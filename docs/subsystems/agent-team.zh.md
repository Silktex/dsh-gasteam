# Agent Teams

[English](agent-team.md) | 中文

实验性隐式 Root Team 领域、模型工具与宿主适配器共享的类型。[Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、task 与共享 checkout 决策；本页记录 [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts) 中的字面持久形式。

## 身份与 roster

`TeamId` 是具有独立[品牌](core.zh.md#branded-ids)的 Root `SessionId`。`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 是全局随机值。teammate 的 Session id 始终是持久身份，而 `name` 是不可变的模型／UI 标签。

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

每个 member 都从 `provisioning` 开始，并且只到达一个终态 roster phase：`active` 或 `failed`。运行时 `running`／`idle`／`inactive` 状态单独派生，绝不会重写该记录。

## 持久 mailbox

Lead Session 首先存储完整 queued message。只有 target 的 pending inbox 条目或已记录用户消息完成持久化，才会写入独立 acknowledgement event，queued-minus-delivered 因而构成恢复 mailbox。

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

target Session 会在 pending inbox 条目和最终用户消息上保留消息身份与发送者归因。跨 inbox 与历史折叠该 source 构成 target 侧去重键；模型可见的 framing 会重复 id 和发送者。

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

## 共享任务 DAG

每条 task event 都存储完整快照。`revision` 是 compare-and-set 值，每次变更递增 1。`blockedBy` edge 必须指向未删除任务，并维持无环图。`writeScopes` 是规范化的提示性路径前缀，不是锁。

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

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`completed` 满足 blocker，`deleted` 是保留的 tombstone。view 会添加 owner name、readiness 和 write-scope 重叠警告，但不会改变持久快照。

## 回放

`agentTeam` Session projection 把一个 Root Session 回放成每个 Team 操作所读取的 roster、任务板与 queued-minus-delivered mailbox。它按 `TeamId` 选取记录，因此普通 fork 继承的 event 保留 ancestor id，绝不会进入新 Root 的状态。Session event 的 `seq` 与 `time` 继续负责顺序和时间记录，Team snapshot 不再重复保存它们。roster 与 task 读取以 view 形式到达调用方，而 pending 邮件仅供投递与恢复内部使用。包 [README](../../packages/experimental/agent-team/README.zh.md)负责 operation、authorization、recovery 和限制行为。

## 工作区、集成、恢复与批次记录

Worktree 记录保留不可变创建输入和释放状态。集成记录固定源 commit 与验证命令；目标和候选 commit 在对应持久执行阶段添加。恢复计数器保留已接纳尝试。批次进度从引用任务的状态派生。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
