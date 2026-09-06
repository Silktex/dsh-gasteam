# Debugging

Use read-only inspection first. Keep coordinator journals separate from DSH session storage, preserve worker directories, and avoid deleting JSONL or Git metadata while diagnosing a failure.

## Startup and profile

Confirm the process uses this checkout's runtime and profile:

```sh
pwd
node --version
pnpm --version
pnpm dsh --profile web --no-open --help
```

If Team tools are missing, check that `pnpm build` completed and that the profile contains the linked `agent-team`, `tool-agent-team`, and profile bundle layers. Re-run `pnpm install:profile` only after stopping the profile service. A separate global `dsh` command may load a different runtime and omit the pinned patches.

If the coordinator does not start, verify its `directory` is absolute, writable by the service user, and separate from session storage. On Linux, verify `flock` is available. A second coordinator writer for the same journal is rejected; stop the competing process only after identifying it through the service manager or process supervisor.

Evidence to collect: the exact profile name, `DSH_HOME`, checkout revision, `pnpm build` output, and the coordinator directory listing. A healthy profile has the expected linked Team package names and starts the host service without duplicate-writer errors. A missing package link or stale runtime points to an incomplete build/profile install; a journal lock error points to another writer or an unclean process boundary.

## Tasks, mail, and workers

If a task is ready but does not run, inspect `team_task_list`, `team_task_get`, and the coordinator `view` or scheduling status. Common durable blockers are project pause, dependency acceptance, global/project capacity, dispatch pacing, an existing owner, cancellation, and a prior execution failure. A task's ready flag is discovery state; readiness alone does not start an owner.

For an undiscovered project, inspect `projects.jsonl` and the coordinator reconciliation entry for its Team. `available` with a ready task is healthy discovery; `unavailable` includes a durable diagnostic and requires correcting the registered session or project path before retrying `reconcile`. For a capacity stall, compare active attempts with `maxConcurrent` and project capacity; do not raise limits by deleting assignment history.

If a message returns `queued`, retain its `messageId` and inspect the recipient's durable Team view before sending again. Queued means the message was durably admitted; dispatch may be waiting for a cold target, capacity, or an in-flight recovery operation. Re-sending can duplicate work.

If a worker disappears, inspect the Team roster, assignment attempt, checkpoint, and dispatch status. An interrupted in-process worker can retain its runtime identity, worktree, and capacity through bounded recovery. An uncertain delivery or exhausted recovery remains visible and requires explicit recovery. Do not release a worktree while a live child, unfinished task, pending message, or unconfirmed runtime drain remains.

For a stale attempt, healthy behavior is a fenced wakeup/submission with the original attempt still visible. For a worker/runtime failure before start, healthy behavior is a released reservation plus a durable diagnostic; after runtime ownership exists, capacity remains held until drain is confirmed. Check `assignments.jsonl`, `dispatch.jsonl`, and `execution.jsonl` before considering any manual recovery.

## Integration and Git

Use `team_integration_list` to distinguish queued, running, verified, merged, and failed jobs. A failed verification preserves the target and candidate diagnostics. A stale target creates a fresh candidate while retaining the old candidate history; inspect `previousCandidates` before cleanup. A gated verified job is expected to wait for host review, and the default review authorization policy denies approval.

If integration reports a busy target, another Team or process owns the canonical repository/target lock. Wait for its durable run to settle and inspect the job before retrying. If the target moved, rerun the recorded verification through the bounded retry path rather than manually changing a candidate record.

For a failed verification, healthy output is an unchanged target branch, a failed integration diagnostic, and a retained candidate. For a successful run, expect `verified` followed by `merged` with target and candidate commit evidence. A gated job remains `verified` without promotion until its host review receipt is present. Inspect `previousCandidates` after target movement and the Git common-directory lock when multiple processes are involved.

Candidate cleanup is conservative. Inspect the candidate path, Git worktree registration, detached commit, target ancestry, dirty/ignored/untracked files, and in-progress Git operation state. Dirty, ignored, untracked, unmerged, uncertain, or actively owned output is retained. Retention checks only live in-process Agents and cannot prove an external process is gone. An interrupted cleanup becomes uncertain and is not automatically retried.

## Coordinator and workflow

Run an explicit `reconcile` or wait for the configured scan interval after correcting a durable blocker. Read the coordinator view again; scans do not overlap, and a project pause suppresses new dispatch and retention deletion. Acceptance requires the exact task, attempt, source, submission, integration, and verification bindings. A worker report alone does not complete a code task.

For a workflow that appears stuck, inspect its execution ID and step receipts. Each step has a durable intent and task binding; accepted report receipts advance the report step. A crash after Team task creation should replay the same pinned task identity. For implementation workflows, follow the pinned submission, verification, review, and integration receipts. For publication workflows, inspect the trusted grant, explicit authorization evidence, publisher identity/revision, and idempotency receipt; a failed or uncertain effect is retained rather than repeated with a new key.

For UI/RPC problems, first check that the browser and host layers were both linked in the Web profile. `workspaceDashboard`, `workspaceDashboardPage`, `workspaceActivityPage`, `scheduling`, `controlScheduling`, and health Remote calls require the exact registered Lead. `Caller is not the configured workspace operator` means the selected session is not that Lead. A cross-project or stale-revision rejection is an expected authorization or fencing result; refresh the dashboard and reselect the project/attempt before retrying the operation.

The Operations section appears only after project selection. A disabled provisioning retry is explained by one of five gates: no classified provisioning failure, non-retryable classification, missing positive stopped-runtime evidence, exhausted pinned budget, or a durable retry deadline that has not arrived. Even when the button is enabled, a reopened dependency, project pause, capacity, pacing, provider admission, cancellation, submission, report, or changed task state can reject the final revision-fenced request. Do not edit the assignment journal to bypass the gate.

Handoff is available only for an active DSH attempt after its authorized health-nudge budget is exhausted. External-provider attempts, non-active attempts, attempts still eligible for nudges, and exhausted handoff lineages remain disabled with the corresponding reason. A successful handoff retains the predecessor worktree and requires a positive stopped receipt before the replacement is reserved. If it stalls, inspect the handoff intent, attempt generation/revision, health recovery count, drain receipt, and replacement lineage in `assignments.jsonl` and `execution.jsonl`.

Activity is ordered by sequence within each journal source, so rows from different sources are not a global timeline. `Time unknown` is expected when a source record has no durable timestamp. The recent-history notice means the reader returned a bounded suffix; use collection history for older attempts. If Activity reports a stale cursor after coordinator restart or eviction, use Restart activity. For provider diagnostics, distinguish `Usage unknown` from reported zero, and do not infer cost. Inspect the attempt's pinned provider policy, admission status, stop evidence, spool metadata, and `provider-admission` blocker when retained external work cannot resume normal dispatch.

## Safe validation commands

These checks do not modify service state:

```sh
git status --short
git diff --check
pnpm typecheck
pnpm exec vitest run packages/agent-team/tests/persistence.spec.ts
```

The full build, tests, acceptance gate, and smoke test can create temporary fixtures and should be run only when that workspace mutation is acceptable:

```sh
pnpm build
pnpm test
pnpm test:acceptance
pnpm test:smoke
test -d /var/tmp
GASTEAM_RELEASE_ROOT=/var/tmp pnpm test:release
```

`test:release` retains a generated `/var/tmp/gasteam-standalone-release-*` directory. Inspect its `consumer/pnpm-lock.yaml`, `consumer/node_modules`, `dsh-home/profiles`, `profile-smoke`, `coordinator-acceptance`, `backup`, and `restored` directories when packaging or upgrade validation fails. A healthy result reports that all packed entry points resolve inside the independent consumer, reports the packed headless profile smoke, and ends with the artifact paths. A registry 404 for a private GasTeam package means the local five-package overrides are incomplete; a path resolving to the development checkout means the fixture is not standalone. An invalid-journal error identifies the line and instructs restoration from a consistent backup.

The release validation covers clean external tarball installation, isolated Web/headless profiles, actual keyless headless CLI execution through real Git promotion, a deterministic-provider coordinator restart through real Git acceptance, and legacy assignment/batch fixture backup/restore. It does not call an authenticated paid model, run `pnpm start`, modify a production service, restore user data, or perform a registry install. Record those context-dependent results separately.
