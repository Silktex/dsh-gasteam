# GasTeam Handoff Document

- **Timestamp**: 2026-09-06T20:18:00-04:00
- **Primary Workspace**: `/home/dsh/projects/gasteam`
- **Shell Environment**: `PATH=/home/linuxbrew/.linuxbrew/bin:$PATH TMPDIR=/var/tmp`
- **Current Branch / State**: `master` (uncommitted working tree with Gate 1, Gate 2, Gate 3, Gate 4, and Autofixer changes intact)

---

## 1. Executive Summary

In this session, **Dark Factory Gate 4 (Fleet Economics and Model Governance)** was completely designed, grilled, implemented, and qualified per `darkfactory.md` Section 8:
1. **DF-15: Redis Authority, Reservations & Accounting Ledger (`packages/agent-team/src/darkfactory/redis-adapter.ts`, `packages/agent-team/src/darkfactory/fleet-store.ts`)**:
   - `InMemoryRedisAdapter` implementing genuine Redis RESP frame parsing, SHA-1 registered server-side Lua scripts, cluster hash tagging (`{df:fleet:<fleetId>}`), and EVAL/EVALSHA execution without external Redis daemon requirements.
   - Pinned `DarkFactoryFleetStore` managing atomic reservation lifecycle states (`reserved → started → reconciling → settled / withheld`).
   - Monotonic fencing tokens and authority epoch rollover invalidation.
   - Stream sequence gap auto-draining buffer withholding release until gaps are filled or reconciliation deadline expires. Conflicting duplicate digests transition reservation to `withheld` and quarantine attempt.
   - Exact 95.000% spend watermark arithmetic across all 6 hierarchies (Fleet, Project, Host $\times$ daily/monthly) for both money and tokens, activating durable `budget` pause.
   - 100% emergency headroom ceiling accessible strictly via typed control-plane emergencies.
   - Five independent durable pause reasons (`manual`, `safety`, `budget`, `quota`, `catalog`) where clearing one never clears another.
   - Append-only local JSONL audit mirror in `darkfactory/<fleetId>/audit.jsonl` failing closed without substituting for authoritative ledger.
2. **DF-16: Subscription Quotas & Emergency Reserve Pool (`packages/agent-team/src/darkfactory/quota-manager.ts`)**:
   - Authenticated provider quota adapters with 5-minute TTL caching and monotonic snapshot watermarks.
   - Watermark deduction prevents double subtraction of past usage and phantom capacity from in-flight local reservations.
   - Routing waterfall order: primary subscription → ordered alternatives → metered deployments.
   - 10% emergency reserve boundary locking pools to `RESERVED_EMERGENCY_ONLY` when remaining allowance $\le 10\%$.
   - Emergency pool strictly restricted to typed control-plane emergencies: `canary-recovery`, `verified-p0-security`, `production-invariant-recovery`.
3. **DF-17: LiteLLM Catalog, Role Assignment, and Pinning (`packages/agent-team/src/darkfactory/model-catalog.ts`)**:
   - Version-pinned LiteLLM catalog ingestion (15-minute refresh, 30-minute expiry, authenticated `MODELS_UPDATED` webhook).
   - 5-minute capability probes and versioned project benchmark scoring. Stale catalog/probes activate durable `'catalog'` pause.
   - Four role assignment matrices: `fast-loops`, `core-coding`, `deep-reasoning`, and `long-context`.
   - Deterministic 4-tier waterfall sorting: benchmark descending → worst-case cost ascending → measured latency ascending → stable deployment ID.
   - Critic diversity rule (`minimumIndependentProviders: 2`): role assignment supports an `excludedProviders` filter; Critic 1 picks top waterfall model, and Critic 2 strictly excludes Critic 1's provider.
4. **DF-18: Transparent Headroom Guardrail Metadata Normalization (`packages/agent-team/src/darkfactory/compression-normalizer.ts`)**:
   - Headroom operates transparently upstream in the Portainer `llm-router` stack as a LiteLLM guardrail; gasteam manages zero client-side compression engines.
   - Case-insensitive parsing and normalization of `x-headroom-compressed` and `x-headroom-tokens-saved` headers into `UsageEventV1.compression`.
   - `headroom_retrieve` tool definition and `HeadroomRetriever` with attempt-scoped access and storage reachability checks.
   - Invariant enforcement (`assertUncompressedEvidence`): verification evidence, cryptographic signatures, and policy assertions are strictly forbidden from being computed on compressed data.
5. **Public API & Packaging Re-exports**:
   - Re-exported in `packages/agent-team/src/darkfactory.ts` and verified in `packages/agent-team/tests/built-lib.spec.ts`.

---

## 2. Test & Repository Verification Status

The repository passed all verification gates:
- **129/129 test files** passed (**1,629 tests passed**, 2 skipped, 0 failed).
- **21/21 process acceptance tests** passed (`pnpm test:acceptance`, 49.6s).
- **Gate 4 dedicated tests** (266 tests across 5 test files):
  - `tests/darkfactory-fleet.spec.ts`: 55/55 passed.
  - `tests/darkfactory-fleet-watermark-stress.spec.ts`: 23/23 passed.
  - `packages/agent-team/tests/darkfactory/quota.spec.ts`: 82/82 passed.
  - `packages/agent-team/tests/darkfactory/models.spec.ts`: 83/83 passed.
  - `packages/agent-team/tests/darkfactory/compression.spec.ts`: 23/23 passed.
- **0 TypeScript compiler errors** (`pnpm check:types`).
- **0 Markdown documentation lint errors** (`pnpm check:docs`, 15 Markdown files).
- **0 git formatting/whitespace errors** (`git diff --check`).
- **System Doctor CLI** (`node scripts/doctor.mjs` / `pnpm run doctor`): PASSED in 688ms (<800ms) with 0 defects.
- **Distribution Smoke & Release Validation**:
  - `node scripts/test-dsh-team-distribution.mjs` PASSED.
  - `node scripts/standalone-release-validation.mjs` PASSED.
  - `packages/agent-team/tests/built-lib.spec.ts` PASSED.

---

## 3. Key References & Existing Artifacts

- **Dark Factory PRD**: [darkfactory.md](file:///home/dsh/projects/gasteam/darkfactory.md) (comprehensive specifications for Gates 0–5, DF-01 through DF-20).
- **Economics Schemas & Reference Graph**: [economics.ts](file:///home/dsh/projects/gasteam/packages/agent-team/src/darkfactory/contracts/economics.ts) and [economics-reference-graph.ts](file:///home/dsh/projects/gasteam/packages/agent-team/src/darkfactory/contracts/economics-reference-graph.ts).
- **Release Schemas & State Transitions**: [release.ts](file:///home/dsh/projects/gasteam/packages/agent-team/src/darkfactory/contracts/release.ts).
- **Autofixer Architecture & Runbook**: [autofixer.md](file:///home/dsh/projects/gasteam/autofixer.md) (5-phase autonomous fix protocol, error sink, doctor, UI settings).
- **Session Prompt Draft Artifact**: [prompt_draft.md](file:///home/dsh/.gemini/antigravity-cli/brain/ddfbc7e7-b530-456b-a9f0-394ec83ace66/prompt_draft.md) (approved Gate 4 plan and completed criteria).

---

## 4. Critical Invariants & Constraints

- **Preserve Untracked & Working Tree Files**: `/home/dsh/projects/gasteam` contains modified and untracked files representing Gate 1, Gate 2, Gate 3, Gate 4, and Autofixer deliverables. **DO NOT run `git reset --hard`, `git clean -fd`, `git checkout .`, or create Git commits/pushes** unless explicitly requested by the user.
- **Environment**: Always prepend `PATH=/home/linuxbrew/.linuxbrew/bin:$PATH TMPDIR=/var/tmp` when executing commands (`/tmp` previously experienced inode exhaustion).
- **Zero Paid/External Network Calls**: All test runs must use local fixtures, deterministic clocks, and local loopbacks (`127.0.0.1:0`). Zero external LLM calls or unpinned external dependencies.
- **Client Bundle Dev Path Leak Prevention**: In `packages/client-ui-agent-team/src/client/autofixer-settings.ts`, generic placeholders (e.g. `\x27/path/to/repository\x27`) must be used for default paths in crontab/systemd generators so `scripts/test-dsh-team-distribution.mjs` assertion (`!client.includes(repository)`) passes.
- **Canonical JSON & TypeScript Typings**:
  - RFC 8785 canonical JSON throws on `undefined`. Strip optional undefined fields before digest computation.
  - `tsconfig.json` enforces `exactOptionalPropertyTypes: true`. Optional properties taking `undefined` must declare `prop?: type | undefined`. Fetch `RequestInit` does not allow `body: undefined`; omit property when body is undefined.

---

## 5. Next Focus Area: Gate 5 (Configuration, Operations, and Recovery — DF-19 & DF-20)

The next session should implement and qualify **Gate 5** per `darkfactory.md` Section 9 and Section 10:
1. **DF-19: Configuration Contract, Prometheus Metrics & Runbooks**:
   - Coordinator configuration integration: add `darkFactory` to coordinator config with strict validation and startup preflight.
   - Bounded operational Prometheus metrics (registered project, component, source, stage, role, reason; series capped at 10,000 per coordinator).
   - Health inbox alerting and notification deduplication (15-minute cooldown, 3 outbound attempts, escalation).
   - Offline journal migration, 365-day retention policies, and disaster recovery runbooks (Key rotation, Redis recovery, Quarantine review, Forced disable).
2. **DF-20: Goal and Acceptance Verification**:
   - Full dark factory reference graph validation across all 5 gates.
   - End-to-end integration and smoke verification under simulated failures.

---

## 6. Suggested Skills

The next agent should call the **Skill** tool for:
- **`antigravity-guide`**: Reference manual for Antigravity CLI (`agy`), slash commands (`/goal`, `/teamwork-preview`, `/boost`, `/grilling`), and runtime controls.
- **`agy-customizations`**: Reference guide for the Antigravity Customization System if creating or adapting custom skills, rules, hooks, or tools.
- **`grilling`**: Interactive design interview skill to stress-test architectural plans with the user before starting Gate 5.
