/** Shared Team task DAG commands and runtime-enriched views. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { isDeepStrictEqual } from 'node:util'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  CreateTeamTaskRequest,
  CreatePinnedTeamTaskRequest,
  IntegratedTaskAcceptance,
  ReportedTaskAcceptance,
  TeamTaskSnapshot,
  TeamTaskReviewBinding,
  TeamTaskWorkflowBinding,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'
import { requiredText, writeScope } from './validation.ts'

/** Whether two normalized file or directory prefixes overlap on path components. */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

const TASK_GRAPH_ERROR_CODES: Record<TeamTaskGraphViolation, string> = {
  missing: 'TEAM_TASK_NOT_FOUND',
  duplicate: 'TEAM_INVALID_ARGUMENT',
  cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
}
function reviewBinding(input: TeamTaskReviewBinding | undefined): TeamTaskReviewBinding | undefined {
  if (input === undefined) return undefined
  const commit = (value: string, name: string) => {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw new TeamError(`Pinned review ${name} is invalid`, 'TEAM_INVALID_ARGUMENT')
    return value
  }
  if (!Number.isSafeInteger(input.candidateRound) || input.candidateRound < 0) throw new TeamError('Pinned review candidate round is invalid', 'TEAM_INVALID_ARGUMENT')
  return { projectId: requiredText(input.projectId, 'pinned review project', 128), teamId: requiredText(input.teamId, 'pinned review team', 128),
    executionId: requiredText(input.executionId, 'pinned review execution', 128), candidateRound: input.candidateRound,
    integrationId: requiredText(input.integrationId, 'pinned review integration', 128), sourceCommit: commit(input.sourceCommit, 'source'), targetCommit: commit(input.targetCommit, 'target'),
    candidateCommit: commit(input.candidateCommit, 'candidate'), reviewGate: requiredText(input.reviewGate, 'pinned review gate', 128) }
}

function workflowBinding(input: TeamTaskWorkflowBinding): TeamTaskWorkflowBinding {
  const names = new Set<string>()
  if (input.inputs.length > 128) throw new TeamError('Pinned workflow has too many input artifacts', 'TEAM_INVALID_ARGUMENT')
  return {
    executionId: requiredText(input.executionId, 'pinned workflow execution', 128),
    stepId: requiredText(input.stepId, 'pinned workflow step', 128),
    inputs: input.inputs.map(value => {
      const name = requiredText(value.name, 'pinned workflow artifact name', 128)
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(name) || names.has(name)) {
        throw new TeamError('Pinned workflow artifact names must be unique identifiers', 'TEAM_INVALID_ARGUMENT')
      }
      names.add(name)
      if (value.artifact.kind !== 'commit' && value.artifact.kind !== 'file' && value.artifact.kind !== 'report') {
        throw new TeamError('Pinned workflow artifact kind is invalid', 'TEAM_INVALID_ARGUMENT')
      }
      return { name, artifact: { kind: value.artifact.kind, ref: requiredText(value.artifact.ref, 'pinned workflow artifact reference', 16_384) } }
    }),
  }
}

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
  /**
   * @param journal - authoritative Lead-log transaction owner.
   * @param maxTasks - maximum non-deleted tasks retained by one Team.
   * @param maxResultLength - maximum normalized completion evidence length.
   */
  constructor(
    private readonly journal: TeamJournal,
    private readonly maxTasks: number,
    private readonly maxResultLength: number,
    private readonly validateMutation: (caller: Agent, root: Agent, request: UpdateTeamTaskRequest) => void = () => {},
    private readonly validateAcceptance: (root: Agent, request: IntegratedTaskAcceptance) => boolean = () => false,
    private readonly validateReportAcceptance: (root: Agent, request: ReportedTaskAcceptance) => boolean = () => false,
  ) {}

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async create(membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const { root } = membership
    if ('workflowBinding' in (request as object)) throw new TeamError('Workflow binding is host-only', 'TEAM_MANAGED_TASK')
    if (request.nonCodeCriteria !== undefined && membership.role !== 'lead') throw new TeamError('Non-code acceptance criteria require a Lead', 'TEAM_LEAD_ONLY')
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const active = state.tasks.filter(task => task.status !== 'deleted').length
      if (active >= this.maxTasks) {
        throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      }
      const id = TeamTaskId(`task-${state.nextTaskNumber}`)
      if (state.tasks.some(task => task.id === id)) {
        throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
      }
      const task: TeamTaskSnapshot = {
        id,
        revision: 1,
        subject: requiredText(request.subject, 'subject', 200),
        description: requiredText(request.description, 'description', 16_384),
        ...(request.nonCodeCriteria === undefined ? {} : { nonCodeCriteria: requiredText(request.nonCodeCriteria, 'non-code criteria', 16_384) }),
        status: 'pending',
        blockedBy: this.dependencies(request.blockedBy ?? [], state),
        writeScopes: this.writeScopes(request.writeScopes ?? []),
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 1, teamId: TeamId(root.id), task })
      return this.taskView(root, state, task)
    })
  }

  /**
   * Host-only workflow admission. `admissionKey` becomes the durable Team task
   * identity in the same flushed event as the task, so replay cannot create a
   * second task after a crash between host return and caller acknowledgement.
   */
  async createPinned(membership: TeamMembership, request: CreatePinnedTeamTaskRequest): Promise<TeamTaskView> {
    const { root } = membership
    if (membership.role !== 'lead') throw new TeamError('Pinned task admission requires a Lead', 'TEAM_LEAD_ONLY')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(request.admissionKey)) throw new TeamError('Pinned task admission key is invalid', 'TEAM_INVALID_ARGUMENT')
    const taskId = TeamTaskId(`workflow-${request.admissionKey}`)
    const subject = requiredText(request.subject, 'subject', 200)
    const description = requiredText(request.description, 'description', 16_384)
    if ((request.nonCodeCriteria === undefined) === (request.reviewGate === undefined)) {
      throw new TeamError('Pinned task requires exactly one report criteria or integration review gate', 'TEAM_INVALID_ARGUMENT')
    }
    const nonCodeCriteria = request.nonCodeCriteria === undefined ? undefined : requiredText(request.nonCodeCriteria, 'non-code criteria', 16_384)
    const reviewGate = request.reviewGate === undefined ? undefined : requiredText(request.reviewGate, 'integration review gate', 128)
    const pinnedReview = reviewBinding(request.reviewBinding)
    const pinnedWorkflow = workflowBinding(request.workflowBinding)
    if (pinnedReview !== undefined && nonCodeCriteria === undefined) throw new TeamError('Pinned candidate review requires non-code criteria', 'TEAM_INVALID_ARGUMENT')
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const existing = state.tasks.find(task => task.id === taskId)
      if (existing) {
        if (existing.subject !== subject || existing.description !== description || existing.nonCodeCriteria !== nonCodeCriteria || existing.reviewGate !== reviewGate || !isDeepStrictEqual(existing.workflowBinding, pinnedWorkflow) || !isDeepStrictEqual(existing.reviewBinding, pinnedReview)
          || existing.blockedBy.length !== 0 || existing.writeScopes.length !== 0) throw new TeamError('Pinned task replay has different immutable inputs', 'TEAM_INVALID_ARGUMENT')
        return this.taskView(root, state, existing)
      }
      const active = state.tasks.filter(task => task.status !== 'deleted').length
      if (active >= this.maxTasks) throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      const task: TeamTaskSnapshot = { id: taskId, revision: 1, subject, description,
        ...(nonCodeCriteria === undefined ? {} : { nonCodeCriteria }), ...(reviewGate === undefined ? {} : { reviewGate }), workflowBinding: pinnedWorkflow, ...(pinnedReview === undefined ? {} : { reviewBinding: pinnedReview }), status: 'pending', blockedBy: [], writeScopes: [] }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 1, teamId: TeamId(root.id), task })
      return this.taskView(root, state, task)
    })
  }

  /** Accept a coordinator-reviewed report only while its durable intent remains authorized. */
  async acceptReported(membership: TeamMembership, request: ReportedTaskAcceptance): Promise<TeamTaskView> {
    const { root } = membership
    if (membership.role !== 'lead') throw new TeamError('Report acceptance requires a Lead', 'TEAM_LEAD_ONLY')
    return this.journal.transact(root.id, async () => {
      if (!this.validateReportAcceptance(root, request)) throw new TeamError('No coordinator grant for this report acceptance', 'TEAM_MANAGED_TASK')
      const state = this.journal.state(root)
      const task = state.tasks.find(task => task.id === request.taskId)
      if (!task || task.nonCodeCriteria === undefined) throw new TeamError('Task does not accept a non-code report', 'TEAM_TASK_INVALID_TRANSITION')
      const result = JSON.stringify({ reportId: request.reportId })
      if (task.status === 'completed' && task.result === result) return this.taskView(root, state, task)
      if (task.revision !== request.expectedRevision || task.status !== 'pending' || task.ownerId !== undefined || !this.taskReady(state, task)) throw new TeamError('Task changed or prerequisites remain unaccepted', 'TEAM_TASK_INVALID_TRANSITION')
      const accepted: TeamTaskSnapshot = { ...task, revision: task.revision + 1, status: 'completed', result: requiredText(result, 'report receipt', this.maxResultLength) }
      await this.journal.appendAndFlush(root, 'team/task', { version: 1, teamId: TeamId(root.id), task: accepted })
      return this.taskView(root, this.journal.state(root), accepted)
    })
  }

  /** Accept only a coordinator-authorized task backed by a durable verified promotion. */
  async acceptIntegrated(membership: TeamMembership, request: IntegratedTaskAcceptance): Promise<TeamTaskView> {
    const { root } = membership
    if (membership.role !== 'lead') throw new TeamError('Integrated acceptance requires a Lead', 'TEAM_LEAD_ONLY')
    return this.journal.transact(root.id, async () => {
      if (!this.validateAcceptance(root, request)) throw new TeamError('No coordinator grant for this acceptance', 'TEAM_MANAGED_TASK')
      const state = this.journal.state(root)
      const task = state.tasks.find(task => task.id === request.taskId)
      const job = state.integrations.find(job => job.id === request.integrationId)
      if (task?.nonCodeCriteria !== undefined) throw new TeamError('Task requires audited report acceptance', 'TEAM_TASK_INVALID_TRANSITION')
      if (!task || !job || job.phase !== 'merged' || !job.candidateCommit || !job.targetCommit) throw new TeamError('Task acceptance requires a verified merged integration', 'TEAM_INTEGRATION_CONFLICT')
      const result = JSON.stringify({ submissionId: request.submissionId, integrationId: job.id, sourceCommit: job.sourceCommit,
        candidateCommit: job.candidateCommit, targetCommit: job.targetCommit })
      if (task.status === 'completed' && task.result === result) {
        return this.taskView(root, state, task)
      }
      if (task.revision !== request.expectedRevision || task.status !== 'pending' || task.ownerId !== undefined || !this.taskReady(state, task)) throw new TeamError('Task changed or prerequisites remain unaccepted', 'TEAM_TASK_INVALID_TRANSITION')
      const accepted: TeamTaskSnapshot = { ...task, revision: task.revision + 1, status: 'completed', result: requiredText(result, 'integration receipt', this.maxResultLength) }
      await this.journal.appendAndFlush(root, 'team/task', { version: 1, teamId: TeamId(root.id), task: accepted })
      return this.taskView(root, this.journal.state(root), accepted)
    })
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  get(membership: TeamMembership, id: TeamTaskId): TeamTaskView {
    const { root } = membership
    const state = this.journal.state(root)
    const task = state.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    return this.taskView(root, state, task)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param membership - exact caller membership resolved by the Team roster.
   * @returns detached current task views.
   */
  list(membership: TeamMembership): TeamTaskView[] {
    const { root } = membership
    const state = this.journal.state(root)
    return state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => this.taskView(root, state, task))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param membership - caller role and exact live Lead.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async update(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
  ): Promise<TeamTaskView> {
    const root = membership.root
    if ('workflowBinding' in (request as object)) throw new TeamError('Workflow binding is host-only', 'TEAM_MANAGED_TASK')
    return this.journal.transact(root.id, async () => {
      this.validateMutation(caller, root, request)
      const state = this.journal.state(root)
      const current = state.tasks.find(task => task.id === request.taskId)
      if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      if (current.revision !== request.expectedRevision) {
        throw new TeamError(
          `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
          'TEAM_TASK_STALE_REVISION',
        )
      }
      if (current.status === 'deleted') throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED')
      const lead = membership.role === 'lead'
      const owner = current.ownerId === caller.id
      const authorizeOwner = (): void => {
        if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
      }
      let next: TeamTaskSnapshot
      switch (request.action) {
        case 'claim':
          if (current.ownerId !== undefined && current.ownerId !== caller.id) {
            throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
          }
          if (current.status !== 'pending' || !this.taskReady(state, current)) {
            throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
          }
          next = { ...current, status: 'in_progress', ownerId: caller.id }
          break
        case 'release':
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
          next = this.withoutOwner({ ...current, status: 'pending' })
          break
        case 'edit':
          authorizeOwner()
          if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
            throw new TeamError('task edit requires subject, description, or write_scopes', 'TEAM_INVALID_ARGUMENT')
          }
          next = {
            ...current,
            ...request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) },
            ...request.description === undefined
              ? {}
              : { description: requiredText(request.description, 'description', 16_384) },
            ...request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) },
          }
          break
        case 'set_dependencies':
          authorizeOwner()
          if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
          next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) }
          break
        case 'complete':
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
          if (request.result === undefined) {
            throw new TeamError('complete requires result', 'TEAM_INVALID_ARGUMENT')
          }
          next = {
            ...current,
            status: 'completed',
            result: requiredText(request.result, 'result', this.maxResultLength),
          }
          break
        case 'reopen':
          authorizeOwner()
          if (current.status !== 'completed') throw new TeamError('only a completed task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
          next = this.withoutResult(this.withoutOwner({ ...current, status: 'pending' }))
          break
        case 'reassign': {
          if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
          if (current.status !== 'pending' && current.status !== 'in_progress') {
            throw new TeamError(
              'only a pending or in-progress task can be reassigned',
              'TEAM_TASK_INVALID_TRANSITION',
            )
          }
          if (request.owner === undefined || request.owner.trim().length === 0) {
            next = this.withoutOwner({ ...current, status: 'pending' })
            break
          }
          if (!this.taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
          const assignee = resolveActiveMember(root, state, request.owner)
          next = { ...current, status: 'in_progress', ownerId: assignee.id }
          break
        }
        case 'delete': {
          authorizeOwner()
          if (state.batches.some(batch => !batch.archived && batch.taskIds.includes(current.id))) {
            throw new TeamError('task belongs to an active Team batch; archive or edit the batch first', 'TEAM_TASK_IN_BATCH')
          }
          const dependent = state.tasks.find(task =>
            task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
          if (dependent !== undefined) {
            throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS')
          }
          next = this.withoutResult({ ...current, status: 'deleted' })
          break
        }
        /* v8 ignore next 2 -- TeamTaskAction is closed and every member is handled above. */
        default:
          throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
      }
      const task: TeamTaskSnapshot = {
        ...next,
        revision: current.revision + 1,
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 1, teamId: TeamId(root.id), task })
      return this.taskView(root, state, task)
    })
  }

  /** Validate and de-duplicate dependency ids against the current task graph. */
  private dependencies(
    values: readonly TeamTaskId[],
    state: TeamState,
    self?: TeamTaskId,
  ): TeamTaskId[] {
    const seen = new Set<TeamTaskId>()
    const result: TeamTaskId[] = []
    for (const id of values) {
      if (id === self) throw new TeamError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE')
      if (seen.has(id)) throw new TeamError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT')
      const task = state.tasks.find(candidate => candidate.id === id)
      if (task === undefined || task.status === 'deleted') {
        throw new TeamError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      }
      seen.add(id)
      result.push(id)
    }
    return result
  }

  /** Normalize and de-duplicate task write scopes. */
  private writeScopes(values: readonly string[]): string[] {
    return [...new Set(values.map(writeScope))]
  }

  /** Map shared task-graph validation onto stable command error codes. */
  private assertTaskGraph(state: TeamState, candidate: TeamTaskSnapshot): void {
    try {
      assertTaskGraphCandidate(state.tasks, candidate)
    } catch (error: unknown) {
      /* v8 ignore next -- the shared validator is the only statement in the try and throws this exact error. */
      if (!(error instanceof TeamTaskGraphError)) throw error
      throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error })
    }
  }

  /** Whether all current blockers completed. */
  private taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
    return task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed')
  }

  /** Remove an optional owner field under exactOptionalPropertyTypes. */
  private withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { ownerId: _ownerId, ...without } = task
    return without
  }

  /** Completion evidence belongs only to completed tasks. */
  private withoutResult(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { result: _result, ...without } = task
    return without
  }

  /**
   * Build one task view with owner name, readiness, and advisory write overlaps.
   * A committing caller may pass its pre-append state because `task` supplies the
   * new value explicitly; owner names, blocker readiness, and other task scopes
   * do not change when that snapshot is appended.
   */
  private taskView(root: Agent, state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
    const ownerName = task.ownerId === undefined
      ? undefined
      : task.ownerId === root.id
        ? 'lead'
        : state.members.find(member => member.id === task.ownerId)?.name
    const warnings = new Set<string>()
    for (const other of state.tasks) {
      if (other.id === task.id || other.status !== 'in_progress') continue
      if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
        warnings.add(`write scopes overlap with ${other.id}`)
      }
    }
    return {
      id: task.id,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      ...(task.nonCodeCriteria === undefined ? {} : { nonCodeCriteria: task.nonCodeCriteria }),
      ...(task.reviewGate === undefined ? {} : { reviewGate: task.reviewGate }),
      ...(task.workflowBinding === undefined ? {} : { workflowBinding: structuredClone(task.workflowBinding) }),
      ...(task.reviewBinding === undefined ? {} : { reviewBinding: structuredClone(task.reviewBinding) }),
      status: task.status,
      blockedBy: structuredClone(task.blockedBy),
      writeScopes: structuredClone(task.writeScopes),
      ...task.result === undefined ? {} : { result: task.result },
      ...ownerName === undefined ? {} : { ownerName },
      ready: task.status === 'pending' && this.taskReady(state, task),
      writeScopeWarnings: [...warnings],
    }
  }
}
