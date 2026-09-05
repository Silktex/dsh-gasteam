/** Automatic independent-task admission; dependency acceptance and retry policy extend this service. */
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from 'zod'
import { AssignmentStore } from './assignments.ts'
import type { AttemptRecord } from './assignments.ts'
import { runGit } from './git-command.ts'
import { SubmissionStore, submitRequestSchema } from './submissions.ts'
import type { SubmitRequest, SubmissionRecord } from './submissions.ts'
import { ReportStore, acceptReportRequestSchema } from './reports.ts'
import type { AcceptReportRequest, ReportAcceptanceRecord } from './reports.ts'
import { TeamTaskId } from './types.ts'
import type { TeamExternalIntegrationWorktree, TeamIntegrationAdmission, TeamIntegrationId, TeamIntegrationReviewReceipt } from './types.ts'
import { DispatchQueue } from './dispatch-queue.ts'
import type { DispatchRequest, DispatchWork } from './dispatch-queue.ts'
import { DshAssignmentRuntime } from './dsh-assignment-runtime.ts'
import { ExternalNonCodeAssignmentAdapter } from './external-assignment-adapter.ts'
import { ExternalAssignmentRuntime } from './external-assignment-runtime.ts'
import { ExternalRuntimeStore } from './external-runtime.ts'
import { admitCodex } from './codex-admission.ts'
import { DurableJournal } from './durable-journal.ts'
import { CandidateRetentionStore } from './candidate-retention.ts'
import type { CandidateRetentionRecord } from './candidate-retention.ts'
import { GitCandidateCleanup } from './git-candidate-cleanup.ts'
import { HealthStore, healthConfigSchema } from './health.ts'
import type { AttemptHealth, OperatorEscalation } from './health.ts'
import { DshHealthRuntimeObserver } from './health-runtime-observation.ts'
import { TeamError } from './error.ts'
import type { ProjectRecord } from './projects.ts'
import type { CoordinatorProjectView } from './coordinator.ts'
import type {} from './index.ts'
import type { WorkflowCodeStatus, WorkflowCodeTaskCreateIntent, WorkflowIntegrationApproval, WorkflowTaskCreateIntent } from './workflow-runtime.ts'

export const executionConfigSchema = z.object({
  modelProvider: z.string().trim().min(1), model: z.string().trim().min(1),
  maxRepairAttempts: z.number().int().min(0).max(10).optional(),
  dispatchIntervalMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  /** Disabled unless explicitly set. The delay is pinned when a merged candidate is first observed. */
  candidateRetention: z.object({ delayMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), commandTimeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(30_000) }).strict().optional(),
  /** Disabled unless an operator explicitly enables durable health observation. */
  health: healthConfigSchema.optional(),
  /**
   * Opt-in external Codex execution in one already
   * registered project. Example: `{ projectId: 'research', cwd: '/repos/research',
   * directory: '/var/lib/dsh/external' }`; `cwd` must canonically equal that
   * project's repository, and every launch field is pinned at reservation.
   */
  externalCodex: z.object({ projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/), directory: z.string().trim().min(1).max(4096), codeWorktreeDirectory: z.string().trim().min(1).max(4096).optional(), cwd: z.string().trim().min(1).max(4096), executable: z.string().trim().min(1).max(4096), version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/), model: z.string().trim().min(1).max(512), sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']), maxSpoolBytes: z.number().int().positive().max(16 * 1024 * 1024), terminateGraceMs: z.number().int().positive().max(300_000), admissionMaxOutputBytes: z.number().int().positive().max(65_536).default(16_384), admissionTimeoutMs: z.number().int().positive().max(30_000).default(5_000) }).strict().optional(),
  maxConcurrent: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
export type ExecutionConfig = z.input<typeof executionConfigSchema>
const blockSchema = z.object({ projectId: z.string(), teamId: z.string(), taskId: z.string(), diagnostic: z.string().min(1).max(16_384) }).strict()
export type ExecutionBlock = z.output<typeof blockSchema>
const blockedEvent = z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('work/blocked'), block: blockSchema }).strict()
const token = (record: AttemptRecord) => ({ attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })
const sameWork = (left: { projectId: string; teamId: string; taskId: string }, right: { projectId: string; teamId: string; taskId: string }) =>
  left.projectId === right.projectId && left.teamId === right.teamId && left.taskId === right.taskId

export type DispatchBlockCode = 'execution-disabled' | 'shutdown' | 'project-unavailable' | 'paused' | 'team-unavailable'
  | 'task-unavailable' | 'task-not-pending' | 'task-owned' | 'dependencies' | 'global-capacity' | 'project-capacity'
  | 'cancelled' | 'pacing' | 'execution-failure' | 'awaiting-acceptance' | 'recovery-required' | 'workspace-batch-dependency' | 'provider-admission'
export interface DispatchStatus extends DispatchRequest {
  readonly state: 'ready' | 'waiting' | 'assigned' | 'finished' | 'cancelled' | 'accepted'
  readonly blockers: { code: DispatchBlockCode; detail: string }[]
  readonly attemptId?: string
  readonly nextDispatchAt?: number
}

export class CoordinatorExecution {
  private readonly runtime: DshAssignmentRuntime
  private readonly external: ExternalNonCodeAssignmentAdapter | undefined
  private readonly externalStore: ExternalRuntimeStore | undefined
  private readonly dshHealth: DshHealthRuntimeObserver | undefined
  private readonly handles = new Map<string, AgentHandle>()
  private readonly roots = new Map<string, Agent>()
  private readonly removePolicy: () => void
  private closing: Promise<void> | undefined
  private shutdownRequested = false
  /** Coordinator-owned cross-project gate; no model input can loosen it. */
  private workspaceBatchBlocker: ((work: { projectId: string; teamId: string; taskId: string }) => string | undefined) | undefined

  private constructor(
    private readonly ctx: Context,
    private readonly config: z.output<typeof executionConfigSchema> | undefined,
    private readonly projects: () => ProjectRecord[],
    private readonly assignments: AssignmentStore,
    private readonly queue: DispatchQueue,
    private readonly submissions: SubmissionStore,
    private readonly reports: ReportStore,
    private readonly retention: CandidateRetentionStore,
    private readonly failures: DurableJournal<ExecutionBlock[], { type: 'work/blocked'; block: ExecutionBlock }>,
    private readonly health: HealthStore | undefined,
    external: ExternalNonCodeAssignmentAdapter | undefined,
    externalStore: ExternalRuntimeStore | undefined,
  ) {
    this.runtime = new DshAssignmentRuntime(ctx, assignments, 30_000, true)
    this.dshHealth = health === undefined ? undefined : new DshHealthRuntimeObserver(ctx)
    this.external = external
    this.externalStore = externalStore
    this.removePolicy = ctx.agentTeams.registerExecutionPolicy({
      taskMutation: (_caller, root) => {
        if (this.projects().some(project => project.teamIds.includes(root.id))) {
          throw new TeamError('Managed work requires coordinator acceptance operations; a worker report cannot complete the task', 'TEAM_MANAGED_TASK')
        }
      },
      acceptance: (root, request) => {
        const submission = this.submissions.list().find(record => record.id === request.submissionId)
        if (!submission || submission.teamId !== root.id || submission.taskId !== request.taskId || submission.integrationId !== request.integrationId || submission.phase === 'pending') return false
        const project = this.projects().find(project => project.id === submission.projectId && project.teamIds.includes(root.id))
        const attempt = this.assignments.list().findLast(record => sameWork(record, submission))
        const job = this.ctx.agentTeams.listIntegrations(root).find(job => job.id === submission.integrationId)
        return !!(project !== undefined && attempt?.attemptId === submission.attemptId && attempt.phase === 'terminal' && !attempt.stopReason
          && !this.queue.list().some(request => sameWork(request, submission) && request.cancelReason !== undefined)
          && (job?.memberId === submission.runtimeId || (attempt !== undefined && this.external?.isCodeAssignment(attempt) && job?.externalOwner?.runtimeId === submission.runtimeId)) && job.sourceCommit === submission.sourceCommit
          && job.repository === submission.repository && job.targetBranch === submission.targetBranch
          && isDeepStrictEqual(job.verification, submission.verification.commands)
          && isDeepStrictEqual(project.verification, submission.verification))
      },
      reportAcceptance: (root, request) => {
        const report = this.reports.list().find(record => record.id === request.reportId)
        if (!report || report.teamId !== root.id || report.taskId !== request.taskId) return false
        const project = this.projects().find(project => project.id === report.projectId && project.teamIds.includes(root.id))
        const attempt = this.assignments.list().findLast(record => sameWork(record, report))
        let task
        try { task = this.ctx.agentTeams.getTask(root, TeamTaskId(report.taskId)) } catch { return false }
        return project !== undefined && attempt?.attemptId === report.attemptId && attempt.generation === report.generation
          && attempt.revision === report.expectedRevision && attempt.phase === 'terminal' && attempt.stopEvidence?.kind === 'stopped' && !attempt.stopReason && attempt.result === report.report
          && task.nonCodeCriteria === report.criteria && (task.revision === report.expectedTaskRevision || (task.status === 'completed' && task.result === JSON.stringify({ reportId: report.id })))
          && !this.queue.list().some(request => sameWork(request, report) && request.cancelReason !== undefined)
      },
      integrationApproval: (root, receipt) => this.acceptedWorkflowReview(root, receipt),
      wake: (_root, targetId) => {
        const record = this.assignments.list().find(record => record.runtimeId === targetId)
        if (record !== undefined && this.queue.list().some(request => sameWork(request, record) && request.cancelReason !== undefined)) throw new TeamError('Cancelled work cannot be woken', 'TEAM_ATTEMPT_FENCED')
        if (record !== undefined && this.shutdownRequested) throw new TeamError('Coordinator shutdown fences managed wakeups', 'TEAM_ATTEMPT_FENCED')
        if (record !== undefined && record.phase !== 'active') throw new TeamError('Attempt is fenced from further wakeups', 'TEAM_ATTEMPT_FENCED')
      },
    })
  }

  static async open(ctx: Context, directory: string, config: ExecutionConfig | undefined, projects: () => ProjectRecord[]): Promise<CoordinatorExecution> {
    const validated = config === undefined ? undefined : executionConfigSchema.parse(config)
    if (validated !== undefined && !ctx.agentTeams.worktreesEnabled) throw new Error('Coordinator execution requires isolated Team worktrees')
    const assignments = await AssignmentStore.open(directory, {
      globalCapacity: validated?.maxConcurrent ?? 8, projectCapacities: Object.fromEntries(projects().map(project => [project.id, project.capacity])),
    })
    try {
      const failures = await DurableJournal.open<ExecutionBlock[], { type: 'work/blocked'; block: ExecutionBlock }>(join(directory, 'execution.jsonl'), [], (state, raw) => {
        const { block } = blockedEvent.parse(raw)
        return [...state.filter(existing => !sameWork(existing, block)), block]
      })
      try {
        const queue = await DispatchQueue.open(directory)
        try {
          const submissions = await SubmissionStore.open(directory)
          try {
            const reports = await ReportStore.open(directory)
            try {
              let retention: CandidateRetentionStore | undefined
              try {
                retention = await CandidateRetentionStore.open(directory)
                await retention.recoverInterrupted()
                let health: HealthStore | undefined
                try {
                  health = validated?.health === undefined ? undefined : await HealthStore.open(directory, validated.health)
                  const retainedExternal = assignments.list().filter(record => record.provider === 'external' && record.phase !== 'terminal')
                  let externalStore: ExternalRuntimeStore | undefined
                  try {
                    let external: ExternalNonCodeAssignmentAdapter | undefined
                    const recoveryPolicy = () => {
                      const first = retainedExternal[0]?.externalPolicy
                      if (first === undefined || retainedExternal.some(record => record.externalPolicy === undefined || JSON.stringify(record.externalPolicy) !== JSON.stringify(first))) {
                        throw new Error('Retained external assignments lack one immutable provider policy; manual recovery is required')
                      }
                      return first
                    }
                    const recoveryAdapter = async () => {
                      externalStore ??= await ExternalRuntimeStore.open(directory)
                      return new ExternalNonCodeAssignmentAdapter(assignments, externalStore, new ExternalAssignmentRuntime(externalStore), recoveryPolicy(), false)
                    }
                    if (validated?.externalCodex !== undefined) {
                      try {
                        const configured = validated.externalCodex
                        const project = projects().find(candidate => candidate.id === configured.projectId)
                        if (project === undefined) throw new Error('External provider policy selects an unregistered project')
                        const cwd = await realpath(configured.cwd)
                        if (cwd !== await realpath(project.repository)) throw new Error('External provider cwd must canonically match its selected project repository')
                        const providerDirectory = await realpath(configured.directory).catch(() => resolve(configured.directory))
                        if (providerDirectory !== configured.directory || !providerDirectory.startsWith('/')) throw new Error('External provider directory must be canonical and absolute')
                        const configuredWorktreeDirectory = configured.codeWorktreeDirectory
                        const codeWorktreeDirectory = configuredWorktreeDirectory === undefined ? undefined : await realpath(configuredWorktreeDirectory).catch(() => resolve(configuredWorktreeDirectory))
                        if (codeWorktreeDirectory !== undefined && (codeWorktreeDirectory !== configured.codeWorktreeDirectory || !codeWorktreeDirectory.startsWith('/') || codeWorktreeDirectory === cwd || codeWorktreeDirectory.startsWith(`${cwd}/`))) {
                          throw new Error('External code worktree directory must be canonical, absolute, and outside its project repository')
                        }
                        const admission = (await admitCodex({
                          config: { executable: configured.executable, version: configured.version, model: configured.model, sandbox: configured.sandbox },
                          policy: { executable: configured.executable, version: configured.version, executableVerification: 'configured-unverified', cwd, model: configured.model, sandbox: configured.sandbox },
                          maxOutputBytes: configured.admissionMaxOutputBytes, timeoutMs: configured.admissionTimeoutMs,
                        })).policy
                        externalStore = await ExternalRuntimeStore.open(directory)
                        const configuredExternal = new ExternalNonCodeAssignmentAdapter(assignments, externalStore, new ExternalAssignmentRuntime(externalStore), {
                          projectId: configured.projectId, directory: providerDirectory, ...(codeWorktreeDirectory === undefined ? {} : { codeWorktreeDirectory }), admission, maxSpoolBytes: configured.maxSpoolBytes, terminateGraceMs: configured.terminateGraceMs,
                        })
                        if (retainedExternal.some(record => !configuredExternal.matchesReservation(record))) throw new Error('Configured external provider does not match a retained immutable assignment policy; manual recovery is required')
                        external = configuredExternal
                      } catch (error) {
                        if (retainedExternal.length === 0) throw error
                        // Read-only recovery does not probe auth or launch a new turn. It
                        // retains the immutable policy solely to observe/cancel its live helper.
                        external = await recoveryAdapter()
                      }
                    } else if (retainedExternal.length > 0) {
                      external = await recoveryAdapter()
                    }
                    return new CoordinatorExecution(ctx, validated, projects, assignments, queue, submissions, reports, retention, failures, health, external, externalStore)
                  } catch (error) { await externalStore?.close(); throw error }
                } catch (error) { await health?.close(); throw error }
              } catch (error) { await retention?.close(); throw error }
            } catch (error) { await reports.close(); throw error }
          } catch (error) { await submissions.close(); throw error }
        } catch (error) { await queue.close(); throw error }
      } catch (error) { await failures.close(); throw error }
    } catch (error) { await assignments.close(); throw error }
  }

  view(views: readonly CoordinatorProjectView[]): { attempts: AttemptRecord[]; executionBlocks: ExecutionBlock[]; dispatchRequests: DispatchRequest[]; dispatchStatus: DispatchStatus[]; submissions: SubmissionRecord[]; reports: ReportAcceptanceRecord[]; candidateRetention: CandidateRetentionRecord[]; health: AttemptHealth[]; escalations: OperatorEscalation[] } {
    const now = Date.now()
    return { submissions: this.submissions.list(), reports: this.reports.list(), attempts: this.assignments.list(), executionBlocks: this.failures.snapshot(), dispatchRequests: this.queue.list(), candidateRetention: this.retention.list(),
      dispatchStatus: this.queue.list().map(request => this.status(request, views, now)), health: this.health?.listHealth() ?? [], escalations: this.health?.listEscalations() ?? [] }
  }

  /** Install the coordinator's authoritative batch dependency gate. */
  setWorkspaceBatchBlocker(blocker: (work: { projectId: string; teamId: string; taskId: string }) => string | undefined): void {
    this.workspaceBatchBlocker = blocker
  }

  /** Reopen the exact registered Lead for a durable host admission. */
  async admittedLead(project: ProjectRecord, teamId: string): Promise<Agent> { return await this.leadFor(project, teamId) }

  healthInbox(projectId: string, teamId: string): OperatorEscalation[] {
    return this.health?.listEscalations().filter(item => item.work.projectId === projectId && item.work.teamId === teamId) ?? []
  }

  acknowledgeHealth(id: string, expectedRevision: number, actor: string): Promise<OperatorEscalation> {
    if (!this.health) throw new Error('Coordinator health is disabled')
    return this.health.acknowledge(id, expectedRevision, actor, Date.now())
  }

  /** Shared read-only ReportStore handle; WorkspaceCoordinator owns the single writer lifecycle. */
  reportStore(): ReportStore { return this.reports }

  /** Materialize one workflow task through the Team log's stable host-only admission key. */
  async createPinnedWorkflowTask(intent: WorkflowTaskCreateIntent): Promise<{ taskId: string }> {
    if (this.shutdownRequested) throw new Error('Coordinator execution is closed')
    const project = this.projects().find(project => project.id === intent.projectId && project.teamIds.includes(intent.teamId))
    if (!project) throw new Error('Workflow task escapes its registered project Lead')
    const lead = await this.leadFor(project, intent.teamId)
    const task = await this.ctx.agentTeams.createPinnedTask(lead, {
      admissionKey: intent.intentId, subject: intent.subject, description: intent.description, nonCodeCriteria: intent.nonCodeCriteria,
      workflowBinding: { executionId: intent.executionId, stepId: intent.stepId, inputs: intent.inputs ?? [] },
      ...(intent.review === undefined ? {} : { reviewBinding: { projectId: intent.projectId, teamId: intent.teamId, executionId: intent.executionId,
        candidateRound: intent.candidateRound ?? 0, ...intent.review } }),
    })
    return { taskId: task.id }
  }

  async createPinnedWorkflowCodeTask(intent: WorkflowCodeTaskCreateIntent): Promise<{ taskId: string }> {
    if (this.shutdownRequested) throw new Error('Coordinator execution is closed')
    const project = this.projects().find(project => project.id === intent.projectId && project.teamIds.includes(intent.teamId))
    if (!project) throw new Error('Workflow code task escapes its registered project Lead')
    const lead = await this.leadFor(project, intent.teamId)
    const task = await this.ctx.agentTeams.createPinnedTask(lead, { admissionKey: intent.intentId, subject: intent.subject, description: intent.description, reviewGate: intent.reviewGate,
      workflowBinding: { executionId: intent.executionId, stepId: intent.stepId, inputs: intent.inputs ?? [] } })
    return { taskId: task.id }
  }

  async workflowCodeStatus(intent: WorkflowCodeTaskCreateIntent): Promise<WorkflowCodeStatus | undefined> {
    const taskId = `workflow-${intent.intentId}`
    const attempts = this.assignments.list().filter(item => item.projectId === intent.projectId && item.teamId === intent.teamId && item.taskId === taskId)
    const latest = attempts.at(-1)
    if (!latest) return undefined
    const submissions = this.submissions.list()
    const exactSubmission = (attempt: AttemptRecord, submission: SubmissionRecord | undefined): SubmissionRecord | undefined => {
      if (!submission || submission.projectId !== intent.projectId || submission.teamId !== intent.teamId || submission.taskId !== taskId
        || submission.attemptId !== attempt.attemptId || submission.generation !== attempt.generation || submission.reviewGate !== intent.reviewGate) return undefined
      return submission
    }
    let sourceAttempt = latest
    let submission = exactSubmission(latest, submissions.find(item => item.attemptId === latest.attemptId))
    const reverse: { attempt: AttemptRecord; submission: SubmissionRecord; repair?: AttemptRecord['repair'] }[] = []
    if (submission) reverse.push({ attempt: latest, submission, repair: latest.repair })

    // Walk only the reducer-validated immediate repair chain.  This retains
    // every source round when a restart missed one or more submission scans;
    // it never chooses an unrelated older submission by task ID.
    while (sourceAttempt.repair) {
      const repair = sourceAttempt.repair
      const predecessor = attempts.find(item => item.attemptId === repair.previousAttemptId)
      if (!predecessor) return undefined
      const predecessorSubmission = exactSubmission(predecessor, submissions.find(item => item.id === repair.submissionId))
      if (!predecessorSubmission || predecessorSubmission.integrationId !== repair.integrationId || predecessorSubmission.sourceCommit !== repair.sourceCommit) return undefined
      sourceAttempt = predecessor
      reverse.push({ attempt: predecessor, submission: predecessorSubmission })
    }
    if (!reverse.length) return undefined
    const lineage = reverse.reverse().map((entry, index) => ({ sourceCommit: entry.submission.sourceCommit, submissionId: entry.submission.id, integrationId: entry.submission.integrationId,
      ...(index === 0 ? {} : { repair: { previousAttemptId: entry.attempt.repair!.previousAttemptId, submissionId: entry.attempt.repair!.submissionId,
        sourceCommit: entry.attempt.repair!.sourceCommit, round: entry.attempt.repair!.round, budget: entry.attempt.repairLimit ?? 0 } }) }))
    const current = reverse.at(-1)!
    submission = current.submission
    const project = this.projects().find(item => item.id === intent.projectId && item.teamIds.includes(intent.teamId))
    if (!project) return undefined
    const lead = await this.leadFor(project, intent.teamId)
    const job = this.ctx.agentTeams.listIntegrations(lead).find(item => item.id === submission.integrationId)
    // A rework is actionable only after the replacement submission exists.
    // The full lineage still includes original submissions during a gap between
    // reservation and replacement submission, so the runtime pins source first.
    const repair = current.attempt === latest ? latest.repair : undefined
    return { sourceCommit: submission.sourceCommit, submissionId: submission.id, integrationId: submission.integrationId, sourceLineage: lineage,
      ...(job === undefined ? { phase: submission.phase === 'pending' ? 'pending' as const : 'queued' as const } : { phase: job.phase,
        ...(job.targetCommit === undefined ? {} : { targetCommit: job.targetCommit }), ...(job.candidateCommit === undefined ? {} : { candidateCommit: job.candidateCommit }),
        ...(job.reviewGate === undefined ? {} : { reviewGate: job.reviewGate }), ...(job.reviewReceipt?.reviewId === undefined ? {} : { reviewId: job.reviewReceipt.reviewId }),
        ...(job.previousCandidates === undefined ? {} : { previousCandidates: job.previousCandidates.map(candidate => candidate.candidateCommit) }), ...(job.error === undefined ? {} : { diagnostic: job.error }),
        ...(repair === undefined ? {} : { repair: { previousAttemptId: repair.previousAttemptId, submissionId: repair.submissionId, sourceCommit: repair.sourceCommit, round: repair.round, budget: latest.repairLimit ?? 0 } }) }) }
  }

  async approveWorkflowIntegration(receipt: WorkflowIntegrationApproval): Promise<void> {
    const report = this.reports.list().find(item => item.id === receipt.reviewId && item.phase === 'accepted')
    if (!report || report.decision !== 'approved' || report.reviewBinding === undefined) {
      throw new Error('Workflow integration approval requires an explicitly approved pinned reviewer report')
    }
    const project = this.projects().find(item => item.id === report.projectId && item.teamIds.includes(report.teamId))
    if (!project) throw new Error('Workflow integration approval project is absent')
    const lead = await this.leadFor(project, report.teamId)
    const task = this.ctx.agentTeams.getTask(lead, TeamTaskId(report.taskId))
    const binding = task.reviewBinding
    if (!binding || !isDeepStrictEqual(binding, report.reviewBinding) || binding.projectId !== report.projectId || binding.teamId !== report.teamId || binding.executionId !== receipt.executionId
      || binding.candidateRound < 0 || binding.integrationId !== receipt.integrationId || binding.sourceCommit !== receipt.sourceCommit
      || binding.targetCommit !== receipt.targetCommit || binding.candidateCommit !== receipt.candidateCommit || binding.reviewGate !== receipt.reviewGate) {
      throw new Error('Workflow integration approval does not match the accepted pinned reviewer task')
    }
    const pinned: TeamIntegrationReviewReceipt = { integrationId: receipt.integrationId as TeamIntegrationReviewReceipt['integrationId'],
      sourceCommit: receipt.sourceCommit as TeamIntegrationReviewReceipt['sourceCommit'], targetCommit: receipt.targetCommit as TeamIntegrationReviewReceipt['targetCommit'],
      candidateCommit: receipt.candidateCommit as TeamIntegrationReviewReceipt['candidateCommit'], reviewGate: receipt.reviewGate, reviewId: receipt.reviewId }
    await this.ctx.agentTeams.approvePinnedIntegration(lead, pinned, new AbortController().signal)
  }

  private acceptedWorkflowReview(root: Agent, receipt: TeamIntegrationReviewReceipt): boolean {
    const report = this.reports.list().find(item => item.id === receipt.reviewId && item.phase === 'accepted' && item.teamId === root.id)
    if (!report || report.decision !== 'approved' || report.reviewBinding === undefined) return false
    let task
    try { task = this.ctx.agentTeams.getTask(root, TeamTaskId(report.taskId)) } catch { return false }
    const binding = task.reviewBinding
    return binding !== undefined && isDeepStrictEqual(binding, report.reviewBinding) && binding.projectId === report.projectId && binding.teamId === report.teamId && binding.executionId.length > 0
      && binding.integrationId === receipt.integrationId && binding.sourceCommit === receipt.sourceCommit && binding.targetCommit === receipt.targetCommit
      && binding.candidateCommit === receipt.candidateCommit && binding.reviewGate === receipt.reviewGate
  }

  private status(request: DispatchRequest, views: readonly CoordinatorProjectView[], now: number): DispatchStatus {
    const records = this.assignments.list()
    const attempt = records.findLast(record => sameWork(record, request))
    const failure = this.failures.snapshot().find(block => sameWork(block, request))
    const blockers: DispatchStatus['blockers'] = []
    const block = (code: DispatchBlockCode, detail: string) => { blockers.push({ code, detail }) }
    const repair = attempt ? this.repairFor(attempt) : undefined
    if (failure && !repair) block('execution-failure', failure.diagnostic)
    if (request.cancelReason !== undefined) block('cancelled', request.cancelReason)
    if (attempt) {
      if (this.submissions.list().some(submission => submission.attemptId === attempt.attemptId && submission.phase === 'accepted')
        || this.reports.list().some(report => report.attemptId === attempt.attemptId && report.phase === 'accepted')) return { ...request, state: 'accepted', attemptId: attempt.attemptId, blockers: [] }
      const interruptionExhausted = attempt.interruption !== undefined && attempt.interruption.count >= (attempt.repairLimit ?? 0)
      if (interruptionExhausted) block('recovery-required', `Coordinator interruption retry budget exhausted (${attempt.repairLimit ?? 0})`)
      if (!repair && attempt.interruption === undefined && attempt.phase === 'terminal' && request.cancelReason === undefined) block(attempt.result && !attempt.stopReason && !failure ? 'awaiting-acceptance' : 'recovery-required',
        failure?.diagnostic ?? (attempt.result && !attempt.stopReason ? 'Worker report awaits verified task acceptance' : attempt.stopReason ?? 'Attempt stopped; explicit recovery is required'))
      if ((!repair && attempt.interruption === undefined) || interruptionExhausted) return { ...request, state: attempt.phase === 'terminal' ? request.cancelReason === undefined ? 'finished' : 'cancelled' : 'assigned', attemptId: attempt.attemptId, blockers }
    }
    if (this.shutdownRequested) block('shutdown', 'Coordinator shutdown has started')
    if (!this.config) block('execution-disabled', 'Coordinator execution is disabled')
    const view = views.find(view => view.project.id === request.projectId)
    const team = view?.teams.find(team => team.teamId === request.teamId)
    const task = team?.tasks.find(task => task.id === request.taskId)
    if (!view) block('project-unavailable', 'Registered project is unavailable')
    else if (view.paused) block('paused', 'Project dispatch is paused')
    if (!team || team.status !== 'available') block('team-unavailable', team?.diagnostic || 'Team state is unavailable')
    else if (!task) block('task-unavailable', 'Task is absent from current Team state')
    else {
      if (task.status !== 'pending') block('task-not-pending', `Task status is ${task.status}`)
      if (task.ownerId !== undefined) block('task-owned', `Task is owned by ${task.ownerId}`)
      const blockedBy = task.blockedBy.filter(id => team.tasks.find(task => task.id === id)?.status !== 'completed')
      if (blockedBy.length) block('dependencies', `Prerequisites require acceptance: ${blockedBy.join(', ')}`)
      if (this.external?.ownsTask(request.projectId, task.nonCodeCriteria !== undefined) && !this.external.canStartProject(request.projectId)) {
        block('provider-admission', 'External provider is in recovery-only mode; restore its immutable admitted policy before launching new selected-project work')
      }
    }
    const workspaceBatchBlocker = this.workspaceBatchBlocker?.(request)
    if (workspaceBatchBlocker !== undefined) block('workspace-batch-dependency', workspaceBatchBlocker)
    const active = records.filter(record => record.phase !== 'terminal')
    if (this.config && active.length >= this.config.maxConcurrent) block('global-capacity', 'Global active capacity is full')
    if (view && active.filter(record => record.projectId === request.projectId).length >= view.project.capacity) block('project-capacity', 'Project active capacity is full')
    const next = this.queue.nextDispatchAt(this.config?.dispatchIntervalMs ?? 0)
    if (next !== undefined && now < next) block('pacing', `Next dispatch cannot precede ${next} milliseconds since epoch`)
    return { ...request, ...(attempt ? { attemptId: attempt.attemptId } : {}), state: request.cancelReason !== undefined ? 'cancelled' : blockers.length ? 'waiting' : 'ready', blockers, ...(next === undefined ? {} : { nextDispatchAt: next }) }
  }

  async scan(views: readonly CoordinatorProjectView[]): Promise<void> {
    if (this.shutdownRequested) throw new Error('Coordinator execution is closed')
    // Enqueue before eligibility checks so blocked/paused work retains its original order.
    for (const view of views) for (const team of view.teams) for (const task of team.tasks) {
      if (task.status === 'pending') await this.queue.enqueue({ projectId: view.project.id, teamId: team.teamId, taskId: task.id })
    }
    // Cancellation intent takes precedence over pause or disabled automatic admission.
    for (const record of this.assignments.list()) {
      const cancelled = this.queue.list().find(request => sameWork(request, record) && request.cancelReason !== undefined)
      if (!cancelled || record.phase === 'terminal') continue
      const project = views.find(view => view.project.id === record.projectId)
      if (!project) continue
      try {
        const lead = this.ctx.agents.get(SessionId(record.teamId)) ?? await this.leadFor(project.project, record.teamId)
        await this.cancelAttempt(lead, record, cancelled.cancelReason!)
      } catch (error) { await this.block(record, error) }
    }
    if (this.config === undefined) return
    // A report intent is durable before the Team receipt. Replay it before dispatching
    // dependents, so a crash between those two writes cannot lose acceptance.
    for (const report of this.reports.list()) {
      if (report.phase !== 'pending') continue
      const project = views.find(view => view.project.id === report.projectId)
      if (!project || project.paused) continue
      try { await this.applyReport(await this.leadFor(project.project, report.teamId), report) }
      catch (error) { await this.block(report, error) }
    }
    for (const submission of this.submissions.list()) {
      if (submission.phase !== 'pending') continue
      const project = views.find(view => view.project.id === submission.projectId)
      if (!project || project.paused) continue
      try { await this.queueSubmission(await this.leadFor(project.project, submission.teamId), submission) }
      catch (error) { await this.block(submission, error) }
    }
    this.assignments.configure({ globalCapacity: this.config.maxConcurrent, projectCapacities: Object.fromEntries(this.projects().map(project => [project.id, project.capacity])) })
    for (const record of this.assignments.list()) {
      if (record.phase === 'terminal' || this.queue.list().some(request => sameWork(request, record) && request.cancelReason !== undefined)) continue
      const project = views.find(view => view.project.id === record.projectId)
      if (!project || project.paused) continue
      try {
        const lead = await this.leadFor(project.project, record.teamId)
        if (record.phase === 'reserved') await this.startAttempt(lead, record)
        else await this.observeAttempt(lead, record)
      } catch (error) { await this.block(record, error) }
    }
    if (this.ctx.agentTeams.integrationEnabled) {
      for (const record of this.assignments.list()) {
        if (record.phase !== 'terminal' || !record.result || record.stopReason
          || this.submissions.list().some(submission => submission.attemptId === record.attemptId)
          || this.reports.list().some(report => report.attemptId === record.attemptId)
          || this.queue.list().some(request => sameWork(request, record) && request.cancelReason !== undefined)) continue
        const project = views.find(view => view.project.id === record.projectId)
        if (!project || project.paused) continue
        try {
          const lead = await this.leadFor(project.project, record.teamId)
          const task = this.ctx.agentTeams.getTask(lead, TeamTaskId(record.taskId))
          if (task.nonCodeCriteria !== undefined) continue
          const externalWorktree = record.provider === 'external' ? await this.external?.submissionWorktree(record) : undefined
          const cwd = externalWorktree?.cwd ?? this.ctx.agentTeams.listMembers(lead).find(member => member.id === record.runtimeId && member.name === record.attemptId)?.worktree?.cwd
          if (cwd === undefined) throw new Error('Reported attempt has no ready provider-owned worktree for submission')
          if (externalWorktree !== undefined && externalWorktree.repository !== project.project.repository) throw new Error('External worktree receipt repository does not match the selected project')
          const sourceCommit = await runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], new AbortController().signal, 30_000)
          await this.submit(lead, project.project, { ...token(record), sourceCommit, evidence: record.result })
        } catch (error) { await this.block(record, error) }
      }
      const visited = new Set<string>()
      for (const submission of this.submissions.list()) {
        if (submission.phase !== 'queued' || visited.has(submission.teamId)) continue
        const project = views.find(view => view.project.id === submission.projectId)
        if (!project || project.paused) continue
        visited.add(submission.teamId)
        try {
          const lead = await this.leadFor(project.project, submission.teamId)
          const next = this.ctx.agentTeams.listIntegrations(lead).find(job => job.phase !== 'merged' && job.phase !== 'failed')
          const owner = this.submissions.list().find(record => record.integrationId === next?.id && record.teamId === lead.id)
          if (!next || !owner) continue
          const job = await this.ctx.agentTeams.runIntegration(lead, new AbortController().signal)
          if (job?.phase === 'failed') await this.block(owner, new Error(job.error ?? 'Integration verification failed'))
        } catch (error) { await this.block(submission, error) }
      }
    }
    for (const submission of this.submissions.list()) {
      if (submission.phase !== 'queued') continue
      const project = views.find(view => view.project.id === submission.projectId)
      if (!project || project.paused) continue
      try {
        const lead = await this.leadFor(project.project, submission.teamId)
        const job = this.ctx.agentTeams.listIntegrations(lead).find(job => job.id === submission.integrationId)
        if (job?.phase === 'failed' && job.failureKind === 'verification') {
          const attempt = this.assignments.list().findLast(record => sameWork(record, submission))
          if (attempt?.attemptId === submission.attemptId && (attempt.repair?.round ?? 0) >= (attempt.repairLimit ?? 0)) {
            await this.block(submission, new Error(`Integration repair budget exhausted (${attempt.repairLimit ?? 0} repairs): ${job.error}`))
          }
        }
        if (job?.phase !== 'merged') continue
        const task = this.ctx.agentTeams.getTask(lead, TeamTaskId(submission.taskId))
        await this.ctx.agentTeams.acceptIntegratedTask(lead, { taskId: task.id, expectedRevision: task.revision,
          submissionId: submission.id, integrationId: submission.integrationId as TeamIntegrationId })
        await this.submissions.accepted(submission.id)
      } catch (error) { await this.block(submission, error) }
    }
    await this.scanCandidateRetention(views)
    const attemptedThisScan = new Set<number>()
    while (true) {
      const active = this.assignments.list().filter(record => record.phase !== 'terminal')
      if (active.length >= this.config.maxConcurrent) break
      const work = await this.queue.select(request => {
        if (attemptedThisScan.has(request.order)) return false
        return this.status(request, views, Date.now()).state === 'ready'
      }, Date.now(), this.config.dispatchIntervalMs ?? 0)
      if (!work) break
      attemptedThisScan.add(work.order)
      const view = views.find(view => view.project.id === work.projectId)!
      const task = view.teams.find(team => team.teamId === work.teamId)!.tasks.find(task => task.id === work.taskId)!
      let record: AttemptRecord | undefined
      let startInvoked = false
      try {
        const previous = this.assignments.list().findLast(record => sameWork(record, work))
        const repair = previous ? this.repairFor(previous) : undefined
        if (previous && !repair && previous.interruption === undefined) throw new Error('Previous attempt is not eligible for repair')
        record = await this.assignments.reserve({ projectId: work.projectId, teamId: work.teamId, taskId: work.taskId,
          workerId: randomUUID(), runtimeId: randomUUID(), provider: this.external?.ownsTask(view.project.id, task.nonCodeCriteria !== undefined) ? 'external' : 'spawn', expectedGeneration: previous?.generation ?? 0,
          repairLimit: previous ? previous.repairLimit! : this.config.maxRepairAttempts ?? 3, ...(repair ? { repair } : {}),
          ...(this.external?.ownsTask(view.project.id, task.nonCodeCriteria !== undefined) ? { externalPolicy: this.external.reservationPolicy() } : {}),
          checkpoint: { task: { subject: task.subject, description: task.description,
            ...(task.nonCodeCriteria === undefined ? {} : { nonCodeCriteria: task.nonCodeCriteria }) }, step: repair ? 'repair' : 'implement',
            ...(task.workflowBinding === undefined ? {} : { workflowId: task.workflowBinding.executionId, workflowStep: task.workflowBinding.stepId }),
            artifacts: [...(task.workflowBinding?.inputs.map(input => input.artifact) ?? []), ...(repair ? [{ kind: 'commit' as const, ref: repair.sourceCommit }, { kind: 'file' as const, ref: repair.candidateCwd }] : [])],
            nextAction: repair
              ? 'Repair the failed submission in this new worktree. Inspect the retained candidate and diagnostic; apply the pinned source commit, resolve conflicts against the current target, fix failing checks, commit the repaired artifact, and report evidence. Preserve all previous checkouts.'
              : task.nonCodeCriteria === undefined
                ? 'Perform the task in your isolated worktree, commit code changes, and report artifacts and verification evidence.'
                : `Produce a clear evidence-backed report that satisfies these acceptance criteria: ${task.nonCodeCriteria}. Do not create a Git submission; the Lead must review and explicitly accept the report.` },
        })
        const lead = await this.leadFor(view.project, work.teamId)
        startInvoked = true
        await this.startAttempt(lead, record)
      } catch (error) {
        if (record !== undefined && !startInvoked) await this.assignments.retire(token(record), {
          runtimeId: record.runtimeId, kind: 'never-started', receipt: 'coordinator/pre-start-failure',
        })
        await this.block(work, error)
      }
    }
    await this.scanHealth(views)
  }

  /** Observational mapping only: no health result can wake, stop, or replace an assignment. */
  private async scanHealth(views: readonly CoordinatorProjectView[]): Promise<void> {
    if (!this.health) return
    const now = Date.now()
    for (const existing of this.health.listHealth()) {
      const report = this.reports.list().find(item => item.attemptId === existing.attemptId && item.generation === existing.generation && item.projectId === existing.work.projectId && item.teamId === existing.work.teamId && item.taskId === existing.work.taskId && item.phase === 'accepted')
      const submission = this.submissions.list().find(item => item.attemptId === existing.attemptId && item.generation === existing.generation && item.projectId === existing.work.projectId && item.teamId === existing.work.teamId && item.taskId === existing.work.taskId && item.phase === 'accepted')
      if (report) await this.health.clearAcceptedAttempt(existing.attemptId, existing.generation, 'accepted-report', report.id, now)
      else if (submission) await this.health.clearAcceptedAttempt(existing.attemptId, existing.generation, 'accepted-submission', submission.id, now)
    }
    for (const attempt of this.assignments.list()) {
      const project = views.find(view => view.project.id === attempt.projectId)
      const team = project?.teams.find(team => team.teamId === attempt.teamId)
      const task = team?.tasks.find(task => task.id === attempt.taskId)
      const report = this.reports.list().find(item => item.attemptId === attempt.attemptId && item.generation === attempt.generation && item.projectId === attempt.projectId && item.teamId === attempt.teamId && item.taskId === attempt.taskId)
      const submission = this.submissions.list().find(item => item.attemptId === attempt.attemptId && item.generation === attempt.generation && item.projectId === attempt.projectId && item.teamId === attempt.teamId && item.taskId === attempt.taskId)
      if (attempt.phase === 'terminal' && (report?.phase === 'accepted' || submission?.phase === 'accepted')) continue
      let state: 'active' | 'dependency-wait' | 'operator-wait' | 'failed' | 'unavailable'
      if (team?.status === 'unavailable' || !task) state = 'unavailable'
      else state = task.blockedBy.some(id => team!.tasks.find(candidate => candidate.id === id)?.status !== 'completed') ? 'dependency-wait' : 'active'
      let execution: 'known-active-operation' | 'idle' | 'waiting' | 'failed' | 'unknown' = 'unknown'
      let diagnostic: string | undefined
      let evidenceRef: string | undefined
      if (attempt.phase === 'terminal') {
        if (attempt.stopReason) {
          // A durable cancellation is intentional and must not be presented as a runtime failure.
          if (this.queue.list().some(request => sameWork(request, attempt) && request.cancelReason !== undefined)) { state = 'operator-wait'; execution = 'idle' }
          else { state = 'failed'; execution = 'failed'; diagnostic = attempt.stopReason; evidenceRef = attempt.attemptId }
        }
        else if (task?.nonCodeCriteria !== undefined && attempt.result) { state = 'operator-wait'; execution = 'idle' }
        else if (submission) {
          const lead = this.ctx.agents.get(SessionId(attempt.teamId))
          const integration = lead ? this.ctx.agentTeams.listIntegrations(lead).find(item => item.id === submission.integrationId) : undefined
          if (integration?.phase === 'failed') { state = 'failed'; execution = 'failed'; diagnostic = `Integration ${integration.id}: ${integration.error ?? 'verification failed'}`.slice(0, 16_384); evidenceRef = integration.id }
          else if (integration) { state = 'dependency-wait'; execution = 'waiting' }
          else state = 'unavailable'
        }
      }
      const provider = ['spawn', 'fork'].includes(attempt.provider) ? 'dsh' : attempt.provider === 'external' ? 'external' : 'unknown'
      // An external attempt's runtimeId is an assignment identity, never a
      // SessionId. Do not let a coincident DSH session manufacture external
      // liveness or progress; only its supervised store/observer may do that.
      const dshOperation = provider === 'dsh' ? this.dshHealth?.observe({ attemptId: attempt.attemptId, teamId: attempt.teamId, runtimeId: attempt.runtimeId }) : undefined
      // Fresh read-only supervisor observation is required; historical process
      // identities in the journal cannot prove that an external effect remains live.
      const externalOperation = provider === 'external' ? await this.external?.health(attempt) : undefined
      await this.health.assess({ attemptId: attempt.attemptId, generation: attempt.generation, provider,
        work: { projectId: attempt.projectId, teamId: attempt.teamId, taskId: attempt.taskId, state },
        // A resident session and its sequence are evidence of life, not evidence that a tool is active.
        runtime: execution !== 'unknown' ? { availability: 'available', execution }
          : externalOperation?.execution === 'known-active-operation' ? { availability: 'available', execution: 'known-active-operation' }
            : dshOperation?.availability === 'available'
              ? { availability: 'available', execution: dshOperation.execution }
              : { availability: 'unknown', execution: 'unknown' },
        ...(execution === 'unknown' && dshOperation?.availability === 'available' && dshOperation.execution === 'unknown'
          ? { progress: { source: 'session-sequence' as const, cursor: dshOperation.cursor } } : {}),
        ...(diagnostic === undefined ? {} : { diagnostic }), ...(evidenceRef === undefined ? {} : { evidenceRef }),
      }, now)
    }
  }

  private repairFor(attempt: AttemptRecord): AttemptRecord['repair'] | undefined {
    if (attempt.phase !== 'terminal' || attempt.stopEvidence?.kind !== 'stopped' || attempt.stopReason || !attempt.result
      || (attempt.repair?.round ?? 0) >= (attempt.repairLimit ?? 0)) return undefined
    const submission = this.submissions.list().find(record => record.attemptId === attempt.attemptId && record.phase === 'queued')
    const lead = this.ctx.agents.get(SessionId(attempt.teamId))
    if (!submission || !lead) return undefined
    const job = this.ctx.agentTeams.listIntegrations(lead).find(job => job.id === submission.integrationId)
    if (job?.phase !== 'failed' || job.failureKind !== 'verification') return undefined
    return { previousAttemptId: attempt.attemptId, submissionId: submission.id, integrationId: submission.integrationId,
      sourceCommit: submission.sourceCommit, candidateCwd: job.cwd, diagnostic: (job.error ?? 'Verification failed').slice(0, 16_384), round: (attempt.repair?.round ?? 0) + 1 }
  }

  async submit(lead: Agent, project: ProjectRecord, request: SubmitRequest): Promise<SubmissionRecord> {
    if (this.shutdownRequested) throw new Error('Coordinator execution is closed')
    const input = submitRequestSchema.parse(request)
    const records = this.assignments.list()
    const attempt = records.find(record => record.attemptId === input.attemptId)
    if (!attempt || attempt.projectId !== project.id || attempt.teamId !== lead.id || attempt.generation !== input.generation || attempt.revision !== input.expectedRevision) throw new Error('Stale or unauthorized submission attempt')
    if (records.findLast(record => sameWork(record, attempt))?.attemptId !== attempt.attemptId) throw new Error('Superseded attempt cannot submit')
    if (attempt.phase !== 'terminal' || attempt.stopEvidence?.kind !== 'stopped' || attempt.stopReason) throw new Error('Submission requires a quiescent reported attempt')
    if (!attempt.result || this.queue.list().some(request => sameWork(request, attempt) && request.cancelReason !== undefined)) throw new Error('Cancelled or unreported attempt cannot submit')
    const task = this.ctx.agentTeams.getTask(lead, TeamTaskId(attempt.taskId))
    if (task.nonCodeCriteria !== undefined) throw new Error('non-code work requires explicit report acceptance, not Git submission')
    if (input.reviewGate !== undefined && input.reviewGate !== task.reviewGate) throw new Error('Submission review gate disagrees with the immutable task gate')
    const submission = await this.submissions.submit({ ...input, projectId: project.id, teamId: lead.id, taskId: attempt.taskId,
      runtimeId: attempt.runtimeId, repository: project.repository, targetBranch: project.targetBranch, verification: project.verification,
      ...(task.reviewGate === undefined ? {} : { reviewGate: task.reviewGate }) })
    try { return await this.queueSubmission(lead, submission) }
    catch (error) { await this.block(submission, error); throw error }
  }

  async acceptReport(lead: Agent, project: ProjectRecord, request: AcceptReportRequest): Promise<ReportAcceptanceRecord> {
    if (this.shutdownRequested) throw new Error('Coordinator execution is closed')
    const input = acceptReportRequestSchema.parse(request)
    const existing = this.reports.list().find(record => record.attemptId === input.attemptId)
    if (existing) {
      if (existing.projectId !== project.id || existing.teamId !== lead.id || existing.generation !== input.generation
        || existing.expectedRevision !== input.expectedRevision || existing.expectedTaskRevision !== input.expectedTaskRevision || existing.rationale !== input.rationale
        || existing.decision !== input.decision) {
        throw new Error('Report acceptance replay has different immutable inputs')
      }
      return existing.phase === 'accepted' ? existing : await this.applyReport(lead, existing)
    }
    const attempt = this.reportAttempt(lead, project, input)
    const task = this.ctx.agentTeams.getTask(lead, TeamTaskId(attempt.taskId))
    if ((task.reviewBinding === undefined) !== (input.decision === undefined)) {
      throw new Error(task.reviewBinding === undefined
        ? 'Only a pinned candidate-review task accepts a review decision'
        : 'Pinned candidate-review acceptance requires an explicit approved or rejected decision')
    }
    const report = await this.reports.record({ ...input, projectId: project.id, teamId: lead.id, taskId: attempt.taskId,
      report: attempt.result!, criteria: task.nonCodeCriteria!, reviewerId: lead.id,
      ...(task.reviewBinding === undefined ? {} : { reviewBinding: task.reviewBinding }) })
    return await this.applyReport(lead, report)
  }

  private reportAttempt(lead: Agent, project: ProjectRecord, input: AcceptReportRequest): AttemptRecord {
    const records = this.assignments.list()
    const attempt = records.find(record => record.attemptId === input.attemptId)
    if (!attempt || attempt.projectId !== project.id || attempt.teamId !== lead.id || attempt.generation !== input.generation || attempt.revision !== input.expectedRevision) throw new Error('Stale or unauthorized report attempt')
    if (records.findLast(record => sameWork(record, attempt))?.attemptId !== attempt.attemptId) throw new Error('Superseded attempt cannot be accepted')
    if (attempt.phase !== 'terminal' || attempt.stopEvidence?.kind !== 'stopped' || attempt.stopReason || !attempt.result) throw new Error('Report acceptance requires a quiescent reported attempt')
    if (this.queue.list().some(request => sameWork(request, attempt) && request.cancelReason !== undefined)) throw new Error('Cancelled attempt cannot be accepted')
    const task = this.ctx.agentTeams.getTask(lead, TeamTaskId(attempt.taskId))
    if (task.nonCodeCriteria === undefined) throw new Error('Code work requires verified Git submission')
    const receipt = JSON.stringify({ reportId: this.reports.list().find(report => report.attemptId === attempt.attemptId)?.id })
    if (task.status === 'completed' && task.result === receipt) return attempt
    if (task.revision !== input.expectedTaskRevision || task.status !== 'pending') throw new Error('Stale task revision for report acceptance')
    return attempt
  }

  private async applyReport(lead: Agent, report: ReportAcceptanceRecord): Promise<ReportAcceptanceRecord> {
    if (report.phase === 'accepted') return report
    const project = this.projects().find(project => project.id === report.projectId && project.teamIds.includes(lead.id))
    if (!project) throw new Error('Report project is no longer registered for this Lead')
    this.reportAttempt(lead, project, report)
    // The Team service re-flushes an idempotent matching receipt. Never infer
    // durability merely because the projection already contains the event.
    await this.ctx.agentTeams.acceptReportedTask(lead, { taskId: TeamTaskId(report.taskId), expectedRevision: report.expectedTaskRevision, reportId: report.id })
    return await this.reports.accepted(report.id)
  }

  private async queueSubmission(lead: Agent, submission: SubmissionRecord): Promise<SubmissionRecord> {
    const attempt = this.assignments.list().findLast(record => sameWork(record, submission))
    if (!attempt || attempt.attemptId !== submission.attemptId || attempt.generation !== submission.generation
      || attempt.revision !== submission.expectedRevision || attempt.phase !== 'terminal' || attempt.stopReason) throw new Error('Submission attempt is stale or no longer eligible')
    if (this.queue.list().some(request => sameWork(request, submission) && request.cancelReason !== undefined)) throw new Error('Cancelled submission cannot enter integration')
    const admission = { id: submission.integrationId, sourceCommit: submission.sourceCommit, repository: submission.repository,
      targetBranch: submission.targetBranch, verification: submission.verification.commands,
      ...(submission.reviewGate === undefined ? {} : { reviewGate: submission.reviewGate }) } as TeamIntegrationAdmission
    if (attempt.provider === 'external') {
      const receipt = await this.external?.submissionWorktree(attempt)
      if (receipt === undefined) throw new Error('External submission has no explicit provider-owned worktree capability')
      const external: TeamExternalIntegrationWorktree = { runtimeId: attempt.runtimeId, repository: receipt.repository, cwd: receipt.cwd,
        branch: receipt.branch as TeamExternalIntegrationWorktree['branch'], baseCommit: receipt.baseCommit as TeamExternalIntegrationWorktree['baseCommit'] }
      await this.ctx.agentTeams.enqueueExternalPinnedIntegration(lead, external, admission, new AbortController().signal)
    } else await this.ctx.agentTeams.enqueuePinnedIntegration(lead, submission.attemptId, admission, new AbortController().signal)
    return this.submissions.queued(submission.id)
  }

  /**
   * The current merged integration candidate is the only cleanup target. Failed
   * and superseded candidates deliberately have no retention intent. A legacy
   * merged job has no merge timestamp, so first coordinator observation is its
   * eligibility time and pins the configured deadline in this separate journal.
   */
  private async scanCandidateRetention(views: readonly CoordinatorProjectView[]): Promise<void> {
    const retention = this.config?.candidateRetention
    if (!retention) return
    const now = Date.now()
    for (const submission of this.submissions.list()) {
      if (submission.phase !== 'accepted') continue
      const project = views.find(view => view.project.id === submission.projectId)
      if (!project) continue
      try {
        const lead = await this.leadFor(project.project, submission.teamId)
        const job = this.ctx.agentTeams.listIntegrations(lead).find(job => job.id === submission.integrationId)
        if (job?.phase !== 'merged' || !job.candidateCommit) continue
        const deadline = now > Number.MAX_SAFE_INTEGER - retention.delayMs ? Number.MAX_SAFE_INTEGER : now + retention.delayMs
        await this.retention.enqueue({ submissionId: submission.id, integrationId: submission.integrationId, repository: job.repository,
          targetBranch: job.targetBranch, cwd: job.cwd, candidateCommit: job.candidateCommit, eligibleAt: now, deadline,
          commandTimeoutMs: retention.commandTimeoutMs })
      } catch (error) {
        await this.block(submission, error)
      }
    }
    for (const record of this.retention.due(now)) {
      const submission = this.submissions.list().find(submission => submission.id === record.submissionId)
      const project = submission === undefined ? undefined : views.find(view => view.project.id === submission.projectId)
      // Pausing prevents mutation but preserves the already-pinned deadline and intent for an explicit resume.
      if (!project || project.paused) continue
      await this.cleanupCandidate(record)
    }
  }

  /** A retained or uncertain terminal result is never retried by ordinary scans. */
  private async cleanupCandidate(record: CandidateRetentionRecord): Promise<void> {
    const running = await this.retention.start(record.submissionId)
    if (running.phase !== 'running') return
    try {
      const active = await this.activeCandidateDiagnostic(record)
      if (active) {
        await this.retention.settle(record.submissionId, 'uncertain', active)
        return
      }
      const result = await new GitCandidateCleanup({ repository: record.repository, targetBranch: record.targetBranch,
        cwd: record.cwd, candidateCommit: record.candidateCommit, commandTimeoutMs: record.commandTimeoutMs }).cleanup(new AbortController().signal)
      if (result.outcome === 'removed' || result.outcome === 'absent') await this.retention.settle(record.submissionId, 'released')
      else await this.retention.settle(record.submissionId, 'retained', result.diagnostic ?? 'Candidate cleanup retained an uncertain worktree')
    } catch (error) {
      await this.retention.settle(record.submissionId, 'uncertain', `Candidate cleanup could not establish safe removal: ${error instanceof Error ? error.message : String(error)}`.slice(0, 16_384))
    }
  }

  /**
   * Never remove a path occupied by an Agent-runtime provider process, even if
   * its job record claims completion. This observes only the in-process Agent
   * registry; external provider process discovery belongs to the M9 runtime.
   */
  private async activeCandidateDiagnostic(record: CandidateRetentionRecord): Promise<string | undefined> {
    try {
      let candidate: string
      try { candidate = await realpath(record.cwd) }
      catch (error) { return `Could not canonicalize candidate path before provider inspection: ${error instanceof Error ? error.message : String(error)}`.slice(0, 16_384) }
      for (const agent of this.ctx.agents.list()) {
        const cwd = agent.session.header.cwd
        if (cwd === undefined) continue
        let actual: string
        try { actual = await realpath(cwd) }
        catch (error) { return `Could not canonicalize a live provider working directory: ${error instanceof Error ? error.message : String(error)}`.slice(0, 16_384) }
        if (actual === candidate) return 'Candidate path is the current working directory of a live provider process'
      }
      return undefined
    } catch (error) {
      return `Could not inspect provider process working directories: ${error instanceof Error ? error.message : String(error)}`.slice(0, 16_384)
    }
  }

  private async startAttempt(lead: Agent, record: AttemptRecord): Promise<AttemptRecord> {
    if (record.provider === 'external') {
      if (this.external === undefined) throw new Error('External provider assignment has no admitted external provider policy')
      return await this.external.start(record)
    }
    return await this.runtime.start(lead, token(record))
  }

  private async observeAttempt(lead: Agent, record: AttemptRecord): Promise<AttemptRecord> {
    if (record.provider === 'external') {
      if (this.external === undefined) throw new Error('External provider assignment has no admitted external provider policy')
      return await this.external.observe(record)
    }
    return await this.runtime.observe(lead, token(record))
  }

  private async cancelAttempt(lead: Agent, record: AttemptRecord, reason: string): Promise<AttemptRecord> {
    if (record.provider === 'external') {
      if (this.external === undefined) throw new Error('External provider assignment has no admitted external provider policy')
      return await this.external.cancel(record, reason)
    }
    return await this.runtime.cancel(lead, token(record), reason)
  }

  async cancel(lead: Agent, work: DispatchWork, expectedRevision: number, reason: string): Promise<void> {
    if (this.shutdownRequested) throw new Error('Coordinator execution is closed')
    const submissions = this.submissions.list().filter(submission => sameWork(submission, work))
    if (submissions.some(submission => this.ctx.agentTeams.listIntegrations(lead).some(job => job.id === submission.integrationId && job.phase !== 'failed'))) throw new Error('Work has entered integration; integration cancellation is required')
    if (this.reports.list().some(report => sameWork(report, work))) throw new Error('Work has entered report acceptance; report cancellation is not permitted')
    await this.queue.cancel(work, expectedRevision, reason)
    const record = this.assignments.list().findLast(record => sameWork(record, work))
    if (record && record.phase !== 'terminal') {
      try { await this.cancelAttempt(lead, record, reason) }
      catch (error) { await this.block(work, error); throw error }
    }
  }

  async reprioritize(work: DispatchWork, expectedRevision: number, priority: number): Promise<void> {
    if (this.shutdownRequested) throw new Error('Coordinator execution is closed')
    if (this.assignments.list().some(record => sameWork(record, work))) throw new Error('Attempt already exists for dispatch request')
    await this.queue.reprioritize(work, expectedRevision, priority)
  }

  close(): Promise<void> {
    this.shutdownRequested = true
    return this.closing ??= (async () => {
      // The external adapter owns no DSH sessions. It must still drive every
      // live helper to a positive terminal receipt before this coordinator lock
      // can be released; uncertainty leaves the stores and ownership intact.
      await this.external?.drain(this.assignments.list())
      // Keep ownership and policies until all managed child activations are quiescent.
      for (const [teamId, lead] of this.roots) {
        // External helpers have no Team session identity. Their durable intent
        // and capacity fence remain on disk for the next coordinator instance;
        // never pass their arbitrary runtime IDs to the DSH drain API.
        const ids = this.assignments.list().filter(record => record.teamId === teamId && record.provider !== 'external').map(record => SessionId(record.runtimeId))
        await this.runtime.drain(lead, ids)
      }
      for (const handle of this.handles.values()) await handle.dispose()
      await this.assignments.close()
      await this.failures.close()
      await this.queue.close()
      await this.submissions.close()
      await this.reports.close()
      await this.retention.close()
      await this.health?.close()
      await this.externalStore?.close()
      this.dshHealth?.close()
      this.removePolicy()
    })().catch((error: unknown) => {
      // A failed observation retains ownership; a later close may rejoin the drain.
      this.closing = undefined
      throw error
    })
  }

  private async leadFor(project: ProjectRecord, teamId: string): Promise<Agent> {
    if (this.config === undefined) throw new Error('Execution is disabled')
    if (!project.teamIds.includes(teamId)) throw new Error('Team is outside the registered project grant')
    let lead = this.ctx.agents.get(SessionId(teamId))
    if (lead === undefined) {
      const handle = await this.ctx.agents.resume({ resumeSessionId: SessionId(teamId), agentOptions: { provider: this.config.modelProvider, model: this.config.model } })
      this.handles.set(teamId, handle)
      lead = handle.agent
    }
    this.roots.set(teamId, lead)
    if (this.ctx.agentTeams.tryMembership(lead)?.role !== 'lead') throw new Error('Registered session is not a Team Lead')
    if (await realpath(lead.session.header.cwd ?? process.cwd()) !== project.repository) throw new Error('Lead cwd does not match the registered project repository')
    if (lead.options.provider !== this.config.modelProvider || lead.options.model !== this.config.model) throw new Error('Lead model does not match coordinator execution policy')
    return lead
  }

  private async block(work: { projectId: string; teamId: string; taskId: string }, error: unknown): Promise<void> {
    const diagnostic = (error instanceof Error ? error.message : String(error)).slice(0, 16_384) || 'Unknown execution failure'
    if (this.failures.snapshot().some(block => sameWork(block, work) && block.diagnostic === diagnostic)) return
    await this.failures.append(() => ({ type: 'work/blocked', block: { projectId: work.projectId, teamId: work.teamId, taskId: work.taskId, diagnostic } }))
  }
}
