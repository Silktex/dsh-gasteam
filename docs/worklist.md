# GasTeam & Dark AI Factory: Master Worklist & Product Roadmap

**Document Version:** 2.0.0

**Repository:** `Silktex/dsh-gasteam`

**Target Scope:** Completed autonomous core and proposed opt-in Dark Factory delivery

**Tracking Scope:** Consolidated from `finishme.md`, `pending.md`, `handoff.md`, `darkfactory.md`, and architectural specifications.

---

## Table of Contents

1. [Executive Summary & Global Roadmap Status](#1-executive-summary--global-roadmap-status)
2. [Track A: Core Autonomous Engine (Milestones M0 – M11)](#2-track-a-core-autonomous-engine-milestones-m0--m11)
   * [M0: Baseline & Acceptance Harness](#m0--baseline--acceptance-harness-complete)
   * [M1: Durable Project, Assignment & Execution Records](#m1--durable-project-assignment--execution-records-core-complete)
   * [M2: Autonomous Coordinator & Cold-Start Reconciliation](#m2--autonomous-coordinator--cold-start-reconciliation-core-complete)
   * [M3: Dependency-Aware Scheduling & Dispatch](#m3--dependency-aware-scheduling--dispatch-in-progress)
   * [M4: Submission, Verification, Integration & Cleanup](#m4--submission-verification-integration--cleanup-core-complete)
   * [M5: Reusable Workflows & Session Handoff](#m5--reusable-workflows--session-handoff-core-complete)
   * [M6: Health, Recovery & Escalation](#m6--health-recovery--escalation-pending)
   * [M7: Multi-Project Coordination & Cross-Project Batches](#m7--multi-project-coordination--cross-project-batches-core-complete)
   * [M8: Workspace Dashboard & Operational Controls](#m8--workspace-dashboard--operational-controls-in-progress)
   * [M9: External Runtime Providers](#m9--external-runtime-providers-in-progress)
   * [M10: Merge Batching & Failing-Change Isolation](#m10--merge-batching--failing-change-isolation-pending)
   * [M11: Standalone Release & Localhost Installation](#m11--standalone-release--localhost-installation-pending)
   * [Core Engine Final Acceptance Matrix](#core-engine-final-acceptance-matrix)
3. [Track B: Dark Factory Delivery Gates](#3-track-b-dark-factory-delivery-gates)
   * [SOTA Dark Factory Enhancements & Verification Roadmap](#sota-dark-factory-enhancements--verification-roadmap)
4. [Operational Governance & Runtime Guardrails](#4-operational-governance--runtime-guardrails)
5. [Architectural Invariants & Upstream Gas Town Boundaries](#5-architectural-invariants--upstream-gas-town-boundaries)

---

## 1. Executive Summary & Global Roadmap Status

The M0–M11 core is complete according to the [current handoff](../handoff.md), [pending-work status](../pending.md), and [completion evidence](completion-evidence.md). The detailed Track A checklist below is retained as a historical planning snapshot; its older pending/in-progress markers are not the current completion ledger.

Dark Factory is proposed work. Its canonical requirements, research sources, authority model, defaults, and qualification criteria are in [darkfactory.md](../darkfactory.md). The former five-phase micro-task plan is superseded by Goals 0–5; no Dark Factory implementation gate is claimed complete by this documentation update.

## 2. Track A: Core Autonomous Engine (Milestones M0 – M11)

### M0 — Baseline & Acceptance Harness `[COMPLETE]`
* **Objective:** Establish reproducible, crash-safe, keyless validation baselines before introducing stateful mutations.
* [x] **Discrepancy Audit:** Reconcile source checkouts, runtime patches, and installed DSH profiles. Evidence logged in `docs/completion-evidence.md`.
* [x] **Passing Baseline Verification:** Build, typings, unit tests, and installed smoke test pass cleanly.
* [x] **Crash-Injection Fixtures:** Add buffered IPC barriers, SIGKILL injection, and fresh-process replay fixtures (`tests/assignment-restart.spec.ts`).
* [x] **End-to-End Acceptance Scenario:** Verify persisted ready work is discovered on cold start with zero live browser sessions or pre-opened Leads.

---

### M1 — Durable Project, Assignment & Execution Records `[CORE COMPLETE]`
* **Objective:** Establish immutable, append-only records separating worker identity from execution attempts, bounded by generation fencing.
* [x] **Project Registration & Canonical Repo Identity:** Project catalog with target branch, verification policy, and durable team lookup.
* [x] **Execution Attempts & Generations:** `AssignmentStore` tracking distinct attempt/worker/runtime identities; generation-fenced ownership.
* [x] **Assignment State Machine & Transition Rules:** Documented transition table (`assignments.spec.ts`) preventing illegal replays or stale attempts.
* [x] **Structured Checkpoints:** Persist assignment context, workflow position, named artifacts, and next actions.
* [x] **Concurrent Capacity Bounds:** Replace lifetime roster capacity with active concurrency limits (`maxConcurrentMembers`), separating name retention.
* [ ] **Remaining Work:** Finalize history archival and pagination (mapped to M8).

---

### M2 — Autonomous Coordinator & Cold-Start Reconciliation `[CORE COMPLETE]`
* **Objective:** Single-owner coordinator that reconciles incomplete operations on startup without user intervention.
* [x] **Cold-Start Discovery:** Unattended project discovery from durable state on boot.
* [x] **Single-Writer Authority:** Exclusive coordinator lock preventing split-brain execution across multiple coordinator instances.
* [x] **Recovery & Mailbox Reconciliation:** Restore assignment context and unpromoted verified candidates after cold process restarts.
* [x] **Durable Pause State:** Coordinator respects operator pause across restarts; paused work remains paused.
* [x] **Clean Teardown:** Bound whole coordinator shutdown, cancel and await background tasks, and cleanly release file/journal locks.

---

### M3 — Dependency-Aware Scheduling & Dispatch `[IN PROGRESS]`
* **Objective:** Autonomous task DAG dispatcher honoring concurrency limits, dependency resolution, and fair resource sharing.
* [x] **DAG Auto-Dispatch:** Verified integration automatically unblocks downstream dependent tasks (e.g. Diamond DAG execution without manual intervention).
* [ ] **Priority & Dispatch Persistence:** Persist dispatch requests with strict priority and stable ordering; expose diagnostic reasons for blocked tasks.
* [ ] **Capacity Governance & Pacing:** Enforce global and per-project active worker slots with bounded backoff and anti-starvation fair turns.
* [ ] **Atomic Slot Reservation:** Reserve capacity before provisioning workers; reconcile provisioning crashes without leaking slots.
* [ ] **Queue Pause/Resume & Cancellation:** Differentiate handling between queued requests and active in-flight worker attempts.
* [ ] **Status Surfaces:** Expose read-only dispatch status through model tools and RPC endpoints.

---

### M4 — Submission, Verification, Integration & Cleanup `[CORE COMPLETE]`
* **Objective:** Guaranteed serialization of repository integration using isolated worktrees, moving-target re-verification, and automated cleanup.
* [x] **Idempotent Submission (`SubmissionStore`):** Pin task, attempt, source commit, and verification policy before queuing integration.
* [x] **Canonical Repo Target Locking:** Serialize merge queue per canonical repo and target branch via Linux `flock`.
* [x] **Moving-Target Re-Verification:** Automatically rebuild and re-verify candidate against latest target commit when target advances; bound retry attempts.
* [x] **Automated Repair Attempts:** Dispatch bounded repair attempts for merge conflicts or test regressions, preserving failure diagnostics.
* [x] **Verified Code Acceptance:** Code tasks mark complete *only* after verified integration into the target branch.
* [x] **Audited Non-Code Acceptance:** Explicit acceptance policy for non-code artifacts (documentation, research) requiring Lead verification.
* [x] **Candidate Retention & Cleanup:** Clean successful candidates according to configured retention; safely preserve dirty, untracked, or uncertain checkouts.

---

### M5 — Reusable Workflows & Session Handoff `[CORE COMPLETE]`
* **Objective:** Structured multi-step task execution templates that survive coordinator and worker session resets.
* [x] **Validated Workflow Templates:** Versioned template definitions with step dependencies, required artifacts, and acceptance gates.
* [x] **Immutable Execution Snapshots:** Pin workflow template version per execution to insulate in-flight tasks from concurrent template edits.
* [x] **Checkpointed Handoff:** Resume interrupted workflows in fresh sessions, restoring completed evidence and pending steps.
* [x] **Standard Shipped Templates:** Pre-configured templates for Implementation, Test, Review, Integration, and Investigation.
* [x] **Publication Gates:** Explicit authorization checks before triggering external release or deployment steps.

---

### M6 — Health, Recovery & Escalation `[PENDING]`
* **Objective:** Adaptive health monitoring that nudges, replaces, or escalates failing workers without human debugging.
* [ ] **Attempt State Classification:** Categorize attempts as `progressing`, `idle`, `waiting_dependency`, `waiting_input`, `stale`, or `failed`.
* [ ] **Progress Signals & Deadlines:** Integrate runtime tool activity and durable event timestamps to detect stalled workers.
* [ ] **Graduated Recovery Protocol:** Sequential escalation: prompt nudge $\rightarrow$ checkpointed handoff $\rightarrow$ fenced worker replacement $\rightarrow$ operator escalation.
* [ ] **Durable Escalation Inbox:** In-app operator inbox recording severity, source, diagnostics, and resolution states.
* [ ] **Configurable Notifications:** Opt-in webhook alerts (Slack/Discord) for unresolvable escalations.

---

### M7 — Multi-Project Coordination & Cross-Project Batches `[CORE COMPLETE]`
* **Objective:** Coordinate task DAGs spanning multiple independent Git repositories.
* [x] **Multi-Project Registration:** Dedicated policies, capacities, and target branches per repository.
* [x] **Cross-Project Batches:** Batch structures linking tasks across distinct projects with global dependency cycle rejection.
* [x] **Independent Failure Boundaries:** Ensure integration failure in Project A does not starve or block independent work in Project B.
* [x] **Deduplicated Notifications:** Persist batch completion subscriptions with idempotent delivery.

---

### M8 — Workspace Dashboard & Operational Controls `[IN PROGRESS]`
* **Objective:** Unified operational interface for real-time visibility and intervention.
* [x] **Read-Only Workspace Projection:** View active projects, tasks, attempts, batches, and merge queues.
* [ ] **Pagination & History Retention:** Paginate attempt histories and event logs to prevent memory exhaustion on long-running installations.
* [ ] **Actionable Operational Controls:** UI triggers for pause/resume, task retry, worker reassignment, and escalation acknowledgement.
* [ ] **Real-Time Telemetry & Diagnostics:** Surface verification logs, queue age, capacity utilization, and provider usage.

---

### M9 — External Runtime Providers `[IN PROGRESS]`
* **Objective:** Decouple the execution engine from the host process to support external agents (Codex CLI, Claude Code, OpenCode).
* [x] **Provider Capability Interface:** Standard contract for start, status, cancel, message, and artifact submission.
* [x] **In-Process DSH Adapter:** Wrap legacy subagent driver in the new provider contract.
* [ ] **Authenticated Codex CLI Adapter:** Published Linux subprocess provider running external CLI workers with map-root user namespaces.
* [ ] **Portable Conformance Fixtures:** Deterministic testing harness for external runtimes.
* [ ] **Graceful Process Tree Teardown:** Ensure SIGTERM/SIGKILL cleanly reaps child processes and free ports on cancellation.

---

### M10 — Merge Batching & Failing-Change Isolation `[PENDING]`
* **Objective:** High-throughput merge queue that tests multiple candidates concurrently while isolating bad commits.
* [ ] **Optimistic Stacking:** Stack non-conflicting candidates into speculative merge batches.
* [ ] **Bisection & Split Isolation:** Automatically split and bisect batch candidates when tests fail, identifying the culprit commit without rolling back good work.
* [ ] **Dependency-Aware Merging:** Retain explicit task dependencies during split runs, ensuring child tasks never merge without prerequisites.

---

### M11 — Standalone Release & Localhost Installation `[PENDING]`
* **Objective:** Turn GasTeam into an easily distributable and upgradeable service.
* [ ] **Autonomous Web Profile:** Packaged installation script linking all core plugins into DSH profiles.
* [ ] **Fresh-Clone CI Suite:** Comprehensive GitHub Actions workflow validating clean checkout installation, builds, and acceptance tests.
* [ ] **Migration Tooling:** Safe migration scripts for existing durable JSONL journals.
* [ ] **Production Release:** Validated package distribution and documentation.

---

### Core Engine Final Acceptance Matrix

| Scenario | Acceptance Requirement | Status |
|---|---|---|
| **Unattended Task DAG** | Concurrency respected; dependencies obeyed; all accepted work advances without human dispatch | **Verified** |
| **Browser Closed** | Backend coordinator and worker subagents continue unattended | **Verified** |
| **Cold Server Restart** | Unopened projects resume; accepted tasks are neither lost nor duplicated | **Verified** |
| **Crash During Promotion** | Reconciliation preserves one logical submission and detects already-promoted Git candidates | **Verified** |
| **Worker Turnover** | Arbitrary sequential workers complete within a bounded concurrent capacity | **Verified** |
| **Stale Worker Fence** | Superseded worker attempts cannot submit, complete, or mutate state | **Verified** |
| **Moving Target Branch** | Candidate is rebuilt and re-verified against new target commit | **Verified** |
| **Verification Failure** | Target branch remains protected; bounded repair or visible escalation follows | **Verified** |

---

## 3. Track B: Dark Factory Delivery Gates

Use the [canonical PRD and gate criteria](../darkfactory.md#10-goal-based-delivery-and-acceptance) for implementation. Do not copy task specifications into this worklist.

| Gate | Scope | Status |
| --- | --- | --- |
| Goal 0 | Versioned contracts, configuration, authority and migration fixtures | PRD revised; implementation gate open |
| Goal 1 | Trusted ingress, executable specs and idempotent workflow admission | Proposed |
| Goal 2 | Architecture, tests, mutations, twins, independent critics and signed evidence | Proposed |
| Goal 3 | Durable releases, canary acceptance, containment and verified rollback | Proposed |
| Goal 4 | Redis fleet reservations, usage, quota reserve and model governance | Proposed |
| Goal 5 | Unattended qualification, security/fault tests and staged rollout | Proposed |

The [requirement traceability table](../darkfactory.md#101-requirement-traceability) maps each requirement to its durable owner, receipt, test scenario and metric. Gate completion requires implementation evidence; a document revision is not a passing runtime test.

### Final Integration Task: Autofixer & Self-Healing Engine (`feat/autofixer`)
* **Objective:** Merge the autonomous Autofixer and CI/CD self-healing subsystem into `master` following Dark Factory completion.
* [ ] **Worktree Branch Convergence:** Merge `feat/autofixer` into `master` after Dark Factory sources freeze and all qualification gates pass.
* [ ] **Combined Verification:** Validate that the autonomous system doctor (`scripts/doctor.mjs`), structured error sink (`packages/agent-team/src/error-sink.ts`), diagnostics tool (`packages/tool-agent-team/src/coordinator.ts`), autofix runner (`scripts/autofixer.mjs`), and Web UI Autofixer settings & prompt helper (`packages/client-ui-agent-team/src/client/AutofixerSettings.tsx`) pass all combined tests.
* [ ] **Clean Worktree Pruning:** Safely remove the `/home/dsh/projects/gasteam-autofixer` worktree once merged and verified.

### SOTA Dark Factory Enhancements & Verification Roadmap
* **Objective:** Incorporate modern autonomous software engineering techniques (adversarial mutation loops, property testing, hybrid critics, in-toto attestations, semantic canaries, and batch bisecting) to harden Dark Factory delivery.
* [ ] **Adversarial Mutation Test Generation Loop (Goal 2 / DF-08 Extension):**
  * Implement active test-hardening feedback loop (Meta CoverUp / TestGen-LLM pattern) in `packages/agent-team/src/darkfactory/mutation-engine.ts`.
  * When mutants survive (`SURVIVED`), dispatch an automated test-generation agent with mutant AST diffs to synthesize targeted assertions that kill surviving mutants before quarantine.
* [ ] **Property-Based Testing (PBT) & Invariant Synthesis (Goal 1 / DF-06 Extension):**
  * Integrate `fast-check` into `packages/agent-team/src/darkfactory/spec-compiler.ts` and test generators.
  * Autonomously synthesize state invariants, codec round-trip guarantees (`decode(encode(x)) == x`), and idempotency properties to resolve the "Oracle Problem" across randomized inputs.
* [ ] **Hybrid Symbolic-LLM Critic Matrix (Goal 2 / DF-09 Extension):**
  * Augment the dual LLM critics in `packages/agent-team/src/darkfactory/critics.ts` with a deterministic static analysis critic (Semgrep rules, strict TypeScript AST linter, and ESLint security rules).
  * Require unanimous consent across the hybrid panel (Static Analyzer + 2 diverse LLM models) to eliminate prompt hallucination.
* [ ] **in-toto & SLSA v1.0 Attestation Envelopes (Goal 2 / DF-10 Extension):**
  * Wrap the RFC 8785 canonical signed verification evidence in `packages/agent-team/src/darkfactory/verification-signer.ts` into standard in-toto Attestation statements with SLSA Provenance v1.0 predicates.
  * Enable external cloud-native policy engines (Cosign, Kyverno, Sigstore) to verify Dark Factory artifacts without bespoke verification code.
* [ ] **OpenTelemetry & eBPF Semantic Canary Analysis (Goal 3 / DF-13 Extension):**
  * Extend the Prometheus metric collector in `darkfactory.md` §7.3 with OpenTelemetry distributed trace error ratios and eBPF kernel-level connection/socket reset observation.
  * Catch subtle regressions (silent data corruption, resource starvation, threadpool deadlocks) that do not immediately present as HTTP 5xx responses.
* [ ] **Refinery Batch-and-Bisect Merge Train (Track A / M10 Integration):**
  * Implement optimistic merge stacking of non-conflicting candidate commits in `packages/agent-team/src/integrations.ts` (Gas Town Refinery pattern).
  * Automatically execute binary search git bisections when test suites fail, isolating faulty commits while allowing healthy changes to merge uninterrupted.

## 4. Operational Governance & Runtime Guardrails

The authoritative policies are [fleet economics and model governance](../darkfactory.md#8-fleet-economics-and-model-governance) and [configuration, operations, and recovery](../darkfactory.md#9-configuration-operations-and-recovery--df-19). These define Redis as fleet authority, quota freshness and the 10% emergency reserve, model pinning, optional measured compression, independent pause reasons, retention and recovery runbooks.

Production rollout follows the [qualification and rollout contract](../darkfactory.md#102-unattended-qualification-and-rollout--df-20). Existing workflows remain compatible while Dark Factory is disabled.

## 5. Architectural Invariants & Upstream Gas Town Boundaries

See the [date-pinned Gas Town comparison](gastown-comparison.md) for existing behavior and upstream boundaries. Proposed Dark Factory extensions and their security boundaries are defined in the [canonical PRD](../darkfactory.md#2-existing-seams-and-state-authority); they are not existing implementation claims.
