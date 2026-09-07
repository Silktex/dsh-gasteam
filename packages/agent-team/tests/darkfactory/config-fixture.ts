import { enabledDarkFactoryConfigSchema } from '../../src/darkfactory/config.ts'

const secretRef = { kind: 'env', name: 'DF_TEST_SECRET' }
const caps = { dailyMoneyMicros: 100, monthlyMoneyMicros: 1000, dailyTokens: 100, monthlyTokens: 1000 }
const command = { id: 'test', executable: 'node', args: ['--test'], deadlineMs: 1000 }
export function policy() {
  return {
    enabled: true, projectIds: ['project'], policyRevision: 1, ownerId: 'operator',
    limits: { maxArtifactBytes: 1000, maxJournalRecordBytes: 65536, maxJournalBytes: 1048576, retentionDays: 30 },
    ingestion: { transport: { kind: 'listener', host: '127.0.0.1', port: 9100 }, routes: [{ id: 'route', projectId: 'project', source: 'github', providerVersion: 'v1', signingKeyId: 'ingress-key', secretRef, repositoryIds: ['repository'], senderIds: ['sender'], ruleIds: ['rule'], bindings: { installationIds: ['10'], authorIds: ['sender'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] } }], automationLabels: [{ label: 'automate', ruleId: 'rule' }], maxBodyBytes: 1000, requestsPerMinute: 10, maxQueueItems: 10, reconciliationIntervalMs: 1000 },
    verification: { ruleIds: ['rule'], checkIds: ['check'], fixtureIds: ['fixture'], sandbox: { cpuMillis: 1000, memoryBytes: 1000, maxProcesses: 10, diskBytes: 1000, deadlineMs: 1000, network: 'disabled' }, commands: [command], mutation: { language: 'typescript-javascript', applicablePaths: ['src'], threshold: 0.9, maxSurvivors: 0, deadlineMs: 1000 }, critics: { roleIds: ['critic'], minimumIndependentProviders: 2, maxRetries: 1, benchmarkRevision: 1 }, signer: { keyId: 'signer', secretRef }, trustedPublicKeys: [{ keyId: 'signer', algorithm: 'ed25519', publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=\n-----END PUBLIC KEY-----\n' }] },
    fleet: { redis: { endpoint: 'rediss://localhost:6379', tls: true, secretRef }, fleetId: 'fleet', hostId: 'host', fleetCaps: caps, projectCaps: [{ id: 'project', caps }], hostCaps: [{ id: 'host', caps }], requestCeiling: { moneyMicros: 10, inputTokens: 10, outputTokens: 10, reasoningTokens: 0, deadlineMs: 1000 }, attemptCeiling: { moneyMicros: 100, tokens: 100, requests: 10, deadlineMs: 10000 }, pricingSnapshots: [{ id: 'prices', digest: `sha256:${'a'.repeat(64)}`, currency: 'USD' }], quotas: [{ id: 'quota', provider: 'fixture', adapterId: 'fixture', secretRef, ttlMs: 1000 }], emergencyPurposes: ['canary-recovery'] },
    models: { endpoint: 'http://127.0.0.1:4000', version: 'v1', credentialRef: secretRef, refreshIntervalMs: 1000, expiryMs: 2000, roleThresholds: [{ roleId: 'critic', minimumScore: 0.9, benchmarkRevision: 1, requiredCapabilities: ['tools'] }], deploymentAllowlist: ['model'], deploymentDenylist: [], fallbacks: [{ roleId: 'critic', deploymentIds: ['model'] }] },
    notifications: { healthInbox: true, redaction: true, cooldownMs: 1000, maxRetries: 1, deadLetterLimit: 10, cardinalityCap: 10 },
  }
}

export function enabledPolicy() { return enabledDarkFactoryConfigSchema.parse(policy()) }
