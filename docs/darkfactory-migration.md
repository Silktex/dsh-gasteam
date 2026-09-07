# Offline Dark Factory journal migration

The host SDK supports an offline migration from inline factory journals to storage layout 2. Policy, ingestion, compilation, admission, provider-request and scanner event schemas remain version 1; the migration copies their bytes exactly. It does not activate work, change policy or upgrade unrelated coordinator journals.

Stop the coordinator and any separate writer before migration. The migration refuses an owned source journal. Keep a consistent backup of the coordinator directory and referenced artifacts: preserving one journal alone does not preserve its external evidence.

The native entry points are `DarkFactoryPolicyStore.migrate(directory, migration)`, `DarkFactoryIngestionStore.migrate(directory, options, migration)` `DarkFactoryCompilationStore.migrate(directory, options, migration)` and `DarkFactoryAdmissionStore.migrate(directory, options, migration)`, available through `dsh-team/darkfactory` and the development SDK. Use the same project limits and registered workflow templates as the stopped owner. `migration` contains a stable `migrationId`, optional `maxBytes`, and a required asynchronous `validateReferences(snapshot)` callback.

The coordinator-wide scanner uses `darkfactory-github-scans.jsonl` and `DarkFactoryGithubScanStore.migrate(directory, options, migration)`. Validate saved page artifacts, per-entity custody, provider request receipts and pinned policy references against the stopped host. New scanner-aware ingestion attachments have an explicit comparison version; historical events retain their original comparison.

The coordinator-wide request owner uses `darkfactory-provider-requests.jsonl` and `DarkFactoryProviderRequestStore.migrate(directory, options, migration)`. Preserve its charges and cooldowns with the source journals; changing route registration does not erase prior request accounting.

The owner replays each copy with its actual schemas, sequence checks, hash chain, storage limits and reducer before invoking the callback. The callback must resolve external references against the stopped host's actual policy, source, workflow, health and artifact records as applicable. Check complete artifact metadata and bytes, immutable identities and revisions. A callback that only checks JSON shape does not establish reference integrity. `validateReferenceSnapshot()` can validate a supplied coherent graph, but the host must also bind that graph to the actual journal snapshot being migrated. No compiler, provider or deployment runs during validation.

The protocol performs these steps under exclusive source ownership:

1. Hash the source and publish a pending marker.
2. Copy the source into a separate layout directory, replay and validate the backup, then protect the backup as read-only.
3. Copy, replay and validate the new active journal; recheck the source and both copies.
4. Write and sync a version-2 guard into the original anchor inode. Keeping the inode prevents an older process with an already opened descriptor from later writing to a detached file.
5. Atomically publish and sync the matching commit marker. New owners retain the anchor lock and verify the preserved backup and migrated prefix before opening the active journal.

The returned receipt identifies the storage layout, migration ID, original byte count and SHA-256 digest, relative layout directory, and usable absolute backup and target paths. Migration is bounded to at most 1 GiB per journal and uses 64 KiB copy/hash buffers. Subsequent normal journal capacity still follows the owner's configured limits.

A completed anchor contains a layout guard rather than event records. An older reader rejects its unknown version without modifying it. Never remove that guard to downgrade a live store. New events append only to the layout-2 active journal; the exact original remains in `legacy-backup.jsonl` until a restore drill has passed and retention permits any later action.

A pending migration, partial guard, missing commit, changed backup or changed migrated prefix blocks writes. There is no automatic repair, implicit retry or marker cleanup. A retry with an existing migration directory is refused. Preserve the entire failed directory for inspection.

For a restore drill, use a separate coordinator directory. Verify the preserved backup against the recorded original digest and byte count, restore its matching policy/health/workflow/artifact dependencies from the consistent backup, and write the validated legacy bytes to the native journal path with private writable permissions. Replay with the native owner and validate all references again before allowing any new work. The read-only preserved backup itself must remain unchanged. A deliberate recovery to another supported layout requires its own validated migration; the SDK does not switch an incomplete live directory automatically.

[Process tests](../tests/darkfactory-migration-restart.spec.ts) exercise actual ingestion, persisted policy, artifact and health records, missing-policy rejection, SIGKILL during target validation, isolated restoration, fresh-process append and legacy refusal. [Native tests](../packages/agent-team/tests/darkfactory/native-migration.spec.ts) cover policy controls and complete held admission plans. [Protocol tests](../packages/agent-team/tests/darkfactory/journal-migration.spec.ts) cover ownership, stale descriptors, copy corruption, symlinks and incomplete publication. These fixtures qualify the documented boundaries; they do not establish a fleet-wide restore-time target or an atomic multi-journal migration.
