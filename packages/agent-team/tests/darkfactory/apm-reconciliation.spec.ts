import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { reconcileApmSource, type ApmReconciliationOptions } from '../../src/darkfactory/apm-reconciliation.ts'
import { apmReconciliationRegistrationSchema, ingressPolicyRouteSchema } from '../../src/darkfactory/config.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
const now = '2026-09-06T12:00:00.000Z', recent = '2026-09-06T11:59:00.000Z', secret = 'PRIVATE_APM_API_TOKEN'
const registration = apmReconciliationRegistrationSchema.parse({ apiBaseUrl: 'https://api.apm.example.invalid', publicSourceBaseUrl: 'https://apm.example.invalid',
  credentialRef: { kind: 'env', name: 'FIXTURE_APM_TOKEN' }, credentialKind: 'api-token', repositoryId: 'repository', repositoryName: 'owner/repo',
  sensorPrincipalId: 'host-sensor:production', productionEnvironmentId: 'production', providerProjectId: 'backend', senderId: 'sender' })
const route = ingressPolicyRouteSchema.parse({ id: 'apm-route', projectId: 'project', source: 'apm', providerVersion: 'gasteam-v1', signingKeyId: 'webhook-key',
  secretRef: { kind: 'env', name: 'FIXTURE_WEBHOOK_KEY' }, repositoryIds: ['repository'], senderIds: ['sender'], ruleIds: ['rule'], reconciliation: registration,
  bindings: { providerProjectIds: ['backend'], environments: [{ providerEnvironment: 'prod', environmentId: 'production' }], ruleMappings: [{ providerRule: 'latency-rule', ruleId: 'rule', automationLabel: 'automate' }] } })
function payload() {
  return { schemaVersion: 1, action: 'triggered', senderId: 'sender', providerProjectId: 'backend', environment: 'prod', ruleId: 'latency-rule', fingerprint: 'latency:p99', revision: 'revision-1',
    title: 'Current latency alert', context: `Current provider narrative ${secret}`, observationWindow: { start: '2026-09-06T11:58:00.000Z', end: recent }, commit: 'a'.repeat(40), release: 'release-1',
    metrics: [{ name: 'latency', value: 250, unit: 'ms' }, { name: 'errors', value: 2, unit: 'count' }],
    evidence: ['evidence-b', 'evidence-a'].map(id => ({ projectId: 'project', id, digest: digestJson(id), mediaType: 'application/json', sizeBytes: 100 })) }
}
const body = () => ({ schemaVersion: 1, observedAt: now, payload: payload() })
function fixture(value: unknown = body()) {
  const requests: string[] = [], charges: number[] = [], cooldowns: string[] = []
  const options: ApmReconciliationOptions = { registration: structuredClone(registration), route: structuredClone(route), projectId: 'project', policyRevision: 1,
    observed: { kind: 'apm', sourceEntityId: `apm:${digestJson(['sender', 'backend', 'latency:p99']).slice(7)}`, providerEntityId: 'latency:p99', fingerprint: 'latency:p99', actorId: 'sender', providerProjectId: 'backend', providerRule: 'latency-rule' },
    secret, redactText: value => value, now: () => new Date(now), beforeRequest: async () => { charges.push(charges.length + 1) }, onRateLimit: async until => { cooldowns.push(until) },
    transport: async (url, init) => {
      requests.push(String(url)); expect(charges.length).toBe(requests.length)
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`)
      return new Response(typeof value === 'string' ? value : JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    } }
  return { options, requests, charges, cooldowns }
}
it('reads the explicit owned current protocol and separates host sensor/repository authority from API sender evidence', async () => {
  const f = fixture(), result = await reconcileApmSource(f.options)
  expect(result.decision).toBe('trusted'); if (result.decision !== 'trusted') throw new Error('Fixture')
  expect(f.requests).toEqual(['https://api.apm.example.invalid/darkfactory/v1/current/backend/latency%3Ap99'])
  expect(result.item).toMatchObject({ repository: { provider: 'github', repositoryId: 'repository', canonicalName: 'owner/repo' }, author: 'host-sensor:production', actor: 'sender',
    labels: ['automate'], sourceUrl: 'https://apm.example.invalid/darkfactory/v1/current/backend/latency%3Ap99' })
  expect(result.provenance).toMatchObject({ protocol: 'gasteam-apm-current/v1', identityBinding: 'host-configured-monitoring-sensor', repositoryBinding: 'host-configured-github-repository',
    credentialBinding: 'host-pinned-api-token', sourceEntityId: f.options.observed.sourceEntityId, repositoryName: 'owner/repo', ruleId: 'rule', productionEnvironmentId: 'production', requestsUsed: 1 })
  expect(result.provenance.responseDigests).toEqual([digestJson(body())]); expect(JSON.stringify(result)).not.toContain(secret)
  expect(result.provenance).not.toHaveProperty('evidence')
})
it('hashes raw execution fields before redaction and canonicalizes parallel metrics/evidence', async () => {
  const first = await reconcileApmSource(fixture().options); if (first.decision !== 'trusted') throw new Error('Fixture')
  const reordered = body(); reordered.payload.metrics.reverse(); reordered.payload.evidence.reverse(); reordered.observedAt = '2026-09-06T11:59:59.000Z'
  const same = await reconcileApmSource(fixture(reordered).options)
  expect(same.decision === 'trusted' && same.sourceRevision).toBe(first.sourceRevision)
  for (const patch of [{ revision: 'revision-2' }, { title: 'Changed title' }, { context: secret + '-changed' }, { action: 'updated' }, { release: 'release-2' }, { commit: 'b'.repeat(40) },
    { metrics: [{ name: 'latency', value: 251, unit: 'ms' }] }, { evidence: [] }, { observationWindow: { start: '2026-09-06T11:57:00.000Z', end: recent } }]) {
    const changed = await reconcileApmSource(fixture({ ...body(), payload: { ...payload(), ...patch } }).options)
    expect(changed.decision).toBe('trusted'); expect(changed.decision === 'trusted' && changed.sourceRevision).not.toBe(first.sourceRevision)
    expect(JSON.stringify(changed)).not.toContain(secret)
  }
})
it('rejects prefetch source, registration, host origin and project mismatches without sending credentials', async () => {
  for (const patch of [{ actorId: 'attacker' }, { providerProjectId: 'other' }, { providerEntityId: 'different' }, { sourceEntityId: 'forged' }]) {
    const f = fixture(); Object.assign(f.options.observed, patch)
    expect((await reconcileApmSource(f.options)).diagnosticCode).toBe('APM_SOURCE_MISMATCH'); expect(f.requests).toEqual([])
  }
  for (const patch of [{ projectId: 'other' }, { registration: { ...registration, repositoryId: 'other' } }, { registration: { ...registration, credentialKind: 'installation-token' } },
    { registration: { ...registration, publicSourceBaseUrl: 'http://public.invalid' } }, { registration: { ...registration, apiBaseUrl: 'https://user:password@attacker.invalid' } },
    { registration: { ...registration, apiBaseUrl: 'http://127.0.0.1:1234' } }]) {
    const f = fixture(); Object.assign(f.options, patch)
    expect((await reconcileApmSource(f.options)).decision).toBe('denied'); expect(f.requests).toEqual([])
  }
})
it('checks current identities before classifying resolved or disallowed conditions as authoritative denials', async () => {
  for (const patch of [{ senderId: 'other' }, { providerProjectId: 'other' }, { fingerprint: 'other' }, { ruleId: 'other' }]) {
    const f = fixture({ ...body(), payload: { ...payload(), ...patch, action: 'resolved' } })
    expect(await reconcileApmSource(f.options)).toMatchObject({ decision: 'denied', diagnosticCode: 'APM_SOURCE_MISMATCH', requestsUsed: 1 })
  }
  expect(await reconcileApmSource(fixture({ ...body(), payload: { ...payload(), action: 'resolved' } }).options)).toMatchObject({ decision: 'denied', diagnosticCode: 'APM_RESOLVED', requestsUsed: 1 })
  expect(await reconcileApmSource(fixture({ ...body(), payload: { ...payload(), environment: 'staging' } }).options)).toMatchObject({ decision: 'denied', diagnosticCode: 'APM_ENVIRONMENT_NOT_ALLOWED', requestsUsed: 1 })
  const rule = fixture(); if (rule.options.route.source !== 'apm') throw new Error('Fixture'); rule.options.route.bindings.ruleMappings[0]!.ruleId = 'unregistered'
  expect(await reconcileApmSource(rule.options)).toMatchObject({ decision: 'denied', diagnosticCode: 'APM_RULE_NOT_ALLOWED', requestsUsed: 1 })
})
it.each([
  ['APM_RESPONSE_STALE', { observedAt: '2026-09-06T11:54:59.999Z', payload: { ...payload(), observationWindow: { start: '2026-09-06T11:53:00.000Z', end: '2026-09-06T11:54:00.000Z' } } }],
  ['APM_RESPONSE_FUTURE', { observedAt: '2026-09-06T12:00:00.001Z' }],
  ['APM_RESPONSE_STALE', { payload: { ...payload(), observationWindow: { start: '2026-09-06T11:53:00.000Z', end: '2026-09-06T11:54:59.999Z' } } }],
  ['APM_RESPONSE_FUTURE', { payload: { ...payload(), observationWindow: { start: recent, end: '2026-09-06T12:00:00.001Z' } } }],
  ['APM_RESPONSE_FUTURE', { observedAt: '2026-09-06T11:58:59.999Z' }],
] as const)('rejects stale/future current read or observation window as unresolved: %s', async (diagnosticCode, patch) => {
  expect(await reconcileApmSource(fixture({ ...body(), ...patch }).options)).toMatchObject({ decision: 'unresolved', reasons: ['PROVIDER_RESPONSE_INVALID'], diagnosticCode })
})
it('strictly rejects unknown fields, malformed envelopes, duplicate metrics/evidence and cross-project evidence', async () => {
  const values = [{ ...body(), extra: secret }, { ...body(), payload: { ...payload(), extra: secret } }, { ...body(), payload: { ...payload(), metrics: [{ ...payload().metrics[0], extra: secret }] } },
    { ...body(), schemaVersion: 2 }, { ...body(), observedAt: '2026-09-06T12:00:00+00:00' }, { ...body(), payload: { ...payload(), observationWindow: { start: recent, end: recent } } }, '{',
    '{"schemaVersion":1,"schemaVersion":1}', { ...body(), payload: { ...payload(), metrics: [{ name: 'metric', value: null, unit: 'ms' }] } }]
  for (const value of values) { const result = await reconcileApmSource(fixture(value).options); expect(result.decision).toBe('unresolved'); expect(JSON.stringify(result)).not.toContain(secret) }
  expect((await reconcileApmSource(fixture({ ...body(), payload: { ...payload(), metrics: [payload().metrics[0], payload().metrics[0]] } }).options)).diagnosticCode).toBe('APM_DUPLICATE_METRIC')
  expect(await reconcileApmSource(fixture({ ...body(), payload: { ...payload(), action: 'resolved', metrics: [payload().metrics[0], payload().metrics[0]] } }).options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'APM_DUPLICATE_METRIC' })
  expect((await reconcileApmSource(fixture({ ...body(), payload: { ...payload(), evidence: [payload().evidence[0], payload().evidence[0]] } }).options)).diagnosticCode).toBe('APM_DUPLICATE_EVIDENCE')
  expect((await reconcileApmSource(fixture({ ...body(), payload: { ...payload(), evidence: [{ ...payload().evidence[0], projectId: 'other' }] } }).options)).diagnosticCode).toBe('APM_EVIDENCE_PROJECT_MISMATCH')
})
it('retains the shared request-budget, cooldown, redirect and body/deadline safeguards', async () => {
  const rate = fixture(); rate.options.transport = async () => new Response(secret, { status: 429, headers: { 'retry-after': '120' } })
  expect(await reconcileApmSource(rate.options)).toMatchObject({ decision: 'unresolved', reasons: ['PROVIDER_RATE_LIMITED'], requestsUsed: 1 })
  expect(rate.charges).toHaveLength(1); expect(rate.cooldowns).toEqual(['2026-09-06T12:02:00.000Z'])
  const refused = fixture(); refused.options.beforeRequest = async () => { throw new Error(secret) }
  const denial = await reconcileApmSource(refused.options); expect(denial.decision).toBe('unresolved'); expect(refused.requests).toEqual([]); expect(JSON.stringify(denial)).not.toContain(secret)
  const redirect = fixture(); redirect.options.transport = async () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid' } })
  expect((await reconcileApmSource(redirect.options)).decision).toBe('unresolved'); expect(redirect.charges).toHaveLength(1)
  const large = fixture(); large.options.maxBodyBytes = 100
  expect((await reconcileApmSource(large.options)).decision).toBe('unresolved')
  const stalled = fixture(); stalled.options.requestTimeoutMs = 10; stalled.options.transport = async () => new Promise<Response>(() => {})
  expect((await reconcileApmSource(stalled.options)).decision).toBe('unresolved')
  const aborted = fixture(), stop = new AbortController(); aborted.options.signal = stop.signal; stop.abort()
  expect((await reconcileApmSource(aborted.options)).decision).toBe('unresolved'); expect(aborted.charges).toEqual([])
})
it('uses actual loopback HTTP only with fixture opt-in and retains a separately pinned HTTPS public source URL', async () => {
  const f = fixture(), paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url!); expect(request.method).toBe('GET'); expect(request.headers.authorization).toBe(`Bearer ${secret}`); expect(f.charges).toHaveLength(paths.length)
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body()))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string' || f.options.route.source !== 'apm') throw new Error('Fixture')
    f.options.transport = undefined; f.options.registration = { ...registration, apiBaseUrl: `http://127.0.0.1:${address.port}`, fixtureLoopback: true }; f.options.route.reconciliation = f.options.registration
    const result = await reconcileApmSource(f.options)
    expect(result.decision).toBe('trusted'); expect(paths).toEqual(['/darkfactory/v1/current/backend/latency%3Ap99'])
    if (result.decision === 'trusted') expect(result.item.sourceUrl).toBe('https://apm.example.invalid/darkfactory/v1/current/backend/latency%3Ap99')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
it('accepts a current response generated while the HTTP request is in flight but rejects timestamps beyond validation time', async () => {
  let currentTime = Date.parse(now)
  const f = fixture()
  f.options.now = () => new Date(currentTime)
  // Advance host clock by 1000ms during the GET transport
  const inFlightResponse = { ...body(), observedAt: '2026-09-06T12:00:00.500Z' }
  f.options.transport = async () => {
    currentTime += 1000
    return new Response(JSON.stringify(inFlightResponse), { headers: { 'content-type': 'application/json' } })
  }
  const result = await reconcileApmSource(f.options)
  expect(result.decision).toBe('trusted')
  if (result.decision === 'trusted') {
    expect(result.checkedAt).toBe('2026-09-06T12:00:01.000Z')
    expect(result.provenance.checkedAt).toBe('2026-09-06T12:00:01.000Z')
  }

  // If provider timestamp is after the response arrival (e.g. 12:00:01.500Z when host time is 12:00:01.000Z), still rejected as APM_RESPONSE_FUTURE
  const f2 = fixture()
  currentTime = Date.parse(now)
  f2.options.now = () => new Date(currentTime)
  const futureResponse = { ...body(), observedAt: '2026-09-06T12:00:01.500Z' }
  f2.options.transport = async () => {
    currentTime += 1000
    return new Response(JSON.stringify(futureResponse), { headers: { 'content-type': 'application/json' } })
  }
  expect(await reconcileApmSource(f2.options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'APM_RESPONSE_FUTURE' })
})
