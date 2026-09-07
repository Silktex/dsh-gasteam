import { describe, expect, it } from 'vitest'
import { assessIngressScope } from '../../src/darkfactory/ingress-scope.ts'
import { ingressPolicyRouteSchema, parseDarkFactoryConfig } from '../../src/darkfactory/config.ts'
import { normalizedIngressFactsSchema, type NormalizedIngressFacts } from '../../src/darkfactory/ingress-adapters.ts'
import { enabledPolicy, policy } from './config-fixture.ts'

function github() { return enabledPolicy().ingestion.routes[0]! }
function facts(overrides: Partial<NormalizedIngressFacts> = {}): NormalizedIngressFacts {
  return normalizedIngressFactsSchema.parse({ sourceEntityId: 'opaque-entity', providerEntityId: 'provider-entity', trust: 'unresolved', invalidatesPending: false,
    installationId: '10', repositoryId: 'repository', repositoryName: 'example/repo', organizationId: null, providerProjectIds: [], authorId: 'sender', actorId: 'sender', ruleIds: [],
    title: 'Issue', context: '', labels: ['automate'], providerRevision: 'v1', observationDigest: `sha256:${'a'.repeat(64)}`, nativeProviderTimestamp: null, nativeTimestampAuthenticated: false,
    details: { kind: 'issue', number: 1, state: 'open' }, ...overrides })
}
function sentry() { return ingressPolicyRouteSchema.parse({ ...github(), source: 'sentry', bindings: {
  installationIds: ['10'], organizationIds: ['organization'], providerProjects: [{ id: '42', slug: 'service', organizationId: 'organization' }],
  environments: [{ providerEnvironment: 'prod-us', environmentId: 'production' }],
  ruleMappings: [{ resource: 'event_alert', providerRule: 'Very Important Alert!', ruleId: 'rule', automationLabel: 'automate' }, { resource: 'metric_alert', providerRule: '7', ruleId: 'rule', automationLabel: 'automate' }, { resource: 'issue', providerRule: null, ruleId: 'rule', automationLabel: 'automate' }],
} }) }
function sentryFacts(overrides: Partial<NormalizedIngressFacts> = {}) { return facts({ repositoryId: null, repositoryName: null, authorId: null, labels: [], providerProjectIds: ['42'], ruleIds: ['Very Important Alert!'], details: { kind: 'sentry_issue', status: 'unresolved', environment: 'prod-us', release: 'v1', eventId: 'event', exceptions: [] }, ...overrides }) }
function apm() { return ingressPolicyRouteSchema.parse({ ...github(), source: 'apm', bindings: { providerProjectIds: ['service'], environments: [{ providerEnvironment: 'prod-us', environmentId: 'production' }], ruleMappings: [{ providerRule: 'upstream-rule', ruleId: 'rule', automationLabel: 'automate' }] } }) }
function apmFacts(overrides: Partial<NormalizedIngressFacts> = {}) { return facts({ installationId: null, repositoryId: null, repositoryName: null, authorId: null, providerProjectIds: ['service'], ruleIds: ['upstream-rule'], labels: [], details: { kind: 'apm', fingerprint: 'alert', environment: 'prod-us', observationWindow: { start: '2026-09-06T12:00:00Z', end: '2026-09-06T12:01:00Z' }, commit: null, release: null, metrics: [{ name: 'errors', value: 4, unit: 'count' }], evidence: [] }, ...overrides }) }

describe('source-bound ingress policy', () => {
  it('requires explicit matching host binding and automation mappings in enabled policy', () => {
    const input = policy()
    expect(() => parseDarkFactoryConfig(input)).not.toThrow()
    expect(() => parseDarkFactoryConfig({ ...input, ingestion: { ...input.ingestion, routes: [{ ...input.ingestion.routes[0], bindings: undefined }] } })).toThrow('Invalid Dark Factory configuration')
    input.ingestion.routes[0]!.bindings.automationRules[0]!.automationLabel = 'unregistered-label'
    expect(() => parseDarkFactoryConfig(input)).toThrow('Invalid Dark Factory configuration')
    const base = policy()
    for (const route of [sentry(), apm()]) expect(() => parseDarkFactoryConfig({ ...base, ingestion: { ...base.ingestion, routes: [route] } })).not.toThrow()
    const invalidSentry = sentry()
    if (invalidSentry.source !== 'sentry') throw new Error('fixture')
    invalidSentry.bindings.providerProjects[0]!.organizationId = 'unregistered-organization'
    expect(() => parseDarkFactoryConfig({ ...base, ingestion: { ...base.ingestion, routes: [invalidSentry] } })).toThrow('Invalid Dark Factory configuration')
  })
  it('requires Git installation, repository, initiating actor, author and current configured automation label independently', () => {
    expect(assessIngressScope(github(), facts())).toEqual({ eligibleForReconciliation: true, reasons: ['PROVIDER_RECONCILIATION_REQUIRED'] })
    for (const [field, value, reason] of [
      ['installationId', 'other', 'INSTALLATION_NOT_ALLOWED'], ['repositoryId', 'other', 'REPOSITORY_NOT_ALLOWED'],
      ['actorId', 'other', 'ACTOR_NOT_ALLOWED'], ['authorId', 'other', 'AUTHOR_NOT_ALLOWED'], ['labels', ['unregistered'], 'AUTOMATION_LABEL_MISSING'],
    ] as const) expect(assessIngressScope(github(), facts({ [field]: value }))).toMatchObject({ eligibleForReconciliation: false, reasons: [reason] })
    expect(assessIngressScope(github(), facts({ invalidatesPending: true }))).toMatchObject({ eligibleForReconciliation: false, reasons: ['SOURCE_INVALIDATED'] })
  })
  it('uses host Dependabot automation without fabricating issue authors or labels', () => {
    const observation = facts({ authorId: null, labels: [], details: { kind: 'dependabot_alert', number: 1, state: 'open', dependency: 'package', ecosystem: 'npm', manifestPath: 'package-lock.json', affectedRange: '<2', availableFix: '2', ghsa: 'GHSA-example', cve: null, identifiers: [] } })
    expect(assessIngressScope(github(), observation).eligibleForReconciliation).toBe(true)
    expect(assessIngressScope(github(), { ...observation, actorId: 'unregistered' }).reasons).toContain('ACTOR_NOT_ALLOWED')
  })
  it('distinguishes Sentry projects from Git repos and maps event rule labels explicitly', () => {
    expect(assessIngressScope(sentry(), sentryFacts()).eligibleForReconciliation).toBe(true)
    expect(assessIngressScope(sentry(), sentryFacts({ providerProjectIds: ['repository'] })).reasons).toContain('PROVIDER_PROJECT_NOT_ALLOWED')
    expect(assessIngressScope(sentry(), sentryFacts({ ruleIds: ['rule'] })).reasons).toContain('AUTOMATION_RULE_NOT_ALLOWED')
    expect(assessIngressScope(sentry(), sentryFacts({ organizationId: 'other' })).reasons).toContain('ORGANIZATION_NOT_ALLOWED')
    const observation = sentryFacts()
    if (observation.details.kind !== 'sentry_issue') throw new Error('fixture')
    observation.details.environment = 'staging'
    expect(assessIngressScope(sentry(), observation).reasons).toContain('ENVIRONMENT_NOT_ALLOWED')
  })
  it('keeps missing native issue environment unresolved for reconciliation and never defaults to production', () => {
    const observation = sentryFacts({ ruleIds: [], details: { kind: 'sentry_issue', status: 'unresolved', eventId: null, environment: null, release: null, exceptions: [] } })
    expect(assessIngressScope(sentry(), observation)).toEqual({ eligibleForReconciliation: true, reasons: ['PROVIDER_RECONCILIATION_REQUIRED', 'ENVIRONMENT_RECONCILIATION_REQUIRED'] })
    expect(observation.details).toMatchObject({ environment: null })
  })
  it('matches metric project slugs, incident organization and numeric rule selector', () => {
    const observation = sentryFacts({ organizationId: 'organization', providerProjectIds: ['service'], ruleIds: ['7'], details: { kind: 'sentry_metric', environment: 'prod-us', aggregate: 'count()', query: 'level:error', windowMinutes: 10, startedAt: '2026-09-06T12:00:00Z', closedAt: null } })
    expect(assessIngressScope(sentry(), observation).eligibleForReconciliation).toBe(true)
    expect(assessIngressScope(sentry(), { ...observation, providerProjectIds: ['42'] }).reasons).toContain('PROVIDER_PROJECT_NOT_ALLOWED')
    expect(assessIngressScope(sentry(), { ...observation, organizationId: 'other' }).reasons).toContain('ORGANIZATION_NOT_ALLOWED')
  })
  it('requires APM sender, provider project, environment and upstream rule mapping without granting trust', () => {
    const observation = apmFacts()
    expect(assessIngressScope(apm(), observation)).toEqual({ eligibleForReconciliation: true, reasons: ['PROVIDER_RECONCILIATION_REQUIRED'] })
    expect(observation.trust).toBe('unresolved')
    for (const override of [{ actorId: 'other' }, { providerProjectIds: ['repository'] }, { ruleIds: ['rule'] }]) expect(assessIngressScope(apm(), apmFacts(override)).eligibleForReconciliation).toBe(false)
    expect(assessIngressScope(github(), observation).reasons).toContain('SOURCE_KIND_MISMATCH')
  })
  it('permits configured Sentry and APM resolution observations to proceed to authoritative reconciliation while denying unconfigured routes', () => {
    const sentryReg = {
      installationId: '10', organizationId: 'organization', organizationSlug: 'acme', providerProjectId: '42', projectSlug: 'service',
      repositoryId: 'repository', repositoryName: 'owner/repo', sensorPrincipalId: 'host-sensor:sentry', productionEnvironmentId: 'production',
      credentialRef: { kind: 'env', name: 'SENTRY_TOKEN' }, credentialKind: 'api-token' as const,
    }
    const configuredSentry = { ...sentry(), reconciliation: sentryReg }
    const resolvedSentry = sentryFacts({ invalidatesPending: true })
    expect(assessIngressScope(configuredSentry, resolvedSentry)).toEqual({ eligibleForReconciliation: true, reasons: ['PROVIDER_RECONCILIATION_REQUIRED'] })
    expect(assessIngressScope(sentry(), resolvedSentry)).toMatchObject({ eligibleForReconciliation: false, reasons: ['SOURCE_INVALIDATED'] })

    const apmReg = {
      apiBaseUrl: 'https://apm-api.example.test',
      providerProjectId: 'service', senderId: 'sender', repositoryId: 'repository', repositoryName: 'owner/repo',
      sensorPrincipalId: 'host-sensor:apm', productionEnvironmentId: 'production',
      publicSourceBaseUrl: 'https://apm.example.test', credentialRef: { kind: 'env', name: 'APM_TOKEN' }, credentialKind: 'api-token' as const,
    }
    const configuredApm = { ...apm(), reconciliation: apmReg }
    const resolvedApm = apmFacts({ invalidatesPending: true })
    expect(assessIngressScope(configuredApm, resolvedApm)).toEqual({ eligibleForReconciliation: true, reasons: ['PROVIDER_RECONCILIATION_REQUIRED'] })
    expect(assessIngressScope(apm(), resolvedApm)).toMatchObject({ eligibleForReconciliation: false, reasons: ['SOURCE_INVALIDATED'] })
  })
})
