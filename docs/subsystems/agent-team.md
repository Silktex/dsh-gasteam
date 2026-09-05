# Agent Teams

English | [中文](agent-team.zh.md)

Types shared by the experimental implicit-root Team domain, model tools, and host adapters. The [Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns identity, mailbox, task, and shared-checkout decisions; this page records the literal durable forms from [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts).

## Identity and roster

`TeamId` is the root `SessionId` under a distinct [brand](core.md#branded-ids). `TeamTaskId` is Team-local and monotonically allocated as `task-<n>`; `TeamMessageId` is globally random. A teammate's Session id remains its persistent identity, while `name` is an immutable model/UI label.

```ts type-equiv
/** Whole durable value written on every teammate lifecycle change. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

Every member starts in `provisioning` and reaches exactly one terminal roster phase, `active` or `failed`. Runtime `running`/`idle`/`inactive` status is derived separately and never rewrites this record.

## Durable mailbox

The Lead Session first stores the complete queued message. A target receipt is acknowledged only after its pending inbox item or recorded user message is durable, leaving queued-minus-delivered as the recovery mailbox.

```ts type-equiv
/** One peer message retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly delivery: 'quiet' | 'wakeup'
  readonly content: ContentBlock[]
}
```

The target Session keeps message identity and sender attribution on both the pending inbox item and the eventual user message. Folding that source across inbox and history is the target-side de-duplication key; the model-visible framing repeats the id and sender.

```ts type-equiv
/** Source retained by the target Session for durable mailbox de-duplication. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}
```

## Shared task DAG

Every task event stores a complete snapshot. `revision` is the compare-and-set value and increments by one per mutation. `blockedBy` edges must name non-deleted tasks and keep the graph acyclic. `writeScopes` are normalized advisory path prefixes rather than locks.

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
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
```

`pending` is unstarted or released, `in_progress` carries an owner, `completed` satisfies blockers, and `deleted` is a retained tombstone. Views add owner name, readiness, and write-scope overlap warnings without changing the durable snapshot.

## Replay

`agentTeam` Session projection replays one root Session into the roster, task board, and queued-minus-delivered mailbox that every Team operation reads. It selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state. Session event `seq` and `time` remain the ordering and timing record; Team snapshots do not duplicate them. Roster and task reads reach callers as views; pending mail stays internal to delivery and recovery. The package [README](../../packages/experimental/agent-team/README.md) owns operation, authorization, recovery, and limit behavior.

## Workspace, integration, recovery, and batch records

Worktree records retain immutable creation inputs and release state. Integration records pin the source commit and verification commands; target and candidate commits are added at their durable execution phases. Recovery counters retain admitted attempts. Batch progress derives from the referenced task states.

```ts type-equiv
/** Resolved Git worktree identity; all paths are absolute. */
interface TeamWorktreeSpec {
  readonly repository: string
  readonly cwd: string
  readonly branch: TeamBranchName
  readonly baseCommit: TeamCommitId
}
```

```ts type-equiv
/** Durable workspace ownership, retained after release for recovery and audit. */
interface TeamWorktreeSnapshot extends TeamWorktreeSpec {
  readonly memberId: SessionId
  readonly provider: string
  readonly phase: 'reserved' | 'ready' | 'released'
}
```

```ts type-equiv
/** Git workspace operations contributed by an explicitly mounted provider. */
interface TeamWorktreeProvider {
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
```

```ts type-equiv
/** Durable identity of one pinned integration request. */
type TeamIntegrationId = Branded<'TeamIntegrationId'>
```

```ts type-equiv
/** Explicit executable verification step; arguments are never interpreted by a shell. */
interface TeamVerificationCommand {
  readonly command: string
  readonly args: string[]
}
```

```ts type-equiv
/** Immutable integration inputs resolved before queue admission. */
interface TeamIntegrationSpec {
  readonly repository: string
  readonly cwd: string
  readonly sourceBranch: TeamBranchName
  readonly sourceCommit: TeamCommitId
  readonly targetBranch: TeamBranchName
  readonly verification: TeamVerificationCommand[]
}
```

```ts type-equiv
/** Durable integration progress; verified candidates survive ambiguous promotion failures. */
interface TeamIntegrationSnapshot extends TeamIntegrationSpec {
  readonly id: TeamIntegrationId
  readonly memberId: SessionId
  readonly provider: string
  readonly phase: 'queued' | 'running' | 'verified' | 'merged' | 'failed'
  readonly targetCommit?: TeamCommitId
  readonly candidateCommit?: TeamCommitId
  readonly error?: string
}
```

```ts type-equiv
/** Provider operations for isolated verification and recoverable fast-forward promotion. */
interface TeamIntegrationProvider {
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
```

```ts type-equiv
/** Durable recovery-attempt counter; admitted failures also consume an attempt. */
interface TeamRecoverySnapshot {
  readonly memberId: SessionId
  readonly attempt: number
  readonly observedEventCount: number
  readonly reason: string
}
```

```ts type-equiv
/** Observed worker progress required for compare-and-set recovery admission. */
interface RecoverTeammateRequest {
  readonly target: string
  /** Child event count, or -1 when no child Activation is resident. */
  readonly observedEventCount: number
  readonly reason: string
}
```

```ts type-equiv
/** Durable identity of one named Team task batch. */
type TeamBatchId = Branded<'TeamBatchId'>
```

```ts type-equiv
/** Durable task membership and archive state for a named batch. */
interface TeamBatchSnapshot {
  readonly id: TeamBatchId
  readonly revision: number
  readonly name: string
  readonly description: string
  readonly taskIds: TeamTaskId[]
  readonly archived: boolean
}
```

```ts type-equiv
/** Batch progress projected from current task states. */
interface TeamBatchView extends TeamBatchSnapshot {
  readonly completedTasks: number
  readonly status: 'active' | 'completed' | 'archived'
}
```

```ts type-equiv
/** Inputs for one durable task batch. */
interface CreateTeamBatchRequest {
  readonly name: string
  readonly description: string
  readonly taskIds: readonly TeamTaskId[]
}
```

```ts type-equiv
/** Compare-and-set edits or permanent archival of one task batch. */
interface UpdateTeamBatchRequest {
  readonly batchId: TeamBatchId
  readonly expectedRevision: number
  readonly name?: string
  readonly description?: string
  readonly taskIds?: readonly TeamTaskId[]
  readonly archive?: boolean
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its root, Team identity, role, and model-facing name.
 */
membership(agent: Agent): TeamMembership

/**
 * List the runtime-enriched roster visible to one Team member.
 * @param agent - exact live Team member.
 * @returns Lead and teammate rows in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create one named, continuable direct child of the Team Lead.
 * @param caller - exact live Lead Agent.
 * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
 * @returns the active roster row.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Register a Git-worktree provider in the calling plugin's effect scope.
 * @param provider - provider for explicitly configured worker isolation.
 * @returns registration disposer; removal prevents subsequent provider lookups.
 */
registerWorktreeProvider(provider: TeamWorktreeProvider): () => Promise<void>

/**
 * Release a quiescent worker checkout after its commits reach the Lead branch.
 * @param caller - exact live Lead authorizing removal.
 * @param target - immutable teammate name, including a failed provision.
 * @param signal - caller cancellation through safe cleanup.
 */
async releaseWorktree(caller: Agent, target: string, signal: AbortSignal): Promise<void>

/**
 * Queue one durable peer message, then attempt immediate delivery.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, scheduling mode, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Return one task, including a deleted tombstone.
 * @param caller - exact live Team member reading the task.
 * @param id - Team-local task identity.
 * @returns the latest task value and derived readiness diagnostics.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * List current non-deleted tasks in numeric creation order.
 * @param caller - exact live Team member reading the board.
 * @returns detached current task views.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Compare-and-set one authorized task transition.
 * @param caller - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Register one integration provider under the mounting plugin effect scope.
 * @param provider - integration implementation.
 * @returns scoped registration disposer.
 */
registerIntegrationProvider(provider: TeamIntegrationProvider): () => Promise<void>

/**
 * Queue committed output from a quiescent worker.
 * @param caller - exact live Lead.
 * @param target - durable teammate name.
 * @param signal - caller cancellation.
 * @returns pinned integration request.
 */
async enqueueIntegration(caller: Agent, target: string, signal: AbortSignal): Promise<TeamIntegrationSnapshot>

/**
 * Run or recover the oldest pending integration.
 * @param caller - exact live Lead.
 * @param signal - caller cancellation.
 * @returns resulting integration record, or undefined for an empty queue.
 */
async runIntegration(caller: Agent, signal: AbortSignal): Promise<TeamIntegrationSnapshot | undefined>

/**
 * Abandon a blocked integration while retaining its candidate checkout.
 * @param caller - exact live Lead.
 * @param id - unfinished integration identity.
 * @param reason - durable abandonment explanation.
 * @param signal - caller cancellation.
 * @returns failed terminal record.
 */
async abandonIntegration(caller: Agent, id: TeamIntegrationId, reason: string, signal: AbortSignal): Promise<TeamIntegrationSnapshot>

/**
 * Read durable integration history.
 * @param caller - exact live Team member.
 * @returns detached queue and terminal records.
 */
listIntegrations(caller: Agent): TeamIntegrationSnapshot[]

/**
 * Restart an unchanged worker that still owns unfinished tasks.
 * @param caller - exact live Lead.
 * @param request - observed progress and durable recovery instruction.
 * @param signal - cancellation through interruption and follow-up admission.
 * @returns admitted attempt, counted even if subsequent delivery fails.
 */
async recoverTeammate(caller: Agent, request: RecoverTeammateRequest, signal: AbortSignal): Promise<TeamRecoverySnapshot>

/**
 * Create a named durable task batch.
 * @param caller - exact live Lead.
 * @param request - batch metadata and current task ids.
 * @returns committed batch with derived progress.
 */
async createBatch(caller: Agent, request: CreateTeamBatchRequest): Promise<TeamBatchView>

/**
 * Update or archive a batch using its current revision.
 * @param caller - exact live Lead.
 * @param request - compare-and-set mutation.
 * @returns committed batch with derived progress.
 */
async updateBatch(caller: Agent, request: UpdateTeamBatchRequest): Promise<TeamBatchView>

/**
 * Read active and archived durable batches.
 * @param caller - exact live Team member.
 * @returns batches with progress derived from the current task board.
 */
listBatches(caller: Agent): TeamBatchView[]

/**
 * Wait for the next Team-domain or member-status change.
 * @param caller - exact live Team member waiting for activity.
 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
 * @param signal - caller cancellation for the wait only.
 * @returns one observed change or a timeout result.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>

/**
 * Interrupt one live teammate turn without clearing its pending inbox.
 * @param caller - exact live Lead Agent.
 * @param targetName - durable teammate name.
 * @returns the target status sampled before cancellation.
 */
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'idle' | 'inactive' }

/**
 * Resolve a caller without throwing, used by scoped-tool installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for non-Team subagents and stale identities.
 */
tryMembership(agent: Agent): TeamMembership | undefined

/**
 * Read the current roster and non-deleted task board through the generated Remote API.
 * @param agent - exact live Team member used as the authority credential.
 * @returns detached current roster and task views.
 */
@Remote('view') remoteView(agent: Agent): TeamView

/**
 * Create one shared task through the generated Remote API.
 * @param agent - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task or a typed Team rejection.
 */
@Remote('createTask') remoteCreateTask(agent: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskMutationResult>

/**
 * Apply one task mutation and preserve Team rejections as business results.
 * @param agent - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed task or a typed Team rejection.
 */
@Remote('updateTask') remoteUpdateTask(agent: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskMutationResult>
```

Types: [Agent](core.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
