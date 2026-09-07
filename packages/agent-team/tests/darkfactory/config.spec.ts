import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { darkFactoryConfigSchema, parseDarkFactoryConfig, preflightDarkFactory } from '../../src/darkfactory/config.ts'

import { policy } from './config-fixture.ts'

const host = { projects: [{ id: 'project', repositoryId: '/repo/.git', targetBranch: 'main', componentIds: ['web'] }], capabilities: [] }

describe('Dark Factory strict configuration', () => {
  it('defaults disabled without inspecting host prerequisites', () => {
    for (const input of [undefined, {}, { enabled: false }]) {
      const config = parseDarkFactoryConfig(input)
      expect(config).toEqual({ schemaVersion: 1, enabled: false })
      expect(preflightDarkFactory(config, new Proxy(host, { get() { throw new Error('Must not inspect host') } }))).toEqual({ ok: true, diagnostics: [] })
    }
  })
  it('validates all enabled sections and applies conservative defaults', () => {
    const config = parseDarkFactoryConfig(policy())
    expect(config).toMatchObject({ enabled: true, mode: 'observe', schemaVersion: 1, delivery: { enabled: false }, fleet: { routineWatermark: 0.95, reserveFraction: 0.1 }, models: { compression: { enabled: false } } })
    expect(darkFactoryConfigSchema.safeParse(config).success).toBe(true)
    for (const section of ['limits', 'ingestion', 'verification', 'fleet', 'models', 'notifications']) {
      const input: Record<string, unknown> = policy()
      delete input[section]
      expect(() => parseDarkFactoryConfig(input), section).toThrow('Invalid Dark Factory configuration')
    }
  })
  it('rejects ambiguous JSON, unknown versions, unknown fields, secret-bearing endpoints and non-finite values without leaking input', () => {
    const marker = 'sensitive-secret'
    const invalid = [
      '{"enabled":false,"enabled":true}', { schemaVersion: 2, enabled: false, [marker]: marker },
      { enabled: false, [marker]: marker }, { ...policy(), [marker]: marker },
      { ...policy(), models: { ...policy().models, endpoint: `https://${marker}:password@example.test` } },
      { ...policy(), limits: { ...policy().limits, maxArtifactBytes: Infinity } },
    ]
    for (const input of invalid) {
      let error: unknown
      try { parseDarkFactoryConfig(input) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(marker)
    }
    expect(() => parseDarkFactoryConfig({ schemaVersion: 2 })).toThrow('migrate offline')
  })
  it('rejects invalid thresholds, empty trust, quotas, cross-project refs and inconsistent ceilings', () => {
    const invalid = [
      { ...policy(), verification: { ...policy().verification, trustedPublicKeys: [] } },
      { ...policy(), verification: { ...policy().verification, mutation: { ...policy().verification.mutation, threshold: 1.01 } } },
      { ...policy(), fleet: { ...policy().fleet, routineWatermark: 0.99 } },
      { ...policy(), fleet: { ...policy().fleet, reserveFraction: 0.01 } },
      { ...policy(), fleet: { ...policy().fleet, quotas: [{ ...policy().fleet.quotas[0], provider: 'unsupported' }] } },
      { ...policy(), projectIds: ['other'] },
      { ...policy(), fleet: { ...policy().fleet, attemptCeiling: { ...policy().fleet.attemptCeiling, tokens: 1 } } },
      { ...policy(), mode: 'production' },
    ]
    for (const input of invalid) expect(() => parseDarkFactoryConfig(input)).toThrow('Invalid Dark Factory configuration')
  })
  it('requires an explicit scanner sender, unique rule mapping and bounded start/page configuration', () => {
    const input = policy(), route = input.ingestion.routes[0]!
    const configured = { ...input, ingestion: { ...input.ingestion, routes: [{ ...route, senderIds: [...route.senderIds, 'host-scanner:repo'],
      reconciliation: { installationId: '10', repositoryId: 'repository', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'GITHUB_READ_TOKEN' }, credentialKind: 'installation-token',
        scan: { scannerId: 'host-scanner:repo', ruleId: 'rule', initialSince: '2026-09-01T00:00:00.000Z' } },
    }] } }
    expect(parseDarkFactoryConfig(configured).enabled).toBe(true)
    for (const patch of [{ scannerId: '12' }, { scannerId: 'host-scanner:unregistered' }, { ruleId: 'unknown' }, { initialSince: 'yesterday' }, { maxPages: 11 }, { secret: 'PRIVATE_SCANNER_SECRET' }]) {
      const changed = structuredClone(configured)
      Object.assign(changed.ingestion.routes[0]!.reconciliation.scan, patch)
      expect(() => parseDarkFactoryConfig(changed)).toThrow('Invalid Dark Factory configuration')
    }
    const changed = structuredClone(configured)
    changed.ingestion.routes[0]!.bindings.automationRules.push({ ...changed.ingestion.routes[0]!.bindings.automationRules[0]! })
    expect(() => parseDarkFactoryConfig(changed)).toThrow('Invalid Dark Factory configuration')
  })
  it('binds optional reconciliation to configured repositories, installations and fixed provider origins', () => {
    const registration = { installationId: '10', repositoryId: 'repository', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'GITHUB_READ_TOKEN' }, credentialKind: 'installation-token' }
    const input = policy()
    const route = input.ingestion.routes[0]!
    const configured = { ...input, ingestion: { ...input.ingestion, routes: [{ ...route, reconciliation: registration }] } }
    expect(parseDarkFactoryConfig(configured).enabled).toBe(true)
    for (const patch of [{ repositoryId: 'other' }, { installationId: 'other' }, { apiBaseUrl: 'https://api.github.com.evil.invalid' }, { apiBaseUrl: 'http://127.0.0.1:9000' }, { repositoryName: '../escape' }, { apiBaseUrl: 'https://secret@example.test' }]) {
      expect(() => parseDarkFactoryConfig({ ...configured, ingestion: { ...configured.ingestion, routes: [{ ...route, reconciliation: { ...registration, ...patch } }] } })).toThrow('Invalid Dark Factory configuration')
    }
  })
  it('rejects a private key masquerading as a public trust root', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const input = policy()
    input.verification.trustedPublicKeys[0]!.publicKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => parseDarkFactoryConfig(input)).toThrow('Invalid Dark Factory configuration')
  })
  it('requires an explicit registered Dependabot sensor principal and unambiguous automation rule', () => {
    const input = policy(), route = input.ingestion.routes[0]!
    const configuredRoute = { ...route, bindings: { ...route.bindings, authorIds: [...route.bindings.authorIds, 'host-sensor:dependabot'] },
      reconciliation: { installationId: '10', repositoryId: 'repository', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'GITHUB_READ_TOKEN' },
        credentialKind: 'installation-token', dependabot: { sensorPrincipalId: 'host-sensor:dependabot', ruleId: 'rule' } },
    }
    const configured = { ...input, ingestion: { ...input.ingestion, routes: [configuredRoute] } }
    expect(parseDarkFactoryConfig(configured).enabled).toBe(true)
    for (const patch of [{ sensorPrincipalId: 'sender' }, { sensorPrincipalId: 'host-sensor:unknown' }, { sensorPrincipalId: 'host-sensor:' }, { ruleId: 'unknown' }, { credential: 'PRIVATE_SENTINEL' }]) {
      expect(() => parseDarkFactoryConfig({ ...configured, ingestion: { ...configured.ingestion, routes: [{ ...configuredRoute,
        reconciliation: { ...configuredRoute.reconciliation, dependabot: { ...configuredRoute.reconciliation.dependabot, ...patch } },
      }] } })).toThrow(/^Invalid Dark Factory configuration: policy schema or reference validation failed$/)
    }
    configuredRoute.bindings.automationRules.push({ ...configuredRoute.bindings.automationRules[0]! })
    expect(() => parseDarkFactoryConfig(configured)).toThrow('Invalid Dark Factory configuration')
  })
  it('validates Sentry and APM reconciliation configuration against route bindings and origins', () => {
    const sentryReg = {
      installationId: '10', organizationId: '20', organizationSlug: 'acme', providerProjectId: '42', projectSlug: 'service',
      repositoryId: 'repository', repositoryName: 'owner/repo', sensorPrincipalId: 'host-sensor:sentry', productionEnvironmentId: 'production',
      credentialRef: { kind: 'env', name: 'SENTRY_TOKEN' }, credentialKind: 'api-token',
    }
    const sentryRoute = {
      id: 'sentry-route', projectId: 'project', source: 'sentry', providerVersion: 'sentry-v1', signingKeyId: 'key',
      secretRef: { kind: 'env', name: 'SENTRY_WEBHOOK_SECRET' }, repositoryIds: ['repository'], senderIds: ['sender'], ruleIds: ['rule'],
      bindings: {
        installationIds: ['10'], organizationIds: ['20'], providerProjects: [{ id: '42', slug: 'service', organizationId: '20' }],
        environments: [{ providerEnvironment: 'production', environmentId: 'production' }],
        ruleMappings: [{ ruleId: 'rule', automationLabel: 'automate', resource: 'issue', providerRule: null }],
      },
      reconciliation: sentryReg,
    }
    const apmReg = {
      apiBaseUrl: 'https://apm-api.example.test',
      providerProjectId: 'service', senderId: 'sender', repositoryId: 'repository', repositoryName: 'owner/repo',
      sensorPrincipalId: 'host-sensor:apm', productionEnvironmentId: 'production',
      publicSourceBaseUrl: 'https://apm.example.test', credentialRef: { kind: 'env', name: 'APM_TOKEN' }, credentialKind: 'api-token',
    }
    const apmRoute = {
      id: 'apm-route', projectId: 'project', source: 'apm', providerVersion: 'gasteam-v1', signingKeyId: 'key',
      secretRef: { kind: 'env', name: 'APM_WEBHOOK_SECRET' }, repositoryIds: ['repository'], senderIds: ['sender'], ruleIds: ['rule'],
      bindings: {
        providerProjectIds: ['service'],
        environments: [{ providerEnvironment: 'prod', environmentId: 'production' }],
        ruleMappings: [{ ruleId: 'rule', automationLabel: 'automate', providerRule: 'alert-rule' }],
      },
      reconciliation: apmReg,
    }
    const base = policy()
    expect(parseDarkFactoryConfig({ ...base, ingestion: { ...base.ingestion, routes: [sentryRoute] } }).enabled).toBe(true)
    expect(parseDarkFactoryConfig({ ...base, ingestion: { ...base.ingestion, routes: [apmRoute] } }).enabled).toBe(true)

    for (const patch of [
      { installationId: 'unregistered' }, { organizationId: 'unregistered' }, { providerProjectId: 'unregistered' },
      { projectSlug: 'unregistered' }, { productionEnvironmentId: 'unregistered' }, { repositoryId: 'unregistered' },
      { apiBaseUrl: 'http://127.0.0.1:8080' }, { credentialKind: 'installation-token' },
    ]) {
      const invalid = structuredClone(sentryRoute)
      Object.assign(invalid.reconciliation, patch)
      expect(() => parseDarkFactoryConfig({ ...base, ingestion: { ...base.ingestion, routes: [invalid] } })).toThrow('Invalid Dark Factory configuration')
    }

    for (const patch of [
      { providerProjectId: 'unregistered' }, { senderId: 'unregistered' }, { productionEnvironmentId: 'unregistered' },
      { repositoryId: 'unregistered' }, { publicSourceBaseUrl: 'ftp://evil.test' }, { apiBaseUrl: 'http://127.0.0.1:8080' },
    ]) {
      const invalid = structuredClone(apmRoute)
      Object.assign(invalid.reconciliation, patch)
      expect(() => parseDarkFactoryConfig({ ...base, ingestion: { ...base.ingestion, routes: [invalid] } })).toThrow('Invalid Dark Factory configuration')
    }
  })
  it('permits observe custody only with registered host prerequisites and keeps build fail-closed', () => {
    const config = parseDarkFactoryConfig(policy())
    const result = preflightDarkFactory(config, host)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map(item => item.code)).toContain('CAPABILITY_MISSING')
    const capableHost = { ...host, capabilities: ['project-ownership', 'ingestion', 'secret-resolution', 'policy-journal', 'ingress-scope', 'redaction', 'health-inbox'] }
    expect(preflightDarkFactory(config, capableHost)).toEqual({ ok: true, diagnostics: [] })
    const build = preflightDarkFactory(parseDarkFactoryConfig({ ...policy(), mode: 'build' }), capableHost)
    expect(build.diagnostics).toContainEqual(expect.objectContaining({ code: 'RUNTIME_UNIMPLEMENTED' }))
    expect(build.diagnostics).toContainEqual(expect.objectContaining({ code: 'QUOTA_ADAPTER_UNSUPPORTED' }))
  })
  it('checks production gates, deployment reversal and component ownership using host evidence', () => {
    const input = {
      ...policy(), mode: 'production',
      delivery: {
        enabled: true,
        environments: [{ id: 'production', projectId: 'project', componentIds: ['unknown'], publicationGrantRefs: ['grant'] }],
        adapter: { endpoint: 'https://deploy.example.test', version: 'v1', keyId: 'signer', secretRef: { kind: 'env', name: 'DEPLOY_KEY' } },
        artifactBuilder: { id: 'build', executable: 'node', args: ['build.mjs'], deadlineMs: 1000 },
        deadlines: { requestMs: 10000, completionMs: 600000, maxSubmissions: 3 },
        canary: { trafficFraction: 0.05, baselineWindowMs: 900000, pollIntervalMs: 60000, sampleWindowMs: 60000, minRequestsPerWindow: 100, minTotalRequests: 1000, freshnessMs: 120000, absoluteErrorRate: 0.01, relativeErrorIncrease: 0.25, minimumErrorIncrease: 0.002, absoluteP99Ms: 1000, relativeP99Increase: 0.25, minimumP99IncreaseMs: 100, consecutiveBreaches: 3, observationWindows: 15, observationDeadlineMs: 1800000, promotionWindows: 5, promotionDeadlineMs: 600000 },
        rollback: { enabled: true, immutablePriorArtifactRequired: true, deadlineMs: 600000, verificationCheckIds: ['check'] },
        telemetry: [{ id: 'errors', endpoint: 'https://telemetry.example.test', query: 'fixed_query', keyId: 'signer', secretRef: { kind: 'env', name: 'TELEMETRY_KEY' } }],
      },
    }
    const result = preflightDarkFactory(parseDarkFactoryConfig(input), host)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'PRODUCTION_GATES_MISSING' }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPONENT_OWNERSHIP_AMBIGUOUS' }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CAPABILITY_MISSING', message: 'Required host capability unavailable: reverse-deployment' }))
    expect(() => parseDarkFactoryConfig({ ...input, gateReceipts: ['goal-5'] })).toThrow('Invalid Dark Factory configuration')
    input.delivery.rollback.enabled = false
    expect(() => parseDarkFactoryConfig(input)).toThrow('Invalid Dark Factory configuration')
  })
  it('reports missing registered projects and duplicate repository ownership', () => {
    const config = parseDarkFactoryConfig(policy())
    expect(preflightDarkFactory(config, { ...host, projects: [] }).diagnostics).toContainEqual(expect.objectContaining({ code: 'PROJECT_UNREGISTERED' }))
    const input = policy()
    input.projectIds.push('other')
    input.fleet.projectCaps.push({ id: 'other', caps: input.fleet.fleetCaps })
    input.ingestion.routes.push({ ...input.ingestion.routes[0]!, id: 'other-route', projectId: 'other' })
    expect(preflightDarkFactory(parseDarkFactoryConfig(input), { ...host, projects: [...host.projects, { ...host.projects[0]!, id: 'other' }] }).diagnostics).toContainEqual(expect.objectContaining({ code: 'PROJECT_OWNERSHIP_AMBIGUOUS' }))
  })
})
