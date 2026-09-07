import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { enabledPolicy } from './config-fixture.ts'
import { githubReconciliationRegistrationSchema } from '../../src/darkfactory/config.ts'
import { DarkFactoryReconciler } from '../../src/darkfactory/reconciliation.ts'
import { DarkFactoryProviderRequestStore } from '../../src/darkfactory/provider-request-store.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { runGit } from '../../src/git-command.ts'

it('rotates a shared two-GET window after the last charged project across native-owner restart while both projects have backlog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'factory-reconciliation-fairness-')), projectIds = ['one', 'two']
  let now = Date.parse('2026-09-06T12:00:00Z'), calls = 0, budget: DarkFactoryProviderRequestStore | undefined, driver: DarkFactoryReconciler | undefined
  const stores = new Map<string, DarkFactoryIngestionStore>(), projects = projectIds.map(id => ({ id, repository: join(root, id) }))
  const policy = enabledPolicy(), template = policy.ingestion.routes[0]!
  if (template.source !== 'github') throw new Error('Expected GitHub fixture')
  policy.projectIds = projectIds; policy.fleet.projectCaps = projectIds.map(id => ({ ...policy.fleet.projectCaps[0]!, id }))
  policy.ingestion.routes = projectIds.map((projectId, index) => ({ ...structuredClone(template), id: `route-${projectId}`, projectId,
    repositoryIds: [String(index + 42)], senderIds: ['11'], bindings: { ...template.bindings, authorIds: ['12'] },
    reconciliation: githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: String(index + 42), repositoryName: `owner/${projectId}`,
      credentialKind: 'installation-token', credentialRef: { kind: 'env', name: 'FIXTURE_TOKEN' } }),
  }))
  const options = { routes: projectIds.map(projectId => ({ projectId, routeId: `route-${projectId}` })), requestsPerMinute: 2 }
  const artifacts = await DarkFactoryArtifactStore.open(root, projectIds, 65536, 1048576)
  const open = async () => {
    budget = await DarkFactoryProviderRequestStore.open(root, options)
    for (const projectId of projectIds) stores.set(projectId, await DarkFactoryIngestionStore.open(root, { projectId }))
    driver = await DarkFactoryReconciler.open(policy, { projects, stores, artifacts, requestBudget: budget, clock: () => now,
      resolveSecret: async () => 'fixture-token', authorize: async () => {}, quarantine: async () => { throw new Error('Unexpected fairness quarantine') },
      transport: async url => {
        calls++
        const number = Number(String(url).split('/').at(-1))
        const body = String(url).includes('/installation/repositories')
          ? { total_count: 2, repositories: projectIds.map((id, index) => ({ id: index + 42, full_name: `owner/${id}` })) }
          : { id: 100 + number, number, title: 'Current fixture', body: 'Read-only fixture', user: { id: 12 }, labels: [{ id: 1, name: 'automate' }], state: 'open', updated_at: '2026-09-06T12:00:00Z' }
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      },
    })
  }
  const close = async () => { await driver?.close(); for (const store of stores.values()) await store.close(); stores.clear(); await budget?.close() }
  try {
    for (const project of projects) {
      await runGit(root, ['init', '--quiet', project.repository], new AbortController().signal, 5000)
      await runGit(project.repository, ['remote', 'add', 'origin', `https://github.com/owner/${project.id}.git`], new AbortController().signal, 5000)
    }
    await open()
    for (const [index, projectId] of projectIds.entries()) for (const number of [1, 2]) {
      const artifact = await artifacts.persist(projectId, { lookup: { kind: 'issue', sourceEntityId: `issue:${index + 42}:${100 + number}`, providerEntityId: String(100 + number),
        repositoryId: String(index + 42), actorId: '11', installationId: '10', number } })
      await stores.get(projectId)!.recordReceived({ bodySizeBytes: 20, envelope: { schemaVersion: 1, id: `envelope-${projectId}-${number}`, projectId, policyRevision: 1,
        source: 'github', adapterVersion: 'v1', routeId: `route-${projectId}`, deliveryId: `delivery-${number}`, eventKind: 'issues', action: 'opened',
        bodyDigest: digestJson([projectId, number]), receivedAt: new Date(now).toISOString(), signingKeyId: 'ingress-key', authentication: 'verified', artifact } })
    }
    await driver!.runOnce()
    expect(calls).toBe(2); expect(stores.get('one')!.snapshot().items).toHaveLength(1); expect(stores.get('two')!.snapshot().items).toEqual([])
    const history = budget!.snapshot(); expect(history.charges.map(receipt => receipt.projectId)).toEqual(['one', 'one'])
    await close(); now += 60001; await open()
    expect(budget!.snapshot()).toEqual(history)
    await driver!.runOnce()
    expect(calls).toBe(4); expect(stores.get('one')!.snapshot().items).toHaveLength(1); expect(stores.get('two')!.snapshot().items).toHaveLength(1)
    expect(budget!.snapshot().charges.map(receipt => receipt.projectId)).toEqual(['one', 'one', 'two', 'two'])
    now += 60001; await driver!.runOnce()
    expect(calls).toBe(6); expect(stores.get('one')!.snapshot().items).toHaveLength(2); expect(stores.get('two')!.snapshot().items).toHaveLength(1)
    expect(budget!.snapshot().charges.map(receipt => receipt.projectId)).toEqual(['one', 'one', 'two', 'two', 'one', 'one'])
    expect(stores.get('two')!.snapshot().reconciliations).toHaveLength(1)
  } finally { await close(); await artifacts.settled(); await rm(root, { recursive: true, force: true }) }
}, 15000)
