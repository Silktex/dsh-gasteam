# Gas Town and GasTeam capability comparison

**Scope date:** 2026-09-05. **GasTeam evidence:** published commits through
[`1b209a3`](https://github.com/Silktex/dsh-gasteam/commit/1b209a3), including the
live DSH operation observer in `cf56d86`, external non-code routing in `185286b`,
and the bounded workspace dashboard. This is a capability comparison, not a
claim of feature or operational parity. GasTeam’s [completion evidence](completion-evidence.md)
and [milestone ledger](../finishme.md) remain the authority for what is tested
and what is unfinished.

**Upstream scope:** current `gastownhall/gastown` README, architecture and
reference documentation reviewed on the scope date. Gas Town changes quickly;
links identify the upstream behavior being compared. “Not established” means
these sources did not establish an equivalent capability, rather than proving a
universal negative.

## Terms and boundaries

| Gas Town term | Closest GasTeam term | Boundary |
| --- | --- | --- |
| Mayor | Registered project Lead and `WorkspaceCoordinator` | The Mayor is an autonomous upstream role. GasTeam uses host-authorized services and an exact live Lead for mutations. |
| Polecat | DSH assignment attempt / teammate | Both use isolated workspaces, but Gas Town documents persistent polecat identity with ephemeral sessions; GasTeam fences attempt generation and revision. |
| Rig | Registered project | Both bind repository policy and teams; GasTeam has no HQ directory or prefix-routed Beads database. |
| Bead | Team task, workflow step, or batch item | Similar work tracking, different persistence and authority models. |
| Witness / Deacon | Health observation and escalation services | Gas Town has persistent monitoring roles. GasTeam has a published live DSH tool observer and external fresh-health probe, but not the full recovery role. |
| Refinery / MR | Team integration | Both gate integration; upstream uses a batch-then-bisect refinery while GasTeam currently serializes individual admitted integrations. |
| Convoy | Workspace batch | Both coordinate work across projects. |
| Formula / molecule | Versioned workflow template | Both describe reusable staged work; their runtime/agent semantics differ. |
| Town mail | Durable Team mailbox | Both deliver coordination messages; neither terminology establishes a protocol equivalence. |
| Beads / Dolt | JSONL journals and projections | Deliberately different stores. Upstream describes a per-town Dolt SQL server; GasTeam uses append-only JSONL journals. |

Gas Town’s own architecture documents its two-level Beads layout, persistent
roles, worktree arrangement, and Dolt storage model in its
[architecture](https://github.com/gastownhall/gastown/blob/main/docs/design/architecture.md).
Its [reference](https://github.com/gastownhall/gastown/blob/main/docs/reference.md)
documents prefix routing and merge-queue configuration.

## Capability matrix

| Capability | Gas Town upstream evidence | GasTeam status | Evidence and limit |
| --- | --- | --- | --- |
| Parallel agents and isolated worktrees | **Implemented.** Polecats and the refinery use worktrees; crew uses full clones. | **Implemented.** | Team worktrees, capacity and real-Git integration are published. GasTeam is a DSH plugin, not a standalone town manager. |
| Task tracking and dependency work | **Implemented.** Beads route project and HQ work; convoys coordinate work. | **Implemented for Team tasks and M7 batches.** | Project/task dependencies and cross-project batch admission are published; all upstream Beads semantics are not reproduced. |
| Cross-project coordination | **Implemented.** HQ Beads, Mayor and convoys coordinate rigs. | **Implemented.** | Published M7 has project registration, union dependency checks, durable batch notifications and two-repository process evidence. |
| Workflow recipes, wisps and gates | **Implemented/partly design-documented.** Formulas/molecules are upstream primitives; wisps and gates also appear in reviewed upstream design/release material, but the plugin-system design labels itself a proposal. | **Implemented, different model.** | GasTeam workflow templates have dependency/artifact/review gates and durable steps. It has no formula/protomolecule/wisp format or compatibility layer. |
| Merge queue and verification | **Implemented.** Refinery batches MRs, tests stacks and bisects failures. | **Implemented, narrower.** | GasTeam verifies and serializes admitted integration candidates, revalidates moving targets, and has bounded repair evidence. **M10 batch/bisect is open.** |
| Code and non-code acceptance | Upstream sources establish MR/refinery completion; they do not establish GasTeam-style immutable non-code receipts. | **Implemented.** | Code acceptance follows verified integration; report acceptance has an immutable review decision/receipt. This is a GasTeam design distinction, not proof that no upstream analogue exists. |
| Worker health observation | **Implemented.** Witness patrol and Deacon roles are documented. | **Partial.** | `cf56d86` proves live DSH tool-dispatch observation; `49cee91` includes fresh external health identity handling. Unknown execution remains unknown rather than “stuck.” |
| Nudge, handoff, replacement and escalation delivery | Upstream documents Witness intervention and lifecycle patrol. | **Partial / open.** | GasTeam has an operator-scoped, revision-fenced escalation inbox. Durable health nudge and recovery drafts are not published completion evidence; full handoff/replacement, external notification and re-escalation remain M6 work. |
| Cold restart and crash reconciliation | Upstream documents persistent role/bead state and lifecycle patrol. | **Implemented for published bounded slices.** | Assignment/workflow/batch/integration process tests cover specific crash boundaries. This is not proof of unattended recovery for every provider and operation. |
| External agent runtimes and session handoff | The current README lists Claude as default and documents alternatives/presets including Codex, Copilot, Gemini and Cursor; polecat identity can outlive an ephemeral session. | **Partial.** | GasTeam’s DSH runtime and exact checkpoint context are published. Codex admission/adapter/supervisor slices and controlled external non-code routing (`185286b`) are published; authenticated external assignment, cancellation/restart conformance and external code integration remain M9 work. |
| Operator dashboard | **Implemented.** `gt feed` is a TUI; upstream also documents a web dashboard and command palette. | **Partial.** | `1b209a3` adds a read-only, operator-authorized DSH workspace dashboard with projects, attempts, workflows, batches, dispatch blockers, integrations and escalations. It is bounded/truncated; cursor activity feed, usage, controls and real service demonstration remain M8 work. |
| Terminal operations UI | **Implemented.** `gt feed` provides activity and problems views with nudge/handoff actions. | **Not established.** | GasTeam has no equivalent terminal fleet UI in the reviewed published source. |
| Storage and routing | **Implemented.** Upstream uses prefix-routed Beads backed by a per-town Dolt SQL server; its architecture says no embedded-Dolt fallback. | **Different implementation.** | GasTeam persists JSONL journals/projections with revision and generation fences. It has no Dolt/Beads compatibility layer. |
| Federation and work economy | **Implemented outside the core town through Wasteland.** Gas Town documents `gt wl` commands; Wasteland documents DoltHub federation, claims, completions and reputation. | **Not established.** | GasTeam has no reviewed federation, shared wanted board, reputation, or external work economy. |
| Telemetry | **Implemented.** The upstream README documents OTLP logs and metrics. | **Not established.** | No equivalent published GasTeam OTLP surface was established by this review. |
| Crew and Dogs | **Implemented.** Crew are persistent human workspaces; Dogs are town-level long-running cross-rig workers. | **Not established.** | GasTeam has Leads and teammates, but no reviewed Crew/Dog role model or equivalent lifecycle contract. |
| Hooks, work attachment and patrol | **Implemented.** Upstream documents persistent hooks/work attachment, Deacon/Witness patrol and role lifecycle. | **Partial / different.** | GasTeam has durable task/assignment records, mailbox delivery and scans. It has no reviewed Hook/GUPP protocol or named patrol command family. |
| Agent identity and session continuity | **Implemented.** Upstream documents persistent agent beads and ephemeral polecat sessions. | **Implemented, different.** | GasTeam preserves assignment/attempt identity, generation, checkpoint context and selected restart boundaries. It does not claim upstream `seance` or role-session semantics. |
| Configuration, directives and permissions | **Implemented.** Upstream documents town/rig settings, role directives and role-specific settings injection. | **Partial / different.** | GasTeam has typed plugin/coordinator config, project registration and exact Lead/operator authorization. It has no reviewed upstream-compatible directives, role settings hierarchy, or town-wide permission language. |
| Doctor, backup and recovery command families | **Implemented/partly release-documented.** `gt doctor` is documented; releases list patrol, reaper and backup skills. | **Partial.** | GasTeam has debugging guidance and bounded recovery evidence, but no reviewed `doctor`, backup or restore command family. M11 backup/rollback validation is open. |
| Installation and lifecycle | **Implemented.** `gt install`, `gt up`, `gt doctor` and standalone prerequisites are documented. | **Partial.** | GasTeam supports a pinned checkout/profile-link workflow and isolated smoke validation. Consumer package/registry installation, production service operation, backup/rollback and full standalone release proof remain M11 work. |

## Important differences

Gas Town is a standalone Go workspace manager with an HQ, tmux-backed roles,
Beads/Dolt storage and its own CLI. Its [README](https://github.com/gastownhall/gastown)
describes `gt up`, Mayor/Witness/Deacon/Refinery roles, `gt feed`, a web
dashboard, the refinery, provider presets, telemetry and Wasteland integration.

GasTeam is a TypeScript plugin for published DeepSeek Harness dependencies. Its
coordination services deliberately use typed host code, durable journals, exact
operator/Lead checks, revision checks and generation fencing. That describes its
implementation choice; it does **not** imply zero total LLM cost, mathematical
predictability of model work, or superiority over Gas Town.

## Gas Town features not provided by the reviewed GasTeam release

- A Gas Town-compatible `gt` CLI, HQ, role names, tmux role management, `gt
  feed` TUI/problems intervention, or web command palette.
- Beads prefix routing, a Dolt server, Beads-compatible storage, or migration
  between Beads and GasTeam journals.
- Wasteland/DoltHub federation, wanted-board claims, portable reputation, or a
  work economy.
- Upstream OTLP telemetry surface.
- Refinery batch-then-bisect merge processing (M10).

## GasTeam capabilities with no asserted upstream equivalent

The reviewed upstream sources do not establish direct equivalents for the
following GasTeam details: generation-fenced assignment writes, immutable
workflow/review receipt binding, exact host authorization of publication, and
JSONL replay rules used by this plugin. These are implementation distinctions,
not claims that Gas Town lacks comparable safety properties.

## Open GasTeam work relevant to this comparison

1. **M6:** publish and prove durable recovery action delivery, handoff and
   replacement fencing, external notifications, acknowledgement/resolution and
   re-escalation policy.
2. **M8:** add a cursor/activity feed, provider usage where authoritative,
   operational controls, and a real-service browser demonstration.
3. **M9:** prove a real authenticated external provider assignment plus
   cancellation/restart behavior and external code integration.
4. **M10:** implement and test the required merge batching and bisecting behavior.
5. **M11:** validate a consumer installation/release, service operation and
   backup/rollback rather than treating checkout/profile linking as full
   distribution proof. All milestones, including M10 and M11, remain required by
   the project plan.

## Sources reviewed

- [Gas Town README: setup, roles, refinery, feed, dashboard, runtimes, telemetry and Wasteland](https://github.com/gastownhall/gastown/blob/main/README.md)
- [Gas Town architecture: role persistence, worktrees, Beads and Dolt](https://github.com/gastownhall/gastown/blob/main/docs/design/architecture.md)
- [Gas Town reference: routing and merge queue configuration](https://github.com/gastownhall/gastown/blob/main/docs/reference.md)
- [Gas Town plugin-system design: explicitly proposed wisp/gate model](https://github.com/gastownhall/gastown/blob/main/docs/design/plugin-system.md)
- [Gas Town releases: doctor, backup, patrol, runtime and lifecycle features](https://github.com/gastownhall/gastown/releases)
- [Polecat lifecycle and patrol design](https://github.com/gastownhall/gastown/blob/main/docs/design/polecat-lifecycle-patrol.md)
- [Wasteland federation](https://github.com/gastownhall/wasteland)
- [GasTeam completion evidence](completion-evidence.md) and [milestone ledger](../finishme.md)

The upstream sources describe upstream behavior. They do not validate a
GasTeam feature, and GasTeam tests do not validate upstream behavior.
