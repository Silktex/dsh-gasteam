/** Durable reviewed-report intent precedes the managed task receipt. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const text = z.string().trim().min(1).max(16_384)

export const acceptReportRequestSchema = z.object({
  attemptId: id, generation: positive, expectedRevision: positive, expectedTaskRevision: positive, rationale: text,
}).strict()
export type AcceptReportRequest = z.infer<typeof acceptReportRequestSchema>

export const reviewReportsRequestSchema = z.object({ projectId: id }).strict()
export type ReviewReportsRequest = z.infer<typeof reviewReportsRequestSchema>
export const remoteAcceptReportRequestSchema = acceptReportRequestSchema.extend({ projectId: id }).strict()
export type RemoteAcceptReportRequest = z.infer<typeof remoteAcceptReportRequestSchema>

const inputSchema = acceptReportRequestSchema.extend({
  projectId: id, teamId: id, taskId: id, report: text, criteria: text, reviewerId: id,
}).strict()
export type ReportAcceptanceInput = z.infer<typeof inputSchema>
export interface ReportAcceptanceRecord extends ReportAcceptanceInput { readonly id: string; readonly phase: 'pending' | 'accepted' }

/** A scoped Lead review queue item or its durable acceptance audit record. */
export interface ReviewableReport {
  readonly projectId: string
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly generation: number
  readonly expectedRevision: number
  readonly expectedTaskRevision: number
  readonly report: string
  readonly criteria: string
  readonly phase: 'awaiting-review' | 'pending' | 'accepted'
  readonly id?: string
  readonly reviewerId?: string
  readonly rationale?: string
}

const envelope = { version: z.literal(1), sequence: positive }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('report/recorded'), id, input: inputSchema }).strict(),
  z.object({ ...envelope, type: z.literal('report/accepted'), id }).strict(),
])
type Payload = { type: 'report/recorded'; id: string; input: ReportAcceptanceInput } | { type: 'report/accepted'; id: string }

export class ReportStore {
  private constructor(private readonly journal: DurableJournal<ReportAcceptanceRecord[], Payload>) {}

  static async open(directory: string): Promise<ReportStore> {
    return new ReportStore(await DurableJournal.open<ReportAcceptanceRecord[], Payload>(join(directory, 'reports.jsonl'), [], (records, raw) => {
      const event = eventSchema.parse(raw)
      if (event.type === 'report/recorded') {
        if (records.some(record => record.attemptId === event.input.attemptId || record.id === event.id)) throw new Error('Attempt already has a report acceptance')
        return [...records, { ...event.input, id: event.id, phase: 'pending' }]
      }
      const record = records.find(record => record.id === event.id)
      if (!record || record.phase !== 'pending') throw new Error('Report acceptance is absent or already accepted')
      return records.map(record => record.id === event.id ? { ...record, phase: 'accepted' } : record)
    }))
  }

  async record(value: ReportAcceptanceInput): Promise<ReportAcceptanceRecord> {
    const input = inputSchema.parse(value)
    const existing = this.list().find(record => record.attemptId === input.attemptId)
    if (existing) {
      const { id: _id, phase: _phase, ...prior } = existing
      if (!isDeepStrictEqual(input, prior)) throw new Error('Report acceptance replay has different immutable inputs')
      return existing
    }
    return (await this.journal.append(() => ({ type: 'report/recorded', id: randomUUID(), input }))).at(-1)!
  }

  async accepted(id: string): Promise<ReportAcceptanceRecord> {
    const existing = this.list().find(record => record.id === id)
    if (existing?.phase === 'accepted') return existing
    return (await this.journal.append(() => ({ type: 'report/accepted', id }))).find(record => record.id === id)!
  }

  list(): ReportAcceptanceRecord[] { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }
}
