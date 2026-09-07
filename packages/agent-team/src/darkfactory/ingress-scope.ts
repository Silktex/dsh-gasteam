/** Static claim checks only. An eligible observation still requires authoritative
 * provider reconciliation before any trusted lifecycle transition or execution.
 */
import z from 'zod'
import { ingressPolicyRouteSchema, type IngressPolicyRoute } from './config.ts'
import { normalizedIngressFactsSchema, type NormalizedIngressFacts } from './ingress-adapters.ts'

export const ingressScopeReasonSchema = z.enum([
  'CONFIGURATION_INVALID', 'PAYLOAD_INVALID', 'SOURCE_KIND_MISMATCH', 'SOURCE_UNSUPPORTED', 'SOURCE_INVALIDATED',
  'INSTALLATION_NOT_ALLOWED', 'REPOSITORY_NOT_ALLOWED', 'AUTHOR_NOT_ALLOWED', 'ACTOR_NOT_ALLOWED',
  'PROVIDER_PROJECT_NOT_ALLOWED', 'ORGANIZATION_NOT_ALLOWED', 'ENVIRONMENT_NOT_ALLOWED',
  'AUTOMATION_RULE_NOT_ALLOWED', 'AUTOMATION_LABEL_MISSING',
  'PROVIDER_RECONCILIATION_REQUIRED', 'ENVIRONMENT_RECONCILIATION_REQUIRED',
])
export type IngressScopeReason = z.output<typeof ingressScopeReasonSchema>
export interface IngressScopeAssessment { eligibleForReconciliation: boolean; reasons: IngressScopeReason[] }
export function assessIngressScope(route: IngressPolicyRoute, facts: NormalizedIngressFacts): IngressScopeAssessment {
  const policy = ingressPolicyRouteSchema.safeParse(route), observation = normalizedIngressFactsSchema.safeParse(facts)
  if (!policy.success) return { eligibleForReconciliation: false, reasons: ['CONFIGURATION_INVALID'] }
  if (!observation.success) return { eligibleForReconciliation: false, reasons: ['PAYLOAD_INVALID'] }
  route = policy.data; facts = observation.data
  const denied = new Set<IngressScopeReason>(), pending = new Set<IngressScopeReason>(['PROVIDER_RECONCILIATION_REQUIRED'])
  const reject = (reason: IngressScopeReason) => denied.add(reason)
  // Registered monitoring readers must check resolution against current provider state.
  if (facts.invalidatesPending && !((route.source === 'sentry' || route.source === 'apm') && route.reconciliation)) reject('SOURCE_INVALIDATED')
  if (facts.actorId === null || !route.senderIds.includes(facts.actorId)) reject('ACTOR_NOT_ALLOWED')
  if (route.source === 'github') {
    if (!['issue', 'pull_request', 'dependabot_alert'].includes(facts.details.kind)) reject('SOURCE_KIND_MISMATCH')
    if (facts.installationId === null || !route.bindings.installationIds.includes(facts.installationId)) reject('INSTALLATION_NOT_ALLOWED')
    if (facts.repositoryId === null || !route.repositoryIds.includes(facts.repositoryId)) reject('REPOSITORY_NOT_ALLOWED')
    if (facts.details.kind === 'issue' || facts.details.kind === 'pull_request') {
      if (facts.authorId === null || !route.bindings.authorIds.includes(facts.authorId)) reject('AUTHOR_NOT_ALLOWED')
      if (!route.bindings.automationRules.some(mapping => route.ruleIds.includes(mapping.ruleId) && facts.labels.includes(mapping.automationLabel))) reject('AUTOMATION_LABEL_MISSING')
    } else if (!route.bindings.automationRules.some(mapping => route.ruleIds.includes(mapping.ruleId))) reject('AUTOMATION_RULE_NOT_ALLOWED')
  } else if (route.source === 'sentry') {
    const details = facts.details
    if (details.kind !== 'sentry_issue' && details.kind !== 'sentry_metric') reject('SOURCE_KIND_MISMATCH')
    if (facts.installationId === null || !route.bindings.installationIds.includes(facts.installationId)) reject('INSTALLATION_NOT_ALLOWED')
    // Native metric alerts identify projects by slug; issue/event alerts carry IDs.
    const projects = facts.providerProjectIds.map(claim => route.bindings.providerProjects.find(project => (details.kind === 'sentry_metric' ? project.slug : project.id) === claim))
    if (!projects.length || projects.some(project => !project)) reject('PROVIDER_PROJECT_NOT_ALLOWED')
    if (facts.organizationId !== null && (!route.bindings.organizationIds.includes(facts.organizationId) || projects.some(project => project && project.organizationId !== facts.organizationId))) reject('ORGANIZATION_NOT_ALLOWED')
    if (details.kind === 'sentry_issue' || details.kind === 'sentry_metric') {
      // Issue-created payloads contain no environment. Missing evidence is fetched;
      // a contradictory environment is rejected and can never be defaulted to production.
      if (details.environment === null) pending.add('ENVIRONMENT_RECONCILIATION_REQUIRED')
      else if (!route.bindings.environments.some(binding => binding.providerEnvironment === details.environment)) reject('ENVIRONMENT_NOT_ALLOWED')
      const resource = details.kind === 'sentry_metric' ? 'metric_alert' : details.eventId === null ? 'issue' : 'event_alert'
      const claims: (string | null)[] = resource === 'issue' ? [null] : facts.ruleIds
      if (!claims.length || claims.some(claim => !route.bindings.ruleMappings.some(mapping => mapping.resource === resource && mapping.providerRule === claim && route.ruleIds.includes(mapping.ruleId)))) reject('AUTOMATION_RULE_NOT_ALLOWED')
    }
  } else if (route.source === 'apm') {
    if (facts.details.kind !== 'apm') reject('SOURCE_KIND_MISMATCH')
    if (!facts.providerProjectIds.length || facts.providerProjectIds.some(project => !route.bindings.providerProjectIds.includes(project))) reject('PROVIDER_PROJECT_NOT_ALLOWED')
    const details = facts.details
    if (details.kind === 'apm' && !route.bindings.environments.some(binding => binding.providerEnvironment === details.environment)) reject('ENVIRONMENT_NOT_ALLOWED')
    if (!facts.ruleIds.length || facts.ruleIds.some(rule => !route.bindings.ruleMappings.some(mapping => mapping.providerRule === rule && route.ruleIds.includes(mapping.ruleId)))) reject('AUTOMATION_RULE_NOT_ALLOWED')
  } else reject('SOURCE_UNSUPPORTED')
  return { eligibleForReconciliation: denied.size === 0, reasons: denied.size ? [...denied] : [...pending] }
}
