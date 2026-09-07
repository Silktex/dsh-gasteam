/** Current Sentry issue/event evidence, with explicit host sensor authority.
 * Documented reads (event:read and project:read bearer token scopes):
 * https://docs.sentry.io/api/events/retrieve-an-issue/
 * https://docs.sentry.io/api/events/retrieve-an-issue-event/
 * https://docs.sentry.io/api/projects/retrieve-a-project/
 * Metric webhooks remain unresolved: this reader has no documented current
 * metric-incident API binding. A metric rule alone cannot attest an active alert.
 */
import z from 'zod'
import { ingressPolicyRouteSchema, sentryReconciliationRegistrationSchema, type IngressPolicyRoute } from './config.ts'
import { idSchema, revisionSchema, timestampSchema, uniqueIds } from './contracts/common.ts'
import { canonicalJson, digestJson } from './json.ts'
import { MonitoringProviderFailure, readMonitoringResource, type MonitoringReadOptions, type MonitoringResult } from './monitoring-reconciliation.ts'

const eventId = z.string().regex(/^[a-fA-F0-9]{32}$/)
const lookupFields = { sourceEntityId: idSchema, providerEntityId: idSchema, installationId: idSchema, actorId: idSchema,
  providerProjectIds: uniqueIds(64).min(1), organizationId: idSchema.nullable(), providerRule: z.string().min(1).max(1024).nullable() }
export const sentryReconciliationLookupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...lookupFields, kind: z.literal('sentry_issue'), resource: z.enum(['issue', 'event_alert']), eventId: eventId.nullable() })
    .refine(value => value.resource === 'issue' ? value.eventId === null && value.providerRule === null : value.eventId !== null && value.providerRule !== null),
  z.strictObject({ ...lookupFields, kind: z.literal('sentry_metric'), resource: z.literal('metric_alert'), eventId: z.null(), organizationId: idSchema, providerRule: idSchema }),
])
export type SentryReconciliationLookup = z.output<typeof sentryReconciliationLookupSchema>
export interface SentryReconciliationOptions extends Omit<MonitoringReadOptions, 'apiBaseUrl' | 'fixtureLoopback'> {
  registration: z.output<typeof sentryReconciliationRegistrationSchema>; route: IngressPolicyRoute
  observed: SentryReconciliationLookup; projectId: string; policyRevision: number
}
const short = z.string().max(1024), nullableText = short.nullable().optional()
const projectSchema = z.object({ id: idSchema, slug: idSchema, organization: z.object({ id: idSchema, slug: idSchema }) })
const issueSchema = z.object({ id: idSchema, title: short.min(1), culprit: short.optional(), status: z.enum(['unresolved', 'resolved', 'ignored']),
  project: z.object({ id: idSchema, slug: idSchema }), firstSeen: timestampSchema, lastSeen: timestampSchema })
const frameSchema = z.object({ filename: nullableText, function: nullableText, lineNo: z.number().int().nonnegative().safe().nullable().optional(),
  colNo: z.number().int().nonnegative().safe().nullable().optional(), inApp: z.boolean().nullable().optional() })
const exceptionSchema = z.object({ type: nullableText, value: nullableText, stacktrace: z.object({ frames: z.array(frameSchema).max(64) }).nullable().optional() })
const eventSchema = z.object({ eventID: eventId, groupID: idSchema, title: short.min(1), dateCreated: timestampSchema, dateReceived: timestampSchema,
  tags: z.array(z.object({ key: z.string().min(1).max(128), value: short })).max(128),
  release: z.object({ version: short.min(1), dateCreated: timestampSchema.optional(), dateReleased: timestampSchema.nullable().optional() }).nullable().optional(),
  entries: z.array(z.object({ type: z.string().min(1).max(128), data: z.unknown() })).max(32),
})
type CurrentIssue = z.output<typeof issueSchema>
type CurrentEvent = Omit<z.output<typeof eventSchema>, 'entries' | 'tags'> & { environment: string; exceptions: z.output<typeof exceptionSchema>[] }
export interface ReconciledSentryItem {
  repository: { provider: 'github'; repositoryId: string; canonicalName: string }
  author: string; actor: string; title: string; context: string; labels: string[]; sourceUrl: string
}
export interface SentryReconciliationProvenance {
  schemaVersion: 1; source: 'sentry'; sourceEntityId: string; sourceRevision: string; projectId: string; policyRevision: number
  providerEntityId: string; organizationId: string; providerProjectId: string; installationId: string
  credentialBinding: 'host-pinned-api-token-installation'; repositoryBinding: 'host-configured-project-repository'
  sensorPrincipalId: string; authorBinding: 'host-configured-sensor'; webhookActorId: string; actorBinding: 'signed-webhook-observation-not-current-provider'
  resource: SentryReconciliationLookup['resource']; ruleId: string; automationLabel: string
  ruleBinding: 'host-mapping-of-signed-webhook-selector-not-current-provider-rule-activation'
  observedEventId: string | null; environmentId: string; checkedAt: string; responseDigests: string[]
  issue: CurrentIssue; event: CurrentEvent
}
export type SentryReconciliationResult = MonitoringResult<{ sourceRevision: string; item: ReconciledSentryItem; provenance: SentryReconciliationProvenance }>

export async function reconcileSentrySource(options: SentryReconciliationOptions): Promise<SentryReconciliationResult> {
  return readMonitoringResource({ ...options, apiBaseUrl: options.registration.apiBaseUrl, fixtureLoopback: options.registration.fixtureLoopback }, async context => {
    const deny = (diagnostic: string): never => { throw new MonitoringProviderFailure('SOURCE_DENIED', diagnostic) }
    const invalid = (diagnostic = 'SENTRY_RESPONSE_INVALID'): never => { throw new MonitoringProviderFailure('PROVIDER_RESPONSE_INVALID', diagnostic) }
    const registration = sentryReconciliationRegistrationSchema.safeParse(options.registration), routeResult = ingressPolicyRouteSchema.safeParse(options.route), lookup = sentryReconciliationLookupSchema.safeParse(options.observed)
    if (!registration.success || !routeResult.success || routeResult.data.source !== 'sentry' || !lookup.success || !idSchema.safeParse(options.projectId).success || !revisionSchema.safeParse(options.policyRevision).success) return deny('SENTRY_CONFIGURATION_INVALID')
    const pinned = registration.data, route = routeResult.data, observed = lookup.data
    if (route.projectId !== options.projectId || !route.repositoryIds.includes(pinned.repositoryId) || !route.senderIds.includes(observed.actorId) ||
      !route.bindings.installationIds.includes(pinned.installationId) || observed.installationId !== pinned.installationId ||
      !route.bindings.organizationIds.includes(pinned.organizationId) || observed.organizationId !== null && observed.organizationId !== pinned.organizationId ||
      !route.bindings.providerProjects.some(project => project.id === pinned.providerProjectId && project.slug === pinned.projectSlug && project.organizationId === pinned.organizationId) ||
      observed.providerProjectIds.length !== 1 || observed.providerProjectIds[0] !== (observed.kind === 'sentry_metric' ? pinned.projectSlug : pinned.providerProjectId) ||
      route.reconciliation && canonicalJson(route.reconciliation) !== canonicalJson(pinned)) return deny('SENTRY_SCOPE_MISMATCH')
    const sourceEntityId = observed.kind === 'sentry_issue' ? `sentry-issue:${pinned.providerProjectId}:${observed.providerEntityId}` : `sentry-metric:${pinned.organizationId}:${observed.providerEntityId}`
    if (observed.sourceEntityId !== sourceEntityId) return deny('SENTRY_ID_MISMATCH')
    const rules = route.bindings.ruleMappings.filter(rule => rule.resource === observed.resource && rule.providerRule === observed.providerRule && route.ruleIds.includes(rule.ruleId))
    if (rules.length !== 1) return deny('SENTRY_RULE_NOT_ALLOWED')
    const environments = route.bindings.environments.filter(environment => environment.environmentId === pinned.productionEnvironmentId)
    if (environments.length !== 1) return deny('SENTRY_PRODUCTION_MAPPING_INVALID')
    if (observed.kind === 'sentry_metric') throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'SENTRY_METRIC_API_UNSUPPORTED')
    const rule = rules[0]!, production = environments[0]!, { get, redact } = context
    const orgPath = encodeURIComponent(pinned.organizationSlug), projectPath = encodeURIComponent(pinned.projectSlug), issuePath = encodeURIComponent(observed.providerEntityId)
    const project = projectSchema.safeParse(await get(`/api/0/projects/${orgPath}/${projectPath}/`))
    if (!project.success) return invalid()
    if (project.data.id !== pinned.providerProjectId || project.data.slug !== pinned.projectSlug || project.data.organization.id !== pinned.organizationId || project.data.organization.slug !== pinned.organizationSlug) return deny('SENTRY_PROJECT_MISMATCH')
    const issueResult = issueSchema.safeParse(await get(`/api/0/organizations/${orgPath}/issues/${issuePath}/`))
    if (!issueResult.success) return invalid()
    const issue = issueResult.data
    if (issue.id !== observed.providerEntityId || issue.project.id !== pinned.providerProjectId || issue.project.slug !== pinned.projectSlug) return deny('SENTRY_ISSUE_MISMATCH')
    if (issue.status !== 'unresolved') return deny('SENTRY_RESOLVED')
    const issueChecked = Date.parse(context.checkedAt)
    if (Date.parse(issue.firstSeen) > Date.parse(issue.lastSeen) || Date.parse(issue.lastSeen) > issueChecked) return invalid('SENTRY_TIMESTAMP_INVALID')
    async function readEvent(selector: string, isObserved: boolean): Promise<{ event: CurrentEvent; checkedAt: string }> {
      const suffix = isObserved ? '' : `?${new URLSearchParams({ environment: production.providerEnvironment })}`
      const parsed = eventSchema.safeParse(await get(`/api/0/organizations/${orgPath}/issues/${issuePath}/events/${encodeURIComponent(selector)}/${suffix}`))
      if (!parsed.success) return invalid()
      const { entries, tags, ...event } = parsed.data
      if (event.groupID !== issue.id || isObserved && event.eventID !== selector) return deny('SENTRY_EVENT_MISMATCH')
      const environment = tags.filter(tag => tag.key === 'environment')
      if (environment.length !== 1 || environment[0]!.value !== production.providerEnvironment)
        return deny(isObserved ? 'SENTRY_OBSERVED_EVENT_ENVIRONMENT_MISMATCH' : 'SENTRY_ENVIRONMENT_NOT_ALLOWED')
      const eventCheckedAt = context.checkedAt, now = Date.parse(eventCheckedAt)
      const at = Date.parse(event.dateCreated), received = Date.parse(event.dateReceived)
      if (at > now || received > now) return invalid('SENTRY_TIMESTAMP_INVALID')
      if (now - at > pinned.maxAgeMs || now - received > pinned.maxAgeMs) return deny('SENTRY_EVENT_STALE')
      const exceptions: z.output<typeof exceptionSchema>[] = []
      for (const entry of entries.filter(entry => entry.type === 'exception')) {
        const values = z.object({ values: z.array(exceptionSchema).max(16) }).safeParse(entry.data)
        if (!values.success) return invalid()
        exceptions.push(...values.data.values)
      }
      if (exceptions.length > 16 || exceptions.reduce((count, exception) => count + (exception.stacktrace?.frames.length ?? 0), 0) > 256) return invalid('SENTRY_EVIDENCE_LIMIT')
      return { event: { ...event, environment: environment[0]!.value, exceptions }, checkedAt: eventCheckedAt }
    }
    if (observed.eventId !== null) await readEvent(observed.eventId, true)
    const { event, checkedAt } = await readEvent('latest', false)
    // Delivery actor/rule/event selectors are provenance, never fresh revisions.
    const sourceRevision = digestJson({ source: 'sentry', organizationId: pinned.organizationId, projectId: pinned.providerProjectId, issue, event })
    const safeIssue: CurrentIssue = { ...issue, title: redact(issue.title, 1024), ...(issue.culprit === undefined ? {} : { culprit: redact(issue.culprit, 1024) }) }
    const safeEvent: CurrentEvent = { ...event, title: redact(event.title, 1024),
      ...(event.release ? { release: { ...event.release, version: redact(event.release.version, 1024) } } : {}),
      exceptions: event.exceptions.map(exception => ({ ...exception, type: exception.type == null ? null : redact(exception.type, 1024), value: exception.value == null ? null : redact(exception.value, 1024),
        ...(exception.stacktrace ? { stacktrace: { frames: exception.stacktrace.frames.map(frame => ({ ...frame,
          filename: frame.filename == null ? null : redact(frame.filename, 1024), function: frame.function == null ? null : redact(frame.function, 1024) })) } } : {}) })) }
    const item: ReconciledSentryItem = { repository: { provider: 'github', repositoryId: pinned.repositoryId, canonicalName: pinned.repositoryName },
      author: pinned.sensorPrincipalId, actor: observed.actorId, title: safeIssue.title,
      context: redact(canonicalJson({ culprit: safeIssue.culprit ?? null, event: safeEvent }), 16384), labels: [rule.automationLabel],
      sourceUrl: `${pinned.publicSourceBaseUrl.replace(/\/$/, '')}/organizations/${orgPath}/issues/${issuePath}/` }
    return { checkedAt, sourceRevision, item, provenance: { schemaVersion: 1 as const, source: 'sentry' as const, sourceEntityId, sourceRevision,
      projectId: options.projectId, policyRevision: options.policyRevision, providerEntityId: issue.id, organizationId: pinned.organizationId, providerProjectId: pinned.providerProjectId,
      installationId: pinned.installationId, credentialBinding: 'host-pinned-api-token-installation' as const, repositoryBinding: 'host-configured-project-repository' as const,
      sensorPrincipalId: pinned.sensorPrincipalId, authorBinding: 'host-configured-sensor' as const, webhookActorId: observed.actorId, actorBinding: 'signed-webhook-observation-not-current-provider' as const,
      resource: observed.resource, ruleId: rule.ruleId, automationLabel: rule.automationLabel, ruleBinding: 'host-mapping-of-signed-webhook-selector-not-current-provider-rule-activation' as const,
      observedEventId: observed.eventId, environmentId: pinned.productionEnvironmentId, checkedAt, responseDigests: context.responseDigests(), issue: safeIssue, event: safeEvent } }
  })
}
