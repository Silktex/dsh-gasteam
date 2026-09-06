/** Durable workspace startup, directory ownership, and registered-Team admission. */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Branded } from '@deepseek-ai/dsh-brand'
import z from 'zod'
import schema from '@deepseek-ai/schemastery'
import { DurableJournal } from './durable-journal.ts'
import { MAX_TIMER_TIMEOUT_MS, RetainedShutdown } from './runtime-drain.ts'
import { ProjectCatalog } from './projects.ts'
import type { ConfiguredPublicationGrant, ProjectRecord, RegisterProjectRequest } from './projects.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamTaskId } from './types.ts'
import type { CreateTeamTaskRequest, TeamTaskSnapshot, TeamTaskView } from './types.ts'
import type {} from './index.ts'
import { CoordinatorExecution, executionConfigSchema } from './coordinator-execution.ts'
import type { ExecutionConfig, ExecutionBlock, DispatchStatus } from './coordinator-execution.ts'
import { schedulingQuerySchema, schedulingControlSchema } from './scheduling-schemas.ts'
import { workspaceBatchPlanSchema, workspaceBatchTaskSchema } from './scheduling-schemas.ts'
import type { SchedulingQuery, SchedulingControl, SchedulingView, WorkspaceBatchPlanRequest } from './scheduling-schemas.ts'
import type { SubmitRequest, SubmissionRecord } from './submissions.ts'
import { reviewReportsRequestSchema } from './reports.ts'
import type { AcceptReportRequest, ReportAcceptanceRecord, ReviewableReport } from './reports.ts'
import type { DispatchRequest } from './dispatch-queue.ts'
import type { AttemptRecord } from './assignments.ts'
import { WorkflowStore } from './workflows.ts'
import { WorkflowRuntime, createWorkflowRequestSchema } from './workflow-runtime.ts'
import type { CreateWorkflowRequest, WorkflowPublicationReceipt, WorkflowPublicationIntent, WorkflowRuntimeView } from './workflow-runtime.ts'
import { implementationTestReviewIntegrationTemplate, investigationReportTemplate, releasePublicationTemplate } from './workflow-templates.ts'
import type { AttemptHealth, OperatorEscalation } from './health.ts'
import { CoordinatorBatchStore } from './coordinator-batches.ts'
import type { CreateWorkspaceBatchRequest, WorkspaceBatchNotification, WorkspaceBatchView, WorkspaceTaskRef } from './coordinator-batches.ts'
import { projectWorkspaceDashboard } from './workspace-dashboard.ts'
import type { WorkspaceDashboardPageRequest, WorkspaceDashboardPage, WorkspaceDashboardView } from './workspace-dashboard.ts'
import { WorkspacePageSnapshotStore } from './workspace-pagination.ts'
import type { RuntimeProviderCapabilities } from './runtime-provider.ts'

function ctxIntegrationFailed(ctx: Context, lead: Agent, integrationId: string): boolean {
  return ctx.agentTeams.listIntegrations(lead).some(integration => integration.id === integrationId && integration.phase === 'failed')
}

export type CoordinatorId = Branded<'CoordinatorId'>
declare module '@deepseek-ai/cordis' {
  interface Context { workspaceCoordinator: WorkspaceCoordinator }
}
const id = z.string().min(1).max(128)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const envelope = { version: z.literal(1), sequence: revision.min(1) }
const reconciliationSchema = z.object({
  projectId: id, teamId: id, status: z.enum(['available', 'unavailable']), diagnostic: z.string().max(16_384),
}).strict()
const storedBatchPlanSchema = workspaceBatchPlanSchema.extend({ id, items: z.array(workspaceBatchTaskSchema.extend({ admissionKey: id, taskId: id })).min(1).max(256) }).strict()
interface StoredBatchPlan extends z.output<typeof storedBatchPlanSchema> {}
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('coordinator/created'), id }).strict(),
  z.object({ ...envelope, type: z.literal('coordinator/workspace-operator-configured'), operatorId: id }).strict(),
  z.object({ ...envelope, type: z.literal('project/paused'), projectId: id, expectedRevision: revision, paused: z.boolean() }).strict(),
  z.object({ ...envelope, type: z.literal('team/reconciliation'), reconciliation: reconciliationSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workspace-batch/planned'), plan: storedBatchPlanSchema }).strict(),
  z.object({ ...envelope, type: z.literal('workspace-batch/task-admitted'), batchId: id, itemId: id }).strict(),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, 'version' | 'sequence'> : never : never
interface Control { projectId: string; revision: number; paused: boolean }
type Reconciliation = z.output<typeof reconciliationSchema>
interface State { id: CoordinatorId | undefined; operatorId: string | undefined; controls: Control[]; reconciliations: Reconciliation[]; plans: StoredBatchPlan[]; admitted: { batchId: string; itemId: string }[] }
function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw)
  if (event.type === 'coordinator/created') {
    if (state.id !== undefined) throw new Error('Coordinator identity cannot be replaced')
    return { ...state, id: event.id as CoordinatorId }
  }
  if (state.id === undefined) throw new Error('Coordinator identity must precede operations')
  if (event.type === 'coordinator/workspace-operator-configured') {
    if (state.operatorId !== undefined && state.operatorId !== event.operatorId) throw new Error('Workspace operator authority cannot be replaced')
    return { ...state, operatorId: event.operatorId }
  }
  if (event.type === 'project/paused') {
    const old = state.controls.find(control => control.projectId === event.projectId)
    if ((old?.revision ?? 0) !== event.expectedRevision) throw new Error('Stale project control revision')
    return { ...state, controls: [...state.controls.filter(control => control.projectId !== event.projectId), {
      projectId: event.projectId, revision: event.expectedRevision + 1, paused: event.paused,
    }] }
  }
  if (event.type === 'workspace-batch/planned') {
    if (state.plans.some(plan => plan.id === event.plan.id)) throw new Error('Workspace batch plan id is already used')
    if (new Set(event.plan.items.map(item => item.id)).size !== event.plan.items.length) throw new Error('Workspace batch plan repeats an item id')
    if (event.plan.items.some(item => item.dependsOn.some(dependency => !event.plan.items.some(candidate => candidate.id === dependency)))) throw new Error('Workspace batch plan references an unknown dependency')
    return { ...state, plans: [...state.plans, event.plan] }
  }
  if (event.type === 'workspace-batch/task-admitted') {
    const plan = state.plans.find(value => value.id === event.batchId)
    if (!plan || !plan.items.some(item => item.id === event.itemId)) throw new Error('Workspace batch admission lacks a durable plan item')
    if (state.admitted.some(value => value.batchId === event.batchId && value.itemId === event.itemId)) return state
    return { ...state, admitted: [...state.admitted, { batchId: event.batchId, itemId: event.itemId }] }
  }
  const next = event.reconciliation
  return { ...state, reconciliations: [...state.reconciliations.filter(value =>
    value.projectId !== next.projectId || value.teamId !== next.teamId), next] }
}
export interface PublicationConfig { readonly grants: readonly ConfiguredPublicationGrant[]; readonly publisher: { readonly identity: string; readonly revision: number; publish(intent: WorkflowPublicationIntent): Promise<WorkflowPublicationReceipt> } }
export interface CoordinatorConfig { readonly directory: string; /** Bounds one complete close observation; timeout retains coordinator ownership. */ readonly shutdownDeadlineMs?: number | undefined; readonly execution?: ExecutionConfig | undefined; readonly publication?: PublicationConfig | undefined; /** Exact server-configured Agent allowed to coordinate across projects. */ readonly workspaceOperatorId?: string | undefined }
export interface Config extends CoordinatorConfig { readonly scanIntervalMs: number }
export const name = 'agent-team-workspace-coordinator'
export const inject = ['agentTeams', 'agents', 'sessions', 'sessionPersistence', 'subagents']
export const Config: schema<Config> = schema.object({
  directory: schema.string().required(), scanIntervalMs: schema.number().step(1).min(1).default(1_000), shutdownDeadlineMs: schema.number().step(1).min(1).max(MAX_TIMER_TIMEOUT_MS).default(30_000),
  execution: schema.union([schema.const(undefined), schema.object({ modelProvider: schema.string().required(), model: schema.string().required(), maxRepairAttempts: schema.union([schema.const(undefined), schema.number().step(1).min(0).max(10)]), retryPolicy: schema.union([schema.const(undefined), schema.object({ maxAttempts: schema.number().step(1).min(1).max(100), initialDelayMs: schema.number().step(1).min(0), multiplier: schema.number().min(1).max(1_000_000), maxDelayMs: schema.number().step(1).min(0) })]), dispatchIntervalMs: schema.union([schema.const(undefined), schema.number().step(1).min(0)]), candidateRetention: schema.union([schema.const(undefined), schema.object({ delayMs: schema.number().step(1).min(0), commandTimeoutMs: schema.union([schema.const(undefined), schema.number().step(1).min(1)]), })]), health: schema.union([schema.const(undefined), schema.object({ dshDeadlineMs: schema.number().step(1).min(1), externalDeadlineMs: schema.number().step(1).min(1), escalationCooldownMs: schema.number().step(1).min(0), maxEscalationsPerCondition: schema.number().step(1).min(1).max(100), recovery: schema.union([schema.const(undefined), schema.object({ maxNudges: schema.number().step(1).min(1).max(3) })]) })]), externalCodex: schema.union([schema.const(undefined), schema.object({ projectId: schema.string().required(), directory: schema.string().required(), codeWorktreeDirectory: schema.union([schema.const(undefined), schema.string()]), cwd: schema.string().required(), executable: schema.string().required(), version: schema.string().required(), model: schema.string().required(), sandbox: schema.string().required(), maxSpoolBytes: schema.number().step(1).min(1).required(), terminateGraceMs: schema.number().step(1).min(1).required(), admissionMaxOutputBytes: schema.union([schema.const(undefined), schema.number().step(1).min(1)]), admissionTimeoutMs: schema.union([schema.const(undefined), schema.number().step(1).min(1)]) })]), maxConcurrent: schema.number().step(1).min(1).default(8) })]),
  // The publisher is a server object, never a model-supplied value.
  publication: schema.union([schema.const(undefined), schema.object({ grants: schema.array(schema.object({ projectId: schema.string().required(), teamId: schema.string().required(), authorization: schema.string().required() })).required(), publisher: schema.object({ identity: schema.string().required(), revision: schema.number().step(1).min(1).required(), publish: schema.function().required() }).required() })]),
  workspaceOperatorId: schema.union([schema.const(undefined), schema.string()]),
}) as schema<Config>

/** Opt-in server lifecycle: startup is awaited before service publication; scans do not overlap. */
export async function* apply(ctx: Context, config: Config): AsyncGenerator<() => Promise<void>> {
  if (!Number.isSafeInteger(config.scanIntervalMs) || config.scanIntervalMs < 1) throw new Error('Coordinator scan interval must be a positive integer')
  const coordinator = await WorkspaceCoordinator.open(ctx, config)
  yield () => coordinator.close()
  ctx.provide('workspaceCoordinator', coordinator)
  let running: Promise<void> | undefined
  const timer = setInterval(() => {
    if (running !== undefined) return
    running = coordinator.reconcile().catch((error: unknown) => {
      ctx.logger.warn(`Workspace reconciliation: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { running = undefined })
  }, config.scanIntervalMs)
  yield async () => {
    clearInterval(timer)
    await coordinator.close()
    await running
  }
}
export interface CoordinatorTeamView extends Reconciliation { readonly tasks: TeamTaskSnapshot[] }
export interface CoordinatorProjectView {
  readonly project: ProjectRecord
  readonly paused: boolean
  readonly controlRevision: number
  readonly teams: CoordinatorTeamView[]
}
export interface CoordinatorView {
  readonly id: CoordinatorId
  readonly projects: CoordinatorProjectView[]
  readonly submissions: SubmissionRecord[]
  readonly reports: ReportAcceptanceRecord[]
  /** Coordinator-visible intent/outcome diagnostics; no model/RPC retention controls yet. */
  readonly candidateRetention: import('./candidate-retention.ts').CandidateRetentionRecord[]
  readonly attempts: AttemptRecord[]
  readonly executionBlocks: ExecutionBlock[]
  readonly dispatchRequests: DispatchRequest[]
  readonly dispatchStatus: DispatchStatus[]
  readonly health: AttemptHealth[]
  readonly escalations: OperatorEscalation[]
  readonly readyTasks: { projectId: string; teamId: string; taskId: string }[]
  readonly workflows: WorkflowRuntimeView[]
  readonly batches: WorkspaceBatchView[]
  readonly runtimeCapabilities: { dsh: RuntimeProviderCapabilities; external?: RuntimeProviderCapabilities }
  readonly batchNotifications: WorkspaceBatchNotification[]
}

/** Owns the complete workspace while its coordinator journal remains open. No fabricated Agent authority. */
export class WorkspaceCoordinator {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly controller = new AbortController()
  private readonly workspacePages = new WorkspacePageSnapshotStore()
  private readonly shutdown: RetainedShutdown
  private projects: CoordinatorProjectView[] = []
  private execution: CoordinatorExecution | undefined
  private workflowStore: WorkflowStore | undefined
  private workflows: WorkflowRuntime | undefined
  private batches: CoordinatorBatchStore | undefined

  private constructor(
    private readonly ctx: Context,
    private readonly journal: DurableJournal<State, Payload>,
    private readonly catalog: ProjectCatalog, private readonly publication: PublicationConfig | undefined, private readonly workspaceOperatorId: string | undefined,
    shutdownDeadlineMs: number,
  ) { this.shutdown = new RetainedShutdown(shutdownDeadlineMs) }

  static async open(ctx: Context, config: CoordinatorConfig): Promise<WorkspaceCoordinator> {
    if (config.execution !== undefined) executionConfigSchema.parse(config.execution)
    if (!isAbsolute(config.directory)) throw new Error('Coordinator directory must be absolute')
    const shutdownDeadlineMs = config.shutdownDeadlineMs ?? 30_000
    if (!Number.isSafeInteger(shutdownDeadlineMs) || shutdownDeadlineMs < 1 || shutdownDeadlineMs > MAX_TIMER_TIMEOUT_MS) throw new Error('Coordinator shutdown deadline must be a positive integer no greater than Node\'s maximum timer delay')
    // Acquire this directory-wide service lock before opening any subordinate store.
    const journal = await DurableJournal.open<State, Payload>(join(config.directory, 'coordinator.jsonl'), {
      id: undefined, operatorId: undefined, controls: [], reconciliations: [], plans: [], admitted: [],
    }, reduce)
    let catalog: ProjectCatalog | undefined
    let execution: CoordinatorExecution | undefined
    let workflowStore: WorkflowStore | undefined
    let workflows: WorkflowRuntime | undefined
    let coordinator: WorkspaceCoordinator | undefined
    try {
      if (journal.snapshot().id === undefined) await journal.append(() => ({ type: 'coordinator/created', id: randomUUID() }))
      if (config.publication && (!config.publication.grants.length || typeof config.publication.publisher.publish !== 'function' || !config.publication.publisher.identity || !Number.isInteger(config.publication.publisher.revision) || config.publication.publisher.revision < 1)) throw new Error('Publication configuration requires grants and an identified idempotent publisher')
      catalog = await ProjectCatalog.open(config.directory, config.publication?.grants)
      coordinator = new WorkspaceCoordinator(ctx, journal, catalog, config.publication, config.workspaceOperatorId, shutdownDeadlineMs)
      const activeCoordinator = coordinator
      if (journal.snapshot().operatorId !== config.workspaceOperatorId) {
        if (journal.snapshot().operatorId !== undefined || config.workspaceOperatorId === undefined) throw new Error('Configured workspace operator disagrees with durable coordinator authority')
        await journal.append(() => ({ type: 'coordinator/workspace-operator-configured', operatorId: config.workspaceOperatorId! }))
      }
      const ownedCatalog = catalog
      execution = await CoordinatorExecution.open(ctx, config.directory, config.execution, () => ownedCatalog.list(), projectId => journal.snapshot().controls.find(control => control.projectId === projectId)?.paused === true)
      activeCoordinator.execution = execution
      activeCoordinator.batches = await CoordinatorBatchStore.open(config.directory)
      execution.setWorkspaceBatchBlocker(work => activeCoordinator.workspaceBatchBlocker(work))
      workflowStore = await WorkflowStore.open(config.directory)
      workflows = await WorkflowRuntime.open(config.directory, workflowStore, execution.reportStore(), {
        createPinnedTask: async intent => await execution!.createPinnedWorkflowTask(intent),
        createPinnedCodeTask: async intent => await execution!.createPinnedWorkflowCodeTask(intent),
        codeStatus: async intent => await execution!.workflowCodeStatus(intent),
        approvePinnedIntegration: async receipt => await execution!.approveWorkflowIntegration(receipt),
        ...(config.publication === undefined ? {} : { publishAuthorizedRelease: async intent => await config.publication!.publisher.publish(intent), publicationPublisher: { identity: config.publication.publisher.identity, revision: config.publication.publisher.revision } }),
      }, [investigationReportTemplate, implementationTestReviewIntegrationTemplate, ...(config.publication === undefined ? [] : [releasePublicationTemplate])])
      activeCoordinator.workflowStore = workflowStore
      activeCoordinator.workflows = workflows
      await activeCoordinator.reconcile()
      return activeCoordinator
    } catch (error) {
      await workflows?.close()
      await workflowStore?.close()
      await execution?.close()
      await coordinator?.batches?.close()
      try { await catalog?.close() } finally { await journal.close() }
      throw error
    }
  }

  /** The exact Lead can grant service access to its own Team; broader grants require an operator surface. */
  register(caller: Agent, request: RegisterProjectRequest): Promise<ProjectRecord> {
    const snapshot = structuredClone(request)
    return this.run(async () => {
      this.assertLead(caller)
      if (snapshot.teamIds.length !== 1 || snapshot.teamIds[0] !== caller.id) throw new Error('A Lead can register only its own team')
      await this.ctx.sessions.flush(caller.session)
      const project = await this.catalog.register(snapshot)
      await this.scan()
      return project
    })
  }

  /** Registration is durably committed before the existing task board can accept work. */
  acceptTask(caller: Agent, projectId: string, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const snapshot = structuredClone(request)
    return this.run(async () => {
      this.authorize(caller, projectId)
      const task = await this.ctx.agentTeams.createTask(caller, snapshot)
      await this.scan()
      return task
    })
  }

  /**
   * Plan globally-addressed work under the configured workspace operator.
   * Task admission keys and references are persisted before any Team-log write.
   */
  planWorkspaceBatch(caller: Agent, request: WorkspaceBatchPlanRequest): Promise<WorkspaceBatchView> {
    const input = workspaceBatchPlanSchema.parse(structuredClone(request))
    return this.run(async () => {
      this.assertWorkspaceOperator(caller)
      const batchId = input.id ?? `workspace-batch-${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`
      const itemIds = new Set(input.items.map(item => item.id))
      if (itemIds.size !== input.items.length) throw new Error('Workspace batch plan repeats an item id')
      for (const item of input.items) {
        const project = this.catalog.list().find(project => project.id === item.projectId)
        if (!project || !project.teamIds.includes(item.teamId)) throw new Error('Workspace batch plan escapes registered project ownership')
        if (item.dependsOn.some(dependency => !itemIds.has(dependency))) throw new Error('Workspace batch plan references an unknown dependency')
      }
      const visiting = new Set<string>(), visited = new Set<string>()
      const visit = (itemId: string): void => {
        if (visiting.has(itemId)) throw new Error('Workspace batch plan dependencies contain a cycle')
        if (visited.has(itemId)) return
        visiting.add(itemId)
        for (const dependency of input.items.find(item => item.id === itemId)!.dependsOn) visit(dependency)
        visiting.delete(itemId); visited.add(itemId)
      }
      for (const item of input.items) visit(item.id)
      if (input.subscriptions.some(subscription => subscription.destination !== `in-app:${caller.id}`)) throw new Error('Workspace batch subscriptions are limited to the durable in-app operator inbox')
      const items = input.items.map(item => ({ ...item,
        admissionKey: `batch-${createHash('sha256').update(`${batchId}\u0000${item.id}`).digest('hex')}`.slice(0, 101),
        taskId: '' }))
      const plan: StoredBatchPlan = { ...input, id: batchId,
        items: items.map(item => ({ ...item, taskId: `workflow-${item.admissionKey}` })) }
      const prior = this.journal.snapshot().plans.find(value => value.id === batchId)
      if (prior !== undefined) {
        if (JSON.stringify(prior) !== JSON.stringify(plan)) throw new Error('Workspace batch plan replay differs from its durable intent')
      } else await this.journal.append(() => ({ type: 'workspace-batch/planned', plan }))
      await this.reconcileWorkspaceBatches()
      await this.scan()
      return this.batches!.inspect(batchId)!
    })
  }

  inspectWorkspaceBatch(caller: Agent, batchId: string): WorkspaceBatchView {
    this.assertWorkspaceOperator(caller)
    const batch = this.batches?.inspect(id.parse(batchId))
    if (!batch) throw new Error('Workspace batch is missing')
    return structuredClone(batch)
  }

  /** Read the bounded cross-project dashboard only as the durable workspace operator. */
  workspaceDashboard(caller: Agent): WorkspaceDashboardView {
    this.assertWorkspaceOperator(caller)
    return projectWorkspaceDashboard(this.workspaceDashboardSource())
  }

  /** Serves a retained immutable projection; continuations never consult live coordinator state. */
  workspaceDashboardPage(caller: Agent, request: WorkspaceDashboardPageRequest): WorkspaceDashboardPage {
    this.assertWorkspaceOperator(caller)
    return this.workspacePages.page(caller.id, request, () => this.workspaceDashboardSource())
  }

  private workspaceDashboardSource(): unknown {
    const current = this.view()
    return {
      projects: current.projects.map(project => ({ id: project.project.id, revision: project.controlRevision, paused: project.paused, capacity: project.project.capacity, active: current.attempts.filter(attempt => attempt.projectId === project.project.id && attempt.phase !== 'terminal').length })),
      attempts: current.attempts.map(attempt => { const health = current.health.findLast(value => value.attemptId === attempt.attemptId && value.generation === attempt.generation); return { attemptId: attempt.attemptId, generation: attempt.generation, revision: attempt.revision, projectId: attempt.projectId, teamId: attempt.teamId, taskId: attempt.taskId, phase: attempt.phase, ...(health === undefined ? {} : { progress: { classification: health.classification, certainty: health.certainty, observedAt: health.observedAt } }), ...(attempt.externalUsage === undefined ? {} : { externalUsage: attempt.externalUsage }) } }),
      workflows: current.workflows.map(workflow => ({ executionId: workflow.executionId, projectId: workflow.projectId, teamId: workflow.teamId, steps: workflow.steps.map(step => ({ stepId: step.stepId, revision: step.revision, phase: step.phase, ...(step.taskId === undefined ? {} : { taskId: step.taskId }) })) })),
      batches: current.batches.map(batch => ({ id: batch.id, phase: batch.phase, required: batch.required, completedRequired: batch.completedRequired, completionEpoch: batch.completionEpoch })),
      queue: current.dispatchStatus.map(request => ({ projectId: request.projectId, teamId: request.teamId, taskId: request.taskId, revision: request.revision, state: request.state, blockers: request.blockers.map(blocker => ({ code: blocker.code })) })),
      integrations: current.projects.flatMap(project => project.teams.flatMap(team => { const lead = this.ctx.agents.get(SessionId(team.teamId)); return lead === undefined ? [] : this.ctx.agentTeams.listIntegrations(lead).map(integration => ({ integrationId: integration.id, projectId: project.project.id, teamId: team.teamId, phase: integration.phase, sourceCommit: integration.sourceCommit, ...(integration.failureKind === undefined ? {} : { failureKind: integration.failureKind }), ...(integration.error === undefined ? {} : { diagnostic: integration.error }) })) })),
      escalations: current.escalations.map(escalation => ({ id: escalation.id, revision: escalation.revision, projectId: escalation.work.projectId, teamId: escalation.work.teamId, taskId: escalation.work.taskId, attemptId: escalation.attemptId, generation: escalation.generation, severity: escalation.severity, condition: escalation.condition, diagnostics: escalation.diagnostics })),
    }
  }

  subscribeWorkspaceBatch(caller: Agent, batchId: string, subscriptionId: string): Promise<WorkspaceBatchView> {
    return this.run(async () => {
      this.assertWorkspaceOperator(caller)
      const batch = await this.batches!.subscribe(id.parse(batchId), { id: id.parse(subscriptionId), destination: `in-app:${caller.id}` })
      await this.scan()
      return batch
    })
  }

  /** Completion is delivered only as a durable coordinator inbox item, never an external message. */
  workspaceBatchInbox(caller: Agent): Promise<WorkspaceBatchNotification[]> {
    return this.run(async () => {
      this.assertWorkspaceOperator(caller)
      await this.batches!.notificationIntents()
      return structuredClone(this.batches!.pendingNotifications().filter(item => item.destination === `in-app:${caller.id}`))
    })
  }

  acknowledgeWorkspaceBatchNotification(caller: Agent, intentId: string): Promise<void> {
    return this.run(async () => {
      this.assertWorkspaceOperator(caller)
      const notification = this.batches!.pendingNotifications().find(item => item.intentId === intentId && item.destination === `in-app:${caller.id}`)
      if (!notification) throw new Error('Workspace batch completion notification is not in this operator inbox')
      await this.batches!.recordNotificationReceipt(intentId, `in-app:${caller.id}`)
    })
  }

  /** Create the only supported non-code workflow under the caller's registered Lead project. */
  createWorkflow(caller: Agent, request: CreateWorkflowRequest): Promise<WorkflowRuntimeView> {
    const snapshot = createWorkflowRequestSchema.parse(structuredClone(request))
    return this.run(async () => {
      const project = this.authorize(caller, snapshot.projectId)
      if (snapshot.teamId !== caller.id) throw new Error('Workflow team must be the registered calling Lead')
      if (!this.workflows) throw new Error('Workflow runtime is unavailable')
      const created = await this.workflows.create(snapshot, { ...project, ...(this.publication === undefined ? {} : { publicationPublisher: { identity: this.publication.publisher.identity, revision: this.publication.publisher.revision } }) })
      await this.scan()
      return this.workflows.inspect(created.executionId)!
    })
  }

  /** Inspect a workflow only through its owning registered Lead project grant. */
  inspectWorkflow(caller: Agent, executionId: string): WorkflowRuntimeView {
    const workflow = this.workflows?.inspect(executionId)
    if (!workflow) throw new Error('Workflow execution is missing')
    this.authorize(caller, workflow.projectId)
    if (workflow.teamId !== caller.id) throw new Error('Workflow is owned by a different Lead')
    return workflow
  }

  /** Resume durable workflow task admission after a process restart or transient host failure. */
  resumeWorkflow(caller: Agent, executionId: string): Promise<WorkflowRuntimeView | undefined> {
    return this.run(async () => {
      const workflow = this.inspectWorkflow(caller, executionId)
      const project = this.authorize(caller, workflow.projectId)
      if (this.journal.snapshot().controls.find(control => control.projectId === project.id)?.paused) throw new Error('Paused project cannot resume workflow work')
      const resumed = await this.workflows!.resume(executionId, project)
      await this.scan()
      return resumed === undefined ? undefined : this.workflows!.inspect(executionId)!
    })
  }

  /** Trusted server operation. It derives authorization actor from the pinned project/execution grant. */
  authorizeWorkflowPublication(caller: Agent, request: { executionId: string; stepId: string; expectedRevision: number; evidence: { kind: string; ref: string } }): Promise<WorkflowRuntimeView> {
    const snapshot = z.object({ executionId: id, stepId: id, expectedRevision: revision, evidence: z.object({ kind: id, ref: z.string().trim().min(1).max(16_384) }).strict() }).strict().parse(structuredClone(request))
    return this.run(async () => {
      const workflow = this.inspectWorkflow(caller, snapshot.executionId)
      const project = this.authorize(caller, workflow.projectId)
      if (this.journal.snapshot().controls.find(control => control.projectId === project.id)?.paused) throw new Error('Paused project cannot authorize publication')
      const authorized = await this.workflows!.authorizePublication(snapshot.executionId, snapshot.stepId, snapshot.expectedRevision, snapshot.evidence, caller.id)
      await this.scan()
      return authorized
    })
  }

  pause(caller: Agent, projectId: string, expectedRevision: number, paused: boolean): Promise<Control> {
    return this.run(async () => {
      this.authorize(caller, projectId)
      const state = await this.journal.append(() => ({ type: 'project/paused', projectId, expectedRevision, paused }))
      await this.scan()
      return state.controls.find(value => value.projectId === projectId)!
    })
  }

  reprioritize(caller: Agent, projectId: string, taskId: string, expectedRevision: number, priority: number): Promise<void> {
    return this.run(async () => {
      this.authorize(caller, projectId)
      if (!this.execution) throw new Error('Coordinator execution is unavailable')
      await this.execution.reprioritize({ projectId, teamId: caller.id, taskId }, expectedRevision, priority)
    })
  }

  submit(caller: Agent, projectId: string, request: SubmitRequest): Promise<SubmissionRecord> {
    const snapshot = structuredClone(request)
    return this.run(async () => {
      const project = this.authorize(caller, projectId)
      if (!this.execution) throw new Error('Coordinator execution is unavailable')
      return this.execution.submit(caller, project, snapshot)
    })
  }

  /** The registered exact Lead records a rationale, then atomically drives the report receipt. */
  acceptReport(caller: Agent, projectId: string, request: AcceptReportRequest): Promise<ReportAcceptanceRecord> {
    const snapshot = structuredClone(request)
    return this.run(async () => {
      const project = this.authorize(caller, projectId)
      if (!this.execution) throw new Error('Coordinator execution is unavailable')
      const accepted = await this.execution.acceptReport(caller, project, snapshot)
      await this.scan()
      return accepted
    })
  }

  /** Read report evidence only through the registered Lead's project grant. */
  reviewReports(caller: Agent, projectId: string): ReviewableReport[] {
    const query = reviewReportsRequestSchema.parse({ projectId })
    this.authorize(caller, query.projectId)
    const view = this.view()
    const accepted = view.reports.filter(report => report.projectId === query.projectId && report.teamId === caller.id)
    const recordedAttempts = new Set(accepted.map(report => report.attemptId))
    const queued = view.attempts.flatMap((attempt): ReviewableReport[] => {
      if (attempt.projectId !== query.projectId || attempt.teamId !== caller.id || recordedAttempts.has(attempt.attemptId)
        || attempt.phase !== 'terminal' || attempt.stopEvidence?.kind !== 'stopped' || attempt.stopReason || !attempt.result) return []
      if (view.attempts.findLast(candidate => candidate.projectId === attempt.projectId && candidate.teamId === attempt.teamId && candidate.taskId === attempt.taskId)?.attemptId !== attempt.attemptId) return []
      if (view.dispatchRequests.some(request => request.projectId === attempt.projectId && request.teamId === attempt.teamId && request.taskId === attempt.taskId && request.cancelReason !== undefined)) return []
      const task = this.ctx.agentTeams.getTask(caller, TeamTaskId(attempt.taskId))
      if (task.nonCodeCriteria === undefined || task.status !== 'pending') return []
      return [{ projectId: attempt.projectId, teamId: attempt.teamId, taskId: attempt.taskId, attemptId: attempt.attemptId,
        generation: attempt.generation, expectedRevision: attempt.revision, expectedTaskRevision: task.revision,
        report: attempt.result, criteria: task.nonCodeCriteria, phase: 'awaiting-review',
        ...(task.reviewBinding === undefined ? {} : { reviewBinding: task.reviewBinding }) }]
    })
    return structuredClone([...queued, ...accepted])
  }

  scheduling(caller: Agent, request: SchedulingQuery): SchedulingView {
    const { projectId } = schedulingQuerySchema.parse(request)
    this.authorize(caller, projectId)
    const view = this.view()
    const project = view.projects.find(project => project.project.id === projectId)!
    return { projectId, paused: project.paused, controlRevision: project.controlRevision,
      requests: view.dispatchStatus.filter(request => request.projectId === projectId && request.teamId === caller.id) }
  }

  /** Read only the registered calling Lead's durable operator inbox. */
  healthInbox(caller: Agent, projectId: string): OperatorEscalation[] {
    this.authorize(caller, projectId)
    if (!this.execution) throw new Error('Coordinator execution is unavailable')
    return this.execution.healthInbox(projectId, caller.id)
  }

  acknowledgeHealth(caller: Agent, projectId: string, escalationId: string, expectedRevision: number): Promise<OperatorEscalation> {
    return this.run(async () => {
      this.authorize(caller, projectId)
      if (!this.execution || !this.execution.healthInbox(projectId, caller.id).some(item => item.id === escalationId)) throw new Error('Escalation is not in this Lead inbox')
      return await this.execution.acknowledgeHealth(escalationId, expectedRevision, caller.id)
    })
  }

  async controlScheduling(caller: Agent, request: SchedulingControl): Promise<SchedulingView> {
    const control = schedulingControlSchema.parse(request)
    if (control.action === 'pause') await this.pause(caller, control.projectId, control.expectedRevision, control.paused)
    else if (control.action === 'cancel') await this.run(async () => {
      this.authorize(caller, control.projectId)
      if (!this.execution) throw new Error('Coordinator execution is unavailable')
      await this.execution.cancel(caller, { projectId: control.projectId, teamId: caller.id, taskId: control.taskId }, control.expectedRevision, control.reason)
    })
    else await this.reprioritize(caller, control.projectId, control.taskId, control.expectedRevision, control.priority)
    return this.scheduling(caller, { projectId: control.projectId })
  }

  reconcile(): Promise<void> { return this.run(() => this.scan()) }

  view(): CoordinatorView {
    const execution = this.execution?.view(this.projects) ?? { attempts: [], executionBlocks: [], dispatchRequests: [], dispatchStatus: [], submissions: [], reports: [], candidateRetention: [], health: [], escalations: [] }
    return structuredClone({
      ...execution,
      id: this.journal.snapshot().id!, projects: this.projects,
      workflows: this.workflowViews(),
      batches: this.batches?.list() ?? [],
      batchNotifications: this.batches?.pendingNotifications() ?? [],
      runtimeCapabilities: this.execution?.routedCapabilities() ?? disabledRuntimeCapabilities(),
      // This mirrors the scheduler's authoritative batch fence for dashboard callers.
      readyTasks: this.projects.flatMap(project => project.paused ? [] : project.teams.flatMap(team =>
        team.status !== 'available' ? [] : team.tasks.filter(task => task.status === 'pending' && task.blockedBy.every(id => team.tasks.find(task => task.id === id)?.status === 'completed')
          && this.workspaceBatchBlocker({ projectId: project.project.id, teamId: team.teamId, taskId: task.id }) === undefined
          && !execution.attempts.some(attempt => attempt.teamId === team.teamId && attempt.taskId === task.id)
          && !execution.dispatchRequests.some(request => request.teamId === team.teamId && request.taskId === task.id && request.cancelReason !== undefined))
          .map(task => ({ projectId: project.project.id, teamId: team.teamId, taskId: task.id })))),
    })
  }

  close(): Promise<void> {
    this.controller.abort(new Error('Coordinator is closing'))
    return this.shutdown.close(async () => {
      await this.pending
      await this.workspacePages.close()
      await this.workflows?.close()
      await this.workflowStore?.close()
      await this.execution?.close()
      await this.batches?.close()
      try { await this.catalog.close() } finally { await this.journal.close() }
    })
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.controller.signal.aborted) return Promise.reject(new Error('Coordinator is closed'))
    const running = this.pending.then(() => { this.controller.signal.throwIfAborted(); return operation() })
    this.pending = running.catch(() => {})
    return running
  }

  private assertLead(caller: Agent): void {
    if (this.ctx.agents.get(caller.id) !== caller || this.ctx.agentTeams.tryMembership(caller)?.role !== 'lead') {
      throw new Error('Coordinator mutation requires an exact live Lead')
    }
  }

  private authorize(caller: Agent, projectId: string): ProjectRecord {
    this.assertLead(caller)
    const project = this.catalog.list().find(project => project.id === projectId)
    if (!project) throw new Error('Project is not registered')
    if (!project.teamIds.includes(caller.id)) throw new Error('Lead is not authorized for this project')
    return project
  }

  private assertWorkspaceOperator(caller: Agent): void {
    if (!this.workspaceOperatorId || this.journal.snapshot().operatorId !== this.workspaceOperatorId) throw new Error('Cross-project batch operations require configured workspace operator authority')
    if (this.ctx.agents.get(caller.id) !== caller || caller.id !== this.workspaceOperatorId) throw new Error('Caller is not the configured workspace operator')
  }

  private workspaceBatchBlocker(work: WorkspaceTaskRef): string | undefined {
    for (const batch of this.batches?.list() ?? []) {
      const item = batch.items.find(item => item.ref.projectId === work.projectId && item.ref.teamId === work.teamId && item.ref.taskId === work.taskId)
      if (!item) continue
      const pending = item.dependsOn.filter(dependency => batch.items.find(candidate => candidate.ref.projectId === dependency.projectId && candidate.ref.teamId === dependency.teamId && candidate.ref.taskId === dependency.taskId)?.state !== 'accepted')
      if (pending.length) return `Workspace batch ${batch.id} requires accepted cross-project dependencies: ${pending.map(value => `${value.projectId}/${value.teamId}/${value.taskId}`).join(', ')}`
    }
    return undefined
  }

  private async reconcileWorkspaceBatches(): Promise<void> {
    if (!this.batches || !this.execution) return
    for (const plan of this.journal.snapshot().plans) {
      if (!this.batches.inspect(plan.id)) {
        await this.batches.create({ id: plan.id, name: plan.name,
          items: plan.items.map(item => ({ ref: { projectId: item.projectId, teamId: item.teamId, taskId: item.taskId }, dependsOn: item.dependsOn.map(dependency => {
            const target = plan.items.find(candidate => candidate.id === dependency)!
            return { projectId: target.projectId, teamId: target.teamId, taskId: target.taskId }
          }) })), subscriptions: plan.subscriptions })
      }
      for (const item of plan.items) {
        if (this.journal.snapshot().admitted.some(value => value.batchId === plan.id && value.itemId === item.id)) continue
        const project = this.catalog.list().find(project => project.id === item.projectId)
        if (!project) throw new Error('Workspace batch durable plan references an unregistered project')
        const lead = await this.execution.admittedLead(project, item.teamId)
        const task = await this.ctx.agentTeams.createPinnedTask(lead, { admissionKey: item.admissionKey, subject: item.subject, description: item.description,
          workflowBinding: { executionId: plan.id, stepId: item.id, inputs: [] }, ...(item.nonCodeCriteria === undefined ? {} : { nonCodeCriteria: item.nonCodeCriteria }) })
        if (task.id !== item.taskId) throw new Error('Workspace batch task admission key produced an unexpected task identity')
        await this.journal.append(() => ({ type: 'workspace-batch/task-admitted', batchId: plan.id, itemId: item.id }))
      }
    }
  }

  private async observeWorkspaceBatches(projects: readonly CoordinatorProjectView[]): Promise<void> {
    if (!this.batches) return
    const execution = this.execution?.view(projects)
    for (const batch of this.batches.list()) {
      const observations = batch.items.flatMap(item => {
        const project = projects.find(project => project.project.id === item.ref.projectId)
        const team = project?.teams.find(team => team.teamId === item.ref.teamId)
        const task = team?.tasks.find(task => task.id === item.ref.taskId)
        if (!task) return []
        const attempt = execution?.attempts.findLast(attempt => attempt.projectId === item.ref.projectId && attempt.teamId === item.ref.teamId && attempt.taskId === item.ref.taskId)
        const currentReport = attempt === undefined ? undefined : execution?.reports.findLast(report => report.projectId === item.ref.projectId && report.teamId === item.ref.teamId && report.taskId === item.ref.taskId
          && report.attemptId === attempt.attemptId && report.generation === attempt.generation)
        const reportAccepted = currentReport?.phase === 'accepted'
        const currentSubmission = attempt === undefined ? undefined : execution?.submissions.findLast(submission => submission.projectId === item.ref.projectId && submission.teamId === item.ref.teamId && submission.taskId === item.ref.taskId
          && submission.attemptId === attempt.attemptId && submission.generation === attempt.generation)
        const submissionAccepted = currentSubmission?.phase === 'accepted'
        const accepted = task.status === 'completed' && (task.nonCodeCriteria === undefined ? submissionAccepted : reportAccepted)
        // Verification failure is a durable integration outcome even when the
        // worker itself ended normally and has no stop reason. Surface it to
        // the workspace graph so it cannot masquerade as active/waiting work.
        const lead = this.ctx.agents.get(SessionId(item.ref.teamId))
        const integrationFailed = lead !== undefined && currentSubmission !== undefined
          && ctxIntegrationFailed(this.ctx, lead, currentSubmission.integrationId)
        const failed = integrationFailed || (attempt?.phase === 'terminal' && !!attempt.stopReason)
        // Failure is the batch outcome; assignment ownership is independent.
        // A successor repair can still be running while a prior integration is
        // failed, and observers must retain its live runtime ownership.
        const activeAssignment = attempt !== undefined && attempt.phase !== 'terminal'
        const state = accepted ? 'accepted' as const : failed ? 'failed' as const : task.status !== 'pending' && !activeAssignment ? 'blocked' as const : activeAssignment ? 'active' as const : 'waiting' as const
        // `acceptance` is the terminal integration receipt component of the
        // observation tuple: 0 is no terminal receipt, 1 is a failed
        // verification/integration receipt, and 2 is an accepted receipt.
        // The task and assignment records need not change when Git writes a
        // failed receipt, so omitting this component would replay a stale
        // waiting observation at the same source revision.
        const terminalReceipt = accepted ? 2 : integrationFailed ? 1 : 0
        return [{ ref: item.ref, revision: { task: task.revision, generation: attempt?.generation ?? 0, attempt: attempt?.revision ?? 0, acceptance: terminalReceipt }, state, activeAssignment }]
      })
      if (observations.length) await this.batches.observe(batch.id, observations)
    }
  }

  private async scan(): Promise<void> {
    const projects: CoordinatorProjectView[] = []
    for (const project of this.catalog.list()) {
      const control = this.journal.snapshot().controls.find(value => value.projectId === project.id)
      const teams: CoordinatorTeamView[] = []
      for (const teamId of project.teamIds) {
        this.controller.signal.throwIfAborted()
        let tasks: TeamTaskSnapshot[] = []
        let reconciliation: Reconciliation = { projectId: project.id, teamId, status: 'available', diagnostic: '' }
        try {
          const stored = await this.ctx.sessionPersistence.inspect(SessionId(teamId), this.controller.signal)
          let state = teamProjectionDefinition.init(stored.meta)
          for (const event of stored.events) state = teamProjectionDefinition.apply(state, event)
          if (state.failure !== undefined) throw new Error(state.failure)
          tasks = state.tasks.filter(task => task.status !== 'deleted')
        } catch (error) {
          this.controller.signal.throwIfAborted()
          reconciliation = { ...reconciliation, status: 'unavailable', diagnostic: (error instanceof Error ? error.message : String(error)).slice(0, 16_384) }
        }
        const prior = this.journal.snapshot().reconciliations.find(value => value.projectId === project.id && value.teamId === teamId)
        if (prior?.status !== reconciliation.status || prior.diagnostic !== reconciliation.diagnostic) {
          await this.journal.append(() => ({ type: 'team/reconciliation', reconciliation }))
        }
        teams.push({ ...reconciliation, tasks })
      }
      projects.push({ project, paused: control?.paused ?? false, controlRevision: control?.revision ?? 0, teams })
    }
    this.projects = projects
    await this.reconcileWorkspaceBatches()
    await this.observeWorkspaceBatches(projects)
    await this.batches?.notificationIntents()
    await this.execution?.scan(projects)
    // Execution can accept a report or integrated submission after the first
    // projection. Re-read the authoritative Team logs before returning so the
    // batch phase and completion inbox never lag a completed managed task.
    await this.refreshProjects()
    await this.observeWorkspaceBatches(this.projects)
    await this.batches?.notificationIntents()
    let workflowTaskCreated = false
    for (const project of projects) if (!project.paused) {
      const dispatched = await this.workflows?.scan(project.project)
      workflowTaskCreated ||= (dispatched?.length ?? 0) > 0
    }
    // Workflow task admission changes the Lead log after the first projection.
    // Re-read it and let the ordinary coordinator queue reserve the fresh step attempt.
    if (workflowTaskCreated) {
      await this.refreshProjects()
      await this.execution?.scan(this.projects)
    }
  }

  private workflowViews(): WorkflowRuntimeView[] {
    if (!this.workflows) return []
    return this.workflowStore!.list().flatMap(execution => {
      const workflow = this.workflows!.inspect(execution.id)
      return workflow ? [workflow] : []
    })
  }

  private async refreshProjects(): Promise<void> {
    const projects: CoordinatorProjectView[] = []
    for (const project of this.catalog.list()) {
      const control = this.journal.snapshot().controls.find(value => value.projectId === project.id)
      const teams: CoordinatorTeamView[] = []
      for (const teamId of project.teamIds) {
        this.controller.signal.throwIfAborted()
        let tasks: TeamTaskSnapshot[] = []
        let reconciliation: Reconciliation = { projectId: project.id, teamId, status: 'available', diagnostic: '' }
        try {
          const stored = await this.ctx.sessionPersistence.inspect(SessionId(teamId), this.controller.signal)
          let state = teamProjectionDefinition.init(stored.meta)
          for (const event of stored.events) state = teamProjectionDefinition.apply(state, event)
          if (state.failure !== undefined) throw new Error(state.failure)
          tasks = state.tasks.filter(task => task.status !== 'deleted')
        } catch (error) {
          this.controller.signal.throwIfAborted()
          reconciliation = { ...reconciliation, status: 'unavailable', diagnostic: (error instanceof Error ? error.message : String(error)).slice(0, 16_384) }
        }
        const prior = this.journal.snapshot().reconciliations.find(value => value.projectId === project.id && value.teamId === teamId)
        if (prior?.status !== reconciliation.status || prior.diagnostic !== reconciliation.diagnostic) await this.journal.append(() => ({ type: 'team/reconciliation', reconciliation }))
        teams.push({ ...reconciliation, tasks })
      }
      projects.push({ project, paused: control?.paused ?? false, controlRevision: control?.revision ?? 0, teams })
    }
    this.projects = projects
  }
}

function disabledRuntimeCapabilities(): { dsh: RuntimeProviderCapabilities } {
  const disabled = { supported: false as const, reason: 'execution is disabled' }
  return { dsh: { start: disabled, resume: disabled, status: disabled, cancel: disabled, message: disabled, usage: disabled, artifacts: disabled } }
}
