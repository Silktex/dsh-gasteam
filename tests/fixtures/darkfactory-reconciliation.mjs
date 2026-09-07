/** Built SDK recovery fixture. No DSH plugin mount, models, or external network. */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { DarkFactoryReconciler, DarkFactoryIngestionStore, DarkFactoryArtifactStore, DarkFactoryPolicyStore, enabledDarkFactoryConfigSchema, digestJson } from '../../packages/agent-team/lib/darkfactory.js'
import { HealthStore } from '../../packages/agent-team/lib/types/health.js'

const [mode, directory] = process.argv.slice(2)
if (!directory || !['seed', 'resume', 'replay'].includes(mode)) throw new Error('Expected reconciliation fixture mode and directory')
const now = Date.parse('2026-09-06T12:01:00.000Z') + (mode === 'seed' ? 0 : 300_001)
const clock = () => new Date(now).toISOString()
const workspace = join(directory, 'workspace')
const policy = enabledDarkFactoryConfigSchema.parse(JSON.parse(await readFile(join(directory, 'policy.json'), 'utf8')))
const route = policy.ingestion.routes[0]
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()))
let store, health, authority, reconciler, denied = false, requests = 0
const host = { projectId: 'project', operatorId: 'operator', authorizationRef: 'fixture-host-grant' }
function snapshot(barrier) {
  return { barrier, pid: process.pid, requests, ingestion: store.snapshot(), inbox: health.listEscalations(), authority: authority.snapshot() }
}
try {
  store = await DarkFactoryIngestionStore.open(workspace, { projectId: 'project', maxBodyBytes: 10_000, maxQueueItems: 100 }, clock)
  const artifacts = await DarkFactoryArtifactStore.open(workspace, ['project'], 1_048_576, 16_777_216)
  health = await HealthStore.open(workspace, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
  authority = await DarkFactoryPolicyStore.open(workspace, { grants: [{ projectId: 'project', operatorIds: ['operator'], authorizationRefs: ['fixture-host-grant'] }], effectGrants: [{ projectId: 'project', effect: 'ingress', authorizationRef: 'fixture-ingress-grant' }], implementedEffects: ['ingress'] }, clock)
  async function receive(index) {
    const artifact = await artifacts.persist('project', { lookup: { kind: 'issue', sourceEntityId: `issue:42:${100 + index}`, providerEntityId: String(100 + index), repositoryId: '42', actorId: '12', installationId: '10', number: index + 1 } })
    return store.recordReceived({ bodySizeBytes: 20, envelope: { schemaVersion: 1, id: `envelope:${index}`, projectId: 'project', policyRevision: 1, source: 'github', adapterVersion: route.providerVersion, routeId: route.id, deliveryId: `delivery-${index}`, eventKind: 'issues', action: 'opened', bodyDigest: digestJson({ index }), receivedAt: clock(), signingKeyId: route.signingKeyId, authentication: 'verified', artifact } })
  }
  if (mode === 'seed') {
    await authority.installPolicy({ ...host, expectedRevision: 0, policy })
    await authority.recordGate({ ...host, expectedRevision: 1, policyRevision: 1, gate: 'observe', evidenceRefs: ['fixture-host-observe-authorization'] })
    await receive(0)
  }
  reconciler = await DarkFactoryReconciler.open(policy, {
    projects: [{ id: 'project', repository: join(directory, 'repository') }], stores: new Map([['project', store]]), artifacts,
    clock: () => now,
    authorize: async (projectId, effectId) => {
      const decision = await authority.decideEffect({ projectId, effectId, effect: 'ingress', expectedRevision: authority.snapshot()[0].revision, policyRevision: 1 })
      if (decision.decision !== 'allow') throw new Error('Fixture authority denied')
    },
    quarantine: async input => (await health.raiseFactoryEscalation({ schemaVersion: 1, projectId: input.projectId, policyRevision: 1, stage: 'trust', reason: input.reason, effectId: input.envelopeId, evidenceRefs: [input.envelopeId], severity: 'warning', diagnostics: input.reason }, now)).id,
    transport: async (url, init) => {
      requests++
      if (!String(url).startsWith('https://api.github.com/')) throw new Error('Unexpected provider origin')
      if (mode === 'seed') {
        // The real driver reaches transport only after append+fsync of begin and authority decision.
        await send(snapshot('fetch-blocked'))
        return new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('Fixture fetch aborted')), { once: true }) })
      }
      const number = Number(String(url).split('/').at(-1))
      const body = String(url).includes('/installation/repositories') ? { total_count: 1, repositories: [{ id: 42, full_name: 'owner/repo' }] }
        : { id: 99 + number, number, title: 'Recover durable source custody', body: `Expected success. secret=${process.env.DF_RECONCILIATION_TOKEN}`, user: { id: 12 }, labels: denied ? [] : [{ id: 3, name: 'automate' }], state: 'open', updated_at: '2026-09-06T12:00:00Z' }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    },
  })
  process.on('message', async command => {
    try {
      if (command === 'stop') {
        await reconciler.close(); await artifacts.settled(); await store.close(); await health.close(); await authority.close(); process.disconnect()
      } else if (command === 'deny') {
        denied = true
        await receive(1)
        await reconciler.runOnce()
        const incident = health.listEscalations()[0]
        await health.acknowledge(incident.id, incident.revision, 'fixture-lead', now)
        await send(snapshot('denied'))
      } else throw new Error('Unknown fixture command')
    } catch (error) { await send({ barrier: 'error', message: String(error) }); process.exitCode = 1; process.disconnect() }
  })
  await reconciler.runOnce()
  if (mode !== 'seed') await send(snapshot(mode === 'resume' ? 'recovered' : 'replayed'))
} catch (error) {
  await send({ barrier: 'error', message: String(error) })
  await reconciler?.close(); await store?.close(); await health?.close(); await authority?.close()
  process.exitCode = 1
  process.disconnect()
}
