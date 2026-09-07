# GitHub missed-delivery scanning

The optional observe scanner discovers GitHub issues and pull requests whose webhook deliveries were missed. It records provider-read custody, then uses the existing current-entity reconciler. It does not compile work or activate tasks. Dependabot, Sentry and APM polling remain separate work.

Inside an existing GitHub route's `reconciliation` registration, add:

```json
{
  "scan": {
    "scannerId": "host-scanner:repository",
    "ruleId": "REPLACE_AUTOMATION_RULE_ID",
    "initialSince": "2026-09-01T00:00:00.000Z",
    "maxPages": 10
  }
}
```

Choose the initial UTC lookback boundary deliberately. Include `scannerId` in the route's `senderIds`. The rule must be in `ruleIds`, have exactly one `bindings.automationRules` entry, and agree with the policy's automation-label mapping. The fetched author must still be allowlisted and the current entity must carry that rule's automation label. Increment `policyRevision` when changing the installed policy. The scanner uses the existing pinned installation token, repository and API origin; see [observe configuration](darkfactory-observe.md).

This is an explicit host initiation grant. A provider read cannot establish who initiated a missed webhook. Scanner work records the registered host actor and a typed scanner initiator. Its envelope uses `authentication: "provider-api"`, carries the actual request charge and response digest, and has no webhook signing key. Per-entity observation artifacts contain bounded lookup facts, not list-page narrative. Source graph validation binds the provider request receipt to the project, route and observation time.

The [GitHub repository issues endpoint](https://docs.github.com/en/rest/issues/issues#list-repository-issues) includes pull requests, whose list issue IDs differ from their PR IDs. The scanner retrieves all states sorted by update time, without filtering for an automation label. Current PR reconciliation fetches the true PR identity and base/head commits before computing its canonical source revision. Authoritative current closed, unlabelled, disallowed-author or unsafe-PR results invalidate matching active work after repository/entity reads and a fresh authority check. Actor, configuration, credential and outage failures do not establish such a revocation. Acknowledged history stays unchanged.

The coordinator uses `ingestion.reconciliationIntervalMs`; the shipped example and standalone scanner store use five minutes. Each completed sweep starts the next from its prior cutoff minus a ten-minute overlap, bounded by the registered initial date. Updates observed beyond the cutoff are retained. GitHub pagination is mutable, so overlap mitigates omissions; it does not establish a transactional snapshot or guarantee detection under arbitrary continuous reordering.

`darkfactory-github-scans.jsonl` pins each sweep's window, page and continuation. A bounded, sanitized page artifact is durable before entity processing. Every entry receives durable custody or quarantine before the page is acknowledged. Only the final page advances the watermark. A crash with partial page custody reuses the saved page and deterministic envelope identities. A page or request failure preserves the old watermark and retries after at least five minutes, honoring longer provider cooldowns.

One route runs per coordinator wake, with at most the configured `maxPages` (1–10) and eleven GETs. This bounds discovery requests per wake; entity reconciliation may still defer when the shared budget is exhausted. A full capped batch retains its next page for a later wake after the retry interval. The store supports up to 10,000 pages per sweep and 100,000 sweeps; reaching a hard capacity leaves progress unresolved. It keeps at most one current page per route in memory, with prior page events preserved in the journal. Removed routes stop scanning while their history remains available. Changes to the initial boundary do not skip an existing watermark, and active sweeps retain their pinned windows.

Every repository-proof and list GET shares the coordinator's durable request budget with entity reconciliation. Saved pages can finish custody while new requests are withheld. Preserve the scanner journal, request journal, ingestion journals, policy and artifact directory together. Automatic cleanup is not implemented; cumulative storage exhaustion requires operator review, and deleting the cursor or request ledger is not a quota reset. [Offline migration](darkfactory-migration.md) uses `DarkFactoryGithubScanStore.migrate` with external reference validation.

Work deduplication retains `(project, github, entity, sourceRevision)` across webhook and scanner transports. Scanner-aware attachment events carry a comparison version; historical events keep their original actor-sensitive comparison. An alias preserves the original work's actor, provenance and authority, and cannot promote an original unresolved observation using its own initiation grant.
