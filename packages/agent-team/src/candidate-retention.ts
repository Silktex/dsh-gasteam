/** Durable, conservative scheduling for removal of accepted Git candidates. */
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const absolute = z.string().refine(value => value.startsWith('/'))
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const duration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const inputSchema = z.object({
  submissionId: id, integrationId: id, repository: absolute, targetBranch: z.string().trim().min(1), cwd: absolute,
  candidateCommit: commit, eligibleAt: timestamp, deadline: timestamp, commandTimeoutMs: duration,
}).strict().refine(value => value.deadline >= value.eligibleAt, 'Retention deadline precedes eligibility')
export type CandidateRetentionInput = z.output<typeof inputSchema>
export type CandidateRetentionPhase = 'queued' | 'running' | 'released' | 'retained' | 'uncertain'
export interface CandidateRetentionRecord extends CandidateRetentionInput {
  readonly phase: CandidateRetentionPhase
  readonly diagnostic?: string
}

const eventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('retention/enqueued'), input: inputSchema }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('retention/running'), submissionId: id }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('retention/released'), submissionId: id }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('retention/retained'), submissionId: id, diagnostic: z.string().min(1).max(16_384) }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('retention/uncertain'), submissionId: id, diagnostic: z.string().min(1).max(16_384) }).strict(),
])
type Payload =
  | { type: 'retention/enqueued'; input: CandidateRetentionInput }
  | { type: 'retention/running' | 'retention/released'; submissionId: string }
  | { type: 'retention/retained' | 'retention/uncertain'; submissionId: string; diagnostic: string }

function reduce(records: CandidateRetentionRecord[], raw: unknown): CandidateRetentionRecord[] {
  const event = eventSchema.parse(raw)
  if (event.type === 'retention/enqueued') {
    if (records.some(record => record.submissionId === event.input.submissionId)) throw new Error('Candidate retention intent already exists')
    return [...records, { ...event.input, phase: 'queued' }]
  }
  const record = records.find(record => record.submissionId === event.submissionId)
  if (!record) throw new Error('Candidate retention intent is absent')
  if (event.type === 'retention/running') {
    if (record.phase !== 'queued') throw new Error('Candidate retention intent is not queued')
    return records.map(value => value.submissionId === event.submissionId ? { ...value, phase: 'running' } : value)
  }
  if (event.type === 'retention/released') {
    if (record.phase !== 'running') throw new Error('Candidate retention intent is not running')
    return records.map(value => value.submissionId === event.submissionId ? { ...value, phase: 'released' } : value)
  }
  if (record.phase !== 'running') throw new Error('Candidate retention intent is not running')
  return records.map(value => value.submissionId === event.submissionId
    ? { ...value, phase: event.type === 'retention/retained' ? 'retained' : 'uncertain', diagnostic: event.diagnostic } : value)
}

/** Separate coordinator-local journal. A running record is never automatically retried after a crash. */
export class CandidateRetentionStore {
  private constructor(private readonly journal: DurableJournal<CandidateRetentionRecord[], Payload>) {}

  static async open(directory: string): Promise<CandidateRetentionStore> {
    return new CandidateRetentionStore(await DurableJournal.open(join(directory, 'candidate-retention.jsonl'), [], reduce))
  }

  list(): CandidateRetentionRecord[] { return this.journal.snapshot() }

  /** The first observation pins the deadline; later configuration changes cannot shorten existing retention. */
  async enqueue(value: CandidateRetentionInput): Promise<CandidateRetentionRecord> {
    const input = inputSchema.parse(value)
    const existing = this.list().find(record => record.submissionId === input.submissionId)
    if (existing) {
      const { eligibleAt: _eligibleAt, deadline: _deadline, commandTimeoutMs: _timeout, phase: _phase, diagnostic: _diagnostic, ...prior } = existing
      const { eligibleAt: _nextEligibleAt, deadline: _nextDeadline, commandTimeoutMs: _nextTimeout, ...next } = input
      if (!isDeepStrictEqual(prior, next)) throw new Error('Candidate retention replay has different immutable inputs')
      return existing
    }
    return (await this.journal.append(() => ({ type: 'retention/enqueued', input }))).at(-1)!
  }

  due(now: number): CandidateRetentionRecord[] {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Retention clock must be a non-negative safe integer')
    return this.list().filter(record => record.phase === 'queued' && record.deadline <= now)
  }

  async start(submissionId: string): Promise<CandidateRetentionRecord> {
    const record = this.require(submissionId)
    if (record.phase !== 'queued') return record
    return (await this.journal.append(() => ({ type: 'retention/running', submissionId }))).find(record => record.submissionId === submissionId)!
  }

  async settle(submissionId: string, phase: 'released' | 'retained' | 'uncertain', diagnostic?: string): Promise<CandidateRetentionRecord> {
    const record = this.require(submissionId)
    if (record.phase === phase) return record
    if (record.phase !== 'running') throw new Error('Candidate retention intent is not running')
    const message = diagnostic?.trim().slice(0, 16_384)
    if (phase !== 'released' && !message) throw new Error('Retained or uncertain candidate requires a diagnostic')
    const event = phase === 'released' ? { type: 'retention/released' as const, submissionId }
      : { type: phase === 'retained' ? 'retention/retained' as const : 'retention/uncertain' as const, submissionId, diagnostic: message! }
    return (await this.journal.append(() => event)).find(record => record.submissionId === submissionId)!
  }

  /** Crash recovery records uncertainty instead of repeating a possibly completed worktree removal. */
  async recoverInterrupted(): Promise<CandidateRetentionRecord[]> {
    const interrupted = this.list().filter(record => record.phase === 'running')
    for (const record of interrupted) await this.settle(record.submissionId, 'uncertain', 'Candidate cleanup was interrupted after durable running intent; outcome uncertain; no automatic retry')
    return this.list().filter(record => record.phase === 'uncertain')
  }

  close(): Promise<void> { return this.journal.close() }

  private require(submissionId: string): CandidateRetentionRecord {
    const record = this.list().find(value => value.submissionId === submissionId)
    if (!record) throw new Error('Candidate retention intent is absent')
    return record
  }
}
