/** Durable submission intent precedes external integration admission. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const submitRequestSchema = z.object({
  attemptId: id, generation: positive, expectedRevision: positive,
  sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), evidence: z.string().trim().min(1).max(16_384),
}).strict()
export type SubmitRequest = z.infer<typeof submitRequestSchema>
const inputSchema = submitRequestSchema.extend({
  projectId: id, teamId: id, taskId: id, runtimeId: id, repository: z.string().min(1), targetBranch: z.string().min(1),
  verification: z.object({ revision: positive, commands: z.array(z.object({ command: z.string().min(1), args: z.array(z.string()) }).strict()).min(1) }).strict(),
}).strict()
export type SubmissionInput = z.infer<typeof inputSchema>
export interface SubmissionRecord extends SubmissionInput { id: string; integrationId: string; phase: 'pending' | 'queued' | 'accepted' }
const envelope = { version: z.literal(1), sequence: positive }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('submission/recorded'), id, input: inputSchema }).strict(),
  z.object({ ...envelope, type: z.literal('submission/queued'), id }).strict(),
  z.object({ ...envelope, type: z.literal('submission/accepted'), id }).strict(),
])
type Payload = { type: 'submission/recorded'; id: string; input: SubmissionInput } | { type: 'submission/queued' | 'submission/accepted'; id: string }
export class SubmissionStore {
  private constructor(private readonly journal: DurableJournal<SubmissionRecord[], Payload>) {}
  static async open(directory: string): Promise<SubmissionStore> {
    return new SubmissionStore(await DurableJournal.open<SubmissionRecord[], Payload>(join(directory, 'submissions.jsonl'), [], (records, raw) => {
      const event = eventSchema.parse(raw)
      if (event.type === 'submission/recorded') {
        if (records.some(record => record.attemptId === event.input.attemptId || record.id === event.id)) throw new Error('Attempt already has a submission')
        return [...records, { ...event.input, id: event.id, integrationId: event.id, phase: 'pending' }]
      }
      const record = records.find(record => record.id === event.id)
      if (!record || record.phase !== (event.type === 'submission/queued' ? 'pending' : 'queued')) throw new Error('Submission is absent or already queued')
      return records.map(record => record.id === event.id ? { ...record, phase: event.type === 'submission/queued' ? 'queued' : 'accepted' } : record)
    }))
  }
  /** The coordinator serializes this with attempt validation and integration admission. */
  async submit(value: SubmissionInput): Promise<SubmissionRecord> {
    const input = inputSchema.parse(value)
    const existing = this.list().find(record => record.attemptId === input.attemptId)
    if (existing) {
      const { id: _id, integrationId: _job, phase: _phase, ...prior } = existing
      if (!isDeepStrictEqual(input, prior)) throw new Error('Submission replay has different immutable inputs')
      return existing
    }
    return (await this.journal.append(() => ({ type: 'submission/recorded', id: randomUUID(), input }))).at(-1)!
  }
  async queued(id: string): Promise<SubmissionRecord> {
    const existing = this.list().find(record => record.id === id)
    if (existing?.phase === 'queued' || existing?.phase === 'accepted') return existing
    return (await this.journal.append(() => ({ type: 'submission/queued', id }))).find(record => record.id === id)!
  }
  async accepted(id: string): Promise<SubmissionRecord> {
    const existing = this.list().find(record => record.id === id)
    if (existing?.phase === 'accepted') return existing
    return (await this.journal.append(() => ({ type: 'submission/accepted', id }))).find(record => record.id === id)!
  }
  list(): SubmissionRecord[] { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }
}
