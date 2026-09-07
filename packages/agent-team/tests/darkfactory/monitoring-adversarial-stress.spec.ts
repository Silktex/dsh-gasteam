import { createServer, type Server } from 'node:http'
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DarkFactoryObserver } from '../../src/darkfactory/observer.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { DarkFactoryPolicyStore } from '../../src/darkfactory/policy-store.ts'
import { DarkFactoryProviderRequestStore, ProviderRequestDeniedError } from '../../src/darkfactory/provider-request-store.ts'
import { DarkFactoryMonitoringReconciler } from '../../src/darkfactory/monitoring-reconciler.ts'
import { HealthStore } from '../../src/health.ts'
import { enabledDarkFactoryConfigSchema, type IngressPolicyRoute } from '../../src/darkfactory/config.ts'
import { digestBytes, digestJson } from '../../src/darkfactory/json.ts'
import { GENERIC_INGRESS_HEADERS, genericIngressSigningInput } from '../../src/darkfactory/ingress-auth.ts'
import { runGit } from '../../src/git-command.ts'
import { enabledPolicy } from './config-fixture.ts'
import { reconcileSentrySource } from '../../src/darkfactory/sentry-reconciliation.ts'
import { reconcileApmSource } from '../../src/darkfactory/apm-reconciliation.ts'

const sentrySecret = 'stress-sentry-webhook-secret'
const sentryToken = 'stress-sentry-api-token'
const apmSecret = 'stress-apm-webhook-secret'
const apmToken = 'stress-apm-api-token'

function sentryIssuePayload(status = 'unresolved', baseTime = Date.now()) {
  return {
    action: status === 'resolved' ? 'resolved' : 'created',
    installation: { uuid: 'installation' },
    actor: { id: 'sender', type: 'user' },
    data: {
      issue: {
        id: '7',
        project: { id: '42', slug: 'service' },
        title: 'Sentry stress test issue',
        culprit: 'stress.service.run',
        status,
        lastSeen: new Date(baseTime - 30_000).toISOString(),
      },
    },
  }
}

function apmAlertPayload(action = 'triggered', baseTime = Date.now(), overrides?: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    action,
    senderId: 'sender',
    providerProjectId: 'service',
    environment: 'prod',
    ruleId: 'alert-rule',
    fingerprint: 'latency:p99',
    revision: 'rev-1',
    title: 'APM Latency Spike',
    context: 'Latency exceeds threshold',
    observationWindow: {
      start: new Date(baseTime - 120_000).toISOString(),
      end: new Date(baseTime - 30_000).toISOString(),
    },
    commit: null,
    release: null,
    metrics: [{ name: 'latency', value: 250, unit: 'ms' }],
    evidence: [],
    ...overrides,
  }
}

interface MockServerControl {
  sentryStatus: string
  apmAction: string
  rateLimit: boolean
  rateLimitHeaders?: Record<string, string>
  sentryTimestamps?: {
    firstSeen?: string
    lastSeen?: string
    dateCreated?: string
    dateReceived?: string
  }
  apmTimestamps?: {
    observedAt?: string
    windowStart?: string
    windowEnd?: string
  }
  injectSecret?: boolean
}

async function startMockProvider(control: MockServerControl): Promise<{
  server: Server
  port: number
  requests: string[]
  control: MockServerControl
}> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url!)
    if (control.rateLimit && requests.length === 1) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '60',
        ...(control.rateLimitHeaders ?? {}),
      })
      res.end(JSON.stringify({ detail: 'Rate limit exceeded' }))
      return
    }
    const now = Date.now()
    res.setHeader('content-type', 'application/json')

    if (req.url?.includes('/api/0/projects/')) {
      res.end(JSON.stringify({ id: '42', slug: 'service', organization: { id: '20', slug: 'acme' } }))
    } else if (req.url?.includes('/events/latest/')) {
      const dateCreated = control.sentryTimestamps?.dateCreated ?? new Date(now - 40_000).toISOString()
      const dateReceived = control.sentryTimestamps?.dateReceived ?? new Date(now - 30_000).toISOString()
      const title = control.injectSecret ? `Event with ${sentryToken}` : 'Sentry issue failure'
      res.end(JSON.stringify({
        eventID: 'a'.repeat(32),
        groupID: '7',
        title,
        dateCreated,
        dateReceived,
        tags: [{ key: 'environment', value: 'production' }],
        release: { version: control.injectSecret ? `rel-${sentrySecret}` : 'release-1' },
        entries: [{
          type: 'exception',
          data: {
            values: [{
              type: control.injectSecret ? `Error-${sentryToken}` : 'Error',
              value: control.injectSecret ? `Value-${sentrySecret}` : 'failure',
              stacktrace: {
                frames: [{
                  filename: control.injectSecret ? `/app/${sentryToken}/file.ts` : '/app/file.ts',
                  function: 'run',
                }],
              },
            }],
          },
        }],
      }))
    } else if (req.url?.includes('/api/0/organizations/acme/issues/7/')) {
      const firstSeen = control.sentryTimestamps?.firstSeen ?? new Date(now - 120_000).toISOString()
      const lastSeen = control.sentryTimestamps?.lastSeen ?? new Date(now - 30_000).toISOString()
      const title = control.injectSecret ? `Issue with ${sentryToken}` : 'Sentry stress test issue'
      res.end(JSON.stringify({
        id: '7',
        title,
        culprit: control.injectSecret ? `culprit-${sentrySecret}` : 'stress.service.run',
        status: control.sentryStatus,
        project: { id: '42', slug: 'service' },
        firstSeen,
        lastSeen,
      }))
    } else if (req.url?.includes('/darkfactory/v1/current/service/latency%3Ap99')) {
      const observedAt = control.apmTimestamps?.observedAt ?? new Date(now - 10_000).toISOString()
      const payload = apmAlertPayload(control.apmAction, now, {
        ...(control.injectSecret ? {
          title: `APM Alert with ${apmToken}`,
          context: `Context secret ${apmSecret}`,
        } : {}),
        ...(control.apmTimestamps?.windowStart || control.apmTimestamps?.windowEnd ? {
          observationWindow: {
            start: control.apmTimestamps?.windowStart ?? new Date(now - 120_000).toISOString(),
            end: control.apmTimestamps?.windowEnd ?? new Date(now - 30_000).toISOString(),
          },
        } : {}),
      })
      res.end(JSON.stringify({
        schemaVersion: 1,
        observedAt,
        payload,
      }))
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ detail: 'Not found' }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Mock server address invalid')
  return { server, port: addr.port, requests, control }
}

function buildSentryRoute(providerPort: number): IngressPolicyRoute {
  return {
    id: 'sentry-route',
    projectId: 'project',
    source: 'sentry',
    providerVersion: 'sentry-v1',
    signingKeyId: 'sentry-key',
    secretRef: { kind: 'env', name: 'DF_SENTRY_WEBHOOK_SECRET' },
    repositoryIds: ['42'],
    senderIds: ['sender'],
    ruleIds: ['rule'],
    bindings: {
      installationIds: ['installation'],
      organizationIds: ['20'],
      providerProjects: [{ id: '42', slug: 'service', organizationId: '20' }],
      environments: [{ providerEnvironment: 'production', environmentId: 'production' }],
      ruleMappings: [
        { ruleId: 'rule', automationLabel: 'automate', resource: 'issue', providerRule: null },
        { ruleId: 'rule', automationLabel: 'automate', resource: 'event_alert', providerRule: 'Production failures' },
        { ruleId: 'rule', automationLabel: 'automate', resource: 'metric_alert', providerRule: '99' },
      ],
    },
    reconciliation: {
      apiBaseUrl: `http://127.0.0.1:${providerPort}`,
      fixtureLoopback: true,
      publicSourceBaseUrl: 'https://sentry.io',
      installationId: 'installation',
      organizationId: '20',
      organizationSlug: 'acme',
      providerProjectId: '42',
      projectSlug: 'service',
      repositoryId: '42',
      repositoryName: 'owner/repo',
      sensorPrincipalId: 'host-sensor:sentry',
      productionEnvironmentId: 'production',
      credentialRef: { kind: 'env', name: 'DF_SENTRY_TOKEN' },
      credentialKind: 'api-token',
      maxAgeMs: 3600000,
    },
  }
}

function buildApmRoute(providerPort: number): IngressPolicyRoute {
  return {
    id: 'apm-route',
    projectId: 'project',
    source: 'apm',
    providerVersion: 'gasteam-v1',
    signingKeyId: 'apm-key',
    secretRef: { kind: 'env', name: 'DF_APM_WEBHOOK_SECRET' },
    repositoryIds: ['42'],
    senderIds: ['sender'],
    ruleIds: ['rule'],
    bindings: {
      providerProjectIds: ['service'],
      environments: [{ providerEnvironment: 'prod', environmentId: 'production' }],
      ruleMappings: [{ ruleId: 'rule', automationLabel: 'automate', providerRule: 'alert-rule' }],
    },
    reconciliation: {
      apiBaseUrl: `http://127.0.0.1:${providerPort}`,
      fixtureLoopback: true,
      publicSourceBaseUrl: 'https://apm.example.test',
      providerProjectId: 'service',
      senderId: 'sender',
      repositoryId: '42',
      repositoryName: 'owner/repo',
      sensorPrincipalId: 'host-sensor:apm',
      productionEnvironmentId: 'production',
      credentialRef: { kind: 'env', name: 'DF_APM_TOKEN' },
      credentialKind: 'api-token',
      maxAgeMs: 3600000,
    },
  }
}

async function postSentry(port: number, body: string, deliveryId: string, resource = 'issue', customSecret = sentrySecret): Promise<Response> {
  const sig = createHmac('sha256', customSecret).update(body).digest('hex')
  return fetch(`http://127.0.0.1:${port}/darkfactory/v1/ingress/sentry/sentry-route`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'request-id': deliveryId,
      'sentry-hook-resource': resource,
      'sentry-hook-timestamp': String(Math.floor(Date.now() / 1000)),
      'sentry-hook-signature': sig,
    },
    body,
  })
}

async function postApm(port: number, body: string, deliveryId: string, customSecret = apmSecret, customTimestamp?: string): Promise<Response> {
  const timestamp = customTimestamp ?? String(Math.floor(Date.now() / 1000))
  const bodyDigest = digestBytes(Buffer.from(body))
  const path = '/darkfactory/v1/ingress/apm/apm-route'
  const signed = genericIngressSigningInput({
    method: 'POST',
    path,
    keyId: 'apm-key',
    deliveryId,
    timestamp,
    bodyDigest,
  })
  const sig = createHmac('sha256', customSecret).update(signed).digest('hex')
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [GENERIC_INGRESS_HEADERS.keyId]: 'apm-key',
      [GENERIC_INGRESS_HEADERS.deliveryId]: deliveryId,
      [GENERIC_INGRESS_HEADERS.timestamp]: timestamp,
      [GENERIC_INGRESS_HEADERS.signature]: `sha256=${sig}`,
    },
    body,
  })
}

describe('Empirical Adversarial Stress Harness for Milestone 1', () => {
  it('Webhook Verification: rejects forged HMAC, drifted timestamps, and malformed bodies without crashing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stress-ingress-'))
    const envBackup = { ...process.env }
    process.env.DF_SENTRY_WEBHOOK_SECRET = sentrySecret
    process.env.DF_SENTRY_TOKEN = sentryToken
    process.env.DF_APM_WEBHOOK_SECRET = apmSecret
    process.env.DF_APM_TOKEN = apmToken

    const provider = await startMockProvider({ sentryStatus: 'unresolved', apmAction: 'triggered', rateLimit: false })
    let observer: DarkFactoryObserver | undefined, health: HealthStore | undefined

    try {
      await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
      await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)

      const basePolicy = enabledPolicy()
      basePolicy.limits.maxArtifactBytes = 65536
      basePolicy.limits.maxJournalRecordBytes = 1_048_576
      basePolicy.limits.maxJournalBytes = 16_777_216
      basePolicy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
      basePolicy.ingestion.routes = [buildSentryRoute(provider.port), buildApmRoute(provider.port)]

      health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
      observer = await DarkFactoryObserver.open(directory, enabledDarkFactoryConfigSchema.parse(basePolicy), (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs), [{ id: 'project', repository: directory }])

      const port = observer.status().port

      // 1. Sentry forged secret
      const sentryBadSig = await postSentry(port, JSON.stringify(sentryIssuePayload()), 'del-bad-1', 'issue', 'wrong-secret')
      expect(sentryBadSig.status).toBe(401)

      // 2. Sentry missing signature
      const sentryNoSig = await fetch(`http://127.0.0.1:${port}/darkfactory/v1/ingress/sentry/sentry-route`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'request-id': 'del-nosig',
          'sentry-hook-resource': 'issue',
          'sentry-hook-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify(sentryIssuePayload()),
      })
      expect(sentryNoSig.status).toBe(401)

      // 3. APM forged signature
      const apmBadSig = await postApm(port, JSON.stringify(apmAlertPayload()), 'del-apm-bad', 'wrong-apm-secret')
      expect(apmBadSig.status).toBe(401)

      // 4. APM timestamp drifted 10 minutes into the past (replay attack simulation)
      const driftedTime = String(Math.floor(Date.now() / 1000) - 600)
      const apmDrifted = await postApm(port, JSON.stringify(apmAlertPayload()), 'del-apm-drift', apmSecret, driftedTime)
      expect(apmDrifted.status).toBe(401)

      // 5. Malformed JSON payload with valid HMAC is authenticated, accepted (202), and quarantined as PAYLOAD_INVALID
      const malformedJson = '{ invalid json'
      const sig = createHmac('sha256', sentrySecret).update(malformedJson).digest('hex')
      const sentryMalformed = await fetch(`http://127.0.0.1:${port}/darkfactory/v1/ingress/sentry/sentry-route`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'request-id': 'del-malformed',
          'sentry-hook-resource': 'issue',
          'sentry-hook-timestamp': String(Math.floor(Date.now() / 1000)),
          'sentry-hook-signature': sig,
        },
        body: malformedJson,
      })
      expect(sentryMalformed.status).toBe(202)
      const malformedOutcome = await sentryMalformed.json() as { receipt?: { decision?: string } }
      expect(malformedOutcome.receipt?.decision).toBe('quarantined')

      // 6. Schema invalid payload (missing project.slug) -> authenticated but quarantined with PAYLOAD_INVALID
      const missingSlugPayload = {
        action: 'created',
        installation: { uuid: 'installation' },
        actor: { id: 'sender', type: 'user' },
        data: {
          issue: {
            id: '7',
            project: { id: '42' }, // missing slug!
            title: 'Sentry issue without slug',
            culprit: 'service.run',
            status: 'unresolved',
            lastSeen: new Date().toISOString(),
          },
        },
      }
      const sentryMissingSlug = await postSentry(port, JSON.stringify(missingSlugPayload), 'del-miss-slug')
      expect(sentryMissingSlug.status).toBe(202)
      const slugOutcome = await sentryMissingSlug.json() as { receipt?: { decision?: string } }
      expect(slugOutcome.receipt?.decision).toBe('quarantined')

      // 7. Method unsupported (GET instead of POST)
      const getReq = await fetch(`http://127.0.0.1:${port}/darkfactory/v1/ingress/sentry/sentry-route`, {
        method: 'GET',
      })
      expect(getReq.status).toBe(405)

      // 8. Body exceeding maxBodyBytes (basePolicy has maxBodyBytes: 1000 by default from config fixture!)
      const hugeBody = JSON.stringify({ padding: 'x'.repeat(2000) })
      const hugeSig = createHmac('sha256', sentrySecret).update(hugeBody).digest('hex')
      const hugeReq = await fetch(`http://127.0.0.1:${port}/darkfactory/v1/ingress/sentry/sentry-route`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'request-id': 'del-huge',
          'sentry-hook-resource': 'issue',
          'sentry-hook-timestamp': String(Math.floor(Date.now() / 1000)),
          'sentry-hook-signature': hugeSig,
        },
        body: hugeBody,
      })
      expect(hugeReq.status).toBe(413)

      // 9. Route unregistered
      const unregistered = await fetch(`http://127.0.0.1:${port}/darkfactory/v1/ingress/sentry/unknown-route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(unregistered.status).toBe(404)

      // 10. Invariant: ZERO tasks created under any adversarial input
      expect(existsSync(join(directory, 'tasks.jsonl'))).toBe(false)
      expect(existsSync(join(directory, 'workflows.jsonl'))).toBe(false)
    } finally {
      await observer?.close(); await health?.close()
      await new Promise<void>((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()))
      process.env = envBackup
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('Freshness Evaluation: Sentry & APM readers reject stale and future timestamps', async () => {
    const route = buildSentryRoute(8000)
    const registration = route.reconciliation!
    const lookup = {
      kind: 'sentry_issue' as const,
      resource: 'issue' as const,
      sourceEntityId: 'sentry-issue:42:7',
      providerEntityId: '7',
      installationId: 'installation',
      actorId: 'sender',
      providerProjectIds: ['42'],
      organizationId: '20',
      providerRule: null,
      eventId: null,
    }

    const hostNow = new Date('2026-09-06T12:00:00.000Z')

    // Sentry: lastSeen in future relative to checkedAt
    const futureResult = await reconcileSentrySource({
      registration,
      route,
      observed: lookup,
      projectId: 'project',
      policyRevision: 1,
      secret: sentryToken,
      now: () => hostNow,
      redactText: t => t,
      transport: async (url: string | URL | Request) => {
        const u = String(url)
        if (u.includes('/api/0/projects/')) {
          return new Response(JSON.stringify({ id: '42', slug: 'service', organization: { id: '20', slug: 'acme' } }), { headers: { 'content-type': 'application/json' } })
        }
        if (u.includes('/issues/7/')) {
          return new Response(JSON.stringify({
            id: '7',
            title: 'Future Issue',
            status: 'unresolved',
            project: { id: '42', slug: 'service' },
            firstSeen: '2026-09-06T11:00:00.000Z',
            lastSeen: '2026-09-06T13:00:00.000Z', // 1 hour in the FUTURE!
          }), { headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })
    expect(futureResult.decision).toBe('unresolved')
    expect(futureResult.diagnosticCode).toBe('SENTRY_TIMESTAMP_INVALID')

    // Sentry: Event older than maxAgeMs (maxAgeMs = 3600000 = 1 hour)
    const staleResult = await reconcileSentrySource({
      registration,
      route,
      observed: lookup,
      projectId: 'project',
      policyRevision: 1,
      secret: sentryToken,
      now: () => hostNow,
      redactText: t => t,
      transport: async (url: string | URL | Request) => {
        const u = String(url)
        if (u.includes('/api/0/projects/')) {
          return new Response(JSON.stringify({ id: '42', slug: 'service', organization: { id: '20', slug: 'acme' } }), { headers: { 'content-type': 'application/json' } })
        }
        if (u.includes('/issues/7/events/')) {
          return new Response(JSON.stringify({
            eventID: 'b'.repeat(32),
            groupID: '7',
            title: 'Stale Event',
            dateCreated: '2026-09-06T10:00:00.000Z', // 2 hours old!
            dateReceived: '2026-09-06T10:00:00.000Z',
            tags: [{ key: 'environment', value: 'production' }],
            entries: [],
          }), { headers: { 'content-type': 'application/json' } })
        }
        if (u.includes('/issues/7/')) {
          return new Response(JSON.stringify({
            id: '7',
            title: 'Issue with stale event',
            status: 'unresolved',
            project: { id: '42', slug: 'service' },
            firstSeen: '2026-09-06T10:00:00.000Z',
            lastSeen: '2026-09-06T11:59:00.000Z',
          }), { headers: { 'content-type': 'application/json' } })
        }
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })
    expect(staleResult.decision).toBe('denied')
    expect(staleResult.diagnosticCode).toBe('SENTRY_EVENT_STALE')

    // APM Freshness: observedAt in future relative to checkedAt
    const apmRoute = buildApmRoute(8000)
    const apmReg = apmRoute.reconciliation!
    const apmLookup = {
      kind: 'apm' as const,
      sourceEntityId: `apm:${digestJson(['sender', 'service', 'latency:p99']).slice(7)}`,
      providerEntityId: 'latency:p99',
      fingerprint: 'latency:p99',
      actorId: 'sender',
      providerProjectId: 'service',
      providerRule: 'alert-rule',
    }

    const apmFuture = await reconcileApmSource({
      registration: apmReg,
      route: apmRoute,
      observed: apmLookup,
      projectId: 'project',
      policyRevision: 1,
      secret: apmToken,
      now: () => hostNow,
      redactText: t => t,
      transport: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        observedAt: '2026-09-06T13:00:00.000Z', // In FUTURE
        payload: apmAlertPayload('triggered', hostNow.getTime()),
      }), { headers: { 'content-type': 'application/json' } }),
    })
    expect(apmFuture.decision).toBe('unresolved')
    expect(apmFuture.diagnosticCode).toBe('APM_RESPONSE_FUTURE')

    // APM Freshness: observedAt older than maxAgeMs (1 hour)
    const apmStale = await reconcileApmSource({
      registration: apmReg,
      route: apmRoute,
      observed: apmLookup,
      projectId: 'project',
      policyRevision: 1,
      secret: apmToken,
      now: () => hostNow,
      redactText: t => t,
      transport: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        observedAt: '2026-09-06T10:00:00.000Z', // 2 hours old!
        payload: apmAlertPayload('triggered', new Date('2026-09-06T10:00:00.000Z').getTime()),
      }), { headers: { 'content-type': 'application/json' } }),
    })
    expect(apmStale.decision).toBe('unresolved')
    expect(apmStale.diagnosticCode).toBe('APM_RESPONSE_STALE')
  })

  it('Sentry Metric Alerts: resolves cleanly to SENTRY_METRIC_API_UNSUPPORTED with ZERO provider HTTP requests', async () => {
    const route = buildSentryRoute(8000)
    const registration = route.reconciliation!
    const metricLookup = {
      kind: 'sentry_metric' as const,
      resource: 'metric_alert' as const,
      sourceEntityId: 'sentry-metric:20:service',
      providerEntityId: 'service',
      installationId: 'installation',
      actorId: 'sender',
      providerProjectIds: ['service'],
      organizationId: '20',
      providerRule: '99',
      eventId: null,
    }

    let httpRequestsMade = 0
    const result = await reconcileSentrySource({
      registration,
      route,
      observed: metricLookup,
      projectId: 'project',
      policyRevision: 1,
      secret: sentryToken,
      redactText: t => t,
      transport: async () => {
        httpRequestsMade++
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })

    expect(result.decision).toBe('unresolved')
    expect(result.diagnosticCode).toBe('SENTRY_METRIC_API_UNSUPPORTED')
    expect(result.reasons).toContain('PROVIDER_UNAVAILABLE')
    expect(httpRequestsMade).toBe(0) // Exactly ZERO HTTP requests made!
    expect(result.requestsUsed).toBe(0)
  })

  it('Rate Limiting & Backoff: DarkFactoryProviderRequestStore triggers exponential cooldown and denies access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stress-provider-request-store-'))
    try {
      const budget = await DarkFactoryProviderRequestStore.open(directory, {
        routes: [{ projectId: 'project', routeId: 'apm-route' }],
        requestsPerMinute: 5,
      })

      const now = new Date('2026-09-06T12:00:00.000Z')
      const at = now.toISOString()
      const until = new Date(now.getTime() + 120_000).toISOString() // 2 minutes cooldown

      // 1. Record block
      const block = await budget.block({
        at,
        until,
        reason: 'PROVIDER_RATE_LIMITED',
        expectedRevision: 0,
      })
      expect(block.reason).toBe('PROVIDER_RATE_LIMITED')
      expect(block.until).toBe(until)

      // 2. Availability should be 0 during cooldown
      const avail = budget.availability(at)
      expect(avail.available).toBe(0)
      expect(avail.nextAttemptAt).toBe(until)

      // 3. Reserve should throw ProviderRequestDeniedError('COOLDOWN')
      await expect(budget.reserve({
        projectId: 'project',
        routeId: 'apm-route',
        at,
        expectedRevision: budget.snapshot().revision,
      })).rejects.toThrow(ProviderRequestDeniedError)

      // 4. Advance time past cooldown
      const futureAt = new Date(now.getTime() + 125_000).toISOString()
      const futureAvail = budget.availability(futureAt)
      expect(futureAvail.available).toBe(5)

      // 5. Reserve up to requestsPerMinute limit (5)
      let rev = budget.snapshot().revision
      for (let i = 0; i < 5; i++) {
        await budget.reserve({
          projectId: 'project',
          routeId: 'apm-route',
          at: new Date(now.getTime() + 125_000 + i * 1000).toISOString(),
          expectedRevision: rev++,
        })
      }

      // 6. 6th reserve within the minute must fail with RATE_LIMITED
      await expect(budget.reserve({
        projectId: 'project',
        routeId: 'apm-route',
        at: new Date(now.getTime() + 130_000).toISOString(),
        expectedRevision: rev,
      })).rejects.toThrow(ProviderRequestDeniedError)

      await budget.close()

      // 7. Verify journal replay persistence
      const reopened = await DarkFactoryProviderRequestStore.open(directory, {
        routes: [{ projectId: 'project', routeId: 'apm-route' }],
        requestsPerMinute: 5,
      })
      expect(reopened.snapshot().blocks).toHaveLength(1)
      expect(reopened.snapshot().charges).toHaveLength(5)
      await reopened.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('Authority Pauses: Paused policy prevents access, aborts provider GETs, and logs critical escalation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stress-authority-pause-'))
    const envBackup = { ...process.env }
    process.env.DF_SENTRY_WEBHOOK_SECRET = sentrySecret
    process.env.DF_SENTRY_TOKEN = sentryToken
    process.env.DF_APM_WEBHOOK_SECRET = apmSecret
    process.env.DF_APM_TOKEN = apmToken

    let providerCalls = 0
    const provider = createServer((_, res) => {
      providerCalls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const providerPort = (provider.address() as { port: number }).port

    let health: HealthStore | undefined
    try {
      await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
      await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)

      const basePolicy = enabledPolicy()
      basePolicy.limits.maxArtifactBytes = 65536
      basePolicy.limits.maxJournalRecordBytes = 1_048_576
      basePolicy.limits.maxJournalBytes = 16_777_216
      basePolicy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
      basePolicy.ingestion.routes = [buildSentryRoute(providerPort), buildApmRoute(providerPort)]

      const digest = digestJson(basePolicy)
      const authorizationRef = `configuration-${digest.slice(7)}`

      // 1. Pre-configure authority with policy and gate, but PAUSE it
      const authority = await DarkFactoryPolicyStore.open(directory, {
        grants: [{ projectId: 'project', operatorIds: ['operator'], authorizationRefs: [authorizationRef] }],
        effectGrants: [{ projectId: 'project', effect: 'ingress', authorizationRef }],
        implementedEffects: ['ingress'],
      })
      try {
        await authority.installPolicy({
          projectId: 'project',
          expectedRevision: 0,
          operatorId: 'operator',
          authorizationRef,
          policy: basePolicy,
        })
        await authority.recordGate({
          projectId: 'project',
          expectedRevision: 1,
          operatorId: 'operator',
          authorizationRef,
          policyRevision: 1,
          gate: 'observe',
          evidenceRefs: [authorizationRef],
        })
        // PAUSE the project authority:
        await authority.control({
          projectId: 'project',
          expectedRevision: 2,
          operatorId: 'operator',
          authorizationRef,
          action: 'pause',
          reason: 'manual',
        })
      } finally {
        await authority.close()
      }

      // 2. Now attempt to open DarkFactoryObserver
      health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
      await expect(
        DarkFactoryObserver.open(
          directory,
          enabledDarkFactoryConfigSchema.parse(basePolicy),
          (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs),
          [{ id: 'project', repository: directory }],
        )
      ).rejects.toThrow('Ingress authority is paused or revoked')

      // 3. Confirm critical escalation was raised in HealthStore
      const escalations = health.listEscalations()
      expect(escalations.length).toBeGreaterThanOrEqual(1)
      expect(escalations[0]!.reason).toBe('AUTHORITY_DENIED')
      expect(escalations[0]!.severity).toBe('critical')

      // 4. Exactly ZERO provider calls were made
      expect(providerCalls).toBe(0)
      // 5. Invariant: ZERO tasks created
      expect(existsSync(join(directory, 'tasks.jsonl'))).toBe(false)
    } finally {
      await health?.close()
      await new Promise<void>((resolve, reject) => provider.close(err => err ? reject(err) : resolve()))
      process.env = envBackup
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('Secret Redaction: Reconciled artifacts and journals strictly redact provider secrets and tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stress-redaction-'))
    const envBackup = { ...process.env }
    const secretMarker1 = 'SENTRY_SUPER_SECRET_TOKEN_999'
    const secretMarker2 = 'APM_SUPER_SECRET_TOKEN_888'
    process.env.DF_SENTRY_WEBHOOK_SECRET = secretMarker1
    process.env.DF_SENTRY_TOKEN = secretMarker1
    process.env.DF_APM_WEBHOOK_SECRET = secretMarker2
    process.env.DF_APM_TOKEN = secretMarker2

    const provider = await startMockProvider({
      sentryStatus: 'unresolved',
      apmAction: 'triggered',
      rateLimit: false,
      injectSecret: true, // Injects secrets into issue title, culprit, frames, etc.
    })

    let observer: DarkFactoryObserver | undefined, health: HealthStore | undefined

    try {
      await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
      await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)

      const basePolicy = enabledPolicy()
      basePolicy.limits.maxArtifactBytes = 65536
      basePolicy.limits.maxJournalRecordBytes = 1_048_576
      basePolicy.limits.maxJournalBytes = 16_777_216
      basePolicy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
      basePolicy.ingestion.routes = [buildSentryRoute(provider.port), buildApmRoute(provider.port)]

      health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
      observer = await DarkFactoryObserver.open(
        directory,
        enabledDarkFactoryConfigSchema.parse(basePolicy),
        (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs),
        [{ id: 'project', repository: directory }],
      )

      // Post Sentry and APM
      const sentryReceipt = await postSentry(observer.status().port, JSON.stringify(sentryIssuePayload()), 'del-redact-1', 'issue', secretMarker1)
      expect(sentryReceipt.status).toBe(202)

      const apmReceipt = await postApm(observer.status().port, JSON.stringify(apmAlertPayload()), 'del-redact-2', secretMarker2)
      expect(apmReceipt.status).toBe(202)

      // Wait for items to reconcile
      const journalPath = join(directory, 'darkfactory/project/ingestion.jsonl')
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        if (existsSync(journalPath)) {
          const text = await readFile(journalPath, 'utf8')
          if (text.includes('sentry-issue:42:7') && text.includes('CURRENT_PROVIDER_EVIDENCE_VERIFIED') &&
              text.includes('apm:') && (text.match(/CURRENT_PROVIDER_EVIDENCE_VERIFIED/g) ?? []).length >= 2) {
            break
          }
        }
        await new Promise(resolve => setTimeout(resolve, 30))
      }

      await observer.close(); observer = undefined

      // Search every single file in the entire directory for secretMarker1 or secretMarker2
      async function scanDirectory(dir: string): Promise<string[]> {
        const found: string[] = []
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name !== '.git') found.push(...await scanDirectory(full))
          } else if (entry.isFile()) {
            const content = await readFile(full, 'utf8')
            if (content.includes(secretMarker1)) found.push(`Leaked secretMarker1 in ${full}`)
            if (content.includes(secretMarker2)) found.push(`Leaked secretMarker2 in ${full}`)
          }
        }
        return found
      }

      const leaks = await scanDirectory(directory)
      expect(leaks).toEqual([])
    } finally {
      await observer?.close(); await health?.close()
      await new Promise<void>((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()))
      process.env = envBackup
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('APM Revocation: Revokes prior active APM work upon resolved webhook and escalates to health inbox', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stress-apm-revocation-'))
    const envBackup = { ...process.env }
    process.env.DF_APM_WEBHOOK_SECRET = apmSecret
    process.env.DF_APM_TOKEN = apmToken

    const provider = await startMockProvider({ apmAction: 'triggered', sentryStatus: 'unresolved', rateLimit: false })
    let observer: DarkFactoryObserver | undefined, health: HealthStore | undefined, restored: DarkFactoryIngestionStore | undefined

    try {
      await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
      await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)

      const basePolicy = enabledPolicy()
      basePolicy.limits.maxArtifactBytes = 65536
      basePolicy.limits.maxJournalRecordBytes = 1_048_576
      basePolicy.limits.maxJournalBytes = 16_777_216
      basePolicy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
      basePolicy.ingestion.routes = [buildApmRoute(provider.port)]

      health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
      observer = await DarkFactoryObserver.open(directory, enabledDarkFactoryConfigSchema.parse(basePolicy), (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs), [{ id: 'project', repository: directory }])

      // Step 1: Ingest active APM alert
      const openReceipt = await postApm(observer.status().port, JSON.stringify(apmAlertPayload('triggered')), 'apm-del-1')
      expect(openReceipt.status).toBe(202)

      const journalPath = join(directory, 'darkfactory/project/ingestion.jsonl')
      let deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (existsSync(journalPath) && (await readFile(journalPath, 'utf8')).includes('CURRENT_PROVIDER_EVIDENCE_VERIFIED')) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }

      // Step 2: Switch mock provider to return resolved, and post resolved webhook
      provider.control.apmAction = 'resolved'
      const resolvedReceipt = await postApm(observer.status().port, JSON.stringify(apmAlertPayload('resolved')), 'apm-del-2')
      expect(resolvedReceipt.status).toBe(202)

      // Step 3: Wait for invalidation to quarantine prior work
      deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const text = await readFile(journalPath, 'utf8')
        if (text.includes('APM_RESOLVED')) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }

      await observer.close(); observer = undefined

      restored = await DarkFactoryIngestionStore.open(directory, {
        projectId: 'project',
        maxBodyBytes: basePolicy.ingestion.maxBodyBytes,
        maxQueueItems: basePolicy.ingestion.maxQueueItems,
        maxRecordBytes: basePolicy.limits.maxJournalRecordBytes,
        maxJournalBytes: basePolicy.limits.maxJournalBytes,
      })

      const items = restored.snapshot().items
      const originalItem = items.find(item => item.source === 'apm')!
      expect(originalItem.state).toBe('quarantined')
      expect(originalItem.trust.decision).toBe('revoked')
      expect(originalItem.trust.reasons).toContain('APM_RESOLVED')

      const escalations = health.listEscalations()
      expect(escalations.some(esc => esc.reason === 'SOURCE_DENIED')).toBe(true)
      expect(existsSync(join(directory, 'tasks.jsonl'))).toBe(false)
    } finally {
      await observer?.close(); await restored?.close(); await health?.close()
      await new Promise<void>((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()))
      process.env = envBackup
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('Rate Limiting & Backoff: Enforces 5-minute exponential backoff floor over shorter provider retry-after', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stress-rate-limit-floor-'))
    const envBackup = { ...process.env }
    process.env.DF_APM_WEBHOOK_SECRET = apmSecret
    process.env.DF_APM_TOKEN = apmToken

    // Provider specifies retry-after of only 10 seconds
    const provider = await startMockProvider({
      rateLimit: true,
      rateLimitHeaders: { 'retry-after': '10' },
      apmAction: 'triggered',
      sentryStatus: 'unresolved',
    })
    let observer: DarkFactoryObserver | undefined, health: HealthStore | undefined

    try {
      await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
      await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)

      const basePolicy = enabledPolicy()
      basePolicy.limits.maxArtifactBytes = 65536
      basePolicy.limits.maxJournalRecordBytes = 1_048_576
      basePolicy.limits.maxJournalBytes = 16_777_216
      basePolicy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
      basePolicy.ingestion.routes = [buildApmRoute(provider.port)]

      health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
      const startTime = Date.now()
      observer = await DarkFactoryObserver.open(directory, enabledDarkFactoryConfigSchema.parse(basePolicy), (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs), [{ id: 'project', repository: directory }])

      await postApm(observer.status().port, JSON.stringify(apmAlertPayload()), 'apm-rate-del-1')

      // Wait for block to be recorded in darkfactory-provider-requests.jsonl
      const budgetPath = join(directory, 'darkfactory-provider-requests.jsonl')
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (existsSync(budgetPath) && (await readFile(budgetPath, 'utf8')).includes('PROVIDER_RATE_LIMITED')) break
        await new Promise(resolve => setTimeout(resolve, 30))
      }

      const budgetLines = (await readFile(budgetPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
      const blockEvent = budgetLines.find(e => e.type === 'provider-requests-blocked')
      expect(blockEvent).toBeDefined()
      expect(blockEvent.request.reason).toBe('PROVIDER_RATE_LIMITED')

      // The until timestamp must be at least startTime + 300_000ms (5 minutes), NOT startTime + 10s
      const untilMs = Date.parse(blockEvent.request.until)
      expect(untilMs).toBeGreaterThanOrEqual(startTime + 299_000) // 5 minutes backoff enforced!

      await observer.close(); observer = undefined
      expect(existsSync(join(directory, 'tasks.jsonl'))).toBe(false)
    } finally {
      await observer?.close(); await health?.close()
      await new Promise<void>((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()))
      process.env = envBackup
      await rm(directory, { recursive: true, force: true })
    }
  })
})
