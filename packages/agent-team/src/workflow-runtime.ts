/** Host-only vertical runtime for the pinned investigation/report workflow. */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'
import type { ReportAcceptanceRecord } from './reports.ts'
import { ReportStore } from './reports.ts'
import { pinWorkflowDefinition, validateWorkflowTemplate, WorkflowStore } from './workflows.ts'
import type { ArtifactReference, CandidateReplacement, PinnedWorkflowDefinition, WorkflowExecution } from './workflows.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const text = z.string().trim().min(1).max(16_384)
const scalar = z.union([z.string().max(16_384), z.number().finite(), z.boolean()])

/** The registered project grant required to create or resume its workflow work. */
export interface WorkflowRuntimeProject {
  readonly id: string
  readonly teamIds: readonly string[]
  readonly publicationGrants?: readonly { readonly teamId: string; readonly authorization: string }[]
  readonly publicationPublisher?: { readonly identity: string; readonly revision: number }
}
export interface WorkflowPublicationIntent { readonly idempotencyKey: string; readonly executionId: string; readonly stepId: string; readonly authorization: string; readonly publisherIdentity: string; readonly publisherRevision: number; readonly evidence: ArtifactReference; readonly release: ArtifactReference }
export interface WorkflowPublicationReceipt { readonly publisher: string; readonly publisherIdentity: string; readonly publisherRevision: number; readonly reference: ArtifactReference; readonly idempotencyKey: string; readonly authorization: string; readonly evidence: ArtifactReference; readonly release: ArtifactReference }

/** Persisted before the host is allowed to create the corresponding Team task. */
export interface WorkflowTaskCreateIntent {
  readonly intentId: string
  readonly projectId: string
  readonly teamId: string
  readonly executionId: string
  readonly stepId: string
  readonly subject: string
  readonly description: string
  readonly nonCodeCriteria: string
  /** Exact completed artifacts required by this workflow step. */
  readonly inputs: { name: string; artifact: { kind: 'commit' | 'file' | 'report'; ref: string } }[]
  readonly candidateRound?: number | undefined
  readonly review?: { readonly integrationId: string; readonly sourceCommit: string; readonly targetCommit: string; readonly candidateCommit: string; readonly reviewGate: string } | undefined
}

/**
 * Host boundary for task creation. The implementation must key idempotency on
 * `intentId`; it must never infer ownership from user-visible task text.
 */
export interface WorkflowTaskHost {
  createPinnedTask(intent: WorkflowTaskCreateIntent): Promise<{ taskId: string }>
  /** Code task admission is separate so the ordinary report task cannot accidentally submit Git output. */
  createPinnedCodeTask?(intent: WorkflowCodeTaskCreateIntent): Promise<{ taskId: string }>
  /** Read-only projection of the submission/integration owned by one pinned code task. */
  codeStatus?(intent: WorkflowCodeTaskCreateIntent): Promise<WorkflowCodeStatus | undefined>
  /** Host policy authorization for the exact candidate and accepted reviewer report. */
  approvePinnedIntegration?(receipt: WorkflowIntegrationApproval): Promise<void>
  publishAuthorizedRelease?(intent: WorkflowPublicationIntent): Promise<WorkflowPublicationReceipt>
  publicationPublisher?: { readonly identity: string; readonly revision: number }
}

export interface WorkflowCodeTaskCreateIntent {
  readonly intentId: string
  readonly projectId: string
  readonly teamId: string
  readonly executionId: string
  readonly stepId: string
  readonly subject: string
  readonly description: string
  readonly reviewGate: string
  /** Exact completed artifacts required by this workflow step. */
  readonly inputs: { name: string; artifact: { kind: 'commit' | 'file' | 'report'; ref: string } }[]
  readonly candidateRound?: number | undefined
}
export interface WorkflowCodeStatus {
  readonly sourceCommit?: string
  readonly submissionId?: string
  readonly integrationId?: string
  readonly phase?: 'pending' | 'queued' | 'running' | 'verified' | 'merged' | 'failed'
  readonly targetCommit?: string
  readonly candidateCommit?: string
  readonly reviewGate?: string
  readonly reviewId?: string
  /** Current integration's retained older candidates, oldest first. */
  readonly previousCandidates?: readonly string[]
  readonly diagnostic?: string
  readonly repair?: { readonly previousAttemptId: string; readonly submissionId: string; readonly sourceCommit: string; readonly round: number; readonly budget: number }
  /**
   * Contiguous, reducer-validated source replacements, oldest first. This
   * lets a restarted runtime retain every source round even when repairs
   * submit before its first reconciliation scan.
   */
  readonly sourceLineage?: readonly { readonly sourceCommit: string; readonly submissionId: string; readonly integrationId: string
    readonly repair?: { readonly previousAttemptId: string; readonly submissionId: string; readonly sourceCommit: string; readonly round: number; readonly budget: number } }[]
}
export interface WorkflowIntegrationApproval {
  readonly executionId: string
  readonly stepId: string
  readonly integrationId: string
  readonly sourceCommit: string
  readonly targetCommit: string
  readonly candidateCommit: string
  readonly reviewGate: string
  readonly reviewId: string
}

export const createWorkflowRequestSchema = z.object({
  projectId: id, teamId: id, templateId: id, templateVersion: positive, parameters: z.record(id, scalar), executionId: id.optional(),
}).strict()
export type CreateWorkflowRequest = z.input<typeof createWorkflowRequestSchema>

const reviewBindingSchema = z.object({ integrationId: id, sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), targetCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  candidateCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), reviewGate: id }).strict()
const approvalSchema = reviewBindingSchema.extend({ executionId: id, stepId: id, reviewId: id }).strict()
const workflowInputSchema = z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/), artifact: z.object({ kind: z.enum(['commit', 'file', 'report']), ref: text }).strict() }).strict()
const intentSchema = z.object({
  intentId: id, projectId: id, teamId: id, executionId: id, stepId: id, subject: text, description: text, nonCodeCriteria: text, inputs: z.array(workflowInputSchema).max(128).default([]), candidateRound: z.number().int().nonnegative().optional(), review: reviewBindingSchema.optional(),
}).strict()
const codeIntentSchema = z.object({
  intentId: id, projectId: id, teamId: id, executionId: id, stepId: id, subject: text, description: text, reviewGate: id, inputs: z.array(workflowInputSchema).max(128).default([]), candidateRound: z.number().int().nonnegative().optional(),
}).strict()
const creationSchema = z.object({
  executionId: id, projectId: id, teamId: id, template: z.unknown(), parameters: z.record(id, scalar), definition: z.unknown(), publicationGrant: z.object({ teamId: id, authorization: id }).strict().optional(), publicationPublisher: z.object({ identity: id, revision: positive }).strict().optional(),
}).strict()
const publicationIntentSchema = z.object({ idempotencyKey: id, executionId: id, stepId: id, authorization: id, publisherIdentity: id, publisherRevision: positive, evidence: z.object({ kind: id, ref: text }).strict(), release: z.object({ kind: id, ref: text }).strict() }).strict()
const publicationReceiptSchema = z.object({ publisher: id, publisherIdentity: id, publisherRevision: positive, reference: z.object({ kind: id, ref: text }).strict(), idempotencyKey: id, authorization: id, evidence: z.object({ kind: id, ref: text }).strict(), release: z.object({ kind: id, ref: text }).strict() }).strict()
const round = z.number().int().nonnegative()
const archivedBindingSchema = z.object({ intent: z.union([intentSchema, codeIntentSchema]).optional(), taskId: id.optional(), reportId: id.optional(), review: reviewBindingSchema.optional(), approval: approvalSchema.optional(), approvalRecorded: z.boolean().optional(), publicationIntent: publicationIntentSchema.optional(), publicationReceipt: publicationReceiptSchema.optional(), sourceRound: round.optional() }).strict()
const bindingSchema = z.object({
  executionId: id, projectId: id, teamId: id, stepId: id, intent: z.union([intentSchema, codeIntentSchema]).optional(), taskId: id.optional(), reportId: id.optional(), review: reviewBindingSchema.optional(), approval: approvalSchema.optional(), approvalRecorded: z.boolean().optional(), publicationIntent: publicationIntentSchema.optional(), publicationReceipt: publicationReceiptSchema.optional(), sourceRound: round.default(0), history: z.array(archivedBindingSchema).max(32).default([]),
}).strict()
const envelope = { version: z.literal(1), sequence: positive }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('workflow-runtime/created'), creation: creationSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/task-intended'), executionId: id, stepId: id, intent: z.union([intentSchema, codeIntentSchema]), sourceRound: round.optional() }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/task-created'), executionId: id, stepId: id, taskId: id }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/step-receipted'), executionId: id, stepId: id, reportId: id }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/task-reset'), executionId: id, stepId: id }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/approval-intended'), executionId: id, stepId: id, approval: approvalSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/approval-recorded'), executionId: id, stepId: id }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/publication-intended'), executionId: id, stepId: id, intent: publicationIntentSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workflow-runtime/publication-recorded'), executionId: id, stepId: id, receipt: publicationReceiptSchema }).strict(),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, 'version' | 'sequence'> : never : never

interface Creation {
  readonly executionId: string
  readonly projectId: string
  readonly teamId: string
  readonly template: PinnedWorkflowDefinition
  readonly parameters: Record<string, string | number | boolean>
  readonly definition: PinnedWorkflowDefinition
  readonly publicationGrant?: { readonly teamId: string; readonly authorization: string } | undefined
  readonly publicationPublisher?: { readonly identity: string; readonly revision: number } | undefined
}
interface State { readonly creations: Creation[]; readonly bindings: z.output<typeof bindingSchema>[] }

function binding(state: State, executionId: string, stepId: string) {
  return state.bindings.find(value => value.executionId === executionId && value.stepId === stepId)
}
function replaceBinding(state: State, next: z.output<typeof bindingSchema>): State {
  return { ...state, bindings: [...state.bindings.filter(value => value.executionId !== next.executionId || value.stepId !== next.stepId), next] }
}
function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw)
  if (event.type === 'workflow-runtime/created') {
    if (state.creations.some(value => value.executionId === event.creation.executionId)) throw new Error('Workflow runtime execution already exists')
    const template = validateSupportedTemplate(event.creation.template)
    const definition = validateSupportedTemplate(event.creation.definition)
    if (!isDeepStrictEqual(pinWorkflowDefinition(template, event.creation.parameters), definition)) throw new Error('Workflow runtime creation has a different pinned definition')
    const creation: Creation = { ...event.creation, template, definition }
    return { ...state, creations: [...state.creations, creation] }
  }
  const creation = state.creations.find(value => value.executionId === event.executionId)
  if (!creation) throw new Error('Workflow runtime execution is missing')
  const prior = binding(state, event.executionId, event.stepId) ?? { executionId: event.executionId, projectId: creation.projectId, teamId: creation.teamId, stepId: event.stepId, sourceRound: 0, history: [] }
  if (event.type === 'workflow-runtime/task-intended') {
    if (prior.intent || prior.taskId || prior.reportId || prior.review || prior.approval) throw new Error('Workflow task intent already exists')
    if (event.intent.executionId !== event.executionId || event.intent.stepId !== event.stepId || event.intent.projectId !== creation.projectId || event.intent.teamId !== creation.teamId) throw new Error('Workflow task intent escapes its execution grant')
    return replaceBinding(state, { ...prior, intent: event.intent, sourceRound: event.sourceRound ?? 0, ...('review' in event.intent && event.intent.review === undefined ? {} : 'review' in event.intent ? { review: event.intent.review } : {}) })
  }
  if (event.type === 'workflow-runtime/task-created') {
    if (!prior.intent || prior.taskId || prior.reportId) throw new Error('Workflow task creation lacks an unconsumed intent')
    return replaceBinding(state, { ...prior, taskId: event.taskId })
  }
  if (event.type === 'workflow-runtime/step-receipted') {
    if (!prior.taskId || prior.reportId) throw new Error('Workflow report receipt lacks a created task or is already recorded')
    return replaceBinding(state, { ...prior, reportId: event.reportId })
  }
  if (event.type === 'workflow-runtime/task-reset') {
    if (!prior.intent && !prior.taskId && !prior.reportId && !prior.review && !prior.approval) return state
    const { executionId, projectId, teamId, stepId, sourceRound, history, ...archive } = prior
    return replaceBinding(state, { executionId, projectId, teamId, stepId, sourceRound, history: [...history, { ...archive, sourceRound }] })
  }
  if (event.type === 'workflow-runtime/publication-intended') {
    if (prior.publicationIntent || event.intent.executionId !== event.executionId || event.intent.stepId !== event.stepId || event.intent.authorization !== creation.publicationGrant?.authorization) throw new Error('Publication intent escapes its execution grant')
    return replaceBinding(state, { ...prior, publicationIntent: event.intent })
  }
  if (event.type === 'workflow-runtime/publication-recorded') {
    if (!prior.publicationIntent || prior.publicationReceipt) throw new Error('Publication receipt lacks an unconsumed durable intent')
    return replaceBinding(state, { ...prior, publicationReceipt: event.receipt })
  }
  if (event.type === 'workflow-runtime/approval-intended') {
    if (!prior.reportId || prior.approval) throw new Error('Workflow integration approval lacks one accepted review report')
    if (event.approval.executionId !== event.executionId || event.approval.stepId !== event.stepId || event.approval.reviewId !== prior.reportId || !prior.review
      || event.approval.integrationId !== prior.review.integrationId || event.approval.sourceCommit !== prior.review.sourceCommit || event.approval.targetCommit !== prior.review.targetCommit
      || event.approval.candidateCommit !== prior.review.candidateCommit || event.approval.reviewGate !== prior.review.reviewGate) throw new Error('Workflow integration approval escapes the pinned review candidate')
    return replaceBinding(state, { ...prior, approval: event.approval })
  }
  if (!prior.approval || prior.approvalRecorded) throw new Error('Workflow integration approval receipt lacks an unconsumed durable intent')
  return replaceBinding(state, { ...prior, approvalRecorded: true })
}

function validateSupportedTemplate(value: unknown): PinnedWorkflowDefinition {
  const template = validateWorkflowTemplate(value)
  if (template.id === 'investigation-report' && template.steps.every(step => step.acceptance.kind === 'report-review')) return template
  if (template.id === 'implementation-test-review-integration'
    && template.steps.map(step => step.acceptance.kind).join(',') === 'artifact-submitted,checks-passed,report-review,integrated') return template
  if (template.id === 'release-publication'
    && template.steps.map(step => step.acceptance.kind).join(',') === 'report-review,externally-authorized-publication') return template
  throw new Error('Workflow template is unsupported by this workflow runtime')
}
function assertProject(project: WorkflowRuntimeProject, projectId: string, teamId: string): void {
  if (project.id !== projectId || !project.teamIds.includes(teamId)) throw new Error('Workflow project or Lead team is not registered')
}
function validateTaskCompatibleDefinition(definition: PinnedWorkflowDefinition): void {
  for (const step of definition.steps) {
    if (step.title.length > 200) throw new Error(`Workflow step ${step.id} title exceeds the managed task subject limit`)
    if (step.acceptance.kind === 'report-review' && `Report review: ${step.title}`.length > 16_384) throw new Error(`Workflow step ${step.id} report criteria exceeds the managed task limit`)
  }
}
function excerpt(value: string, limit: number, notice: string): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - notice.length))}${notice}`
}

/** Durable execution/binding view. Workflow step phase remains authoritative in WorkflowStore. */
export interface WorkflowRuntimeView {
  readonly executionId: string
  readonly projectId: string
  readonly teamId: string
  readonly templateId: string
  readonly templateVersion: number
  /**
   * `revision` is the optimistic-concurrency token required by server-side
   * publication authorization. Failure evidence is deliberately bounded to the
   * public step failure record; authorization and completion receipts stay host
   * private.
   */
  readonly steps: readonly {
    stepId: string
    taskId?: string
    intentId?: string
    reportId?: string
    phase: WorkflowExecution['steps'][number]['phase']
    revision: number
    attempts: number
    failure?: { readonly reason: string; readonly evidence: { readonly kind: string; readonly ref: string } }
    retryNotBefore?: number
  }[]
}

/**
 * Connects immutable WorkflowStore checkpoints to concrete non-code Team tasks.
 * It owns no model-facing completion method: accepted ReportStore receipts are its
 * only progress input.
 */
export class WorkflowRuntime {
  private constructor(
    private readonly journal: DurableJournal<State, Payload>,
    private readonly workflows: WorkflowStore,
    private readonly reports: ReportStore,
    private readonly tasks: WorkflowTaskHost,
    private readonly templates: Map<string, PinnedWorkflowDefinition>,
  ) {}

  static async open(directory: string, workflows: WorkflowStore, reports: ReportStore, tasks: WorkflowTaskHost, templates: readonly unknown[]): Promise<WorkflowRuntime> {
    const registry = new Map<string, PinnedWorkflowDefinition>()
    for (const candidate of templates) {
      const template = validateSupportedTemplate(candidate)
      const key = `${template.id}@${template.version}`
      if (registry.has(key)) throw new Error(`Duplicate workflow template ${key}`)
      registry.set(key, template)
    }
    return new WorkflowRuntime(await DurableJournal.open<State, Payload>(join(directory, 'workflow-runtime.jsonl'), { creations: [], bindings: [] }, reduce), workflows, reports, tasks, registry)
  }

  /** Record runtime intent first; a restart can then safely materialize the pinned WorkflowStore execution. */
  async create(request: CreateWorkflowRequest, project: WorkflowRuntimeProject): Promise<WorkflowRuntimeView> {
    const input = createWorkflowRequestSchema.parse(request)
    assertProject(project, input.projectId, input.teamId)
    const template = this.templates.get(`${input.templateId}@${input.templateVersion}`)
    if (!template) throw new Error('Workflow template and version are not registered for this runtime')
    // This pure validation/substitution precedes the runtime creation intent.
    const definition = pinWorkflowDefinition(template, input.parameters)
    validateTaskCompatibleDefinition(definition)
    const publication = definition.steps.find(step => step.acceptance.kind === 'externally-authorized-publication')
    let publicationGrant: { readonly teamId: string; readonly authorization: string } | undefined
    if (publication?.acceptance.kind === 'externally-authorized-publication') {
      const authorization = publication.acceptance.authorization
      publicationGrant = project.publicationGrants?.find(grant => grant.teamId === input.teamId && grant.authorization === authorization)
    }
    if (publication && (!publicationGrant || !project.publicationPublisher || !this.tasks.publishAuthorizedRelease)) throw new Error('Release workflow requires a configured publication grant and publisher')
    const executionId = input.executionId ?? randomUUID()
    const existing = this.creation(executionId)
    if (existing) {
      if (existing.projectId !== input.projectId || existing.teamId !== input.teamId || !isDeepStrictEqual(existing.definition, definition) || !isDeepStrictEqual(existing.publicationGrant, publicationGrant) || !isDeepStrictEqual(existing.publicationPublisher, project.publicationPublisher)
        || !isDeepStrictEqual(existing.parameters, input.parameters)) throw new Error('Workflow creation replay has different immutable inputs')
    } else {
      await this.journal.append(() => ({ type: 'workflow-runtime/created', creation: { executionId, projectId: input.projectId, teamId: input.teamId, template, parameters: input.parameters, definition,
        ...(publicationGrant === undefined ? {} : { publicationGrant }), ...(project.publicationPublisher === undefined ? {} : { publicationPublisher: project.publicationPublisher }) } }))
    }
    await this.ensureWorkflow(this.creation(executionId)!)
    return this.inspect(executionId)!
  }

  /** Reconcile accepted receipts, then create and start every newly eligible bound task. */
  async scan(project: WorkflowRuntimeProject): Promise<WorkflowRuntimeView[]> {
    const dispatched: WorkflowRuntimeView[] = []
    for (const creation of this.journal.snapshot().creations.filter(value => value.projectId === project.id)) {
      assertProject(project, creation.projectId, creation.teamId)
      await this.ensureWorkflow(creation)
      await this.reconcileReceipts(creation)
      await this.reconcileCode(creation)
      await this.reconcilePublication(creation)
      const execution = this.workflows.inspect(creation.executionId)!
      const next = this.workflows.resume(execution.id)
      if (!next) continue
      await this.ensureStep(creation, execution, next.id)
      dispatched.push(this.inspect(creation.executionId)!)
    }
    return dispatched
  }

  /** Resume one owned execution after process reconstruction. */
  async resume(executionId: string, project: WorkflowRuntimeProject): Promise<WorkflowRuntimeView | undefined> {
    const creation = this.creation(executionId)
    if (!creation) throw new Error('Workflow runtime execution is missing')
    assertProject(project, creation.projectId, creation.teamId)
    await this.ensureWorkflow(creation)
    await this.reconcileReceipts(creation)
    await this.reconcileCode(creation)
    await this.reconcilePublication(creation)
    const next = this.workflows.resume(executionId)
    if (!next) return undefined
    await this.ensureStep(creation, this.workflows.inspect(executionId)!, next.id)
    return this.inspect(executionId)
  }

  /** Server-only authority path: actor is derived from the pinned execution grant. */
  async authorizePublication(executionId: string, stepId: string, expectedRevision: number, evidence: ArtifactReference, callerTeamId: string): Promise<WorkflowRuntimeView> {
    const creation = this.creation(executionId)
    if (!creation?.publicationGrant || creation.publicationGrant.teamId !== callerTeamId) throw new Error('Publication authorization caller lacks the pinned execution grant')
    const execution = this.workflows.inspect(executionId)
    const step = execution?.steps.find(value => value.id === stepId)
    const definition = execution?.definition.steps.find(value => value.id === stepId)
    if (!execution || !step || definition?.acceptance.kind !== 'externally-authorized-publication' || definition.acceptance.authorization !== creation.publicationGrant.authorization) throw new Error('Publication authorization does not target the pinned publication step')
    await this.workflows.authorizePublication(executionId, stepId, expectedRevision, { actor: creation.publicationGrant.authorization, evidence })
    return this.inspect(executionId)!
  }

  inspect(executionId: string): WorkflowRuntimeView | undefined {
    const creation = this.creation(executionId)
    const execution = this.workflows.inspect(executionId)
    if (!creation || !execution) return undefined
    const state = this.journal.snapshot()
    return { executionId, projectId: creation.projectId, teamId: creation.teamId, templateId: execution.definition.id, templateVersion: execution.definition.version,
      steps: execution.steps.map(step => {
        const value = binding(state, executionId, step.id)
        return { stepId: step.id, ...(value?.taskId === undefined ? {} : { taskId: value.taskId }), ...(value?.intent === undefined ? {} : { intentId: value.intent.intentId }),
          ...(value?.reportId === undefined ? {} : { reportId: value.reportId }), phase: step.phase, revision: step.revision, attempts: step.attempts,
          ...(step.failure === undefined ? {} : { failure: { reason: step.failure.reason, evidence: { ...step.failure.reference } } }),
          ...(step.notBefore === undefined ? {} : { retryNotBefore: step.notBefore }) }
      }) }
  }

  close(): Promise<void> { return this.journal.close() }

  private creation(executionId: string): Creation | undefined {
    return this.journal.snapshot().creations.find(value => value.executionId === executionId)
  }

  private async ensureWorkflow(creation: Creation): Promise<void> {
    const existing = this.workflows.inspect(creation.executionId)
    if (existing) {
      if (!isDeepStrictEqual(existing.definition, creation.definition)) throw new Error('Pinned WorkflowStore execution disagrees with runtime intent')
      return
    }
    await this.workflows.create(creation.template, creation.parameters, creation.executionId)
  }

  private async reconcileReceipts(creation: Creation): Promise<void> {
    let execution = this.workflows.inspect(creation.executionId)!
    const state = this.journal.snapshot()
    for (const value of state.bindings.filter(value => value.executionId === execution.id && value.taskId !== undefined && value.reportId === undefined)) {
      const completed = execution.steps.find(step => step.id === value.stepId)
      const report = this.acceptedReport(creation, value.taskId!)
      if (completed?.phase === 'completed' && completed.receipt?.kind === 'report-review' && report && completed.receipt.reference.kind === 'report' && completed.receipt.reference.ref === report.id) {
        await this.journal.append(() => ({ type: 'workflow-runtime/step-receipted', executionId: execution.id, stepId: value.stepId, reportId: report.id }))
      }
    }
    for (const step of execution.steps.filter(value => value.phase === 'running')) {
      const value = binding(state, execution.id, step.id)
      if (!value?.taskId) continue
      const report = this.acceptedReport(creation, value.taskId)
      if (!report) continue
      const definition = execution.definition.steps.find(candidate => candidate.id === step.id)!
      const decision = definition.id === 'review' && execution.definition.id === 'implementation-test-review-integration'
        ? report.decision : 'approved'
      if (decision === undefined) throw new Error('Pinned candidate reviewer report lacks an explicit decision')
      const reference = { kind: 'report', ref: report.id }
      const artifacts = Object.fromEntries(definition.artifacts.produces.map(name => [name, reference]))
      await this.workflows.completeStep(execution.id, step.id, step.revision, { artifacts,
        receipt: { kind: 'report-review', reviewer: report.reviewerId, decision, reference } })
      if (!value.reportId) await this.journal.append(() => ({ type: 'workflow-runtime/step-receipted', executionId: execution.id, stepId: step.id, reportId: report.id }))
      execution = this.workflows.inspect(creation.executionId)!
    }
  }

  /** Observe durable submission/integration state; this method never invokes a model or Git provider. */
  private async reconcileCode(creation: Creation): Promise<void> {
    const state = this.journal.snapshot()
    const execution = this.workflows.inspect(creation.executionId)!
    const implement = execution.definition.steps.find(step => step.acceptance.kind === 'artifact-submitted')
    await this.resetStaleCandidateBindings(execution, implement?.id)
    if (!implement) return
    await this.resetReworkedTaskBindings(execution, implement.id)
    const implementBinding = binding(state, execution.id, implement.id)
    if (!implementBinding?.intent || !('reviewGate' in implementBinding.intent)) return
    const host = this.tasks.codeStatus
    if (!host) throw new Error('Code workflow runtime requires a code status host')
    const status = await host.call(this.tasks, implementBinding.intent)
    if (!status) return
    const source = status.sourceCommit
    const lineage = this.sourceLineage(status)
    const implementationStep = this.workflows.inspect(execution.id)!.steps.find(step => step.id === implement.id)!
    if (lineage.length && implementationStep.phase === 'completed') {
      if (implement.acceptance.kind !== 'artifact-submitted') throw new Error('Workflow implementation step has the wrong acceptance kind')
      const prior = implementationStep.artifacts?.[implement.acceptance.artifact]
      if (prior?.kind !== 'commit') throw new Error('Completed workflow implementation source is not a commit')
      const position = lineage.findIndex(entry => entry.sourceCommit === prior.ref)
      if (position < 0) throw new Error('Workflow implementation source is absent from the authoritative repair lineage')
      const replacement = lineage[position + 1]
      if (replacement) {
        if (!replacement.repair || replacement.repair.sourceCommit !== prior.ref || replacement.repair.submissionId !== lineage[position]!.submissionId
          || replacement.repair.round !== this.workflows.inspect(execution.id)!.sourceHistory.length + 1) throw new Error('Replacement workflow source lacks the pinned repair lineage')
        await this.workflows.reworkSource(execution.id, implement.id, implementationStep.revision, { kind: 'commit', ref: replacement.sourceCommit }, replacement.repair, status.diagnostic ?? 'Pinned repair submission replaced the prior source')
        await this.resetReworkedTaskBindings(this.workflows.inspect(execution.id)!, implement.id)
        return
      }
    }
    const currentImplementation = this.workflows.inspect(execution.id)!.steps.find(step => step.id === implement.id)!
    const retainedSource = this.workflows.inspect(execution.id)!.sourceHistory.at(-1)?.replacement
    const implementationSource = currentImplementation.phase === 'completed'
      ? currentImplementation.artifacts?.[implement.acceptance.kind === 'artifact-submitted' ? implement.acceptance.artifact : 'source']
      : retainedSource
    const nextSource = implementationSource?.kind === 'commit'
      ? lineage.find(entry => entry.sourceCommit === implementationSource.ref)
      : lineage[0]
    if (nextSource && currentImplementation.phase === 'pending') {
      await this.workflows.startStep(execution.id, currentImplementation.id, currentImplementation.revision)
    }
    if (nextSource && this.workflows.inspect(execution.id)!.steps.find(step => step.id === implement.id)?.phase === 'running') {
      if (implement.acceptance.kind !== 'artifact-submitted') throw new Error('Workflow implementation step has the wrong acceptance kind')
      const step = this.workflows.inspect(execution.id)!.steps.find(step => step.id === implement.id)!
      const reference = { kind: 'commit', ref: nextSource.sourceCommit }
      await this.workflows.completeStep(execution.id, step.id, step.revision, { artifacts: { [implement.acceptance.artifact]: reference },
        receipt: { kind: 'artifact-submitted', submitter: creation.teamId, artifact: reference } })
    }
    const completedSource = this.workflows.inspect(execution.id)!.steps.find(step => step.id === implement.id)?.artifacts?.[implement.acceptance.kind === 'artifact-submitted' ? implement.acceptance.artifact : 'source']
    // One scan records one durable edge. If a restart missed several repair
    // submissions, let the next scan append the first source-rework transition
    // before considering the newest integration candidate.
    if (completedSource?.kind === 'commit' && lineage.length && completedSource.ref !== lineage.at(-1)!.sourceCommit) return
    // A persisted source rework deliberately returns implementation to pending.
    // Do not consume a later integration receipt until resume has restarted that
    // same pinned implementation task and recorded its replacement source.
    if (this.workflows.inspect(execution.id)!.steps.find(step => step.id === implement.id)?.phase !== 'completed') return
    let current = this.workflows.inspect(execution.id)!
    const checkDefinition = current.definition.steps.find(step => step.acceptance.kind === 'checks-passed')
    if (!checkDefinition || !source || !status.integrationId || !status.targetCommit || !status.candidateCommit) return
    const checkAcceptance = checkDefinition.acceptance
    if (checkAcceptance.kind !== 'checks-passed') throw new Error('Workflow verification step has the wrong acceptance kind')
    if ((status.phase !== 'verified' && status.phase !== 'merged') || status.reviewGate !== implementBinding.intent.reviewGate) return
    const check = current.steps.find(step => step.id === checkDefinition.id)!
    const sourceReference = current.steps.find(step => step.artifacts?.[checkAcceptance.source])?.artifacts?.[checkAcceptance.source]
    if (!sourceReference || sourceReference.kind !== 'commit' || sourceReference.ref !== source) throw new Error('Verified integration source does not match the immutable workflow submission')
    const candidateReference = { kind: 'commit', ref: status.candidateCommit }
    if (check.phase === 'completed') {
      const old = check.artifacts?.[checkAcceptance.candidate]
      if (old?.kind === candidateReference.kind && old.ref === candidateReference.ref) {
        // The candidate already has the exact completed checkpoint.
      } else {
        const previous = status.previousCandidates?.map(commit => ({ kind: 'commit', ref: commit })) ?? []
        const replacement: CandidateReplacement = { integration: { kind: 'integration', ref: status.integrationId }, source: sourceReference,
          target: { kind: 'commit', ref: status.targetCommit }, candidate: candidateReference, retryRound: current.candidateHistory.length + 1, previousCandidates: previous }
        if (replacement.retryRound > 3 || previous.length > 3) throw new Error('Integration candidate retry budget is exhausted')
        await this.workflows.invalidateCandidate(execution.id, check.id, check.revision, replacement, status.diagnostic ?? 'Pinned integration target advanced; fresh candidate review is required')
        await this.resetStaleCandidateBindings(this.workflows.inspect(execution.id)!)
        return
      }
    }
    current = this.workflows.inspect(execution.id)!
    const pending = current.steps.find(step => step.id === checkDefinition.id)!
    if (pending.phase === 'pending') await this.workflows.startStep(execution.id, pending.id, pending.revision)
    const running = this.workflows.inspect(execution.id)!.steps.find(step => step.id === checkDefinition.id)!
    if (running.phase === 'running') await this.workflows.completeStep(execution.id, running.id, running.revision, {
      artifacts: { [checkAcceptance.candidate]: candidateReference },
      receipt: { kind: 'checks-passed', verifier: creation.teamId, source: sourceReference, candidate: candidateReference,
        verification: { kind: 'integration', ref: status.integrationId } },
    })

    current = this.workflows.inspect(execution.id)!
    const review = current.definition.steps.find(step => step.acceptance.kind === 'report-review')
    if (review) {
      const reviewBinding = binding(this.journal.snapshot(), execution.id, review.id)
      const reviewStep = this.workflows.inspect(execution.id)!.steps.find(step => step.id === review.id)
      if (reviewBinding?.reportId && reviewBinding.review && !reviewBinding.approval && reviewStep?.phase === 'completed' && reviewStep.receipt?.kind === 'report-review' && reviewStep.receipt.decision === 'approved') {
        const approval: WorkflowIntegrationApproval = { executionId: execution.id, stepId: review.id, ...reviewBinding.review, reviewId: reviewBinding.reportId }
        await this.journal.append(() => ({ type: 'workflow-runtime/approval-intended', executionId: execution.id, stepId: review.id, approval }))
      }
      const intended = binding(this.journal.snapshot(), execution.id, review.id)
      if (intended?.approval && !intended.approvalRecorded) {
        if (!this.tasks.approvePinnedIntegration) throw new Error('Code workflow runtime requires an integration approval host')
        await this.tasks.approvePinnedIntegration(intended.approval)
        await this.journal.append(() => ({ type: 'workflow-runtime/approval-recorded', executionId: execution.id, stepId: review.id }))
      }
    }
    const integration = current.definition.steps.find(step => step.acceptance.kind === 'integrated')
    if (!integration || status.phase !== 'merged' || status.reviewId === undefined) return
    const reviewBinding = review === undefined ? undefined : binding(this.journal.snapshot(), execution.id, review.id)
    if (!reviewBinding?.approval || reviewBinding.approval.reviewId !== status.reviewId || reviewBinding.approval.integrationId !== status.integrationId
      || reviewBinding.approval.candidateCommit !== status.candidateCommit) return
    const integrationStep = this.workflows.inspect(execution.id)!.steps.find(step => step.id === integration.id)!
    if (integrationStep.phase === 'pending') await this.workflows.startStep(execution.id, integrationStep.id, integrationStep.revision)
    const integrationRunning = this.workflows.inspect(execution.id)!.steps.find(step => step.id === integration.id)!
    if (integrationRunning.phase === 'running' && integration.acceptance.kind === 'integrated') await this.workflows.completeStep(execution.id, integrationRunning.id, integrationRunning.revision, { artifacts: {},
      receipt: { kind: 'integrated', integrator: creation.teamId, source: sourceReference, candidate: candidateReference, integration: { kind: 'integration', ref: status.integrationId } },
    })
  }

  private acceptedReport(creation: Creation, taskId: string): ReportAcceptanceRecord | undefined {
    return this.reports.list().find(report => report.phase === 'accepted' && report.projectId === creation.projectId && report.teamId === creation.teamId && report.taskId === taskId)
  }

  private async ensureStep(creation: Creation, execution: WorkflowExecution, stepId: string): Promise<void> {
    const definition = execution.definition.steps.find(step => step.id === stepId)!
    if (definition.acceptance.kind === 'artifact-submitted') return await this.ensureCodeTask(creation, execution, stepId)
    if (definition.acceptance.kind === 'report-review') return await this.ensureTask(creation, execution, stepId)
    if (definition.acceptance.kind === 'externally-authorized-publication') return await this.ensurePublication(creation, execution, stepId)
    // checks-passed and integrated steps are driven solely by immutable host receipts.
  }

  private async ensurePublication(creation: Creation, execution: WorkflowExecution, stepId: string): Promise<void> {
    const step = this.workflows.inspect(execution.id)!.steps.find(value => value.id === stepId)!
    const definition = execution.definition.steps.find(value => value.id === stepId)!
    if (step.phase === 'pending') { await this.workflows.startStep(execution.id, stepId, step.revision); return }
    const current = this.workflows.inspect(execution.id)!.steps.find(value => value.id === stepId)!
    if (current.phase !== 'running' || !current.authorization || definition.acceptance.kind !== 'externally-authorized-publication') return
    if (!creation.publicationGrant || !creation.publicationPublisher || !this.tasks.publicationPublisher || current.authorization.actor !== creation.publicationGrant.authorization
      || !isDeepStrictEqual(this.tasks.publicationPublisher, creation.publicationPublisher)) throw new Error('Publication publisher configuration disagrees with its pinned execution grant')
    const releaseName = definition.artifacts.requires[0]
    const release = releaseName === undefined ? undefined : execution.steps.find(value => value.artifacts?.[releaseName])?.artifacts?.[releaseName]
    if (!release) throw new Error('Publication step lacks its pinned release artifact')
    let value = binding(this.journal.snapshot(), execution.id, stepId)
    if (!value?.publicationIntent) {
      const key = `publication-${createHash('sha256').update(JSON.stringify({ executionId: execution.id, stepId, revision: current.authorization.revision, evidence: current.authorization.evidence, release })).digest('hex')}`
      const intent: WorkflowPublicationIntent = { idempotencyKey: key, executionId: execution.id, stepId, authorization: current.authorization.actor, publisherIdentity: creation.publicationPublisher.identity, publisherRevision: creation.publicationPublisher.revision, evidence: current.authorization.evidence, release }
      await this.journal.append(() => ({ type: 'workflow-runtime/publication-intended', executionId: execution.id, stepId, intent }))
      value = binding(this.journal.snapshot(), execution.id, stepId)
    }
    if (!value?.publicationReceipt) {
      if (!this.tasks.publishAuthorizedRelease) throw new Error('Release workflow requires a configured publisher')
      let receipt: WorkflowPublicationReceipt
      try { receipt = await this.tasks.publishAuthorizedRelease(value!.publicationIntent!) }
      catch (error) {
        const classified = typeof error === 'object' && error !== null && 'publicationOutcome' in error ? (error as { publicationOutcome?: unknown }).publicationOutcome : undefined
        const outcome = classified === 'definite' ? 'Publisher definitely rejected the release' : 'Publisher outcome is uncertain; operator evidence is required before retry'
        await this.workflows.failStep(execution.id, stepId, current.revision, { reason: outcome, reference: { kind: 'publication', ref: value!.publicationIntent!.idempotencyKey } })
        return
      }
      if (receipt.reference.kind !== 'publication' || receipt.idempotencyKey !== value!.publicationIntent!.idempotencyKey || receipt.publisherIdentity !== value!.publicationIntent!.publisherIdentity || receipt.publisherRevision !== value!.publicationIntent!.publisherRevision
        || receipt.authorization !== value!.publicationIntent!.authorization || !isDeepStrictEqual(receipt.evidence, value!.publicationIntent!.evidence)
        || !isDeepStrictEqual(receipt.release, value!.publicationIntent!.release)) throw new Error('Configured publisher receipt does not bind the exact durable publication intent')
      await this.journal.append(() => ({ type: 'workflow-runtime/publication-recorded', executionId: execution.id, stepId, receipt }))
      value = binding(this.journal.snapshot(), execution.id, stepId)
    }
    const after = this.workflows.inspect(execution.id)!.steps.find(value => value.id === stepId)!
    if (after.phase === 'running') await this.workflows.completeStep(execution.id, stepId, after.revision, { artifacts: {}, receipt: { kind: 'externally-authorized-publication', publisher: value!.publicationReceipt!.publisher, reference: value!.publicationReceipt!.reference } })
  }

  private async reconcilePublication(creation: Creation): Promise<void> {
    const execution = this.workflows.inspect(creation.executionId)!
    for (const step of execution.steps.filter(step => step.phase === 'running')) {
      const definition = execution.definition.steps.find(candidate => candidate.id === step.id)!
      if (definition.acceptance.kind === 'externally-authorized-publication') await this.ensurePublication(creation, execution, step.id)
    }
  }

  private async ensureTask(creation: Creation, execution: WorkflowExecution, stepId: string): Promise<void> {
    let state = this.journal.snapshot()
    let value = binding(state, execution.id, stepId)
    if (!value?.intent) {
      const definition = execution.definition.steps.find(step => step.id === stepId)!
      const inputs = definition.artifacts.requires.map(name => {
        const source = execution.steps.find(step => step.artifacts?.[name] !== undefined)?.artifacts?.[name]
        if (!source) throw new Error(`Workflow input artifact ${name} is missing from completed checkpoints`)
        if (source.kind !== 'commit' && source.kind !== 'file' && source.kind !== 'report') {
          throw new Error(`Workflow input artifact ${name} has an unsupported task binding kind`)
        }
        return { name, artifact: { kind: source.kind, ref: source.ref } as const }
      })
      const evidence = inputs.map(({ name, artifact: source }) => {
        const accepted = source.kind === 'report' ? this.reports.list().find(report => report.phase === 'accepted' && report.id === source.ref) : undefined
        return accepted
          ? `${name}: report:${accepted.id}\n  Accepted report excerpt: ${excerpt(accepted.report, 8_000, `\n[truncated; durable report receipt ${accepted.id}]`)}\n  Review criteria: ${excerpt(accepted.criteria, 2_000, '\n[criteria truncated]')}\n  Lead rationale: ${excerpt(accepted.rationale, 2_000, '\n[rationale truncated]')}`
          : `${name}: ${source.kind}:${source.ref}`
      })
      const code = await this.codeReviewBinding(execution, definition)
      const intent: WorkflowTaskCreateIntent & { review?: z.output<typeof reviewBindingSchema> } = { intentId: `workflow-${randomUUID()}`, projectId: creation.projectId, teamId: creation.teamId, executionId: execution.id, stepId,
        subject: definition.title, description: excerpt(`${definition.title}\n\nPinned workflow ${execution.definition.id}@${execution.definition.version}.\nInput evidence:\n${evidence.length ? evidence.map(item => `- ${item}`).join('\n') : '- none'}${code === undefined ? '' : `\n\nExact candidate review binding:\n- source: ${code.sourceCommit}\n- target: ${code.targetCommit}\n- candidate: ${code.candidateCommit}\n- integration: ${code.integrationId}\n- gate: ${code.reviewGate}`}\n\nProduce an evidence-backed report for Lead review.`, 16_384, '\n[workflow evidence truncated; use durable report receipt IDs above]'),
        nonCodeCriteria: `Report review: ${definition.title}`, inputs, candidateRound: execution.candidateHistory.length,
        ...(code === undefined ? {} : { review: code }) }
      await this.journal.append(() => ({ type: 'workflow-runtime/task-intended', executionId: execution.id, stepId, intent, sourceRound: execution.sourceHistory.length }))
      state = this.journal.snapshot(); value = binding(state, execution.id, stepId)!
    }
    if (!value.taskId) {
      if (!value.intent || 'reviewGate' in value.intent) throw new Error('Workflow report task has the wrong pinned intent kind')
      const created = await this.tasks.createPinnedTask(value.intent)
      id.parse(created.taskId)
      await this.journal.append(() => ({ type: 'workflow-runtime/task-created', executionId: execution.id, stepId, taskId: created.taskId }))
      value = binding(this.journal.snapshot(), execution.id, stepId)!
    }
    const current = this.workflows.inspect(execution.id)!.steps.find(step => step.id === stepId)!
    if (current.phase === 'pending') await this.workflows.startStep(execution.id, stepId, current.revision)
  }

  private async ensureCodeTask(creation: Creation, execution: WorkflowExecution, stepId: string): Promise<void> {
    let state = this.journal.snapshot()
    let value = binding(state, execution.id, stepId)
    if (!value?.intent) {
      const definition = execution.definition.steps.find(step => step.id === stepId)!
      const intent: WorkflowCodeTaskCreateIntent = { intentId: `workflow-${randomUUID()}`, projectId: creation.projectId, teamId: creation.teamId, executionId: execution.id, stepId,
        subject: definition.title, description: excerpt(`${definition.title}\n\nPinned workflow ${execution.definition.id}@${execution.definition.version}. Commit the implementation and report evidence; the host will submit this exact commit for verification.`, 16_384, '\n[workflow evidence truncated]'),
        reviewGate: `workflow-${execution.id}-${stepId}`.slice(0, 128), inputs: [], candidateRound: execution.candidateHistory.length }
      await this.journal.append(() => ({ type: 'workflow-runtime/task-intended', executionId: execution.id, stepId, intent, sourceRound: execution.sourceHistory.length }))
      state = this.journal.snapshot(); value = binding(state, execution.id, stepId)!
    }
    if (!('reviewGate' in value.intent!)) throw new Error('Workflow implementation task has the wrong pinned intent kind')
    if (!value.taskId) {
      if (!this.tasks.createPinnedCodeTask) throw new Error('Code workflow runtime requires a pinned code task host')
      const created = await this.tasks.createPinnedCodeTask(value.intent)
      id.parse(created.taskId)
      await this.journal.append(() => ({ type: 'workflow-runtime/task-created', executionId: execution.id, stepId, taskId: created.taskId }))
    }
    const current = this.workflows.inspect(execution.id)!.steps.find(step => step.id === stepId)!
    if (current.phase === 'pending') await this.workflows.startStep(execution.id, stepId, current.revision)
  }

  private async codeReviewBinding(execution: WorkflowExecution, definition: PinnedWorkflowDefinition['steps'][number]): Promise<z.output<typeof reviewBindingSchema> | undefined> {
    if (execution.definition.id !== 'implementation-test-review-integration') return undefined
    const source = definition.artifacts.requires.includes('source') ? execution.steps.find(step => step.artifacts?.source)?.artifacts?.source : undefined
    const candidate = definition.artifacts.requires.includes('candidate') ? execution.steps.find(step => step.artifacts?.candidate)?.artifacts?.candidate : undefined
    const implementation = execution.definition.steps.find(step => step.acceptance.kind === 'artifact-submitted')!
    const code = binding(this.journal.snapshot(), execution.id, implementation.id)?.intent
    if (!source || !candidate || !code || !('reviewGate' in code)) throw new Error('Candidate review requires a pinned source, candidate, and review gate')
    const host = this.tasks.codeStatus
    if (!host) throw new Error('Code workflow runtime requires a code status host')
    const status = await host.call(this.tasks, code)
    if (!status || status.phase !== 'verified' || status.reviewGate !== code.reviewGate || !status.integrationId || !status.targetCommit || !status.candidateCommit
      || source.kind !== 'commit' || candidate.kind !== 'commit' || source.ref !== status.sourceCommit || candidate.ref !== status.candidateCommit) {
      throw new Error('Candidate review requires the current exact verified integration candidate')
    }
    return { integrationId: status.integrationId, sourceCommit: source.ref, targetCommit: status.targetCommit, candidateCommit: candidate.ref, reviewGate: code.reviewGate }
  }

  private sourceLineage(status: WorkflowCodeStatus): readonly { readonly sourceCommit: string; readonly submissionId: string; readonly integrationId: string
    readonly repair?: { readonly previousAttemptId: string; readonly submissionId: string; readonly sourceCommit: string; readonly round: number; readonly budget: number } }[] {
    if (!status.sourceCommit || !status.submissionId || !status.integrationId) return []
    // Older/adapted hosts may expose only the current replacement. The
    // coordinator host always supplies explicit ancestry; retain this narrow
    // single-source compatibility for already-reworked durable executions.
    const explicit = status.sourceLineage !== undefined
    const lineage = status.sourceLineage ?? [{ sourceCommit: status.sourceCommit, submissionId: status.submissionId, integrationId: status.integrationId,
      ...(status.repair === undefined ? {} : { repair: status.repair }) }]
    if (!lineage.length || lineage.at(-1)!.sourceCommit !== status.sourceCommit || lineage.at(-1)!.submissionId !== status.submissionId || lineage.at(-1)!.integrationId !== status.integrationId) {
      throw new Error('Workflow source lineage does not end at the current pinned submission')
    }
    for (const [index, entry] of lineage.entries()) {
      if (index === 0) {
        if (!explicit) continue
        if (entry.repair !== undefined) throw new Error('Workflow source lineage cannot repair before its original source')
        continue
      }
      const prior = lineage[index - 1]!
      if (!entry.repair || entry.repair.sourceCommit !== prior.sourceCommit || entry.repair.submissionId !== prior.submissionId || entry.repair.round !== index) {
        throw new Error('Workflow source lineage has an invalid repair predecessor')
      }
    }
    return lineage
  }

  private async resetStaleCandidateBindings(execution: WorkflowExecution, implementationId?: string): Promise<void> {
    for (const step of execution.steps) {
      // Candidate movement never reopens implementation. In particular, a
      // source-rework can leave implementation pending while a prior candidate
      // history remains; do not turn that one durable code-task intent into a
      // second task.
      if (step.id === implementationId) continue
      const value = binding(this.journal.snapshot(), execution.id, step.id)
      const round = value?.intent?.candidateRound ?? 0
      if (step.phase === 'pending' && value?.intent && round < execution.candidateHistory.length) {
        await this.journal.append(() => ({ type: 'workflow-runtime/task-reset', executionId: execution.id, stepId: step.id }))
      }
    }
  }
  private async resetReworkedTaskBindings(execution: WorkflowExecution, implementationId: string): Promise<void> {
    for (const step of execution.steps) {
      if (step.id === implementationId || step.phase !== 'pending') continue
      const value = binding(this.journal.snapshot(), execution.id, step.id)
      if (value?.intent && value.sourceRound < execution.sourceHistory.length) {
        await this.journal.append(() => ({ type: 'workflow-runtime/task-reset', executionId: execution.id, stepId: step.id }))
      }
    }
  }
}
