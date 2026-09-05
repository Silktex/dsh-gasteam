import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string().trim().min(1).max(16_384)
const processSchema = z.object({ pid: z.number().int().positive(), birthId: z.string().regex(/^\d{1,128}$/) }).strict()
const runtimeIdentity = z.discriminatedUnion('kind', [
  z.object({ provider: id, kind: z.literal('new'), attemptId: id, generation, executable: z.string().min(1).max(4096).optional(), version: z.string().min(1).max(256).optional(), cwd: z.string().min(1).max(4096).optional(), model: z.string().min(1).max(512).optional(), sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional() }).strict(),
  z.object({ provider: id, kind: z.literal('resume'), attemptId: id, generation, threadId: id, quiescentReceipt: z.string().trim().min(1).max(512), executable: z.string().min(1).max(4096).optional(), version: z.string().min(1).max(256).optional(), cwd: z.string().min(1).max(4096).optional(), model: z.string().min(1).max(512).optional(), sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional() }).strict(),
]).superRefine((value, ctx) => {
  if (value.provider === 'codex-cli' && (value.executable === undefined || value.version === undefined || value.cwd === undefined || value.model === undefined || value.sandbox === undefined)) ctx.addIssue({ code: 'custom', message: 'Codex runtime identity requires its pinned executable, version, cwd, model, and sandbox' })
})
const spool = z.object({ directory: z.string().min(1).max(4096), stdout: z.string().min(1).max(4096), stderr: z.string().min(1).max(4096), maxBytes: z.number().int().positive().max(16 * 1024 * 1024) }).strict()
const supervision = z.object({ containment: z.literal('pid-namespace'), terminateGraceMs: z.number().int().positive().max(300_000) }).strict()
const admission = z.object({ executable: z.string().min(1).max(4096), configuredExecutable: z.string().min(1).max(4096), version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/), cwd: z.string().min(1).max(4096), model: z.string().min(1).max(512), sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']), executableVerification: z.literal('verified'), authStatus: z.literal('authenticated') }).strict()
const worktree = z.object({ attemptId: id, generation, runtimeId: id, directory: z.string().min(1).max(4096), repository: z.string().min(1).max(4096), commonDirectory: z.string().min(1).max(4096), cwd: z.string().min(1).max(4096), branch: z.string().min(1).max(512), baseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict()
const exit = z.object({ code: z.number().int().nonnegative().nullable(), signal: z.string().trim().min(1).max(128).nullable() }).strict()
const receipt = z.object({ receiptId: id, process: processSchema, groupEmpty: z.literal(true) }).strict()
const intent = z.object({ attemptId: id, generation, provider: id, runtimeIdentity, admission: admission.optional(), inputSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), spool: spool.optional(), supervision: supervision.optional(), worktree: worktree.optional() }).strict().superRefine((value, ctx) => {
  if (value.provider !== value.runtimeIdentity.provider || value.attemptId !== value.runtimeIdentity.attemptId || value.generation !== value.runtimeIdentity.generation) ctx.addIssue({ code: 'custom', message: 'External runtime identity must bind the durable attempt' })
  if (value.provider === 'codex-cli' && (value.admission === undefined || value.inputSha256 === undefined || value.spool === undefined || value.supervision === undefined)) ctx.addIssue({ code: 'custom', message: 'Codex runtime launch requires verified admission, spool, supervision, and input binding' })
  if (value.worktree !== undefined && (value.worktree.attemptId !== value.attemptId || value.worktree.generation !== value.generation || value.worktree.cwd !== value.runtimeIdentity.cwd)) ctx.addIssue({ code: 'custom', message: 'External code worktree must bind the runtime identity' })
})
const terminal = z.object({ outcome: z.enum(['completed', 'failed', 'cancelled']), exit, receipt, observedAt: time }).strict()
const recordSchema = intent.extend({
  phase: z.enum(['launch-intent', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'uncertain']), revision: z.number().int().positive(), lastObservedAt: time,
  acceptedOutputCount: z.number().int().nonnegative().max(1_000_000), fencedOutputCount: z.number().int().nonnegative().max(1_000_000), retainsCapacity: z.boolean(),
  process: processSchema.optional(), supervisor: processSchema.optional(), processExit: exit.optional(), cancellation: z.object({ reason: text, requestedAt: time }).strict().optional(),
  threadId: id.optional(), result: text.optional(), turnCompleted: z.boolean().optional(), terminal: terminal.optional(), uncertainty: text.optional(),
}).strict()
export type ExternalRuntimePhase = z.output<typeof recordSchema>['phase']
export type ProcessBirthIdentity = z.output<typeof processSchema>
export type ExternalRuntimeIdentity = z.output<typeof runtimeIdentity>
export type ExternalRuntimeLaunchIntent = z.input<typeof intent>
export type ExternalRuntimeRecord = z.output<typeof recordSchema>
export interface ExternalRuntimeOutput { type: string; text: string }
type Record = ExternalRuntimeRecord
interface State { records: Record[] }
type Payload =
  | { type: 'external/intent'; intent: ExternalRuntimeLaunchIntent; at: number }
  | { type: 'external/started'; attemptId: string; generation: number; process: ProcessBirthIdentity; supervisor?: ProcessBirthIdentity; at: number }
  | { type: 'external/output'; attemptId: string; generation: number; output: ExternalRuntimeOutput; at: number }
  | { type: 'external/thread'; attemptId: string; generation: number; threadId: string; at: number }
  | { type: 'external/result'; attemptId: string; generation: number; result: string; at: number }
  | { type: 'external/turn-completed'; attemptId: string; generation: number; at: number }
  | { type: 'external/reconciled'; attemptId: string; generation: number; process: ProcessBirthIdentity; at: number }
  | { type: 'external/cancel'; attemptId: string; generation: number; reason: string; at: number }
  | { type: 'external/exit'; attemptId: string; generation: number; exit: z.output<typeof exit>; at: number }
  | { type: 'external/group-stopped'; attemptId: string; generation: number; receipt: z.output<typeof receipt>; turnCompleted: boolean; at: number }
  | { type: 'external/uncertain'; attemptId: string; generation: number; reason: string; at: number }
type Event = Payload & { version: 1; sequence: number }
const output = z.object({ type: id, text }).strict()
const eventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/intent'), intent, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/started'), attemptId: id, generation, process: processSchema, supervisor: processSchema.optional(), at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/output'), attemptId: id, generation, output, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/thread'), attemptId: id, generation, threadId: id, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/result'), attemptId: id, generation, result: text, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/turn-completed'), attemptId: id, generation, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/reconciled'), attemptId: id, generation, process: processSchema, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/cancel'), attemptId: id, generation, reason: text, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/exit'), attemptId: id, generation, exit, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/group-stopped'), attemptId: id, generation, receipt, turnCompleted: z.boolean(), at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/uncertain'), attemptId: id, generation, reason: text, at: time }).strict(),
])

/** Durable state only keeps spool references/counters; runtime bytes never enter the journal. */
export class ExternalRuntimeStore {
  private constructor(private readonly journal: DurableJournal<State, Payload>) {}
  static async open(directory: string): Promise<ExternalRuntimeStore> {
    await mkdir(directory, { recursive: true })
    return new ExternalRuntimeStore(await DurableJournal.open(join(directory, 'external-runtime.jsonl'), { records: [] }, reduce))
  }
  close(): Promise<void> { return this.journal.close() }
  list(): Record[] { return this.journal.snapshot().records }
  get(attemptId: string, valueGeneration: number): Record | undefined { return this.list().find(item => key(item) === key({ attemptId, generation: valueGeneration })) }
  async prepareLaunch(value: ExternalRuntimeLaunchIntent, at = Date.now()): Promise<Record> {
    const parsed = intent.parse(value), prior = this.get(parsed.attemptId, parsed.generation)
    if (prior !== undefined) { sameIntent(prior, parsed); return prior }
    return get(await this.journal.append(() => ({ type: 'external/intent', intent: parsed, at: time.parse(at) })), parsed.attemptId, parsed.generation)
  }
  async recordProcessStarted(attemptId: string, valueGeneration: number, process: ProcessBirthIdentity, at = Date.now(), supervisor?: ProcessBirthIdentity): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/started', attemptId, generation: valueGeneration, process: processSchema.parse(process), ...(supervisor === undefined ? {} : { supervisor: processSchema.parse(supervisor) }), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordOutput(attemptId: string, valueGeneration: number, value: ExternalRuntimeOutput, at = Date.now()): Promise<Record> {
    const prior = this.get(attemptId, valueGeneration)
    if (prior === undefined) throw new Error('External runtime attempt is not durable')
    // The spool is the durable byte artifact. Keep at most one accepted and one
    // fenced marker in JSONL rather than turning verbose provider output into an
    // unbounded second journal.
    if ((prior.cancellation !== undefined || prior.phase === 'uncertain' || prior.terminal !== undefined) ? prior.fencedOutputCount > 0 : prior.acceptedOutputCount > 0) return prior
    return get(await this.journal.append(current => ({ type: 'external/output', attemptId, generation: valueGeneration, output: output.parse(value), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordThread(attemptId: string, valueGeneration: number, threadId: string, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/thread', attemptId, generation: valueGeneration, threadId: id.parse(threadId), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordResult(attemptId: string, valueGeneration: number, result: string, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/result', attemptId, generation: valueGeneration, result: text.parse(result), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordTurnCompleted(attemptId: string, valueGeneration: number, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/turn-completed', attemptId, generation: valueGeneration, at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async reconcileRunning(attemptId: string, valueGeneration: number, process: ProcessBirthIdentity, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/reconciled', attemptId, generation: valueGeneration, process: processSchema.parse(process), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordCancellation(attemptId: string, valueGeneration: number, reason: string, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/cancel', attemptId, generation: valueGeneration, reason: text.parse(reason), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordExit(attemptId: string, valueGeneration: number, value: z.input<typeof exit>, at = Date.now()): Promise<Record> {
    const parsed = exit.parse(value), prior = this.get(attemptId, valueGeneration)
    if (prior === undefined) throw new Error('External runtime attempt is not durable')
    if (prior.processExit !== undefined) {
      if (sameExit(prior.processExit, parsed)) return prior
      throw new Error('External runtime exit identity is immutable')
    }
    return get(await this.journal.append(current => ({ type: 'external/exit', attemptId, generation: valueGeneration, exit: parsed, at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordGroupStopped(attemptId: string, valueGeneration: number, value: z.input<typeof receipt>, at = Date.now(), turnCompleted = false): Promise<Record> {
    const parsed = receipt.parse(value), prior = this.get(attemptId, valueGeneration)
    if (prior === undefined) throw new Error('External runtime attempt is not durable')
    if (prior.terminal !== undefined) {
      if (sameReceipt(prior.terminal.receipt, parsed) && prior.turnCompleted === turnCompleted) return prior
      throw new Error('External runtime terminal receipt is immutable')
    }
    return get(await this.journal.append(current => ({ type: 'external/group-stopped', attemptId, generation: valueGeneration, receipt: parsed, turnCompleted, at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async markUncertain(attemptId: string, valueGeneration: number, reason: string, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/uncertain', attemptId, generation: valueGeneration, reason: text.parse(reason), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
}
function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw) as Event
  if (event.type === 'external/intent') {
    const old = find(state, event.intent.attemptId, event.intent.generation)
    if (old !== undefined) { sameIntent(old, event.intent); return state }
    return { records: [...state.records, recordSchema.parse({ ...event.intent, phase: 'launch-intent', revision: 1, lastObservedAt: event.at, acceptedOutputCount: 0, fencedOutputCount: 0, retainsCapacity: true })] }
  }
  const old = get(state, event.attemptId, event.generation)
  assertAt(old, event.at)
  if (event.type === 'external/started') {
    if (old.phase !== 'launch-intent' && old.phase !== 'cancelling' && !(old.phase === 'uncertain' && old.process === undefined)) throw new Error('External runtime process cannot start from this phase')
    if (old.process !== undefined) throw new Error('External runtime process identity is immutable')
    const { uncertainty: _uncertainty, ...clean } = old
    return update(state, old, { ...clean, phase: old.cancellation ? 'cancelling' : 'running', process: event.process, ...(event.supervisor === undefined ? {} : { supervisor: event.supervisor }), revision: old.revision + 1, lastObservedAt: event.at })
  }
  if (event.type === 'external/output') return update(state, old, old.cancellation || old.terminal || old.phase === 'uncertain'
    ? { ...old, fencedOutputCount: increment(old.fencedOutputCount), revision: old.revision + 1, lastObservedAt: event.at }
    : { ...old, acceptedOutputCount: increment(old.acceptedOutputCount), revision: old.revision + 1, lastObservedAt: event.at })
  if (event.type === 'external/thread') {
    if (old.cancellation || old.terminal || old.phase === 'uncertain') throw new Error('External runtime thread is fenced')
    if (old.threadId !== undefined && old.threadId !== event.threadId) throw new Error('External runtime thread identity is immutable')
    return old.threadId === event.threadId ? state : update(state, old, { ...old, threadId: event.threadId, revision: old.revision + 1, lastObservedAt: event.at })
  }
  if (event.type === 'external/result') {
    if (old.cancellation || old.terminal || old.phase === 'uncertain') throw new Error('External runtime result is fenced')
    return old.result === event.result ? state : update(state, old, { ...old, result: event.result, revision: old.revision + 1, lastObservedAt: event.at })
  }
  if (event.type === 'external/turn-completed') {
    if (old.cancellation || old.terminal || old.phase === 'uncertain') throw new Error('External runtime completion is fenced')
    return old.turnCompleted ? state : update(state, old, { ...old, turnCompleted: true, revision: old.revision + 1, lastObservedAt: event.at })
  }
  if (event.type === 'external/reconciled') {
    if (old.phase !== 'uncertain' || old.process === undefined || old.process.pid !== event.process.pid || old.process.birthId !== event.process.birthId) throw new Error('External runtime reconciliation requires matching uncertain process identity')
    const { uncertainty: _uncertainty, ...clean } = old
    return update(state, old, { ...clean, phase: old.cancellation ? 'cancelling' : 'running', revision: old.revision + 1, lastObservedAt: event.at })
  }
  if (event.type === 'external/cancel') {
    if (terminalState(old) || old.phase === 'uncertain') throw new Error('External runtime cannot cancel from this phase')
    return update(state, old, old.cancellation ? { ...old, lastObservedAt: event.at } : { ...old, phase: 'cancelling', cancellation: { reason: event.reason, requestedAt: event.at }, revision: old.revision + 1, lastObservedAt: event.at, retainsCapacity: true })
  }
  if (event.type === 'external/exit') {
    if (terminalState(old) || old.process === undefined) throw new Error('External runtime exit is not legal for this phase')
    if (old.processExit !== undefined) {
      if (sameExit(old.processExit, event.exit)) return state
      throw new Error('External runtime exit identity is immutable')
    }
    return update(state, old, { ...old, processExit: event.exit, revision: old.revision + 1, lastObservedAt: event.at, retainsCapacity: true })
  }
  if (event.type === 'external/group-stopped') {
    if (!old.processExit || old.process === undefined) throw new Error('Group-stop receipt requires durable process identity and exit')
    if (old.process.pid !== event.receipt.process.pid || old.process.birthId !== event.receipt.process.birthId) throw new Error('Group-stop receipt process identity does not bind attempt')
    if (terminalState(old)) {
      if (sameReceipt(old.terminal!.receipt, event.receipt) && old.turnCompleted === event.turnCompleted) return state
      throw new Error('External runtime terminal receipt is immutable')
    }
    const outcome = old.cancellation ? 'cancelled' : event.turnCompleted && old.turnCompleted && old.threadId !== undefined && old.result !== undefined && old.processExit.code === 0 && old.processExit.signal === null ? 'completed' : 'failed'
    return update(state, old, { ...old, phase: outcome, revision: old.revision + 1, lastObservedAt: event.at, retainsCapacity: false, terminal: { outcome, exit: old.processExit, receipt: event.receipt, observedAt: event.at } })
  }
  if (terminalState(old)) throw new Error('External runtime is already terminal')
  return update(state, old, { ...old, phase: 'uncertain', revision: old.revision + 1, lastObservedAt: event.at, retainsCapacity: true, uncertainty: event.reason })
}
function key(value: { attemptId: string; generation: number }): string { return `${value.attemptId}:${value.generation}` }
function find(state: State, attemptId: string, valueGeneration: number): Record | undefined { return state.records.find(item => key(item) === key({ attemptId, generation: valueGeneration })) }
function get(state: State, attemptId: string, valueGeneration: number): Record { const found = find(state, attemptId, valueGeneration); if (!found) throw new Error('External runtime attempt is not durable'); return found }
function update(state: State, old: Record, value: Record): State { return { records: state.records.map(item => item === old ? recordSchema.parse(value) : item) } }
function sameIntent(old: Record, value: z.output<typeof intent>): void {
  if (old.provider !== value.provider || JSON.stringify(old.runtimeIdentity) !== JSON.stringify(value.runtimeIdentity) || JSON.stringify(old.admission) !== JSON.stringify(value.admission) || old.inputSha256 !== value.inputSha256 || JSON.stringify(old.spool) !== JSON.stringify(value.spool) || JSON.stringify(old.supervision) !== JSON.stringify(value.supervision) || JSON.stringify(old.worktree) !== JSON.stringify(value.worktree)) throw new Error('External runtime launch intent is immutable')
}
function sameExit(left: z.output<typeof exit>, right: z.output<typeof exit>): boolean { return left.code === right.code && left.signal === right.signal }
function sameReceipt(left: z.output<typeof receipt>, right: z.output<typeof receipt>): boolean { return left.receiptId === right.receiptId && left.process.pid === right.process.pid && left.process.birthId === right.process.birthId && left.groupEmpty === right.groupEmpty }
function terminalState(value: Record): boolean { return value.terminal !== undefined }
function assertAt(value: Record, at: number): void { if (at < value.lastObservedAt) throw new Error('External runtime clock moved backwards') }
function increment(value: number): number { if (value >= 1_000_000) throw new Error('External runtime output counter limit reached'); return value + 1 }
function monotonic(state: State, attemptId: string, valueGeneration: number, at: number): number {
  const value = time.parse(at), old = get(state, attemptId, valueGeneration)
  const prior = old.cancellation?.requestedAt ?? old.terminal?.observedAt
  if (prior !== undefined && value < prior) throw new Error('External runtime clock moved backwards')
  return value
}
