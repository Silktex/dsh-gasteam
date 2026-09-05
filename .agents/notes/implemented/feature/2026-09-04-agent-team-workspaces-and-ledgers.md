# Agent Note: Recoverable Team workspaces and work ledgers

Status: implemented

English | [中文](2026-09-04-agent-team-workspaces-and-ledgers.zh.md)

## Problem

Concurrent writers in a shared checkout can overwrite each other outside guarded filesystem tools. Long-running Teams also need durable batch membership, bounded recovery of silent workers, and evidence that a worker commit passed verification before integration.

## Decision

Worktree and integration providers are explicit opt-in subpaths of the experimental Team package. They evolve with Team ownership and have complete service registrations, Git implementations, and model-tool consumers. Shared checkout remains the default. This partially supersedes the shared-checkout-only decision in [Durable Agent Teams](2026-08-05-agent-teams.md); that note retains authority over membership, mailbox, task ownership, and completion evidence.

Workspace ownership is recorded before Git mutations. The continuable child header receives the selected cwd before activation, and cold follow-up uses that persisted cwd. Idle workers retain their worktrees. Release rejects live workers, unfinished owned tasks, queued mail, dirty or ignored files, and unmerged commits. A failed pre-admission spawn may release a clean base checkout; admitted or uncertain work remains recoverable. Worktrees separate checkouts and do not grant or restrict filesystem permissions.

Integration admission pins the worker commit, target branch, candidate directory, and executable verification commands. One runner per Team records the target commit before creating a candidate checkout. Verification runs there and must leave the candidate commit and tracked files unchanged. A verified candidate is flushed before target promotion. Promotion requires a clean Lead checkout on the configured target and the expected target commit; it uses a fast-forward and recognizes an already promoted candidate. Interrupted verification becomes a failed record with its checkout retained. Ambiguous promotion retains the verified record for retry. Explicit abandonment releases queue capacity without deleting evidence. Candidate checkouts remain available for manual inspection and cleanup.

Supervisor progress is the authoritative child Session event count. An unchanged worker with unfinished owned tasks may be interrupted and resumed through durable mailbox delivery. Recovery admission records a compare-and-set observation and a lifetime attempt count before interruption. Plugin activation grants a fresh observation interval; it does not reset the persisted retry budget. Recovery preserves task ownership and never infers completion from silence.

Named batches retain task ids and monotonic revisions in the Lead log. Progress derives from current task states, so reopening a completed task reopens batch progress. Active batches prevent task deletion; archived batches retain references to tombstones. Service reloads and Lead Session restoration replay these records without a second database.

## Alternatives considered

Implicit worktrees for every subagent are rejected: repository location, branch policy, verification commands, and cleanup remain explicit deployment choices. Automatic reset, autostash, forced removal, and unverified conflict resolution are rejected because they can destroy or silently alter another writer's output. A dedicated model agent is unnecessary for deterministic integration; an optional background plugin executes the configured checks and preserves conflicts for the Lead.

## Consequences

The queue serializes one Team, not arbitrary external Git writers or multiple harness processes. Git's own ref and index checks still apply. Verification commands are trusted deployment code, and ignored build outputs may remain in retained candidate checkouts. The system does not claim a cross-process transaction spanning Git and the Session log.

## Verification

Temporary Git repositories exercise independent edits, conservative release, pinned source commits, failed checks, dirty targets, target movement, and merge conflicts. Service tests exercise durable admission phases, retry after verified promotion, queue capacity, batch references, recovery budgets, and disposal. Recorded-session tests project model-visible task and batch results through shipped profiles. Projection tests reject malformed records and invalid phase transitions.
