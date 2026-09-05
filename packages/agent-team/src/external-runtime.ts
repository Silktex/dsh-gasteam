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
const exit = z.object({ code: z.number().int().nonnegative().nullable(), signal: z.string().trim().min(1).max(128).nullable() }).strict()
const receipt = z.object({ receiptId: id, process: processSchema, groupEmpty: z.literal(true) }).strict()
const intent = z.object({ attemptId: id, generation, provider: id, runtimeIdentity, spool: spool.optional() }).strict().superRefine((value, ctx) => {
  if (value.provider !== value.runtimeIdentity.provider || value.attemptId !== value.runtimeIdentity.attemptId || value.generation !== value.runtimeIdentity.generation) ctx.addIssue({ code: 'custom', message: 'External runtime identity must bind the durable attempt' })
})
const terminal = z.object({ outcome: z.enum(['completed', 'failed', 'cancelled']), exit, receipt, observedAt: time }).strict()
const recordSchema = intent.extend({
  phase: z.enum(['launch-intent', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'uncertain']), revision: z.number().int().positive(), lastObservedAt: time,
  acceptedOutputCount: z.number().int().nonnegative().max(1_000_000), fencedOutputCount: z.number().int().nonnegative().max(1_000_000), retainsCapacity: z.boolean(),
  process: processSchema.optional(), processExit: exit.optional(), cancellation: z.object({ reason: text, requestedAt: time }).strict().optional(),
  terminal: terminal.optional(), uncertainty: text.optional(),
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
  | { type: 'external/started'; attemptId: string; generation: number; process: ProcessBirthIdentity; at: number }
  | { type: 'external/output'; attemptId: string; generation: number; output: ExternalRuntimeOutput; at: number }
  | { type: 'external/cancel'; attemptId: string; generation: number; reason: string; at: number }
  | { type: 'external/exit'; attemptId: string; generation: number; exit: z.output<typeof exit>; at: number }
  | { type: 'external/group-stopped'; attemptId: string; generation: number; receipt: z.output<typeof receipt>; turnCompleted: boolean; at: number }
  | { type: 'external/uncertain'; attemptId: string; generation: number; reason: string; at: number }
type Event = Payload & { version: 1; sequence: number }
const output = z.object({ type: id, text }).strict()
const eventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/intent'), intent, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/started'), attemptId: id, generation, process: processSchema, at: time }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('external/output'), attemptId: id, generation, output, at: time }).strict(),
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
  async recordProcessStarted(attemptId: string, valueGeneration: number, process: ProcessBirthIdentity, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/started', attemptId, generation: valueGeneration, process: processSchema.parse(process), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
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
  async recordCancellation(attemptId: string, valueGeneration: number, reason: string, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/cancel', attemptId, generation: valueGeneration, reason: text.parse(reason), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordExit(attemptId: string, valueGeneration: number, value: z.input<typeof exit>, at = Date.now()): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/exit', attemptId, generation: valueGeneration, exit: exit.parse(value), at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
  }
  async recordGroupStopped(attemptId: string, valueGeneration: number, value: z.input<typeof receipt>, at = Date.now(), turnCompleted = false): Promise<Record> {
    return get(await this.journal.append(current => ({ type: 'external/group-stopped', attemptId, generation: valueGeneration, receipt: receipt.parse(value), turnCompleted, at: monotonic(current, attemptId, valueGeneration, at) })), attemptId, valueGeneration)
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
    if (old.phase !== 'launch-intent' && old.phase !== 'cancelling') throw new Error('External runtime process cannot start from this phase')
    if (old.process !== undefined) throw new Error('External runtime process identity is immutable')
    return update(state, old, { ...old, phase: old.cancellation ? 'cancelling' : 'running', process: event.process, revision: old.revision + 1, lastObservedAt: event.at })
  }
  if (event.type === 'external/output') return update(state, old, old.cancellation || old.terminal || old.phase === 'uncertain'
    ? { ...old, fencedOutputCount: increment(old.fencedOutputCount), revision: old.revision + 1, lastObservedAt: event.at }
    : { ...old, acceptedOutputCount: increment(old.acceptedOutputCount), revision: old.revision + 1, lastObservedAt: event.at })
  if (event.type === 'external/cancel') {
    if (terminalState(old) || old.phase === 'uncertain') throw new Error('External runtime cannot cancel from this phase')
    return update(state, old, old.cancellation ? { ...old, lastObservedAt: event.at } : { ...old, phase: 'cancelling', cancellation: { reason: event.reason, requestedAt: event.at }, revision: old.revision + 1, lastObservedAt: event.at, retainsCapacity: true })
  }
  if (event.type === 'external/exit') {
    if (terminalState(old) || old.processExit !== undefined || old.process === undefined) throw new Error('External runtime exit is not legal for this phase')
    return update(state, old, { ...old, processExit: event.exit, revision: old.revision + 1, lastObservedAt: event.at, retainsCapacity: true })
  }
  if (event.type === 'external/group-stopped') {
    if (!old.processExit || old.process === undefined) throw new Error('Group-stop receipt requires durable process identity and exit')
    if (old.process.pid !== event.receipt.process.pid || old.process.birthId !== event.receipt.process.birthId) throw new Error('Group-stop receipt process identity does not bind attempt')
    if (terminalState(old)) throw new Error('External runtime is already terminal')
    const outcome = old.cancellation ? 'cancelled' : event.turnCompleted && old.processExit.code === 0 && old.processExit.signal === null ? 'completed' : 'failed'
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
  if (old.provider !== value.provider || JSON.stringify(old.runtimeIdentity) !== JSON.stringify(value.runtimeIdentity) || JSON.stringify(old.spool) !== JSON.stringify(value.spool)) throw new Error('External runtime launch intent is immutable')
}
function terminalState(value: Record): boolean { return value.terminal !== undefined }
function assertAt(value: Record, at: number): void { if (at < value.lastObservedAt) throw new Error('External runtime clock moved backwards') }
function increment(value: number): number { if (value >= 1_000_000) throw new Error('External runtime output counter limit reached'); return value + 1 }
function monotonic(state: State, attemptId: string, valueGeneration: number, at: number): number {
  const value = time.parse(at), old = get(state, attemptId, valueGeneration)
  const prior = old.cancellation?.requestedAt ?? old.terminal?.observedAt
  if (prior !== undefined && value < prior) throw new Error('External runtime clock moved backwards')
  return value
}
