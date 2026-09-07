import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authenticateIngress, genericIngressSigningInput, ingressPath, IngressError, type IngressRoute } from '../../src/darkfactory/ingress-auth.ts'
import { normalizeIngress, normalizedIngressFactsSchema } from '../../src/darkfactory/ingress-adapters.ts'
import { digestBytes } from '../../src/darkfactory/json.ts'

const at = '2026-09-06T12:00:00Z', secret = 'synthetic-key', sha = 'a'.repeat(40)
const repository = { id: 100, full_name: 'org/repo', url: 'https://evil.example/ignored' }
const base = { action: 'opened', repository, installation: { id: 200 }, sender: { id: 300, login: 'actor' } }
function issue() { return { ...base, issue: { id: 400, number: 1, title: 'Example issue', body: 'Reproduction context', user: { id: 500 }, labels: [{ name: 'darkfactory:execute' }, { name: 'bug report' }], state: 'open', updated_at: at } } }
function normalize(source: IngressRoute['source'], eventKind: string, input: unknown, sentryTimestamp = '1') {
  const body = typeof input === 'string' ? Buffer.from(input) : Buffer.from(JSON.stringify(input))
  const route: IngressRoute = { id: 'route', projectId: 'project', source, providerVersion: 'v1', policyRevision: 1, signingKeyId: 'key' }
  const headers: [string, string][] = [['content-type', 'application/json']]
  if (source === 'github') headers.push(['x-github-delivery', 'delivery'], ['x-github-event', eventKind], ['x-hub-signature-256', `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`])
  else if (source === 'sentry') headers.push(['request-id', 'delivery'], ['sentry-hook-resource', eventKind], ['sentry-hook-timestamp', sentryTimestamp], ['sentry-hook-signature', createHmac('sha256', secret).update(body).digest('hex')])
  else {
    const timestamp = String(Date.parse(at) / 1000)
    const signed = genericIngressSigningInput({ method: 'POST', path: ingressPath(route), keyId: 'key', deliveryId: 'delivery', timestamp, bodyDigest: digestBytes(body) })
    headers.push(['x-darkfactory-key-id', 'key'], ['x-darkfactory-delivery-id', 'delivery'], ['x-darkfactory-timestamp', timestamp], ['x-darkfactory-signature-256', `sha256=${createHmac('sha256', secret).update(signed).digest('hex')}`])
  }
  return normalizeIngress(authenticateIngress({ route, request: { method: 'POST', path: ingressPath(route), headers, body }, secret, receivedAt: at }))
}
const sentryBase = { action: 'triggered', installation: { uuid: 'installation' }, actor: { id: 'sentry', type: 'application' } }
function apm() { return { schemaVersion: 1, action: 'triggered', senderId: 'sender', providerProjectId: 'service', environment: 'production', ruleId: 'rule', fingerprint: 'error-group', revision: 'revision-1', title: 'Errors elevated', context: 'Reproduction evidence pending', observationWindow: { start: '2026-09-06T11:59:00Z', end: at }, commit: sha, release: 'v1', metrics: [{ name: 'errors', value: 4, unit: 'count' }], evidence: [] } }

describe('authenticated ingress normalization', () => {
  it('normalizes GitHub issues without deriving authority from labels, actors, payload URLs or extension fields', () => {
    const payload = { ...issue(), projectId: 'other', trusted: true, command: 'rm -rf /', sourceUrl: 'https://evil.example/' }
    const result = normalize('github', 'issues', payload)
    expect(result.envelope).toMatchObject({ projectId: 'project', source: 'github', authentication: 'verified', action: 'opened' })
    expect(result.envelope).not.toHaveProperty('providerAt')
    expect(result.facts).toMatchObject({ trust: 'unresolved', providerEntityId: '400', repositoryId: '100', installationId: '200', authorId: '500', actorId: '300', labels: ['bug report', 'darkfactory:execute'] })
    expect(JSON.stringify(result)).not.toContain('evil.example')
    expect(JSON.stringify(result)).not.toContain('rm -rf')
    expect(normalizedIngressFactsSchema.parse(result.facts)).toEqual(result.facts)
    for (const action of ['closed', 'unlabeled']) expect(normalize('github', 'issues', { ...issue(), action }).facts.invalidatesPending).toBe(true)
  })
  it('pins PR base/head identities and commits, preserving fork untrust and source revision changes', () => {
    const { issue: entity } = issue()
    const payload = { ...base, action: 'synchronize', pull_request: { ...entity, base: { sha, repo: repository }, head: { sha: 'b'.repeat(40), repo: { id: 101, full_name: 'fork/repo' } } } }
    const first = normalize('github', 'pull_request', payload)
    expect(first.facts.details).toMatchObject({ kind: 'pull_request', baseRepositoryId: '100', headRepositoryId: '101', fork: true, baseCommit: sha, headCommit: 'b'.repeat(40) })
    expect(first.facts.trust).toBe('unresolved')
    expect(first.facts.providerEntityId).toBe('400')
    expect(first.facts.details).toMatchObject({ number: 1 })
    payload.pull_request.head.sha = 'c'.repeat(40)
    expect(normalize('github', 'pull_request', payload).facts.observationDigest).not.toBe(first.facts.observationDigest)
    payload.pull_request.base.repo = { ...repository, id: 999 }
    expect(() => normalize('github', 'pull_request', payload)).toThrow('REPOSITORY_MISMATCH')
  })
  it('normalizes Dependabot exposure and fix claims without inventing issue labels', () => {
    const payload = { ...base, action: 'created', alert: { number: 7, state: 'open', updated_at: at, dependency: { package: { name: '@scope/library', ecosystem: 'npm' }, manifest_path: 'pnpm-lock.yaml' }, security_advisory: { ghsa_id: 'GHSA-abcd-efgh-ijkl', cve_id: 'CVE-2026-12345', summary: 'Dependency vulnerability', identifiers: [{ type: 'CVE', value: 'CVE-2026-12345' }] }, security_vulnerability: { vulnerable_version_range: '< 2.0.0', first_patched_version: { identifier: '2.0.0' } } } }
    const result = normalize('github', 'dependabot_alert', payload)
    expect(result.facts).toMatchObject({ labels: [], authorId: null, trust: 'unresolved', providerEntityId: '7', details: { dependency: '@scope/library', manifestPath: 'pnpm-lock.yaml', affectedRange: '< 2.0.0', availableFix: '2.0.0', cve: 'CVE-2026-12345' } })
    for (const action of ['reopened', 'reintroduced']) expect(normalize('github', 'dependabot_alert', { ...payload, action }).facts.invalidatesPending).toBe(false)
    expect(normalize('github', 'dependabot_alert', { ...payload, action: 'dismissed' }).facts.invalidatesPending).toBe(true)
  })
  it('normalizes Sentry issue/event alerts with optional bounded frames and unsigned timestamp metadata', () => {
    const event = { event_id: 'event', issue_id: 'issue', project: 42, title: 'ReferenceError', datetime: at, tags: [['environment', 'production']], release: { version: 'v1' }, exception: { values: [{ type: 'ReferenceError', value: 'undefined symbol', stacktrace: { frames: [{ filename: 'src/app.ts', lineno: 10, colno: 2, function: 'run', in_app: true, vars: { password: 'discard-me' } }] } }] } }
    const payload = { ...sentryBase, data: { triggered_rule: 'Very Important Alert!', event } }
    const result = normalize('sentry', 'event_alert', payload)
    expect(result.facts).toMatchObject({ trust: 'unresolved', providerEntityId: 'issue', providerProjectIds: ['42'], nativeTimestampAuthenticated: false, details: { environment: 'production', release: 'v1', exceptions: [{ frames: [{ filename: 'src/app.ts', line: 10 }] }] } })
    expect(result.envelope).not.toHaveProperty('providerAt')
    expect(JSON.stringify(result)).not.toContain('discard-me')
    expect(normalize('sentry', 'event_alert', payload, '2').facts.observationDigest).toBe(result.facts.observationDigest)
    const withoutFrames = { ...payload, data: { ...payload.data, event: { ...event, exception: undefined } } }
    expect(normalize('sentry', 'event_alert', withoutFrames).facts.details).toMatchObject({ exceptions: [] })
    const issuePayload = { ...sentryBase, action: 'resolved', data: { issue: { id: 'issue', title: 'Issue', status: 'resolved', project: { id: '42', slug: 'service' }, lastSeen: '2026-09-06T12:00:00+00:00' } } }
    expect(normalize('sentry', 'issue', issuePayload).facts).toMatchObject({ invalidatesPending: true, providerEntityId: 'issue' })
  })
  it('normalizes Sentry metric alerts and rejects cross-organization/project inconsistency', () => {
    const metric = { id: 'incident', organization_id: 'org', projects: ['service'], date_started: at, date_closed: null, alert_rule: { id: 'rule', organization_id: 'org', projects: ['service'], environment: 'production', aggregate: 'count()', query: 'level:error', time_window: 10, date_modified: at } }
    const payload = { ...sentryBase, action: 'critical', data: { description_text: '1000 events', description_title: 'Too many errors', metric_alert: metric } }
    expect(normalize('sentry', 'metric_alert', payload).facts).toMatchObject({ organizationId: 'org', providerEntityId: 'incident', ruleIds: ['rule'], details: { kind: 'sentry_metric', environment: 'production', windowMinutes: 10 } })
    expect(normalize('sentry', 'metric_alert', { ...payload, action: 'resolved' }).facts.invalidatesPending).toBe(true)
    metric.alert_rule.organization_id = 'other'
    expect(() => normalize('sentry', 'metric_alert', payload)).toThrow('PROJECT_MISMATCH')
  })
  it('requires strict generic APM schemas and project-bound evidence', () => {
    const result = normalize('apm', 'alert', apm())
    expect(result.envelope.providerAt).toBe('2026-09-06T12:00:00.000Z')
    expect(result.facts).toMatchObject({ trust: 'unresolved', providerEntityId: 'error-group', actorId: 'sender', providerProjectIds: ['service'], details: { kind: 'apm', fingerprint: 'error-group', commit: sha } })
    for (const input of [
      { ...apm(), trust: 'trusted' },
      { ...apm(), observationWindow: { ...apm().observationWindow, authority: true } },
      { ...apm(), observationWindow: { start: at, end: at } },
      { ...apm(), metrics: [{ name: 'errors', value: '4', unit: 'count' }] },
    ]) expect(() => normalize('apm', 'alert', input)).toThrow('PAYLOAD_INVALID')
    expect(() => normalize('apm', 'alert', { ...apm(), evidence: [{ projectId: 'other', id: 'artifact', mediaType: 'application/json', sizeBytes: 1, digest: digestBytes('x') }] })).toThrow('PROJECT_MISMATCH')
  })
  it('rejects ambiguous/malformed signed JSON and unsupported or forged event shapes with redacted errors', () => {
    for (const input of ['{"action":"opened","action":"closed"}', '{', { ...issue(), issue: { ...issue().issue, updated_at: 'invalid' } }]) {
      try { normalize('github', 'issues', input); throw new Error('unexpected acceptance') } catch (error) { expect(error).toBeInstanceOf(IngressError); expect(error).toMatchObject({ authenticated: true, status: 422 }) }
    }
    expect(() => normalize('github', 'pull_request', issue())).toThrow('PAYLOAD_INVALID')
    expect(() => normalize('github', 'push', issue())).toThrow('EVENT_UNSUPPORTED')
    expect(() => normalize('github', 'issues', { ...issue(), pull_request: {} })).toThrow('PAYLOAD_AMBIGUOUS')
    expect(() => normalize('apm', 'alert', { ...apm(), ['sensitive-redaction-key']: true })).toThrow(/^Dark Factory ingress rejected: PAYLOAD_INVALID$/)
  })
})
