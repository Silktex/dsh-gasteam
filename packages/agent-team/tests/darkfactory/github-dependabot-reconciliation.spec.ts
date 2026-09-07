import { expect, it } from 'vitest'
import { githubReconciliationRegistrationSchema, ingressPolicyRouteSchema } from '../../src/darkfactory/config.ts'
import { reconcileGithubDependabotAlert, type GithubDependabotReconciliationOptions } from '../../src/darkfactory/github-dependabot-reconciliation.ts'
import { enabledPolicy } from './config-fixture.ts'
import { dependabotAlertFixture } from './dependabot-reconciliation-fixture.ts'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function fixture(transform: (value: ReturnType<typeof dependabotAlertFixture>) => unknown = value => value) {
  const requests: string[] = []
  const options: GithubDependabotReconciliationOptions = {
    registration: githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'FIXTURE_TOKEN' }, credentialKind: 'installation-token', dependabot: { sensorPrincipalId: 'host-sensor:dependabot', ruleId: 'rule' } }),
    observed: { kind: 'dependabot_alert', repositoryId: '42', providerEntityId: '7', actorId: '12', installationId: '10', number: 7, sourceEntityId: 'dependabot:42:7' },
    route: ingressPolicyRouteSchema.parse({ ...enabledPolicy().ingestion.routes[0], repositoryIds: ['42'], senderIds: ['12'], bindings: { installationIds: ['10'], authorIds: ['host-sensor:dependabot'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] } }),
    projectId: 'project', policyRevision: 1, secret: 'fixture-installation-secret', redactText: value => value.replaceAll('fixture-installation-secret', '[redacted]'), now: () => new Date('2026-09-06T12:01:00Z'),
    transport: async (url, init) => {
      requests.push(String(url)); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-installation-secret')
      return String(url).includes('/installation/') ? json({ total_count: 1, repositories: [{ id: 42, full_name: 'Owner/Repo' }] }) : json(transform(dependabotAlertFixture()))
    },
  }
  return { options, requests }
}
it('binds the actual open alert, dependency and fix to an explicit host sensor, retaining webhook actor only as provenance', async () => {
  const f = fixture(), result = await reconcileGithubDependabotAlert(f.options)
  expect(result.decision).toBe('trusted'); if (result.decision !== 'trusted') throw new Error('fixture')
  expect(result.issue).toMatchObject({ kind: 'dependabot_alert', id: '7', authorId: 'host-sensor:dependabot', actorId: 'host-sensor:dependabot', labels: ['automate'], sourceUrl: 'https://github.com/owner/repo/security/dependabot/7',
    dependency: { package: 'fixture-package', ecosystem: 'npm', manifestPath: 'package-lock.json', scope: 'runtime' }, advisory: { ghsa: 'GHSA-abcd-efgh-1234', cve: 'CVE-2026-12345', affectedRange: '< 2.0.0', availableFix: '2.0.0' } })
  expect(result.provenance).toMatchObject({ resource: 'dependabot_alert', identityBinding: 'host-configured-dependabot-sensor', sensorPrincipalId: 'host-sensor:dependabot', actorId: 'host-sensor:dependabot', webhookActorId: '12', webhookActorBinding: 'signed-webhook-observation-not-current-provider', ruleId: 'rule', sourceRevision: result.sourceRevision })
  expect(result.provenance.responseDigests).toHaveLength(2)
  expect(f.requests).toEqual(['https://api.github.com/installation/repositories?per_page=100&page=1', 'https://api.github.com/repos/owner/repo/dependabot/alerts/7'])
})
it('changes the execution revision for manifest, affected range, fix, dependency, severity and provider update changes', async () => {
  const original = await reconcileGithubDependabotAlert(fixture().options)
  if (original.decision !== 'trusted') throw new Error('fixture')
  const changes = [
    (value: ReturnType<typeof dependabotAlertFixture>) => { value.dependency.manifest_path = 'nested/package-lock.json' },
    (value: ReturnType<typeof dependabotAlertFixture>) => { value.security_vulnerability.vulnerable_version_range = '< 2.0.1'; value.security_advisory.vulnerabilities[0]!.vulnerable_version_range = '< 2.0.1' },
    (value: ReturnType<typeof dependabotAlertFixture>) => { value.security_vulnerability.first_patched_version.identifier = '2.0.1'; value.security_advisory.vulnerabilities[0]!.first_patched_version.identifier = '2.0.1' },
    (value: ReturnType<typeof dependabotAlertFixture>) => { value.dependency.package.name = value.security_vulnerability.package.name = value.security_advisory.vulnerabilities[0]!.package.name = 'different-package' },
    (value: ReturnType<typeof dependabotAlertFixture>) => { value.security_vulnerability.severity = value.security_advisory.vulnerabilities[0]!.severity = 'critical' },
    (value: ReturnType<typeof dependabotAlertFixture>) => { value.updated_at = '2026-09-06T12:00:01Z' },
    (value: ReturnType<typeof dependabotAlertFixture>) => { value.security_advisory.updated_at = '2026-09-06T11:00:00Z' },
  ]
  for (const change of changes) {
    const result = await reconcileGithubDependabotAlert(fixture(value => { change(value); return value }).options)
    expect(result.decision).toBe('trusted'); expect(result.decision === 'trusted' && result.sourceRevision).not.toBe(original.sourceRevision)
  }
})
it('requires registered sensor/rule authority rather than an apparent provider user or alert labels', async () => {
  const missing = fixture(); delete missing.options.registration.dependabot
  expect((await reconcileGithubDependabotAlert(missing.options)).diagnosticCode).toBe('DEPENDABOT_POLICY_REQUIRED'); expect(missing.requests).toHaveLength(0)
  const author = fixture(); if (author.options.route.source !== 'github') throw new Error('fixture'); author.options.route.bindings.authorIds = ['12', '999']
  expect((await reconcileGithubDependabotAlert(author.options)).diagnosticCode).toBe('DEPENDABOT_POLICY_REQUIRED')
  const rule = fixture(); rule.options.registration.dependabot!.ruleId = 'invented-rule'
  expect((await reconcileGithubDependabotAlert(rule.options)).diagnosticCode).toBe('DEPENDABOT_RULE_NOT_ALLOWED')
  const actor = fixture(); actor.options.observed.actorId = '999'
  expect((await reconcileGithubDependabotAlert(actor.options)).diagnosticCode).toBe('ACTOR_NOT_ALLOWED'); expect(actor.requests).toHaveLength(0)
})
it('denies closed or withdrawn alerts and mismatched authoritative alert identity', async () => {
  for (const state of ['fixed', 'dismissed', 'auto_dismissed']) expect((await reconcileGithubDependabotAlert(fixture(value => ({ ...value, state })).options)).diagnosticCode).toBe('DEPENDABOT_CLOSED')
  expect((await reconcileGithubDependabotAlert(fixture(value => ({ ...value, security_advisory: { ...value.security_advisory, withdrawn_at: '2026-09-06T12:00:00Z' } })).options)).diagnosticCode).toBe('DEPENDABOT_ADVISORY_WITHDRAWN')
  expect((await reconcileGithubDependabotAlert(fixture(value => ({ ...value, number: 8 })).options)).diagnosticCode).toBe('DEPENDABOT_ID_MISMATCH')
  const observed = fixture(); observed.options.observed.providerEntityId = '8'
  expect((await reconcileGithubDependabotAlert(observed.options)).diagnosticCode).toBe('DEPENDABOT_ID_MISMATCH'); expect(observed.requests).toHaveLength(0)
})
it('rejects package/advisory substitution, unsafe manifests, duplicate identities and impossible timestamp order', async () => {
  for (const change of [
    (value: ReturnType<typeof dependabotAlertFixture>) => ({ ...value, dependency: { ...value.dependency, package: { ...value.dependency.package, name: 'substituted' } } }),
    (value: ReturnType<typeof dependabotAlertFixture>) => ({ ...value, security_vulnerability: { ...value.security_vulnerability, vulnerable_version_range: 'different range' } }),
    (value: ReturnType<typeof dependabotAlertFixture>) => ({ ...value, dependency: { ...value.dependency, manifest_path: '../outside' } }),
    (value: ReturnType<typeof dependabotAlertFixture>) => ({ ...value, security_advisory: { ...value.security_advisory, identifiers: [...value.security_advisory.identifiers, value.security_advisory.identifiers[0]] } }),
    (value: ReturnType<typeof dependabotAlertFixture>) => ({ ...value, updated_at: '2020-01-01T00:00:00Z' }),
  ]) expect((await reconcileGithubDependabotAlert(fixture(change).options)).decision).toBe('unresolved')
})
it('represents a missing patched version honestly without asserting runnable reproduction or fix compatibility', async () => {
  const result = await reconcileGithubDependabotAlert(fixture(value => ({ ...value, security_vulnerability: { ...value.security_vulnerability, first_patched_version: null }, security_advisory: { ...value.security_advisory, vulnerabilities: value.security_advisory.vulnerabilities.map(item => ({ ...item, first_patched_version: null })) } })).options)
  expect(result.decision).toBe('trusted'); if (result.decision === 'trusted') expect(result.issue.advisory.availableFix).toBeNull()
})
it('uses shared bounded HTTP failures and mandatory secret redaction', async () => {
  const secret = await reconcileGithubDependabotAlert(fixture(value => ({ ...value, security_advisory: { ...value.security_advisory, description: 'fixture-installation-secret' } })).options)
  expect(secret.decision).toBe('trusted'); expect(JSON.stringify(secret)).not.toContain('fixture-installation-secret')
  for (const status of [302, 429, 503]) {
    const f = fixture(); f.options.transport = async () => new Response('sensitive-provider-failure', { status })
    const result = await reconcileGithubDependabotAlert(f.options)
    expect(result.decision).toBe('unresolved'); expect(JSON.stringify(result)).not.toContain('sensitive-provider-failure')
  }
  const large = fixture(); large.options.maxBodyBytes = 20
  expect((await reconcileGithubDependabotAlert(large.options)).decision).toBe('unresolved')
  const timed = fixture(); timed.options.requestTimeoutMs = 10; timed.options.transport = async () => new Promise<Response>(() => {})
  expect((await reconcileGithubDependabotAlert(timed.options)).diagnosticCode).toBe('REQUEST_TIMEOUT')
})

it('uses an exact custom host rule label without requiring webhook issue labels', async () => {
  const f = fixture(); if (f.options.route.source !== 'github') throw new Error('fixture')
  f.options.route.bindings.automationRules[0]!.automationLabel = 'repair dependencies'
  const result = await reconcileGithubDependabotAlert(f.options)
  expect(result.decision).toBe('trusted')
  if (result.decision === 'trusted') { expect(result.issue.labels).toEqual(['repair dependencies']); expect(result.provenance.automationLabel).toBe('repair dependencies') }
})
