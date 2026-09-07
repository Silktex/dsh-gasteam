import z from 'zod'
import { createPublicKey } from 'node:crypto'
import { counterSchema, digestSchema, httpsUrlSchema, idSchema, revisionSchema, safePathSchema, secretRefSchema, timestampSchema, uniqueIds } from './contracts/common.ts'
import { canonicalJson, parseStrictJson } from './json.ts'

const positive = counterSchema.min(1)
const ratio = z.number().min(0).max(1)
const ids = () => uniqueIds().min(1)
const bounded = <T extends z.ZodType>(schema: T) => z.array(schema).min(1).max(256)
const endpoint = z.url().max(2048).refine(value => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
}, { message: 'Expected credential-free HTTPS or loopback HTTP endpoint' })
const command = z.strictObject({ id: idSchema, executable: z.string().min(1).max(1024), args: z.array(z.string().max(4096)).max(128), deadlineMs: positive })
const cap = z.strictObject({ dailyMoneyMicros: positive, monthlyMoneyMicros: positive, dailyTokens: positive, monthlyTokens: positive })
  .refine(value => value.monthlyMoneyMicros >= value.dailyMoneyMicros && value.monthlyTokens >= value.dailyTokens)
const scopedCap = z.strictObject({ id: idSchema, caps: cap })
const automationRule = z.strictObject({ ruleId: idSchema, automationLabel: z.string().min(1).max(128) })
const environmentBinding = z.strictObject({ providerEnvironment: z.string().min(1).max(128), environmentId: idSchema })
const routeFields = { id: idSchema, projectId: idSchema, providerVersion: idSchema, signingKeyId: idSchema, secretRef: secretRefSchema, repositoryIds: ids(), senderIds: ids(), ruleIds: ids() }
export const githubReconciliationRegistrationSchema = z.strictObject({
  apiBaseUrl: endpoint.default('https://api.github.com'),
  installationId: idSchema, repositoryId: idSchema,
  repositoryName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/).max(256),
  credentialRef: secretRefSchema, credentialKind: z.literal('installation-token'),
  fixtureLoopback: z.boolean().default(false),
  scan: z.strictObject({
    scannerId: idSchema.regex(/^host-scanner:[A-Za-z0-9][A-Za-z0-9_.:-]*$/), ruleId: idSchema,
    initialSince: timestampSchema, maxPages: positive.max(10).default(10),
  }).optional(),
  dependabot: z.strictObject({
    sensorPrincipalId: idSchema.regex(/^host-sensor:[A-Za-z0-9][A-Za-z0-9_.:-]*$/), ruleId: idSchema,
  }).optional(),
}).superRefine((value, ctx) => {
  const url = new URL(value.apiBaseUrl)
  const valid = value.fixtureLoopback
    ? url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/'
    : value.apiBaseUrl === 'https://api.github.com'
  if (!valid) ctx.addIssue({ code: 'custom', message: 'GitHub reconciliation requires the official API or an explicit loopback fixture' })
})
const monitoringOrigin = endpoint.refine(value => new URL(value).pathname === '/', { message: 'Monitoring API requires an origin without a path' })
const publicMonitoringOrigin = monitoringOrigin.refine(value => new URL(value).protocol === 'https:')
const monitoringFields = {
  apiBaseUrl: monitoringOrigin, fixtureLoopback: z.boolean().default(false), credentialRef: secretRefSchema, credentialKind: z.literal('api-token'),
  repositoryId: idSchema, repositoryName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/).max(256),
  sensorPrincipalId: idSchema.regex(/^host-sensor:[A-Za-z0-9][A-Za-z0-9_.:-]*$/), productionEnvironmentId: idSchema,
  maxAgeMs: positive.max(3600000).default(300000),
}
function monitoringEndpoint(value: { apiBaseUrl: string; fixtureLoopback: boolean }, ctx: z.RefinementCtx) {
  const url = new URL(value.apiBaseUrl)
  if (value.fixtureLoopback ? url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) : url.protocol !== 'https:')
    ctx.addIssue({ code: 'custom', message: 'Monitoring APIs require HTTPS or an explicit loopback fixture' })
}
export const sentryReconciliationRegistrationSchema = z.strictObject({ ...monitoringFields,
  apiBaseUrl: monitoringOrigin.default('https://sentry.io'), publicSourceBaseUrl: publicMonitoringOrigin.default('https://sentry.io'),
  installationId: idSchema, organizationId: idSchema, organizationSlug: idSchema, providerProjectId: idSchema, projectSlug: idSchema,
}).superRefine(monitoringEndpoint)
export const apmReconciliationRegistrationSchema = z.strictObject({ ...monitoringFields, publicSourceBaseUrl: publicMonitoringOrigin,
  providerProjectId: idSchema, senderId: idSchema,
}).superRefine(monitoringEndpoint)
export const ingressPolicyRouteSchema = z.discriminatedUnion('source', [
  z.strictObject({ ...routeFields, source: z.literal('github'), reconciliation: githubReconciliationRegistrationSchema.optional(), bindings: z.strictObject({ installationIds: ids(), authorIds: ids(), automationRules: bounded(automationRule) }) }),
  z.strictObject({ ...routeFields, source: z.literal('sentry'), reconciliation: sentryReconciliationRegistrationSchema.optional(), bindings: z.strictObject({
    installationIds: ids(), organizationIds: ids(),
    providerProjects: bounded(z.strictObject({ id: idSchema, slug: idSchema, organizationId: idSchema })),
    environments: bounded(environmentBinding),
    ruleMappings: bounded(automationRule.extend({ resource: z.enum(['issue', 'event_alert', 'metric_alert']), providerRule: z.string().min(1).max(1024).nullable() })),
  }) }),
  z.strictObject({ ...routeFields, source: z.literal('apm'), reconciliation: apmReconciliationRegistrationSchema.optional(), bindings: z.strictObject({
    providerProjectIds: ids(), environments: bounded(environmentBinding),
    ruleMappings: bounded(automationRule.extend({ providerRule: idSchema })),
  }) }),
  z.strictObject({ ...routeFields, source: z.literal('maintenance'), bindings: z.strictObject({ scannerIds: ids(), automationRules: bounded(automationRule) }) }),
])
export type IngressPolicyRoute = z.output<typeof ingressPolicyRouteSchema>
const ingestion = z.strictObject({
  transport: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('listener'), host: z.enum(['127.0.0.1', '::1']), port: counterSchema.max(65535) }),
    z.strictObject({ kind: z.literal('gateway'), endpoint }),
  ]),
  routes: bounded(ingressPolicyRouteSchema),
  automationLabels: bounded(z.strictObject({ label: z.string().min(1).max(128), ruleId: idSchema })),
  maxBodyBytes: positive.max(16_777_216), requestsPerMinute: positive, maxQueueItems: positive.max(100_000), reconciliationIntervalMs: positive,
})
const verification = z.strictObject({
  ruleIds: ids(), checkIds: ids(), fixtureIds: ids(),
  sandbox: z.strictObject({ cpuMillis: positive, memoryBytes: positive, maxProcesses: positive, diskBytes: positive, deadlineMs: positive, network: z.literal('disabled') }),
  commands: bounded(command),
  mutation: z.strictObject({ language: z.literal('typescript-javascript'), applicablePaths: bounded(safePathSchema), threshold: ratio, maxSurvivors: counterSchema, deadlineMs: positive }),
  critics: z.strictObject({ roleIds: ids(), minimumIndependentProviders: positive.min(2), maxRetries: counterSchema.max(1), benchmarkRevision: revisionSchema }),
  signer: z.strictObject({ keyId: idSchema, secretRef: secretRefSchema }),
  trustedPublicKeys: bounded(z.strictObject({ keyId: idSchema, algorithm: z.literal('ed25519'), publicKey: z.string().min(1).max(4096).refine(value => {
    try { return /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(value) && createPublicKey(value).asymmetricKeyType === 'ed25519' } catch { return false }
  }) })),
})
const canary = z.strictObject({
  trafficFraction: ratio.gt(0).lt(1), baselineWindowMs: positive, pollIntervalMs: positive, sampleWindowMs: positive,
  minRequestsPerWindow: positive, minTotalRequests: positive, freshnessMs: positive,
  absoluteErrorRate: ratio, relativeErrorIncrease: ratio, minimumErrorIncrease: ratio,
  absoluteP99Ms: positive, relativeP99Increase: ratio, minimumP99IncreaseMs: positive,
  consecutiveBreaches: positive, observationWindows: positive, observationDeadlineMs: positive,
  promotionWindows: positive, promotionDeadlineMs: positive,
}).refine(value => value.minTotalRequests >= value.minRequestsPerWindow &&
  value.observationDeadlineMs >= value.observationWindows * value.sampleWindowMs &&
  value.promotionDeadlineMs >= value.promotionWindows * value.sampleWindowMs &&
  value.baselineWindowMs >= value.sampleWindowMs)
const delivery = z.union([
  z.strictObject({ enabled: z.literal(false).default(false) }),
  z.strictObject({
    enabled: z.literal(true),
    environments: bounded(z.strictObject({ id: idSchema, projectId: idSchema, componentIds: ids(), publicationGrantRefs: ids() })),
    adapter: z.strictObject({ endpoint, version: idSchema, keyId: idSchema, secretRef: secretRefSchema }),
    artifactBuilder: command,
    deadlines: z.strictObject({ requestMs: positive, completionMs: positive, maxSubmissions: positive.max(3) }),
    canary,
    rollback: z.strictObject({ enabled: z.literal(true), immutablePriorArtifactRequired: z.literal(true), deadlineMs: positive, verificationCheckIds: ids() }),
    telemetry: bounded(z.strictObject({ id: idSchema, endpoint, query: z.string().min(1).max(4096), keyId: idSchema, secretRef: secretRefSchema })),
  }),
]).default({ enabled: false })
const fleet = z.strictObject({
  redis: z.strictObject({ endpoint: z.url().max(2048).refine(value => {
    const url = new URL(value)
    return url.protocol === 'rediss:' && !url.username && !url.password && !url.search && !url.hash
  }), tls: z.literal(true), secretRef: secretRefSchema }),
  fleetId: idSchema, hostId: idSchema, fleetCaps: cap, projectCaps: bounded(scopedCap), hostCaps: bounded(scopedCap),
  requestCeiling: z.strictObject({ moneyMicros: positive, inputTokens: positive, outputTokens: positive, reasoningTokens: counterSchema, deadlineMs: positive }),
  attemptCeiling: z.strictObject({ moneyMicros: positive, tokens: positive, requests: positive, deadlineMs: positive }),
  pricingSnapshots: bounded(z.strictObject({ id: idSchema, digest: digestSchema, currency: z.literal('USD') })),
  routineWatermark: ratio.gt(0).max(0.95).default(0.95), reserveFraction: ratio.min(0.1).lt(1).default(0.1),
  quotas: bounded(z.strictObject({ id: idSchema, provider: z.enum(['fixture', 'metered', 'subscription']), adapterId: idSchema, secretRef: secretRefSchema, ttlMs: positive })),
  emergencyPurposes: z.array(z.enum(['canary-recovery', 'verified-p0-security', 'production-invariant-recovery'])).min(1).max(3),
}).refine(value => value.attemptCeiling.moneyMicros >= value.requestCeiling.moneyMicros &&
  value.attemptCeiling.tokens >= value.requestCeiling.inputTokens + value.requestCeiling.outputTokens + value.requestCeiling.reasoningTokens &&
  value.attemptCeiling.deadlineMs >= value.requestCeiling.deadlineMs)
const models = z.strictObject({
  endpoint, version: idSchema, credentialRef: secretRefSchema, refreshIntervalMs: positive, expiryMs: positive,
  roleThresholds: bounded(z.strictObject({ roleId: idSchema, minimumScore: ratio, benchmarkRevision: revisionSchema, requiredCapabilities: ids() })),
  deploymentAllowlist: ids(), deploymentDenylist: uniqueIds(),
  fallbacks: bounded(z.strictObject({ roleId: idSchema, deploymentIds: ids() })),
  compression: z.strictObject({ enabled: z.literal(false).default(false) }).default({ enabled: false }),
}).refine(value => value.expiryMs >= value.refreshIntervalMs &&
  !value.deploymentAllowlist.some(id => value.deploymentDenylist.includes(id)) &&
  value.fallbacks.every(role => role.deploymentIds.every(id => value.deploymentAllowlist.includes(id))))
const notifications = z.strictObject({
  healthInbox: z.literal(true),
  destinations: z.array(z.strictObject({ id: idSchema, endpoint: httpsUrlSchema.refine(value => !new URL(value).search), secretRef: secretRefSchema })).max(32).default([]),
  redaction: z.literal(true), cooldownMs: positive, maxRetries: counterSchema.max(10), deadLetterLimit: positive, cardinalityCap: positive,
})
export const enabledDarkFactoryConfigSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1), enabled: z.literal(true), mode: z.enum(['observe', 'build', 'staging', 'production']).default('observe'),
  projectIds: ids(), policyRevision: revisionSchema, ownerId: idSchema,
  limits: z.strictObject({ maxArtifactBytes: positive, maxArtifactTotalBytes: positive.default(1_073_741_824), maxJournalRecordBytes: positive.max(16_777_216), maxJournalBytes: positive, retentionDays: positive }),
  ingestion, verification, delivery, fleet, models, notifications,
}).superRefine((value, context) => {
  const issue = (path: (string | number)[]) => context.addIssue({ code: 'custom', path, message: 'Invalid policy reference or duplicate identity' })
  if (value.limits.maxJournalBytes < value.limits.maxJournalRecordBytes) issue(['limits'])
  if (value.limits.maxArtifactTotalBytes < value.limits.maxArtifactBytes) issue(['limits'])
  const unique = (items: { id: string }[], path: string[]) => { if (new Set(items.map(item => item.id)).size !== items.length) issue(path) }
  unique(value.ingestion.routes, ['ingestion', 'routes'])
  unique(value.verification.commands, ['verification', 'commands'])
  unique(value.fleet.projectCaps, ['fleet', 'projectCaps'])
  unique(value.fleet.hostCaps, ['fleet', 'hostCaps'])
  unique(value.fleet.quotas, ['fleet', 'quotas'])
  unique(value.fleet.pricingSnapshots, ['fleet', 'pricingSnapshots'])
  unique(value.notifications.destinations, ['notifications', 'destinations'])
  const keyIds = value.verification.trustedPublicKeys.map(key => key.keyId)
  if (new Set(keyIds).size !== keyIds.length) issue(['verification', 'trustedPublicKeys'])
  const roleIds = value.models.roleThresholds.map(role => role.roleId)
  if (new Set(roleIds).size !== roleIds.length) issue(['models', 'roleThresholds'])
  const fallbackRoles = value.models.fallbacks.map(role => role.roleId)
  if (new Set(fallbackRoles).size !== fallbackRoles.length) issue(['models', 'fallbacks'])
  if (value.verification.critics.roleIds.some(role => !roleIds.includes(role))) issue(['verification', 'critics'])
  if (value.projectIds.some(project => !value.ingestion.routes.some(route => route.projectId === project))) issue(['ingestion', 'routes'])
  for (const route of value.ingestion.routes) if (!value.projectIds.includes(route.projectId) || route.ruleIds.some(rule => !value.verification.ruleIds.includes(rule))) issue(['ingestion', 'routes'])
  for (const label of value.ingestion.automationLabels) if (!value.verification.ruleIds.includes(label.ruleId)) issue(['ingestion', 'automationLabels'])
  for (const route of value.ingestion.routes) {
    if (route.source === 'github' && route.reconciliation && (!route.repositoryIds.includes(route.reconciliation.repositoryId) || !route.bindings.installationIds.includes(route.reconciliation.installationId))) issue(['ingestion', 'routes', 'reconciliation'])
    if (route.source === 'github' && route.reconciliation?.dependabot) {
      const sensor = route.reconciliation.dependabot
      if (!route.bindings.authorIds.includes(sensor.sensorPrincipalId) || !route.ruleIds.includes(sensor.ruleId) ||
        route.bindings.automationRules.filter(mapping => mapping.ruleId === sensor.ruleId).length !== 1) issue(['ingestion', 'routes', 'reconciliation', 'dependabot'])
    }
    if (route.source === 'github' && route.reconciliation?.scan) {
      const scan = route.reconciliation.scan
      if (!route.senderIds.includes(scan.scannerId) || !route.ruleIds.includes(scan.ruleId) ||
        route.bindings.automationRules.filter(mapping => mapping.ruleId === scan.ruleId).length !== 1) issue(['ingestion', 'routes', 'reconciliation', 'scan'])
    }
    const mappings = route.source === 'github' || route.source === 'maintenance' ? route.bindings.automationRules : route.bindings.ruleMappings
    for (const mapping of mappings) if (!route.ruleIds.includes(mapping.ruleId) || !value.ingestion.automationLabels.some(label => label.ruleId === mapping.ruleId && label.label === mapping.automationLabel)) issue(['ingestion', 'routes', 'bindings'])
    if (route.source === 'sentry' || route.source === 'apm') {
      const registration = route.reconciliation
      if (registration && (!route.repositoryIds.includes(registration.repositoryId) ||
        !route.bindings.environments.some(binding => binding.environmentId === registration.productionEnvironmentId))) issue(['ingestion', 'routes', 'reconciliation'])
      if (route.source === 'sentry' && route.reconciliation) {
        const pinned = route.reconciliation
        if (!route.bindings.installationIds.includes(pinned.installationId) || !route.bindings.organizationIds.includes(pinned.organizationId) ||
          !route.bindings.providerProjects.some(project => project.id === pinned.providerProjectId && project.slug === pinned.projectSlug && project.organizationId === pinned.organizationId)) issue(['ingestion', 'routes', 'reconciliation'])
      }
      if (route.source === 'apm' && route.reconciliation && (!route.bindings.providerProjectIds.includes(route.reconciliation.providerProjectId) ||
        !route.senderIds.includes(route.reconciliation.senderId))) issue(['ingestion', 'routes', 'reconciliation'])

      const environments = route.bindings.environments.map(binding => binding.providerEnvironment)
      if (new Set(environments).size !== environments.length) issue(['ingestion', 'routes', 'bindings', 'environments'])
      const selectors = route.bindings.ruleMappings.map(mapping => JSON.stringify(['resource' in mapping ? mapping.resource : 'apm', mapping.providerRule]))
      if (new Set(selectors).size !== selectors.length) issue(['ingestion', 'routes', 'bindings', 'ruleMappings'])
    }
    if (route.source === 'sentry') {
      const projects = route.bindings.providerProjects
      if (projects.some(project => !route.bindings.organizationIds.includes(project.organizationId)) || new Set(projects.map(project => project.id)).size !== projects.length || new Set(projects.map(project => project.slug)).size !== projects.length) issue(['ingestion', 'routes', 'bindings', 'providerProjects'])
      if (route.bindings.ruleMappings.some(mapping => (mapping.resource === 'issue') !== (mapping.providerRule === null))) issue(['ingestion', 'routes', 'bindings', 'ruleMappings'])
    }
  }
  if (value.projectIds.some(id => !value.fleet.projectCaps.some(cap => cap.id === id)) || value.fleet.projectCaps.some(cap => !value.projectIds.includes(cap.id))) issue(['fleet', 'projectCaps'])
  if (!value.fleet.hostCaps.some(cap => cap.id === value.fleet.hostId)) issue(['fleet', 'hostCaps'])
  if (value.models.fallbacks.some(fallback => !value.models.roleThresholds.some(role => role.roleId === fallback.roleId))) issue(['models', 'fallbacks'])
  if (!value.verification.trustedPublicKeys.some(key => key.keyId === value.verification.signer.keyId)) issue(['verification', 'signer'])
  if (value.delivery.enabled) {
    unique(value.delivery.environments, ['delivery', 'environments'])
    unique(value.delivery.telemetry, ['delivery', 'telemetry'])
    for (const environment of value.delivery.environments) if (!value.projectIds.includes(environment.projectId)) issue(['delivery', 'environments'])
    if (value.delivery.rollback.verificationCheckIds.some(id => !value.verification.checkIds.includes(id))) issue(['delivery', 'rollback'])
  }
  if ((value.mode === 'staging' || value.mode === 'production') && !value.delivery.enabled) issue(['delivery'])
})
export const darkFactoryConfigSchema = z.union([
  z.strictObject({ schemaVersion: z.literal(1).default(1), enabled: z.literal(false).default(false) }),
  enabledDarkFactoryConfigSchema,
]).default({ schemaVersion: 1, enabled: false })
export type DarkFactoryConfig = z.output<typeof darkFactoryConfigSchema>
export type EnabledDarkFactoryConfig = z.output<typeof enabledDarkFactoryConfigSchema>

/** Host entry point: never include attacker-controlled keys, values, or Zod issues in errors. */
export function parseDarkFactoryConfig(input?: unknown): DarkFactoryConfig {
  let value: unknown
  try {
    value = input === undefined ? undefined : parseStrictJson(typeof input === 'string' || input instanceof Uint8Array ? input : canonicalJson(input))
  } catch { throw new Error('Invalid Dark Factory configuration: expected bounded, unambiguous JSON') }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) {
    throw new Error('Unsupported Dark Factory configuration version; migrate offline from a verified backup')
  }
  const result = darkFactoryConfigSchema.safeParse(value)
  if (!result.success) throw new Error('Invalid Dark Factory configuration: policy schema or reference validation failed')
  return result.data
}
export interface DarkFactoryPreflightHost {
  projects: readonly { id: string; repositoryId: string; targetBranch: string; componentIds: readonly string[] }[]
  capabilities: readonly string[]
  /** Host-verified receipt identities, never copied from configuration. */
  gateReceipts?: readonly string[]
}
export interface DarkFactoryDiagnostic { code: string; path: string; message: string }

/** Pure startup check. Disabled operation does not inspect host prerequisites or resolve secrets. */
export function preflightDarkFactory(config: DarkFactoryConfig, host: DarkFactoryPreflightHost): { ok: boolean; diagnostics: DarkFactoryDiagnostic[] } {
  if (!config.enabled) return { ok: true, diagnostics: [] }
  const diagnostics: DarkFactoryDiagnostic[] = []
  const reject = (code: string, path: string, message: string) => diagnostics.push({ code, path, message })
  const projects = config.projectIds.map(id => host.projects.find(project => project.id === id))
  if (projects.some(project => !project)) reject('PROJECT_UNREGISTERED', 'projectIds', 'Every policy project must be registered with the host')
  const ownership = new Set<string>()
  for (const project of projects) {
    if (!project) continue
    const key = JSON.stringify([project.repositoryId, project.targetBranch])
    if (!project.repositoryId || !project.targetBranch || ownership.has(key)) reject('PROJECT_OWNERSHIP_AMBIGUOUS', 'projectIds', 'Repository and target ownership must be unique and registered')
    ownership.add(key)
  }
  const required = ['project-ownership', 'ingestion', 'secret-resolution', 'policy-journal', 'ingress-scope', 'redaction', 'health-inbox']
  if (config.mode !== 'observe') required.push('sandbox', 'machine-verification', 'signed-evidence', 'admission-reconciliation')
  if (config.mode === 'production') required.push('fleet-reservations', 'incremental-accounting', 'redis-durability')
  if (config.delivery.enabled) {
    required.push('deployment-idempotency', 'deployment-status', 'reverse-deployment', 'telemetry', 'publication-grants')
    const owners = new Set<string>()
    for (const environment of config.delivery.environments) {
      const project = host.projects.find(project => project.id === environment.projectId)
      for (const component of environment.componentIds) {
        const key = JSON.stringify([environment.id, component])
        if (owners.has(key) || !project?.componentIds.includes(component)) reject('COMPONENT_OWNERSHIP_AMBIGUOUS', 'delivery.environments', 'Each deployment component must have one registered project owner')
        owners.add(key)
      }
    }
  }
  for (const capability of required) if (!host.capabilities.includes(capability)) reject('CAPABILITY_MISSING', 'host.capabilities', `Required host capability unavailable: ${capability}`)
  for (const quota of config.mode === 'observe' ? [] : config.fleet.quotas) if (!host.capabilities.includes(`quota:${quota.adapterId}`)) reject('QUOTA_ADAPTER_UNSUPPORTED', 'fleet.quotas', 'Configured quota adapter is unavailable')
  if (config.mode === 'production' && ['goal-0', 'goal-1', 'goal-2', 'goal-3', 'goal-4', 'goal-5'].some(gate => !host.gateReceipts?.includes(gate))) reject('PRODUCTION_GATES_MISSING', 'mode', 'Production requires host-verified delivery and qualification receipts')
  // Observe supports custody only; capabilities cannot assert unfinished executing modes into existence.
  if (config.mode !== 'observe') reject('RUNTIME_UNIMPLEMENTED', 'mode', 'Dark Factory executing runtime is not implemented; observe supports unresolved custody only')
  if (config.ingestion.routes.some(route => route.source === 'maintenance')) reject('MAINTENANCE_UNIMPLEMENTED', 'ingestion.routes', 'Host maintenance scanning is not implemented')
  return { ok: diagnostics.length === 0, diagnostics }
}
