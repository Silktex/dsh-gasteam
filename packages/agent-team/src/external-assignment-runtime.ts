/** Isolated bridge for externally supervised Codex turns; it never touches DSH sessions. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { VerifiedCodexExecutionPolicy } from './codex-admission.ts'
import { ExternalRuntimeStore } from './external-runtime.ts'
import type { ExternalRuntimeRecord } from './external-runtime.ts'
import type { ExternalCodeWorktreeReceipt } from './external-code-worktree.ts'
import { compiledExternalRuntimeSupervisorClient, ExternalRuntimeSupervisorObserver, inspectProcessIdentity, readSupervisorIdentity, requestExternalSupervisorCancellation } from './external-runtime-supervisor.ts'
import type { ExternalRuntimeSupervisorClient, ExternalSupervisorRequest } from './external-runtime-supervisor.ts'

export interface ExternalAssignmentLaunch {
  readonly attemptId: string
  readonly generation: number
  readonly directory: string
  readonly verifiedAdmission: VerifiedCodexExecutionPolicy
  readonly prompt: object
  readonly maxSpoolBytes: number
  readonly terminateGraceMs: number
  /** A provisioned, immutable external code checkout; omitted for report-only turns. */
  readonly worktree?: ExternalCodeWorktreeReceipt
}

export interface ExternalAssignmentCapabilities { readonly start: true; readonly observe: true; readonly cancel: true; readonly resume: false }

export class ExternalAssignmentRuntime {
  readonly capabilities: ExternalAssignmentCapabilities = { start: true, observe: true, cancel: true, resume: false }
  private readonly observer = new ExternalRuntimeSupervisorObserver()
  constructor(private readonly store: ExternalRuntimeStore, private readonly client: ExternalRuntimeSupervisorClient = compiledExternalRuntimeSupervisorClient()) {}

  async start(launch: ExternalAssignmentLaunch): Promise<ExternalRuntimeRecord> {
    const prior = this.store.get(launch.attemptId, launch.generation)
    const input = `${JSON.stringify(launch.prompt)}\n`
    const inputSha256 = createHash('sha256').update(input).digest('hex')
    const workingDirectory = launch.worktree?.cwd ?? launch.verifiedAdmission.cwd
    if (launch.worktree !== undefined && (launch.worktree.attemptId !== launch.attemptId || launch.worktree.generation !== launch.generation || launch.worktree.runtimeId === '')) throw new Error('External code worktree does not bind this launch')
    if (prior !== undefined) {
      this.assertDirectory(prior, launch.directory)
      if (!sameAdmission(prior.admission, launch.verifiedAdmission)) throw new Error('External runtime replay admission does not match verified launch policy')
      if (prior.spool?.maxBytes !== launch.maxSpoolBytes) throw new Error('External runtime replay spool limit does not match immutable launch intent')
      if (prior.supervision?.containment !== 'pid-namespace' || prior.supervision.terminateGraceMs !== launch.terminateGraceMs) throw new Error('External runtime replay termination policy does not match immutable launch intent')
      if (prior.inputSha256 !== inputSha256) throw new Error('External runtime replay prompt does not match immutable launch intent')
      if (prior.runtimeIdentity.cwd !== workingDirectory || JSON.stringify(prior.worktree) !== JSON.stringify(launch.worktree)) throw new Error('External runtime replay worktree does not match immutable launch intent')
      return await this.observe(launch.attemptId, launch.generation, launch.directory)
    }
    const policy = launch.verifiedAdmission
    const runtimeIdentity = { provider: 'codex-cli', kind: 'new' as const, attemptId: launch.attemptId, generation: launch.generation,
      executable: policy.executable, version: policy.version, cwd: workingDirectory, model: policy.model, sandbox: policy.sandbox }
    await this.store.prepareLaunch({ attemptId: launch.attemptId, generation: launch.generation, provider: 'codex-cli', runtimeIdentity,
      admission: policy, inputSha256, spool: { directory: launch.directory, stdout: `${launch.directory}/stdout.log`, stderr: `${launch.directory}/stderr.log`, maxBytes: launch.maxSpoolBytes }, supervision: { containment: 'pid-namespace', terminateGraceMs: launch.terminateGraceMs }, ...(launch.worktree === undefined ? {} : { worktree: launch.worktree }) })
    const writableDirectories = launch.worktree === undefined ? [] : [launch.worktree.commonDirectory]
    const request: ExternalSupervisorRequest = { attemptId: launch.attemptId, generation: launch.generation, directory: launch.directory,
      command: policy.executable, args: ['exec', '--json', '--config', 'approval_policy="never"', '--cd', workingDirectory, ...writableDirectories.flatMap(directory => ['--add-dir', directory]), '--model', policy.model, '--sandbox', policy.sandbox, '-'], cwd: workingDirectory, writableDirectories, stdin: input, maxSpoolBytes: launch.maxSpoolBytes,
      terminateGraceMs: launch.terminateGraceMs, containment: 'pid-namespace' }
    await this.client.launch(request)
    const identity = await waitForIdentity(launch.directory)
    if (identity?.process === undefined || identity.supervisor === undefined || identity.attemptId !== launch.attemptId || identity.generation !== launch.generation) return await this.store.markUncertain(launch.attemptId, launch.generation, 'helper launch has no durable namespace wrapper identity')
    return await this.store.recordProcessStarted(launch.attemptId, launch.generation, identity.process, Date.now(), identity.supervisor)
  }

  async cancel(attemptId: string, generation: number, directory: string, reason: string): Promise<ExternalRuntimeRecord> {
    const current = this.store.get(attemptId, generation)
    if (current === undefined) throw new Error('External assignment is not durable')
    this.assertDirectory(current, directory)
    const record = await this.store.recordCancellation(attemptId, generation, reason)
    await requestExternalSupervisorCancellation(directory, attemptId, generation, reason)
    return record
  }

  /**
   * Read-only active-operation evidence for health patrols. A live helper named
   * by a directory is insufficient: every persisted identity and the immutable
   * request must bind this exact external attempt before liveness is reported.
   */
  async health(attemptId: string, generation: number, directory: string): Promise<{ availability: 'available' | 'unknown'; execution: 'known-active-operation' | 'unknown' }> {
    try {
      const record = this.store.get(attemptId, generation)
      if (record === undefined || record.terminal !== undefined || (record.phase !== 'running' && record.phase !== 'cancelling')) return unknownHealth()
      this.assertDirectory(record, directory)
      const identity = await readSupervisorIdentity(directory)
      if (identity === undefined || identity.attemptId !== attemptId || identity.generation !== generation || identity.containment?.kind !== 'pid-namespace'
        || identity.process === undefined || record.process === undefined || record.supervisor === undefined
        || !sameProcess(identity.process, record.process) || !sameProcess(identity.supervisor, record.supervisor)) return unknownHealth()
      await this.assertManifest(directory, attemptId, generation, record)
      const [helper, wrapper] = await Promise.all([inspectProcessIdentity(identity.supervisor), inspectProcessIdentity(identity.process)])
      return helper === 'owned' && wrapper === 'owned'
        ? { availability: 'available', execution: 'known-active-operation' }
        : unknownHealth()
    } catch { return unknownHealth() }
  }

  async observe(attemptId: string, generation: number, directory: string): Promise<ExternalRuntimeRecord> {
    let record = this.store.get(attemptId, generation)
    if (record === undefined) throw new Error('External assignment is not durable')
    this.assertDirectory(record, directory)
    if (record.terminal !== undefined) return record
    let observed = await this.observer.observe(directory)
    // Identity publication precedes target launch, but a restarted caller can
    // observe the detached helper between exec and /proc visibility. Wait a
    // bounded interval before turning that transient into retained uncertainty.
    const deadline = Date.now() + 250
    while (observed.state === 'uncertain' && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
      observed = await this.observer.observe(directory)
    }
    const identity = await readSupervisorIdentity(directory)
    if (identity === undefined || identity.attemptId !== attemptId || identity.generation !== generation || identity.supervisor === undefined) return await this.store.markUncertain(attemptId, generation, 'supervisor identity does not bind this external attempt')
    try { await this.assertManifest(directory, attemptId, generation, record) } catch (error) {
      return await this.store.markUncertain(attemptId, generation, `supervisor manifest does not match durable external intent: ${error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512)}`)
    }
    if (record.process === undefined && identity.process !== undefined) record = await this.store.recordProcessStarted(attemptId, generation, identity.process, Date.now(), identity.supervisor)
    if (record.process !== undefined && (identity.process === undefined || identity.process.pid !== record.process.pid || identity.process.birthId !== record.process.birthId)) return await this.store.markUncertain(attemptId, generation, 'supervisor wrapper identity does not match durable attempt')
    if (record.supervisor !== undefined && !sameProcess(identity.supervisor, record.supervisor)) return await this.store.markUncertain(attemptId, generation, 'supervisor helper identity does not match durable attempt')
    if (record.supervisor === undefined) return await this.store.markUncertain(attemptId, generation, 'durable external attempt lacks supervisor helper identity')
    // A caller may crash after journaled cancellation but before it creates the
    // helper request. Re-materialize exactly that durable request only after
    // binding the live helper to the immutable launch manifest.
    if (record.cancellation !== undefined && observed.state !== 'stopped') {
      try { await requestExternalSupervisorCancellation(directory, attemptId, generation, record.cancellation.reason) } catch (error) {
        return await this.store.markUncertain(attemptId, generation, `external cancellation reconciliation failed: ${error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512)}`)
      }
    }
    if (observed.state === 'running') return record.phase === 'uncertain' && record.process !== undefined ? await this.store.reconcileRunning(attemptId, generation, record.process) : record
    if (observed.state === 'uncertain') return await this.store.markUncertain(attemptId, generation, observed.reason ?? 'external helper ownership is uncertain')
    if (identity?.process === undefined || record.process === undefined) return await this.store.markUncertain(attemptId, generation, 'stopped helper lacks durable wrapper binding')
    try {
      const exitRaw = await readFile(`${directory}/helper-exit.json`)
      const proofRaw = await readFile(`${directory}/terminal-proof.json`)
      const exit = JSON.parse(exitRaw.toString('utf8')) as { attemptId?: string; generation?: number; supervisor?: { pid?: number; birthId?: string }; process?: { pid?: number; birthId?: string }; exit?: { code?: number | null; signal?: string | null } }
      const proof = JSON.parse(proofRaw.toString('utf8')) as { attemptId?: string; generation?: number; supervisor?: { pid?: number; birthId?: string }; process?: { pid?: number; birthId?: string }; exit?: { code?: number | null; signal?: string | null }; spool?: { stdout?: { bytes?: number; sha256?: string }; stderr?: { bytes?: number; sha256?: string } } }
      if (exit.attemptId !== attemptId || exit.generation !== generation || proof.attemptId !== attemptId || proof.generation !== generation || !sameProcess(exit.supervisor, record.supervisor) || !sameProcess(proof.supervisor, record.supervisor) || !sameProcess(exit.process, record.process) || !sameProcess(proof.process, record.process) || !sameExit(exit.exit, proof.exit)) throw new Error('terminal receipt does not bind durable attempt and helper identity')
      if (!exit.exit || typeof exit.exit.code !== 'number' && exit.exit.code !== null || typeof exit.exit.signal !== 'string' && exit.exit.signal !== null) throw new Error('invalid helper exit receipt')
      if (record.processExit === undefined) record = await this.store.recordExit(attemptId, generation, { code: exit.exit.code, signal: exit.exit.signal })
      const stdoutBytes = await readFile(`${directory}/stdout.log`)
      const stderrBytes = await readFile(`${directory}/stderr.log`)
      if (!sameSpool(proof.spool, stdoutBytes, stderrBytes, record.spool?.maxBytes)) throw new Error('terminal spool digest or bounds do not match durable proof')
      const turn = record.cancellation === undefined ? parseCompletedTurn(stdoutBytes.toString('utf8')) : undefined
      if (record.cancellation === undefined) {
        if (turn?.threadId !== undefined) record = await this.store.recordThread(attemptId, generation, turn.threadId)
        // Codex can emit progress and final agent_message items. Its final
        // completed agent_message before turn.completed is the bounded result;
        // journal it once, so a replay never treats progress as a conflicting
        // immutable result.
        if (turn?.finalResult !== undefined) record = await this.store.recordResult(attemptId, generation, turn.finalResult)
        if (turn?.completed) record = await this.store.recordTurnCompleted(attemptId, generation)
      } else if (stdoutBytes.byteLength !== 0) record = await this.store.recordOutput(attemptId, generation, { type: 'fenced-output', text: 'stdout retained after cancellation' })
      if (record.process === undefined) throw new Error('terminal observation lost wrapper identity')
      return await this.store.recordGroupStopped(attemptId, generation, { receiptId: `terminal-${createHash('sha256').update(proofRaw).digest('hex')}`, process: record.process, groupEmpty: true }, Date.now(), record.turnCompleted === true)
    } catch (error) {
      return await this.store.markUncertain(attemptId, generation, `external terminal observation failed: ${error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512)}`)
    }
  }

  private assertDirectory(record: ExternalRuntimeRecord, directory: string): void {
    if (record.spool?.directory !== directory) throw new Error('External runtime directory does not match durable spool binding')
  }

  private async assertManifest(directory: string, attemptId: string, generation: number, record: ExternalRuntimeRecord): Promise<void> {
    const parsed = JSON.parse(await readFile(`${directory}/supervisor-request.json`, 'utf8')) as { request?: ExternalSupervisorRequest }
    const request = parsed.request
    const writableDirectories = record.worktree === undefined ? [] : [record.worktree.commonDirectory]
    if (!request || request.attemptId !== attemptId || request.generation !== generation || request.directory !== directory || request.command !== record.admission?.executable || request.cwd !== record.runtimeIdentity.cwd || request.maxSpoolBytes !== record.spool?.maxBytes || request.containment !== record.supervision?.containment || request.terminateGraceMs !== record.supervision?.terminateGraceMs || JSON.stringify(request.writableDirectories ?? []) !== JSON.stringify(writableDirectories) || record.inputSha256 !== createHash('sha256').update(request.stdin).digest('hex')) throw new Error('supervisor manifest does not bind durable external intent')
    const expected = ['exec', '--json', '--config', 'approval_policy="never"', '--cd', record.runtimeIdentity.cwd, ...writableDirectories.flatMap(directory => ['--add-dir', directory]), '--model', record.admission.model, '--sandbox', record.admission.sandbox, '-']
    if (JSON.stringify(request.args) !== JSON.stringify(expected)) throw new Error('supervisor manifest command does not match verified Codex policy')
  }
}

function sameProcess(value: unknown, expected: { pid: number; birthId: string }): boolean { return typeof value === 'object' && value !== null && (value as Record<string, unknown>).pid === expected.pid && (value as Record<string, unknown>).birthId === expected.birthId }
function unknownHealth(): { availability: 'unknown'; execution: 'unknown' } { return { availability: 'unknown', execution: 'unknown' } }
function sameExit(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function sameAdmission(left: ExternalRuntimeRecord['admission'], right: VerifiedCodexExecutionPolicy): boolean {
  return left !== undefined && left.executable === right.executable && left.configuredExecutable === right.configuredExecutable && left.version === right.version && left.cwd === right.cwd && left.model === right.model && left.sandbox === right.sandbox && left.executableVerification === right.executableVerification && left.authStatus === right.authStatus
}
function sameSpool(value: unknown, stdout: Buffer, stderr: Buffer, maxBytes: number | undefined): boolean {
  if (typeof value !== 'object' || value === null || maxBytes === undefined) return false
  const spool = value as { stdout?: { bytes?: number; sha256?: string }; stderr?: { bytes?: number; sha256?: string } }
  const check = (proof: { bytes?: number; sha256?: string } | undefined, bytes: Buffer) => proof?.bytes === bytes.byteLength && proof.sha256 === createHash('sha256').update(bytes).digest('hex')
  return stdout.byteLength + stderr.byteLength <= maxBytes + 1_024 && check(spool.stdout, stdout) && check(spool.stderr, stderr)
}

function isAgentMessage(value: unknown): value is { type: 'agent_message'; text: string } {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim() !== '' && Buffer.byteLength(item.text) <= 16_384
}

function parseCompletedTurn(stdout: string): { threadId?: string; finalResult?: string; completed: boolean } {
  let threadId: string | undefined
  let finalResult: string | undefined
  let completed = false
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const event = JSON.parse(line) as Record<string, unknown>
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      if (threadId !== undefined && threadId !== event.thread_id) throw new Error('completed turn contains conflicting thread identities')
      threadId = event.thread_id
    }
    if (event.type === 'item.completed' && isAgentMessage(event.item)) {
      if (completed) throw new Error('completed turn contains an agent message after turn.completed')
      finalResult = event.item.text
    }
    if (event.type === 'turn.completed') completed = true
  }
  return { ...(threadId === undefined ? {} : { threadId }), ...(finalResult === undefined ? {} : { finalResult }), completed }
}

async function waitForIdentity(directory: string): Promise<Awaited<ReturnType<typeof readSupervisorIdentity>> | undefined> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const identity = await readSupervisorIdentity(directory)
    if (identity?.process !== undefined && identity.supervisor !== undefined) return identity
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  return undefined
}
