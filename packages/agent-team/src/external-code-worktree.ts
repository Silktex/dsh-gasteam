/** Durable Git worktrees owned by an external provider attempt, never by a DSH Team member. */
import { spawn } from 'node:child_process'
import { link, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

const pendingGit = new Set<ReturnType<typeof spawn>>()
/**
 * A failed `git worktree add` can leave a descendant holding its pipes.  The
 * receipt key fences that effect until the original child actually closes;
 * another caller must never turn an unproven close into a second add.
 */
const pendingIntentGit = new Map<string, Promise<void>>()

export interface ExternalCodeWorktreeIntent {
  readonly attemptId: string
  readonly generation: number
  readonly runtimeId: string
  readonly repository: string
  readonly directory: string
}
export interface ExternalCodeWorktreeReceipt {
  readonly attemptId: string
  readonly generation: number
  readonly runtimeId: string
  readonly directory: string
  readonly repository: string
  readonly commonDirectory: string
  readonly cwd: string
  readonly branch: string
  readonly baseCommit: string
}

interface ExternalCodeWorktreeCompletion {
  readonly proof: 'git-worktree-add-closed-v1'
  readonly receipt: ExternalCodeWorktreeReceipt
}

/**
 * The intent is durable before `git worktree add`. Reconciliation never removes
 * a path: an unmatched or changed checkout is retained for operator recovery.
 */
export class ExternalCodeWorktreeProvider {
  async ensure(intent: ExternalCodeWorktreeIntent): Promise<ExternalCodeWorktreeReceipt> {
    validate(intent)
    await validateDirectory(intent)
    this.assertNoPendingGit(intent)
    // A prior receipt pins the base revision. Never recompute it from a moved
    // project HEAD during restart/replay.
    const existingReceipt = await this.read(intent)
    if (existingReceipt !== undefined) {
      const completion = await this.readCompletion(intent)
      // A receipt is deliberately only launch intent. After a host crash it
      // cannot prove whether the original Git child is still writing, even if
      // a checkout happens to be listed. Do not adopt or relaunch it.
      if (completion === undefined) throw new Error('External code worktree provision has durable intent but no completed Git close proof; retain ownership')
      if (!sameReceipt(completion.receipt, existingReceipt)) throw new Error('External code worktree completion does not bind its immutable receipt')
      const receipt = await this.assertReceipt(intent, existingReceipt)
      const existing = await locate(receipt.repository, receipt.cwd)
      if (existing?.branch !== `refs/heads/${receipt.branch}`) throw new Error('External code worktree completed provision is absent or ambiguous; retain it for recovery')
      return receipt
    }
    const repository = await git(intent.repository, ['rev-parse', '--show-toplevel'])
    const commonDirectory = await git(repository, ['rev-parse', '--git-common-dir'])
    const canonicalCommon = resolve(repository, commonDirectory)
    const baseCommit = await git(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const branch = `dsh-external/${intent.runtimeId}`
    const cwd = join(intent.directory, intent.attemptId)
    const receipt: ExternalCodeWorktreeReceipt = { ...intent, repository, commonDirectory: canonicalCommon, cwd, branch, baseCommit }
    // The receipt sits beside, never inside, the target checkout: Git requires
    // an absent path for `worktree add`.
    const file = this.receiptFile(intent)
    await writeImmutable(file, JSON.stringify(receipt))
    const existing = await locate(repository, cwd)
    if (existing !== undefined) {
      // A matching branch is not a completion proof: it may be the Git child
      // of another provisioner between `add` and its close receipt.
      throw new Error('External code worktree exists before this provision has completed; retain ownership')
    }
    await git(repository, ['worktree', 'add', '-b', branch, '--', cwd, baseCommit], file)
    const created = await locate(repository, cwd)
    if (created?.branch !== `refs/heads/${branch}`) throw new Error('External code worktree provision lacks exact branch identity; retain it for recovery')
    // `git()` resolves only from its close handler. The fsynced completion is
    // therefore the sole recovery authority to admit a later external launch.
    await writeImmutable(this.completionFile(intent), JSON.stringify({ proof: 'git-worktree-add-closed-v1', receipt }))
    return receipt
  }

  async restore(intent: ExternalCodeWorktreeIntent): Promise<ExternalCodeWorktreeReceipt> {
    this.assertNoPendingGit(intent)
    const receipt = await this.read(intent)
    if (receipt === undefined) throw new Error('External code worktree has no durable provision intent')
    const completion = await this.readCompletion(intent)
    if (completion === undefined) throw new Error('External code worktree provision has no completed Git close proof; retain ownership')
    if (!sameReceipt(completion.receipt, receipt)) throw new Error('External code worktree completion does not bind its immutable receipt')
    await validateDirectory(intent)
    await this.assertReceipt(intent, receipt)
    const existing = await locate(receipt.repository, receipt.cwd)
    if (existing?.branch !== `refs/heads/${receipt.branch}`) throw new Error('External code worktree is absent or ambiguous; preserve capacity and checkout')
    return receipt
  }

  private async assertReceipt(intent: ExternalCodeWorktreeIntent, receipt: ExternalCodeWorktreeReceipt): Promise<ExternalCodeWorktreeReceipt> {
    const repository = await git(intent.repository, ['rev-parse', '--show-toplevel'])
    const commonDirectory = resolve(repository, await git(repository, ['rev-parse', '--git-common-dir']))
    if (receipt.attemptId !== intent.attemptId || receipt.generation !== intent.generation || receipt.runtimeId !== intent.runtimeId || receipt.directory !== intent.directory
      || receipt.repository !== repository || receipt.commonDirectory !== commonDirectory || receipt.cwd !== join(intent.directory, intent.attemptId) || receipt.branch !== `dsh-external/${intent.runtimeId}`) throw new Error('External code worktree receipt does not bind this attempt')
    await git(repository, ['cat-file', '-e', `${receipt.baseCommit}^{commit}`])
    return receipt
  }

  private async read(intent: ExternalCodeWorktreeIntent): Promise<ExternalCodeWorktreeReceipt | undefined> {
    const file = this.receiptFile(intent)
    try { return parse(await readFile(file, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async readCompletion(intent: ExternalCodeWorktreeIntent): Promise<ExternalCodeWorktreeCompletion | undefined> {
    try { return parseCompletion(await readFile(this.completionFile(intent), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private receiptFile(intent: ExternalCodeWorktreeIntent): string {
    return join(intent.directory, `${intent.attemptId}.code-worktree.json`)
  }

  private completionFile(intent: ExternalCodeWorktreeIntent): string {
    return join(intent.directory, `${intent.attemptId}.code-worktree.complete.json`)
  }

  private assertNoPendingGit(intent: ExternalCodeWorktreeIntent): void {
    if (pendingIntentGit.has(this.receiptFile(intent))) throw new Error('External code worktree provision is still active with unproven close; retain ownership')
  }
}

function validate(intent: ExternalCodeWorktreeIntent): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(intent.attemptId) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(intent.runtimeId)
    || !Number.isSafeInteger(intent.generation) || intent.generation < 1 || !isAbsolute(intent.repository) || !isAbsolute(intent.directory)
    || intent.repository !== resolve(intent.repository) || intent.directory !== resolve(intent.directory)) throw new Error('Invalid external code worktree intent')
  const location = relative(intent.repository, intent.directory)
  if (location === '' || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`))) throw new Error('External code worktree directory must be outside its repository')
}

async function validateDirectory(intent: ExternalCodeWorktreeIntent): Promise<void> {
  const repository = await realpath(intent.repository)
  const directory = await canonicalPath(intent.directory)
  const location = relative(repository, directory)
  if (location === '' || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`))) throw new Error('External code worktree directory must remain outside its canonical repository')
}

/** Resolve a present ancestor so a not-yet-created child cannot hide a symlink into the repository. */
async function canonicalPath(path: string): Promise<string> {
  let ancestor = path
  const suffix: string[] = []
  while (true) {
    try { return resolve(await realpath(ancestor), ...suffix.reverse()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return resolve(path)
      suffix.push(relative(parent, ancestor))
      ancestor = parent
    }
  }
}

async function locate(repository: string, cwd: string): Promise<{ branch?: string } | undefined> {
  const rows = (await git(repository, ['worktree', 'list', '--porcelain'])).split('\n\n').filter(Boolean).map(row => Object.fromEntries(row.split('\n').map(field => {
    const [key, ...rest] = field.split(' '); return [key!, rest.join(' ')]
  })))
  const row = rows.find(row => resolve(row.worktree ?? '') === resolve(cwd))
  return row === undefined ? undefined : { ...(row.branch === undefined ? {} : { branch: row.branch }) }
}

async function git(cwd: string, args: readonly string[], intentKey?: string): Promise<string> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    if (intentKey !== undefined && pendingIntentGit.has(intentKey)) {
      reject(new Error('External code worktree provision is still active with unproven close; retain ownership'))
      return
    }
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let resolveClosed: (() => void) | undefined
    const closed = new Promise<void>(resolve => { resolveClosed = resolve })
    if (intentKey !== undefined) pendingIntentGit.set(intentKey, closed)
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    let bytes = 0; let settled = false; let failure: Error | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let closeTimeout: ReturnType<typeof setTimeout> | undefined
    const settle = (error?: Error, value?: string, retainChild = false) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (closeTimeout !== undefined) clearTimeout(closeTimeout)
      if (!retainChild) pendingGit.delete(child)
      if (error !== undefined) reject(error)
      else resolveOutput(value!)
    }
    const fail = (error: Error) => {
      if (failure !== undefined || settled) return
      failure = error
      pendingGit.add(child)
      try { child.kill('SIGKILL') } catch {}
      closeTimeout = setTimeout(() => settle(new Error(`${error.message}; git child close is unproven`), undefined, true), 1_000)
    }
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (failure !== undefined || settled) return
      bytes += chunk.byteLength
      if (bytes > 1_048_576) return fail(new Error('git worktree command exceeded bounded output'))
      into.push(Buffer.from(chunk))
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', error => fail(error))
    timeout = setTimeout(() => fail(new Error('git worktree command exceeded 30 second deadline')), 30_000)
    child.once('close', code => {
      resolveClosed?.()
      if (intentKey !== undefined && pendingIntentGit.get(intentKey) === closed) pendingIntentGit.delete(intentKey)
      // A secondary timeout has already rejected, but retain the handle until
      // the OS confirms close so a still-live child is not forgotten.
      if (settled) {
        pendingGit.delete(child)
        return
      }
      if (failure !== undefined) return settle(failure)
      code === 0 ? settle(undefined, Buffer.concat(stdout).toString('utf8').trim()) : settle(new Error(`git ${args[0]} failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 512)}`))
    })
  })
  return output
}

async function writeImmutable(filename: string, body: string): Promise<void> {
  try {
    const existing = await readFile(filename, 'utf8')
    if (existing !== body) throw new Error('External code worktree intent replay differs from immutable receipt')
    return
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  await writeFile(temporary, body, { mode: 0o600, flag: 'wx' })
  const handle = await open(temporary, 'r'); await handle.sync(); await handle.close()
  try {
    // link is create-only: a concurrent different intent cannot replace the
    // first durable receipt.
    await link(temporary, filename)
    const parent = await open(dirname(filename), 'r'); await parent.sync(); await parent.close()
  } catch (error) {
    const existing = await readFile(filename, 'utf8').catch(() => undefined)
    if (existing !== body) throw error
  } finally { await rm(temporary, { force: true }) }
}

function parse(raw: string): ExternalCodeWorktreeReceipt {
  const value = JSON.parse(raw) as Record<string, unknown>
  if (typeof value.attemptId !== 'string' || typeof value.generation !== 'number' || typeof value.runtimeId !== 'string' || typeof value.directory !== 'string' || typeof value.repository !== 'string'
    || typeof value.commonDirectory !== 'string' || typeof value.cwd !== 'string' || typeof value.branch !== 'string' || typeof value.baseCommit !== 'string') throw new Error('Invalid external code worktree receipt')
  return value as unknown as ExternalCodeWorktreeReceipt
}

function parseCompletion(raw: string): ExternalCodeWorktreeCompletion {
  const value = JSON.parse(raw) as Record<string, unknown>
  if (value.proof !== 'git-worktree-add-closed-v1' || typeof value.receipt !== 'object' || value.receipt === null) throw new Error('Invalid external code worktree completion')
  return { proof: value.proof, receipt: parse(JSON.stringify(value.receipt)) }
}

function sameReceipt(left: ExternalCodeWorktreeReceipt, right: ExternalCodeWorktreeReceipt): boolean {
  return left.attemptId === right.attemptId && left.generation === right.generation && left.runtimeId === right.runtimeId
    && left.directory === right.directory && left.repository === right.repository && left.commonDirectory === right.commonDirectory
    && left.cwd === right.cwd && left.branch === right.branch && left.baseCommit === right.baseCommit
}
