/** Automatic independent-task admission; dependency acceptance and retry policy extend this service. */
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from 'zod'
import { AssignmentStore } from './assignments.ts'
import type { AttemptRecord } from './assignments.ts'
import { runGit } from './git-command.ts'
import { SubmissionStore, submitRequestSchema } from './submissions.ts'
import type { SubmitRequest, SubmissionRecord } from './submissions.ts'
import { TeamTaskId } from './types.ts'
import type { TeamIntegrationAdmission, TeamIntegrationId } from './types.ts'
import { DispatchQueue } from './dispatch-queue.ts'
import type { DispatchRequest, DispatchWork } from './dispatch-queue.ts'
import { DshAssignmentRuntime } from './dsh-assignment-runtime.ts'
import { DurableJournal } from './durable-journal.ts'
import { TeamError } from './error.ts'
import type { ProjectRecord } from './projects.ts'
import type { CoordinatorProjectView } from './coordinator.ts'
import type {} from './index.ts'

export const executionConfigSchema = z.object({
  modelProvider: z.string().trim().min(1), model: z.string().trim().min(1),
  maxRepairAttempts: z.number().int().min(0).max(10).optional(),
  dispatchIntervalMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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
  | 'cancelled' | 'pacing' | 'execution-failure' | 'awaiting-acceptance' | 'recovery-required'
export interface DispatchStatus extends DispatchRequest {
  readonly state: 'ready' | 'waiting' | 'assigned' | 'finished' | 'cancelled' | 'accepted'
  readonly blockers: { code: DispatchBlockCode; detail: string }[]
  readonly attemptId?: string
  readonly nextDispatchAt?: number
}

export class CoordinatorExecution {
  private readonly runtime: DshAssignmentRuntime
  private readonly handles = new Map<string, AgentHandle>()
  private readonly roots = new Map<string, Agent>()
  private readonly removePolicy: () => void
  private closing: Promise<void> | undefined
  private shutdownRequested = false

  private constructor(
    private readonly ctx: Context,
    private readonly config: ExecutionConfig | undefined,
    private readonly projects: () => ProjectRecord[],
    private readonly assignments: AssignmentStore,
    private readonly queue: DispatchQueue,
    private readonly submissions: SubmissionStore,
    private readonly failures: DurableJournal<ExecutionBlock[], { type: 'work/blocked'; block: ExecutionBlock }>,
  ) {
    this.runtime = new DshAssignmentRuntime(ctx, assignments, 30_000, true)
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
        return project !== undefined && attempt?.attemptId === submission.attemptId && attempt.phase === 'terminal' && !attempt.stopReason
          && !this.queue.list().some(request => sameWork(request, submission) && request.cancelReason !== undefined)
          && job?.memberId === submission.runtimeId && job.sourceCommit === submission.sourceCommit
          && job.repository === submission.repository && job.targetBranch === submission.targetBranch
          && isDeepStrictEqual(job.verification, submission.verification.commands)
          && isDeepStrictEqual(project.verification, submission.verification)
      },
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
          return new CoordinatorExecution(ctx, validated, projects, assignments, queue, submissions, failures)
        } catch (error) { await queue.close(); throw error }
      } catch (error) { await failures.close(); throw error }
    } catch (error) { await assignments.close(); throw error }
  }

  view(views: readonly CoordinatorProjectView[]): { attempts: AttemptRecord[]; executionBlocks: ExecutionBlock[]; dispatchRequests: DispatchRequest[]; dispatchStatus: DispatchStatus[]; submissions: SubmissionRecord[] } {
    const now = Date.now()
    return { submissions: this.submissions.list(), attempts: this.assignments.list(), executionBlocks: this.failures.snapshot(), dispatchRequests: this.queue.list(),
      dispatchStatus: this.queue.list().map(request => this.status(request, views, now)) }
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
      if (this.submissions.list().some(submission => submission.attemptId === attempt.attemptId && submission.phase === 'accepted')) return { ...request, state: 'accepted', attemptId: attempt.attemptId, blockers: [] }
      if (!repair && attempt.phase === 'terminal' && request.cancelReason === undefined) block(attempt.result && !attempt.stopReason && !failure ? 'awaiting-acceptance' : 'recovery-required',
        failure?.diagnostic ?? (attempt.result && !attempt.stopReason ? 'Worker report awaits verified task acceptance' : attempt.stopReason ?? 'Attempt stopped; explicit recovery is required'))
      if (!repair) return { ...request, state: attempt.phase === 'terminal' ? request.cancelReason === undefined ? 'finished' : 'cancelled' : 'assigned', attemptId: attempt.attemptId, blockers }
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
    }
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
        await this.runtime.cancel(lead, token(record), cancelled.cancelReason!)
      } catch (error) { await this.block(record, error) }
    }
    if (this.config === undefined) return
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
        if (record.phase === 'reserved') await this.runtime.start(lead, token(record))
        else await this.runtime.observe(lead, token(record))
      } catch (error) { await this.block(record, error) }
    }
    if (this.ctx.agentTeams.integrationEnabled) {
      for (const record of this.assignments.list()) {
        if (record.phase !== 'terminal' || !record.result || record.stopReason
          || this.submissions.list().some(submission => submission.attemptId === record.attemptId)
          || this.queue.list().some(request => sameWork(request, record) && request.cancelReason !== undefined)) continue
        const project = views.find(view => view.project.id === record.projectId)
        if (!project || project.paused) continue
        try {
          const lead = await this.leadFor(project.project, record.teamId)
          const member = this.ctx.agentTeams.listMembers(lead).find(member => member.id === record.runtimeId && member.name === record.attemptId)
          if (member?.worktree?.phase !== 'ready') throw new Error('Reported attempt has no ready worktree for submission')
          const sourceCommit = await runGit(member.worktree.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], new AbortController().signal, 30_000)
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
        if (previous && !repair) throw new Error('Previous attempt is not eligible for repair')
        record = await this.assignments.reserve({ projectId: work.projectId, teamId: work.teamId, taskId: work.taskId,
          workerId: randomUUID(), runtimeId: randomUUID(), provider: 'spawn', expectedGeneration: previous?.generation ?? 0,
          repairLimit: previous ? previous.repairLimit! : this.config.maxRepairAttempts ?? 3, ...(repair ? { repair } : {}),
          checkpoint: { task: { subject: task.subject, description: task.description }, step: repair ? 'repair' : 'implement',
            artifacts: repair ? [{ kind: 'commit', ref: repair.sourceCommit }, { kind: 'file', ref: repair.candidateCwd }] : [],
            nextAction: repair
              ? 'Repair the failed submission in this new worktree. Inspect the retained candidate and diagnostic; apply the pinned source commit, resolve conflicts against the current target, fix failing checks, commit the repaired artifact, and report evidence. Preserve all previous checkouts.'
              : 'Perform the task in your isolated worktree, commit code changes, and report artifacts and verification evidence.' },
        })
        const lead = await this.leadFor(view.project, work.teamId)
        startInvoked = true
        await this.runtime.start(lead, token(record))
      } catch (error) {
        if (record !== undefined && !startInvoked) await this.assignments.retire(token(record), {
          runtimeId: record.runtimeId, kind: 'never-started', receipt: 'coordinator/pre-start-failure',
        })
        await this.block(work, error)
      }
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
    const submission = await this.submissions.submit({ ...input, projectId: project.id, teamId: lead.id, taskId: attempt.taskId,
      runtimeId: attempt.runtimeId, repository: project.repository, targetBranch: project.targetBranch, verification: project.verification })
    try { return await this.queueSubmission(lead, submission) }
    catch (error) { await this.block(submission, error); throw error }
  }

  private async queueSubmission(lead: Agent, submission: SubmissionRecord): Promise<SubmissionRecord> {
    const attempt = this.assignments.list().findLast(record => sameWork(record, submission))
    if (!attempt || attempt.attemptId !== submission.attemptId || attempt.generation !== submission.generation
      || attempt.revision !== submission.expectedRevision || attempt.phase !== 'terminal' || attempt.stopReason) throw new Error('Submission attempt is stale or no longer eligible')
    if (this.queue.list().some(request => sameWork(request, submission) && request.cancelReason !== undefined)) throw new Error('Cancelled submission cannot enter integration')
    const admission = { id: submission.integrationId, sourceCommit: submission.sourceCommit, repository: submission.repository,
      targetBranch: submission.targetBranch, verification: submission.verification.commands } as TeamIntegrationAdmission
    await this.ctx.agentTeams.enqueuePinnedIntegration(lead, submission.attemptId, admission, new AbortController().signal)
    return this.submissions.queued(submission.id)
  }

  async cancel(lead: Agent, work: DispatchWork, expectedRevision: number, reason: string): Promise<void> {
    if (this.shutdownRequested) throw new Error('Coordinator execution is closed')
    const submissions = this.submissions.list().filter(submission => sameWork(submission, work))
    if (submissions.some(submission => this.ctx.agentTeams.listIntegrations(lead).some(job => job.id === submission.integrationId && job.phase !== 'failed'))) throw new Error('Work has entered integration; integration cancellation is required')
    await this.queue.cancel(work, expectedRevision, reason)
    const record = this.assignments.list().findLast(record => sameWork(record, work))
    if (record && record.phase !== 'terminal') {
      try { await this.runtime.cancel(lead, token(record), reason) }
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
      // Keep ownership and policies until all managed child activations are quiescent.
      for (const [teamId, lead] of this.roots) {
        const ids = this.assignments.list().filter(record => record.teamId === teamId).map(record => SessionId(record.runtimeId))
        await this.runtime.drain(lead, ids)
      }
      for (const handle of this.handles.values()) await handle.dispose()
      await this.assignments.close()
      await this.failures.close()
      await this.queue.close()
      await this.submissions.close()
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
