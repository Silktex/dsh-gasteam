#Inspired by Gastown
I love [gastown](https://github.com/gastownhall/gastown), but I wanted a simple plugin for deepseek. working on animated pixel agents for visual understanding.

# DSH GasTeam

See the [documentation index](docs/README.md) for installation, usage, and debugging guides.

Agent Teams for DeepSeek Harness: named teammates, durable messages, a shared task board, task batches, optional Git worktrees, verified integration, and bounded worker recovery. The Web UI shows the roster, task evidence, batch progress, and integration state.

This repository contains only the plugin packages, build scripts, and tests. **No DeepSeek Harness source checkout is required.** It uses the published `@deepseek-ai/dsh@0.1.2-rc.1` runtime and two small, version-pinned dependency patches.

## Install

Requirements: Git, Node.js `^22.19` or `>=24`, pnpm 11, and access to this private repository. Git integration and coordinator journals require Linux with util-linux `flock`; manual integration uses the same repository ownership lock.

```sh
gh repo clone Silktex/dsh-gasteam ~/projects/gasteam -- --depth 1
cd ~/projects/gasteam
pnpm install --frozen-lockfile
pnpm build
pnpm install:profile
pnpm start
```

`install:profile` links the five built Team packages into your existing `web` profile under `$DSH_HOME/profiles/web` (`~/.dsh/profiles/web` by default). It adds the host and Web bundle layers and preserves the other installed plugins. Stop an already-running Web service before starting another server on its port.

To validate the distributable packages before touching an existing profile, run `GASTEAM_RELEASE_ROOT=/var/tmp pnpm test:release`. It packs all five plugins, installs them with the published DSH runtime and committed patches into an unrelated consumer and isolated Web/headless profiles, rejects checkout links, runs the actual headless CLI through deterministic worker commit/verification/promotion/release, restarts a deterministic coordinator through a four-task real-Git DAG, and exercises backup, upgrade, and restoration of committed legacy assignment/batch fixtures. See [installation and rollback](docs/installation.md) for the retained evidence and remaining service/registry steps.

Use the [complete autonomous profile patch](examples/autonomous.cordis.patch.yml) as the deployment template after replacing its directory, branch, provider, model, and verification placeholders. The release validator composes this template against the packed profile without starting a model or localhost service.

Open the authenticated URL printed by `dsh`; the usual local address is `http://127.0.0.1:3080`. Configure model credentials through your normal DSH settings or the `DEEPSEEK_API_KEY` environment variable. Keep credentials outside Git.

**Launch through this checkout's `pnpm dsh` or `pnpm start`.** This selects the pinned runtime with the required patches. Installing the plugin links alone does not patch a separate global DSH installation.

For a headless profile:

```sh
pnpm install:profile -- --profile headless
pnpm dsh --profile headless "Create a reviewer teammate, review this repository, and summarize the findings."
```

For an existing systemd user service, set its working directory to `~/projects/gasteam` and use the installed CLI entry:

```ini
WorkingDirectory=%h/projects/gasteam
ExecStart=/absolute/path/to/node %h/projects/gasteam/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open
```

Use your actual Node executable, retain the service's existing environment settings, then run `systemctl --user daemon-reload` and `systemctl --user restart dsh.service`. No server is deployed by the repository's package-install lifecycle.

## Usage

Open a coding session. Its agent is the Team Lead; teammates are created when you request delegated work. The default configuration shares the Lead's checkout.

Example prompts:

- “Create a researcher and an implementer. Have the researcher inspect the design, then send the findings to the implementer.”
- “Create tasks for the API, tests, and documentation. Make documentation depend on the API task.”
- “Group those tasks in a release batch and show its progress.”
- “Ask the reviewer to inspect the result. Require completion evidence for every finished task.”

The Team panel opens from the conversation header. It shows teammates and their status, lets you navigate to a teammate, and provides task creation and editing. Completing a task requires a written result; reopening clears that evidence. Concurrent task edits use revisions, so a stale edit must be refreshed and retried.

The model receives Team-scoped tools:

| Area | Tools |
| --- | --- |
| Teammates | `spawn_teammate`, `list_agents`, `send_message`, `followup_task`, `interrupt_agent`, `wait_agent` |
| Tasks | `team_task_create`, `team_task_list`, `team_task_get`, `team_task_update` |
| Batches | `team_batch_create`, `team_batch_list`, `team_batch_update` |
| Worktrees, when configured | `team_worktree_release` |
| Integration, when configured | `team_integration_enqueue`, `team_integration_list`, `team_integration_run`, `team_integration_abandon` |

Batches derive their progress from task state. Active batches prevent deletion of their referenced tasks. Archived batches retain their historical references. New batch and integration mutations are model-tool operations; the Web panel displays their state.

## Optional worktrees, integration, and recovery

Append these patches to your profile's `cordis.patch.yml`. Replace the absolute worker directory, target branch, and verification commands for the repository where the Team will work. The worker directory must be outside that repository and its parent must already exist.

```yaml
- id: agent-team
  config:
    worktreeProvider: git
    integrationProvider: git

- insert:
    - id: team-worktrees
      name: '@deepseek-ai/dsh-experimental-agent-team/git-worktrees'
      config:
        directory: /absolute/path/outside/repository/team-workers

    - id: team-integration
      name: '@deepseek-ai/dsh-experimental-agent-team/git-integration'
      config:
        targetBranch: master
        verification:
          - command: pnpm
            args: [install, --frozen-lockfile]
          - command: pnpm
            args: [build]
          - command: pnpm
            args: [test]

    - id: team-integration-worker
      name: '@deepseek-ai/dsh-experimental-agent-team/integration-worker'

    - id: team-supervisor
      name: '@deepseek-ai/dsh-experimental-agent-team/supervisor'
      config:
        scanIntervalMs: 1000
        staleAfterMs: 60000
        recoveryMessage: 'Resume your unfinished assigned tasks and report progress.'
```

Restart the profile after changing its composition. Omit the integration worker to run queued jobs explicitly with `team_integration_run`. Omit the supervisor to leave worker recovery manual. These features are opt-in; installation does not enable them globally for every workspace.

Worktrees start from committed Lead HEAD. A worker's cwd persists across later turns and cold restoration. Have workers commit completed changes before enqueueing integration. The queue pins the worker commit, merges in a separate candidate checkout, runs the configured verification commands, and fast-forwards the clean Lead checkout only if the target branch has not moved.

Git commands need appropriate filesystem permissions, including access to the repository's shared Git metadata. A different cwd does not grant additional permissions. Install dependencies inside worker checkouts when their tasks require them. Verification commands are trusted deployment configuration.

Failed, superseded, and uncertain candidate checkouts are retained for inspection and manual cleanup. Worker release refuses dirty, ignored, or unmerged output, a live child, unfinished assigned tasks, or queued mail. Recovery preserves task ownership and is bounded by a durable per-worker attempt limit. Successful candidate cleanup is separately opt-in through coordinator execution retention.

## Configuration

The `agent-team` row accepts these optional limits:

| Field | Default |
| --- | ---: |
| `maxConcurrentMembers` | 8 provisioning or resident teammates |
| `maxMembers` | 4,096 retained immutable teammate names |
| `maxTasks` | 256 active tasks |
| `maxBatches` | 128 non-archived batches |
| `maxTaskResultLength` | 16,384 UTF-16 code units |
| `maxBatchTextLength` | 16,384 UTF-16 code units |
| `maxRecoveryAttempts` | 3 per teammate lifetime |
| `maxIntegrations` | 32 unfinished jobs |
| `maxPendingMessagesPerMember` | 64 |
| `maxMessageBytes` | 65,536 |
| `disposalTimeoutMs` | 5,000 ms |

Concurrent capacity applies to new teammates and wakeups of inactive teammates. Provisioning reserves a slot before runtime creation; an Agent leaving the registry releases its resident slot. Capacity-blocked wakeups remain durably queued and retry when a slot is released, including after failed provisioning. Direct spawn requests that exceed capacity return `TEAM_CONCURRENT_LIMIT`; automatic queuing of dispatch requests belongs to the upcoming scheduler.

`maxMembers` is an independent history guard. Existing explicit values retain their meaning; the default increased from eight to 4,096 so normal turnover is governed by concurrent capacity. Names and historical references are never recycled. Reaching the history guard returns an actionable error to increase `maxMembers`; history archival/pagination is still planned.

Team state requires durable session storage and coordinates agents within one harness process. Work scopes are advisory overlap warnings. The plugin is experimental and has no cross-version compatibility promise.

## Develop and update

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:smoke
```

The build compiles only the five plugin packages. Host and browser RPC declarations share plugin-owned schemas in `packages/agent-team/src/remote-*.ts`; request/result fields are checked against the public TypeScript types. Tests cover task evidence, mailbox ordering, restoration through JSONL persistence, real Git worktrees and integration, recovery, tools, RPC codecs, and the Web UI. The smoke command creates and removes a temporary Git repository and isolated DSH home, and exercises the installed CLI without model credentials. Browser tests load the published runtime factories rather than importing harness source files.

After pulling updates, install dependencies, rebuild, and restart your DSH process. Re-run `pnpm install:profile` if the checkout moved. Do not move a linked checkout while its server is running.

### Autonomous operation

`pnpm test:acceptance` runs the fresh-process autonomous gate after `pnpm build`. It registers a project, accepts work, waits for durable-write acknowledgement, kills the writer, and starts the built coordinator plugin with no browser or pre-opened Lead. The new process restores the coordinator identity, starts accepted work in isolated worktrees, completes a persisted diamond DAG, and recovers across integration and task-receipt crash boundaries. It also resumes a killed in-process worker with its uncommitted edits and completes the dependent DAG. `pnpm test:release` exercises the packed profile and coordinator from an unrelated consumer; see [installation and rollback](docs/installation.md).

The project catalog records validated project policy and team references in `projects.jsonl`. It resolves repository identity through the canonical Git common directory, rejects duplicate ownership of a repository/target pair, and requires explicit verification commands. `assignments.jsonl` adds execution attempts, generation/revision checks, structured checkpoints, and concurrent capacity reservations. Worker reports remain separate from task acceptance, and capacity is held until runtime-stop evidence is recorded. Journals require Linux with util-linux `flock` and reject a second writer. The Team roster now has its own concurrent spawn/wakeup admission limit; the coordinator now invokes that admission path for independent ready tasks when execution is configured. See [the architecture decisions and transition table](docs/autonomous-architecture.md).

The optional `@deepseek-ai/dsh-experimental-agent-team/coordinator` plugin takes an absolute `directory` for its durable workspace and a positive `scanIntervalMs` (default 1000). It publishes `ctx.workspaceCoordinator` only after startup reconciliation, then scans registered Team logs independently of live Agents. Its host API supports `register`, `acceptTask`, `pause`, `reconcile`, and `view`; mutations require an exact live Lead authorized for the selected project. Registration is committed before task admission. Pause state uses revisions and survives restart; missing or malformed registered sessions remain visible as durable, deduplicated reconciliation failures. The coordinator is not enabled by installation. Project model tools expose revision-fenced scheduling controls, including bounded provisioning retry and eligible DSH handoff; dependency-aware dispatch and recovery persist across restart.

Keep coordinator/assignment storage separate from the runtime's JSONL session directory. The internal DSH assignment bridge now starts a Team worker under its reserved session ID, supplies assignment/checkpoint context, records worker reports separately from task acceptance, and awaits runtime drain before retirement. The coordinator uses this bridge for automatic independent-task dispatch; bounded interrupted-worker continuation preserves its runtime identity and worktree.

### Runtime patches

`pnpm-workspace.yaml` applies the patches in `patches/` during installation:

- `dsh-subagent`: allows the Team service to select the child's persisted cwd before activation.
- `dsh-session`: recognizes the four additional Team event kinds during durable replay.

The patches apply only to `0.1.2-rc.1`. Review the patches and run the build, tests, and a profile smoke before changing the runtime version. No runtime source is copied into this repository.

## Layout and license

`packages/agent-team` owns the service; `tool-agent-team` exposes model tools; `client-ui-agent-team` owns the browser panel. `agent-team-profile` and `agent-team-web-profile` provide the corresponding DSH bundle layers. Package names retain their existing `@deepseek-ai/dsh-experimental-*` identities so existing profiles and persisted Team data keep their references.

Derived from DeepSeek Harness's experimental Agent Teams packages. See [LICENSE](LICENSE) for the MIT license.

### Coordinator execution configuration

After enabling the Git worktree provider described above, the coordinator row can opt into execution:

```yaml
- insert:
    - id: workspace-coordinator
      name: '@deepseek-ai/dsh-experimental-agent-team/coordinator'
      config:
        directory: /absolute/path/outside/session-storage/gasteam-workspace
        scanIntervalMs: 1000
        execution:
          modelProvider: your-registered-provider
          model: your-model-id
          maxConcurrent: 8
          dispatchIntervalMs: 1000
          candidateRetention:
            delayMs: 86400000
            commandTimeoutMs: 30000
```

Use the registered project's repository as the Lead cwd and the same model/provider as the execution policy. The coordinator restores unopened Leads through the published runtime, reserves assignment identity and capacity durably, and starts independent pending tasks automatically. Global capacity and each project's registered capacity are enforced. Pause prevents new dispatch; existing workers are not cancelled by pausing.

The workspace view includes `attempts`, durable `executionBlocks`, and `dispatchRequests`. `dispatchStatus` explains each request using the scheduler’s eligibility check: pause, execution configuration, dependencies, ownership, capacity, pacing, or recorded failure. It also links assignments and identifies stopped attempts awaiting acceptance or recovery. `readyTasks` remains the discovery view of independent pending tasks. `dispatch.jsonl` preserves request order, priority, project turns, and the last dispatch time. Projects take fair turns; within a project, higher priority runs first and equal priority follows acceptance/discovery order. `dispatchIntervalMs` sets the minimum time between selections (default zero). An authorized Lead can use the host `reprioritize` operation with the request revision before an attempt exists. A failure before runtime start releases its reservation and retains diagnostics. `execution.retryPolicy` provides pinned bounded provisioning retry and backoff; verification repair uses separate explicit attempts and pinned budgets. Worker reports do not complete managed tasks; ordinary task mutation is rejected and verified coordinator acceptance completes managed tasks. Terminal/stopping attempt wakeups are fenced, including when execution is later disabled. The validated combined autonomous profile is documented in [installation and rollback](docs/installation.md).

`candidateRetention` is disabled unless configured. Once enabled, each accepted submission schedules only its current final merged candidate; the delay starts when the coordinator first observes that merged candidate and is pinned in `candidate-retention.jsonl`. Pausing the project suppresses deletion while retaining the deadline. Cleanup preserves dirty, ignored, untracked, unmerged, active, or uncertain worktrees. An interrupted cleanup is recorded as uncertain and is never automatically retried. Active ownership checks cover canonical live in-process Agents only and provide no external-process ownership proof.

Coordinator health is opt-in. Configure `execution.health` with `dshDeadlineMs`, `externalDeadlineMs`, `escalationCooldownMs`, and `maxEscalationsPerCondition` to record generation-fenced attempt observations and expose a registered-Lead escalation inbox. Observation alone does not infer a stuck tool. Opt-in `execution.health.recovery` enables bounded DSH nudges, and an authorized Lead can hand off an eligible DSH attempt after its nudge budget is exhausted. Dependency/report waits and failed integration become actionable incidents, while intentional cancellation is not critical. Acknowledgement and recovery are revision- and policy-fenced, and accepted receipts clear only the exact generation while retaining history. Provider admission performs bounded version and authentication probes; the dashboard exposes project-scoped health, acknowledgement, retry, handoff, and scheduling controls. No external notification transport is included, and external-provider attempts cannot use DSH handoff.

Enable `@deepseek-ai/dsh-experimental-tool-agent-team/coordinator` after the coordinator plugin to expose `team_dispatch_status`, `team_dispatch_pause`, `team_dispatch_priority`, `team_dispatch_cancel`, `team_dispatch_retry`, and `team_dispatch_handoff` in Lead scopes. Calls require a registered project grant and the current revisions for the selected operation. Browser Remote clients can call `agentTeams.scheduling` and `agentTeams.controlScheduling` with the same Lead identity. These interfaces return project-scoped status and reject cross-project access and stale revisions.

Cancellation uses the current dispatch request revision and requires a reason. Its durable intent excludes queued work from admission across restart. Active work remains reserved until DSH shutdown is confirmed; a failed or timed-out cancellation remains visible and reconciliation continues even while the project is paused. Cancellation preserves task history and worker output and does not mark the task accepted. Read status after a failed call before attempting another control.

With coordinator execution and a Team integration provider configured, scans automatically submit successful stopped code workers using their exact worktree HEAD and report evidence. Registered target and verification commands must match the integration provider. The coordinator runs the next queue job belonging to one of its submissions; the Git provider verifies an isolated candidate and promotes only on success. Failed verification preserves the target and diagnostic; eligible work enters bounded repair, while exhausted work remains blocked. A durable merged job bound to the submission permits task acceptance; accepted prerequisites release dependent tasks on subsequent scans. Both regular tests and the fresh-process gate include a real-Git diamond DAG; midway in-process worker restart now passes in the fresh-process gate.

An integration admission may specify a host-only `reviewGate`. A gated candidate stops after verification until the host authorization callback approves a receipt bound to the integration, source, target, candidate, gate, and review ID; the default policy denies approval. Stale-target retries retain the historical receipt with the superseded candidate, clear the current receipt, and require fresh approval. Background integration workers therefore await host review before promotion.

A task created with `nonCodeCriteria` is report-only work. Its worker report never enters Git submission. The exact registered Lead must supply an acceptance rationale; the coordinator durably records the report, criteria, reviewer, task revision, and attempt revision before it writes a host-authorized task receipt. A crash between those writes replays the pending intent safely. Tasks without `nonCodeCriteria` remain code work and cannot use report acceptance.

Interrupted in-process attempts retain assignment capacity and default to three recovery deliveries after the initial generation, with persisted 1-, 2-, and 4-second delays. `execution.retryPolicy` pins `maxAttempts`, `initialDelayMs`, `multiplier`, and `maxDelayMs` on the first reservation; replacements inherit it. Recovery reuses the existing runtime/worktree and sends checkpoint context through a stable mailbox identity. Health nudges use their own bounded health-recovery ledger and never consume this interrupted-runtime delivery budget. Pending delivery is retried under the same identity; uncertain delivery does not release capacity. Exhausted interrupted rounds produce a stopped attempt requiring recovery.

When an external Git writer advances the target after verification, the integration runner retains the old candidate and durably queues a fresh checkout under the same integration/source identity. It permits three target-movement retries after the initial verification, one round per run/scan. `previousCandidates` exposes each superseded checkout, target, candidate commit, and diagnostic. Exhaustion fails the job visibly; the target-movement retry limit is currently fixed. A crash after promotion still replays the verified candidate before considering a retry.

Coordinator execution accepts `maxRepairAttempts` (0–10, default 3). The first attempt pins that value as `repairLimit`; later configuration changes cannot replenish an in-flight task's budget. A completed, drained worker whose candidate fails merge or verification can produce a new repair attempt with a fresh runtime/worktree. The repair checkpoint includes the original source commit, submission/integration IDs, retained candidate and diagnostic. Repair goes through the same capacity, priority, pause, pacing, submission and verification gates as initial work. Source and candidate history remain available; successful repair accepts only its new submission. Earlier failed submissions remain recorded as queued with failed integration jobs.

Setting the limit to zero disables automatic repair for newly started work. Legacy attempts without a pinned limit and historical failures without a verification classification remain available for explicit recovery instead of acquiring new automatic behavior. Exhaustion leaves a durable execution blocker and pending task; it cannot release dependent tasks. Operator cancellation can stop queued or active repair while preserving failed history. Interrupted candidate verification, explicit integration abandonment, and exhausted target-movement retries require separate recovery. Integration repair has no separately configurable backoff. Provider admission and external-runtime restart, cancellation, usage, and real authenticated Git integration have dedicated conformance evidence; external attempts still require manual recovery where their pinned runtime cannot be safely resumed.
