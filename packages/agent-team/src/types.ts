/** Public Agent Teams identities, durable records, and service request values. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/** Durable identity of one named Team task batch. */
export type TeamBatchId = Branded<'TeamBatchId'>

/**
 * Brand one Team-local batch id.
 * @param id - durable batch identifier.
 * @returns the same id with its batch brand.
 */
export function TeamBatchId(id: string): TeamBatchId {
  return id as TeamBatchId
}

/** Durable task membership and archive state for a named batch. */
export interface TeamBatchSnapshot {
  readonly id: TeamBatchId
  readonly revision: number
  readonly name: string
  readonly description: string
  readonly taskIds: TeamTaskId[]
  readonly archived: boolean
}

/** Batch progress projected from current task states. */
export interface TeamBatchView extends TeamBatchSnapshot {
  readonly completedTasks: number
  readonly status: 'active' | 'completed' | 'archived'
}

/** Inputs for one durable task batch. */
export interface CreateTeamBatchRequest {
  readonly name: string
  readonly description: string
  readonly taskIds: readonly TeamTaskId[]
}

/** Compare-and-set edits or permanent archival of one task batch. */
export interface UpdateTeamBatchRequest {
  readonly batchId: TeamBatchId
  readonly expectedRevision: number
  readonly name?: string
  readonly description?: string
  readonly taskIds?: readonly TeamTaskId[]
  readonly archive?: boolean
}

/** Durable recovery-attempt counter; admitted failures also consume an attempt. */
export interface TeamRecoverySnapshot {
  readonly memberId: SessionId
  readonly attempt: number
  readonly observedEventCount: number
  readonly reason: string
}

/** Observed worker progress required for compare-and-set recovery admission. */
export interface RecoverTeammateRequest {
  readonly target: string
  /** Child event count, or -1 when no child Activation is resident. */
  readonly observedEventCount: number
  readonly reason: string
}

/** Validated Git branch name owned by a Team worktree. */
export type TeamBranchName = Branded<'TeamBranchName'>

/** Full Git object identity recorded for reproducible workspace operations. */
export type TeamCommitId = Branded<'TeamCommitId'>

/** Resolved Git worktree identity; all paths are absolute. */
export interface TeamWorktreeSpec {
  readonly repository: string
  readonly cwd: string
  readonly branch: TeamBranchName
  readonly baseCommit: TeamCommitId
}

/** Durable workspace ownership, retained after release for recovery and audit. */
export interface TeamWorktreeSnapshot extends TeamWorktreeSpec {
  readonly memberId: SessionId
  readonly provider: string
  readonly phase: 'reserved' | 'ready' | 'released'
}

/** Git workspace operations contributed by an explicitly mounted provider. */
export interface TeamWorktreeProvider {
  readonly name: string
  /**
   * Resolve an unused worker path and branch without creating either.
   * @param repository - Lead's workspace directory.
   * @param memberId - reserved child identity.
   * @param signal - caller cancellation.
   * @returns immutable worktree creation inputs.
   */
  resolve(repository: string, memberId: SessionId, signal: AbortSignal): Promise<TeamWorktreeSpec>
  /**
   * Create the resolved worktree, rejecting conflicting existing ownership.
   * @param spec - previously recorded creation inputs.
   * @param signal - caller cancellation.
   */
  provision(spec: TeamWorktreeSpec, signal: AbortSignal): Promise<void>
  /**
   * Remove an owned clean worktree and its merged branch; preserve dirty or unmerged work.
   * @param spec - recorded workspace identity.
   * @param signal - cleanup cancellation.
   */
  release(spec: TeamWorktreeSpec, signal: AbortSignal): Promise<void>
}

/** Durable identity of one pinned integration request. */
export type TeamIntegrationId = Branded<'TeamIntegrationId'>

/** Explicit executable verification step; arguments are never interpreted by a shell. */
export interface TeamVerificationCommand {
  readonly command: string
  readonly args: string[]
}

/** Immutable integration inputs resolved before queue admission. */
export interface TeamIntegrationSpec {
  readonly repository: string
  readonly cwd: string
  readonly sourceBranch: TeamBranchName
  readonly sourceCommit: TeamCommitId
  readonly targetBranch: TeamBranchName
  readonly verification: TeamVerificationCommand[]
}

/** Host-only link from managed task acceptance to one durable submission/integration. */
export interface IntegratedTaskAcceptance {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly submissionId: string
  readonly integrationId: TeamIntegrationId
}

/** Coordinator-pinned inputs; reusing an ID requires the exact same logical submission. */
export interface TeamIntegrationAdmission {
  readonly id: TeamIntegrationId
  readonly sourceCommit: TeamCommitId
  readonly repository: string
  readonly targetBranch: TeamBranchName
  readonly verification: TeamVerificationCommand[]
}

/** Retained verification invalidated by target movement. */
export interface TeamIntegrationCandidate {
  readonly cwd: string
  readonly targetCommit: TeamCommitId
  readonly candidateCommit: TeamCommitId
  readonly error: string
}

/** Durable integration progress; verified candidates survive ambiguous promotion failures. */
export interface TeamIntegrationSnapshot extends TeamIntegrationSpec {
  readonly id: TeamIntegrationId
  readonly memberId: SessionId
  readonly provider: string
  readonly failureKind?: 'verification'
  readonly previousCandidates?: TeamIntegrationCandidate[]
  readonly phase: 'queued' | 'running' | 'verified' | 'merged' | 'failed'
  readonly targetCommit?: TeamCommitId
  readonly candidateCommit?: TeamCommitId
  readonly error?: string
}

/** Provider operations for isolated verification and recoverable fast-forward promotion. */
export interface TeamIntegrationProvider {
  readonly name: string
  /**
   * Pin committed worker output and configured verification without mutating Git.
   * @param worktree - ready worker workspace.
   * @param id - unique queue identity.
   * @param signal - caller cancellation.
   * @returns durable integration inputs.
   */
  resolve(worktree: TeamWorktreeSnapshot, id: TeamIntegrationId, signal: AbortSignal): Promise<TeamIntegrationSpec>
  /**
   * Read the configured target commit before candidate creation.
   * @param spec - queued inputs.
   * @param signal - caller cancellation.
   * @returns target commit to record before Git mutations.
   */
  target(spec: TeamIntegrationSpec, signal: AbortSignal): Promise<TeamCommitId>
  /**
   * Merge and verify in the reserved candidate checkout, preserving failures for inspection.
   * @param spec - queued inputs.
   * @param target - recorded target commit.
   * @param signal - caller cancellation.
   * @returns verified candidate commit, recorded before promotion.
   */
  verify(spec: TeamIntegrationSpec, target: TeamCommitId, signal: AbortSignal): Promise<TeamCommitId>
  /**
   * Fast-forward a clean target checkout or recognize an already promoted candidate.
   * @param spec - queued inputs.
   * @param target - original target commit.
   * @param candidate - durably verified candidate.
   * @param signal - caller cancellation.
   */
  promote(spec: TeamIntegrationSpec, target: TeamCommitId, candidate: TeamCommitId, signal: AbortSignal): Promise<void>
}

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'idle' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly model?: string
  readonly diagnostics: string[]
  readonly worktree?: TeamWorktreeSnapshot
  readonly recoveryAttempts?: number
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  /** Completion evidence retained while the task is completed. */
  readonly result?: string
}

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly result?: string
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
}

/** Point-in-time roster and task-board projection returned to browser clients. */
export interface TeamView {
  readonly members: TeamMemberView[]
  readonly tasks: TeamTaskView[]
  readonly batches: TeamBatchView[]
  readonly integrations: TeamIntegrationSnapshot[]
}

/** One peer message retained until its target Session records it. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly delivery: 'quiet' | 'wakeup'
  readonly content: ContentBlock[]
}

/** Source retained by the target Session for durable mailbox de-duplication. */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service deployment limits. */
export interface Config {
  /** Registered integration provider; omission disables integration tools. */
  readonly integrationProvider?: string
  /** Maximum unfinished integration requests per Team. */
  readonly maxIntegrations?: number
  /** Registered worktree provider; omission keeps teammates in the Lead checkout. */
  readonly worktreeProvider?: string
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum provisioning or resident teammates per Team, including wakeup admission. */
  readonly maxConcurrentMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum non-archived task batches per Team. */
  readonly maxBatches?: number
  /** Maximum admitted automatic recovery attempts over one teammate lifetime. */
  readonly maxRecoveryAttempts?: number
  /** Maximum normalized UTF-16 code units in each batch name or description. */
  readonly maxBatchTextLength?: number
  /** Maximum normalized UTF-16 code units in task completion evidence. */
  readonly maxTaskResultLength?: number
  /** Maximum queued-minus-delivered messages for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds allowed for Team-owned runtime disposal. */
  readonly disposalTimeoutMs?: number
}

/** Input for creating one durable teammate. */
export interface SpawnTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  readonly signal: AbortSignal
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for one durable peer message. */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  readonly delivery: 'quiet' | 'wakeup'
  readonly signal: AbortSignal
}

/** Result after a peer message enters the durable mailbox. */
export interface SendTeamMessageResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: string
  /** Required completion evidence for the `complete` action. */
  readonly result?: string
}

/** Browser task mutation result with stale revisions kept distinct from other Team rejections. */
export type TeamTaskMutationResult =
  | { readonly ok: true; readonly value: TeamTaskView }
  | {
    readonly ok: false
    readonly error: {
      readonly code: 'team-task-conflict' | 'team-rejected'
      readonly message: string
    }
  }

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole pinned integration request and its durable execution phase. */
    'team/integration': { version: 1; teamId: TeamId; integration: TeamIntegrationSnapshot }
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 1; teamId: TeamId; member: TeamMemberSnapshot }
    /** Recovery admission recorded before interrupting or waking a worker. */
    'team/recovery': { version: 1; teamId: TeamId; recovery: TeamRecoverySnapshot }
    /** Whole task-batch membership and archive state, retained across Lead restarts. */
    'team/batch': { version: 1; teamId: TeamId; batch: TeamBatchSnapshot }
    /** Whole worker-worktree ownership value, recorded before Git mutations. */
    'team/worktree': { version: 1; teamId: TeamId; worktree: TeamWorktreeSnapshot }
    /** Whole shared-task value, stored only in the Team Lead Session. */
    'team/task': { version: 1; teamId: TeamId; task: TeamTaskSnapshot }
    /** Durable mailbox enqueue, stored before delivery is attempted. */
    'team/message/queued': { version: 1; teamId: TeamId; message: TeamMessageSnapshot }
    /** Durable acknowledgement that the target Session recorded the message. */
    'team/message/delivered': {
      version: 1
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
  }
}
