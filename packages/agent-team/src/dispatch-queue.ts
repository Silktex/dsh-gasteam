/** Durable scheduling order; assignment records remain authoritative for runtime ownership. */
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const workSchema = z.object({ projectId: z.string().min(1), teamId: z.string().min(1), taskId: z.string().min(1) }).strict()
export type DispatchWork = z.output<typeof workSchema>
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const priority = z.number().int().min(-1_000_000).max(1_000_000)
const requestSchema = workSchema.extend({ order: integer.min(1), priority, revision: integer.min(1), cancelReason: z.string().min(1).max(16_384).optional() }).strict()
export type DispatchRequest = z.output<typeof requestSchema>
const envelope = { version: z.literal(1), sequence: integer.min(1) }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('dispatch/enqueued'), work: workSchema, priority }).strict(),
  z.object({ ...envelope, type: z.literal('dispatch/priority'), work: workSchema, expectedRevision: integer.min(1), priority }).strict(),
  z.object({ ...envelope, type: z.literal('dispatch/cancelled'), work: workSchema, expectedRevision: integer.min(1), reason: z.string().trim().min(1).max(16_384) }).strict(),
  z.object({ ...envelope, type: z.literal('dispatch/selected'), work: workSchema, at: integer }).strict(),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, 'version' | 'sequence'> : never : never
interface State { requests: DispatchRequest[]; turns: Record<string, number>; lastDispatchAt: number | undefined }
export const sameDispatchWork = (a: DispatchWork, b: DispatchWork): boolean => a.projectId === b.projectId && a.teamId === b.teamId && a.taskId === b.taskId
function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw)
  const existing = state.requests.find(request => sameDispatchWork(request, event.work))
  if (event.type === 'dispatch/enqueued') {
    if (existing) throw new Error('Dispatch request already exists')
    return { ...state, requests: [...state.requests, { ...event.work, priority: event.priority, order: event.sequence, revision: 1 }] }
  }
  if (!existing) throw new Error('Dispatch request is missing')
  if (event.type === 'dispatch/priority' || event.type === 'dispatch/cancelled') {
    if (existing.revision !== event.expectedRevision) throw new Error('Stale dispatch revision')
    if (existing.cancelReason !== undefined) throw new Error('Dispatch request is cancelled')
    return { ...state, requests: state.requests.map(request => request === existing ? { ...request,
      ...(event.type === 'dispatch/priority' ? { priority: event.priority } : { cancelReason: event.reason }), revision: request.revision + 1 } : request) }
  }
  if (state.lastDispatchAt !== undefined && event.at < state.lastDispatchAt) throw new Error('Dispatch clock moved backwards')
  return { ...state, turns: { ...state.turns, [event.work.projectId]: event.sequence }, lastDispatchAt: event.at }
}

export class DispatchQueue {
  private constructor(private readonly journal: DurableJournal<State, Payload>) {}
  static async open(directory: string): Promise<DispatchQueue> {
    return new DispatchQueue(await DurableJournal.open<State, Payload>(join(directory, 'dispatch.jsonl'), { requests: [], turns: {}, lastDispatchAt: undefined }, reduce))
  }
  list(): DispatchRequest[] { return this.journal.snapshot().requests }
  nextDispatchAt(intervalMs: number): number | undefined {
    const last = this.journal.snapshot().lastDispatchAt
    return last === undefined ? undefined : last + intervalMs
  }
  async enqueue(work: DispatchWork): Promise<void> {
    workSchema.parse(work)
    if (this.list().some(request => sameDispatchWork(request, work))) return
    await this.journal.append(() => ({ type: 'dispatch/enqueued', work, priority: 0 }))
  }
  async reprioritize(work: DispatchWork, expectedRevision: number, value: number): Promise<void> {
    await this.journal.append(() => ({ type: 'dispatch/priority', work, expectedRevision, priority: value }))
  }
  async cancel(work: DispatchWork, expectedRevision: number, reason: string): Promise<void> {
    await this.journal.append(() => ({ type: 'dispatch/cancelled', work, expectedRevision, reason }))
  }
  /** Caller serializes selection with assignment reservation. Ineligible requests retain their order. */
  async select(eligible: (request: DispatchRequest) => boolean, now: number, intervalMs: number): Promise<DispatchRequest | undefined> {
    integer.parse(now); integer.parse(intervalMs)
    const state = this.journal.snapshot()
    if (state.lastDispatchAt !== undefined && now - state.lastDispatchAt < intervalMs) return undefined
    const turn = (projectId: string): number => Object.hasOwn(state.turns, projectId) ? state.turns[projectId]! : 0
    const candidates = state.requests.filter(request => request.cancelReason === undefined && eligible(request))
    const project = [...candidates].sort((a, b) =>
      turn(a.projectId) - turn(b.projectId) || a.order - b.order,
    )[0]?.projectId
    const request = candidates.filter(request => request.projectId === project)
      .sort((a, b) => b.priority - a.priority || a.order - b.order)[0]
    if (!request) return undefined
    await this.journal.append(() => ({ type: 'dispatch/selected', work: { projectId: request.projectId, teamId: request.teamId, taskId: request.taskId }, at: now }))
    return request
  }
  close(): Promise<void> { return this.journal.close() }
}
