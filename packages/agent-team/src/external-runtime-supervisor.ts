import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'zod'
import { acquireFileOwnership } from './file-ownership.ts'

export interface ProcessBirthIdentity { pid: number; birthId: string }
export type ProcessIdentityStatus = 'owned' | 'missing' | 'mismatch' | 'unavailable'

export interface ExternalSupervisorRequest {
  attemptId: string
  generation: number
  directory: string
  command: string
  args: readonly string[]
  cwd: string
  stdin: string
  maxSpoolBytes: number
  terminateGraceMs: number
  containment: 'pid-namespace'
}

export interface StopProof {
  requestedAt: number
  signals: Array<'SIGTERM' | 'SIGKILL'>
  exit?: { code: number | null; signal: string | null }
  containment: 'pid-namespace'
  hostWrapper: ProcessBirthIdentity
  innerInitPid: 1
  spool?: { stdout: { bytes: number; sha256: string }; stderr: { bytes: number; sha256: string } }
  uncertain?: string
}

export interface SupervisedProcess {
  readonly identity: ProcessBirthIdentity
  readonly finished: Promise<{ code: number | null; signal: string | null; overflowed: boolean; stopProof?: StopProof }>
  status(): Promise<ProcessIdentityStatus>
  cancel(): Promise<StopProof>
}

export interface PidNamespaceCapability { supported: boolean; reason?: string }

/**
 * Strict tree-containment capability. `unshare --kill-child` makes the wrapper
 * responsible for PID namespace init teardown; callers must still persist the
 * host wrapper PID/birth identity separately from inner PID 1.
 */
export async function probePidNamespaceContainment(): Promise<PidNamespaceCapability> {
  if (process.platform !== 'linux') return { supported: false, reason: 'PID namespace containment requires Linux' }
  const result = await new Promise<{ code: number | null; stderr: string }>(resolveProbe => {
    const child = spawn('unshare', ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', '--kill-child', '--', 'true'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(0, 4_096) })
    child.once('error', error => resolveProbe({ code: null, stderr: error.message.slice(0, 4_096) }))
    child.once('close', code => resolveProbe({ code, stderr }))
  })
  return result.code === 0 ? { supported: true } : { supported: false, reason: result.stderr || `unshare exited with ${result.code ?? 'no status'}` }
}

export interface ExternalRuntimeSupervisorClientOptions {
  /** Compiled supervisor entrypoint in production; tests may use tsx bootstrap arguments. */
  helperArgs: readonly string[]
  executable?: string
}

/**
 * Coordinator-side launcher. It never owns the lifetime lock or target pipes:
 * those belong to the detached helper, so killing this client cannot orphan a
 * live target into an unsafe replacement.
 */
export class ExternalRuntimeSupervisorClient {
  constructor(private readonly options: ExternalRuntimeSupervisorClientOptions) {}

  async launch(request: ExternalSupervisorRequest): Promise<{ supervisorPid: number }> {
    validateRequest(request)
    await mkdir(request.directory, { recursive: true })
    const requestFile = join(request.directory, 'supervisor-request.json')
    const manifest = JSON.stringify({ request })
    await immutableManifest(requestFile, manifest)
    // Claim before the OS effect. A client dying in the claim-to-spawn gap is
    // deliberately uncertain: replay may inspect its receipt, never launch a
    // second target. The helper makes a second claim while holding the
    // lifetime lock, covering bypassed or duplicated helper invocations too.
    if (!await claimLaunch(join(request.directory, 'launcher-claim.json'), manifest)) {
      const identity = await waitForSupervisorIdentity(request.directory, 1_000)
      if (identity === undefined) throw new Error('External runtime launch was already claimed without an identity receipt; preserve capacity')
      return { supervisorPid: identity.supervisor.pid }
    }
    const child = spawn(this.options.executable ?? process.execPath, [...this.options.helperArgs, '--request', requestFile], {
      cwd: request.cwd, detached: true, stdio: 'ignore',
    })
    // `spawn` can report ENOENT asynchronously. The durable claim remains an
    // uncertainty fence and the listener prevents an unhandled launch error.
    child.once('error', error => { void writeUncertain(request.directory, `detached helper launch failed: ${error.message}`) })
    if (child.pid === undefined) throw new Error('External runtime helper did not return a process id')
    child.unref()
    return { supervisorPid: child.pid }
  }
}

/** Read-only recovery probe. It never signals a persisted numeric process group. */
export class ExternalRuntimeSupervisorObserver {
  async observe(directory: string): Promise<{ state: 'running' | 'stopped' | 'uncertain'; reason?: string }> {
    const identity = await readSupervisorIdentity(directory)
    if (identity?.process === undefined || identity.containment?.kind !== 'pid-namespace') return { state: 'uncertain', reason: 'missing strict namespace identity' }
    const helper = await inspectProcessIdentity(identity.supervisor)
    if (helper === 'owned') return { state: 'running' }
    if (helper !== 'missing') return { state: 'uncertain', reason: 'helper identity cannot be verified as absent' }
    const wrapper = await inspectProcessIdentity(identity.process)
    // Never signal a historical PID/PGID. With --kill-child the host wrapper's
    // verified absence is the namespace teardown receipt; mismatch stays
    // uncertain because a reused host PID proves nothing about the old run.
    return wrapper === 'missing' ? { state: 'stopped' } : { state: 'uncertain', reason: wrapper === 'owned' ? 'helper is absent while namespace wrapper remains live' : 'namespace wrapper identity cannot be verified as absent' }
  }
}

/** Uses this compiled module as the detached helper entrypoint. */
export function compiledExternalRuntimeSupervisorClient(): ExternalRuntimeSupervisorClient {
  return new ExternalRuntimeSupervisorClient({ helperArgs: [fileURLToPath(import.meta.url)] })
}

interface SupervisorIdentityFile {
  attemptId: string
  generation: number
  supervisor: ProcessBirthIdentity
  process?: ProcessBirthIdentity | undefined
  containment?: { kind: 'pid-namespace'; innerInitPid: 1 } | undefined
}
const processIdentitySchema = z.object({ pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), birthId: z.string().regex(/^\d{1,128}$/) }).strict()
const supervisorIdentitySchema = z.object({ attemptId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/), generation: z.number().int().nonnegative(), supervisor: processIdentitySchema, process: processIdentitySchema.optional(), containment: z.object({ kind: z.literal('pid-namespace'), innerInitPid: z.literal(1) }).strict().optional() }).strict()

/**
 * Owns one strict PID-namespace wrapper. Its lock fd is deliberately inherited
 * by the wrapper: a crashed coordinator cannot launch a duplicate while it lives.
 */
export class ExternalRuntimeSupervisor {
  async launch(request: ExternalSupervisorRequest): Promise<SupervisedProcess> {
    validateRequest(request)
    const supervisor = await processBirthIdentity(process.pid)
    await mkdir(request.directory, { recursive: true })
    const lock = await open(join(request.directory, 'lifetime.lock'), 'a+', 0o600)
    const stdout = join(request.directory, 'stdout.log')
    const stderr = join(request.directory, 'stderr.log')
    let inheritedLock = false
    try {
      await acquireFileOwnership(lock)
      if (!await claimLaunch(join(request.directory, 'target-launch-claim.json'), JSON.stringify({ request }))) {
        throw new Error('External runtime target launch was already claimed; preserve capacity')
      }
      await writeIdentity(request.directory, { attemptId: request.attemptId, generation: request.generation, supervisor, containment: { kind: 'pid-namespace', innerInitPid: 1 } })
      // `unshare` is the host-visible wrapper. The requested command becomes
      // PID 1 inside its child namespace. On wrapper death --kill-child kills
      // PID 1, and kernel PID-namespace semantics kill namespace descendants.
      const child = spawn('unshare', ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', '--kill-child', '--', request.command, ...request.args], {
        cwd: request.cwd, detached: false, stdio: ['pipe', 'pipe', 'pipe', lock.fd],
      })
      // Attach error/close before any asynchronous identity or journal work. A
      // fast ENOENT/exit cannot be lost in the launch-to-identity window.
      const lifecycle = observeChild(child)
      if (child.pid === undefined) { await lifecycle.catch(() => {}); throw new Error('External runtime did not return a process id') }
      inheritedLock = true
      let identity: ProcessBirthIdentity
      try { identity = await processBirthIdentity(child.pid) } catch (error) {
        await writeUncertain(request.directory, `process started but birth identity could not be read: ${error instanceof Error ? error.message : String(error)}`)
        void retainLockThroughDrain(lifecycle, child.pid, lock)
        throw new Error('External runtime launch identity is uncertain; preserve capacity', { cause: error })
      }
      try { await writeIdentity(request.directory, { attemptId: request.attemptId, generation: request.generation, supervisor, process: identity, containment: { kind: 'pid-namespace', innerInitPid: 1 } }) } catch (error) {
        // The lock remains owned while the target remains alive. Do not return a
        // handle that could prompt a replacement; the caller must reconcile it.
        await writeUncertain(request.directory, `process started but identity receipt failed: ${error instanceof Error ? error.message : String(error)}`)
        void retainLockThroughDrain(lifecycle, child.pid, lock)
        throw new Error('External runtime launch identity is uncertain; preserve capacity', { cause: error })
      }
      if (child.stdin === null) {
        await writeUncertain(request.directory, 'process started but stdin pipe is unavailable')
        void retainLockThroughDrain(lifecycle, child.pid, lock)
        throw new Error('External runtime launch identity is uncertain; preserve capacity')
      }
      child.stdin.end(request.stdin)
      return supervise(child, identity, request, lock, stdout, stderr, lifecycle)
    } catch (error) {
      // Once the namespace wrapper inherited the descriptor, the helper must
      // preserve the fence until that wrapper has actually closed. Closing here would
      // make a later launch indistinguishable from a safe empty group.
      if (!inheritedLock) await lock.close()
      throw error
    }
  }
}

async function retainLockThroughDrain(lifecycle: Promise<unknown>, _pid: number, lock: Awaited<ReturnType<typeof open>>): Promise<void> {
  await lifecycle.catch(() => {})
  await lock.close()
}

function observeChild(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose)
    child.once('close', (code, signal) => resolveClose({ code, signal }))
  })
}

function supervise(child: ChildProcess, identity: ProcessBirthIdentity, request: ExternalSupervisorRequest, lock: Awaited<ReturnType<typeof open>>, stdout: string, stderr: string, lifecycle: Promise<{ code: number | null; signal: string | null }>): SupervisedProcess {
  let pending = Promise.resolve()
  let bytes = 0
  let overflowed = false
  let cancellation: Promise<StopProof> | undefined
  let exit: { code: number | null; signal: string | null } | undefined
  const append = (filename: string, chunk: Buffer) => {
    pending = pending.then(async () => {
      const remaining = Math.max(0, request.maxSpoolBytes - bytes)
      if (remaining > 0) {
        const written = chunk.subarray(0, remaining)
        bytes += written.byteLength
        await appendFile(filename, written, { mode: 0o600 })
      }
      if (chunk.byteLength > remaining && !overflowed) {
        overflowed = true
        await appendFile(filename, '\n[external runtime spool limit reached; cancellation requested]\n', { mode: 0o600 })
        setImmediate(() => { void requestCancellation() })
      }
    })
  }
  child.stdout?.on('data', (chunk: Buffer) => append(stdout, Buffer.from(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => append(stderr, Buffer.from(chunk)))
  const closed = lifecycle.then(async result => {
    exit = result
    await pending
    // `close` arrives only after the wrapper's stdio closes. Namespace teardown
    // is certified separately by the read-only observer after helper exit.
    await durableWrite(join(request.directory, 'helper-exit.json'), JSON.stringify({ process: identity, exit: result }))
    await lock.close()
    return result
  }, async error => { await lock.close(); throw error })
  const requestCancellation = async (): Promise<StopProof> => cancellation ??= cancelNamespacedProcess(child, identity, lifecycle, request.terminateGraceMs, async proof => {
    if (proof.exit !== undefined) {
      await pending
      proof.spool = await spoolProof(stdout, stderr)
    }
    await writeStopProof(request.directory, proof)
  })
  return {
    identity,
    finished: closed.then(async result => ({ code: result.code, signal: result.signal, overflowed, ...(cancellation === undefined ? {} : { stopProof: await cancellation }) })),
    status: async () => await inspectProcessIdentity(identity),
    cancel: requestCancellation,
  }
}

async function cancelNamespacedProcess(child: ChildProcess, identity: ProcessBirthIdentity, lifecycle: Promise<{ code: number | null; signal: string | null }>, graceMs: number, persist: (proof: StopProof) => Promise<void>): Promise<StopProof> {
  const proof: StopProof = { requestedAt: Date.now(), signals: [], containment: 'pid-namespace', hostWrapper: identity, innerInitPid: 1 }
  if (child.pid !== identity.pid || child.exitCode !== null || child.signalCode !== null) {
    proof.uncertain = 'live namespace wrapper handle is unavailable; refusing a persisted PID signal'
    await persist(proof)
    return proof
  }
  try { child.kill('SIGTERM'); proof.signals.push('SIGTERM') } catch (error) {
    proof.uncertain = `SIGTERM could not be delivered: ${error instanceof Error ? error.message : String(error)}`
    await persist(proof)
    return proof
  }
  let terminal = await waitForLifecycle(lifecycle, graceMs)
  if (terminal === undefined) {
    if (child.pid === identity.pid && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); proof.signals.push('SIGKILL') } catch (error) { proof.uncertain = `SIGKILL could not be delivered: ${error instanceof Error ? error.message : String(error)}` }
      terminal = await waitForLifecycle(lifecycle, graceMs)
      if (terminal === undefined) proof.uncertain ??= 'namespace wrapper did not close within the bounded SIGKILL drain'
    } else proof.uncertain = 'namespace wrapper handle changed before SIGKILL; refusing a persisted PID signal'
  }
  if (terminal !== undefined) proof.exit = terminal
  await persist(proof)
  return proof
}

async function waitForLifecycle(lifecycle: Promise<{ code: number | null; signal: string | null }>, timeoutMs: number): Promise<{ code: number | null; signal: string | null } | undefined> {
  let timer: number | undefined
  try {
    return await Promise.race([
      lifecycle,
      new Promise<undefined>(resolveTimeout => { timer = setTimeout(resolveTimeout, timeoutMs) }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Linux start ticks prevent a persisted PID from being confused with a reused PID. */
export async function processBirthIdentity(pid: number): Promise<ProcessBirthIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process id')
  const statLine = await readFile(`/proc/${pid}/stat`, 'utf8')
  const close = statLine.lastIndexOf(')')
  if (close < 0) throw new Error('Cannot parse Linux process identity')
  const fields = statLine.slice(close + 1).trim().split(/\s+/)
  const birthId = fields[19]
  if (birthId === undefined || !/^\d+$/.test(birthId)) throw new Error('Cannot parse Linux process birth identity')
  return { pid, birthId }
}

async function spoolProof(stdout: string, stderr: string): Promise<NonNullable<StopProof['spool']>> {
  const one = async (filename: string) => {
    const handle = await open(filename, 'a+', 0o600)
    try {
      await handle.sync()
      const content = await handle.readFile()
      return { bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }
    } finally { await handle.close() }
  }
  return { stdout: await one(stdout), stderr: await one(stderr) }
}

export async function inspectProcessIdentity(identity: ProcessBirthIdentity): Promise<ProcessIdentityStatus> {
  try {
    const current = await processBirthIdentity(identity.pid)
    return current.birthId === identity.birthId ? 'owned' : 'mismatch'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return 'unavailable'
  }
}

export async function readSupervisorIdentity(directory: string): Promise<SupervisorIdentityFile | undefined> {
  try { return supervisorIdentitySchema.parse(JSON.parse(await readFile(join(directory, 'supervisor.json'), 'utf8'))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeIdentity(directory: string, identity: SupervisorIdentityFile): Promise<void> {
  const file = join(directory, 'supervisor.json')
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(identity), { mode: 0o600 })
  await rename(temporary, file)
  const handle = await open(file, 'r')
  try { await handle.sync() } finally { await handle.close() }
  await syncDirectory(dirname(file))
}

async function durableWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  const handle = await open(temporary, 'r')
  try { await handle.sync() } finally { await handle.close() }
  await rename(temporary, file)
  await syncDirectory(dirname(file))
}

/** A hard link changes the directory, so fsync the directory before any OS effect. */
export async function durableLink(source: string, destination: string): Promise<void> {
  await link(source, destination)
  await syncDirectory(dirname(destination))
}

async function syncDirectory(directory: string): Promise<void> {
  const parent = await open(directory, 'r')
  try { await parent.sync() } finally { await parent.close() }
}

async function immutableManifest(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await durableWrite(temporary, content)
    await durableLink(temporary, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readFile(file, 'utf8')
    if (existing !== content) throw new Error('External runtime helper manifest is immutable')
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

const launchClaimSchema = z.object({ version: z.literal(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/**
 * Atomically creates a durable launch claim. A matching existing claim is a
 * completed or uncertain prior launch, never permission to execute again.
 */
async function claimLaunch(file: string, manifest: string): Promise<boolean> {
  const content = JSON.stringify({ version: 1, manifestSha256: createHash('sha256').update(manifest).digest('hex') })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await durableWrite(temporary, content)
    await durableLink(temporary, file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = launchClaimSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    if (existing.manifestSha256 !== JSON.parse(content).manifestSha256) throw new Error('External runtime launch claim is bound to a different immutable manifest')
    return false
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function waitForSupervisorIdentity(directory: string, timeoutMs: number): Promise<SupervisorIdentityFile | undefined> {
  const deadline = Date.now() + timeoutMs
  do {
    const identity = await readSupervisorIdentity(directory)
    if (identity !== undefined) return identity
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  } while (Date.now() < deadline)
  return undefined
}

async function writeStopProof(directory: string, proof: StopProof): Promise<void> {
  const file = join(directory, 'stop-proof.json')
  await writeFile(file, JSON.stringify(proof), { mode: 0o600 })
  const handle = await open(file, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function writeUncertain(directory: string, reason: string): Promise<void> {
  await writeFile(join(directory, 'uncertain.json'), JSON.stringify({ reason: reason.slice(0, 4_096) }), { mode: 0o600 })
}

function validateRequest(request: ExternalSupervisorRequest): void {
  if (request.attemptId.trim() === '' || !Number.isSafeInteger(request.generation) || request.generation < 0) throw new Error('Invalid external supervisor attempt')
  if (!isAbsolute(request.directory) || !isAbsolute(request.cwd) || request.directory !== resolve(request.directory) || request.cwd !== resolve(request.cwd)) throw new Error('External supervisor requires canonical absolute directory and cwd')
  if (request.containment !== 'pid-namespace' || request.command.trim() === '' || request.args.some(arg => typeof arg !== 'string') || Buffer.byteLength(request.args.join('\0')) > 65_536 || Buffer.byteLength(request.stdin) > 1_048_576 || !Number.isSafeInteger(request.maxSpoolBytes) || request.maxSpoolBytes < 1 || !Number.isSafeInteger(request.terminateGraceMs) || request.terminateGraceMs < 0) throw new Error('Invalid external supervisor request')
}

interface SupervisorCommand { request: ExternalSupervisorRequest }

async function main(): Promise<void> {
  const requestFlag = process.argv.indexOf('--request')
  const requestFile = requestFlag >= 0 ? process.argv[requestFlag + 1] : undefined
  if (requestFile === undefined) throw new Error('Supervisor command requires --request <json-file>')
  if (process.argv.includes('--launch-helper')) {
    const command = JSON.parse(await readFile(requestFile, 'utf8')) as SupervisorCommand
    const launched = await new ExternalRuntimeSupervisorClient({ executable: process.execPath, helperArgs: ['--import', 'tsx', fileURLToPath(import.meta.url)] }).launch(command.request)
    // This test/bootstrap client remains alive only so SIGKILL can model a
    // coordinator crash. The detached helper has already taken responsibility.
    process.stdout.write(`${launched.supervisorPid}\n`)
    await new Promise<void>(() => {})
  } else {
    const parsed = JSON.parse(await readFile(requestFile, 'utf8')) as SupervisorCommand
    const supervised = await new ExternalRuntimeSupervisor().launch(parsed.request)
    await supervised.finished
  }
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) void main().catch(error => { process.stderr.write(`external runtime supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
