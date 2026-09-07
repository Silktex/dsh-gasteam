/** GasTeam-owned current-state protocol, not a third-party APM standard.
 * GET /darkfactory/v1/current/{providerProjectId}/{fingerprint} returns a strict
 * {schemaVersion:1,observedAt,payload:genericApmPayload}. TLS + pinned API bearer
 * credentials authenticate the response; webhook signing never substitutes for
 * this current read. Host repository/sensor/environment mappings remain explicit.
 */
import z from 'zod'
import { apmReconciliationRegistrationSchema, ingressPolicyRouteSchema, type IngressPolicyRoute } from './config.ts'
import { idSchema, revisionSchema, timestampSchema } from './contracts/common.ts'
import { genericApmPayloadSchema } from './ingress-adapters.ts'
import { canonicalJson, digestJson } from './json.ts'
import { readMonitoringResource, MonitoringProviderFailure, type MonitoringReadOptions, type MonitoringResult } from './monitoring-reconciliation.ts'

export const apmReconciliationLookupSchema = z.strictObject({ kind: z.literal('apm'), sourceEntityId: idSchema, providerEntityId: idSchema,
  fingerprint: idSchema, actorId: idSchema, providerProjectId: idSchema, providerRule: idSchema })
export const apmCurrentResponseSchema = z.strictObject({ schemaVersion: z.literal(1), observedAt: timestampSchema, payload: genericApmPayloadSchema })
export type ApmReconciliationLookup = z.output<typeof apmReconciliationLookupSchema>
export interface ApmReconciliationOptions extends Omit<MonitoringReadOptions, 'apiBaseUrl' | 'fixtureLoopback'> {
  registration: z.output<typeof apmReconciliationRegistrationSchema>; route: IngressPolicyRoute; observed: ApmReconciliationLookup; projectId: string; policyRevision: number
}
export interface ReconciledApmItem {
  repository: { provider: 'github'; repositoryId: string; canonicalName: string }
  author: string; actor: string; title: string; context: string; labels: string[]; sourceUrl: string
}
export interface ApmReconciliationProvenance {
  schemaVersion: 1; protocol: 'gasteam-apm-current/v1'; projectId: string; policyRevision: number
  sourceEntityId: string; providerEntityId: string; sourceRevision: string; providerRevision: string; observedAt: string; checkedAt: string
  repositoryId: string; repositoryName: string; providerProjectId: string; senderId: string; sensorPrincipalId: string
  identityBinding: 'host-configured-monitoring-sensor'; repositoryBinding: 'host-configured-github-repository'; credentialBinding: 'host-pinned-api-token'
  productionEnvironmentId: string; providerEnvironment: string; providerRule: string; ruleId: string; automationLabel: string
  providerEvidenceDigest: string; responseDigests: string[]; requestsUsed: number
}
export type ApmReconciliationResult = MonitoringResult<{ sourceRevision: string; item: ReconciledApmItem; provenance: ApmReconciliationProvenance }>
const sourceId = (senderId: string, project: string, fingerprint: string) => `apm:${digestJson([senderId, project, fingerprint]).slice(7)}`
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const denied = (diagnostic: string): never => { throw new MonitoringProviderFailure('SOURCE_DENIED', diagnostic) }
const invalid = (diagnostic: string): never => { throw new MonitoringProviderFailure('PROVIDER_RESPONSE_INVALID', diagnostic) }

export async function reconcileApmSource(options: ApmReconciliationOptions): Promise<ApmReconciliationResult> {
  return readMonitoringResource({ ...options, apiBaseUrl: options.registration?.apiBaseUrl, fixtureLoopback: options.registration?.fixtureLoopback }, async context => {
    const registration = apmReconciliationRegistrationSchema.safeParse(options.registration), policy = ingressPolicyRouteSchema.safeParse(options.route), observation = apmReconciliationLookupSchema.safeParse(options.observed)
    if (!registration.success || !policy.success || policy.data.source !== 'apm' || !observation.success || !idSchema.safeParse(options.projectId).success || !revisionSchema.safeParse(options.policyRevision).success) return denied('APM_CONFIGURATION_INVALID')
    const pinned = registration.data, route = policy.data, observed = observation.data
    if (route.projectId !== options.projectId || !route.reconciliation || digestJson(route.reconciliation) !== digestJson(pinned) ||
      !route.repositoryIds.includes(pinned.repositoryId) || !route.bindings.providerProjectIds.includes(pinned.providerProjectId) || !route.senderIds.includes(pinned.senderId)) return denied('APM_CONFIGURATION_INVALID')
    if (observed.actorId !== pinned.senderId || observed.providerProjectId !== pinned.providerProjectId || observed.providerEntityId !== observed.fingerprint ||
      observed.sourceEntityId !== sourceId(pinned.senderId, pinned.providerProjectId, observed.fingerprint)) return denied('APM_SOURCE_MISMATCH')
    const path = `/darkfactory/v1/current/${encodeURIComponent(pinned.providerProjectId)}/${encodeURIComponent(observed.fingerprint)}`
    const parsed = apmCurrentResponseSchema.safeParse(await context.get(path))
    if (!parsed.success) return invalid('APM_RESPONSE_INVALID')
    const current = parsed.data, payload = current.payload, checkedAt = context.checkedAt, checked = Date.parse(checkedAt), observedAt = Date.parse(current.observedAt), windowEnd = Date.parse(payload.observationWindow.end)
    if (observedAt > checked || windowEnd > checked || windowEnd > observedAt) return invalid('APM_RESPONSE_FUTURE')
    if (checked - observedAt > pinned.maxAgeMs || checked - windowEnd > pinned.maxAgeMs) return invalid('APM_RESPONSE_STALE')
    if (payload.senderId !== pinned.senderId || payload.providerProjectId !== pinned.providerProjectId || payload.fingerprint !== observed.fingerprint || payload.ruleId !== observed.providerRule ||
      sourceId(payload.senderId, payload.providerProjectId, payload.fingerprint) !== observed.sourceEntityId) return denied('APM_SOURCE_MISMATCH')
    if (new Set(payload.metrics.map(metric => metric.name)).size !== payload.metrics.length) return invalid('APM_DUPLICATE_METRIC')
    if (payload.evidence.some(reference => reference.projectId !== options.projectId)) return denied('APM_EVIDENCE_PROJECT_MISMATCH')
    if (new Set(payload.evidence.map(reference => reference.id)).size !== payload.evidence.length) return invalid('APM_DUPLICATE_EVIDENCE')
    if (payload.action === 'resolved') return denied('APM_RESOLVED')
    const rules = route.bindings.ruleMappings.filter(rule => rule.providerRule === payload.ruleId && route.ruleIds.includes(rule.ruleId))
    if (rules.length !== 1 || !idSchema.safeParse(rules[0]!.automationLabel).success) return denied('APM_RULE_NOT_ALLOWED')
    const environments = route.bindings.environments.filter(value => value.providerEnvironment === payload.environment && value.environmentId === pinned.productionEnvironmentId)
    if (environments.length !== 1) return denied('APM_ENVIRONMENT_NOT_ALLOWED')
    const metrics = [...payload.metrics].sort((a, b) => compare(a.name, b.name)), evidence = [...payload.evidence].sort((a, b) => compare(canonicalJson(a), canonicalJson(b)))
    // Query-time observedAt is freshness evidence, not an execution revision. Raw
    // narrative, values, explicit revision and source timestamps hash before redaction.
    const sourceRevision = digestJson({ protocol: 'gasteam-apm-current/v1', payload: { ...payload, metrics, evidence } }), rule = rules[0]!
    const sourceUrl = new URL(path, pinned.publicSourceBaseUrl).href
    if (context.redact(sourceUrl, 2048) !== sourceUrl) return invalid('APM_SOURCE_ID_REDACTION_REQUIRED')
    const item: ReconciledApmItem = { repository: { provider: 'github', repositoryId: pinned.repositoryId, canonicalName: pinned.repositoryName },
      author: pinned.sensorPrincipalId, actor: pinned.senderId, title: context.redact(payload.title, 1024),
      context: context.redact(canonicalJson({ context: payload.context, metrics, evidence, observationWindow: payload.observationWindow, commit: payload.commit, release: payload.release }), 16384),
      labels: [rule.automationLabel], sourceUrl }
    const provenance: ApmReconciliationProvenance = { schemaVersion: 1, protocol: 'gasteam-apm-current/v1', projectId: options.projectId, policyRevision: options.policyRevision,
      sourceEntityId: observed.sourceEntityId, providerEntityId: observed.providerEntityId, sourceRevision, providerRevision: context.redact(payload.revision, 128), observedAt: current.observedAt, checkedAt,
      repositoryId: pinned.repositoryId, repositoryName: pinned.repositoryName, providerProjectId: pinned.providerProjectId, senderId: pinned.senderId, sensorPrincipalId: pinned.sensorPrincipalId,
      identityBinding: 'host-configured-monitoring-sensor', repositoryBinding: 'host-configured-github-repository', credentialBinding: 'host-pinned-api-token',
      productionEnvironmentId: pinned.productionEnvironmentId, providerEnvironment: payload.environment, providerRule: payload.ruleId, ruleId: rule.ruleId, automationLabel: rule.automationLabel,
      // Remote evidence references are provider-reported input, never host-verified artifact authority.
      providerEvidenceDigest: digestJson(evidence), responseDigests: context.responseDigests(), requestsUsed: context.requestsUsed() }
    return { checkedAt, sourceRevision, item, provenance }
  })
}
