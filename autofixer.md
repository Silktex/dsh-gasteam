# Autonomous Nightly Review & Fix Playbook (`autofixer.md`)

This document defines the universal execution runbook for any AI coding agent (e.g. DeepSeek Harness, Claude Code, Cursor, Copilot, Codex, Aider, OpenHands) running on a scheduled (9:00 PM nightly) or on-demand basis. It instructs the agent to review project health, audit runtime and test logs, isolate failures, and generate an actionable **Plan of Fix** (or perform safe, verified self-healing).

---

## 1. Project Context, Environment & Multi-Agent Safety Constraints

The agent must respect the following environment invariants and project boundaries before executing any inspection commands:

- **Target Repository**: `Silktex/dsh-gasteam` (Durable Agent Teams plugin for DeepSeek Harness).
- **Runtime Stack**: Node.js (`^22.19` or `>=24`), `pnpm 11.24.0`, TypeScript, Vitest, Cordis 4.
- **Operating System Requirement**: Linux with `util-linux` (`flock` support for Git worktree and coordinator journal locks).
- **Critical Shell Variables**:
  ```bash
  export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH
  export TMPDIR=/var/tmp
  ```
  > **Note**: Linux tmpfs `/tmp` is prone to inode exhaustion during heavy Vitest and esbuild cycles (often reaching >95% inode saturation). Always ensure `TMPDIR=/var/tmp` is set for all child processes and test runs.

- **Multi-Agent Anti-Clobber Isolation Policy (Git Worktrees)**:
  - When multiple agents or automated pipelines operate concurrently (e.g., one agent implementing Dark Factory in [darkfactory.md](darkfactory.md) while an autofixer agent conducts reviews or repairs), **NEVER** edit files directly in the shared main repository working tree.
  - Doing so clobbers uncommitted diffs, causes merge conflicts, and invalidates in-progress test runs.
  - **Always create an isolated Git worktree** for your task:
    ```bash
    git worktree add -b feat/autofixer /home/dsh/projects/gasteam-autofixer master
    cd /home/dsh/projects/gasteam-autofixer
    export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH
    export TMPDIR=/var/tmp
    pnpm install --frozen-lockfile
    ```
  - Worktrees share the canonical `.git` object database while maintaining independent indices, checkouts, and local dependencies.

- **Authentication & Access Model**:
  - **Headless Mode (`pnpm dsh --profile headless`)**: Runs with full process-local host authority. No browser login, cookie, or API token is required. This is the recommended mode for scheduled cron runners.
  - **Web Interface / API**: Uses an ephemeral token printed at service launch (e.g., `http://127.0.0.1:3080?token=...`). Cordis Typert remote RPC (`@Remote`) methods require an active in-memory `Agent` caller scope.

- **Working Tree Preservation Policy**:
  - The working directory may contain in-progress, uncommitted source files and untracked test fixtures (e.g., related to milestone tracking in `finishme.md` and `handoff.md`).
  - **NEVER** run destructive commands: `git reset --hard`, `git clean -fd`, or `git checkout -- .`.
  - Always verify state with `git status --short` before touching any files.

---

## 2. Schedule & Trigger Configuration (9:00 PM Nightly)

The 5-field cron expression for **9:00 PM local time daily** is:
```cron
0 21 * * *
```

### Universal Execution Triggers

#### A. One-Command Autonomous Autofixer (`pnpm autofix`)
The repository includes a dedicated autonomous reviewer and plan-of-fix generator:
```bash
export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH
export TMPDIR=/var/tmp
pnpm autofix
```
- Standard mode (`pnpm autofix`): Runs Doctor, documentation checks, typecheck, build, unit tests, and smoke test.
- Quick mode (`pnpm autofix --quick`): Runs Doctor, documentation, typecheck, build, and smoke test (<15s).
- Full mode (`pnpm autofix --full`): Includes multi-process acceptance suites.
- JSON mode (`pnpm autofix --json`): Outputs structured diagnostic JSON.

#### B. Linux Crontab (`crontab -e`)
Add the following entry to trigger the agent CLI in headless mode at 9:00 PM daily:
```cron
0 21 * * * cd /home/dsh/projects/gasteam && export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH && export TMPDIR=/var/tmp && pnpm autofix >> /var/tmp/autofixer-cron.log 2>&1
```

#### C. Systemd User Timer (`~/.config/systemd/user/`)

**Service (`~/.config/systemd/user/autofixer.service`)**:
```ini
[Unit]
Description=Nightly Project Health & Log Autofixer Agent
After=network.target

[Service]
Type=oneshot
WorkingDirectory=%h/projects/gasteam
Environment="PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
Environment="TMPDIR=/var/tmp"
ExecStart=/bin/bash -c 'pnpm autofix'
```

**Timer (`~/.config/systemd/user/autofixer.timer`)**:
```ini
[Unit]
Description=Trigger Autofixer Agent at 9:00 PM Daily

[Timer]
OnCalendar=*-*-* 21:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

#### D. Generic Coding Agent CLI Invocation
For any interactive or CLI-based coding agent, invoke with the prompt:
```text
Read autofixer.md. Inspect today's work, check runtime/test logs for errors, and synthesize the Plan of Fix report.
```

#### E. Interactive Web UI Settings & Prompt Helper (`WorkspaceDashboard`)
The GasTeam Web UI provides an interactive **Autofixer & CI/CD Setup** panel within the `WorkspaceDashboard`. Operators can configure and preview autofixing policies directly from the browser:
1. **Target Scope**: Toggle between the GasTeam root workspace (`Silktex/dsh-gasteam`) or any registered project ID (e.g. `api`, `web`).
2. **Schedule Modes & Presets**:
   - `Nightly Review` (`0 21 * * *`): Generates daily Plan of Fix reports with P0/P1 remediation.
   - `Continuous CI/CD` (`0 * * * *`): Hourly or trigger-driven verification with 5-minute downtime budget.
   - `Instant P0 Fix`: Dispatches immediate autonomous repairs for P0 Blockers while batching P1/P2 fixes.
   - `Custom Cron`: Operator-defined cron expressions.
3. **Severity Routing Policy**:
   - **P0 (Blocker)**: Instant dispatch with anti-clobber worktree isolation and clean rollback guard (reverts if >2 attempts fail).
   - **P1 (Regression)**: Remediation scheduled for the next CI/CD cycle.
   - **P2 (Warning / Docs)**: Report synthesis only (`reports/nightly-fix-plan-YYYY-MM-DD.md`) without autonomous commits.
4. **Production Downtime Tolerance**:
   - Configurable limits: `0 min` (Zero-downtime / Blue-Green only), `5 min`, `15 min`, `30 min`, or `60 min`.
   - **Threshold Exceeded Policy**: Automatically quarantines candidate worktrees and alerts the operator inbox via `health.jsonl` if projected remediation exceeds the tolerance.
5. **Multi-Agent Anti-Clobber Worktree Isolation**:
   - Enforces isolated Git worktrees and `TMPDIR=/var/tmp` for all autonomous repairs.
6. **Dynamic Prompt Helper**:
   - Generates tailored prompts for external coding agents (DSH, Claude Code, Cursor, Copilot, Codex).
   - Generates matching Linux crontab lines, systemd timer/service units, and CI/CD pipeline steps with one-click clipboard copying.

---

## 3. Autonomous Execution Runbook

When triggered, the agent executes five phases sequentially:

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Environment & Working Tree Sanity Check      │
│  - Runtime versions, git diff/status, active milestones│
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 2: Log Ingestion & Verification Gates            │
│  - Fast Diagnostics (pnpm doctor)                      │
│  - Static Checks (check:docs, typecheck)               │
│  - Dynamic Gates (build, unit test, acceptance, smoke) │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 3: Defect Classification & Root-Cause Triage     │
│  - P0 Blocker / P1 Regression / P2 Flakiness           │
│  - Host, Client, Tool, Environment, Dark Factory       │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 4: Plan of Fix Artifact Generation               │
│  - reports/nightly-fix-plan-YYYY-MM-DD.md              │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 5 (Optional): Safe Self-Healing Verification     │
│  - Worktree isolation, atomic commits, rollback guard  │
└────────────────────────────────────────────────────────┘
```

---

### Phase 1: Environment & Working Tree Sanity Check

1. Verify runtime binaries:
   ```bash
   node --version
   pnpm --version
   git --version
   ```
2. Check Git activity for the past 24 hours:
   ```bash
   git log --since="24 hours ago" --stat --oneline
   ```
3. Inspect current working tree state:
   ```bash
   git status --short
   ```
4. Check active milestone trackers (`finishme.md`, `handoff.md`, [darkfactory.md](darkfactory.md)) to determine current milestones and boundaries.

---

### Phase 2: Log Ingestion & Verification Gates

Execute verification in order of increasing cost. If fast diagnostic checks reveal immediate blockers, prioritize triaging them before running heavy test suites:

#### Step 0: Fast-Path Diagnostics (`pnpm doctor`)
Run the ultra-fast (<500ms) system doctor:
```bash
pnpm doctor
# or for JSON output:
pnpm doctor --json
```
The doctor audits:
1. **Disk & Inode Saturation**: Verifies inode and disk levels across `/tmp`, `/var/tmp`, and root volumes. Warns if `/tmp` inode usage exceeds 90% and verifies `TMPDIR=/var/tmp` is set.
2. **Linux `flock` Locks**: Audits `.git/gasteam-integration-locks/` to detect active integration locks or orphaned locks left by aborted processes.
3. **Leaked Worktrees & Candidate Directories**: Audits `git worktree list --porcelain` and scans `/var/tmp/team-workers/` for abandoned candidates older than 24 hours (run `pnpm doctor --prune` to clean them safely).
4. **Structured Error Telemetry**: Ingests `/var/tmp/gasteam-errors.jsonl` for errors logged across Cordis events and tool executions in the last 24 hours.
5. **Durable Health Escalations**: Checks coordinator `health.jsonl` journals for unacknowledged `stale` or `failed` escalations.
6. **In-Session Agent Diagnostics**: If executing within a live DeepSeek Harness agent session, call the `team_system_diagnostics` tool to inspect active coordinator health.

#### Step 1: Gate 1 — Documentation Alignment
```bash
pnpm check:docs
```
*Validates that all local Markdown links resolve and all `sh`/`bash` code fence blocks have valid syntax.*

#### Step 2: Gate 2 — Typecheck (Dual Host & Client Configurations)
This repository uses separate TypeScript configurations for Node backend (`tsconfig.host.json`) and Web UI client (`tsconfig.client.json`):
```bash
pnpm typecheck
```
*Captures all `TSxxxx` error codes, affected file paths, and interface discrepancies.*

#### Step 3: Gate 3 — Build Generation
```bash
pnpm build
```
*Ensures all 5 package bundles under `packages/*/lib` generate with shared Remote descriptors.*

#### Step 4: Gate 4 — Unit Test Suite
```bash
pnpm test
```
*Runs `vitest run` across 50+ test suites in `packages/agent-team/tests/`, `packages/client-ui-agent-team/tests/`, and `packages/tool-agent-team/tests/`.*

#### Step 5: Gate 5 — Fresh-Process Acceptance Suite
```bash
pnpm test:acceptance
```
*Runs multi-process integration scenarios using actual built plugins and real Git worktrees.*

#### Step 6: Gate 6 — Smoke Validation
```bash
pnpm test:smoke
```
*Validates standalone profile lifecycle, worker cwd, commit, verification, promotion, and release.*

---

### Phase 3: Defect Classification & Root-Cause Triage

Categorize all detected failures into the following triage matrix:

| Severity | Failure Class | Typical Manifestations in `dsh-gasteam` |
| :--- | :--- | :--- |
| **P0 - Blocker** | Process Crash / Deadlock | `flock` contention timeouts, unhandled promise rejections, journal corruption in `durable-journal.ts`, worktree collision in `git-integration-provider.ts` (`TEAM_INTEGRATION_STALE`), smoke test failures. |
| **P1 - Regression** | Test / Build Failure | Broken assertions in `vitest run`, compilation errors in `tsconfig.host.json` or `tsconfig.client.json`, missing exports in `package.json`. |
| **P2 - Flakiness / Warning** | Environmental / Doc Drift | Inode saturation warnings on `/tmp`, sourcemap warnings, transient race conditions in concurrent observer tests, outdated links in `check:docs`. |

#### Triage Analysis Checklist:
- Correlate each failure to recent commits (`git log --since="24 hours ago" -p <file>`).
- Determine defect domain:
  - **Host-side**: `packages/agent-team/src/` (durability, state projection, dispatch queue, coordinator).
  - **Client-side**: `packages/client-ui-agent-team/src/` (React/Cordis UI, workspace dashboard).
  - **Tool-side**: `packages/tool-agent-team/src/` (DSH agent tool registrations).
  - **Environment-side**: Missing binary, path resolution, or filesystem inode exhaustion.
  - **Dark Factory**: Ingest quarantine receipts (`quarantine.jsonl`), failed canary releases (`releases.jsonl`), or digital twin contract violations from [darkfactory.md](darkfactory.md).

---

### Phase 4: Plan of Fix Generation

The agent creates a date-stamped report at `reports/nightly-fix-plan-YYYY-MM-DD.md` (generated automatically via `pnpm autofix`).

#### Standard Report Format

```markdown
# Nightly Health Review & Plan of Fix — YYYY-MM-DD

## 1. Executive Summary
- **Health Score**: [Passing / Degraded / Failing]
- **Commits Reviewed (Last 24h)**: [N]
- **Failing Gates**: [e.g. pnpm typecheck, pnpm test:acceptance]
- **Working Tree State**: [Clean / Uncommitted changes present]
- **Active Milestones**: [Reference to finishme.md / handoff.md / darkfactory.md]

## 2. Defect Ledger
| ID | Severity | Component | Error Description | Source File / Test |
|:---|:---|:---|:---|:---|
| ERR-01 | P0/P1/P2 | [Host/Client/Tool/Env] | [Brief summary of failure] | `path/to/file.ts:line` |

## 3. Deep Root-Cause Analysis
### [ERR-01] <Title>
- **Stack Trace / Failure Snippet**:
  ```
  <Exact log output or assertion failure>
  ```
- **Triggering Commit**: `[commit_hash]` (or uncommitted diff in working tree)
- **Root Cause Deduction**: [Detailed explanation of why the failure occurs]

## 4. Prioritized Plan of Fix
1. **Task 1 (`[Component]`)**:
   - **Target File**: `path/to/file.ts`
   - **Remediation**: [Exact code change or refactoring required]
   - **Verification**: [Exact command to verify fix, e.g. `pnpm test -t "test name"`]
2. **Task 2 (`[Component]`)**:
   - ...

## 5. Verification Gate Status
- [ ] `node scripts/doctor.mjs`
- [ ] `pnpm check:docs`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm test:acceptance`
- [ ] `pnpm test:smoke`
```

---

### Phase 5 (Optional): Safe Self-Healing Protocol

If the agent is explicitly authorized to apply fixes autonomously (rather than only drafting the plan), it must adhere to these safety constraints:

1. **Isolation First**: Never commit directly to `master` and never modify an active shared checkout. Always create a dedicated fix branch in an isolated worktree:
   ```bash
   git worktree add -b fix/nightly-$(date +%Y%m%d)-auto-remediation /var/tmp/gasteam-fix master
   cd /var/tmp/gasteam-fix
   export TMPDIR=/var/tmp
   pnpm install --frozen-lockfile
   ```
2. **Atomic Fixes**: Implement fixes one defect at a time, strictly addressing the identified root cause.
3. **Continuous Verification**:
   ```bash
   pnpm typecheck
   pnpm test
   ```
4. **Clean Rollback**: If a fix causes cascading regressions or cannot pass tests within 2 attempts:
   ```bash
   git checkout -- <modified_files>
   ```
   Document the attempted solution and remaining roadblock in the **Plan of Fix** report for human review.
5. **No Release Actions**: Do not restart production services, publish packages, or push to remote repositories without explicit operator approval.

---

## 4. Main Plugin Optimization Status & Architecture

The following enhancements are integrated into the GasTeam architecture to make this playbook run in seconds with zero test-suite overhead:

### 1. Structured Error Sink Hook (`packages/agent-team/src/error-sink.ts`)
- **Implementation**: Append-only JSONL error sink at `/var/tmp/gasteam-errors.jsonl`.
- **Integration**: Hooked into Cordis `ctx.on('error')` and wrapped around `tools/execute` in `DshHealthRuntimeObserver` (`packages/agent-team/src/health-runtime-observation.ts`).
- **Telemetry**: Captures timestamp, error source (`tool`, `cordis`, `coordinator`, `runtime`), message, stack trace, and agent/attempt identity.
- **Value**: Gives the doctor and autofixer immediate, structured telemetry without parsing arbitrary terminal logs or rerunning slow test suites.

### 2. Fast CLI Triage Tool (`scripts/doctor.mjs`, `pnpm doctor`)
- **Implementation**: High-speed (<500ms) system doctor.
- **Audits**:
  - `flock` lock status in `.git/gasteam-integration-locks/`.
  - Leaked worktrees and candidate directories in `/var/tmp/team-workers/` and `/tmp/`.
  - Inode and storage saturation across `/tmp` and `/var/tmp`.
  - Unacknowledged health escalations from `health.jsonl`.
  - Structured runtime errors from `/var/tmp/gasteam-errors.jsonl`.
- **Options**: `--json` for automation and `--prune` for safe candidate garbage collection.

### 3. Dedicated System Diagnostics Tool (`packages/tool-agent-team/src/coordinator.ts`)
- **Implementation**: `team_system_diagnostics` tool registered on Lead agents.
- **Returns**: Live health status, paused state, active attempt count, unacknowledged health escalations, blocked dispatch count, and recent structured error records.
- **Value**: Enables any AI agent in an active DeepSeek Harness session to query full system health via structured tool execution.

### 4. Automated Candidate Worktree Pruning (`scripts/doctor.mjs --prune`)
- **Implementation**: Conservative garbage collection for abandoned candidate directories older than 24 hours.
- **Value**: Prevents `TEAM_INTEGRATION_STALE` errors caused by aborted or crashed previous worker runs.

### 5. Automated Review & Fix Plan Orchestrator (`scripts/autofixer.mjs`, `pnpm autofix`)
- **Implementation**: Fully automated 5-phase execution runner.
- **Execution**: Runs doctor diagnostics, documentation validation, host/client typechecking, package building, unit tests, and smoke test, categorizing defects and outputting `reports/nightly-fix-plan-YYYY-MM-DD.md`.

### 6. Interactive Web UI Settings & Prompt Helper (`packages/client-ui-agent-team/src/client/AutofixerSettings.tsx`)
- **Implementation**: Interactive browser configuration and prompt generation panel mounted within the `WorkspaceDashboard`.
- **Capabilities**:
  - Configures target scope for GasTeam root or any registered running project.
  - Controls schedule cadence (Nightly, Continuous CI/CD, Instant P0 Blocker fixes).
  - Enforces production downtime tolerance (0m, 5m, 15m, 30m, 60m) with candidate worktree quarantine and operator escalation.
  - Dynamically synthesizes ready-to-use agent prompts, crontab commands, systemd unit templates, and CI/CD steps with one-click clipboard copying.

