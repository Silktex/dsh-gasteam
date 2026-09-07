import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DarkFactoryMonitoringReconciler } from '../../src/darkfactory/monitoring-reconciler.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryProviderRequestStore } from '../../src/darkfactory/provider-request-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { HealthStore } from '../../src/health.ts'
import { runGit } from '../../src/git-command.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { enabledDarkFactoryConfigSchema } from '../../src/darkfactory/config.ts'
import { policy as basePolicy } from './config-fixture.ts'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(count = 1) {
 const directory = await mkdtemp(join(tmpdir(), 'factory-monitoring-'))
 cleanups.push(() => rm(directory, { recursive: true, force: true }))
 await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
 await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)
 const policy = enabledDarkFactoryConfigSchema.parse({ ...basePolicy(), ingestion: { ...basePolicy().ingestion, routes: [{
  id: 'monitor', projectId: 'project', source: 'apm', providerVersion: 'v1', signingKeyId: 'key', secretRef: { kind: 'env', name: 'WEBHOOK_KEY' },
  repositoryIds: ['42'], senderIds: ['sender'], ruleIds: ['rule'], bindings: { providerProjectIds: ['service'], environments: [{ providerEnvironment: 'production', environmentId: 'production' }], ruleMappings: [{ providerRule: 'provider-rule', ruleId: 'rule', automationLabel: 'automate' }] },
  reconciliation: { apiBaseUrl: 'https://apm.example', publicSourceBaseUrl: 'https://apm.example', credentialRef: { kind: 'env', name: 'API_TOKEN' }, credentialKind: 'api-token', repositoryId: '42', repositoryName: 'owner/repo', sensorPrincipalId: 'host-sensor:apm', productionEnvironmentId: 'production', maxAgeMs: 3600000, providerProjectId: 'service', senderId: 'sender' },
 }] } })
 let store = await DarkFactoryIngestionStore.open(directory, { projectId: 'project', maxQueueItems: 100 })
 cleanups.push(() => store.close())
 const stores = new Map([['project', store]])
 const budget = await DarkFactoryProviderRequestStore.open(directory, { routes: [{ projectId: 'project', routeId: 'monitor' }] })
 cleanups.push(() => budget.close())
 const artifacts = await DarkFactoryArtifactStore.open(directory, ['project'], 1048576, 16777216)
 const health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
 cleanups.push(() => health.close())
 let now = Date.parse('2026-09-06T12:00:00Z'), allowed = true, status = 200, action = 'triggered', calls = 0, token = 'fixture-monitoring-token'
 let beforeResponse: (() => Promise<void>) | undefined
 let sender = 'sender', environment = 'production'
 const lookup = (fingerprint: string) => ({ kind: 'apm', sourceEntityId: `apm:${digestJson(['sender', 'service', fingerprint]).slice(7)}`, providerEntityId: fingerprint, fingerprint, actorId: 'sender', providerProjectId: 'service', providerRule: 'provider-rule' })
 const receive = async (id: string, fingerprint = 'error-0', overrides: Record<string, unknown> = {}, lookupOverride?: unknown) => {
  const artifact = await artifacts.persist('project', { lookup: lookupOverride ?? lookup(fingerprint) })
  return store.recordReceived({ bodySizeBytes: 20, envelope: { schemaVersion: 1, id, projectId: 'project', policyRevision: 1, source: 'apm', adapterVersion: 'v1', routeId: 'monitor', deliveryId: id,
   eventKind: 'alert', action: 'triggered', bodyDigest: digestJson({ id }), receivedAt: new Date(now).toISOString(), signingKeyId: 'key', authentication: 'verified', artifact, ...overrides } })
 }
 for (let index = 0; index < count; index++) await receive(`envelope:${index}`, `error-${index}`)
 const host = { projects: [{ id: 'project', repository: directory }], stores, artifacts, requestBudget: budget, clock: () => now, resolveSecret: async () => token,
  authorize: async () => { if (!allowed) throw new Error('revoked') },
  quarantine: async (input: { projectId: string; envelopeId: string; reason: string }) => (await health.raiseFactoryEscalation({ schemaVersion: 1, projectId: input.projectId, policyRevision: 1, stage: 'ingress', reason: input.reason, effectId: input.envelopeId, evidenceRefs: [input.envelopeId], severity: 'warning', diagnostics: input.reason }, now)).id,
  transport: async (url: string | URL | Request) => {
   calls++; await beforeResponse?.()
   if (status !== 200) return new Response('unavailable', { status, headers: status === 429 ? { 'retry-after': '900' } : {} })
   const fingerprint = decodeURIComponent(String(url).split('/').at(-1)!)
   return new Response(JSON.stringify({ schemaVersion: 1, observedAt: new Date(now).toISOString(), payload: { schemaVersion: 1, action, senderId: sender, providerProjectId: 'service', environment, ruleId: 'provider-rule', fingerprint, revision: 'provider-revision', title: 'Error group', context: `Current production error secret=${token}`,
    observationWindow: { start: '2026-09-06T11:59:00.000Z', end: '2026-09-06T12:00:00.000Z' }, commit: 'a'.repeat(40), release: 'v1', metrics: [{ name: 'errors', value: 5, unit: 'count' }], evidence: [] } }), { headers: { 'content-type': 'application/json' } })
  },
 }
 let reconciler = await DarkFactoryMonitoringReconciler.open(policy, host)
 cleanups.push(() => reconciler.close())
 return { directory, policy, host, budget, health, artifacts, receive, lookup, get store() { return store }, get reconciler() { return reconciler }, get calls() { return calls },
  advance() { now += 300001 }, status(value: number) { status = value }, resolve() { action = 'resolved' }, revoke() { allowed = false }, environment(value: string) { environment = value }, sender(value: string) { sender = value }, rotate() { token = 'replacement-monitoring-token' },
  block() { let entered!: () => void, release!: () => void; const seen = new Promise<void>(resolve => { entered = resolve }), wait = new Promise<void>(resolve => { release = resolve }); beforeResponse = async () => { entered(); await wait }; return { entered: seen, release } },
  async reopen() { await reconciler.close(); await store.close(); store = await DarkFactoryIngestionStore.open(directory, { projectId: 'project', maxQueueItems: 100 }); stores.set('project', store); reconciler = await DarkFactoryMonitoringReconciler.open(policy, host) },
 }
}
it('reconciles authenticated monitoring custody through actual reader and shared budget, retaining exact receipt after replay', async () => {
 const f = await fixture(), receipt = f.store.snapshot().custody[0]!.receipt
 await f.reconciler.runOnce()
 expect(f.store.snapshot().items[0]).toMatchObject({ source: 'apm', state: 'trusted', author: 'host-sensor:apm', actor: 'sender', revision: 2 })
 expect(f.store.snapshot().reconciliations[0]).toMatchObject({ attempts: 1, status: 'resolved' })
 expect(f.budget.snapshot().charges).toHaveLength(f.calls)
 expect(JSON.stringify(f.store.snapshot())).not.toContain('fixture-monitoring-token')
 await f.reopen(); await f.reconciler.runOnce()
 expect(f.store.snapshot().custody[0]!.receipt).toEqual(receipt); expect(f.calls).toBe(1)
})
it('limits each run to ten candidates and coalesces concurrent drains', async () => {
 const f = await fixture(11); await Promise.all([f.reconciler.runOnce(), f.reconciler.runOnce()])
 expect(f.calls).toBe(10); expect(f.store.snapshot().items).toHaveLength(10)
 await f.reconciler.runOnce(); expect(f.calls).toBe(11)
})
it('persists outage retries across reopen and creates a real inbox escalation after attempt three', async () => {
 const f = await fixture(); f.status(503); await f.reconciler.runOnce()
 await f.reopen(); await f.reconciler.runOnce(); expect(f.calls).toBe(1)
 for (let i = 0; i < 2; i++) { f.advance(); await f.reconciler.runOnce() }
 expect(f.store.snapshot().reconciliations[0]).toMatchObject({ attempts: 3, status: 'quarantined', lastReason: 'RECONCILIATION_EXHAUSTED' })
 expect(f.health.listEscalations()).toHaveLength(1); expect(f.budget.snapshot().charges).toHaveLength(3)
})
it('does not begin an attempt without shared capacity and retains durable provider cooldown', async () => {
 const f = await fixture(); f.status(429); await f.reconciler.runOnce()
 expect(f.budget.snapshot().blockedUntil).toBe('2026-09-06T12:15:00.000Z')
 f.advance(); await f.reopen(); await f.reconciler.runOnce()
 expect(f.calls).toBe(1); expect(f.store.snapshot().reconciliations[0]?.attempts).toBe(1)
})
it('recovers an interrupted attachment without replacing its pinned input', async () => {
 const f = await fixture(), transition = f.store.transition.bind(f.store)
 f.store.transition = async () => { throw new Error('after attachment') }
 await f.reconciler.runOnce(); expect(f.store.snapshot().items[0]?.state).toBe('received')
 const receipts = f.store.snapshot().attachments
 f.store.transition = transition; await f.reopen(); f.advance(); await f.reconciler.runOnce()
 expect(f.store.snapshot().items[0]?.state).toBe('trusted'); expect(f.store.snapshot().attachments).toEqual(receipts)
})
it('rechecks current host authority after response before any trusted attachment', async () => {
 const f = await fixture(), block = f.block(), running = f.reconciler.runOnce()
 await block.entered; f.revoke(); block.release(); await running
 expect(f.store.snapshot().items).toEqual([]); expect(f.store.snapshot().reconciliations[0]?.lastReason).toBe('AUTHORITY_UNRESOLVED')
})
it.each(['resolved', 'environment'])('revokes same-source active work after current %s denial with actual health references', async mode => {
 const f = await fixture(); await f.reconciler.runOnce(); const original = f.store.snapshot().items[0]!
 await f.receive('envelope:later'); if (mode === 'resolved') f.resolve(); else f.environment('staging')
 await f.reconciler.runOnce()
 expect(f.store.snapshot().items[0]).toMatchObject({ id: original.id, state: 'quarantined', trust: { decision: 'revoked' } })
 expect(f.health.listEscalations().some(value => value.id === f.store.snapshot().items[0]!.healthEscalationId)).toBe(true)
 await f.reopen(); expect(f.store.snapshot().items[0]!.trust.decision).toBe('revoked')
})
it.each(['outage', 'sender', 'policy'])('does not revoke prior work on %s failure', async mode => {
 const f = await fixture(); await f.reconciler.runOnce()
 await f.receive('envelope:later', 'error-0', mode === 'policy' ? { policyRevision: 2 } : {})
 if (mode === 'outage') f.status(503); else if (mode === 'sender') f.sender('impostor')
 await f.reconciler.runOnce(); expect(f.store.snapshot().items[0]?.state).toBe('trusted')
})
it('rejects nonmatching transport and lookup before provider reads', async () => {
 const f = await fixture(0)
 await f.receive('envelope:wrong-source', 'error-0', { source: 'sentry' })
 await f.receive('envelope:wrong-lookup', 'error-0', {}, { kind: 'sentry_metric' })
 await f.reconciler.runOnce(); expect(f.calls).toBe(0)
 expect(f.store.snapshot().reconciliations.map(value => value.lastReason)).toEqual(['AUTHORITY_UNRESOLVED', 'ARTIFACT_UNAVAILABLE'])
})
it('requires shared budget and registered GitHub origin before opening monitoring routes', async () => {
 const f = await fixture(), { requestBudget: _, ...unbudgeted } = f.host
 await expect(DarkFactoryMonitoringReconciler.open(f.policy, unbudgeted)).rejects.toThrow('shared provider budget')
 await runGit(f.directory, ['remote', 'set-url', 'origin', 'https://github.com/other/repo.git'], new AbortController().signal, 5000)
 await expect(DarkFactoryMonitoringReconciler.open(f.policy, f.host)).rejects.toThrow('registered GitHub origin')
})
it('never promotes an unresolved original through an alias and quarantines alias exhaustion after replay', async () => {
 const seed = await fixture(); await seed.reconciler.runOnce()
 const model = seed.store.snapshot().items[0]!, f = await fixture(0)
 const artifact = await f.artifacts.persist('project', { lookup: f.lookup('error-0') })
 const envelope = { ...seed.store.snapshot().custody[0]!.envelope, id: 'envelope:original', routeId: 'removed-route', deliveryId: 'original', artifact }
 const original = { ...model, envelopeId: envelope.id, provenance: [artifact], state: 'received' as const, revision: 1,
  trust: { ...model.trust, decision: 'unresolved' as const, reasons: ['PROVIDER_RECONCILIATION_REQUIRED'] } }
 await f.store.recordReceived({ envelope, item: original, bodySizeBytes: 20 })
 await f.receive('envelope:alias'); await f.reconciler.runOnce()
 expect(f.store.snapshot().custody.find(value => value.envelope.id === 'envelope:alias')?.itemId).toBe(original.id)
 expect(f.store.snapshot().items).toEqual([original]); expect(f.calls).toBe(1)
 await f.reopen()
 for (let i = 0; i < 2; i++) { f.advance(); await f.reconciler.runOnce() }
 expect(f.store.snapshot().items).toEqual([original]); expect(f.calls).toBe(1)
 expect(f.store.snapshot().reconciliations.find(value => value.envelopeId === 'envelope:alias')).toMatchObject({ attempts: 3, status: 'quarantined', lastReason: 'RECONCILIATION_EXHAUSTED' })
})
async function sentryFixture(count: number, eventAlert = false) {
 const f = await fixture(0); await f.reconciler.close()
 const registration = { apiBaseUrl: 'https://sentry.io', publicSourceBaseUrl: 'https://sentry.io', credentialRef: { kind: 'env', name: 'SENTRY_API_TOKEN' }, credentialKind: 'api-token',
  repositoryId: '42', repositoryName: 'owner/repo', sensorPrincipalId: 'host-sensor:sentry', productionEnvironmentId: 'production', maxAgeMs: 3600000, installationId: 'installation', organizationId: 'org', organizationSlug: 'organization', providerProjectId: 'service', projectSlug: 'service' }
 const resource = eventAlert ? 'event_alert' : 'issue', providerRule = eventAlert ? 'Provider alert' : null
 const policy = enabledDarkFactoryConfigSchema.parse({ ...f.policy, ingestion: { ...f.policy.ingestion, routes: [{ ...f.policy.ingestion.routes[0], source: 'sentry', reconciliation: registration,
  bindings: { installationIds: ['installation'], organizationIds: ['org'], providerProjects: [{ id: 'service', slug: 'service', organizationId: 'org' }], environments: [{ providerEnvironment: 'production', environmentId: 'production' }], ruleMappings: [{ resource, providerRule, ruleId: 'rule', automationLabel: 'automate' }] },
 }] } })
 let calls = 0
 const at = '2026-09-06T12:00:00.000Z', eventId = 'a'.repeat(32)
 for (let i = 0; i < count; i++) await f.receive(`sentry:${i}`, 'unused', { source: 'sentry', eventKind: resource }, {
  kind: 'sentry_issue', resource, eventId: eventAlert ? eventId : null, sourceEntityId: `sentry-issue:service:${i + 1}`, providerEntityId: String(i + 1), installationId: 'installation', actorId: 'sender', providerProjectIds: ['service'], organizationId: null, providerRule,
 })
 const transport: typeof fetch = async input => {
  calls++
  const url = String(input), issueId = /\/issues\/([^/]+)/.exec(url)?.[1] ?? '1'
  const response = url.includes('/events/') ? { eventID: eventId, groupID: issueId, title: 'Error event', dateCreated: at, dateReceived: at, tags: [{ key: 'environment', value: 'production' }], entries: [] }
   : url.includes('/issues/') ? { id: issueId, title: 'Sentry issue secret=fixture-monitoring-token', status: 'unresolved', project: { id: 'service', slug: 'service' }, firstSeen: at, lastSeen: at }
   : { id: 'service', slug: 'service', organization: { id: 'org', slug: 'organization' } }
  return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
 }
 const reconciler = await DarkFactoryMonitoringReconciler.open(policy, { ...f.host, transport })
 cleanups.push(() => reconciler.close())
 return { ...f, reconciler, get calls() { return calls } }
}
it('reconciles Sentry issue custody using current project, issue and event reads', async () => {
 const f = await sentryFixture(1); await f.reconciler.runOnce()
 expect(f.calls).toBe(3); expect(f.budget.snapshot().charges).toHaveLength(3)
 expect(f.store.snapshot().items[0]).toMatchObject({ source: 'sentry', author: 'host-sensor:sentry', actor: 'sender', state: 'trusted' })
 expect(JSON.stringify(f.store.snapshot())).not.toContain('fixture-monitoring-token')
})
it('caps a multi-read monitoring wake at eleven charged GETs without starting a fourth candidate', async () => {
 const f = await sentryFixture(4, true); await f.reconciler.runOnce()
 expect(f.calls).toBe(11); expect(f.budget.snapshot().charges).toHaveLength(11)
 expect(f.store.snapshot().items).toHaveLength(2)
 expect(f.store.snapshot().reconciliations).toHaveLength(3)
 expect(f.store.snapshot().reconciliations[2]).toMatchObject({ status: 'pending', lastReason: 'PROVIDER_RATE_LIMITED', attempts: 1 })
 expect(f.health.listEscalations()).toHaveLength(0)
})
it.each(['compiled', 'admitted', 'acknowledged'] as const)('invalidates only nonterminal matching work while preserving %s lifecycle rules and other entities', async target => {
 const f = await fixture(2); await f.reconciler.runOnce()
 for (const state of ['compiled', 'admitted', 'acknowledged'] as const) {
  const item = f.store.snapshot().items[0]!
  await f.store.transition({ projectId: 'project', expectedRevision: item.revision, item: { ...item, revision: item.revision + 1, state } })
  if (state === target) break
 }
 const [original, other] = f.store.snapshot().items
 await f.receive('envelope:current-denial'); f.resolve(); await f.reconciler.runOnce()
 expect(f.store.snapshot().items[1]).toEqual(other)
 if (target === 'acknowledged') expect(f.store.snapshot().items[0]).toEqual(original)
 else expect(f.store.snapshot().items[0]).toMatchObject({ state: 'quarantined', trust: { decision: 'revoked' } })
})
it('settles a crash-left final attempt without additional request capacity', async () => {
 const f = await fixture(); f.status(503)
 for (let i = 0; i < 2; i++) { await f.reconciler.runOnce(); f.advance() }
 await f.store.beginReconciliation({ projectId: 'project', expectedRevision: f.store.snapshot().revision, envelopeId: 'envelope:0', at: new Date(f.host.clock()).toISOString() })
 f.advance()
 const at = new Date(f.host.clock()).toISOString()
 await f.budget.block({ expectedRevision: f.budget.snapshot().revision, at, until: new Date(f.host.clock() + 60000).toISOString(), reason: 'PROVIDER_RATE_LIMITED' })
 await f.reopen(); await f.reconciler.runOnce()
 expect(f.calls).toBe(2); expect(f.store.snapshot().reconciliations[0]).toMatchObject({ attempts: 3, status: 'quarantined', lastReason: 'RECONCILIATION_EXHAUSTED' })
})
