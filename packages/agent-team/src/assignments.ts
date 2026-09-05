/** Durable reservations and execution attempts, separate from worker and session identities. */
import { join } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'
import type { ProjectId } from './projects.ts'

export type WorkerId = Branded<'WorkerId'>
export type AttemptId = Branded<'AttemptId'>
export type AssignmentId = Branded<'AssignmentId'>
export type WorkflowId = Branded<'WorkflowId'>
export type EscalationId = Branded<'EscalationId'>
export type WorkspaceBatchId = Branded<'WorkspaceBatchId'>
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const text = z.string().trim().min(1).max(16_384)
const externalPolicySchema = z.object({
  projectId: id, directory: text,
  admission: z.object({ executable: text, configuredExecutable: text, version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/), executableVerification: z.literal('verified'), cwd: text, model: z.string().trim().min(1).max(512), sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']), authStatus: z.literal('authenticated') }).strict(),
  maxSpoolBytes: z.number().int().positive().max(16 * 1024 * 1024), terminateGraceMs: z.number().int().positive().max(300_000),
}).strict()
const checkpointSchema = z.object({
  task: z.object({ subject: text, description: text, nonCodeCriteria: text.optional() }).strict(),
  workflowId: id.optional(), workflowStep: text.optional(), step: text,
  artifacts: z.array(z.object({ kind: z.enum(['commit', 'file', 'report']), ref: text }).strict()).max(256),
  nextAction: text,
}).strict()
const legacyRequestSchema = z.object({
  projectId: id, teamId: id, taskId: id, workerId: id, runtimeId: id, provider: id,
  repairLimit: z.number().int().min(0).max(10).optional(),
  repair: z.object({ previousAttemptId: id, submissionId: id, integrationId: id,
    sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    candidateCwd: text, diagnostic: text, round: positive,
  }).strict().optional(),
  expectedGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), checkpoint: checkpointSchema,
  externalPolicy: externalPolicySchema.optional(),
}).strict()
const requestSchema = legacyRequestSchema.superRefine((value, ctx) => {
  if (value.provider === 'external' && value.externalPolicy === undefined) ctx.addIssue({ code: 'custom', message: 'External assignment requires an immutable verified provider policy' })
  if (value.provider !== 'external' && value.externalPolicy !== undefined) ctx.addIssue({ code: 'custom', message: 'Only external assignments may carry an external provider policy' })
})
const tokenSchema = z.object({ attemptId: id, generation: positive, expectedRevision: positive }).strict()
const stopSchema = z.object({ runtimeId: id, kind: z.enum(['stopped', 'never-started']), receipt: text }).strict()
const interruptionRequestSchema = z.object({ reason: z.literal('coordinator-shutdown'), receipt: text }).strict()
const interruptionSchema = interruptionRequestSchema.extend({ count: positive }).strict()
const envelope = { version: z.literal(1), sequence: positive }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('assignment/reserved'), request: legacyRequestSchema }).strict(),
  z.object({ ...envelope, type: z.literal('attempt/recovery'), token: tokenSchema, observedSequence: z.number().int().nonnegative(), notBefore: z.number().int().nonnegative(), messageId: id }).strict(),
  z.object({ ...envelope, type: z.literal('attempt/activated'), token: tokenSchema }).strict(),
  z.object({ ...envelope, type: z.literal('attempt/checkpoint'), token: tokenSchema, checkpoint: checkpointSchema }).strict(),
  z.object({ ...envelope, type: z.literal('attempt/reported'), token: tokenSchema, result: text }).strict(),
  z.object({ ...envelope, type: z.literal('attempt/stopping'), token: tokenSchema, reason: text }).strict(),
  z.object({ ...envelope, type: z.literal('attempt/retired'), token: tokenSchema, evidence: stopSchema }).strict(),
  z.object({ ...envelope, type: z.literal('attempt/interrupted'), token: tokenSchema, evidence: stopSchema, interruption: interruptionRequestSchema }).strict(),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, 'version' | 'sequence'> : never : never
export type AssignmentCheckpoint = z.input<typeof checkpointSchema>
export type ExternalProviderPolicy = z.output<typeof externalPolicySchema>
export type ReserveAssignmentRequest = z.input<typeof requestSchema>
export type AttemptToken = z.input<typeof tokenSchema>
export type RuntimeStopEvidence = z.input<typeof stopSchema>
export interface AttemptRecord extends Omit<ReserveAssignmentRequest, 'expectedGeneration' | 'projectId' | 'workerId'> {
  readonly projectId: ProjectId
  readonly workerId: WorkerId
  readonly attemptId: AttemptId
  readonly assignmentId: AssignmentId
  readonly generation: number
  readonly revision: number
  readonly phase: 'reserved' | 'active' | 'stopping' | 'terminal'
  readonly recovery?: { count: number; observedSequence: number; notBefore: number; messageId: string }
  readonly result?: string
  readonly stopReason?: string
  readonly stopEvidence?: RuntimeStopEvidence
  /** A coordinator shutdown is recoverable after a positive provider stop receipt. */
  readonly interruption?: z.output<typeof interruptionSchema>
}
const limitsSchema = z.object({
  globalCapacity: positive, projectCapacities: z.record(id, positive),
}).strict()
export type AssignmentLimits = z.input<typeof limitsSchema>

function sameTask(record: AttemptRecord, task: ReserveAssignmentRequest): boolean {
  return record.projectId === task.projectId && record.teamId === task.teamId && record.taskId === task.taskId
}

/** Replay validates ownership and legal edges, even if deployment capacity changes after a restart. */
function reduce(records: AttemptRecord[], raw: unknown): AttemptRecord[] {
  const event = eventSchema.parse(raw)
  if (event.type === 'assignment/reserved') {
    const request = event.request
    const prior = records.filter(record => sameTask(record, request)).at(-1)
    if ((prior?.generation ?? 0) !== request.expectedGeneration) throw new Error('Stale assignment generation')
    if (prior !== undefined && prior.phase !== 'terminal') throw new Error('Task is already owned')
    if (prior && request.repairLimit !== prior.repairLimit) throw new Error('Repair policy is immutable for accepted work')
    if (prior?.interruption && prior.interruption.count >= (request.repairLimit ?? 0)) throw new Error('Coordinator interruption retry budget is exhausted')
    if (request.repair) {
      if (!prior || prior.stopEvidence?.kind !== 'stopped' || prior.stopReason || !prior.result
        || request.repair.previousAttemptId !== prior.attemptId
        || request.repair.round !== (prior.repair?.round ?? 0) + 1
        || request.repair.round > (request.repairLimit ?? 0)) throw new Error('Invalid or exhausted repair attempt')
    } else if (prior?.repair) throw new Error('Replacement cannot erase repair history')
    if (records.some(record => record.phase !== 'terminal' && record.workerId === request.workerId)) throw new Error('Worker is already assigned')
    // A runtime identity is an immutable attempt reference; it is never reused after termination.
    if (records.some(record => record.runtimeId === request.runtimeId)) throw new Error('Runtime identity is already assigned')
    const { expectedGeneration, ...identity } = request
    const record = {
      ...identity, attemptId: `attempt-${event.sequence}`, assignmentId: `assignment-${event.sequence}`,
      generation: expectedGeneration + 1, revision: 1, phase: 'reserved',
    } as AttemptRecord
    return [...records, record]
  }
  const index = records.findIndex(record => record.attemptId === event.token.attemptId)
  const current = records[index]
  if (!current || current.generation !== event.token.generation) throw new Error('Stale attempt generation')
  if (current.phase === 'terminal') throw new Error('Attempt is terminal; stale workers have no authority')
  if (current.revision !== event.token.expectedRevision) throw new Error('Stale attempt revision')
  let next: AttemptRecord = { ...current, revision: current.revision + 1 }
  switch (event.type) {
    case 'attempt/recovery':
      if (current.phase !== 'active' || (current.recovery?.count ?? 0) >= 3) throw new Error('Recovery requires an active attempt with remaining budget')
      next = { ...next, recovery: { count: (current.recovery?.count ?? 0) + 1, observedSequence: event.observedSequence, notBefore: event.notBefore, messageId: event.messageId } }
      break
    case 'attempt/activated':
      if (current.phase !== 'reserved') throw new Error('Activation requires a reserved attempt')
      next = { ...next, phase: 'active' }
      break
    case 'attempt/checkpoint':
      if (current.phase !== 'active') throw new Error('Checkpoint requires an active attempt')
      next = { ...next, checkpoint: event.checkpoint }
      break
    case 'attempt/reported':
      if (current.phase !== 'active') throw new Error('Report requires an active attempt')
      next = { ...next, result: event.result }
      break
    case 'attempt/stopping':
      if (current.phase === 'stopping') throw new Error('Attempt is already stopping')
      next = { ...next, phase: 'stopping', stopReason: event.reason }
      break
    case 'attempt/retired':
      if (event.evidence.runtimeId !== current.runtimeId) throw new Error('Stop evidence is for a different runtime')
      if (event.evidence.kind === 'never-started' && current.phase !== 'reserved') throw new Error('Never-started evidence requires a reserved attempt')
      next = { ...next, phase: 'terminal', stopEvidence: event.evidence }
      break
    case 'attempt/interrupted':
      if (event.evidence.runtimeId !== current.runtimeId) throw new Error('Interruption evidence is for a different runtime')
      if (event.evidence.kind === 'never-started' && current.phase !== 'reserved') throw new Error('Never-started interruption requires a reserved attempt')
      next = { ...next, phase: 'terminal', stopEvidence: event.evidence,
        interruption: { ...event.interruption, count: records.filter(record => record.projectId === current.projectId && record.teamId === current.teamId && record.taskId === current.taskId && record.interruption !== undefined).length + 1 } }
      break
  }
  return records.map((record, position) => position === index ? next : record)
}

/** Coordinator-owned store. Runtime-stop evidence must come from its trusted provider adapter. */
export class AssignmentStore {
  private constructor(
    private readonly journal: DurableJournal<AttemptRecord[], Payload>, private limits: AssignmentLimits,
  ) {}

  static async open(directory: string, limits: AssignmentLimits): Promise<AssignmentStore> {
    const validated = limitsSchema.parse(limits)
    return new AssignmentStore(await DurableJournal.open(join(directory, 'assignments.jsonl'), [], reduce), validated)
  }

  /** Coordinator policy is authoritative; changing limits never releases existing reservations. */
  configure(limits: AssignmentLimits): void { this.limits = limitsSchema.parse(limits) }

  async reserve(request: ReserveAssignmentRequest): Promise<AttemptRecord> {
    const input = requestSchema.parse(request)
    const records = await this.journal.append(records => {
      const projectCapacity = Object.hasOwn(this.limits.projectCapacities, input.projectId)
        ? this.limits.projectCapacities[input.projectId] : undefined
      if (projectCapacity === undefined) throw new Error('Project is not configured for assignments')
      const active = records.filter(record => record.phase !== 'terminal')
      if (active.length >= this.limits.globalCapacity || active.filter(record => record.projectId === input.projectId).length >= projectCapacity) {
        throw new Error('Concurrent assignment capacity is full')
      }
      return { type: 'assignment/reserved', request: input }
    })
    return records.at(-1)!
  }

  recover(token: AttemptToken, observedSequence: number, notBefore: number, messageId: string): Promise<AttemptRecord> {
    return this.mutate({ type: 'attempt/recovery', token, observedSequence, notBefore, messageId })
  }
  activate(token: AttemptToken): Promise<AttemptRecord> { return this.mutate({ type: 'attempt/activated', token }) }
  checkpoint(token: AttemptToken, checkpoint: AssignmentCheckpoint): Promise<AttemptRecord> {
    return this.mutate({ type: 'attempt/checkpoint', token, checkpoint })
  }
  report(token: AttemptToken, result: string): Promise<AttemptRecord> { return this.mutate({ type: 'attempt/reported', token, result }) }
  stop(token: AttemptToken, reason: string): Promise<AttemptRecord> { return this.mutate({ type: 'attempt/stopping', token, reason }) }
  retire(token: AttemptToken, evidence: RuntimeStopEvidence): Promise<AttemptRecord> {
    return this.mutate({ type: 'attempt/retired', token, evidence })
  }
  interrupt(token: AttemptToken, evidence: RuntimeStopEvidence): Promise<AttemptRecord> {
    return this.mutate({ type: 'attempt/interrupted', token, evidence, interruption: { reason: 'coordinator-shutdown', receipt: evidence.receipt } })
  }
  list(): AttemptRecord[] { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }

  private async mutate(event: Exclude<Payload, { type: 'assignment/reserved' }>): Promise<AttemptRecord> {
    const snapshot = structuredClone(event)
    const records = await this.journal.append(() => snapshot)
    return records.find(record => record.attemptId === snapshot.token.attemptId)!
  }
}
