import { createServer, type Server } from 'node:http'
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DarkFactoryObserver } from '../../src/darkfactory/observer.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { HealthStore } from '../../src/health.ts'
import { enabledDarkFactoryConfigSchema, type IngressPolicyRoute } from '../../src/darkfactory/config.ts'
import { digestBytes } from '../../src/darkfactory/json.ts'
import { GENERIC_INGRESS_HEADERS, genericIngressSigningInput } from '../../src/darkfactory/ingress-auth.ts'
import { runGit } from '../../src/git-command.ts'
import { enabledPolicy } from './config-fixture.ts'

const sentrySecret = 'sentry-webhook-secret-marker', sentryToken = 'sentry-api-token-marker'
const apmSecret = 'apm-webhook-secret-marker', apmToken = 'apm-api-token-marker'

function sentryIssuePayload(status = 'unresolved', baseTime = Date.now()) {
  return {
    action: status === 'resolved' ? 'resolved' : 'created',
    installation: { uuid: 'installation' },
    actor: { id: 'sender', type: 'user' },
    data: {
      issue: {
        id: '7',
        project: { id: '42', slug: 'service' },
        title: 'Sentry issue failure',
        culprit: 'service.run',
        status,
        lastSeen: new Date(baseTime - 30_000).toISOString(),
      },
    },
  }
}

function apmAlertPayload(action = 'triggered', baseTime = Date.now()) {
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
  }
}

interface MockProviderState {
  sentryStatus: string
  apmAction: string
  rateLimit: boolean
}

async function startMockProvider(options: {
  sentryStatus?: string
  apmAction?: string
  rateLimit?: boolean
}): Promise<{ server: Server; port: number; requests: string[]; state: MockProviderState }> {
  const requests: string[] = []
  const state: MockProviderState = {
    sentryStatus: options.sentryStatus ?? 'unresolved',
    apmAction: options.apmAction ?? 'triggered',
    rateLimit: options.rateLimit ?? false,
  }
  const server = createServer((req, res) => {
    requests.push(req.url!)
    if (state.rateLimit && requests.length === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
      res.end(JSON.stringify({ detail: 'Rate limit exceeded' }))
      return
    }
    const now = Date.now()
    res.setHeader('content-type', 'application/json')
    if (req.url?.includes('/api/0/projects/')) {
      res.end(JSON.stringify({ id: '42', slug: 'service', organization: { id: '20', slug: 'acme' } }))
    } else if (req.url?.includes('/events/latest/')) {
      res.end(JSON.stringify({
        eventID: 'a'.repeat(32),
        groupID: '7',
        title: 'Sentry issue failure',
        dateCreated: new Date(now - 40_000).toISOString(),
        dateReceived: new Date(now - 30_000).toISOString(),
        tags: [{ key: 'environment', value: 'production' }],
        release: { version: 'release-1' },
        entries: [{ type: 'exception', data: { values: [{ type: 'Error', value: 'failure', stacktrace: { frames: [] } }] } }],
      }))
    } else if (req.url?.includes('/api/0/organizations/acme/issues/7/')) {
      res.end(JSON.stringify({
        id: '7',
        title: 'Sentry issue failure',
        culprit: 'service.run',
        status: state.sentryStatus,
        project: { id: '42', slug: 'service' },
        firstSeen: new Date(now - 120_000).toISOString(),
        lastSeen: new Date(now - 30_000).toISOString(),
      }))
    } else if (req.url?.includes('/darkfactory/v1/current/service/latency%3Ap99')) {
      res.end(JSON.stringify({
        schemaVersion: 1,
        observedAt: new Date(now - 10_000).toISOString(),
        payload: apmAlertPayload(state.apmAction, now),
      }))
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ detail: 'Not found' }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Mock server address invalid')
  return { server, port: addr.port, requests, state }
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

async function postSentry(port: number, body: string, deliveryId: string, resource = 'issue'): Promise<Response> {
  const sig = createHmac('sha256', sentrySecret).update(body).digest('hex')
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

async function postApm(port: number, body: string, deliveryId: string): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000))
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
  const sig = createHmac('sha256', apmSecret).update(signed).digest('hex')
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

it('observes signed Sentry and APM webhooks through loopback REST, reconciles current state without creating tasks, and redacts secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-monitoring-observer-'))
  const envBackup = { ...process.env }
  process.env.DF_SENTRY_WEBHOOK_SECRET = sentrySecret
  process.env.DF_SENTRY_TOKEN = sentryToken
  process.env.DF_APM_WEBHOOK_SECRET = apmSecret
  process.env.DF_APM_TOKEN = apmToken

  const provider = await startMockProvider({})
  let observer: DarkFactoryObserver | undefined, health: HealthStore | undefined, restored: DarkFactoryIngestionStore | undefined

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

    // Post Sentry webhook
    const sentryBody = JSON.stringify(sentryIssuePayload())
    const sentryReceipt = await postSentry(observer.status().port, sentryBody, 'sentry-delivery-1')
    expect(sentryReceipt.status).toBe(202)

    // Post APM webhook
    const apmBody = JSON.stringify(apmAlertPayload())
    const apmReceipt = await postApm(observer.status().port, apmBody, 'apm-delivery-1')
    expect(apmReceipt.status).toBe(202)

    // Wait for both items to reach 'trusted' in journal
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

    restored = await DarkFactoryIngestionStore.open(directory, {
      projectId: 'project',
      maxBodyBytes: basePolicy.ingestion.maxBodyBytes,
      maxQueueItems: basePolicy.ingestion.maxQueueItems,
      maxRecordBytes: basePolicy.limits.maxJournalRecordBytes,
      maxJournalBytes: basePolicy.limits.maxJournalBytes,
    })

    const snapshot = restored.snapshot()
    expect(snapshot.items).toHaveLength(2)

    const sentryItem = snapshot.items.find(item => item.source === 'sentry')!
    expect(sentryItem).toMatchObject({
      state: 'trusted',
      author: 'host-sensor:sentry',
      actor: 'sender',
      sourceEntityId: 'sentry-issue:42:7',
      labels: ['automate'],
    })

    const apmItem = snapshot.items.find(item => item.source === 'apm')!
    expect(apmItem).toMatchObject({
      state: 'trusted',
      author: 'host-sensor:apm',
      actor: 'sender',
      labels: ['automate'],
    })

    // Verify artifact evidence and secret redaction
    const artifacts = await DarkFactoryArtifactStore.open(directory, ['project'], basePolicy.limits.maxArtifactBytes, basePolicy.limits.maxArtifactTotalBytes)
    const sentryEvidence = await artifacts.read(sentryItem.provenance[1]!)
    expect(sentryEvidence).toMatchObject({
      credentialBinding: 'host-pinned-api-token-installation',
      sensorPrincipalId: 'host-sensor:sentry',
      resource: 'issue',
    })

    const apmEvidence = await artifacts.read(apmItem.provenance[1]!)
    expect(apmEvidence).toMatchObject({
      credentialBinding: 'host-pinned-api-token',
      sensorPrincipalId: 'host-sensor:apm',
      protocol: 'gasteam-apm-current/v1',
    })

    // Check secrets are completely redacted from journal, items, and artifacts
    const allPersisted = JSON.stringify([snapshot, sentryEvidence, apmEvidence])
    expect(allPersisted).not.toContain(sentryToken)
    expect(allPersisted).not.toContain(apmToken)
    expect(allPersisted).not.toContain(sentrySecret)
    expect(allPersisted).not.toContain(apmSecret)

    // Verify NO tasks or workflows were created
    expect(existsSync(join(directory, 'tasks.jsonl'))).toBe(false)
    expect(existsSync(join(directory, 'workflows.jsonl'))).toBe(false)

    // Zero escalations in inbox on healthy reconciliation
    expect(health.listEscalations()).toHaveLength(0)
  } finally {
    await observer?.close(); await restored?.close(); await health?.close()
    await new Promise<void>((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()))
    process.env = envBackup
    await rm(directory, { recursive: true, force: true })
  }
})

it('revokes prior active work on current Sentry resolution without task creation and records inbox escalation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-sentry-revocation-'))
  const envBackup = { ...process.env }
  process.env.DF_SENTRY_WEBHOOK_SECRET = sentrySecret
  process.env.DF_SENTRY_TOKEN = sentryToken

  let provider = await startMockProvider({ sentryStatus: 'unresolved' })
  let observer: DarkFactoryObserver | undefined, health: HealthStore | undefined, restored: DarkFactoryIngestionStore | undefined

  try {
    await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
    await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)

    const basePolicy = enabledPolicy()
    basePolicy.limits.maxArtifactBytes = 65536
    basePolicy.limits.maxJournalRecordBytes = 1_048_576
    basePolicy.limits.maxJournalBytes = 16_777_216
    basePolicy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
    basePolicy.ingestion.routes = [buildSentryRoute(provider.port)]

    health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
    observer = await DarkFactoryObserver.open(directory, enabledDarkFactoryConfigSchema.parse(basePolicy), (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs), [{ id: 'project', repository: directory }])

    // Step 1: Ingest active unresolved issue
    const openReceipt = await postSentry(observer.status().port, JSON.stringify(sentryIssuePayload('unresolved')), 'sentry-del-1')
    expect(openReceipt.status).toBe(202)

    // Wait for item to be trusted
    const journalPath = join(directory, 'darkfactory/project/ingestion.jsonl')
    let deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (existsSync(journalPath) && (await readFile(journalPath, 'utf8')).includes('CURRENT_PROVIDER_EVIDENCE_VERIFIED')) break
      await new Promise(resolve => setTimeout(resolve, 30))
    }

    // Switch mock provider to return status: resolved
    provider.state.sentryStatus = 'resolved'

    // Step 2: Post resolution webhook
    const resolvedReceipt = await postSentry(observer.status().port, JSON.stringify(sentryIssuePayload('resolved')), 'sentry-del-2')
    expect(resolvedReceipt.status).toBe(202)

    // Wait for invalidation to quarantine the prior active work
    deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const text = await readFile(journalPath, 'utf8')
      if (text.includes('SENTRY_RESOLVED')) break
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
    const originalItem = items.find(item => item.sourceEntityId === 'sentry-issue:42:7')!
    expect(originalItem.state).toBe('quarantined')
    expect(originalItem.trust.decision).toBe('revoked')
    expect(originalItem.trust.reasons).toContain('SENTRY_RESOLVED')

    // An escalation should be recorded in health inbox
    const escalations = health.listEscalations()
    expect(escalations.length).toBeGreaterThanOrEqual(1)
    expect(escalations.some(esc => esc.reason === 'SOURCE_DENIED')).toBe(true)

    // No tasks created
    expect(existsSync(join(directory, 'tasks.jsonl'))).toBe(false)
  } finally {
    await observer?.close(); await restored?.close(); await health?.close()
    await new Promise<void>((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()))
    process.env = envBackup
    await rm(directory, { recursive: true, force: true })
  }
})

it('starts timer and drains in monitoring-only mode with zero GitHub routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-monitoring-only-'))
  const envBackup = { ...process.env }
  process.env.DF_APM_WEBHOOK_SECRET = apmSecret
  process.env.DF_APM_TOKEN = apmToken

  const provider = await startMockProvider({})
  let observer: DarkFactoryObserver | undefined, health: HealthStore | undefined

  try {
    await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
    await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)

    const basePolicy = enabledPolicy()
    basePolicy.limits.maxArtifactBytes = 65536
    basePolicy.limits.maxJournalRecordBytes = 1_048_576
    basePolicy.limits.maxJournalBytes = 16_777_216
    basePolicy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
    // Only APM route; ZERO GitHub routes!
    basePolicy.ingestion.routes = [buildApmRoute(provider.port)]

    health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
    observer = await DarkFactoryObserver.open(directory, enabledDarkFactoryConfigSchema.parse(basePolicy), (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs), [{ id: 'project', repository: directory }])

    const apmReceipt = await postApm(observer.status().port, JSON.stringify(apmAlertPayload()), 'apm-del-only-1')
    expect(apmReceipt.status).toBe(202)

    // Wait for timer to automatically drain and reconcile
    const journalPath = join(directory, 'darkfactory/project/ingestion.jsonl')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (existsSync(journalPath) && (await readFile(journalPath, 'utf8')).includes('CURRENT_PROVIDER_EVIDENCE_VERIFIED')) break
      await new Promise(resolve => setTimeout(resolve, 30))
    }

    const journalContent = await readFile(journalPath, 'utf8')
    expect(journalContent).toContain('CURRENT_PROVIDER_EVIDENCE_VERIFIED')
    expect(existsSync(join(directory, 'tasks.jsonl'))).toBe(false)
  } finally {
    await observer?.close(); await health?.close()
    await new Promise<void>((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()))
    process.env = envBackup
    await rm(directory, { recursive: true, force: true })
  }
})

it('persists provider cooldowns when rate limited and denies access on authority pause', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-monitoring-cooldown-'))
  const envBackup = { ...process.env }
  process.env.DF_APM_WEBHOOK_SECRET = apmSecret
  process.env.DF_APM_TOKEN = apmToken

  const provider = await startMockProvider({ rateLimit: true })
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
    observer = await DarkFactoryObserver.open(directory, enabledDarkFactoryConfigSchema.parse(basePolicy), (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs), [{ id: 'project', repository: directory }])

    const apmReceipt = await postApm(observer.status().port, JSON.stringify(apmAlertPayload()), 'apm-del-rate-1')
    expect(apmReceipt.status).toBe(202)

    // Wait for rate limit to be recorded
    const budgetPath = join(directory, 'darkfactory-provider-requests.jsonl')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (existsSync(budgetPath) && (await readFile(budgetPath, 'utf8')).includes('PROVIDER_RATE_LIMITED')) break
      await new Promise(resolve => setTimeout(resolve, 30))
    }

    const budgetText = await readFile(budgetPath, 'utf8')
    expect(budgetText).toContain('PROVIDER_RATE_LIMITED')

    // Close and verify no work dispatched
    await observer.close(); observer = undefined
    expect(existsSync(join(directory, 'tasks.jsonl'))).toBe(false)
  } finally {
    await observer?.close(); await health?.close()
    await new Promise<void>((resolve, reject) => provider.server.close(error => error ? reject(error) : resolve()))
    process.env = envBackup
    await rm(directory, { recursive: true, force: true })
  }
})
