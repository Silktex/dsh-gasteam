# Dark Factory observe mode

Observe mode adds authenticated webhook custody to the existing GasTeam coordinator. It records immutable policy and custody receipts, deduplicates deliveries, and sends exceptions to the existing project health inbox. An optional GitHub issue, pull-request and Dependabot reconciler can establish current source trust through bounded read-only provider requests. It does not call paid models, create tasks, publish Git changes, or deploy releases.

Use the optional `dsh-team/coordinator` entry after [installing the DSH plugin](installation.md). The default `dsh-team` bundle does not start a coordinator or ingress listener. Development checkouts use the equivalent `@deepseek-ai/dsh-experimental-agent-team/coordinator` entry.

## Configure an existing registered project

1. Start the coordinator with `darkFactory: { enabled: false }` and register the project through its existing host API, `ctx.workspaceCoordinator.register(lead, request)`. The caller must be the actual Lead, and registration binds its team to a real Git repository, target branch, capacity, and verification commands. Keep that coordinator directory. Adding an ID to `projectIds` does not register a project.
2. Copy [the complete observe policy](../examples/darkfactory-observe.json). Replace every `REPLACE_...` value with the registered project, host operator, webhook key identifier, and actual GitHub installation/repository/actor/author IDs. Repository and account fields use provider IDs. Keep `enabled: true`, `mode: "observe"`, and delivery disabled. Increment `policyRevision` whenever you change an installed policy.
3. Supply `GASTEAM_GITHUB_WEBHOOK_SECRET` to the DSH process through your normal secret-management setup, and configure the matching GitHub webhook secret. The policy contains only the environment-variable reference. Do not put the secret in JSON, source control, or model prompts.
4. Stop the coordinator before changing its profile configuration. Set its `config.darkFactory` to the customized JSON object, then start it with the same coordinator directory. Do not run a second coordinator against that directory.

The following generates a reviewable profile insertion from the customized example. Replace the absolute directory before using it; JSON is also valid YAML. Merge this into the selected profile's existing `cordis.patch.yml`. If its coordinator entry already exists, update that entry instead of inserting another one.

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const darkFactory = JSON.parse(readFileSync('examples/darkfactory-observe.json', 'utf8'))
const patch = [{ insert: [{
  id: 'workspace-coordinator', name: 'dsh-team/coordinator',
  config: { directory: '/absolute/path/to/existing-coordinator', darkFactory },
}] }]
writeFileSync('/var/tmp/darkfactory-observe.patch.yml', JSON.stringify(patch, null, 2) + '\n')
NODE
```

The verification, fleet, pricing, and model sections are currently required by the complete policy schema. Their `UNUSED_OBSERVE_...` values, example public key, and example pricing digest are placeholders, not qualification evidence. Observe startup resolves the webhook secret and any configured reconciliation credential; it does not contact the model or Redis endpoints or run those verification commands. Delivery and compression remain disabled. No production gate receipts belong in this configuration.

## Listener and receipts

The example listens on `127.0.0.1:9100` at `POST /darkfactory/v1/ingress/github/github-issues`. Configure GitHub's delivery/event headers and its raw-body `X-Hub-Signature-256` signature. Put non-test deployments behind a configured trusted TLS gateway that forwards the original body bytes and required headers. The application listener stays on loopback; this example does not provision a gateway or install a production service.

A `202` response means durable custody or authenticated quarantine. A known duplicate returns `200` with its original receipt. Neither response is task admission. Body, queue, artifact, and journal limits reject new custody when exhausted. Webhook custody stores sanitized lookup facts and withholds raw request bodies, narrative and stack payloads. Optional GitHub reconciliation separately persists bounded, redacted provider issue/PR text, alert details and provenance.

Factory exceptions appear in the same health inbox as attempt incidents, with their project, stage, reason, and effect identity. Registered project Leads can inspect and acknowledge them through the existing inbox UI or `dsh-team/coordinator-tools`. Acknowledgement does not resolve the cause or accept work.

## Optional GitHub issue and pull-request reconciliation

Add this optional `reconciliation` property to the existing GitHub route; it is a route fragment, not a complete policy. Replace the identifiers and absolute private-file path, and increment `policyRevision`.

```json
{
  "reconciliation": {
    "apiBaseUrl": "https://api.github.com",
    "installationId": "REPLACE_GITHUB_INSTALLATION_ID",
    "repositoryId": "REPLACE_GITHUB_REPOSITORY_ID",
    "repositoryName": "REPLACE_OWNER/REPLACE_REPOSITORY",
    "credentialRef": {
      "kind": "file",
      "path": "/absolute/private/path/github-installation-token"
    },
    "credentialKind": "installation-token",
    "fixtureLoopback": false
  }
}
```

Provision a GitHub App installation access token with Issues read permission for issues and Pull requests read permission for PRs through host secret management. A rotated private file is recommended; the resolver checks ownership and private permissions and refuses symlink traversal. The credential is re-resolved for each attempt. This adapter does not mint or renew tokens. Keep the credential file outside the repository and separate from the webhook signing secret.

The registered repository's actual Git `origin` must identify the configured GitHub `owner/repository`. The route's installation and repository allowlists must contain the reconciliation identifiers. The host binds the credential reference to the installation; [listing installation repositories](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation) verifies token visibility of the exact repository ID and name. It does not independently attest the token's installation ID. The reader then [gets the current issue](https://docs.github.com/en/rest/issues/issues#get-an-issue) or [current pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) through the host-pinned repository name and entity number. Payload URLs cannot select a destination, and redirects are refused.

The initiating actor must match the configured allowlist; the fetched issue or PR must match its provider ID and number, remain open, have an allowed current author and retain a configured automation label. Authority is checked again before persisting trusted work. The authoritative source revision hashes execution-relevant provider fields before redaction. Trust is source eligibility only: it does not compile, admit or dispatch work.

PR reconciliation uses the actual PR endpoint and pins current base/head repository identities, full commit SHAs and branch references. A fork identified either at delivery or during the current read, a missing head repository, a mismatched base repository, or a closed/merged PR is denied. Changes to current commits produce a new source revision; conflicting active source revisions require inbox review. Provider test-merge SHAs and payload URLs never substitute for the pinned head/base identity.

For Dependabot, add an explicit sensor grant inside the route's `reconciliation` property:

```json
{
  "dependabot": {
    "sensorPrincipalId": "host-sensor:dependabot",
    "ruleId": "REPLACE_AUTOMATION_RULE_ID"
  }
}
```

Include that sensor principal in `bindings.authorIds`. The rule must be allowed by `ruleIds` and have exactly one matching `bindings.automationRules` entry, agreeing with the policy's automation-label mapping. The installation token also needs Dependabot alerts read permission. [The current alert endpoint](https://docs.github.com/en/rest/dependabot/alerts#get-a-dependabot-alert) supplies alert, dependency and advisory facts rather than a current initiating human actor. The work record therefore names the explicitly configured host sensor; provenance separately identifies the signed webhook actor and states that it is not a current-provider actor attestation.

Dependabot reconciliation requires an open, matching alert, an active advisory, matching package/ecosystem vulnerability data and a safe manifest path. Its source revision covers original execution-relevant alert, dependency, advisory and fix fields before redaction. A missing patched version remains absent; source trust does not prove that a proposed fix is compatible or that reproduction checks exist. Compiler validation must establish those later requirements.

Provider title/body text remains untrusted. The bounded credential redactor removes known host credentials and common token/password/private-key patterns before persistence; it does not detect arbitrary confidential prose. Webhook narrative remains withheld. Provider reconciliation runs on the host through read-only APIs, without paid model calls.

The coordinator records every actual GET in `darkfactory-provider-requests.jsonl` before transport, sharing a rolling limit of 55 requests per minute across projects and source kinds. Uncertain requests remain charged. An exhausted budget defers fresh reconciliation attempts. Project order rotates from the last persisted charge so backlogged projects take turns across restart. The native owner preserves charges and extend-only cooldowns across restart; removing a route or lowering the current limit does not erase earlier usage. Standalone SDK hosts may supply the same `requestBudget`; hosts that omit it retain the legacy five-start/eleven-GET bound.

The request ledger also has cumulative storage limits: by default 100,000 charge receipts and 10,000 cooldown receipts, plus the configured journal byte limit. Exhausting charge or journal capacity stops fresh reconciliation; waiting restores rolling quota but does not free storage. Automatic retention remains unimplemented. Preserve this ledger with the other factory journals; deleting it loses usage and cooldown evidence.

Provider response bodies are capped at 1 MiB, requests at five seconds, and the provider-read phase at fifteen seconds. Provider cooldowns honor valid `retry-after` and exhausted-quota reset deadlines, with a one-minute fallback; rate-limited custody reconciliation attempts using the shared budget additionally back off for five, ten and twenty minutes. Other provider failures retain the five-minute retry lease. SDK hosts without the shared budget do not persist header-derived cooldowns. This follows [GitHub's rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately). On startup, recent reconciliation cursors conservatively withhold the remainder of their one-minute window, covering legacy reads whose exact request count is unknown. Cancellation aborts pending provider work. Each custody record has at most three attempts and a durable retry lease; source denial or exhaustion requires an inbox exception. A custody receipt keeps its original identity and meaning.

## Sentry and APM monitoring reconciliation

Observe mode includes optional authoritative reconciliation for Sentry issues/event alerts and generic APM telemetry. Each provider requires an explicit route `reconciliation` fragment and shares the global provider request budget, secret redactor, and retry/cooldown rules.

### Sentry route configuration

```json
{
  "reconciliation": {
    "apiBaseUrl": "https://sentry.io",
    "publicSourceBaseUrl": "https://sentry.io",
    "installationId": "REPLACE_INSTALLATION_ID",
    "organizationId": "REPLACE_ORGANIZATION_ID",
    "organizationSlug": "REPLACE_ORGANIZATION_SLUG",
    "providerProjectId": "REPLACE_PROVIDER_PROJECT_ID",
    "projectSlug": "REPLACE_PROJECT_SLUG",
    "repositoryId": "REPLACE_GITHUB_REPOSITORY_ID",
    "repositoryName": "REPLACE_OWNER/REPLACE_REPOSITORY",
    "sensorPrincipalId": "host-sensor:sentry",
    "productionEnvironmentId": "production",
    "credentialRef": {
      "kind": "file",
      "path": "/absolute/private/path/sentry-api-token"
    },
    "credentialKind": "api-token",
    "maxAgeMs": 3600000,
    "fixtureLoopback": false
  }
}
```

Sentry reconciliation reads current project, issue, and latest production event evidence using a pinned API token. Freshness evaluation checks host clock post-response against provider event and issue timestamps. If a Sentry issue is marked resolved at the provider, any prior active work item is revoked and quarantined, logging an operator escalation in the health inbox. Sentry metric alerts cleanly resolve to `SENTRY_METRIC_API_UNSUPPORTED` without inventing fake metric trust because Sentry lacks a documented current metric-incident API.

### APM route configuration

```json
{
  "reconciliation": {
    "apiBaseUrl": "https://apm.internal.net",
    "publicSourceBaseUrl": "https://apm.internal.net",
    "providerProjectId": "REPLACE_PROVIDER_PROJECT_ID",
    "senderId": "REPLACE_SENDER_ID",
    "repositoryId": "REPLACE_GITHUB_REPOSITORY_ID",
    "repositoryName": "REPLACE_OWNER/REPLACE_REPOSITORY",
    "sensorPrincipalId": "host-sensor:apm",
    "productionEnvironmentId": "production",
    "credentialRef": {
      "kind": "file",
      "path": "/absolute/private/path/apm-api-token"
    },
    "credentialKind": "api-token",
    "maxAgeMs": 3600000,
    "fixtureLoopback": false
  }
}
```

APM reconciliation implements the GasTeam-owned current-state protocol: `GET /darkfactory/v1/current/{providerProjectId}/{fingerprint}` returning strict `{schemaVersion:1, observedAt, payload:genericApmPayload}`. Response freshness is evaluated against host time post-transport. If an APM incident is resolved, prior active work is revoked and quarantined, raising a health inbox exception without task creation.

An optional [GitHub scanner](darkfactory-scanning.md) discovers missed issue/PR deliveries with durable page custody, a ten-minute overlap and the same request budget. It requires a separate explicit host scanner grant. Other provider polling, live compiler/admission wiring, stage activation and barrier release, verification/release controllers, fleet accounting, automatic retention cleanup and live provider conformance remain open. The reconciliation interval schedules the implemented GitHub reconciliation, Sentry/APM monitoring reconciliation, and optional issue/PR scanner; retention duration does not start cleanup. Full automation and production qualification remain separate work.

The host SDK now also provides a durable admission store/controller and a five-stage workflow template: reproduction, implementation, machine verification, integration and release acceptance. Host callers can materialize the complete deterministic task plan with immutable factory bindings, but every task stays held and the admission barrier remains closed even after acknowledgement. Ordinary task mutation, acceptance and coordinator scans cannot activate those tasks. This groundwork has no observe configuration switch and is not wired to the webhook reconciler; observe continues to create no tasks. Stage activation and controller-backed release remain unavailable. The [source-to-workflow process evidence](../tests/darkfactory-source-workflow-restart.spec.ts) now connects actual authenticated custody and provider reconciliation to an explicitly hosted deterministic compiler and real Team materialization across SIGKILL. That fixture does not make observe compile or enable task execution.

Set `darkFactory` to `{ "enabled": false }` to omit the listener. Keep the existing coordinator directory: recorded policy, custody, and inbox history remain available, including unresolved factory incidents. Disablement does not erase receipts or replay queued external effects. Back up the stopped coordinator directory before changing or restoring its journals.
