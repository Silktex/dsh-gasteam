# GasTeam completion plan

Status: in_progress; baseline and first durable project registration slice implemented. Full unattended acceptance remains incomplete.

Baseline: standalone repository `Silktex/dsh-gasteam`, checkout `/home/dsh/projects/gasteam`, commit `9e27c64cc70c3a497e8c1ebfac6a1cd5e3e4cc9c`. Written 2026-09-05. Recheck the checkout and installed runtime before execution; this baseline is an observation, not a pin for future work.

## Objective and completion criteria

Make GasTeam operate unattended from accepted work through verified integration, with durable assignments, bounded worker capacity, recoverable workflows, actionable failures, and coordination across repositories. Keep the project independently installable using published DSH dependencies. Do not reintroduce the DeepSeek Harness source checkout as a build or runtime prerequisite.

The defining acceptance scenario is: submit a batch of dependent tasks, close the browser, restart the server midway, and observe automatic continuation without duplicate assignments. Every task must end in verified integration, an explicitly accepted non-code result, or a durable blocker visible to the operator. A blocked batch is not a successfully completed batch.

All milestones below are in scope. Priorities establish execution order; lower priority does not mean optional. Real integration checks that cannot run must remain visibly incomplete. Do not claim full Gas Town parity: federation and exact replication of its CLI, role names, storage engine, and terminal interface are outside this plan.

## Current implementation

| Surface | Present | Gap to close |
| --- | --- | --- |
| Team identity | One implicit team per root session; named continuable teammates | Project and coordinator identities independent of a live chat |
| Persistence | Session-backed roster, tasks, messages, batches, integration, recovery | Discovering and servicing unfinished work after a cold process start |
| Mail | Durable queue, receiver receipts, quiet and wakeup delivery | Assignment and workflow-aware startup reconciliation |
| Tasks | Dependency DAG, revisions, ownership, completion evidence | Scheduling, execution attempts, workflow gates, integration-aware completion |
| Workers | Optional isolated Git worktrees; guarded explicit release | Concurrent capacity, turnover, persistent identity independent of attempts |
| Integration | Pinned commits, isolated verification, guarded promotion | Automatic submission, stale-target re-verification, repair, project-wide ordering |
| Background work | Opt-in supervisor and integration worker over live Leads | Durable coordinator operation over unopened teams |
| Recovery | Event-count inactivity detection and bounded attempts | Health classification, backoff, handoff, escalation |
| UI | Team roster, tasks, batches, integration and recovery views | Workspace overview and operational controls |
| Runtime | In-process DSH subagents | Optional external agent providers |

At the baseline the default was eight lifetime teammates. M1 now defaults to eight concurrent teammates and a separate 4,096-name history guard; explicit existing history limits retain their meaning. Candidate integration checkouts are retained even after successful merges. Worktree, integration-worker, and supervisor configuration is opt-in. Existing localhost installation must be inspected before changing it.

Primary implementation locations: `packages/agent-team/src/`, `packages/tool-agent-team/`, `packages/client-ui-agent-team/`, and the two profile packages. Existing tests cover persistence, projection, tasks, messaging, Git operations, tools, RPC, profiles, and browser factories. `scripts/smoke.mjs` exercises the installed CLI with a deterministic model fixture and real Git.

## Goal-loop execution protocol

This document is a plan for a subsequent execution request. Creating it does not start implementation or create an active goal.

Suggested execution instruction:

> Execute finishme.md in /home/dsh/projects/gasteam using the goal loop and TDD. Complete every milestone, keep evidence and the continuation record current, and persist until the objective is achieved or an actual external blocker prevents further useful work.

On execution:

1. Read applicable instructions, this file, `readme.md`, current Git status, and the continuation record. Preserve unrelated work. Inspect changed files before trusting historical completion entries.
2. If the environment provides a goal skill, discover and read it. Do not invent a skill or assume it is installed. Otherwise use available goal tools and disclose that substitution briefly.
3. Read the active goal first. Reuse a matching unfinished goal; do not replace an unrelated goal silently. Create a goal only when the execution request explicitly authorizes it. Do not set a token budget unless one was requested.
4. Select the earliest unblocked acceptance slice. Record the behavior to prove and run its new test before implementation. Confirm that it fails for the missing behavior, rather than a fixture, import, or environment error.
5. Implement the smallest complete slice; make the test pass; refactor while preserving behavior. Update affected contracts, README instructions, fixtures, and this ledger in the same slice.
6. Run the relevant checks once after the final change. Expand testing when the change crosses additional surfaces or new evidence justifies it. A commit or push alone does not justify repeating passing checks.
7. Record exact commands, outcomes, evidence locations, remaining risks, and the next action. Keep concise progress updates during execution. Continue without asking about routine reversible implementation decisions.
8. If one slice is externally blocked, complete independent work. Missing credentials are not passing e2e evidence. Never bypass product permissions or fabricate a successful runtime check.
9. Follow the environment's goal status rules. With the current tools, mark blocked only after the same external blocker has recurred for three consecutive goal turns and no meaningful progress remains. Exhaustion, difficulty, and incomplete work are not completion.
10. Mark complete only after every required acceptance item and release gate passes. If a budgeted goal was used, report final token usage from the goal result. Give the user a self-contained outcome with remaining limitations.

The goal loop is the development executor. GasTeam's scheduler is product behavior; tests must prove that product behavior without relying on the development agent to manually advance work.

## Architecture decisions to settle first

- **Durable authority:** retain event-backed, reconstructable model-visible state. Add a project/coordinator catalog that locates durable teams without scanning only `ctx.agents.list()`. Specify whether catalog entries are authoritative or rebuildable indexes. Prevent catalog and session-log disagreement from silently losing accepted work.
- **Service authority:** existing mutations use exact live Agents as authority. Define a narrowly scoped coordinator service capability for unattended mutations. Do not fabricate Agents or grant background processes unrestricted user authority.
- **Identifiers:** use distinct branded project, worker, attempt, assignment, workflow, escalation, and batch identifiers. Preserve historical references when attempts end or sessions change.
- **Ownership and fencing:** each task has at most one authoritative active assignment. Define durable revision/generation checks and how an old worker is stopped before reassignment. A lease timeout alone does not prove that a worker stopped writing.
- **Repository ownership:** canonicalize repository identity, including worktrees of the same repository. Serialize integration for a repository and target branch across all teams. Start with one coordinator process; a second process must be rejected or fenced, not silently race.
- **Completion:** distinguish worker-reported completion, submitted artifacts, passing verification, and integration. Define a separate explicit acceptance policy for non-code work. Failed checks never produce a successful final batch state.
- **Configuration:** expose deployment choices through validated configuration: capacities, timeouts, retries, retention, verification commands, routing, project policies, and provider selection. Keep correctness requirements fixed.
- **Runtime compatibility:** new durable events must replay through the published runtime. Inspect the existing session and subagent patches. Prefer supported extension points; any unavoidable patch must be minimal, version-pinned, documented, and covered by installed-artifact tests.
- **Storage changes:** explicitly choose migration or actionable rejection before changing existing records. Preserve the installed user's history; do not silently reinterpret or delete it. No unrelated compatibility framework is required.

Keep new services in the existing packages until independent lifecycle or dependency requirements justify a package split. Avoid creating a separate AI process for every Gas Town role when a deterministic service can perform the operation.

## TDD and evidence rules

For every milestone, follow red → green → refactor. Record the observed red failure and the final passing command. Test public behavior and persisted consequences, not private method call sequences.

- Use deterministic model responses for keyless orchestration tests. A provider mock validates orchestration, not compatibility with a real external runtime.
- Use injected clocks or fake timers for scheduling and deadlines; avoid sleep-based assertions. Synchronize subprocess tests with explicit readiness and durable-write acknowledgements.
- Use isolated temporary repositories, data directories, ports, and environment variables. Restore process-global changes and await teardown. Never use the user's localhost data as a failure-injection fixture.
- Exercise actual JSONL round trips, fresh service construction, and fresh processes where restart behavior is claimed. Reusing an in-memory object is not a cold restart test.
- Test crash windows around intent persistence, side effects, receipts, verification, and promotion. Assert recovered state and absence of duplicate effects after replay.
- Use real Git for conflicts, dirty files, moving target branches, worktree retention, and integration. Include ignored and untracked output in preservation cases.
- Capture user/model-visible workflows in deterministic expected transcripts or snapshots owned by this repository. Add the missing harness support if necessary. Assert ordering or IDs only where they are part of observable behavior.
- Exercise browser factories and RPC codecs as shipped. Test loading, empty, stale-revision, error, and successful action states. Preserve existing locale ownership for English and Chinese text.

Existing commands, run from the standalone root:

```sh
export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH
pnpm install --frozen-lockfile
pnpm test packages/agent-team/tests/persistence.spec.ts
pnpm test packages/agent-team/tests/git-integration.spec.ts
pnpm test packages/tool-agent-team/tests/tool-team.spec.ts
pnpm typecheck
pnpm build
pnpm test
pnpm test:smoke
git diff --check
```

The PATH adjustment is specific to the current Linux host. Focused test paths above exist at the baseline. New test filenames below are proposed; create them before invoking them. Build before checks that consume installed artifacts. Do not document commands as available until their package scripts exist.

## Milestones

### M0 — Baseline and acceptance harness

Dependencies: none.

- [x] Inspect the handoff if available, source, runtime patches, installed profile, and CI. Resolve discrepancies between this plan and the checkout; record changes. Evidence: `docs/completion-evidence.md`.
- [x] Establish passing baseline build, types, tests, and installed smoke. Verified baseline: 146 tests; current regular suite: 153. Evidence: `docs/completion-evidence.md`.
- [x] Add isolated fixture helpers for durable restarts, worker progress barriers, and coordinator crash injection. Buffered IPC barriers now cover a real DSH worker model request, durable writes, SIGKILL injection, and awaited fresh-process replay (`tests/assignment-restart.spec.ts`).
- [x] Write the first failing end-to-end acceptance slice: persisted ready work is discovered after a fresh process starts with no browser or pre-opened Lead. `pnpm test:acceptance` fails on missing discovery after proving durable task survival.

Done evidence: exact baseline results and a reproducible behavioral red test for M1/M2. Keep intermediate red work local; do not publish failing release checks.

### M1 — Durable project, assignment, and execution records

Dependencies: M0.

- [x] Define project registration, canonical repository identity, target branch, verification policy, and durable team lookup. Reject malformed configuration before accepting work. Catalog tests and coordinator scoped-admission tests pass; registration precedes task acceptance.
- [x] Introduce execution attempts distinct from worker identity and root-session identity. `AssignmentStore` persists distinct assignment/attempt/worker/runtime identities, generation-fenced ownership, and immutable terminal history; concurrent claim, replacement, and JSONL restoration tests pass in published CI `2c2d76c`.
- [x] Specify and implement legal assignment/attempt transitions, revision checks, terminal evidence, and reconciliation records. The documented transition table and `assignments.spec.ts` cover illegal replay, stale revisions, persisted reservation before activation, checkpoint/report restoration, and stop evidence before capacity release; provider wiring reserves before provisioning.
- [x] Add structured checkpoints containing the assignment, workflow position, artifact references, and next action. Host-pinned task bindings now populate checkpoint workflowId/workflowStep and named input artifacts; operational step retains repair semantics. Public mutation is fenced, JSONL replay preserves bindings, and report/code/reviewer/repair restart tests pass in the isolated M1 archive.
- [x] Replace lifetime roster capacity as the operational limit with concurrent capacity. Bound or archive history independently without breaking references. Spawn and wakeup share `maxConcurrentMembers`; `maxMembers` independently bounds retained immutable names. Four public lifecycle/turnover tests pass; history archival/pagination remains M8 work.

Red tests: concurrent claims yield one owner; stale attempts cannot submit or complete replacement work; crash after assignment persistence is recoverable; nine sequential completed workers can run with capacity two; the third concurrent worker waits; invalid/reused project identifiers and conflicting repository ownership are rejected.

Done evidence: persistence/replay tests and a documented transition table. Suggested tests: `assignments.spec.ts`, `projects.spec.ts`, and existing projection/persistence suites.

### M2 — Autonomous coordinator and cold-start reconciliation

Dependencies: M1.

- [x] Discover unfinished projects/teams from durable state on startup without requiring a user to open their sessions. Built-plugin fresh-process acceptance discovers the original ready task with zero live Agents.
- [ ] Establish the coordinator's explicit mutation authority and single-owner protection. Resolve uncertain prior operations before creating replacements.
- [ ] Restore assignment context and mailbox delivery; reconcile missing workers, provisioning attempts, queued integration, and verified-but-unpromoted candidates.
- [x] Persist pause state. A restart must not reactivate work an operator paused. Built-plugin SIGKILL/restart acceptance preserves revision-one pause and excludes the task from ready work.
- [ ] Bound shutdown, cancel and await background work, and release coordinator ownership safely.

Red tests: full process restart with no live Lead resumes accepted work; two coordinator instances cannot double-dispatch; crash between worker creation and admission is reconciled; pending mail is not duplicated; paused work stays paused; teardown leaves no timer or child process.

Done evidence: M0 acceptance slice passes in a new process with isolated storage. A systemd restart alone is insufficient unless work actually continues.

### M3 — Dependency-aware scheduling and dispatch

Dependencies: M1–M2.

- [ ] Persist dispatch requests with priority and stable ordering. Schedule only eligible tasks; explain why blocked tasks cannot run.
- [ ] Enforce global and per-project active capacity, dispatch pacing, and bounded retry/backoff. Define fairness so one busy project cannot starve another.
- [ ] Atomically reserve assignment/capacity before provisioning. Reconcile failed provisioning without leaking a slot or erasing failure history.
- [ ] Support pause/resume and cancellation with defined treatment of queued versus active work. Expose read-only dispatch status through tools and RPC.
- [x] Dispatch newly eligible dependent tasks automatically using verified integration acceptance. A real-Git diamond DAG completes four tasks once each without manual dispatch or completion; the built-plugin fresh-process gate also completes the persisted DAG; the gate also completes the DAG after killing its active root worker; broader runtime/release acceptance remains.

Red tests: a diamond DAG runs each task once; failed prerequisites block dependents; concurrent scans do not exceed capacity; restart preserves ordering/backoff/pause; a failing project does not starve a healthy one; completed attempts free capacity; stale workers cannot regain authority.

Done evidence: deterministic scheduler tests, model-tool transcript, and an unattended multi-task smoke. Suggested test: `scheduler.spec.ts`.

### M4 — Submission, verification, integration, and cleanup

Dependencies: M1–M3.

- [x] Add one idempotent submit operation that records task/attempt identity, source commit, result evidence, and verification policy revision, then queues integration. SubmissionStore pins immutable inputs and integration identity; coordinator fences stale/cancelled attempts. Pending-intent replay, concurrent pinned admission, and cold promotion/task-receipt recovery pass in published CI `f05b35e`.
- [x] Serialize the queue by canonical repository and target branch across teams. Preserve expected-target checks and clean-checkout requirements. Canonical Git-common-directory/target ownership covers the whole verification/promotion operation. Competing-process SIGKILL, busy-queue preservation, dirty-checkout, and stale-target tests pass in published CI `f05b35e`.
- [x] Rebuild and re-verify candidates when the target advances, with bounded retries. Real-Git preservation and fresh-process queued-retry recovery pass. Never promote a candidate based on checks against a different target.
- [x] Dispatch bounded conflict/test repair as explicit new attempts. Real-Git success, conflict, exhaustion and reserved-repair process replay pass. Preserve the original submission and diagnostics. Exhaustion creates a blocker.
- [x] Mark code work accepted only after verified integration. Required non-code work uses immutable criteria, a durable reviewed-report intent/receipt, and Lead rationale; code acceptance remains unchanged.
- [x] Retire quiescent attempts and clean successful candidates by configured retention. The opt-in scheduler targets only the current final accepted merged candidate and preserves dirty, ignored, untracked, unmerged, or uncertain output; dependency installation/bootstrap for worktrees remains explicit project configuration.

Red tests: duplicate submission creates one job; target movement triggers fresh checks; failing checks do not advance the target; crash after promotion does not merge twice; independent teams cannot race the same target; stale attempt submission is refused; dirty worker output survives cleanup; completed text alone cannot mark a code batch successful.

Done evidence: real-Git regression cases, installed smoke from dispatch through merge, and task/batch UI showing submitted versus accepted work distinctly.

### M5 — Reusable workflows and session handoff

Dependencies: M1–M4.

- [x] Define validated, versioned workflow templates with parameters, step dependencies, acceptance requirements, retry policy, and artifact references. Choose one file format and document it.
- [x] Persist an immutable workflow definition/version for each execution so editing a template does not alter in-flight obligations.
- [x] Implement checkpointed execution and fresh-session handoff with task evidence, pending steps, and unresolved blockers restored.
- [x] Ship implementation/test/review/integration and investigation/report templates. Include a release template with an explicit externally authorized publication gate.
- [x] Add workflow create/inspect/resume controls and clear diagnostics for missing parameters or invalid graphs.

Red tests: invalid template rejected before dispatch; completed expensive steps survive restart; failed review prevents integration; changing a template does not mutate a running workflow; handoff resumes the first incomplete step; external publication cannot occur without the configured authorization being satisfied.

Done evidence: workflow tests and expected transcripts for both code and non-code paths. Suggested test: `workflows.spec.ts`.

### M6 — Health, recovery, and escalation

Dependencies: M2–M5.

- [ ] Distinguish progressing, idle, waiting on a dependency, awaiting operator input, stale, unavailable, and failed attempts. Avoid treating all unchanged event counts as a stuck worker.
- [ ] Define progress signals and configurable deadlines for DSH and external providers. Combine authoritative runtime state with durable work state.
- [ ] Apply bounded recovery stages: prompt/nudge where appropriate, checkpointed handoff, fenced replacement, then escalation. Preserve ownership until replacement is safe.
- [ ] Persist severity, source, diagnostics, affected work, acknowledgement, resolution, and bounded re-escalation state.
- [ ] Provide a durable in-app operator inbox. External notification transports must be configurable and explicitly enabled; do not send test messages to real people.

Red tests: a legitimate long-running tool is not restarted before its deadline; input-waiting work is classified correctly; repeated scans do not create duplicate recoveries/escalations; recovery budget survives restart; acknowledgement stops repeat notifications; stale replacement cannot modify task state.

Done evidence: fake-clock recovery tests, failure transcripts, and an operator flow from exhausted recovery to acknowledged and resolved blocker.

### M7 — Multi-project coordination and cross-project batches

Dependencies: M3–M6.

- [x] Expose project register/inspect/pause operations with repository-specific policy and capacity. Persist coordinator identity independently of browser chats.
- [x] Extend batches to reference globally identified work across projects and teams. Detect cycles across project dependencies.
- [x] Derive batch progress from required acceptance states, retaining reopened and failed histories. Show ready work without an active assignment as an actionable condition.
- [x] Persist completion subscriptions and deduplicated notification delivery. Reopening and later completion must have explicit notification semantics.
- [x] Support a coordinator planning interaction that creates and dispatches a multi-project batch through the same validated services.

Red tests: a dependency spanning two repositories runs in order; project A's failing checks do not block unrelated project B work; cross-project cycles are rejected; restored batches do not emit duplicate completion notices; one task's text completion cannot hide an unmerged required change.

Done evidence: a keyless two-repository installed smoke, cross-project status transcript, and project-specific configuration examples.

### M8 — Workspace dashboard and operational controls

Dependencies: M3–M7; build small UI slices alongside the owning services.

- [ ] Show projects, workers/attempts, assignments, workflow steps, batches, merge queues, and escalations in one workspace view.
- [ ] Show actionable reasons for blocked work, queue age, capacity usage, last progress, retries, and relevant verification diagnostics. Add usage/cost data only when the provider reports it; unknown must remain unknown.
- [ ] Add pause/resume, safe cancellation, retry, reassignment, handoff, and escalation acknowledgement using typed service operations and revision checks.
- [ ] Provide an activity feed with durable event references and reconnect behavior. Paginate/bound history so long-running projects do not require loading every attempt.
- [ ] Update model tools, RPC descriptors/codecs, English/Chinese copy, keyboard access, and browser error states with each operation.

Red tests: actions affect the selected project/attempt only; stale views receive recoverable conflicts; loading and reconnect do not lose or duplicate events; paused/blocked state remains visible after reload; unknown usage is not displayed as zero; keyboard-operated controls invoke the same validated actions.

Done evidence: browser-factory and RPC tests, representative expected UI output, and a recorded demonstration from the real running feature. If publishing a PR with a demo, use an applicable browser-recording skill when available.

### M9 — External runtime providers

Dependencies: M1–M6.

- [ ] Define provider capabilities for start, resume or fresh-session handoff, status, cancellation, messaging, artifact submission, and optional usage. Advertise unsupported operations explicitly.
- [ ] Adapt the current in-process DSH implementation to that interface without changing its existing guarantees.
- [ ] Implement at least one external CLI provider selected from the authenticated runtimes actually available on the host. Record the selected runtime/version and verify its official documentation at implementation time.
- [ ] Route provider choice by project or task policy. Preserve existing permissions, cwd isolation, identity fencing, and durable admission semantics.
- [ ] Classify startup/authentication errors and unsupported resume behavior. Terminate owned process trees on cancellation and teardown; do not claim process death from missing output alone.

Red tests: capability mismatch fails before assignment activation; CLI launch failure creates a recoverable attempt; restart uses the persisted runtime identity; late output from a cancelled attempt is rejected; cancellation cleans descendants; provider-reported usage is attributed to the correct attempt.

Done evidence: deterministic provider conformance suite plus a real installed external-runtime task producing a verified artifact. If credentials or a usable CLI are unavailable, record that exact blocker and finish independent milestones; fixture success does not complete this acceptance item.

### M10 — Merge batching and failing-change isolation

Dependencies: M4 and stable sequential integration evidence.

- [ ] Add configurable candidate batching while retaining a sequential mode for diagnosis and small projects.
- [ ] Verify ordered candidate stacks against the current target; isolate failing submissions with a bounded bisect/split policy.
- [ ] Track per-submission acceptance and retain diagnostics so a rejected submission does not appear merged when other changes succeed.
- [ ] Re-verify any changed candidate composition. Honor explicit dependencies between submissions; do not merge dependents whose prerequisites were excluded.

Red tests: one bad submission among independent good ones is isolated; dependent changes are held with their failed prerequisite; combinations that fail together are handled without assuming individual pass implies combined pass; target movement invalidates old verification; restart during isolation does not duplicate promotion.

Done evidence: real-Git batch tests proving target contents and per-task state, not merely the number of verification commands run.

### M11 — Standalone release and localhost installation

Dependencies: M0–M10.

- [ ] Update `readme.md` with installation, project setup, unattended operation, workflow examples, recovery, runtime providers, troubleshooting, retention, and uninstall/rollback instructions.
- [ ] Provide a validated autonomous profile/example enabling the required worktree, scheduler, coordinator, integration, and supervisor components together. Show required target branch and verification configuration explicitly.
- [ ] Add fresh-clone CI covering frozen install, build, types, host/client tests, deterministic restart acceptance, and installed CLI smoke. Add suitable scripts for the new acceptance suites.
- [ ] Run clean-install validation outside the development checkout using published runtime dependencies and committed patches only. Verify that no path references the former full harness checkout.
- [ ] Test upgrade against a backed-up fixture of the existing durable format. Confirm either supported restoration or the documented actionable migration path before touching localhost state.
- [ ] When installation is authorized by the execution request or existing session authorization, back up profile/service settings and durable data consistently, install, restart, and verify localhost health and an isolated autonomous project. Preserve unrelated profiles and sessions.
- [ ] Commit/push only within the applicable authorization, inspect the outgoing diff for secrets and generated residue, and verify CI for the exact published commit. If publication is not authorized, leave a concrete verified change ready for review and record that remaining release action.

Done evidence: clean-clone logs, exact commit and CI result if published, localhost verification if installed, and final acceptance artifacts below. Never use a passing earlier commit as evidence for later edits.

## Final acceptance matrix

| Scenario | Required observation |
| --- | --- |
| Unattended task DAG | Capacity respected; dependencies obeyed; every accepted task advances without manual dispatch |
| Browser closed | Backend orchestration continues independently |
| Cold server restart | Unopened projects resume; accepted assignments are neither lost nor duplicated |
| Crash during submission/promotion | Reconciliation preserves one logical submission and recognizes already-integrated work |
| Worker turnover | More than eight sequential workers complete while concurrency stays bounded |
| Stale worker | Superseded attempt cannot submit, complete, or reclaim replacement work |
| Verification failure | Target remains protected; bounded repair or visible blocker follows |
| Target branch moves | Candidate is rebuilt and checked against the new target |
| Workflow handoff | Durable completed steps remain complete and the next required step resumes |
| Recovery exhausted | One actionable escalation remains visible and can be acknowledged/resolved |
| Two repositories | Shared batch progresses with independent project configuration and correct cross-project dependencies |
| Merge batch failure | Passing independent changes land; failed/dependent changes retain accurate blocked state |
| External runtime | A real supported CLI completes one verified assignment; cancellation/restart conformance also passes |
| Output preservation | Cleanup retains dirty, ignored, untracked, unmerged, and uncertain work |
| Standalone installation | Fresh clone builds and runs without any full-harness source checkout |

## Progress and continuation record

Update this section at each completed slice and before yielding. Checkboxes above require evidence, not estimates. Use `pending`, `in_progress`, `blocked`, or `done`; record a blocker narrowly enough to reproduce it.

| Milestone | Status | Evidence |
| --- | --- | --- |
| M0 Baseline/harness | done | Baseline verified, fresh-process behavioral red established, and real-worker progress/crash fixture passes. See `docs/completion-evidence.md`. |
| M1 Durable records | done | Canonical project registration, distinct durable attempt/worker/runtime identities, legal revision-fenced transitions and stop evidence, immutable structured workflow checkpoints, and concurrent capacity/turnover are implemented. Requirement-specific assignment/projection/coordinator tests and 17 process scenarios pass; current clean M1 archive passes 325 regular tests with one explicitly optional local CLI probe skipped. See completion evidence and transition table. |
| M2 Cold-start coordinator | in_progress | Stable identity, directory ownership, scoped host admission, startup discovery, durable diagnostics, and pause implemented; nine fresh-process scenarios pass, including a complete DAG and crashes after promotion/task receipt. In-process interrupted-worker continuation preserves worktree edits and completes a dependent DAG. Broader provisioning/mail/integration recovery remains. |
| M3 Scheduler | in_progress | Configured scans reserve/admit independent tasks with global/project capacity and durable priority/order, fair project turns, and restart-safe pacing. Three process acceptance scenarios pass. Scoped model/Remote status, pause and priority controls are implemented. Cancellation intent and paused shutdown reconciliation are implemented. Verified dependency release passes a real-Git diamond DAG. Retry/backoff and global operator controls remain. |
| M4 Integration lifecycle | done | All six requirements have published evidence: immutable idempotent submissions; canonical repository/target exclusion; bounded stale-target re-verification; distinct bounded repair attempts; verified code and explicitly reviewed report acceptance; conservative opt-in candidate retention. Real-Git, process crash/replay, installed smoke, and visible integration/task states are covered by published e0b57bb CI. See completion evidence. |
| M5 Workflows/handoff | done | Requirement audit maps validated versioned JSON, immutable execution definitions, checkpointed fresh-worker handoff, report/code/release templates, and typed controls/diagnostics to workflow, coordinator, tool/Remote, and real-Git process tests. Publication remains an explicitly configured host publisher with a server-only gate; no actual external publication is claimed. See completion evidence. |
| M6 Recovery/escalation | in_progress | Opt-in observational health store, generation-fenced attempt observations, Lead-scoped escalation inbox, and typed acknowledgement are implemented. Unknown live operations do not create incidents; provider probes, recovery/replacement actions, external notifications, and dashboard UI remain unfinished. |
| M7 Cross-project batches | done | All five requirements map to published03a6920: project policy/authority, union dependency graph, current-attempt acceptance and failed/reopened history, durable notification epochs/acknowledgements, and operator planning through model/typed Remote services. Real compiled-plugin keyless two-repository process tests prove dependency ordering, independent failure recovery, exact assignment counts and notification replay. Consumer-package installation remains M11. |
| M8 Dashboard | in_progress | Project-scoped health inbox, revision-fenced acknowledgement, loading/empty/error/stale/project-switch states, and English/Chinese copy are validated. Chrome fixture evidence uses explicit DOM input-event fallback; native keyboard transport was unavailable. Full workspace view, activity pagination, remaining operational controls, and real service demonstration remain open. |
| M9 External providers | in_progress | Capability/CLI adapter, durable attempt store, compiled PID-namespace supervisor, idempotent launch claims, and stop/spool proof validated. Combined checkpoint passes 306 regular tests and 17 process scenarios. Verified CLI admission and the isolated external assignment adapter are validated. DSH adaptation, coordinator routing, external code integration, and real authenticated assignment conformance remain unfinished. |
| M10 Merge batching | pending | — |
| M11 Release/install | pending | — |

Continuation fields:

- Active goal identifier/objective: existing active thread goal `/home/dsh/projects/gasteam/finishme.md`; no token budget.
- Current milestone and acceptance slice: M2 bounded whole-operation teardown, M6 durable recovery with real reserved-message replay, M9 external code-worktree/submission integration, and remaining M7/M8 workspace operations.
- Last completed slice: published external non-code routing/recovery (185286b), authoritative live DSH health observer (cf56d86), and typed workspace batch RPC plus failed-A/independent-B process acceptance (03a6920). All three exact GitHub CI runs passed.
- Red evidence: non-code test initially entered Git submission; review caught report receipt replay/durability gaps and missing review queue. Workflow review caught erased authorization history, unenforced backoff and conflated receipt stages. Consolidated tests caught two obsolete Remote expectations; new codec tests tighten report revision/rationale validation.
- Green evidence and exact commands: latest exact CI33995336253 passed build/types/regular/process/docs/smoke. M7 process suite has19 scenarios; combined cf56 + M7 archive passes build/types and57focused tests. See completion evidence and /tmp/gasteam-ci-03a6920.json.
- Changed files and commit: published through03a6920. Uncommitted external-code worktree/integration, M2 shutdown, and M6 recovery drafts remain with their owners and are not release evidence. Preserve local readme.md draft, .agents/, skills-lock.json and pending.md.
- Open decisions/constraints: uncertain reserved-runtime ownership still holds capacity for repair. Disabled execution cannot restore an unopened Lead without configured runtime authority. Retention cleanup observes only canonical live in-process Agents; it has no external ownership proof. An interrupted cleanup becomes uncertain and is never automatically retried. Global workspace-operator authorization, whole-operation startup/shutdown bounds, retry/backoff, interrupted-attempt handoff, and broader acceptance remain unfinished.
- External blockers: none established. Installed Codex CLI 0.153.4 reports authenticated status, and the host supports a disposable user/PID namespace probe. A real authenticated external assignment and cancellation/restart conformance remain unproved.
- Next concrete action: finish agents' M2 teardown deadline regression, M6 real AssignmentStore/TeamService recovery replay and coordinator wiring, and external code-worktree/submission vertical. Validate isolated final overlays, publish passing checkpoints, then complete every remaining milestone and final acceptance requirement.
- Release actions still required: M2–M11, full final acceptance, and applicable publication/installation verification. Local service was inspected only; no restart or durable-user-data modification occurred.
- Previous goal-turn classification: progress — three verified implementation checkpoints published with passing exact CI; active agents implementing remaining slices. Temporary /tmp inode exhaustion was resolved by removing obsolete validation dependency trees while preserving source and evidence.

## Research references

These sources informed the feature comparison. They describe upstream behavior, not proof that GasTeam implements it. Recheck upstream source and runtime documentation when implementing version-sensitive integrations.

- [Gas Town overview, roles, merge queue, and dashboard](https://github.com/gastownhall/gastown/blob/main/README.md)
- [Capacity-controlled scheduler](https://github.com/gastownhall/gastown/blob/main/docs/design/scheduler.md)
- [Assignments, worker identity, and handoffs](https://github.com/gastownhall/gastown/blob/main/docs/glossary.md)
- [Workflow formulas and checkpoints](https://github.com/gastownhall/gastown/blob/main/docs/concepts/molecules.md)
- [Cross-project convoys](https://github.com/gastownhall/gastown/blob/main/docs/concepts/convoy.md)
- [Escalation protocol](https://github.com/gastownhall/gastown/blob/main/docs/design/escalation.md)
- [Agent provider integration](https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md)

## Documentation deliverables

- [ ] Create `docs/usage.md` with detailed operator guidance for registering a project, configuring repository and verification policy, submitting dependent tasks and batches, running unattended coordination, monitoring assignments and integration, pausing/resuming/cancelling work, accepting non-code results, and using workflow and runtime-provider controls. Include complete examples, expected state transitions, and links to the relevant CLI, model-tool, RPC, and dashboard surfaces that actually ship.
- [ ] Create `docs/installation.md` with prerequisites, supported runtime and package-manager versions, fresh-clone and published-package installation, build/profile configuration, autonomous service startup, required repository permissions, upgrade and durable-data migration, health verification, backup, rollback, and uninstall steps. Clearly separate development-checkout instructions from standalone installation and ensure no instructions depend on the former full DeepSeek Harness source checkout.
- [ ] Create `docs/debug.md` with a symptom-oriented troubleshooting guide for coordinator startup and ownership, undiscovered or undispatched tasks, capacity stalls, worker/runtime failures, mailbox delivery, stale attempts, verification and merge failures, restart recovery, retained worktrees, profile/service configuration, and UI/RPC connectivity. For each case, identify safe diagnostic commands and evidence locations, explain healthy versus faulty output, and provide recovery steps that preserve durable state and unmerged work.
- [x] Add a `docs/README.md` documentation index and link it from `readme.md`. Cross-link the usage, installation, and debug pages with `docs/autonomous-architecture.md` and `docs/completion-evidence.md`; remove duplicated procedural text where a canonical page is clearer without weakening the top-level quick start.
- [ ] Validate every documented command against a clean standalone installation and the shipped CLI/profile. The link/shell checker is in CI, and a disposable committed-archive run covers frozen install, build, CLI help, and Web/headless profile linking; clean external installation, authenticated model calls, service operation, backup/rollback, and full command coverage remain open. Record the exact validation evidence in `docs/completion-evidence.md`, and keep this task open wherever the corresponding product surface or real-runtime acceptance remains incomplete.
