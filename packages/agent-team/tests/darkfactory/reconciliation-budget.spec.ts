import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { enabledPolicy } from './config-fixture.ts'
import { githubReconciliationRegistrationSchema } from '../../src/darkfactory/config.ts'
import { DarkFactoryReconciler, type ReconciliationHost } from '../../src/darkfactory/reconciliation.ts'
import { DarkFactoryProviderRequestStore } from '../../src/darkfactory/provider-request-store.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { runGit } from '../../src/git-command.ts'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(limit = 3) {
  const root = await mkdtemp(join(tmpdir(), 'factory-reconciliation-budget-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-09-06T12:00:00Z'), calls = 0, status = 200
  const hosts: ReconciliationHost[] = [], stores: DarkFactoryIngestionStore[] = [], reconcilers: DarkFactoryReconciler[] = []
  const budgetOptions = { routes: ['one', 'two'].map(projectId => ({ projectId, routeId: 'route' })), requestsPerMinute: limit }
  let budget = await DarkFactoryProviderRequestStore.open(root, budgetOptions); cleanup.push(() => budget.close())
  const artifacts = await DarkFactoryArtifactStore.open(root, ['one', 'two'], 1_048_576, 16_777_216)
  cleanup.push(() => artifacts.settled())
  for (const projectId of ['one', 'two']) {
    const repository = join(root, projectId)
    await runGit(root, ['init', '--quiet', repository], new AbortController().signal, 5000)
    await runGit(repository, ['remote', 'add', 'origin', `https://github.com/owner/${projectId}.git`], new AbortController().signal, 5000)
    const policy = enabledPolicy(), route = policy.ingestion.routes[0]!
    if (route.source !== 'github') throw new Error('fixture route')
    policy.projectIds = [projectId]; policy.fleet.projectCaps[0]!.id = projectId; route.projectId = projectId
    route.repositoryIds = ['42']; route.senderIds = ['11']; route.bindings.authorIds = ['12']
    route.reconciliation = githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: '42', repositoryName: `owner/${projectId}`,
      credentialKind: 'installation-token', credentialRef: { kind: 'env', name: 'TEST_READ_TOKEN' } })
    const store = await DarkFactoryIngestionStore.open(root, { projectId }); stores.push(store); cleanup.push(() => store.close())
    const artifact = await artifacts.persist(projectId, { lookup: { kind: 'issue', sourceEntityId: 'issue:42:100', providerEntityId: '100', repositoryId: '42', actorId: '11', installationId: '10', number: 1 } })
    await store.recordReceived({ bodySizeBytes: 20, envelope: { schemaVersion: 1, id: `envelope-${projectId}`, projectId, policyRevision: 1, source: 'github', adapterVersion: 'v1', routeId: 'route',
      deliveryId: 'delivery', eventKind: 'issues', action: 'opened', bodyDigest: digestJson(projectId), receivedAt: new Date(now).toISOString(), signingKeyId: 'ingress-key', authentication: 'verified', artifact } })
    const host: ReconciliationHost = { projects: [{ id: projectId, repository }], stores: new Map([[projectId, store]]), artifacts, requestBudget: budget,
      clock: () => now, resolveSecret: async () => 'PRIVATE_REQUEST_TOKEN', authorize: async () => {}, quarantine: async () => { throw new Error('Unexpected fixture quarantine') },
      transport: async url => {
        calls++
        if (status === 429) return new Response('', { status, headers: { 'retry-after': '900' } })
        return new Response(JSON.stringify(String(url).includes('/installation/repositories') ? { total_count: 1, repositories: [{ id: 42, full_name: `owner/${projectId}` }] } : {
          id: 100, number: 1, title: 'Current registered issue', body: 'Expected fixture behavior', user: { id: 12 }, labels: [{ id: 1, name: 'automate' }], state: 'open', updated_at: '2026-09-06T12:00:00Z',
        }), { headers: { 'content-type': 'application/json' } })
      },
    }
    hosts.push(host); const reconciler = await DarkFactoryReconciler.open(policy, host); reconcilers.push(reconciler); cleanup.push(() => reconciler.close())
  }
  return { stores, reconcilers, get budget() { return budget }, get calls() { return calls }, get now() { return new Date(now).toISOString() }, advance(ms: number) { now += ms }, rateLimit() { status = 429 }, recover() { status = 200 },
    async reopenBudget() { await budget.close(); budget = await DarkFactoryProviderRequestStore.open(root, budgetOptions); hosts.forEach(host => { host.requestBudget = budget }) },
  }
}
it('charges actual GETs globally across independent project reconcilers and preserves partial-read charges after restart', async () => {
  const f = await fixture()
  await f.reconcilers[0]!.runOnce(); await f.reconcilers[1]!.runOnce()
  expect(f.calls).toBe(3)
  expect(f.budget.snapshot().charges).toHaveLength(3)
  expect(f.stores[0]!.snapshot().items[0]!.state).toBe('trusted')
  expect(f.stores[1]!.snapshot().items).toEqual([])
  expect(f.stores[1]!.snapshot().reconciliations[0]).toMatchObject({ status: 'pending', attempts: 1, lastReason: 'PROVIDER_RATE_LIMITED' })
  const before = f.budget.snapshot(); await f.reopenBudget()
  expect(f.budget.snapshot()).toEqual(before); expect(f.budget.availability(f.now).available).toBe(0)
  await f.reconcilers[1]!.runOnce(); expect(f.calls).toBe(3)
  f.advance(300_001); await f.reconcilers[1]!.runOnce()
  expect(f.calls).toBe(5); expect(f.budget.snapshot().charges).toHaveLength(5)
  expect(new Set(f.budget.snapshot().charges.map(receipt => receipt.id)).size).toBe(5)
  expect(f.stores[1]!.snapshot().items[0]!.state).toBe('trusted')
  expect(JSON.stringify(f.budget.snapshot())).not.toContain('PRIVATE_REQUEST_TOKEN')
})
it('persists provider cooldown globally and does not consume another source attempt while requests are withheld', async () => {
  const f = await fixture(55); f.rateLimit()
  await f.reconcilers[0]!.runOnce()
  expect(f.calls).toBe(1)
  expect(f.budget.snapshot().blockedUntil).toBe('2026-09-06T12:15:00.000Z')
  await f.reopenBudget(); f.recover(); f.advance(300_001)
  await f.reconcilers[0]!.runOnce(); await f.reconcilers[1]!.runOnce()
  expect(f.calls).toBe(1); expect(f.stores[0]!.snapshot().reconciliations[0]!.attempts).toBe(1)
  expect(f.stores[1]!.snapshot().reconciliations).toEqual([])
  f.advance(600_000); await f.reconcilers[1]!.runOnce()
  expect(f.calls).toBe(3); expect(f.stores[1]!.snapshot().items[0]!.state).toBe('trusted')
})
