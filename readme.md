# DSH GasTeam

Agent Teams for DeepSeek Harness: named teammates, durable messages, a shared task board, task batches, optional Git worktrees, verified integration, and bounded worker recovery. The Web UI shows the roster, task evidence, batch progress, and integration state.

This repository contains only the plugin packages, build scripts, and tests. **No DeepSeek Harness source checkout is required.** It uses the published `@deepseek-ai/dsh@0.1.2-rc.1` runtime and two small, version-pinned dependency patches.

## Install

Requirements: Git, Node.js `^22.19` or `>=24`, pnpm 11, and access to this private repository. Git worktree integration is tested on Linux.

```sh
gh repo clone Silktex/dsh-gasteam ~/projects/gasteam -- --depth 1
cd ~/projects/gasteam
pnpm install --frozen-lockfile
pnpm build
pnpm install:profile
pnpm start
```

`install:profile` links the five built Team packages into your existing `web` profile under `$DSH_HOME/profiles/web` (`~/.dsh/profiles/web` by default). It adds the host and Web bundle layers and preserves the other installed plugins. Stop an already-running Web service before starting another server on its port.

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

Failed and successful candidate checkouts are retained for inspection and manual cleanup. Worker release refuses dirty, ignored, or unmerged output, a live child, unfinished assigned tasks, or queued mail. Recovery preserves task ownership and is bounded by a durable per-worker attempt limit.

## Configuration

The `agent-team` row accepts these optional limits:

| Field | Default |
| --- | ---: |
| `maxMembers` | 8 lifetime teammates |
| `maxTasks` | 256 active tasks |
| `maxBatches` | 128 non-archived batches |
| `maxTaskResultLength` | 16,384 UTF-16 code units |
| `maxBatchTextLength` | 16,384 UTF-16 code units |
| `maxRecoveryAttempts` | 3 per teammate lifetime |
| `maxIntegrations` | 32 unfinished jobs |
| `maxPendingMessagesPerMember` | 64 |
| `maxMessageBytes` | 65,536 |
| `disposalTimeoutMs` | 5,000 ms |

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

### Runtime patches

`pnpm-workspace.yaml` applies the patches in `patches/` during installation:

- `dsh-subagent`: allows the Team service to select the child's persisted cwd before activation.
- `dsh-session`: recognizes the four additional Team event kinds during durable replay.

The patches apply only to `0.1.2-rc.1`. Review the patches and run the build, tests, and a profile smoke before changing the runtime version. No runtime source is copied into this repository.

## Layout and license

`packages/agent-team` owns the service; `tool-agent-team` exposes model tools; `client-ui-agent-team` owns the browser panel. `agent-team-profile` and `agent-team-web-profile` provide the corresponding DSH bundle layers. Package names retain their existing `@deepseek-ai/dsh-experimental-*` identities so existing profiles and persisted Team data keep their references.

Derived from DeepSeek Harness's experimental Agent Teams packages. See [LICENSE](LICENSE) for the MIT license.
