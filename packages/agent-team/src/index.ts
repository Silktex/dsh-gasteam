/** Agent Teams service façade over roster, mailbox, task, and runtime lifecycle owners. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TeamActivity } from './activity.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamMailbox } from './mailbox.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamRoster } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamTaskBoard } from './task-board.ts'
import { TeamWorktrees } from './worktrees.ts'
import { TeamBatches } from './batches.ts'
import { TeamIntegrations } from './integrations.ts'
import { TeamRecovery } from './recovery.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  Config,
  CreateTeamTaskRequest,
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberView,
  TeamWorktreeProvider,
  TeamBatchView,
  TeamIntegrationId,
  TeamIntegrationProvider,
  TeamIntegrationSnapshot,
  TeamRecoverySnapshot,
  RecoverTeammateRequest,
  CreateTeamBatchRequest,
  UpdateTeamBatchRequest,
  TeamTaskMutationResult,
  TeamTaskView,
  TeamView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export type { TeamMembership } from './roster.ts'
export { TeamId, TeamMessageId, TeamTaskId, TeamBatchId } from './types.ts'
export { TeamError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

const DEFAULT_MAX_MEMBERS = 8
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_BATCHES = 128
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3
const DEFAULT_MAX_BATCH_TEXT_LENGTH = 16_384
const DEFAULT_MAX_TASK_RESULT_LENGTH = 16_384
const DEFAULT_MAX_PENDING_MESSAGES = 64
const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    worktreeProvider: z.string(),
    integrationProvider: z.string(),
    maxIntegrations: z.number().step(1).min(1).default(32),
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxBatches: z.number().step(1).min(1).default(DEFAULT_MAX_BATCHES),
    maxRecoveryAttempts: z.number().step(1).min(1).default(DEFAULT_MAX_RECOVERY_ATTEMPTS),
    maxBatchTextLength: z.number().step(1).min(1).default(DEFAULT_MAX_BATCH_TEXT_LENGTH),
    maxTaskResultLength: z.number().step(1).min(1).default(DEFAULT_MAX_TASK_RESULT_LENGTH),
    maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_MESSAGES),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  })

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Omit<Config, 'worktreeProvider' | 'integrationProvider'>> & Pick<Config, 'worktreeProvider' | 'integrationProvider'>

  private readonly activity: TeamActivity
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private readonly tasks: TeamTaskBoard
  private readonly worktrees: TeamWorktrees
  private readonly batches: TeamBatches
  private readonly integrations: TeamIntegrations
  private readonly recovery: TeamRecovery
  private readonly operations = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      ...config.integrationProvider === undefined ? {} : { integrationProvider: config.integrationProvider.trim() },
      maxIntegrations: positiveLimit('maxIntegrations', config.maxIntegrations ?? 32),
      ...config.worktreeProvider === undefined ? {} : {
        worktreeProvider: config.worktreeProvider.trim(),
      },
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
      maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS),
      maxBatches: positiveLimit('maxBatches', config.maxBatches ?? DEFAULT_MAX_BATCHES),
      maxRecoveryAttempts: positiveLimit('maxRecoveryAttempts', config.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS),
      maxBatchTextLength: positiveLimit('maxBatchTextLength', config.maxBatchTextLength ?? DEFAULT_MAX_BATCH_TEXT_LENGTH),
      maxTaskResultLength: positiveLimit(
        'maxTaskResultLength', config.maxTaskResultLength ?? DEFAULT_MAX_TASK_RESULT_LENGTH,
      ),
      maxPendingMessagesPerMember: positiveLimit(
        'maxPendingMessagesPerMember',
        config.maxPendingMessagesPerMember ?? DEFAULT_MAX_PENDING_MESSAGES,
      ),
      maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
      disposalTimeoutMs: positiveLimit(
        'disposalTimeoutMs',
        config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
      ),
    }

    if (this.config.integrationProvider === '') throw new TeamError('integrationProvider must be non-empty', 'TEAM_INVALID_CONFIG')
    if (this.config.worktreeProvider === '') throw new TeamError('worktreeProvider must be non-empty', 'TEAM_INVALID_CONFIG')
    this.activity = new TeamActivity()
    this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
    this.integrations = new TeamIntegrations(ctx, this.journal, this.config.integrationProvider, this.config.maxIntegrations)
    this.worktrees = new TeamWorktrees(ctx, this.journal, this.config.worktreeProvider)
    this.roster = new TeamRoster(
      ctx, this.journal, this.lifecycle, this.config.maxMembers, this.worktrees, this.config.disposalTimeoutMs,
    )
    this.mailbox = new TeamMailbox(
      ctx,
      this.journal,
      this.roster,
      this.lifecycle,
      this.config.maxPendingMessagesPerMember,
      this.config.maxMessageBytes,
    )
    this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks, this.config.maxTaskResultLength)
    this.batches = new TeamBatches(this.journal, this.config.maxBatches, this.config.maxBatchTextLength)
    this.recovery = new TeamRecovery(ctx, this.journal, this.roster, this.mailbox, this.config.maxRecoveryAttempts)

    ctx.on('session/event', (session, event) => { this.mailbox.observeSessionEvent(session, event) })
    ctx.on('agent/session-start', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
          disposeProjection()
        }
      }
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    return this.roster.list(this.roster.membership(agent))
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /** Workspace policy selected for newly created teammates. */
  get workspaceMode(): 'shared' | 'worktree' {
    return this.config.worktreeProvider === undefined ? 'shared' : 'worktree'
  }

  /**
   * Register a Git-worktree provider in the calling plugin's effect scope.
   * @param provider - provider for explicitly configured worker isolation.
   * @returns registration disposer; removal prevents subsequent provider lookups.
   */
  registerWorktreeProvider(provider: TeamWorktreeProvider): () => Promise<void> {
    return this.ctx.effect(() => this.worktrees.register(provider), 'agentTeams.registerWorktreeProvider()')
  }

  /**
   * Release a quiescent worker checkout after its commits reach the Lead branch.
   * @param caller - exact live Lead authorizing removal.
   * @param target - immutable teammate name, including a failed provision.
   * @param signal - caller cancellation through safe cleanup.
   */
  async releaseWorktree(caller: Agent, target: string, signal: AbortSignal): Promise<void> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can release worktrees', 'TEAM_LEAD_REQUIRED')
    const member = this.journal.state(membership.root).members.find(candidate => candidate.name === target)
    if (member === undefined) throw new TeamError(`teammate "${target}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    await this.runOperation(signal, async (cancellation) => {
      await this.worktrees.release(membership.root, member.id, cancellation)
    })
  }

  /**
   * Queue one durable peer message, then attempt immediate delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, scheduling mode, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    return await this.mailbox.send(caller, request)
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.create(this.roster.membership(caller), request)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.roster.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.roster.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.update(caller, this.roster.membership(caller), request)
  }

  /** Whether integration tools are enabled by deployment configuration. */
  get integrationEnabled(): boolean { return this.config.integrationProvider !== undefined }

  /**
   * Register one integration provider under the mounting plugin effect scope.
   * @param provider - integration implementation.
   * @returns scoped registration disposer.
   */
  registerIntegrationProvider(provider: TeamIntegrationProvider): () => Promise<void> {
    return this.ctx.effect(() => this.integrations.register(provider))
  }

  /**
   * Queue committed output from a quiescent worker.
   * @param caller - exact live Lead.
   * @param target - durable teammate name.
   * @param signal - caller cancellation.
   * @returns pinned integration request.
   */
  async enqueueIntegration(caller: Agent, target: string, signal: AbortSignal): Promise<TeamIntegrationSnapshot> {
    return await this.runOperation(signal, async cancellation =>
      await this.integrations.enqueue(this.roster.membership(caller), target, cancellation))
  }

  /**
   * Run or recover the oldest pending integration.
   * @param caller - exact live Lead.
   * @param signal - caller cancellation.
   * @returns resulting integration record, or undefined for an empty queue.
   */
  async runIntegration(caller: Agent, signal: AbortSignal): Promise<TeamIntegrationSnapshot | undefined> {
    return await this.runOperation(signal, async cancellation => await this.integrations.run(this.roster.membership(caller), cancellation))
  }

  /**
   * Abandon a blocked integration while retaining its candidate checkout.
   * @param caller - exact live Lead.
   * @param id - unfinished integration identity.
   * @param reason - durable abandonment explanation.
   * @param signal - caller cancellation.
   * @returns failed terminal record.
   */
  async abandonIntegration(caller: Agent, id: TeamIntegrationId, reason: string, signal: AbortSignal): Promise<TeamIntegrationSnapshot> {
    return await this.runOperation(signal, async (cancellation) => {
      cancellation.throwIfAborted()
      return await this.integrations.abandon(this.roster.membership(caller), id, reason)
    })
  }

  /**
   * Read durable integration history.
   * @param caller - exact live Team member.
   * @returns detached queue and terminal records.
   */
  listIntegrations(caller: Agent): TeamIntegrationSnapshot[] {
    return this.integrations.list(this.roster.membership(caller))
  }

  /**
   * Restart an unchanged worker that still owns unfinished tasks.
   * @param caller - exact live Lead.
   * @param request - observed progress and durable recovery instruction.
   * @param signal - cancellation through interruption and follow-up admission.
   * @returns admitted attempt, counted even if subsequent delivery fails.
   */
  async recoverTeammate(caller: Agent, request: RecoverTeammateRequest, signal: AbortSignal): Promise<TeamRecoverySnapshot> {
    return await this.runOperation(signal, async cancellation => await this.recovery.recover(caller, request, cancellation))
  }

  /**
   * Create a named durable task batch.
   * @param caller - exact live Lead.
   * @param request - batch metadata and current task ids.
   * @returns committed batch with derived progress.
   */
  async createBatch(caller: Agent, request: CreateTeamBatchRequest): Promise<TeamBatchView> {
    return await this.batches.create(this.roster.membership(caller), request)
  }

  /**
   * Update or archive a batch using its current revision.
   * @param caller - exact live Lead.
   * @param request - compare-and-set mutation.
   * @returns committed batch with derived progress.
   */
  async updateBatch(caller: Agent, request: UpdateTeamBatchRequest): Promise<TeamBatchView> {
    return await this.batches.update(this.roster.membership(caller), request)
  }

  /**
   * Read active and archived durable batches.
   * @param caller - exact live Team member.
   * @returns batches with progress derived from the current task board.
   */
  listBatches(caller: Agent): TeamBatchView[] {
    return this.batches.list(this.roster.membership(caller))
  }

  /**
   * Wait for the next Team-domain or member-status change.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' } {
    return this.roster.interrupt(caller, targetName)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /**
   * Read the current roster and non-deleted task board through the generated Remote API.
   * @param agent - exact live Team member used as the authority credential.
   * @returns detached current roster and task views.
   */
  @Remote('view')
  remoteView(agent: Agent): TeamView {
    return {
      members: this.listMembers(agent),
      tasks: this.listTasks(agent),
      batches: this.listBatches(agent),
      integrations: this.listIntegrations(agent),
    }
  }

  /**
   * Create one shared task through the generated Remote API.
   * @param agent - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task or a typed Team rejection.
   */
  @Remote('createTask')
  remoteCreateTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    return this.taskMutationResult(this.createTask(agent, request))
  }

  /**
   * Apply one task mutation and preserve Team rejections as business results.
   * @param agent - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed task or a typed Team rejection.
   */
  @Remote('updateTask')
  remoteUpdateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult> {
    return this.taskMutationResult(this.updateTask(agent, request))
  }

  /** Preserve Team task rejections while allowing unexpected failures to reject the Remote call. */
  private async taskMutationResult(operation: Promise<TeamTaskView>): Promise<TeamTaskMutationResult> {
    try {
      return { ok: true, value: await operation }
    } catch (error) {
      if (!(error instanceof TeamError)) throw error
      return {
        ok: false,
        error: {
          code: error.code === 'TEAM_TASK_STALE_REVISION' ? 'team-task-conflict' : 'team-rejected',
          message: error.message,
        },
      }
    }
  }

  /** Track external mutations until they settle, including cancellation cleanup. */
  private async runOperation<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const pending = operation(AbortSignal.any([signal, this.lifecycle.signal]))
    this.operations.add(pending)
    try {
      return await pending
    } finally {
      this.operations.delete(pending)
    }
  }

  /** Queue one contained recovery pass after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      if (this.lifecycle.disposed) return
      void this.recoverFor(agent).catch((error: unknown) => {
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
      })
    })
  }

  /** Reconcile roster provisioning before retrying that member's pending mailbox. */
  private async recoverFor(agent: Agent): Promise<void> {
    await this.roster.recoverFor(agent, this.lifecycle.signal)
    await this.mailbox.recoverFor(agent, this.lifecycle.signal)
  }

  /** Stop Team-owned live branches and release every waiter before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    this.activity.close()

    const failures: unknown[] = []
    await this.lifecycle.settle(this.roster.pendingCreations(), failures)
    await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures)
    await this.lifecycle.settle([...this.operations], failures)
    for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
      try {
        await this.roster.stopTeammates(root, childIds)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
  }
}

export default TeamService
