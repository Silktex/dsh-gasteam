import { join } from 'node:path'
import { createHash } from 'node:crypto'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const condition = z.enum(['stale', 'failed'])
const phase = z.enum(['intent', 'revalidated', 'requested', 'receipt'])
const binding = z.object({ attemptId: id, generation: positive, healthRevision: positive, condition }).strict()
const recordSchema = binding.extend({ maxNudges: positive, messageId: id, phase, revision: positive, receipt: id.optional() }).strict()
type Record = z.output<typeof recordSchema>
type Input = z.input<typeof binding> & { readonly maxNudges: number }
type Event =
  | { type: 'intent'; input: Input }
  | { type: 'revalidated'; attemptId: string; generation: number; healthRevision: number; condition: 'stale' | 'failed' }
  | { type: 'requested'; attemptId: string; generation: number; healthRevision: number; condition: 'stale' | 'failed' }
  | { type: 'receipt'; attemptId: string; generation: number; healthRevision: number; condition: 'stale' | 'failed'; receipt: string }

const eventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('intent'), input: binding.extend({ maxNudges: positive }).strict() }).strict(),
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('revalidated'), ...binding.shape }).strict(),
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('requested'), ...binding.shape }).strict(),
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('receipt'), ...binding.shape, receipt: id }).strict(),
])
function key(v: z.output<typeof binding>) { return `${v.attemptId}:${v.generation}:${v.healthRevision}:${v.condition}` }
function messageId(v: z.output<typeof binding>) { return `health-nudge-${createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 48)}` }
function reduce(state: Record[], raw: unknown): Record[] {
  const event = eventSchema.parse(raw)
  const input = event.type === 'intent' ? event.input : event
  const index = state.findIndex(item => key(item) === key(input))
  const prior = state[index]
  if (event.type === 'intent') {
    const intent = event.input
    const bound = binding.parse({ attemptId: intent.attemptId, generation: intent.generation, healthRevision: intent.healthRevision, condition: intent.condition })
    const next = { ...bound, maxNudges: intent.maxNudges, messageId: messageId(bound), phase: 'intent' as const, revision: 1 }
    if (prior && (prior.maxNudges !== next.maxNudges || prior.messageId !== next.messageId)) throw new Error('Recovery intent replay differs from immutable binding')
    const siblings = state.filter(item => item.attemptId === bound.attemptId && item.generation === bound.generation)
    if (!prior && siblings[0] !== undefined && siblings[0].maxNudges !== next.maxNudges) {
      throw new Error('Recovery nudge budget is immutable for one attempt generation')
    }
    if (!prior && siblings.length >= (siblings[0]?.maxNudges ?? next.maxNudges)) throw new Error('Recovery nudge budget exhausted')
    return prior ? state : [...state, next]
  }
  if (!prior) throw new Error('Recovery transition requires durable intent')
  if (event.type === 'receipt' && prior.phase === 'receipt') { if (prior.receipt !== event.receipt) throw new Error('Recovery receipt replay differs'); return state }
  if (prior.phase === event.type || prior.phase === 'receipt' || (event.type === 'revalidated' && prior.phase === 'requested')) return state
  const allowed = event.type === 'revalidated' ? prior.phase === 'intent' : event.type === 'requested' ? prior.phase === 'revalidated' : prior.phase === 'requested'
  if (!allowed) throw new Error('Invalid recovery transition')
  const next: Record = event.type === 'receipt' ? { ...prior, phase: 'receipt', receipt: event.receipt, revision: prior.revision + 1 }
    : { ...prior, phase: event.type, revision: prior.revision + 1 }
  return state.map((item, i) => i === index ? next : item)
}

/** Durable intent ledger. Intent admission conservatively consumes its immutable generation budget even when fresh revalidation later rejects delivery. */
export class HealthRecoveryStore {
  private constructor(private readonly journal: DurableJournal<Record[], Event>) {}
  static async open(directory: string): Promise<HealthRecoveryStore> { return new HealthRecoveryStore(await DurableJournal.open(join(directory, 'health-recovery.jsonl'), [], reduce)) }
  async intent(input: Input): Promise<Record> { return this.apply({ type: 'intent', input: z.object({ ...binding.shape, maxNudges: positive }).strict().parse(input) }) }
  async revalidate(input: z.output<typeof binding>): Promise<Record> { return this.apply({ type: 'revalidated', ...binding.parse(input) }) }
  async request(input: z.output<typeof binding>): Promise<Record> { return this.apply({ type: 'requested', ...binding.parse(input) }) }
  async receipt(input: z.output<typeof binding>, receipt: string): Promise<Record> { return this.apply({ type: 'receipt', ...binding.parse({ attemptId: input.attemptId, generation: input.generation, healthRevision: input.healthRevision, condition: input.condition }), receipt: id.parse(receipt) }) }
  list(): Record[] { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }
  private async apply(event: Event): Promise<Record> { const state = await this.journal.append(() => event); return state.find(item => key(item) === key(event.type === 'intent' ? event.input : event))! }
}

export interface HealthRecoveryCapabilities {
  current(input: { attemptId: string; generation: number }): Promise<{ attemptId: string; generation: number; healthRevision: number; condition: 'stale' | 'failed'; actionable: boolean; acknowledged: boolean; assignmentRevision: number; observedSequence: number; active: boolean }>
  reserve(input: { attemptId: string; generation: number; assignmentRevision: number; observedSequence: number; notBefore: number; messageId: string }): Promise<void>
  deliver(input: { attemptId: string; generation: number; messageId: string }): Promise<string>
}

/** Executes only after a fresh authoritative read; delivery itself is idempotent by messageId. */
export class HealthRecoveryExecutor {
  constructor(private readonly store: HealthRecoveryStore, private readonly capabilities: HealthRecoveryCapabilities) {}
  async nudge(input: Input): Promise<Record | undefined> {
    const intent = await this.store.intent(input)
    const current = await this.capabilities.current(input)
    if (current.attemptId !== input.attemptId || current.generation !== input.generation
      || !current.actionable || current.acknowledged || !current.active
      || current.healthRevision !== input.healthRevision || current.condition !== input.condition) return undefined
    let state = await this.store.revalidate({ attemptId: input.attemptId, generation: input.generation, healthRevision: input.healthRevision, condition: input.condition })
    if (state.phase === 'receipt') return state
    state = await this.store.request({ attemptId: input.attemptId, generation: input.generation, healthRevision: input.healthRevision, condition: input.condition })
    await this.capabilities.reserve({ attemptId: input.attemptId, generation: input.generation, assignmentRevision: current.assignmentRevision,
      observedSequence: current.observedSequence, notBefore: Date.now(), messageId: intent.messageId })
    return await this.store.receipt(input, await this.capabilities.deliver({ attemptId: input.attemptId, generation: input.generation, messageId: intent.messageId }))
  }
}
