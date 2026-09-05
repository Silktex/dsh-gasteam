# Usage

Start with a normal coding session. The session's Agent is the Team Lead. Team operations are scoped to the exact live Agent; a task or message does not grant another Lead authority.

## External-runtime restart/cancel conformance

The opt-in restart/cancel fixture creates a disposable repository and may use a
real authenticated Codex account. It is not part of the regular test suite.
Use the local deterministic CLI fixture to exercise its harness without provider
usage:

```sh
GASTEAM_REAL_CODEX_EXECUTABLE="$PWD/packages/agent-team/tests/fixtures/external-runtime-fixture.mjs" \
GASTEAM_REAL_CODEX_VERSION=0.153.4 \
GASTEAM_REAL_CODEX_MODEL=gpt-5.6-codex \
pnpm exec tsx packages/agent-team/tests/fixtures/real-codex-restart-cancel.mts
```

The historical authenticated run under `/tmp/gasteam-real-codex-restart-cancel-vJKz4L`
is evidence for its prior source only. Run this reconstructed fixture with the
real configured executable before treating it as new authenticated evidence.

## Team collaboration

Ask the Lead to use teammates when work should be delegated. The shipped model tools are:

- `spawn_teammate`, `list_agents`, `wait_agent`, and `interrupt_agent` for roster work.
- `send_message` for quiet or wakeup mail. A successful send is durable even when its immediate status is `queued`; do not resend the same request.
- `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update` for revision-checked tasks and completion evidence.
- `team_batch_create`, `team_batch_list`, and `team_batch_update` for task groups.
- `team:policy` for the scoped collaboration rules supplied to the model.

Example prompts:

```text
Create a researcher and an implementer. Give the implementer the research as a dependent task.
Ask the reviewer to inspect the implementation and require completion evidence.
```

Task write scopes are advisory overlap warnings. Dependencies control readiness, while task revisions fence stale updates. Completing a task requires written evidence; reopening clears that evidence.

## Register a project and submit dependent work

Project registration is a host coordinator operation; there is no shipped model tool or CLI command that fabricates a project grant. The exact live registered Lead supplies a request equivalent to:

```ts
await ctx.workspaceCoordinator.register(lead, {
  id: 'website',
  repository: '/absolute/path/to/repository',
  targetBranch: 'main',
  teamIds: [lead.id],
  capacity: 2,
  verification: {
    revision: 1,
    commands: [{ command: 'pnpm', args: ['test'] }],
  },
})
```

Registration resolves the real Git repository and common directory, checks the target branch and verification policy, and commits the project before task admission. A repository/target pair has one owner. The current Lead-scoped registration API registers only that Lead; adding Teams to an existing project has no shipped operator control yet. The coordinator `view` exposes the project, Team reconciliation, attempts, dispatch requests, submissions, reports, workflows, and retention records.

Create two tasks with the model tools, then make the second depend on the first using its current revision:

```json
{"subject":"Update API","description":"Implement the API change.","write_scopes":["src/api"]}
{"subject":"Update client","description":"Use the API change.","blocked_by":["<api-task-id>"],"write_scopes":["src/client"]}
```

The exact tool request fields are `team_task_create.subject`, `description`, optional `non_code_criteria`, `blocked_by`, and `write_scopes`. `team_task_update` requires `task_id` and `expected_revision`; use its latest task view before changing `blocked_by`, result, ownership, or status. A dependent task becomes ready only after its prerequisite reaches accepted/completed state through the relevant acceptance path.

Group the task IDs with `team_batch_create`:

```json
{"name":"release-42","description":"API and client change","task_ids":["<api-task-id>","<client-task-id>"]}
```

Use `team_batch_list` to read progress and `team_batch_update` with `batch_id` and `expected_revision` to rename, describe, or archive it. Batch state follows task state; archiving does not erase historical task references.

## Worktrees and integration

With the Git worktree provider enabled, workers start from committed Lead HEAD in isolated checkouts. Commit completed work before integration. The optional integration tools are:

- `team_worktree_release` releases a quiescent worker checkout after its output is integrated.
- `team_integration_enqueue` pins the worker commit, repository, target branch, and verification policy.
- `team_integration_list` reads queued, running, verified, merged, and failed records.
- `team_integration_run` verifies an isolated candidate and promotes it when checks pass.
- `team_integration_abandon` records an explicit abandonment reason.

Failed, superseded, dirty, ignored, untracked, unmerged, active, and uncertain candidates remain available for inspection. An integration with `reviewGate` stops after verification until the host authorizes a receipt bound to the exact source, target, candidate, gate, and review ID. A stale-target retry requires fresh approval and retains historical receipt evidence.

## Coordinator execution

The coordinator plugin is an opt-in host service. It discovers registered Teams after startup, persists project and assignment state, and scans without requiring a browser or an open Lead. Configure a project with its canonical repository, target branch, verification commands, Team IDs, and capacity through the host coordinator API. Its host operations are `register`, `acceptTask`, `pause`, `reconcile`, and `view`; the model-facing scheduling tools expose status, pause/resume, priority, and cancellation when the coordinator tool plugin is enabled.

Execution dispatches independent pending tasks under global and project capacity. Pause blocks new dispatch while existing workers continue. Code tasks remain pending until their exact submission is verified and accepted. Non-code tasks with immutable `nonCodeCriteria` use the separate report review and acceptance path.

`shutdownDeadlineMs` is a top-level coordinator setting (default `30_000`, maximum `2_147_483_647`). It bounds observation of the *entire* coordinator close sequence, including any in-flight scan and all workflow, execution, batch, catalog, and journal closes. Expiry does not release the coordinator lock or claim that workers stopped: a later close joins the same retained shutdown operation and releases ownership only after it completes.

### Selected-project external provider

An operator may opt one already registered project into the external Codex provider. Register the project first, then configure one canonical provider policy on the coordinator host:

```ts
execution: {
  // other execution fields
  externalCodex: {
    projectId: 'research',
    directory: '/var/lib/dsh/external',
    cwd: '/repos/research',
    codeWorktreeDirectory: '/var/lib/dsh/external-worktrees', // optional code-task opt-in
    executable: '/usr/local/bin/codex',
    version: '0.153.4',
    model: 'gpt-5.6-codex',
    sandbox: 'workspace-write',
    maxSpoolBytes: 65_536,
    terminateGraceMs: 30_000,
  },
}
```

`cwd` must canonically equal the selected registered project's repository. At startup the host verifies the configured executable's version and local authentication status before reserving new work; that preflight does not start a model turn. Explicit non-code tasks in the selected project use this provider. The admitted executable, version, model, sandbox, repository, spool limit, and cancellation grace are pinned in each assignment. Other projects retain normal DSH routing; selected-project code tasks do too unless the code worktree option below is set.

Set `codeWorktreeDirectory` only to opt that same project’s code tasks into the external provider. It must be a canonical directory outside the repository. Each code attempt writes an immutable worktree intent before Git creates its checkout, then records a separate completion receipt only after the `git worktree add` process has closed and the exact branch identity is verified. If recovery finds intent without that completion receipt, it retains ownership and blocks launch or checkout adoption; resolve the provision boundary before retrying. A completed external code task enters the ordinary verified integration path with its exact provider-owned checkout, branch, base commit, and runtime receipt.

For an explicit live conformance check, run the disposable harness only after selecting an account-available CLI model. It creates a temporary repository and provider state, submits one bounded one-file/one-commit task, and prints a sanitized evidence record with durable identities, spool byte counts, and any provider-reported usage fields. It does not estimate cost or print authentication output.

```sh
GASTEAM_REAL_CODEX_EXECUTABLE="$(realpath "$(command -v codex)")" \
GASTEAM_REAL_CODEX_VERSION=0.153.4 \
GASTEAM_REAL_CODEX_MODEL=gpt-5.4-mini \
node --import tsx packages/agent-team/tests/fixtures/real-codex-conformance.mts
```

If a restart finds retained external work but current admission is unavailable or differs from its pinned policy, the coordinator enters recovery-only mode for that project. It can observe or safely stop the retained helper, but it blocks every new selected-project non-code task with `provider-admission`; it never falls back to DSH. Restore the exact admitted policy to resume dispatch. Legacy external journal records without a pinned policy remain readable and intentionally require manual recovery.

Set `execution.candidateRetention` only when automatic cleanup is desired. The delay starts when the coordinator first observes the current final accepted merged candidate, not from a merge timestamp. Pause suppresses deletion. Cleanup records uncertain interrupted work and does not automatically retry it; ownership checks cover live in-process Agents only.

## Workflow vertical slice

The coordinator runtime includes the built-in `investigation-report@1` and `implementation-test-review-integration@1` workflows. A registered Lead can create, inspect, and resume them through the coordinator host controls or Remote operations (`createWorkflow`, `inspectWorkflow`, `resumeWorkflow`). The report workflow hands an accepted report to the next managed task with the report criteria, rationale, and durable receipt ID.

Workflow definitions use the versioned JSON files in [`workflows/`](../workflows/): `investigation-report.json`, `implementation-test-review-integration.json`, and `release-publication.json`. The host validates and pins the exact substituted JSON definition for each execution, including its parameters, dependencies, artifacts, acceptance rules, and retry policy.

Use `team_workflow_create` with one of these requests:

```json
{"project_id":"<project-id>","workflow_kind":"investigation-report","question":"Which API behavior needs changing?"}
```

```json
{"project_id":"<project-id>","workflow_kind":"implementation-test-review-integration","subject":"Implement the agreed API change"}
```

Omitting `workflow_kind` selects the report workflow and still requires `question`. The code workflow requires `subject`. Inspect the returned execution with `team_workflow_inspect` using `execution_id`; `team_workflow_resume` reconciles persisted receipts and task admissions after interruption.

The code workflow creates a managed implementation task, submits its pinned commit, and verifies it using the project's configured Git checks. A verified candidate waits for a fresh reviewer task. The registered Lead reviews that report with `team_report_status` and records `team_report_accept` with the current attempt/task revisions, a rationale, and an explicit `decision` of `approved` or `rejected`. Approval applies only to that report's exact source, target, candidate, integration, and gate. Rejection preserves the report audit and prevents promotion. Only actual verified integration completes the implementation task and workflow.

Target changes require verification and a fresh review of the replacement candidate. Authorized verification repairs retain the original failed source and attempt history, reuse the implementation task, and require review of the repaired candidate. Repair limits remain pinned to the admitted policy and workflow budget.

`release-publication@1` is available only when a trusted server configures publication grants and an idempotent publisher before project registration. Its prepare task produces an explicitly accepted non-code release manifest. The publisher consumes that durable manifest artifact; it does not infer authorization from report acceptance.

The configured grant binds the project, Lead, and `release-manager` authority. The server calls `authorizeWorkflowPublication` with the execution/step IDs, current revision, and authorization evidence. This operation is absent from model tools and Remote descriptors. Paused projects cannot authorize or resume publication. Publisher identity/revision and grants remain pinned: incompatible configuration fails closed on restart or invocation.

A publisher must deduplicate the supplied idempotency key and return a receipt bound to that exact key, manifest, authorization evidence, and publisher identity/revision. Known failures and uncertain caught errors leave a durable failed step; periodic scans do not repeat the effect. A process interrupted after the effect but before its receipt may replay the same key. These host-boundary semantics are tested with an idempotent fixture publisher; no built-in real external release transport or real publication conformance is claimed. Full session handoff and external-provider coordinator controls remain unfinished.

The browser panel shows roster, task, batch, integration, and recovery state when the Web profile is installed. A complete autonomous release profile, dashboard controls for every coordinator operation, globally ordered integration backlog, and external runtime/provider conformance remain unfinished.

## Coordinator controls and acceptance

The shipped coordinator Remote operations are `view`, `createTask`, `updateTask`, `scheduling`, `controlScheduling`, `createWorkflow`, `inspectWorkflow`, `resumeWorkflow`, `reviewReports`, and `acceptReport`. `scheduling` takes `{projectId}`. `controlScheduling` takes a project ID, current control/request revision, and one action: pause/resume, cancel with a reason, or reprioritize with a priority. The model tools expose scheduling status and controls as `team_dispatch_status`, `team_dispatch_pause`, `team_dispatch_priority`, and `team_dispatch_cancel` when the coordinator tool plugin is enabled.

For a non-code task, set immutable `non_code_criteria` when creating it. Review with the registered Lead's `reviewReports({projectId})`, then accept the exact report using its attempt generation, expected attempt revision, expected task revision, and a nonempty rationale. The acceptance writes durable report evidence before the Team receipt and releases dependents only after the receipt is accepted. Code tasks cannot use report acceptance; they require pinned submission, verification, and integrated acceptance.

The host-only `submit` operation and project `register` operation are intentionally absent from model tools. Dashboard controls for project registration, full coordinator views, and health operations are not a substitute for those host APIs; the Web panel currently displays the shipped Team surfaces, while the complete autonomous dashboard remains unfinished. See [the architecture decisions](autonomous-architecture.md) and [completion evidence](completion-evidence.md) for the authority and acceptance boundaries.

## Workspace batches across projects

Workspace batches are a coordinator service feature for work that spans registered projects. They require a configured `workspaceOperatorId`; the exact live Agent with that ID is the only authority that can plan, inspect, subscribe to, acknowledge, or read the batch inbox. A model tool never grants this authority.

Register each repository independently with its own Team, capacity, and verification policy. For example, a host can register two repositories before opening a cross-project batch:

```ts
await ctx.workspaceCoordinator.register(leadA, {
  id: 'api', repository: '/repos/api', targetBranch: 'main', teamIds: [leadA.id], capacity: 2,
  verification: { revision: 1, commands: [{ command: 'pnpm', args: ['test'] }] },
})
await ctx.workspaceCoordinator.register(leadB, {
  id: 'web', repository: '/repos/web', targetBranch: 'main', teamIds: [leadB.id], capacity: 1,
  verification: { revision: 3, commands: [{ command: 'pnpm', args: ['test:e2e'] }] },
})
```

With the coordinator configured with `workspaceOperatorId: leadA.id`, that operator can ask its enabled coordinator tool plugin to plan a batch. The server validates registered project and Team ownership, persists the plan before task admission, and rejects cycles, including cycles formed by separate batches.

```json
{
  "batch_id": "api-then-web",
  "name": "Ship API before client",
  "subscribe": true,
  "items": [
    { "id": "api", "project_id": "api", "team_id": "<lead-a>", "subject": "Add API", "description": "Implement and verify the API." },
    { "id": "web", "project_id": "web", "team_id": "<lead-b>", "subject": "Use API", "description": "Integrate the accepted API.", "depends_on": ["api"] }
  ]
}
```

Use `team_workspace_batch_plan`, `team_workspace_batch_inspect`, `team_workspace_batch_subscribe`, `team_workspace_batch_inbox`, and `team_workspace_batch_ack` only from that configured operator. The typed Remote surface exposes the corresponding five operations: `agentTeams/planWorkspaceBatch` with the plan above, `agentTeams/inspectWorkspaceBatch` with `{ "batchId": "api-then-web" }`, `agentTeams/subscribeWorkspaceBatch` with `{ "batchId": "api-then-web", "subscriptionId": "operator" }`, `agentTeams/workspaceBatchInbox` with `{}`, and `agentTeams/acknowledgeWorkspaceBatchNotification` with `{ "intentId": "..." }`. Each derives the caller from the authenticated Agent Remote context and checks it is the configured `workspaceOperatorId`; none accepts an operator ID in its request. A dependent item may be admitted durably, but dispatch remains blocked until every referenced item is accepted. Code items become accepted only after their pinned submission is verified and integrated; non-code items require their immutable reviewed-report acceptance.

Inspection returns `readyWithoutActiveAssignment` for actionable work and bounded item/history data. Large `items` and histories are explicitly truncated by the tool response; use the coordinator's durable records for complete operator investigation. Completion subscriptions create an in-app operator notification intent. Acknowledging it records a durable receipt. If a completed batch reopens before an undelivered intent is acknowledged, that old intent is suppressed; a later completion creates a new completion epoch and notification.

For the example, inspection initially shows two required items with no actionable dependent work, and coordinator status reports `workspace-batch-dependency` for `web`. After `api` is accepted, `web` receives its one assignment; after both are accepted, inspection reports `{ "phase": "completed", "required": 2, "completedRequired": 2, "completionEpoch": 1 }`. The in-app inbox then contains the completion intent until the acknowledgement request succeeds.

The Web session header now includes a read-only workspace dashboard for the configured operator. It uses `agentTeams/workspaceDashboard` with `{}` and shows projects, attempts, workflow steps, cross-project batches, dispatch blockers, integration results, and health incidents. Project/attempt selection filters the view; refresh reloads the authorized snapshot. Collections show explicit truncation notices. Workspace mutations, cursor pagination, and a reconnecting activity feed remain unfinished. Batch mutations remain available through the typed Remote/model operations above.


## Opt-in stale-operation nudges

Within the coordinator's existing `execution.health` configuration, set `recovery: { maxNudges: 1 }` to enable bounded DSH nudges. Omit `recovery` to keep health observational. The per-generation budget is pinned by the first durable recovery intent. A nudge requires the same live tool operation to remain stale beyond its configured DSH deadline, with exact assignment, Lead, runtime, task and health authority rechecked before delivery. Paused projects, acknowledged incidents, uncertain ownership, changed progress and unavailable runtimes do not authorize a nudge.

Delivery uses one reserved durable Team message ID; replay cannot consume another recovery count or enqueue the same message twice. Exhaustion leaves the escalation visible and allows other projects to continue. This stage does not perform handoff, replacement, or external-provider recovery. Those stages remain unfinished.
