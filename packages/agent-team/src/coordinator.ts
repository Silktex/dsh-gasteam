/** Durable workspace startup, directory ownership, and registered-Team admission. */
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Branded } from '@deepseek-ai/dsh-brand'
import z from 'zod'
import schema from '@deepseek-ai/schemastery'
import { DurableJournal } from './durable-journal.ts'
import { ProjectCatalog } from './projects.ts'
import type { ProjectRecord, RegisterProjectRequest } from './projects.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamTaskId } from './types.ts'
import type { CreateTeamTaskRequest, TeamTaskSnapshot, TeamTaskView } from './types.ts'
import type {} from './index.ts'
import { CoordinatorExecution, executionConfigSchema } from './coordinator-execution.ts'
import type { ExecutionConfig, ExecutionBlock, DispatchStatus } from './coordinator-execution.ts'
import { schedulingQuerySchema, schedulingControlSchema } from './scheduling-schemas.ts'
import type { SchedulingQuery, SchedulingControl, SchedulingView } from './scheduling-schemas.ts'
import type { SubmitRequest, SubmissionRecord } from './submissions.ts'
import { reviewReportsRequestSchema } from './reports.ts'
import type { AcceptReportRequest, ReportAcceptanceRecord, ReviewableReport } from './reports.ts'
import type { DispatchRequest } from './dispatch-queue.ts'
import type { AttemptRecord } from './assignments.ts'
import { WorkflowStore } from './workflows.ts'
import { WorkflowRuntime, createWorkflowRequestSchema } from './workflow-runtime.ts'
import type { CreateWorkflowRequest, WorkflowRuntimeView } from './workflow-runtime.ts'
import { investigationReportTemplate } from './workflow-templates.ts'
import type { AttemptHealth, OperatorEscalation } from './health.ts'

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
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('coordinator/created'), id }).strict(),
  z.object({ ...envelope, type: z.literal('project/paused'), projectId: id, expectedRevision: revision, paused: z.boolean() }).strict(),
  z.object({ ...envelope, type: z.literal('team/reconciliation'), reconciliation: reconciliationSchema }).strict(),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, 'version' | 'sequence'> : never : never
interface Control { projectId: string; revision: number; paused: boolean }
type Reconciliation = z.output<typeof reconciliationSchema>
interface State { id: CoordinatorId | undefined; controls: Control[]; reconciliations: Reconciliation[] }
function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw)
  if (event.type === 'coordinator/created') {
    if (state.id !== undefined) throw new Error('Coordinator identity cannot be replaced')
    return { ...state, id: event.id as CoordinatorId }
  }
  if (state.id === undefined) throw new Error('Coordinator identity must precede operations')
  if (event.type === 'project/paused') {
    const old = state.controls.find(control => control.projectId === event.projectId)
    if ((old?.revision ?? 0) !== event.expectedRevision) throw new Error('Stale project control revision')
    return { ...state, controls: [...state.controls.filter(control => control.projectId !== event.projectId), {
      projectId: event.projectId, revision: event.expectedRevision + 1, paused: event.paused,
    }] }
  }
  const next = event.reconciliation
  return { ...state, reconciliations: [...state.reconciliations.filter(value =>
    value.projectId !== next.projectId || value.teamId !== next.teamId), next] }
}
export interface CoordinatorConfig { readonly directory: string; readonly execution?: ExecutionConfig | undefined }
export interface Config extends CoordinatorConfig { readonly scanIntervalMs: number }
export const name = 'agent-team-workspace-coordinator'
export const inject = ['agentTeams', 'agents', 'sessions', 'sessionPersistence', 'subagents']
export const Config: schema<Config> = schema.object({
  directory: schema.string().required(), scanIntervalMs: schema.number().step(1).min(1).default(1_000),
  execution: schema.union([schema.const(undefined), schema.object({ modelProvider: schema.string().required(), model: schema.string().required(), maxRepairAttempts: schema.union([schema.const(undefined), schema.number().step(1).min(0).max(10)]), dispatchIntervalMs: schema.union([schema.const(undefined), schema.number().step(1).min(0)]), candidateRetention: schema.union([schema.const(undefined), schema.object({ delayMs: schema.number().step(1).min(0), commandTimeoutMs: schema.union([schema.const(undefined), schema.number().step(1).min(1)]), })]), health: schema.union([schema.const(undefined), schema.object({ dshDeadlineMs: schema.number().step(1).min(1), externalDeadlineMs: schema.number().step(1).min(1), escalationCooldownMs: schema.number().step(1).min(0), maxEscalationsPerCondition: schema.number().step(1).min(1).max(100) })]), maxConcurrent: schema.number().step(1).min(1).default(8) })]),
})

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
}

/** Owns the complete workspace while its coordinator journal remains open. No fabricated Agent authority. */
export class WorkspaceCoordinator {
  private pending: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private readonly controller = new AbortController()
  private projects: CoordinatorProjectView[] = []
  private execution: CoordinatorExecution | undefined
  private workflowStore: WorkflowStore | undefined
  private workflows: WorkflowRuntime | undefined

  private constructor(
    private readonly ctx: Context,
    private readonly journal: DurableJournal<State, Payload>,
    private readonly catalog: ProjectCatalog,
  ) {}

  static async open(ctx: Context, config: CoordinatorConfig): Promise<WorkspaceCoordinator> {
    if (config.execution !== undefined) executionConfigSchema.parse(config.execution)
    if (!isAbsolute(config.directory)) throw new Error('Coordinator directory must be absolute')
    // Acquire this directory-wide service lock before opening any subordinate store.
    const journal = await DurableJournal.open<State, Payload>(join(config.directory, 'coordinator.jsonl'), {
      id: undefined, controls: [], reconciliations: [],
    }, reduce)
    let catalog: ProjectCatalog | undefined
    let execution: CoordinatorExecution | undefined
    let workflowStore: WorkflowStore | undefined
    let workflows: WorkflowRuntime | undefined
    try {
      if (journal.snapshot().id === undefined) await journal.append(() => ({ type: 'coordinator/created', id: randomUUID() }))
      catalog = await ProjectCatalog.open(config.directory)
      const coordinator = new WorkspaceCoordinator(ctx, journal, catalog)
      const ownedCatalog = catalog
      execution = await CoordinatorExecution.open(ctx, config.directory, config.execution, () => ownedCatalog.list())
      coordinator.execution = execution
      workflowStore = await WorkflowStore.open(config.directory)
      workflows = await WorkflowRuntime.open(config.directory, workflowStore, execution.reportStore(), {
        createPinnedTask: async intent => await execution!.createPinnedWorkflowTask(intent),
      }, [investigationReportTemplate])
      coordinator.workflowStore = workflowStore
      coordinator.workflows = workflows
      await coordinator.reconcile()
      return coordinator
    } catch (error) {
      await workflows?.close()
      await workflowStore?.close()
      await execution?.close()
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

  /** Create the only supported non-code workflow under the caller's registered Lead project. */
  createWorkflow(caller: Agent, request: CreateWorkflowRequest): Promise<WorkflowRuntimeView> {
    const snapshot = createWorkflowRequestSchema.parse(structuredClone(request))
    return this.run(async () => {
      const project = this.authorize(caller, snapshot.projectId)
      if (snapshot.teamId !== caller.id) throw new Error('Workflow team must be the registered calling Lead')
      if (!this.workflows) throw new Error('Workflow runtime is unavailable')
      const created = await this.workflows.create(snapshot, project)
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
      const resumed = await this.workflows!.resume(executionId, project)
      await this.scan()
      return resumed === undefined ? undefined : this.workflows!.inspect(executionId)!
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
        report: attempt.result, criteria: task.nonCodeCriteria, phase: 'awaiting-review' }]
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
      // Dependency acceptance is added by the scheduler/integration slices. No dependent work is prematurely eligible.
      readyTasks: this.projects.flatMap(project => project.paused ? [] : project.teams.flatMap(team =>
        team.status !== 'available' ? [] : team.tasks.filter(task => task.status === 'pending' && task.blockedBy.every(id => team.tasks.find(task => task.id === id)?.status === 'completed')
          && !execution.attempts.some(attempt => attempt.teamId === team.teamId && attempt.taskId === task.id)
          && !execution.dispatchRequests.some(request => request.teamId === team.teamId && request.taskId === task.id && request.cancelReason !== undefined))
          .map(task => ({ projectId: project.project.id, teamId: team.teamId, taskId: task.id })))),
    })
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.controller.abort(new Error('Coordinator is closing'))
    return this.closing = this.pending.then(async () => {
      await this.workflows?.close()
      await this.workflowStore?.close()
      await this.execution?.close()
      try { await this.catalog.close() } finally { await this.journal.close() }
    }).catch((error: unknown) => {
      this.closing = undefined
      throw error
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
    await this.execution?.scan(projects)
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
