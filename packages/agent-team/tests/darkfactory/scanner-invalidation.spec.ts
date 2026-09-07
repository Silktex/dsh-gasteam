import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DarkFactoryReconciler } from '../../src/darkfactory/reconciliation.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { DarkFactoryProviderRequestStore } from '../../src/darkfactory/provider-request-store.ts'
import { githubReconciliationRegistrationSchema } from '../../src/darkfactory/config.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { HealthStore } from '../../src/health.ts'
import { runGit } from '../../src/git-command.ts'
import { enabledPolicy } from './config-fixture.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
type Mode = 'open' | 'closed' | 'unlabelled' | 'author' | 'fork' | 'head-missing' | 'base' | 'head' | 'outage'
async function fixture(kind: 'issue' | 'pull_request' = 'issue') {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-invalidation-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
  await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)
  const policy = enabledPolicy(), route = policy.ingestion.routes[0]!
  if (route.source !== 'github') throw new Error('Expected GitHub route')
  route.repositoryIds = ['42']; route.senderIds = ['12', 'host-scanner:fixture']
  route.bindings = { installationIds: ['10'], authorIds: ['12'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] }
  route.reconciliation = githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'FIXTURE_TOKEN' }, credentialKind: 'installation-token',
    scan: { scannerId: 'host-scanner:fixture', ruleId: 'rule', initialSince: '2026-09-06T00:00:00Z' } })
  const options = { projectId: 'project' }
  let store = await DarkFactoryIngestionStore.open(directory, options)
  const stores = new Map([['project', store]])
  const artifacts = await DarkFactoryArtifactStore.open(directory, ['project'], 1_048_576, 16_777_216)
  const budget = await DarkFactoryProviderRequestStore.open(directory, { routes: [{ projectId: 'project', routeId: route.id }] })
  const health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
  let mode: Mode = 'open', allowed = true, revokeAfterRead = false, now = Date.parse('2026-09-06T12:00:00Z'), deliveries = 0, calls = 0
  const open = () => DarkFactoryReconciler.open(policy, { projects: [{ id: 'project', repository: directory }], stores, artifacts, requestBudget: budget,
    clock: () => now, resolveSecret: async () => 'fixture-token', authorize: async () => { if (!allowed) throw new Error('Authority revoked') },
    quarantine: async input => (await health.raiseFactoryEscalation({ schemaVersion: 1, projectId: input.projectId, policyRevision: 1, stage: 'trust', reason: input.reason, effectId: input.envelopeId, evidenceRefs: [input.envelopeId], severity: 'warning', diagnostics: input.reason }, now)).id,
    transport: async url => {
      calls++
      if (mode === 'outage') return new Response('unavailable', { status: 503 })
      if (String(url).includes('/installation/repositories')) return Response.json({ total_count: 1, repositories: [{ id: 42, full_name: 'owner/repo' }] })
      if (revokeAfterRead) allowed = false
      const side = { repo: { id: 42, full_name: 'owner/repo' }, sha: 'a'.repeat(40), ref: 'main' }
      return Response.json({ id: 100, number: 1, title: 'Repair requests', body: 'Empty requests should return 400', user: { id: mode === 'author' ? 99 : 12 },
        labels: mode === 'unlabelled' ? [] : [{ id: 3, name: 'automate' }], state: mode === 'closed' ? 'closed' : 'open', updated_at: '2026-09-06T11:59:00Z',
        ...(kind === 'pull_request' ? { merged: false, draft: false, base: mode === 'base' ? { ...side, repo: { id: 99, full_name: 'owner/other' } } : side,
          head: { ...side, sha: 'b'.repeat(40), ref: 'repair', repo: mode === 'head-missing' ? null : mode === 'fork' ? { id: 99, full_name: 'owner/fork' } : mode === 'head' ? { id: 42, full_name: 'owner/other' } : side.repo } } : {}),
      })
    },
  })
  let reconciler = await open()
  cleanup.push(async () => { await reconciler.close(); await artifacts.settled(); await store.close(); await budget.close(); await health.close() })
  const add = async (scanner = false, actorId = scanner ? 'host-scanner:fixture' : '12', initialFork = false) => {
    const id = `envelope-${++deliveries}`, receivedAt = new Date(now).toISOString()
    const lookup = { kind: scanner && kind === 'pull_request' ? 'scanned_pull_request' : kind, repositoryId: '42', installationId: '10', actorId, number: 1,
      providerEntityId: scanner && kind === 'pull_request' ? '777' : '100', sourceEntityId: scanner && kind === 'pull_request' ? 'pr-number:42:1' : `${kind === 'issue' ? 'issue' : 'pr'}:42:100`,
      ...(scanner ? { initiator: { kind: 'host-scanner', scannerId: 'host-scanner:fixture', ruleId: 'rule' } } : {}),
      ...(!scanner && kind === 'pull_request' ? { baseRepositoryId: '42', headRepositoryId: initialFork ? '99' : '42', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), fork: initialFork } : {}),
    }
    const charge = scanner ? await budget.reserve({ projectId: 'project', routeId: route.id, at: receivedAt, expectedRevision: budget.snapshot().revision }) : undefined
    const responseDigest = digestJson({ mode, delivery: deliveries })
    const artifact = await artifacts.persist('project', { lookup, ...(charge ? { responseDigest, requestReceiptId: charge.id } : {}) })
    const envelope = { schemaVersion: 1 as const, id, projectId: 'project', policyRevision: 1, source: 'github' as const, adapterVersion: route.providerVersion, routeId: route.id, deliveryId: `delivery-${deliveries}`,
      eventKind: kind === 'issue' ? 'issues' : 'pull_request', action: scanner ? 'observed' : 'edited', bodyDigest: scanner ? artifact.digest : digestJson({ id }), receivedAt, artifact,
      ...(charge ? { authentication: 'provider-api' as const, providerRead: { scannerId: 'host-scanner:fixture', ruleId: 'rule', requestReceiptId: charge.id, responseDigest, observedAt: receivedAt } }
        : { authentication: 'verified' as const, signingKeyId: route.signingKeyId }),
    }
    await store.recordReceived({ envelope, bodySizeBytes: scanner ? artifact.sizeBytes : 20 })
    return id
  }
  await add()
  return { get store() { return store }, get reconciler() { return reconciler }, health, get calls() { return calls }, add,
    active: () => store.snapshot().items[0]!, mode(value: Mode) { mode = value }, revokeAfterRead() { revokeAfterRead = true }, advance() { now += 300_001 },
    async state(value: 'compiled' | 'admitted' | 'acknowledged') { for (const next of ['compiled', 'admitted', 'acknowledged'] as const) { const item = store.snapshot().items[0]!; await store.transition({ projectId: 'project', expectedRevision: item.revision, item: { ...item, revision: item.revision + 1, state: next } }); if (value === next) break } },
    async reopen() { await reconciler.close(); await store.close(); store = await DarkFactoryIngestionStore.open(directory, options); stores.set('project', store); reconciler = await open() },
  }
}

it.each([
  ['issue', 'closed', 'trusted'], ['issue', 'unlabelled', 'compiled'], ['issue', 'author', 'admitted'],
  ['pull_request', 'closed', 'trusted'], ['pull_request', 'fork', 'compiled'], ['pull_request', 'head-missing', 'admitted'], ['pull_request', 'base', 'trusted'], ['pull_request', 'head', 'trusted'],
] as const)('revokes prior %s work after authoritative %s denial in %s state', async (kind, mode, state) => {
  const f = await fixture(kind); await f.reconciler.runOnce()
  if (state !== 'trusted') await f.state(state)
  const before = f.active(); f.mode(mode)
  const incoming = await f.add(true); await f.reconciler.runOnce()
  expect(f.active()).toMatchObject({ id: before.id, envelopeId: before.envelopeId, sourceEntityId: before.sourceEntityId, sourceRevision: before.sourceRevision, state: 'quarantined', quarantineReason: 'SOURCE_DENIED', trust: { decision: 'revoked' } })
  expect(f.active().provenance).toEqual(before.provenance)
  const inbox = f.health.listEscalations()
  expect(inbox).toHaveLength(2)
  expect(inbox.find(entry => entry.id === f.active().healthEscalationId)).toMatchObject({ source: 'darkfactory', effectId: before.envelopeId, reason: 'SOURCE_DENIED' })
  expect(f.store.snapshot().reconciliations.find(cursor => cursor.envelopeId === incoming)).toMatchObject({ status: 'quarantined', lastReason: 'SOURCE_DENIED' })
  const revoked = f.active(); await f.reopen(); await f.reconciler.runOnce()
  expect(f.active()).toEqual(revoked); expect(f.health.listEscalations()).toEqual(inbox)
})

it.each(['outage', 'actor', 'initial-fork'] as const)('does not revoke old work on %s failure without an authoritative entity denial', async failure => {
  const f = await fixture(failure === 'initial-fork' ? 'pull_request' : 'issue'); await f.reconciler.runOnce()
  const before = f.active(), requests = f.calls
  if (failure === 'outage') f.mode('outage')
  const envelopeId = await f.add(failure === 'outage', failure === 'outage' ? 'host-scanner:fixture' : failure === 'actor' ? '999' : '12', failure === 'initial-fork')
  await f.reconciler.runOnce()
  expect(f.active()).toEqual(before)
  expect(f.health.listEscalations().some(entry => entry.source === 'darkfactory' && entry.effectId === before.envelopeId)).toBe(false)
  expect(f.calls - requests).toBe(failure === 'outage' ? 1 : 0)
  if (failure === 'outage') expect(f.store.snapshot().reconciliations.find(cursor => cursor.envelopeId === envelopeId)).toMatchObject({ status: 'pending', lastReason: 'PROVIDER_UNAVAILABLE' })
})

it('rechecks host authority after the denied provider read and preserves acknowledged history', async () => {
  const revokedHost = await fixture(); await revokedHost.reconciler.runOnce()
  const before = revokedHost.active(); revokedHost.mode('closed'); revokedHost.revokeAfterRead()
  const incoming = await revokedHost.add(true); await revokedHost.reconciler.runOnce()
  expect(revokedHost.active()).toEqual(before)
  expect(revokedHost.store.snapshot().reconciliations.find(cursor => cursor.envelopeId === incoming)).toMatchObject({ status: 'quarantined', lastReason: 'AUTHORITY_UNRESOLVED' })
  const acknowledged = await fixture(); await acknowledged.reconciler.runOnce(); await acknowledged.state('acknowledged')
  const accepted = acknowledged.active(); acknowledged.mode('closed'); await acknowledged.add(true); await acknowledged.reconciler.runOnce()
  expect(acknowledged.active()).toEqual(accepted)
  expect(acknowledged.health.listEscalations()).toHaveLength(1)
})

it('restricts scanned PR-number invalidation to the registered repository and exact canonical URL', async () => {
  const f = await fixture('pull_request'); await f.reconciler.runOnce()
  const original = f.active(), custody = f.store.snapshot().custody[0]!
  for (const [index, patch] of [{ repository: { provider: 'github', repositoryId: '99', canonicalName: 'owner/other' } }, { sourceUrl: `${original.sourceUrl}?different=1` }].entries()) {
    const item = { ...original, ...patch, id: `decoy-${index}`, sourceEntityId: `pr:42:decoy-${index}`, envelopeId: `decoy-envelope-${index}`, state: 'received' as const, revision: 1, trust: { ...original.trust, decision: 'unresolved' as const } }
    await f.store.recordReceived({ envelope: { ...custody.envelope, id: item.envelopeId, routeId: 'not-reconciled', deliveryId: item.envelopeId, bodyDigest: digestJson(item.id) }, bodySizeBytes: 20, item })
    await f.store.transition({ projectId: 'project', expectedRevision: 1, item: { ...item, revision: 2, state: 'trusted', trust: { ...item.trust, decision: 'trusted' } } })
  }
  const decoys = f.store.snapshot().items.slice(1)
  f.mode('closed'); await f.add(true); await f.reconciler.runOnce()
  expect(f.active().trust.decision).toBe('revoked')
  expect(f.store.snapshot().items.slice(1)).toEqual(decoys)
})

it('retries an interrupted source quarantine using its existing real health receipt', async () => {
  const f = await fixture(); await f.reconciler.runOnce(); f.mode('closed'); const incoming = await f.add(true)
  const transition = f.store.transition.bind(f.store)
  f.store.transition = async () => { throw new Error('Simulated interruption before source append') }
  await f.reconciler.runOnce()
  expect(f.active().state).toBe('trusted'); expect(f.health.listEscalations()).toHaveLength(1)
  const incident = f.health.listEscalations()[0]!
  f.store.transition = transition; await f.reopen(); f.advance(); await f.reconciler.runOnce()
  expect(f.active()).toMatchObject({ state: 'quarantined', healthEscalationId: incident.id, trust: { decision: 'revoked' } })
  expect(f.store.snapshot().reconciliations.find(cursor => cursor.envelopeId === incoming)).toMatchObject({ status: 'quarantined', attempts: 2 })
  expect(f.health.listEscalations()).toHaveLength(2)
})

it('never promotes received work through a scanner alias and exhausts the alias at attempt three', async () => {
  const f = await fixture(), transition = f.store.transition.bind(f.store)
  f.store.transition = async () => { throw new Error('Original observation trust transition interrupted') }
  await f.reconciler.runOnce()
  expect(f.active().state).toBe('received')
  const incoming = await f.add(true); await f.reconciler.runOnce()
  for (let retry = 0; retry < 2; retry++) { f.advance(); await f.reconciler.runOnce() }
  expect(f.active()).toMatchObject({ state: 'received', actor: '12', trust: { decision: 'unresolved' } })
  expect(f.store.snapshot().items).toHaveLength(1)
  expect(f.store.snapshot().reconciliations.find(cursor => cursor.envelopeId === incoming)).toMatchObject({ attempts: 3, status: 'quarantined', lastReason: 'RECONCILIATION_EXHAUSTED' })
  f.store.transition = transition
})
