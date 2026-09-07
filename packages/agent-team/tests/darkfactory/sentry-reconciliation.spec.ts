import { expect, it } from 'vitest'
import { ingressPolicyRouteSchema, sentryReconciliationRegistrationSchema } from '../../src/darkfactory/config.ts'
import { reconcileSentrySource, sentryReconciliationLookupSchema, type SentryReconciliationOptions } from '../../src/darkfactory/sentry-reconciliation.ts'
import { enabledPolicy } from './config-fixture.ts'

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const now = '2026-09-06T12:01:00Z', eventId = 'a'.repeat(32), token = 'fixture-private-token'
function fixture() {
  const project = { id: '42', slug: 'service', organization: { id: '20', slug: 'acme' } }
  const issue = { id: '7', title: 'Current failure', culprit: 'service.run', status: 'unresolved', project: { id: '42', slug: 'service' }, firstSeen: '2026-09-06T11:00:00Z', lastSeen: '2026-09-06T12:00:00Z' }
  const event = { eventID: eventId, groupID: '7', title: 'Current failure', dateCreated: '2026-09-06T12:00:00Z', dateReceived: '2026-09-06T12:00:01Z',
    tags: [{ key: 'environment', value: 'production' }], release: { version: 'release-1', dateCreated: '2026-09-06T10:00:00Z', dateReleased: null },
    entries: [{ type: 'exception', data: { values: [{ type: 'Error', value: 'failure', stacktrace: { frames: [{ filename: 'src/service.ts', function: 'run', lineNo: 8, colNo: 4, inApp: true }] } }] } }],
    user: { id: 'NOT-AUTHORITY', email: 'private@example.invalid' }, request: { headers: [['Authorization', token]] } }
  const requests: string[] = [], charged: number[] = []
  const registration = sentryReconciliationRegistrationSchema.parse({ credentialRef: { kind: 'env', name: 'FIXTURE_SENTRY_TOKEN' }, credentialKind: 'api-token', installationId: 'installation',
    organizationId: '20', organizationSlug: 'acme', providerProjectId: '42', projectSlug: 'service', repositoryId: 'repository', repositoryName: 'owner/repo', sensorPrincipalId: 'host-sensor:sentry', productionEnvironmentId: 'production' })
  const route = ingressPolicyRouteSchema.parse({ ...enabledPolicy().ingestion.routes[0], source: 'sentry', senderIds: ['sender'], reconciliation: registration,
    bindings: { installationIds: ['installation'], organizationIds: ['20'], providerProjects: [{ id: '42', slug: 'service', organizationId: '20' }],
      environments: [{ providerEnvironment: 'production', environmentId: 'production' }],
      ruleMappings: [{ ruleId: 'rule', automationLabel: 'custom automation', resource: 'issue', providerRule: null },
        { ruleId: 'rule', automationLabel: 'custom automation', resource: 'event_alert', providerRule: 'Production failures' },
        { ruleId: 'rule', automationLabel: 'custom automation', resource: 'metric_alert', providerRule: '99' }] } })
  const options: SentryReconciliationOptions = { registration, route, projectId: 'project', policyRevision: 1,
    observed: { kind: 'sentry_issue', resource: 'issue', sourceEntityId: 'sentry-issue:42:7', providerEntityId: '7', installationId: 'installation', actorId: 'sender', providerProjectIds: ['42'], organizationId: null, providerRule: null, eventId: null },
    secret: token, redactText: value => value.replaceAll('private-value', '[redacted]'), now: () => new Date(now),
    beforeRequest: () => { charged.push(requests.length) },
    transport: async (url, init) => { requests.push(String(url)); expect(charged.length).toBe(requests.length)
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`)
      return json(String(url).includes('/projects/') ? project : String(url).includes('/events/') ? event : issue)
    } }
  return { options, project, issue, event, requests, charged }
}
it('binds current project, unresolved issue and fresh production event; host sensor and webhook actor have distinct provenance', async () => {
  const f = fixture(), result = await reconcileSentrySource(f.options)
  expect(result.decision).toBe('trusted'); if (result.decision !== 'trusted') throw new Error('fixture')
  expect(result.item).toMatchObject({ repository: { provider: 'github', repositoryId: 'repository', canonicalName: 'owner/repo' }, author: 'host-sensor:sentry', actor: 'sender', title: 'Current failure', labels: ['custom automation'], sourceUrl: 'https://sentry.io/organizations/acme/issues/7/' })
  expect(result.provenance).toMatchObject({ sourceEntityId: 'sentry-issue:42:7', sourceRevision: result.sourceRevision, credentialBinding: 'host-pinned-api-token-installation', repositoryBinding: 'host-configured-project-repository',
    authorBinding: 'host-configured-sensor', actorBinding: 'signed-webhook-observation-not-current-provider', ruleBinding: 'host-mapping-of-signed-webhook-selector-not-current-provider-rule-activation', event: { eventID: eventId, environment: 'production' } })
  expect(result.provenance.responseDigests).toHaveLength(3)
  expect(JSON.stringify(result)).not.toContain('private@example.invalid'); expect(JSON.stringify(result)).not.toContain('NOT-AUTHORITY'); expect(JSON.stringify(result)).not.toContain(token)
  expect(f.requests).toEqual(['https://sentry.io/api/0/projects/acme/service/', 'https://sentry.io/api/0/organizations/acme/issues/7/', 'https://sentry.io/api/0/organizations/acme/issues/7/events/latest/?environment=production'])
})
it('checks the referenced event for event alerts while deriving the same revision from current facts', async () => {
  const original = await reconcileSentrySource(fixture().options), f = fixture()
  f.options.observed = { ...f.options.observed, kind: 'sentry_issue', resource: 'event_alert', eventId, providerRule: 'Production failures' }
  const result = await reconcileSentrySource(f.options)
  expect(result.decision).toBe('trusted'); expect(result.decision === 'trusted' && result.sourceRevision).toBe(original.decision === 'trusted' && original.sourceRevision)
  expect(f.requests[2]).toBe(`https://sentry.io/api/0/organizations/acme/issues/7/events/${eventId}/`); expect(f.requests).toHaveLength(4)
})
it('hashes actual execution facts before redaction, retaining bounded sanitized frames and release metadata', async () => {
  const f = fixture(); f.issue.title = f.event.title = `private-value ${token}`; f.event.release.version = 'private-value'; f.event.entries[0]!.data.values[0]!.stacktrace.frames[0]!.filename = 'private-value'
  const first = await reconcileSentrySource(f.options)
  expect(first.decision).toBe('trusted'); if (first.decision !== 'trusted') throw new Error('fixture')
  expect(JSON.stringify(first)).not.toContain('private-value'); expect(JSON.stringify(first)).not.toContain(token)
  expect(first.provenance.event.exceptions[0]?.stacktrace?.frames[0]?.filename).toBe('[redacted]')
  f.event.entries[0]!.data.values[0]!.stacktrace.frames[0]!.lineNo = 9
  const second = await reconcileSentrySource(f.options)
  expect(second.decision === 'trusted' && second.sourceRevision).not.toBe(first.sourceRevision)
  f.event.release.version = 'different release'; const third = await reconcileSentrySource(f.options)
  expect(third.decision === 'trusted' && third.sourceRevision).not.toBe(second.decision === 'trusted' && second.sourceRevision)
})
it.each(['resolved', 'ignored'])('denies current %s issues after exact entity binding', async status => {
  const f = fixture(); f.issue.status = status
  expect(await reconcileSentrySource(f.options)).toMatchObject({ decision: 'denied', diagnosticCode: 'SENTRY_RESOLVED', requestsUsed: 2 })
})
it('denies changed scope, source, sender and registered mapping before any provider read', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.options.observed.installationId = 'wrong' }, f => { f.options.observed.organizationId = 'wrong' }, f => { f.options.observed.providerProjectIds = ['99'] },
    f => { f.options.observed.sourceEntityId = 'sentry-issue:42:8' }, f => { f.options.observed.actorId = 'NOT-AUTHORITY' }, f => { f.options.projectId = 'another-project' },
    f => { f.options.route.ruleIds = ['unregistered'] }, f => { f.options.registration.repositoryName = 'other/repo' },
  ]
  for (const change of changes) { const f = fixture(); change(f); const result = await reconcileSentrySource(f.options); expect(result.decision).toBe('denied'); expect(f.requests).toHaveLength(0) }
})
it('rejects provider project, organization, issue or event substitution', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.project.organization.id = '99' }, f => { f.project.id = '99' }, f => { f.project.slug = 'other' },
    f => { f.issue.id = '8' }, f => { f.issue.project.id = '99' }, f => { f.event.groupID = '8' },
  ]
  for (const change of changes) { const f = fixture(); change(f); expect((await reconcileSentrySource(f.options)).decision).toBe('denied') }
})
it('requires exactly one current production environment, without deriving it from release deploys or webhook claims', async () => {
  for (const tags of [[], [{ key: 'environment', value: 'staging' }], [{ key: 'environment', value: 'production' }, { key: 'environment', value: 'production' }]]) {
    const f = fixture(); f.event.tags = tags
    expect(await reconcileSentrySource(f.options)).toMatchObject({ decision: 'denied', diagnosticCode: 'SENTRY_ENVIRONMENT_NOT_ALLOWED' })
  }
})
it('rejects stale, future and inconsistent source timestamps', async () => {
  const stale = fixture(); stale.event.dateCreated = '2026-09-06T11:00:00Z'
  expect(await reconcileSentrySource(stale.options)).toMatchObject({ decision: 'denied', diagnosticCode: 'SENTRY_EVENT_STALE' })
  const future = fixture(); future.event.dateReceived = '2026-09-06T12:02:00Z'
  expect(await reconcileSentrySource(future.options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'SENTRY_TIMESTAMP_INVALID' })
  const issue = fixture(); issue.issue.firstSeen = '2026-09-06T12:00:30Z'
  expect(await reconcileSentrySource(issue.options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'SENTRY_TIMESTAMP_INVALID' })
})
it('does not accept a different referenced event or stale/nonproduction trigger as a current alert', async () => {
  for (const mode of ['id', 'environment', 'stale'] as const) {
    const f = fixture(), transport = f.options.transport!
    f.options.observed = { ...f.options.observed, kind: 'sentry_issue', resource: 'event_alert', eventId, providerRule: 'Production failures' }
    f.options.transport = async (url, init) => {
      const response = await transport(url, init)
      if (!String(url).includes(`/events/${eventId}/`)) return response
      return json({ ...f.event, ...(mode === 'id' ? { eventID: 'b'.repeat(32) } : mode === 'environment' ? { tags: [{ key: 'environment', value: 'staging' }] } : { dateCreated: '2026-09-06T11:00:00Z' }) })
    }
    expect((await reconcileSentrySource(f.options)).decision).toBe('denied'); expect(f.requests).toHaveLength(3)
  }
})
it('leaves metric incidents explicitly unresolved rather than fabricating current API state', async () => {
  const f = fixture(); f.options.observed = { ...f.options.observed, kind: 'sentry_metric', resource: 'metric_alert', providerProjectIds: ['service'], eventId: null, organizationId: '20', providerRule: '99', sourceEntityId: 'sentry-metric:20:7' }
  expect(await reconcileSentrySource(f.options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'SENTRY_METRIC_API_UNSUPPORTED', reasons: ['PROVIDER_UNAVAILABLE'], requestsUsed: 0 })
  const wrongProject = fixture(); wrongProject.options.observed = { ...wrongProject.options.observed, kind: 'sentry_metric', resource: 'metric_alert', providerProjectIds: ['42'], eventId: null, organizationId: '20', providerRule: '99', sourceEntityId: 'sentry-metric:20:7' }
  expect(await reconcileSentrySource(wrongProject.options)).toMatchObject({ decision: 'denied', diagnosticCode: 'SENTRY_SCOPE_MISMATCH', requestsUsed: 0 })
})
it('strictly bounds event evidence, identifiers and lookup combinations', async () => {
  const f = fixture(); f.event.entries[0]!.data.values[0]!.stacktrace.frames = Array.from({ length: 65 }, () => f.event.entries[0]!.data.values[0]!.stacktrace.frames[0]!)
  expect(await reconcileSentrySource(f.options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'SENTRY_RESPONSE_INVALID' })
  expect(sentryReconciliationLookupSchema.safeParse({ ...fixture().options.observed, eventId, resource: 'issue' }).success).toBe(false)
  expect(sentryReconciliationLookupSchema.safeParse({ ...fixture().options.observed, extra: true }).success).toBe(false)
  expect(sentryReconciliationLookupSchema.safeParse({ ...fixture().options.observed, providerEntityId: '../7' }).success).toBe(false)
})
it('pins regional API and separately registered public source origin', async () => {
  const f = fixture(); f.options.registration.apiBaseUrl = 'https://us.sentry.io'; f.options.registration.publicSourceBaseUrl = 'https://acme.sentry.io'
  if (f.options.route.source !== 'sentry') throw new Error('fixture'); f.options.route.reconciliation = structuredClone(f.options.registration)
  const result = await reconcileSentrySource(f.options)
  expect(result.decision === 'trusted' && result.item.sourceUrl).toBe('https://acme.sentry.io/organizations/acme/issues/7/'); expect(f.requests.every(url => url.startsWith('https://us.sentry.io/'))).toBe(true)
})
it('charges every GET and forwards rate-limit cooldown while suppressing raw errors', async () => {
  const f = fixture(), cooldowns: string[] = []; f.options.onRateLimit = until => { cooldowns.push(until) }
  f.options.transport = async () => new Response(token, { status: 429, headers: { 'retry-after': '120' } })
  const result = await reconcileSentrySource(f.options)
  expect(result).toMatchObject({ decision: 'unresolved', diagnosticCode: 'RATE_LIMITED', requestsUsed: 1 }); expect(f.charged).toHaveLength(1)
  expect(cooldowns).toEqual(['2026-09-06T12:03:00.000Z']); expect(JSON.stringify(result)).not.toContain(token)
  const failed = fixture(); failed.options.beforeRequest = () => { throw new Error(token) }
  expect(await reconcileSentrySource(failed.options)).toMatchObject({ decision: 'unresolved', requestsUsed: 0 }); expect(failed.requests).toHaveLength(0)
})
it('refuses redirects, malformed bodies, credential errors and deadline overruns without exposing provider data', async () => {
  for (const response of [new Response(token, { status: 302, headers: { location: 'https://evil.invalid/' } }), new Response(token, { status: 401 }), new Response('{"id":1,"id":2}', { headers: { 'content-type': 'application/json' } })]) {
    const f = fixture(); f.options.transport = async () => response
    const result = await reconcileSentrySource(f.options); expect(result.decision).toBe('unresolved'); expect(JSON.stringify(result)).not.toContain(token)
  }
  const timeout = fixture(); timeout.options.requestTimeoutMs = 10; timeout.options.transport = async () => new Promise<Response>(() => {})
  expect(await reconcileSentrySource(timeout.options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'REQUEST_TIMEOUT', requestsUsed: 1 })
})
it('accepts provider events generated while requests are in flight but rejects timestamps beyond validation time', async () => {
  let currentTime = Date.parse(now)
  const f = fixture()
  f.options.now = () => new Date(currentTime)
  const originalTransport = f.options.transport!
  f.options.transport = async (url, init) => {
    currentTime += 5000 // host clock advances 5s per request
    return originalTransport(url, init)
  }
  // Event created at 12:01:02Z (after request began at 12:01:00Z, but before latest event response arrived at 12:01:15Z)
  f.event.dateCreated = '2026-09-06T12:01:02Z'
  f.event.dateReceived = '2026-09-06T12:01:03Z'
  f.issue.lastSeen = '2026-09-06T12:01:04Z'
  const result = await reconcileSentrySource(f.options)
  expect(result.decision).toBe('trusted')
  if (result.decision === 'trusted') {
    expect(result.checkedAt).toBe('2026-09-06T12:01:15.000Z')
    expect(result.provenance.checkedAt).toBe('2026-09-06T12:01:15.000Z')
  }

  // Beyond validation time: dateReceived is 12:01:20Z when host time is 12:01:15Z
  const f2 = fixture()
  let currentTime2 = Date.parse(now)
  f2.options.now = () => new Date(currentTime2)
  const transport2 = f2.options.transport!
  f2.options.transport = async (url, init) => {
    currentTime2 += 5000
    return transport2(url, init)
  }
  f2.event.dateReceived = '2026-09-06T12:01:20Z'
  expect(await reconcileSentrySource(f2.options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'SENTRY_TIMESTAMP_INVALID' })
})
