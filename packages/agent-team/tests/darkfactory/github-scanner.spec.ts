import { mkdtemp, rm } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DarkFactoryGithubScanner } from '../../src/darkfactory/github-scanner.ts'
import { DarkFactoryGithubScanStore } from '../../src/darkfactory/github-scan-store.ts'
import { DarkFactoryReconciler } from '../../src/darkfactory/reconciliation.ts'
import { DarkFactoryProviderRequestStore } from '../../src/darkfactory/provider-request-store.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { authenticateIngress } from '../../src/darkfactory/ingress-auth.ts'
import { normalizeIngress } from '../../src/darkfactory/ingress-adapters.ts'
import { githubReconciliationRegistrationSchema, enabledDarkFactoryConfigSchema } from '../../src/darkfactory/config.ts'
import { HealthStore } from '../../src/health.ts'
import { runGit } from '../../src/git-command.ts'
import { enabledPolicy } from './config-fixture.ts'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const scannerId = 'host-scanner:repository', origin = { id: 42, full_name: 'owner/repo' }
const issue = (number = 1) => ({ id: 99 + number, number, title: `Repair ${number}`, body: 'Current provider evidence', user: { id: 12 }, labels: [{ id: 3, name: 'automate' }], state: 'open', updated_at: '2026-09-06T12:00:00Z' })
type Row = ReturnType<typeof issue> & { pull_request?: object }
async function fixture(maxPages = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-github-scanner-')); cleanups.push(() => rm(directory, { recursive: true, force: true }))
  await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
  await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)
  const raw = enabledPolicy(), route = raw.ingestion.routes[0]!
  if (route.source !== 'github') throw new Error('fixture route')
  route.repositoryIds = ['42']; route.senderIds = ['12', scannerId]; route.bindings = { installationIds: ['10'], authorIds: ['12'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] }
  route.reconciliation = githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'FIXTURE_TOKEN' }, credentialKind: 'installation-token', scan: { scannerId, ruleId: 'rule', initialSince: '2026-09-06T11:00:00Z', maxPages } })
  raw.limits.maxArtifactBytes = 1_048_576; raw.limits.maxJournalRecordBytes = 1_048_576; raw.limits.maxJournalBytes = 67_108_864
  raw.ingestion.maxBodyBytes = 1_048_576; raw.ingestion.maxQueueItems = 1000
  const policy = enabledDarkFactoryConfigSchema.parse(raw)
  const ingestOptions = { projectId: 'project', maxBodyBytes: policy.ingestion.maxBodyBytes, maxQueueItems: 1000, maxRecordBytes: policy.limits.maxJournalRecordBytes, maxJournalBytes: policy.limits.maxJournalBytes }
  const scanOptions = { routes: [{ projectId: 'project', routeId: route.id, initialSince: route.reconciliation.scan!.initialSince }] }
  const budgetOptions = { routes: [{ projectId: 'project', routeId: route.id }] }
  let store = await DarkFactoryIngestionStore.open(directory, ingestOptions), scanStore = await DarkFactoryGithubScanStore.open(directory, scanOptions), requestBudget = await DarkFactoryProviderRequestStore.open(directory, budgetOptions)
  const artifacts = await DarkFactoryArtifactStore.open(directory, ['project'], 1_048_576, 67_108_864)
  const health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
  const stores = new Map([['project', store]]), pages = new Map<number, Row[]>([[1, [issue()]]]), urls: string[] = []
  const details = new Map<number, Record<string, unknown>>()
  let now = Date.parse('2026-09-06T12:01:00Z'), status = 200, authority = true
  const host = () => ({ projects: [{ id: 'project', repository: directory }], stores, artifacts, requestBudget, scanStore, clock: () => now,
    resolveSecret: async () => 'fixture-installation-token', authorize: async () => { if (!authority) throw new Error('authority unavailable') },
    quarantine: async (input: { projectId: string; envelopeId: string; reason: string }) => (await health.raiseFactoryEscalation({ schemaVersion: 1, projectId: input.projectId, policyRevision: 1, stage: 'ingress', reason: input.reason, effectId: input.envelopeId, evidenceRefs: [input.envelopeId], severity: 'warning', diagnostics: input.reason }, now)).id,
    transport: (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url)); expect(requestBudget.snapshot().charges).toHaveLength(urls.length)
      expect(init?.method).toBe('GET'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-installation-token')
      if (status !== 200) return new Response('untrusted provider failure', { status, headers: status === 429 ? { 'retry-after': '600' } : {} })
      const address = new URL(String(url)); let value: unknown
      if (address.pathname === '/installation/repositories') value = { total_count: 1, repositories: [origin] }
      else if (address.pathname === '/repos/owner/repo/issues') value = pages.get(Number(address.searchParams.get('page'))) ?? []
      else {
        const number = Number(address.pathname.split('/').at(-1))
        value = { ...issue(number), ...(address.pathname.includes('/pulls/') ? { id: 499 + number, merged: false, draft: false, base: { repo: origin, sha: 'a'.repeat(40), ref: 'main' }, head: { repo: origin, sha: 'b'.repeat(40), ref: 'repair' } } : {}), ...details.get(number) }
      }
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  let scanner = await DarkFactoryGithubScanner.open(policy, host()), reconciler = await DarkFactoryReconciler.open(policy, host())
  cleanups.push(async () => { await scanner.close(); await reconciler.close(); await scanStore.close(); await requestBudget.close(); await store.close(); await health.close() })
  return { directory, urls, health, artifacts, get scanner() { return scanner }, get reconciler() { return reconciler }, get store() { return store }, get scanStore() { return scanStore }, get budget() { return requestBudget },
    get now() { return now }, advance(ms = 300_001) { now += ms }, setPage(page: number, rows: Row[]) { pages.set(page, rows) }, setStatus(value: number) { status = value }, setDetail(number: number, value: Record<string, unknown>) { details.set(number, value) }, revoke() { authority = false },
    async webhook(number = 1) {
      const secret = 'fixture-webhook-secret', body = Buffer.from(JSON.stringify({ action: 'opened', repository: origin, sender: { id: 12 }, installation: { id: 10 }, issue: issue(number) }))
      const frame = authenticateIngress({ route: { id: route.id, projectId: 'project', source: 'github', providerVersion: route.providerVersion, policyRevision: 1, signingKeyId: route.signingKeyId }, secret, receivedAt: new Date(now).toISOString(), request: { method: 'POST', path: `/darkfactory/v1/ingress/github/${route.id}`, body, headers: [['content-type', 'application/json'], ['x-github-event', 'issues'], ['x-github-delivery', `webhook-${number}`], ['x-hub-signature-256', `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`]] } })
      const { envelope, facts } = normalizeIngress(frame)
      const artifact = await artifacts.persist('project', { lookup: { kind: 'issue', sourceEntityId: facts.sourceEntityId, providerEntityId: facts.providerEntityId, repositoryId: facts.repositoryId, installationId: facts.installationId, actorId: facts.actorId, number } })
      await store.recordReceived({ envelope: { ...envelope, artifact }, bodySizeBytes: body.byteLength })
    },
    async reopen() {
      await scanner.close(); await reconciler.close(); await scanStore.close(); await requestBudget.close(); await store.close()
      store = await DarkFactoryIngestionStore.open(directory, ingestOptions); stores.set('project', store)
      scanStore = await DarkFactoryGithubScanStore.open(directory, scanOptions); requestBudget = await DarkFactoryProviderRequestStore.open(directory, budgetOptions)
      scanner = await DarkFactoryGithubScanner.open(policy, host()); reconciler = await DarkFactoryReconciler.open(policy, host())
    },
  }
}
it('discovers a missed issue without webhook/HMAC custody and then establishes current source trust', async () => {
  const f = await fixture(); await f.scanner.runOnce()
  const custody = f.store.snapshot().custody[0]!
  expect(custody.envelope).toMatchObject({ authentication: 'provider-api', action: 'scan', providerRead: { scannerId, ruleId: 'rule' } })
  expect(custody.envelope).not.toHaveProperty('signingKeyId'); expect(f.store.snapshot().items).toEqual([])
  expect(f.scanStore.snapshot().cursors[0]).toMatchObject({ watermark: new Date(f.now).toISOString(), sweep: { status: 'complete' } })
  await f.reconciler.runOnce()
  expect(f.store.snapshot().items[0]).toMatchObject({ state: 'trusted', actor: scannerId, author: '12', sourceEntityId: 'issue:42:100', initiator: { kind: 'host-scanner', scannerId, ruleId: 'rule' } })
  expect(f.health.listEscalations()).toHaveLength(0); expect(f.urls).toHaveLength(4)
})
it('creates distinct durable custody and work for multiple entities on one page', async () => {
  const f = await fixture(); f.setPage(1, [issue(1), issue(2)])
  await f.scanner.runOnce(); await f.reconciler.runOnce()
  expect(new Set(f.store.snapshot().custody.map(value => value.envelope.id)).size).toBe(2)
  expect(new Set(f.store.snapshot().items.map(value => value.sourceEntityId))).toEqual(new Set(['issue:42:100', 'issue:42:101']))
  expect(f.store.snapshot().items.every(item => item.state === 'trusted')).toBe(true)
})
it.each(['webhook-first', 'scanner-first'] as const)('deduplicates the same source revision across %s receipts', async order => {
  const f = await fixture()
  if (order === 'webhook-first') { await f.webhook(); await f.reconciler.runOnce(); await f.scanner.runOnce() }
  else { await f.scanner.runOnce(); await f.reconciler.runOnce(); await f.webhook() }
  const original = structuredClone(f.store.snapshot().items[0]!)
  await f.reconciler.runOnce()
  expect(f.store.snapshot().custody).toHaveLength(2); expect(f.store.snapshot().items).toEqual([original])
  expect(f.store.snapshot().reconciliations.every(value => value.status === 'resolved')).toBe(true)
  expect(f.health.listEscalations()).toHaveLength(0)
})
it('reopens a saved partial page and finishes custody without refetching its mutable provider page', async () => {
  const f = await fixture(); f.setPage(1, [issue(1), issue(2)])
  const receive = f.store.recordReceived.bind(f.store); let calls = 0
  f.store.recordReceived = async request => { if (++calls === 2) throw new Error('custody interruption'); return receive(request) }
  await f.scanner.runOnce()
  expect(f.store.snapshot().custody).toHaveLength(1); expect(f.scanStore.snapshot().cursors[0]!.watermark).toBeNull()
  const first = f.store.snapshot().custody[0]!, page = f.scanStore.snapshot().cursors[0]!.sweep!.pages[0]!
  expect(page.acknowledged).toBe(false); expect(f.urls).toHaveLength(2)
  await f.reopen(); f.advance(); f.setStatus(503); await f.scanner.runOnce()
  expect(f.urls).toHaveLength(2); expect(f.store.snapshot().custody).toHaveLength(2)
  expect(f.store.snapshot().custody[0]).toEqual(first)
  expect(f.scanStore.snapshot().cursors[0]!.sweep!.status).toBe('complete')
})
it('retains full-page continuation and watermark until final custody, then starts an overlapping sweep', async () => {
  const f = await fixture(1), cutoff = new Date(f.now).toISOString()
  f.setPage(1, Array.from({ length: 100 }, (_, index) => issue(index + 1))); f.setPage(2, [])
  await f.scanner.runOnce()
  expect(f.store.snapshot().custody).toHaveLength(100)
  expect(f.scanStore.snapshot().cursors[0]).toMatchObject({ watermark: null, sweep: { page: 2, status: 'active', cutoff } })
  await f.reopen(); await f.scanner.runOnce(); expect(f.urls).toHaveLength(2)
  f.advance(); await f.scanner.runOnce()
  expect(f.urls.at(-1)).toContain('page=2'); expect(f.scanStore.snapshot().cursors[0]!.watermark).toBe(cutoff)
  f.setPage(1, []); await f.scanner.runOnce()
  const query = new URL(f.urls.at(-1)!)
  expect(query.searchParams.get('page')).toBe('1'); expect(query.searchParams.get('since')).toBe(new Date(Date.parse(cutoff) - 600_000).toISOString())
})
it.each([503, 429])('preserves the established watermark after provider failure %s', async status => {
  const f = await fixture(); f.setPage(1, []); await f.scanner.runOnce()
  const watermark = f.scanStore.snapshot().cursors[0]!.watermark
  f.advance(); f.setStatus(status); await f.scanner.runOnce()
  expect(f.scanStore.snapshot().cursors[0]).toMatchObject({ watermark, sweep: { status: 'active', page: 1 } })
  expect(f.health.listEscalations()).toHaveLength(status === 429 ? 0 : 1)
  if (status === 429) expect(Date.parse(f.budget.snapshot().blockedUntil!)).toBeGreaterThanOrEqual(f.now + 600_000)
})
it('reconciles the actual PR identity and commits rather than its list issue identity', async () => {
  const f = await fixture(); f.setPage(1, [{ ...issue(), pull_request: { url: 'https://attacker.invalid/no-follow' } }])
  await f.scanner.runOnce(); await f.reconciler.runOnce()
  const item = f.store.snapshot().items[0]!
  expect(item).toMatchObject({ state: 'trusted', sourceEntityId: 'pr:42:500', sourceUrl: 'https://github.com/owner/repo/pull/1' })
  expect(await f.artifacts.read(item.provenance[1]!)).toMatchObject({ providerEntityId: '500', sourceEntityId: 'pr:42:500', base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } })
  expect(f.urls.some(url => url.endsWith('/pulls/1'))).toBe(true)
})

it('does not create custody or advance a saved page after host authority is paused', async () => {
  const f = await fixture(), original = f.store.recordReceived.bind(f.store)
  f.store.recordReceived = async () => { throw new Error('interruption before first custody') }
  await f.scanner.runOnce()
  const saved = structuredClone(f.scanStore.snapshot().cursors[0]!.sweep!.pages[0]!)
  expect(saved.acknowledged).toBe(false); expect(f.store.snapshot().custody).toEqual([])
  f.store.recordReceived = original; await f.reopen(); f.advance(); f.revoke()
  await f.scanner.runOnce()
  expect(f.store.snapshot().custody).toEqual([]); expect(f.urls).toHaveLength(2)
  expect(f.scanStore.snapshot().cursors[0]!.watermark).toBeNull()
  expect(f.scanStore.snapshot().cursors[0]!.sweep!.pages[0]).toEqual(saved)
})
it.each(['closed', 'unlabelled'] as const)('invalidates existing trusted work when a missed %s change is discovered', async change => {
  const f = await fixture(); await f.scanner.runOnce(); await f.reconciler.runOnce()
  const original = structuredClone(f.store.snapshot().items[0]!)
  const patch = change === 'closed' ? { state: 'closed' } : { labels: [] }
  f.advance(); f.setPage(1, [{ ...issue(), ...patch }]); f.setDetail(1, patch)
  await f.scanner.runOnce(); await f.reconciler.runOnce()
  expect(f.store.snapshot().items).toHaveLength(1)
  expect(f.store.snapshot().items[0]).toMatchObject({ id: original.id, sourceRevision: original.sourceRevision, state: 'quarantined', trust: { decision: 'revoked' }, quarantineReason: 'SOURCE_DENIED' })
  expect(f.health.listEscalations().map(value => value.id)).toContain(f.store.snapshot().items[0]!.healthEscalationId)
})
