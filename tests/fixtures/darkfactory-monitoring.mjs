/** Built SDK monitoring recovery fixture. No DSH plugin mount, models, or external network. */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  DarkFactoryMonitoringReconciler,
  DarkFactoryIngestionStore,
  DarkFactoryArtifactStore,
  DarkFactoryPolicyStore,
  DarkFactoryProviderRequestStore,
  enabledDarkFactoryConfigSchema,
  digestJson,
} from '../../packages/agent-team/lib/darkfactory.js'
import { HealthStore } from '../../packages/agent-team/lib/types/health.js'

const [mode, directory] = process.argv.slice(2)
if (!directory || !['seed', 'resume', 'replay'].includes(mode)) throw new Error('Expected monitoring reconciliation fixture mode and directory')
const now = Date.parse('2026-09-06T12:01:00.000Z') + (mode === 'seed' ? 0 : 300_001)
const clock = () => new Date(now).toISOString()
const workspace = join(directory, 'workspace')
const policy = enabledDarkFactoryConfigSchema.parse(JSON.parse(await readFile(join(directory, 'policy.json'), 'utf8')))
const route = policy.ingestion.routes[0]
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()))
let store, health, authority, budget, reconciler, denied = false, requests = 0
const host = { projectId: 'project', operatorId: 'operator', authorizationRef: 'fixture-host-grant' }
function snapshot(barrier) {
  return {
    barrier,
    pid: process.pid,
    requests,
    ingestion: store.snapshot(),
    inbox: health.listEscalations(),
    authority: authority.snapshot(),
    budget: budget.snapshot(),
  }
}
try {
  store = await DarkFactoryIngestionStore.open(workspace, { projectId: 'project', maxBodyBytes: 10_000, maxQueueItems: 100 }, clock)
  const artifacts = await DarkFactoryArtifactStore.open(workspace, ['project'], 1_048_576, 16_777_216)
  health = await HealthStore.open(workspace, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
  authority = await DarkFactoryPolicyStore.open(workspace, {
    grants: [{ projectId: 'project', operatorIds: ['operator'], authorizationRefs: ['fixture-host-grant'] }],
    effectGrants: [{ projectId: 'project', effect: 'ingress', authorizationRef: 'fixture-ingress-grant' }],
    implementedEffects: ['ingress'],
  }, clock)
  budget = await DarkFactoryProviderRequestStore.open(workspace, {
    routes: [{ projectId: 'project', routeId: route.id }],
    maxRecordBytes: 1_048_576,
    maxJournalBytes: 16_777_216,
  })

  async function receive(index) {
    const artifact = await artifacts.persist('project', {
      lookup: {
        kind: 'sentry_issue',
        sourceEntityId: 'sentry-issue:42:7',
        providerEntityId: '7',
        installationId: '10',
        actorId: '12',
        providerProjectIds: ['42'],
        organizationId: '20',
        resource: 'issue',
        providerRule: null,
        eventId: null,
      },
    })
    return store.recordReceived({
      bodySizeBytes: 20,
      envelope: {
        schemaVersion: 1,
        id: `envelope:${index}`,
        projectId: 'project',
        policyRevision: 1,
        source: 'sentry',
        adapterVersion: route.providerVersion,
        routeId: route.id,
        deliveryId: `delivery-${index}`,
        eventKind: 'issue',
        action: index === 0 ? 'created' : 'resolved',
        bodyDigest: digestJson({ index }),
        receivedAt: clock(),
        signingKeyId: route.signingKeyId,
        authentication: 'verified',
        artifact,
      },
    })
  }

  if (mode === 'seed') {
    await authority.installPolicy({ ...host, expectedRevision: 0, policy })
    await authority.recordGate({ ...host, expectedRevision: 1, policyRevision: 1, gate: 'observe', evidenceRefs: ['fixture-host-observe-authorization'] })
    await receive(0)
  }

  reconciler = await DarkFactoryMonitoringReconciler.open(policy, {
    projects: [{ id: 'project', repository: join(directory, 'repository') }],
    stores: new Map([['project', store]]),
    artifacts,
    requestBudget: budget,
    clock: () => now,
    authorize: async (projectId, effectId) => {
      const decision = await authority.decideEffect({ projectId, effectId, effect: 'ingress', expectedRevision: authority.snapshot()[0].revision, policyRevision: 1 })
      if (decision.decision !== 'allow') throw new Error('Fixture authority denied')
    },
    quarantine: async input => (await health.raiseFactoryEscalation({
      schemaVersion: 1,
      projectId: input.projectId,
      policyRevision: 1,
      stage: 'trust',
      reason: input.reason,
      effectId: input.envelopeId,
      evidenceRefs: [input.envelopeId],
      severity: 'warning',
      diagnostics: input.reason,
    }, now)).id,
    transport: async (url, init) => {
      requests++
      const urlString = String(url)
      if (!urlString.startsWith('https://sentry.io/')) throw new Error('Unexpected provider origin')
      if (mode === 'seed') {
        await send(snapshot('fetch-blocked'))
        return new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('Fixture fetch aborted')), { once: true }) })
      }
      if (urlString.includes('/api/0/projects/')) {
        return new Response(JSON.stringify({ id: '42', slug: 'service', organization: { id: '20', slug: 'acme' } }), { headers: { 'content-type': 'application/json' } })
      }
      if (urlString.includes('/events/latest/')) {
        return new Response(JSON.stringify({
          eventID: 'a'.repeat(32),
          groupID: '7',
          title: 'Sentry issue failure',
          dateCreated: new Date(now - 30_000).toISOString(),
          dateReceived: new Date(now - 10_000).toISOString(),
          tags: [{ key: 'environment', value: 'production' }],
          release: { version: 'release-1' },
          entries: [{
            type: 'exception',
            data: {
              values: [{
                type: 'Error',
                value: `Failure report. secret=${process.env.DF_SENTRY_TOKEN}`,
                stacktrace: { frames: [] },
              }],
            },
          }],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (urlString.includes('/api/0/organizations/acme/issues/7/')) {
        return new Response(JSON.stringify({
          id: '7',
          title: 'Sentry issue failure',
          culprit: 'service.run',
          status: denied ? 'resolved' : 'unresolved',
          project: { id: '42', slug: 'service' },
          firstSeen: new Date(now - 60_000).toISOString(),
          lastSeen: new Date(now - 10_000).toISOString(),
        }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ detail: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    },
  })

  process.on('message', async command => {
    try {
      if (command === 'stop') {
        await reconciler.close()
        await artifacts.settled()
        await budget.close()
        await store.close()
        await health.close()
        await authority.close()
        process.disconnect()
      } else if (command === 'deny') {
        denied = true
        await receive(1)
        await reconciler.runOnce()
        for (const incident of health.listEscalations()) {
          await health.acknowledge(incident.id, incident.revision, 'fixture-lead', now)
        }
        await send(snapshot('denied'))
      } else throw new Error('Unknown fixture command')
    } catch (error) {
      await send({ barrier: 'error', message: String(error) })
      process.exitCode = 1
      process.disconnect()
    }
  })

  await reconciler.runOnce()
  if (mode !== 'seed') await send(snapshot(mode === 'resume' ? 'recovered' : 'replayed'))
} catch (error) {
  await send({ barrier: 'error', message: String(error) })
  await reconciler?.close()
  await budget?.close()
  await store?.close()
  await health?.close()
  await authority?.close()
  process.exitCode = 1
  process.disconnect()
}
