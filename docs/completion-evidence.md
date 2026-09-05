# Completion evidence

## 2026-09-05 — M0 baseline and M1 registration slice

Checkout baseline: `9e27c64cc70c3a497e8c1ebfac6a1cd5e3e4cc9c`. Initially only the user-provided, untracked `finishme.md` differed. No applicable `AGENTS.md` or separate handoff was found in this checkout or its ancestors. No goal skill is available; the existing matching active goal is used directly.

Inspected README, package/build/test configuration, CI, published-runtime patches, session persistence tests, task board, background workers, and installed profile. Both background loops enumerate live Agents; neither discovers unopened teams. The old built-library e2e file was excluded by the test glob and referenced the former harness path and wrong root depth. Renamed it to `built-lib.spec.ts`, removed silent artifact skipping, and corrected standalone paths.

Local installation observations: `dsh.service` active, PID 311107 at inspection, working directory `/home/dsh/projects/gasteam`, Node executable `/home/linuxbrew/.linuxbrew/Cellar/node/26.8.1/bin/node`. The Web profile's Team package link resolves to this checkout. Its local patch contains only the LAN-host insertion, not autonomous orchestration configuration. No service/profile/data mutation, installation, restart, commit, or push was performed. Build outputs were regenerated in the linked checkout; the running process was not restarted.

All pnpm commands used `export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH`.

| Command | Observed result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; already current, pnpm 11.24.0 |
| Baseline `pnpm build` | Passed; five packages |
| Baseline `pnpm typecheck` | Passed |
| Baseline `pnpm test` | 12 files, 146 tests passed |
| Baseline `pnpm test:smoke` | Passed; installed CLI, worker cwd, Git commit, verification, promotion, release |
| `pnpm test packages/agent-team/tests/built-lib.spec.ts` before path fix | Failed on obsolete built-artifact location; coverage repair red, not autonomous behavior evidence |
| Same command after path fix | 1 test passed under plain Node |
| `pnpm exec vitest run --config vitest.acceptance.config.ts` | Behavioral red: persisted `task-1` exists and is pending/unblocked after SIGKILL; fresh process discovers `[]` instead of that task |
| `pnpm test packages/agent-team/tests/projects.spec.ts` before implementation | 5 failed, 1 passed; missing registration behavior and no successful concurrent registration |
| Same command after implementation | 6 tests passed; real Git identity, registration races, JSONL replay, validation, detached records, corrupt-version rejection |
| Final `pnpm typecheck` and `pnpm build` | Passed |
| Final `pnpm test` (captured in `/tmp/gasteam-m0-m1-tests.log`) | 14 files, 153 tests passed |
| Final `pnpm test:smoke` | Passed |
| Final `pnpm test:acceptance` | Still the same intended behavioral red; task survived, no startup discovery |
| `git diff --check` | Passed after final ledger update |

Published dependencies emit missing-source-map warnings in Vitest. These do not fail tests and were present at baseline.

The new process fixture uses buffered IPC barriers and a durable flush acknowledgement before SIGKILL, then waits for process termination and performs a fresh JSONL read in a new process. Teardown is bounded and awaited. It has no sleep-based success assertions or real credentials. A worker-progress barrier must still be exercised with actual dispatched work as assignment/coordinator execution is added; the current barriers cover persistence and startup only.

The catalog is internal groundwork, not yet an autonomous public service. Its caller must eventually hold coordinator ownership; cross-process exclusion, catalog/session admission ordering, assignments, policy updates, and coordinator integration remain unfinished. No M1 checkbox is justified solely by these unit tests. Architecture decisions and remaining constraints are in `docs/autonomous-architecture.md`.

## 2026-09-05 — M1 assignment records and M0 worker barrier

Revalidated the current worktree and active goal before continuing. Previous turn classification: progress. No unrelated edits were found. Added `AssignmentStore` with distinct worker/attempt/assignment identities, durable pre-provisioning reservations, generation/revision checks, legal lifecycle transitions, checkpoints, worker reports, and runtime-stop evidence. All nonterminal attempts consume capacity; reports do not accept tasks or free slots. Nine sequential terminal records are retained under capacity two. Stale/terminal attempts cannot write into replacements.

Extracted `DurableJournal` from the project catalog so both stores share append/sync/publication ordering, versioned replay, fail-closed uncertain writes, and awaited close. Added exclusive Linux file-description locks using util-linux `flock`; the parent retains the acquired lock after the helper exits. A second instance is rejected; a fresh process can acquire ownership after the owner is killed. This is journal exclusion, not yet the complete coordinator authority/lifecycle.

| Command / stage | Observation |
| --- | --- |
| Initial `pnpm test packages/agent-team/tests/assignments.spec.ts` | 8 behavioral failures: reservations unimplemented; concurrent claims yielded no successful owner |
| Assignment implementation | Transition, replay, fencing, checkpoint, capacity, and history tests passed after correcting case-sensitive diagnostic assertions |
| New second-owner test before locking | Failed because a second store opened successfully |
| `pnpm test packages/agent-team/tests/assignments.spec.ts packages/agent-team/tests/projects.spec.ts` after locking | 15 tests passed |
| `pnpm test tests/assignment-restart.spec.ts` | Passed after narrowing prompt count to the exact assignment checkpoint (the runtime also persists its own user-context message) |
| Final `pnpm build` | Passed, five packages |
| Final `pnpm typecheck` | Passed |
| Final `pnpm test` (captured in `/tmp/gasteam-assignments-tests.log`) | 16 files, 163 tests passed |
| Final `pnpm test:smoke` | Passed: installed CLI and real Git promotion/release |
| Final `pnpm test:acceptance` | Same intended red: durable pending task survives, but unopened ready work is not discovered |

The M0 worker-progress helper now runs a real published DSH in-process subagent with a deterministic adapter. It reserves an assignment/runtime identity, starts the child with its checkpoint, waits for the actual model request, persists activation and child session state, then acknowledges the worker barrier over IPC. A contender process is rejected before the owner is killed. A third process replays exactly the same active assignment and finds exactly one copy of its checkpoint prompt with no pre-opened Agents. No sleeps advance the scenario, and every child is awaited on teardown. This proves persisted context and crash lock release; it does not claim resumed execution or complete coordinator recovery.

Remaining M1 work: connect records to accepted product work, trusted provider receipts, scoped worker tools, and replace the legacy interactive lifetime roster bottleneck. M2 still needs directory-wide coordinator identity/authority, catalog/session admission ordering, startup discovery, reconciliation, pause, and shutdown. Runtime/provider policy updates, history pagination, and other milestones remain open. The architecture document now includes the exact implemented assignment transition table. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M2 startup discovery and scoped admission

Revalidated worktree state, continuation record, and the matching active goal. Previous turn classification: progress. Added the exported `coordinator` plugin and `WorkspaceCoordinator` host API. The coordinator acquires its own journal before opening the catalog, persists a stable identity, registers only an exact live Lead's own Team, and requires that registration before durable task admission. It reads registered logs through published persistence inspection and the existing Team projection without materializing Agents. Missing/corrupt Team logs retain a visible durable reconciliation failure; repeat unchanged scans do not append duplicate notices. Pause controls have independent revisions and survive startup.

The plugin awaits initial reconciliation before publishing its service, runs nonoverlapping scans, and clears its timer/cancels inspection/awaits operations before releasing ownership. This lifecycle currently covers discovery and admission; no worker subprocess dispatch is claimed.

| Command / stage | Observation |
| --- | --- |
| Initial `pnpm test packages/agent-team/tests/coordinator.spec.ts` | Five failures for missing registration/admission/discovery/pause/ownership |
| Same suite after implementation and plugin lifecycle test | Six passed |
| `pnpm build` | Passed; five packages, now including exported built coordinator entry |
| `pnpm typecheck` | Passed |
| `pnpm test` (captured in `/tmp/gasteam-coordinator-tests.log`) | 17 files, 169 tests passed |
| `pnpm test:smoke` | Passed; existing installed CLI/Git scenario |
| `pnpm test:acceptance` after wiring built plugin | Original discovery red became green |
| Final `pnpm test:acceptance` with pause scenario | Two fresh-process scenarios passed |

The subprocess acceptance fixture now initializes an isolated real Git project, mounts the built plugin, registers the Team, and accepts its task through the coordinator API. It acknowledges synced state before SIGKILL. The second process mounts the same built plugin, opens zero Agents, and proves the original task and coordinator identity survived. The unpaused case discovers exactly that ready task; the paused case restores revision-one pause and does not reactivate it. The original no-browser, killed-writer, and durable-task assertions remain. CI now runs this gate explicitly; it is discovery/pause evidence, not the full final acceptance matrix.

Next: connect assignment reservations and preselected runtime IDs to actual product worker admission and recovery; remove the lifetime roster bottleneck, add trusted provider stop observations, and implement dependency-aware scheduling. Pending mailbox and integration reconciliation, worker shutdown bounds, authenticated operator controls without a live Lead, model tools/RPC, and later milestones are still unfinished. No local service restart, install, commit, or push was performed.

## 2026-09-05 — M1 concurrent Team admission and turnover

Revalidated the worktree and matching goal; previous turn classification: progress. Added `maxConcurrentMembers` (default eight) and enforced it under the same Team transaction for both provisioning reservations and inactive-worker wakeups. Live Agent residency continues consuming capacity until authoritative registry disposal. The independent immutable-name history guard `maxMembers` defaults to 4,096; existing explicit history limits retain their meaning and history is never deleted/reinterpreted.

Capacity-blocked wakeups remain in the existing durable mailbox. A registry-disposal event or a settled provisioning/wakeup reservation triggers a contained retry only for a capacity-blocked queue. Failed provisioning now releases the queue even when no runtime was ever created. Direct spawn overflow returns `TEAM_CONCURRENT_LIMIT` before consuming a name. Durable dispatch queuing is still an M3 requirement.

| Command / stage | Observation |
| --- | --- |
| Initial `pnpm test packages/agent-team/tests/team.spec.ts` | Four failures: new limit was not validated; ninth worker hit lifetime cap; three concurrent claims were admitted; wakeup exceeded capacity |
| Worker fixture inspection | Native child-completion notices wake the Lead and were consuming the worker script. Added routing for Lead acknowledgements; nine-worker test now checks each persisted worker answer is `done` |
| New failed-provisioning capacity test before callback | Failed with the wakeup still durably queued after provider rejection |
| `pnpm test packages/agent-team/tests/team.spec.ts` after fixes | 68 tests passed |
| `pnpm build` / `pnpm typecheck` | Passed |
| `pnpm test` (captured in `/tmp/gasteam-capacity-tests.log`) | 17 files, 173 tests passed |
| `pnpm test:smoke` | Installed CLI/Git smoke passed |
| `pnpm test:acceptance` | Both process-restart discovery/pause scenarios passed |
| `git diff --check` | Passed |

Four added public-behavior tests prove nine actual sequential worker answers at capacity two, two reservations from three racing spawns, durable wakeup queuing with exactly one delivery after a resident worker stops, and retry after a provisioning failure with no child runtime. The failure test synchronizes on a provider-entry barrier and an explicit rejection; no sleep advances it. Existing persistence, mailbox, recovery, tool, RPC, and browser tests remain green.

Remaining: connect coordinator assignments/preselected runtime IDs to Team worker admission and trusted provider observations, automatic dependency-aware dispatch, full cold-start worker/mail/integration reconciliation, and later milestones. History archival/pagination is still planned; the independent guard provides bounded retention today. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M1/M2 reserved runtime admission and DSH bridge

Revalidated current code and the matching goal; previous turn classification: progress. Added host-only `spawnReservedTeammate` without widening model tool inputs. Team provisioning now accepts the coordinator's durable runtime identity, rejects live/stored collisions, and reserves identities across racing Team roots before any asynchronous admission work. Persistence inspection failures are not interpreted as absence.

Added `DshAssignmentRuntime` to resolve exact-parent authority and attempt revisions, start one reserved runtime with complete assignment/checkpoint context, observe persisted worker reports, and cancel/retire through awaited published DSH drain operations. Task state remains pending when a worker merely reports completion. Ownership uncertainty keeps the attempt reserved/stopping and prevents draining unrelated work. Automatic coordinator invocation and full recovery policies remain unfinished.

| Command / stage | Observation |
| --- | --- |
| Reserved-ID red tests | Generated a different ID; both racing Team roots admitted the requested identity |
| DSH bridge red tests | Attempt remained reserved; unrelated Lead authority was not rejected |
| Fixture correction | Assignment files inside the session storage root caused the published runtime's flat-layout rejection. Moved assignment journals to a separate isolated root; no runtime validation was bypassed |
| `pnpm test packages/agent-team/tests/team.spec.ts` | 72 passed after implementation; four new tests cover identity reuse/races, execution/report, and cancellation/authority |
| `pnpm build` / `pnpm typecheck` | Passed |
| `pnpm test tests/assignment-restart.spec.ts` | Passed using the built DSH bridge and actual Team admission, replacing direct subagent fixture provisioning |
| `pnpm test` (captured in `/tmp/gasteam-dsh-runtime-tests.log`) | 17 files, 177 tests passed |
| `pnpm test:smoke` | Installed CLI/Git smoke passed |
| `pnpm test:acceptance` | Both discovery/pause process-restart scenarios passed |
| `git diff --check` | Passed |

The worker process fixture now starts through the bridge, persists the active assignment, and reaches an actual model-request barrier before SIGKILL. A fresh process still finds one matching assignment/checkpoint prompt and acquires the released ownership lock. This proves bridge admission and durable replay, not automatic dispatch or interrupted-worker resumption. No service restart, installation, commit, or push occurred.

Next: wire the bridge into coordinator execution policy and durable dispatch requests; enforce managed-task mutation/wakeup fencing, restore real Lead handles only under registered project authority, and reconcile interrupted or uncertain attempts with bounded recovery. Then expand process acceptance to actual automatic execution and verified integration.

## 2026-09-05 — M2/M3 automatic independent-task dispatch

Revalidated the worktree and active goal; previous turn classification: progress. Added `CoordinatorExecution`, explicit model/provider/global-capacity configuration, and coordinator invocation of the DSH bridge. Execution requires Git worktrees, restores only catalog-authorized real Lead handles, validates repository cwd/model policy, reserves assignment identity/capacity before provisioning, and observes worker reports on subsequent scans. Existing attempt history prevents duplicate redispatch. Known pre-start failures release their reservation and retain deduplicated diagnostics in `execution.jsonl`.

Installed Team execution policies run inside task mutation and wakeup admission transactions. Registered tasks cannot be completed by ordinary worker/Lead text mutations. Terminal/stopping attempts cannot be woken again, and fencing remains installed if execution configuration is disabled. Coordinator shutdown drains managed DSH children and disposes only Lead handles it restored before releasing ownership. Dependency-aware scheduling, bounded handoff/retry, publication/acceptance, and external-provider shutdown remain unfinished.

| Command / stage | Observation |
| --- | --- |
| Initial `pnpm test packages/agent-team/tests/coordinator.spec.ts` | Two new behavioral failures: no attempt created for live or unopened accepted work |
| Coordinator suite after implementation | Nine passed, including task/wakeup fencing, disabled-execution fencing, and failed-policy capacity release allowing unrelated work |
| Built process test | Exposed a missing `subagents` plugin injection during teardown; fixed the shipped plugin dependency declaration |
| Config/build correction | Explicit optional execution schema needed `undefined` in its TypeScript type. An acceptance attempt against stale pre-build artifacts was discarded as evidence |
| Final `pnpm build` / `pnpm typecheck` | Passed |
| Final `pnpm test` (captured in `/tmp/gasteam-automatic-dispatch-tests.log`) | 17 files, 180 tests passed |
| Final `pnpm test:smoke` | Installed CLI/Git smoke passed |
| Final `pnpm test:acceptance` | Three fresh-process scenarios passed: discovery, persistent pause, and automatic isolated worker admission after restart |
| `git diff --check` | Passed |

The new acceptance scenario accepts work with execution initially disabled, waits for durable acknowledgement, kills the process, then mounts the built coordinator with execution configured. No browser/agent action advances dispatch. Startup restores the registered Lead, creates exactly one generation-one attempt, and reaches the real worker's model-request barrier in a Git worktree outside the project checkout. The fixture then disposes the running plugin cleanly. Earlier zero-live-Agent discovery and paused-work assertions remain separate and unchanged.

This proves automatic independent-worker admission, not a complete DAG or successful integration. The worker is intentionally held at a progress barrier; report verification/integration and interrupted-worker continuation remain required. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M3 durable dispatch ordering, fairness, and pacing

Revalidated the current execution path and plan. Previous goal turn classified as progress: ledger corrections reconciled milestone evidence with implemented dispatch. This slice replaces catalog-order admission with a locked `dispatch.jsonl` journal and connects it to actual coordinator execution. Pending requests are recorded even with execution disabled or paused. Priority edits require exact authorized Lead identity, request revision, and no existing attempt. Read-only coordinator views expose durable requests.

Projects are selected by least recent turn, with initial ties broken by oldest eligible request. Inside each project, priority precedes stable order. Pacing is persisted before selection reaches reservation, including across restart. A selection does not consume work: existing assignment history fences duplicate admission, while a crash before reservation leaves the request recoverable. Capacity, pause, dependencies, ownership, and durable failure blockers remain eligibility gates.

Validation:

- `pnpm test packages/agent-team/tests/scheduler.spec.ts packages/agent-team/tests/coordinator.spec.ts`: 13 passed. New tests cover durable priority/revision, fair project turns, restart pacing and backwards clock handling, selection-before-reservation recovery, eligibility preserving order, authorized priority driving actual admission after reopening, and concurrent scans respecting pacing.
- `pnpm build` and `pnpm typecheck`: passed. Typechecking caught an optional pacing schema mismatch during implementation; the plugin schema now explicitly permits the omitted value.
- `pnpm test`: 18 files, 184 tests passed; output `/tmp/gasteam-dispatch-queue-tests.log`.
- `pnpm test:acceptance`: all three built-plugin process restart scenarios passed.
- `pnpm test:smoke`: standalone worker/commit/verification/promotion/release passed.
- `git diff --check`: passed.

Retry/backoff and uncertain-worker recovery remain unfinished; a failed or terminal attempt is still not silently replaced. Full dependency acceptance, model/RPC controls, and autonomous integration remain required. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M2 bounded drain observation and stopping-worker reconciliation

Previous turn classification: progress — durable queue behavior and tests were implemented. Inspected the runtime bridge and found that registry residency short-circuited observation even for stopping attempts. This prevented a resident worker from completing drain reconciliation. Stopping state is now handled first.

Added `RuntimeDrain`: each DSH runtime drain observation has a 30-second deadline, retains the actual pending provider promise on timeout, rejoins it on subsequent observation, and clears observation timers. Late failures remain observed. Coordinator disposal uses the same drain tracker. Timeout conveys unconfirmed termination; it cannot author a stop receipt, free capacity, or authorize a replacement.

Validation:

- New real-worker regression holds the published drain behind a barrier: cancellation times out, the attempt stays stopping with no receipt, a new capacity reservation is rejected, and observation of the still-resident worker rejoins exactly one drain. Releasing the barrier stops the actual worker and permits retirement.
- Two deterministic drain tests cover retained operations, unrelated workers, late failure, and timer cleanup. An initial test incorrectly assumed one microtask was sufficient for late failure settlement; corrected it to explicitly await the same pending handle's failure before retrying.
- `pnpm build`, `pnpm typecheck`: passed.
- `pnpm test`: 19 files, 187 tests passed (`/tmp/gasteam-runtime-drain-tests.log`).
- `pnpm test:acceptance`: three process scenarios passed.
- `pnpm test:smoke`: passed.
- `git diff --check`: passed.

This does not complete bounded shutdown or automatic recovery. Startup/provisioning and restored-Lead disposal still need whole-operation bounds; failed coordinator close currently retains its ownership until process exit. Interrupted-worker handoff, retry/backoff, and verified integration remain required. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M2 retryable failed close

Previous turn: progress, bounded drain observation and resident stopping-worker reconciliation. Revalidated the close path: both coordinator layers cached rejected close promises permanently. They now permit a later close to retry while retaining a permanent shutdown fence. Admissions/reconciliation remain rejected after the first close request; managed wakeups are fenced during execution shutdown. Successful close remains idempotent, and concurrent callers share one operation.

A real-worker coordinator regression injects a provider drain failure, confirms the worker remains resident, confirms a competing coordinator cannot acquire ownership, and verifies that admission and wakeups remain blocked. Two concurrent retry callers then stop the worker with one additional drain and permit reopening the same durable coordinator identity.

Validation: coordinator suite 11 passed; `pnpm typecheck`, `pnpm build`, regular suite 188 passed, three built process acceptance scenarios, and installed smoke all passed. Regular output: `/tmp/gasteam-close-retry-tests.log`. `git diff --check` passed. Full startup/provisioning/Lead-disposal bounds, automatic handoff/retry, dependency acceptance and integration remain unfinished. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M3 dispatch eligibility status

Previous turn: progress, retryable coordinator shutdown. Revalidated selection and added `CoordinatorView.dispatchStatus`, using the same eligibility function as worker admission. Typed blocker codes explain disabled execution, shutdown, missing project/team/task, pause, task state/ownership, dependencies, both capacity limits, pacing, and durable failures. Existing assignments link to their attempt; terminal reports remain awaiting acceptance, while stopped attempts without a report require recovery. Reading status does not mutate durable state.

Regression coverage now checks restart-preserved pause/disabled status, report versus acceptance, durable failure/recovery status, pacing timestamps, simultaneous dependency/global/project capacity blockers, and detached view snapshots. Coordinator suite: 12 passed. `pnpm build`, `pnpm typecheck`, full suite (189 tests; `/tmp/gasteam-dispatch-status-tests.log`), three process acceptance scenarios, installed smoke, and `git diff --check` all passed. Typed model/RPC exposure, cancellation/retry, handoff, and verified integration remain required. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M3 scoped scheduling tools and Remote contracts

Previous turn: progress, unified dispatch eligibility/status. Added project-scoped host status/control operations and Team Remote descriptors for `scheduling` and `controlScheduling`, with strict browser-safe request/response schemas and published client types. Remote lookup resolves the Agent; coordinator authorization enforces its exact registered Lead grant. Controls retain project/request revision checks. Status filters to the authorized project and Team.

The opt-in `tool-agent-team/coordinator` entry point installs `team_dispatch_status`, `team_dispatch_pause`, and `team_dispatch_priority` in Lead scopes, including newly created Leads. Tool execution checks the exact scope carrier before calling coordinator operations. Package exports/build entries include the plugin. A model-tool execution regression reads structured status, updates priority, pauses, rejects stale revisions, and rejects cross-project calls; it also validates direct Remote host-method outcomes. This proves tool execution and Remote contracts, not an end-to-end authenticated browser transport session.

Validation: coordinator suite 13 passed; `pnpm typecheck` and `pnpm build` passed. Three built restart acceptance scenarios and installed smoke passed. Initial full suite caught an obsolete three-method Remote descriptor expectation; updated it and added scheduling codec validation. Final regular-suite result is recorded in the continuation ledger and `/tmp/gasteam-scheduling-controls-tests.log`. `git diff --check` passed. Cancellation/retry, global workspace-operator authorization, handoff and verified integration remain unfinished. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M3 durable queued and active cancellation

Previous turn: progress, scoped scheduling controls. Revalidated queue and runtime cancellation paths. Added revision-checked cancellation intent to `dispatch.jsonl`, including a durable reason. Queued cancelled requests are excluded from admission and discovery-ready work across restart. Active cancellation persists that intent before stop/drain/retire, fences wakeups immediately, retains capacity until actual termination, and reconciles even while the project is paused. Cancellation does not complete the task or remove artifacts.

The existing Remote control contract now accepts cancellation, and the scoped model plugin provides `team_dispatch_cancel`. Status uses explicit cancelled state once no live attempt remains; an active cancellation remains assigned with a cancellation blocker. New regressions prove queued restart exclusion, priority rejection after cancellation, durable intent visible before drain, failure retention, paused reconciliation, actual worker shutdown, no redispatch after resume, and model-tool cancellation.

Focused coordinator/scheduler suites passed (18 tests). Final build/types/full/acceptance/smoke results are recorded in the continuation ledger and `/tmp/gasteam-cancellation-tests.log`. Reserved runtimes of uncertain ownership still require repair; disabled execution cannot restore an unopened Lead without configured runtime authority. Automatic retry/backoff, interrupted-worker handoff, and verified integration remain unfinished. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M2 latest-turn recovery evidence

Previous turn: progress, durable cancellation. Inspected worker observation and the installed persistence contract. Observation previously selected the last turn-end event without explicitly matching the latest turn-start. Added a bridge-level boundary check; mismatched, missing, or older completion events cannot supply a report. A recorded stop reason now takes precedence over any retained old report when displaying recovery versus awaiting acceptance.

The installed JSONL persistence inspector already synthesizes interrupted-turn closers. Therefore this slice makes the bridge invariant explicit and verifies that protection; it is not evidence that the current JSONL backend previously misclassified this crash. Two boundary tests cover later unfinished turns and invalid boundary ordering/identity. A real worker produces a completed report, then the fixture durably appends an unfinished later turn; observation records recovery and leaves task acceptance pending. Fixture corrections accounted for already-disposed live sessions and the generated session/end-seed event before appending the contiguous crash tail.

Build and typecheck passed. Focused latest-turn tests and the real-worker regression passed. Full-suite/acceptance/smoke results are in the continuation ledger and `/tmp/gasteam-turn-evidence-tests.log`. This does not implement automatic interrupted-worker handoff or retry/backoff. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M4 pinned replay-safe integration admission

Previous turn: progress, explicit latest-turn evidence. Inspected existing integration admission: it generated a fresh ID and resolved current worker state for every enqueue. Added host-only `enqueuePinnedIntegration` as the prerequisite for durable coordinator submissions. It requires a stable ID, exact source commit, repository, target and verification policy. The Team transaction returns an existing matching job on replay and rejects differing inputs. New jobs compare the resolved provider spec before queue admission. Replays flush the existing record before acknowledging it, including after an uncertain prior checkpoint.

Tests use actual Team/worker/worktree lifecycle with a controlled integration provider. They cover concurrent replay at full capacity, reconstruction, completed-job replay, changed commit/repository/target/verification rejection, invalid IDs, and failed durability acknowledgement. They do not yet prove a full coordinator submission or real-Git integration under pinned inputs. Build and typecheck passed; final test/acceptance/smoke results are recorded in the continuation ledger and `/tmp/gasteam-pinned-integration-tests.log`. Submission journaling, policy revision linkage, acceptance, and cross-Team integration ownership remain unfinished. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M4 durable submission intent and queue reconciliation

Previous completed goal turn: progress, pinned integration admission. Implemented `SubmissionStore` and authorized host `WorkspaceCoordinator.submit`. A successful, latest, quiescent reported attempt can pin a full source commit and evidence. Registered verification commands and policy revision are captured with task/runtime/attempt identities in `submissions.jsonl`; a persisted UUID prevents integration identity collisions across coordinator stores. Queue admission follows the durable record. Pending records reconcile after coordinator reconstruction with the same integration identity; authority and cancellation are rechecked. Runtime cancellation now rejects work already admitted to integration instead of implying that stopping a worker cancels promotion.

Three store tests cover pending replay, immutable commit/evidence/policy, duplicate acknowledgement, writer exclusion, malformed refs, and corrupt replay. A real worker/coordinator regression with a controlled integration provider records a pending submission during provider failure, reconstructs the coordinator, admits exactly one matching job, and rejects stale or altered replay. It leaves task acceptance pending; real-Git end-to-end submission and promotion are not yet proven by this regression.

`pnpm build` and `pnpm typecheck` passed before the final suite. The suite log proves 21 files and 203 tests passed (`/tmp/gasteam-submissions-tests.log`). The execution handle was unavailable after continuation, and process inspection found no remaining test/build process; acceptance and installed smoke were rerun to obtain direct completion evidence. No worker/test was restarted solely on a timeout. `git diff --check` passed. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M4 automatic artifact submission and integration execution

Previous turn: progress, durable submission records. Connected terminal reported workers to automatic source-commit capture and submission when a Team integration provider is configured. Scans honor pause/cancellation and retain recorded submission identity. The coordinator runs the next integration job only if it belongs to one of its submissions, at most once per Team per scan. Provider failures create durable work diagnostics.

Two real-Git scenarios now run an actual DSH worker whose controlled model adapter commits a file in its isolated worktree. Reconciliation automatically submits the exact commit and invokes the Git integration provider. A content-check command permits promotion in the passing scenario; a failing command leaves main at its original file content. Repeated scans retain exactly one submission/job, and task status remains pending in both scenarios. This proves automatic submission/verification/promotion, not verified task acceptance or a full dependent DAG. The worker artifact action is scripted by the adapter; this is not authenticated-model evidence.

Coordinator suite: 18 passed. `pnpm build`, `pnpm typecheck`, full suite (205 tests; `/tmp/gasteam-automatic-integration-tests.log`), three fresh-process acceptance scenarios, installed smoke, and `git diff --check` passed. Verified acceptance, dependency release, canonical cross-Team ownership, bounded repair/reverification, and full midway-restart acceptance remain unfinished. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M3/M4 verified task acceptance and diamond DAG

Previous turn: progress, automatic submission/verification/promotion. Added a host-only integrated-task acceptance path inside the Team transaction. A coordinator policy grants only the exact task/submission/integration binding with latest terminal attempt, worker/source identity, and matching registered verification policy. The board requires merged candidate/target evidence and accepted prerequisites, writes a deterministic task receipt, and flushes before the submission becomes accepted. Matching receipt replay preserves the task revision; an unrelated submission is rejected. Ordinary task mutation remains fenced.

Scheduling now evaluates dependency completion rather than requiring an empty dependency list. Accepted status is explicit in the workspace/Remote/tool vocabulary. Updated real-Git tests show successful verification leads to completed task/accepted submission, while failed verification leaves task pending and target unchanged. A new four-task diamond scenario commits distinct worker artifacts, automatically submits/verifies/merges each task, and releases branches/join only after prerequisite acceptance. It checks four attempts, four merged/accepted submissions, bounded active capacity, and no redispatch. Model behavior remains scripted; this is not authenticated-model or fresh-process midway-restart evidence.

Validation: coordinator suite 19 passed; `pnpm build`, `pnpm typecheck`, full suite 206 passed (`/tmp/gasteam-verified-acceptance-tests.log`), three process acceptance scenarios, installed smoke, and `git diff --check` passed. Initial test expectations still asserted pending after successful integration; those were updated to the new verified-acceptance behavior. Full crash injection between receipt and submission acknowledgement, canonical cross-Team integration ownership, target-movement repair/reverification, non-code acceptance, and full midway restart remain required. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M2/M4 fresh-process DAG and acceptance crash boundaries

Previous turn: progress, verified acceptance and in-process diamond DAG. Expanded the plain-Node fixture to use built coordinator/worktree/Git-integration plugins with scripted artifact-producing workers and the production scan timer. A persisted diamond DAG is seeded, its writer killed, and a fresh unopened coordinator completes four unique attempts, submissions, merges and accepted tasks without browser or manual dispatcher calls.

Two additional three-process scenarios kill the execution process at explicit IPC barriers: after durable promotion but before task acceptance, and after the durable task receipt but before submission acceptance acknowledgement. Fresh startup retains the same Git HEAD and integration identity, starts no new worker, and marks the existing submission accepted. The receipt-boundary case preserves task revision; the promotion-boundary case advances it exactly once. These barriers occur after a merged integration record; ambiguous promotion before that record and active-worker handoff still need coverage.

Validation: `pnpm test:acceptance` — six passed against the existing built artifacts; `pnpm test tests/assignment-restart.spec.ts` — existing shared worker-crash fixture passed; `git diff --check` passed. Only fixtures/tests/docs changed in this slice; the preceding full source/build/type/smoke baseline remains 206 passing regular tests. The workers use a controlled adapter, not an authenticated model. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M4 ambiguous-promotion process recovery

Previous turn: progress, fresh-process DAG and acceptance-boundary coverage. Added a built Git-provider barrier after actual target advancement but before the merged integration record. SIGKILL leaves the durable job verified, task pending, and submission queued. Fresh startup recognizes the same candidate already at target HEAD, records merged/accepted, increments the task revision once, and starts no worker. Integration/source/candidate identity and Git HEAD remain unchanged.

The first expanded run passed ambiguous-promotion recovery but exposed a full-DAG fixture race: its success barrier checked task receipts before submission acceptance acknowledgement. The barrier now waits for both durable outcomes; crash tests separately exercise that intentional intermediate state.

Validation: `pnpm test:acceptance` — seven passed; `pnpm test tests/assignment-restart.spec.ts` — one passed; `git diff --check` passed. Fixture/test/docs-only slice against the prior built artifacts and 206-test regular baseline. Active-worker restart/handoff, bounded retries and target-movement repair remain unfinished. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M2/M3 bounded in-process worker continuation

Previous turn: progress, ambiguous-promotion process coverage. Added durable assignment recovery intent (count, observed sequence, backoff timestamp, message ID), capped at three interrupted rounds. Coordinator-enabled DSH observation resumes absent interrupted workers through reserved mailbox admission after 1/2/4-second delays, retaining assignment identity/capacity and existing worktree. Identical pending intent reuses its mailbox ID; changed content under that ID is rejected. Exhaustion records stop intent and awaits drain before retirement. Uncertain pending delivery remains owned.

Assignment tests prove persisted budget/backoff/identity and refusal to reserve replacement work. Mailbox regression proves concurrent replay queues one logical message and rejects altered input. Two process cases kill a model-request-blocked worker after a durable checkpoint and an uncommitted edit: startup resumes the same attempt/runtime and preserves the edit through verified integration. The dependent-DAG case then completes all four tasks. Initial fixture assertion incorrectly compared mutable revisions; it now checks immutable identities and expected terminal progress.

Validation: focused assignment/Team suites 88 passed; `pnpm build`, `pnpm typecheck`, full suite 208 passed (`/tmp/gasteam-worker-recovery-tests.log`), nine process acceptance scenarios, installed smoke, and `git diff --check` passed. The controlled adapter supplies artifact actions; authenticated-model/external-provider evidence remains required. Configurable retry policy, workflow/replacement handoff, escalations, canonical integration ownership, and bounded target-movement repair remain unfinished. No service restart, installation, commit, or push occurred.

## 2026-09-05 — M4 canonical integration execution ownership

Previous turn: progress, bounded in-process continuation. Added canonical Git common-directory/target ownership around integration runs. The target key is hashed under the Git administrative directory, and existing Linux open-file-description locking provides cross-process exclusion without expiring leases. The lock covers target observation through verification/promotion/durable status and releases in finally. Contention leaves a queued job untouched.

New tests prove alias/linked-worktree exclusion, separate target keys, aborted acquisition cleanup, actual integration runner refusal before verification, and successful run after release. A real process test holds ownership, rejects a competing process, kills the owner, and lets a successor acquire. Full build/type tests and process acceptance remain green.

Validation: `pnpm typecheck`, `pnpm build`, `pnpm test` (212 tests; `/tmp/gasteam-integration-ownership-tests.log`), `pnpm test:acceptance` (9), `pnpm test:smoke`, and `git diff --check` passed. Shared execution exclusion is implemented; globally ordered integration backlog, stale-target re-verification, repair budgets and later milestones remain unfinished. No local service restart, installation, commit, or push occurred.

## 2026-09-05 — M4 bounded stale-target re-verification

Resumed after reviewing handoff.md and finishme.md. No goal existed in the new thread; restored the full documented objective with the goal tools and no token budget. Preserved the existing uncommitted implementation.

Verified jobs now handle provider `TEAM_INTEGRATION_STALE` by retaining the exact candidate/target/cwd/diagnostic in append-only `previousCandidates`, then durably queuing a fresh `.retry-N` checkout under the same integration, worker, source and policy identity. Each run handles one round; three retries are permitted after the initial verification. Exhaustion records a failed job with retained candidates. Projection checks immutable history and directory ownership. Existing records replay without history. Remote/client contracts expose history. Promotion replay remains first, so already-promoted candidates do not trigger new verification.

Red: `pnpm test packages/agent-team/tests/team.spec.ts -t 'reverifies moved targets'` failed with the unhandled stale-target error. Green runner tests prove bounded retries across service reconstruction and pinned source; a real-Git case advances the target after verification, changes the worker branch after submission, and proves the rebuilt target contains the original source plus external change while old untracked/ignored output survives.

The new three-process acceptance case kills execution after the retry record is flushed and completes it on a fresh unopened coordinator with the same submission/integration and no new worker. Its first run timed out because separately built provider/service plugins have distinct TeamError constructors; the runner now checks the stable error code rather than constructor identity. Test teardown now preserves the original error if cleanup also fails. The final process suite passes this case and all earlier worker/DAG/promotion crash boundaries.

Validation: `pnpm build`, `pnpm typecheck`, `pnpm test` (23 files, 214 tests), `pnpm test:acceptance` (10 scenarios), `pnpm test:smoke`, and `git diff --check` passed. Logs: `/tmp/gasteam-stale-build.log`, `/tmp/gasteam-stale-tests.log`, `/tmp/gasteam-stale-acceptance.log`, `/tmp/gasteam-stale-smoke.log`. Controlled model adapters remain the only model evidence. Configurable policy, explicit conflict/test repair attempts, global integration backlog order, non-code acceptance and later milestones remain unfinished. No service restart, installation, commit or push occurred.

## 2026-09-05 — M4 bounded explicit verification repair

Previous goal turn: progress, durable stale-target re-verification. Inspected current assignments/submissions/execution before extending them. Added `execution.maxRepairAttempts` (0–10, default 3), pinned as `repairLimit` in initial reservation. New verification failures carry a durable classification, excluding explicit abandonment, target-movement exhaustion and interrupted candidate verification from automatic repair. Legacy unclassified failures and unconfigured historical attempts retain their prior behavior.

The scheduler admits a new repair attempt only from the latest reported and drained predecessor. Its reservation records predecessor/submission/integration identity, pinned source commit, retained candidate path, diagnostic and round before creating a fresh runtime/worktree. Store replay enforces fixed policy, consecutive rounds and exhaustion; worker prompts carry repair context and instructions to preserve prior output. Repairs share capacity, project fairness, priority, pause, and dispatch pacing. Original submissions and failed integration jobs remain intact; latest-attempt submission fencing and verified acceptance continue to apply. Failed historical jobs no longer prevent cancelling active repair; jobs which can still promote remain protected. Exhaustion is a durable recovery blocker, never task completion.

Red: `pnpm test packages/agent-team/tests/coordinator.spec.ts -t 'automatically repairs'` failed both success and exhaustion cases because only the original attempt existed (`/tmp/gasteam-repair-red.log`). Real-Git tests now prove successful repair, conflicting target repair, repeated-failure exhaustion with target unchanged, fresh runtime identities, source/diagnostic context, superseded submission rejection and cancellation while paused. A JSONL store test proves replay of repair intent and refusal to reset policy/history or exceed the budget.

The fresh-process fixture kills after repair reservation but before worker creation. A successor using a higher configured limit reuses the exact reserved attempt/runtime and original pinned budget. The controlled adapter merges the original source into the new worktree and commits a repair; verification accepts the new submission while original artifact contents survive in both retained candidate and target. The first fixture version observed pending work immediately after startup; the fixture now waits for durable task/submission acceptance on the production coordinator timer. This is scripted-model orchestration evidence, not authenticated-model conformance.

Final validation: `pnpm build`, `pnpm typecheck`, `pnpm test` (23 files, 219 tests), `pnpm test:acceptance` (11 scenarios), `pnpm test:smoke`, and `git diff --check` passed. Logs: `/tmp/gasteam-repair-build.log`, `/tmp/gasteam-repair-tests.log`, `/tmp/gasteam-repair-acceptance.log`, `/tmp/gasteam-repair-smoke.log`. Non-code acceptance, global integration backlog ordering, retention, repair backoff, escalation and later milestones remain unfinished. No installation, local service restart, commit or push occurred.

## 2026-09-05 — M4 audited non-code report acceptance

Added an immutable optional `nonCodeCriteria` to task creation, durable task snapshots/projection, Team views, Remote schemas, and assignment checkpoints. Omission retains the existing code path. A marked task records its terminal report and the exact criteria, task/attempt revisions, Lead reviewer identity, and rationale in `reports.jsonl`. The durable intent is written before the host-only Team task receipt; only the exact registered Lead and a coordinator policy can apply that receipt. Receipt replay is idempotent and only releases dependents after task completion.

Code tasks still require the existing pinned submission, verified integration, and integrated receipt. Marked tasks are excluded from automatic Git submission and reject manual submission. A cancellation is rejected once either report intent or acceptance exists, so it cannot silently invalidate an already-reviewed acceptance. Pending report intents replay on a fresh context after the receipt crash boundary, preserving one task revision and one report record.

Focused validation on the current source: `pnpm build` passed; focused report/coordinator/Team/tool suites passed 124 tests; and `pnpm exec vitest run --config vitest.acceptance.config.ts tests/cold-start.acceptance.ts` passed 13 built-process scenarios. The new report scenarios kill a process after durable intent and after the flushed Team receipt, then start a distinct process that accepts the same report with one attempt and task revision two. Vitest emitted the pre-existing missing source-map warning from a published subagent dependency. Consolidated type/full/smoke validation remains for this uncommitted slice. The full goal remains incomplete.

Publication evidence for the preceding completed tree: `854591fa4c7b894c23a87201a4661a8d6206534d` was pushed to `master`; a clean independent frozen install, build, typecheck, and smoke passed in `/tmp/gasteam-clean-854591f-oXe35U/repo` (logs `/tmp/gasteam-clean-854591f-{install,build,typecheck,smoke}.log`). GitHub Plugin checks passed for that exact SHA: https://github.com/Silktex/dsh-gasteam/actions/runs/33982568072. This evidence applies only to the published commit, not this later working-tree slice.

## 2026-09-05 — M5 workflow core and M4 cleanup primitive

Delegated independent implementation to coding-focused agents and reviewed their source/contracts. Added host-only WorkflowStore in workflows.ts with strict versioned JSON templates, immutable parameterized execution definitions, dependency/artifact gates, durable step checkpoints, bounded retries and persisted backoff using an injected clock. Shipped implementation/test/review/integration, investigation/report and authorized-publication templates. Review caught and fixed erased publication authorization history after retry, unused retry backoff, forged initial state, inherited parameter lookup and conflated pre-review/integration receipt kinds. Submission, checks, report review and integration now require distinct evidence. Publication authorization binds execution/step/revision/actor/evidence and cannot be reused after retry. Ten focused workflow tests pass. This core has no coordinator dispatch, model controls or actual fresh-session handoff wiring yet; M5 remains in progress.

Added conservative GitCandidateCleanup with canonical target locking, exact non-symlink worktree/common-directory ownership, full pinned detached commit identity, target ancestry, complete dirty/ignored/untracked/unmerged checks, and in-progress Git operation checks before non-force removal. Both absent-path and absent-registration evidence are required for idempotent missing recognition; uncertain filesystem observations retain output. Ten focused real-Git tests and focused types pass. The later opt-in retention scheduler now invokes this primitive for the current final accepted merged candidate; this does not complete M4 as a whole.

Initial consolidated typecheck passed; regular suite found only two obsolete Remote descriptor expectations after adding reviewReports/acceptReport (244 passing, two failing). Those contract tests are being updated with report codec coverage. Final combined validation is recorded below once complete. No local service restart or installation occurred; new work remains uncommitted after published 854591f.


Final combined validation after review fixes: `pnpm build`, `pnpm typecheck`, `pnpm test` (26 files, 247 tests), `pnpm test:acceptance` (13 fresh-process scenarios), `pnpm test:smoke`, and `git diff --check` all passed. Logs are `/tmp/gasteam-combined-build.log`, `/tmp/gasteam-combined-tests.log`, `/tmp/gasteam-combined-acceptance.log`, and `/tmp/gasteam-combined-smoke.log`. The Remote expectation update also added positive-revision/nonempty-rationale checks to the report request codec. Parent reviewed the acceptance replay/durability and workflow/cleanup safety boundaries and inspected final logs. These are uncommitted changes after 854591f; that commit's CI is not evidence for this later slice. Non-code report acceptance is implemented; workflow runtime/handoff and broader M4/M5 work remain unfinished.

## 2026-09-05 — M4 opt-in candidate retention and host review gate

Added coordinator execution candidate retention behind optional `execution.candidateRetention` (`delayMs`, with a default 30-second cleanup command timeout). The durable `CandidateRetentionStore` pins eligibility and deadline at the first coordinator observation of the current final accepted merged candidate; it does not use a merge timestamp. Failed and superseded candidates receive no retention intent. Project pause leaves due intents queued. Cleanup uses the conservative Git primitive and preserves dirty, ignored, untracked, unmerged, active, or uncertain output. Interrupted running intents become `uncertain` with a diagnostic and are never automatically retried. The active provider check covers only canonical live in-process Agents; external ownership is not proven.

The integration API and projection now enforce a host-only review gate. A gated verified candidate cannot be promoted until the host authorization callback accepts a receipt bound to integration/source/target/candidate/gate/review ID; the default callback denies. Durable projection and replay require the binding, explicitly reject a gated merged state without a receipt, and stale-target retry resets the current receipt while retaining the historical receipt with the superseded candidate. Background workers stop awaiting approval.

Earlier focused validation reported by the implementation work: candidate-retention, Git-candidate-cleanup, and coordinator tests passed 40 cases with typecheck; integration queue, projection, and Git gate tests passed 16 + 19 cases. The later reducer regression for gated merged state without a review receipt is covered by the final regular suite below. Global typecheck was not rerun at that point, so this earlier slice did not claim a consolidated build/full-suite result. The report workflow remained separate at that time.

## 2026-09-05 — M5 investigation/report runtime vertical

The coordinator now ships the built-in `investigation-report@1` vertical slice. Creation validates and pins substituted parameters before writing runtime intent. Each step records an intent before the host calls `createPinnedTask`; the Team log atomically persists a stable task ID derived from that intent, and replay validates the immutable task fields rather than matching subject text. Only accepted `ReportStore` receipts complete a workflow step. The following worker receives the accepted report excerpt, review criteria, Lead rationale, and durable receipt ID, and normal coordinator scheduling reserves its fresh runtime. Create, inspect, and resume are available to the scoped registered Lead through host controls, Remote descriptors, and model tools. Code and publication templates remain outside this runtime slice.

Focused tests cover invalid/oversized inputs, accepted-evidence handoff, exact pinned-definition reconstruction, task-side-effect crash replay, and final two-step completion without a third task or attempt. The built-process fixture SIGKILLs after the real Team task side effect, then verifies the successor process binds that same task and creates exactly one generation-one worker attempt.

Final validation: `pnpm build`, `pnpm typecheck`, `pnpm test` (29 files, 270 tests, including the independent seven-test health slice; workflow checkpoint subset: 28 files, 263 tests), `pnpm test:acceptance` (14 built-process scenarios), `pnpm test:smoke`, and `git diff --check` passed. Logs are `/tmp/gasteam-workflow-build.log`, `/tmp/gasteam-workflow-typecheck.log`, `/tmp/gasteam-workflow-test.log`, `/tmp/gasteam-workflow-acceptance.log`, and `/tmp/gasteam-workflow-smoke.log`.

The final extended coordinator handoff test also passed all 29 coordinator tests (`/tmp/gasteam-workflow-handoff.log`). Initial publication CI for `4cb3b601b316a0b79920c1af318cceb35d5a668a` passed frozen install, build, and types, but failed an older persistence test that required an immediate `accepted` observation. The mailbox contract also permits `queued` while another recovery dispatch owns delivery. The test now requires exactly one persisted receiver receipt for the returned message ID and eventual empty pending mail, without adding a timing delay. All five persistence tests and five targeted repetitions passed. Startup dispatch overlap is an inference from the implementation, not a proven CI trace. During verification an external history rewrite moved local and remote master to `27ead4af472dc52ff1a2bb240b7736f1b9be7320`, whose tree matches the prior `854591fa4c` baseline; the verified changes are preserved on that new history. Exact replacement-commit CI remains to be checked.

## 2026-09-05 — M6 bounded observational health vertical

Added an opt-in coordinator health store that records per-attempt, generation-fenced observations and a registered-Lead-scoped operator inbox. A live DSH session contributes a durable sequence cursor but is deliberately classified as execution-unknown: it cannot prove an active tool is stuck and creates no escalation. The coordinator never invokes a health-triggered nudge, stop, handoff, or replacement. Unchanged uncertain patrols do not append journal events. Known durable dependency and report-review waits become `dependency-wait` and `operator-wait`; authoritative stop reasons and failed integration records become `failed` incidents. Only accepted report/submission/integration receipts may clear an open incident without new runtime evidence, and the receipt generation must match the health attempt.

Escalations persist severity, diagnostics, work binding, cooldown, acknowledgement, and resolution. Inbox acknowledgement is revision-fenced, authorized to the registered Lead and exposed through typed Remote descriptors plus `team_health_inbox` and `team_health_ack`. The coordinator view includes health observations and escalations. This is an observational M6 slice: provider-specific active-operation probes, recovery stages, replacement fencing, external notification delivery, and dashboard UI remain unfinished.

Validation: isolated archive `/tmp/gasteam-health-validate-BCNfXG` began at published checkpoint `016a976e5bb843153a2a888c14630d6805f68ab4` and overlaid only the health files and shared health wiring, excluding in-flight workflow files. Its frozen install, `pnpm typecheck` (`/tmp/gasteam-health-validate-typecheck.log`), and focused Remote/health/coordinator/tool suite (60 tests; `/tmp/gasteam-health-validate-focused.log`) passed; the main-tree health diff check passed. Vitest emitted the pre-existing missing source-map warning from the published subagent dependency. Published checkpoint `016a976e5bb843153a2a888c14630d6805f68ab4` passed CI frozen install, build, types, regular tests, 14 acceptance scenarios, and smoke: https://github.com/Silktex/dsh-gasteam/actions/runs/33985554978. That CI applies to the checkpoint, not this uncommitted health slice.

## 2026-09-05 — Documentation index, operator pages, and command checker

Added `docs/README.md`, `docs/installation.md`, `docs/usage.md`, and `docs/debug.md`, cross-linked to the architecture and evidence records. Added `scripts/check-docs.mjs`, `pnpm check:docs`, and a CI step. The checker validates local Markdown file targets (including angle-bracket paths and percent-encoded paths) and syntax-checks fenced `sh`/`bash` examples with `bash -n`; it does not validate anchors or execute examples.

Validation: the repository checker passed seven Markdown files. A temporary negative fixture correctly failed on an angle-bracket path with spaces and invalid shell syntax; a valid fixture passed. A disposable archive of committed `016a976e5bb843153a2a888c14630d6805f68ab4` at `/tmp/gasteam-docs-install-8D5nQh` passed frozen install, build, `pnpm dsh --profile web --no-open --help`, and `DSH_HOME`-isolated Web and headless `pnpm install:profile` commands. Logs are `/tmp/gasteam-docs-install-{pnpm,build,help,web-profile,headless-profile}.log`. This validates command and profile-link mechanics only; authenticated model calls, `pnpm start`, production service operation, clean external installation, backup/restore, rollback, and full documented command coverage remain open.

## 2026-09-05 — Health plus documentation archive validation

The health validation archive `/tmp/gasteam-health-validate-BCNfXG` began from the published health checkpoint and overlaid only the health slice, the four documentation pages, documentation checker/configuration, and current documentation/evidence/ledger files. `pnpm check:docs`, `pnpm build`, `pnpm typecheck`, `pnpm test:acceptance` (14 scenarios), and `pnpm test:smoke` passed. The full regular suite ran 29 files and 274 tests with 273 passing and one expected stale built-library descriptor assertion: `packages/agent-team/tests/built-lib.spec.ts` omitted the newly shipped `healthInbox` and `acknowledgeHealth` Remote methods. This archive validation did not modify source or service state; the focused health evidence remains the authoritative 60-test result above.

Logs: `/tmp/gasteam-health-docs-check.log`, `/tmp/gasteam-health-docs-build.log`, `/tmp/gasteam-health-docs-typecheck.log`, `/tmp/gasteam-health-docs-test.log`, `/tmp/gasteam-health-docs-acceptance.log`, and `/tmp/gasteam-health-docs-smoke.log`. The isolated archive remains at `/tmp/gasteam-health-validate-BCNfXG` for review. Full current-tree workflow/health validation and broader command, service, clean-install, backup/rollback, and release validation remain open.

The isolated archive then received only the matching `built-lib.spec.ts` Remote descriptor expectation update. Its focused built-library test passed (`/tmp/gasteam-health-docs-built-lib.log`), followed by a clean full rerun: 29 files and 274 tests passed (`/tmp/gasteam-health-docs-test-final.log`). This closes the descriptor-test mismatch in the validation archive; it does not add source or claim broader release/service validation.

## 2026-09-05 — Published health and documentation checkpoint

The validated health/documentation slice was committed and pushed as `92715a0fd16af303bb76d8d71b1056b3b463d9f8`. [Exact-commit GitHub CI](https://github.com/Silktex/dsh-gasteam/actions/runs/33986522205) passed frozen installation, documentation checks, build, types, 274 regular tests, 14 process acceptance scenarios, and CLI smoke. The local CI receipt is `/tmp/gasteam-ci-92715a0.log`. Code-workflow and external-runtime changes still in the working tree are separate drafts; these checkpoint results do not validate them. No service restart or user-data migration occurred.


## 2026-09-05 — Gated code workflow and complete repair lineage

The built-in code workflow now binds its implementation task to a host-only review gate before dispatch, observes pinned Git verification, creates a fresh candidate-bound reviewer task, and requires an explicit approved Lead decision before promotion. Rejected reports remain durable audits and cannot authorize integration. Model workflow creation selects either shipped report or code template with validated parameters. Task, report, and host approval checks preserve the exact source/target/candidate/integration/gate tuple.

Candidate/source invalidation archives old evidence and reconciles task bindings after a crash, including an intended review whose task was not yet created. Implementation task identity is retained. The status host walks the exact persisted repair ancestry, and runtime records each source edge in order even if replacements submitted between scans. Previous report approvals cannot authorize a replacement candidate.

Red findings included a missing code-template tool choice, stale pre-task review intents, and lost source history when repair reservation superseded the first submission before workflow reconciliation. A repair fixture also used mismatched verification commands after restart; fixing that test setup exposed the real history gap. Tests now cover actual journal close/reopen, missed-scan lineage, and real-Git approved, rejected, and failed-verification/repair process scenarios.

Clean archive `/tmp/gasteam-m5-acceptance-CihYI5` began at `92715a0` and overlaid only M5 files, excluding external-runtime drafts. Frozen install, build (`/tmp/gasteam-m5-missed-lineage-build.log`), 42 focused tests, types, documentation checks, 286 regular tests, 17 process acceptance scenarios, and CLI smoke passed. Final logs: `/tmp/gasteam-m5-archive-final-{regular,acceptance,typecheck,docs,smoke}.log`. The process tests use controlled model adapters and real Git. Publication workflow runtime, broader handoff/recovery, external-provider conformance, and all other unfinished milestones remain open. No service restart or user-data migration occurred.


## 2026-09-05 — Published code workflow and external-runtime foundation

Code workflow checkpoint `7d649fe5279e589351e78a1bcc1e1df3e1243b31` was pushed and passed [exact-commit CI](https://github.com/Silktex/dsh-gasteam/actions/runs/33989214493); local receipt: `/tmp/gasteam-ci-7d649fe.log`.

The separate M9 foundation adds an explicit capability contract, a Codex CLI 0.153.4 argument/JSONL adapter, durable external-attempt state, and a compiled detached supervisor. Linux executions use `unshare --user --map-root-user --pid --fork --mount-proc --kill-child`; host wrapper birth identity is distinct from inner PID 1. Cancellation signals the live child handle, waits for actual close and spool drain, then persists fsynced byte/digest proof. Recovery observers never signal historical numeric PIDs or groups. Immutable launch/target claims prevent duplicate execution across identical concurrent and completed replays; claim publication syncs the containing directory before spawning. Unknown ownership preserves capacity.

Independent review exposed duplicate replay launches, premature output proof from exit rather than close, and missing directory sync after hard-link publication. Focused tests cover the fixes, malformed journals, fenced output, silent/client/helper-death states, and namespace teardown of a setsid-escaped descendant. The retained plain-Node fixture `packages/agent-team/tests/fixtures/external-runtime-namespace-evidence.mjs` ran against compiled output; `/tmp/gasteam-m9-final-namespace-evidence-20260905.json` records host/helper birth identities, inner PID 1, stopped phase, TERM/KILL receipt, and stdout/stderr byte/digest evidence.

The foundation-only archive passed 20 focused tests, build, types, 294 regular tests, 14 process scenarios, docs, and smoke (`/tmp/gasteam-m9-final-*`, `/tmp/gasteam-m9-publish-*`). Combined clean archive `/tmp/gasteam-m5m9-combined-pizZFv` began at committed `7d649fe` and overlaid the 12 exact M9 files recorded in `/tmp/gasteam-m5m9-combined-manifest.sha256`. Frozen offline installation, build, types, 306 regular tests, 17 process acceptance scenarios, documentation checks, and smoke passed. Logs: `/tmp/gasteam-m5m9-combined-{install,build,typecheck,test,acceptance,docs,smoke}.log`.

This is infrastructure, not completed provider integration. Configured executable/version metadata remains explicitly `configured-unverified`; admission must verify the actual binary. DSH adaptation, coordinator routing, authenticated Codex assignment completion, runtime cancellation/restart conformance through that coordinator, and public provider controls remain unfinished. No real authenticated model call, external release publication, service restart, or user-data modification occurred.

The first published M9 CI run (`33989368465`) exposed Ubuntu's AppArmor restriction on unprivileged user namespaces: `unshare --map-root-user` failed writing `uid_map`. CI now enables `kernel.unprivileged_userns_clone=1` and, only where that Ubuntu AppArmor sysctl exists, sets `kernel.apparmor_restrict_unprivileged_userns=0`, then executes the same strict namespace command before the test suite. Ubuntu documents this setting as a per-boot override for the 24.04 user-namespace restriction ([Ubuntu 24.04 release notes](https://documentation.ubuntu.com/release-notes/24.04/)). The production supervisor and its strict namespace backend are unchanged; the setting applies only to the disposable CI runner.


## 2026-09-05 — Authorized release runtime, batch state, and CLI admission

The release runtime prepares an accepted non-code manifest and requires an explicit server-only grant before invoking a configured idempotent publisher. Grants, publisher identity/revision, and execution authorization are pinned. Pause guards prevent resume/authorization effects; mismatched grants fail catalog restoration and a changed publisher fails invocation. Receipts bind the exact intent key, manifest, authority/evidence, and publisher. Definite failures, classified unknown outcomes, and ordinary thrown errors persist a failed step and do not trigger repeated scan effects. Crash replay is tested by failing receipt persistence after publisher success, retaining the same key.

Review found pause bypass, unbound receipts, ignored grant changes, indefinite exception retries, and a code prepare task that could remain unaccepted. These were corrected and covered by coordinator/runtime tests. JSON examples also differed from built-in templates with identical IDs/versions; a new consistency assertion failed (`/tmp/gasteam-template-consistency-red.log`), then passed after synchronization (`/tmp/gasteam-template-consistency-green.log`). Clean release archive `/tmp/gasteam-release-final-jpa4mP` overlays ten exact files on `2c2d76c`; build, types, 313 regular tests, 17 process scenarios, docs, and smoke passed. Manifest/logs: `/tmp/gasteam-release-final-manifest.sha256` and `/tmp/gasteam-release-final-{install,build,typecheck,regular,acceptance,docs,smoke}.log`. Publisher tests use a fixture host, not a real external release transport.

The separate batch foundation persists globally identified required tasks, a workspace dependency graph, acceptance-derived progress, failed/reopened histories, and completion epochs/subscriptions. Review fixes make concurrent notification admission idempotent, reject cycles spanning batches, fence stale authoritative observations, and enforce durable bounds before writing. Reopen suppresses undelivered old-epoch intents; recompletion produces a new epoch. Coordinator dispatch, operator/planning controls, delivery transport, and two-repository acceptance remain unfinished.

Codex admission validates configured policy before probes, canonicalizes the executable, accepts an exact Codex version banner, and requires successful authentication status without retaining authentication output. Timeout/overflow returns are bounded even with inherited open pipes; the regression uses readiness/exit barriers and read-only liveness evidence. The local authenticated CLI was probed read-only, without a model call. Clean foundation archive `/tmp/gasteam-foundations-yAgxHo` overlays batch/admission source/tests and the required pipe fixture on `2c2d76c`; build, types, 316 regular tests, 17 process scenarios, docs, and smoke passed. Manifest/logs: `/tmp/gasteam-foundations-manifest.sha256` and `/tmp/gasteam-foundations-{install,build,typecheck,regular,acceptance,docs,smoke}.log`. Larger external-adapter changes and checkpoint-context wiring remain separate drafts.

Combined publication archive `/tmp/gasteam-final-combined-2TR6oa` overlays the 15 frozen source/test/template files on committed `2c2d76c`. Frozen offline install, build, types, 323 regular tests, 17 process scenarios, documentation checks, and smoke passed. Source manifest: `/tmp/gasteam-final-combined-manifest.sha256`; logs: `/tmp/gasteam-final-combined-{install,build,typecheck,regular,acceptance,docs,smoke}.log`. The parent stages these exact archived source blobs, preserving separate M1 checkpoint and M9 adapter edits in the main worktree.


The first CI run for `44ac554` (`33990699141`) failed two admission tests: the staged fixture lacked its executable bit, and a positive control assumed this workstation's installed Codex path. The fixture is now tracked executable; authenticated local probing is explicitly selected with `GASTEAM_CODEX_ADMISSION_EXECUTABLE`. Deterministic admission tests remain mandatory. Local default admission tests passed (4 tests, 1 optional host probe skipped; `/tmp/gasteam-admission-portable.log`), and explicitly selecting `/home/linuxbrew/.linuxbrew/bin/codex` passed all 5 (`/tmp/gasteam-admission-host-probe.log`). This is read-only admission evidence, not a model assignment. Future archived staging preserves executable modes as well as file contents.


## 2026-09-05 — M1 structured workflow checkpoints completed

Host-pinned tasks now atomically retain execution ID, step ID, and named input artifact references. Public create/update and direct task mutation reject injected or changed bindings; projection replay preserves them. Coordinator reservation supplies `workflowId`, `workflowStep`, and input artifacts to the worker checkpoint. The operational `step` remains separate, preserving `repair` and its immutable source/candidate context and next action. Report, implementation, and reviewer tasks receive reconstructable context after restoration.

The first M1 process run exposed the overloaded `step` field: using it for exact workflow position broke the repair consumer. The separate `workflowStep` fixes the contract; real-Git repair acceptance passes. Independent review confirmed host-only authority, exact input association, mutation fencing, and journal replay. Clean archive `/tmp/gasteam-m1-final-KpWSZR` begins at `44ac554`, includes the committed portable admission correction and only frozen M1 files, and excludes in-flight M7/M9 work. Build, types, 66 focused tests, 325 regular tests (one optional local authenticated CLI probe skipped), 17 process scenarios, docs, and smoke passed. Manifest: `/tmp/gasteam-m1-final-manifest.sha256`; logs: `/tmp/gasteam-m1-final-{install,build,typecheck,focused,regular,acceptance,docs,smoke}.log`.

The parent audited M1 against the source, documented transition table, assignment/projection/coordinator tests, and process evidence. Project authority, distinct identities/history, legal transitions/intent ordering, checkpoint context, and concurrent capacity/turnover are proven at that milestone's scope. This does not close unfinished coordinator recovery, global scheduling/UI, provider routing, or release/install milestones. Published portability checkpoint `0c8489dd463b44cce1f69d97d68c28abc53aeab7` passed [exact-commit CI](https://github.com/Silktex/dsh-gasteam/actions/runs/33990948824); receipt `/tmp/gasteam-ci-0c8489d.log`.


## 2026-09-05 — Isolated external assignment adapter

The adapter derives Codex invocation from verified admission, persists immutable prompt/policy/resource intent before helper launch, restores observation across launch gaps, and fences cancellation before requesting the live helper to stop. Completed-turn parsing selects the final agent message; partial journal replay and concurrent terminal observations are idempotent. Namespace identity and exit/spool receipts bind the exact attempt, generation, wrapper, helper, and output digests. Uncertain proof retains capacity. Independent review corrected unpinned resource policy, terminal receipt replay, and unbounded queued overflow buffers; storm output now reserves bounded copies synchronously and initiates one cancellation.

Independent clean archive `/tmp/gasteam-m9-adapter-final-1788641851` overlays seven frozen files on `21de9b6`. Manifest `/tmp/gasteam-m9-adapter-final-manifest.sha256` was verified; executable fixture mode is retained. Commands `pnpm install --offline --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:acceptance`, `pnpm check:docs`, and `pnpm test:smoke` passed: 334 regular tests, one explicitly optional local CLI probe skipped, and 17 process scenarios. Logs are `/tmp/gasteam-m9-adapter-final-{install,build,typecheck,regular,acceptance,docs,smoke}.log`.

This is an isolated adapter with start/observe/cancel capability; resume is explicitly unsupported. Coordinator routing, external code worktree integration, and actual authenticated model assignment/cancellation/restart conformance remain open. No external publication, local service restart, or user-data migration occurred.


## 2026-09-05 — Deterministic shutdown deadline regression

Adapter checkpoint `08988a91ecd80fb545855458d1b2fc981f82b994` passed full local validation but [GitHub CI](https://github.com/Silktex/dsh-gasteam/actions/runs/33991834788) exposed the existing shutdown regression's 50 ms wall-clock race: the same short budget covered both deliberately blocked cancellation and real provider shutdown. The test now injects the deadline scheduler, explicitly expires the first wait, proves the second wait joined the same drain, and releases the real provider barrier. It still verifies retained capacity, absent stop evidence before termination, one provider drain, and eventual terminal state. Cleanup releases the barrier and restores the spy even on failure. Production deadlines are unchanged.

Independent clean archive `/tmp/gasteam-ci-drain-final-1788642377` overlays only runtime-drain, DSH runtime constructor injection, and the regression test on `08988a9`; manifest `/tmp/gasteam-ci-drain-final-manifest.sha256`. Frozen offline installation, build, types, 88 focused tests, and 334 regular tests (one optional probe skipped) passed. Logs `/tmp/gasteam-ci-drain-final-{install,build,typecheck,focused,regular}.log`. The earlier failed CI is retained as evidence, not represented as passing.

The same frozen archive also passed 17 process acceptance scenarios, documentation checks, and CLI smoke; logs `/tmp/gasteam-ci-drain-final-{acceptance,docs,smoke}.log`.


## 2026-09-05 — Published shutdown correction and M4 checklist audit

Checkpoint `f05b35e` passed [exact-commit CI](https://github.com/Silktex/dsh-gasteam/actions/runs/33992206500), including 334 regular tests (one optional probe skipped), 17 process scenarios, build, types, docs, and smoke. Receipt: `/tmp/gasteam-ci-f05b35e.json`.

Review of existing published source and tests closes two stale M4 checklist entries without new runtime changes. `SubmissionStore` persists exact task/attempt/source/evidence/policy-revision input before admission, preserves one integration identity, and rejects changed replay. The coordinator fences stale, superseded, cancelled, and non-code submissions. `submissions.spec.ts` proves pending-intent restoration; Team tests prove concurrent pinned admission, reconstruction, failed durability acknowledgement, and conflicting inputs. Cold-process acceptance proves promotion and task-receipt recovery without another worker or merge.

Integration execution acquires ownership under the canonical Git common directory keyed by target branch before verification and holds it through promotion. Team busy-queue tests prove no verification starts under competing ownership; `tests/integration-restart.spec.ts` proves cross-process exclusion and reacquisition after SIGKILL. Real-Git provider tests prove clean-checkout and expected-target guards. These results are covered by the green published checkpoint; broader M4 completion and full-plan acceptance are not inferred solely from these two entries.


## 2026-09-05 — Project-scoped runtime health inbox UI

The Team header now loads the registered Lead's project-scoped health inbox through the existing typed Remote operations, displays severity/condition/diagnostics, and acknowledges with the incident revision. English/Chinese copy covers loading, empty, transport error, stale revision reload, and acknowledged states. Review fixed stale project responses, rejected promise handling, A-to-B-to-A acknowledgement races, and older acknowledgement responses overwriting a newer incident revision. Deferred-response UI tests cover these boundaries.

Frozen archive `/tmp/gasteam-m8-health-f05-1788643001` starts at published `f05b35e`; the five exact UI source/test files are recorded in `/tmp/gasteam-m8-health-final-manifest.sha256`. Build, types, and 27 focused UI tests passed (`/tmp/gasteam-m8-health-f05-validation.log`).

Browser verification ran the shipped React component against isolated mock Remote results. Obscura produced only the collapsed trigger and is not counted as incident evidence. Playwright/Chrome were installed under `/tmp/gasteam-m8-browser-tools-1788643002` with private Debian libraries and fonts, leaving repository dependencies and actual service/data untouched. Native keyboard/CDP text commands produced no input events despite trusted focus. Verification therefore used the native input value setter plus bubbling input/change events, followed by refresh/acknowledgement clicks; this proves rendered handler behavior, not real keyboard transport. Root inspected visible normal, stale-reload, error, and switched-project screenshots. Artifacts: `/tmp/gasteam-m8-browser-{normal,stale,empty,error,switch}.png`, `/tmp/gasteam-m8-fallback.mjs`, and the archive's `.m8-browser` fixture.

This is a project health slice. The full workspace dashboard, activity feed/pagination, remaining operational controls, real service demonstration, and broader M8 acceptance remain unfinished.

The same final UI archive passed 338 regular tests (one optional probe skipped), 17 process acceptance scenarios, documentation checks, and CLI smoke; logs `/tmp/gasteam-m8-health-final-{regular,acceptance,docs,smoke}.log`. Successful acknowledgement was also captured in `/tmp/gasteam-m8-browser-acknowledged.png`, showing the server-derived fixture actor after the revision-fenced action.


## 2026-09-05 — Workspace planning, process replay, and M5 audit

M7 connects exact configured-operator planning to durable host task admission and cross-project dependency dispatch. Code completion requires accepted verified integration; report work requires accepted review. Durable in-app subscriptions survive reconstruction, preserve completion epochs, suppress obsolete undelivered notices on reopen, and acknowledge without external messaging. Model inspection exposes bounded item/dependency/history data with explicit truncation.

Review corrected premature ready visibility, lossy arithmetic revisions, legacy numeric journal restoration, and missing acceptance ordering when a task completed before its submission receipt. Revisions now compare task/generation/attempt/acceptance; numeric and earlier three-field events remain readable. Moving shared planning contracts out of the host coordinator fixed a real browser TypeScript augmentation collision. Model and Remote workflow outputs now include current step revision, attempt count, bounded failure evidence, and retry deadline; the strict Remote fixture was updated accordingly.

A compiled plain-Node fixture runs a real-Git batch across two repositories, kills the coordinator after first integration, restarts with unopened Leads, and verifies both target artifacts, unchanged first assignment/runtime identity, and exactly one dependent attempt. A second restart retains the same completion notice; acknowledgement removes it. Invalid operator and cycle requests fail before admission. Failed-project independence is currently proved at batch-state level only; the actual failing-check/healthy-independent-project integration scenario remains open.

Frozen `/tmp/gasteam-m7-m5-final` begins at `383a107`. Manifest `/tmp/gasteam-m7-m5-final-with-admission-manifest.sha256` records 19 exact source/test files, excluding external routing and new batch RPC drafts. Build, types, 77 focused tests, 18 process acceptance scenarios, docs, and smoke passed (`/tmp/gasteam-m7-m5-final-{build,typecheck,focused,acceptance,docs,smoke}.log`). Final regular suite passed 344 tests with one optional local CLI skip (`/tmp/gasteam-m7-m5-final-with-admission-regular.log`).

Full-suite load exposed the existing inherited-pipe admission fixture's short startup/death race. The fixture now publishes the child identity/ready barrier synchronously, gives the probe a bounded startup allowance, and holds its inherited pipe until the test explicitly releases it after observing timeout and live-child evidence. A 10-second self-exit is only a failed-test backstop; cleanup releases and awaits exit without signaling stored PIDs. The two-file patch independently passed focused tests and the full clean383 suite; manifest `/tmp/gasteam-codex-admission-fix-final-manifest.sha256`.

M5's explicit requirements were audited against current code/tests: `workflows.spec.ts` validates graph/parameters/retry/artifacts, immutable definitions, expensive-step reconstruction, and all three JSON templates; workflow-runtime and coordinator tests prove receipt/task binding, accepted-artifact handoff, invalid-input diagnostics, and the host-only publication gate with exact pause/config/receipt/failure behavior. Tool/Remote tests exercise create/inspect/resume output, while process tests prove report admission crash replay and approved/rejected/repair code workflows. Stale report-only documentation is corrected. These establish M5 completion; actual external publication is not claimed, and remaining M2–M4/M6–M11 and final acceptance retain their full scope.


## 2026-09-05 — Published cross-project checkpoint and M4 audit

Checkpoint `e0b57bb3a167162c2f70aeaf646a59c420722292` passed [exact-commit CI](https://github.com/Silktex/dsh-gasteam/actions/runs/33994124630): 344 regular tests with one optional local CLI skip, 18 process acceptance scenarios, build, types, docs, and smoke. Receipt: `/tmp/gasteam-ci-e0b57bb.json`.

The remaining M4 milestone audit confirms its six checklist requirements against published implementation and evidence. Immutable submission/replay and canonical integration exclusion are documented above. Real-Git tests cover moving/dirty targets, conflicts, failed checks, and accepted promotion; coordinator tests cover bounded distinct success/conflict/exhaustion/cancel repair attempts and automatic diamond-DAG acceptance. Process tests cover reserved repair, queued stale-target retry, and crashes after promotion or task/report receipts without duplicate effects. Candidate-retention tests pin deadlines and settle interrupted cleanup conservatively; Git cleanup tests preserve dirty, ignored, untracked, unmerged, and uncertain output. The installed fixture exercises real Git, and Team UI renders integration phases separately from task/batch completion. These establish M4's integration lifecycle; broader runtime recovery, external-provider code support, batching/bisect, deployment, and all remaining final acceptance retain their own unfinished requirements.


## 2026-09-05 — Project-scoped external assignment routing

Frozen archive `/tmp/gasteam-external-route-health-only-e0b-87Oeh1` layers the reviewed external route on e0b57bb. Admission pins the exact project, canonical directory, executable/version, model and sandbox before reservation; recovery-only admission retains observation and cancellation without silently falling back to DSH. Compiled coordinator tests resolve the standalone supervisor helper. Shutdown retains uncertain capacity, records positive interruption evidence for bounded fresh-generation recovery, and preserves completed reports across cancellation/restart races. Health checks freshly bind helper and wrapper birth identities to the durable attempt, generation and immutable manifest; a swapped live helper is rejected.

Validation in that exact archive: install, typecheck, build, compiled focused tests 55/55, regular tests 362 passed with two explicit optional/default skips, process acceptance 18/18, docs and smoke. Logs and `route-health-overlay.sha256` are retained in the archive. External code worktrees/submissions, actual authenticated model conformance, and full provider usage/interface coverage remain unfinished; M9 remains in progress.
