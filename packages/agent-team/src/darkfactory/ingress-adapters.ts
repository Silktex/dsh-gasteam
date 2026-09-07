import type { InboundEnvelopeWithoutArtifact } from './contracts/ingestion.ts'
/** Provider payloads contain many optional presentation fields. Select validated facts,
 * discard extensions, and never use provider URLs as fetch targets or authority.
 * Native examples: https://docs.github.com/en/webhooks/webhook-events-and-payloads
 * https://github.com/getsentry/sentry-docs/tree/master/docs/integrations/integration-platform/webhooks
 */
import z from 'zod'
import { artifactRefSchema, commitSchema, counterSchema, idSchema, safePathSchema, timestampSchema } from './contracts/common.ts'
import type { inboundEnvelopeSchema } from './contracts/ingestion.ts'
import { digestJson, parseStrictJson } from './json.ts'
import { authenticatedIngressBody, IngressError, type AuthenticatedIngress } from './ingress-auth.ts'

const short = z.string().max(1024)
const context = z.string().max(16_384)
const nativeTimestamp = z.iso.datetime({ offset: true }).max(64)
const providerId = z.union([idSchema, counterSchema]).transform(String)
const nullableText = short.nullable().optional()
const user = z.object({ id: providerId })
const repository = z.object({ id: providerId, full_name: z.string().min(1).max(256) })
const labels = z.array(z.object({ name: z.string().min(1).max(128) })).max(64)
const githubCommon = { action: idSchema, repository, installation: z.object({ id: providerId }).optional(), sender: user }
const githubIssue = z.object({ ...githubCommon, issue: z.object({
  id: providerId, number: counterSchema.min(1), title: short.min(1), body: context.nullable(), user, labels,
  state: z.enum(['open', 'closed']), updated_at: timestampSchema,
}) })
const githubPr = z.object({ ...githubCommon, pull_request: z.object({
  id: providerId, number: counterSchema.min(1), title: short.min(1), body: context.nullable(), user, labels,
  state: z.enum(['open', 'closed']), updated_at: timestampSchema,
  base: z.object({ sha: commitSchema, repo: repository }), head: z.object({ sha: commitSchema, repo: repository.nullable() }),
}) })
const githubAlert = z.object({ ...githubCommon, alert: z.object({
  number: counterSchema.min(1), state: z.enum(['open', 'fixed', 'dismissed', 'auto_dismissed']), updated_at: timestampSchema,
  dependency: z.object({ package: z.object({ name: z.string().min(1).max(256), ecosystem: short.min(1) }), manifest_path: safePathSchema, scope: short.optional(), relationship: short.optional() }),
  security_advisory: z.object({ ghsa_id: z.string().regex(/^GHSA-[a-z0-9-]+$/), cve_id: z.string().regex(/^CVE-[0-9]{4}-[0-9]+$/).nullable(), summary: short.min(1), identifiers: z.array(z.object({ type: z.enum(['GHSA', 'CVE']), value: short.min(1) })).max(32).optional() }),
  security_vulnerability: z.object({ vulnerable_version_range: short.min(1), first_patched_version: z.object({ identifier: short.min(1) }).nullable() }),
}) })
const frameSchema = z.object({ filename: nullableText, function: nullableText, lineno: counterSchema.nullable().optional(), colno: counterSchema.nullable().optional(), in_app: z.boolean().optional() })
const exceptionSchema = z.object({ type: nullableText, value: nullableText, stacktrace: z.object({ frames: z.array(frameSchema).max(64) }).optional() })
const sentryCommon = { action: idSchema, installation: z.object({ uuid: idSchema }), actor: z.object({ id: providerId, type: z.enum(['user', 'application']) }) }
const sentryEvent = z.object({ ...sentryCommon, data: z.object({
  triggered_rule: short.min(1), event: z.object({ event_id: idSchema, issue_id: providerId, project: providerId, title: short.min(1), datetime: nativeTimestamp,
    environment: nullableText, release: z.union([short, z.object({ version: short })]).nullable().optional(),
    tags: z.array(z.tuple([short, short])).max(128).optional(), exception: z.object({ values: z.array(exceptionSchema).max(16) }).optional(),
  }),
}) })
const sentryIssue = z.object({ ...sentryCommon, data: z.object({ issue: z.object({ id: providerId, title: short.min(1), culprit: short.optional(), status: z.enum(['unresolved', 'resolved', 'ignored']),
  project: z.object({ id: providerId, slug: short.min(1) }), lastSeen: nativeTimestamp,
}) }) })
const sentryMetric = z.object({ ...sentryCommon, data: z.object({ description_text: context, description_title: short.min(1), metric_alert: z.object({
  id: providerId, organization_id: providerId, projects: z.array(idSchema).min(1).max(64), date_started: nativeTimestamp, date_closed: nativeTimestamp.nullable().optional(),
  alert_rule: z.object({ id: providerId, organization_id: providerId, projects: z.array(idSchema).min(1).max(64), environment: nullableText, aggregate: short.min(1), query: short, time_window: counterSchema.min(1), date_modified: nativeTimestamp }),
}) }) })
/** The generic protocol is owned here and rejects unknown fields at every level. */
export const genericApmPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), action: z.enum(['triggered', 'updated', 'resolved']), senderId: idSchema, providerProjectId: idSchema, environment: idSchema, ruleId: idSchema,
  fingerprint: idSchema, revision: idSchema, title: short.min(1), context,
  observationWindow: z.strictObject({ start: timestampSchema, end: timestampSchema }),
  commit: commitSchema.nullable(), release: short.nullable(),
  metrics: z.array(z.strictObject({ name: idSchema, value: z.number(), unit: idSchema })).min(1).max(64),
  evidence: z.array(artifactRefSchema).max(64),
}).refine(value => Date.parse(value.observationWindow.start) < Date.parse(value.observationWindow.end), { message: 'Invalid observation window' })
const detailSchemas = [
  z.strictObject({ kind: z.literal('issue'), number: counterSchema.min(1), state: z.enum(['open', 'closed']) }),
  z.strictObject({ kind: z.literal('pull_request'), number: counterSchema.min(1), state: z.enum(['open', 'closed']), baseRepositoryId: idSchema, headRepositoryId: idSchema.nullable(), baseCommit: commitSchema, headCommit: commitSchema, fork: z.boolean() }),
  z.strictObject({ kind: z.literal('dependabot_alert'), number: counterSchema.min(1), state: idSchema, dependency: short.min(1), ecosystem: short.min(1), manifestPath: safePathSchema, affectedRange: short.min(1), availableFix: short.nullable(), ghsa: short.min(1), cve: short.nullable(), identifiers: z.array(short).max(32) }),
  z.strictObject({ kind: z.literal('sentry_issue'), status: idSchema, environment: short.nullable(), release: short.nullable(), eventId: idSchema.nullable(), exceptions: z.array(z.strictObject({ type: short.nullable(), value: short.nullable(), frames: z.array(z.strictObject({ filename: short.nullable(), function: short.nullable(), line: counterSchema.nullable(), column: counterSchema.nullable(), inApp: z.boolean().nullable() })).max(64) })).max(16) }),
  z.strictObject({ kind: z.literal('sentry_metric'), environment: short.nullable(), aggregate: short.min(1), query: short, windowMinutes: counterSchema.min(1), startedAt: short.min(1), closedAt: short.nullable() }),
  z.strictObject({ kind: z.literal('apm'), fingerprint: idSchema, environment: idSchema, observationWindow: genericApmPayloadSchema.shape.observationWindow, commit: commitSchema.nullable(), release: short.nullable(), metrics: genericApmPayloadSchema.shape.metrics, evidence: genericApmPayloadSchema.shape.evidence }),
] as const
export const normalizedIngressFactsSchema = z.strictObject({
  sourceEntityId: idSchema, providerEntityId: idSchema, trust: z.literal('unresolved'), invalidatesPending: z.boolean(),
  installationId: idSchema.nullable(), repositoryId: idSchema.nullable(), repositoryName: short.nullable(), organizationId: idSchema.nullable(),
  providerProjectIds: z.array(idSchema).max(64), authorId: idSchema.nullable(), actorId: idSchema.nullable(), ruleIds: z.array(short.min(1)).max(64),
  title: short.min(1), context, labels: z.array(z.string().min(1).max(128)).max(64), providerRevision: short.min(1),
  /** Digest of this observation only; authoritative reconciliation must derive sourceRevision. */
  observationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  nativeProviderTimestamp: z.string().max(32).nullable(), nativeTimestampAuthenticated: z.literal(false),
  details: z.discriminatedUnion('kind', detailSchemas),
})
export type NormalizedIngressFacts = z.output<typeof normalizedIngressFactsSchema>
type UnpinnedFacts = Omit<NormalizedIngressFacts, 'observationDigest'>
export interface NormalizedIngress { envelope: InboundEnvelopeWithoutArtifact; facts: NormalizedIngressFacts }
function allowed(action: string, actions: readonly string[]): void { if (!actions.includes(action)) throw new IngressError(422, 'EVENT_UNSUPPORTED', true) }
function boundCollections(value: unknown): void {
  let nodes = 0
  function visit(value: unknown): void {
    if (++nodes > 20_000) throw new IngressError(413, 'PAYLOAD_COLLECTION_LIMIT', true)
    if (typeof value !== 'object' || value === null) return
    const items = Object.values(value)
    if (items.length > 1024) throw new IngressError(413, 'PAYLOAD_COLLECTION_LIMIT', true)
    for (const item of items) visit(item)
  }
  visit(value)
}
/** Returned facts are untrusted prompt material; redact before persistence/export. */
export function normalizeIngress(frame: AuthenticatedIngress): NormalizedIngress {
  const bytes = authenticatedIngressBody(frame)
  try {
    const raw = parseStrictJson(bytes, bytes.length || 1)
    boundCollections(raw)
    const common: UnpinnedFacts = {
      sourceEntityId: '', providerEntityId: '', trust: 'unresolved', invalidatesPending: false, installationId: null, repositoryId: null, repositoryName: null, organizationId: null,
      providerProjectIds: [], authorId: null, actorId: null, ruleIds: [], title: '', context: '', labels: [], providerRevision: '',
      nativeProviderTimestamp: frame.nativeProviderTimestamp ?? null, nativeTimestampAuthenticated: false,
      details: { kind: 'issue', number: 1, state: 'open' },
    }
    let facts: UnpinnedFacts, action: string
    if (frame.route.source === 'github') {
      if (typeof raw !== 'object' || raw === null || ['issue', 'pull_request', 'alert'].filter(key => Object.hasOwn(raw, key)).length !== 1) throw new IngressError(422, 'PAYLOAD_AMBIGUOUS', true)
      if (frame.eventKind === 'issues') {
        const payload = githubIssue.parse(raw), entity = payload.issue
        action = payload.action; allowed(action, ['opened', 'edited', 'labeled', 'reopened', 'closed', 'unlabeled'])
        facts = { ...common, sourceEntityId: `issue:${payload.repository.id}:${entity.id}`, providerEntityId: entity.id, installationId: payload.installation?.id ?? null, repositoryId: payload.repository.id, repositoryName: payload.repository.full_name,
          authorId: entity.user.id, actorId: payload.sender.id, title: entity.title, context: entity.body ?? '', labels: entity.labels.map(label => label.name), providerRevision: entity.updated_at,
          invalidatesPending: action === 'closed' || action === 'unlabeled' || entity.state === 'closed', details: { kind: 'issue', number: entity.number, state: entity.state } }
      } else if (frame.eventKind === 'pull_request') {
        const payload = githubPr.parse(raw), entity = payload.pull_request
        action = payload.action; allowed(action, ['opened', 'synchronize', 'edited', 'labeled', 'reopened', 'closed', 'unlabeled'])
        if (entity.base.repo.id !== payload.repository.id) throw new IngressError(422, 'REPOSITORY_MISMATCH', true)
        facts = { ...common, sourceEntityId: `pr:${payload.repository.id}:${entity.id}`, providerEntityId: entity.id, installationId: payload.installation?.id ?? null, repositoryId: payload.repository.id, repositoryName: payload.repository.full_name,
          authorId: entity.user.id, actorId: payload.sender.id, title: entity.title, context: entity.body ?? '', labels: entity.labels.map(label => label.name), providerRevision: entity.updated_at,
          invalidatesPending: action === 'closed' || action === 'unlabeled' || entity.state === 'closed', details: { kind: 'pull_request', number: entity.number, state: entity.state, baseRepositoryId: entity.base.repo.id, headRepositoryId: entity.head.repo?.id ?? null, baseCommit: entity.base.sha, headCommit: entity.head.sha, fork: entity.head.repo?.id !== entity.base.repo.id } }
      } else if (frame.eventKind === 'dependabot_alert') {
        const payload = githubAlert.parse(raw), entity = payload.alert
        action = payload.action; allowed(action, ['created', 'reopened', 'reintroduced', 'fixed', 'dismissed', 'auto_dismissed', 'auto_reopened'])
        facts = { ...common, sourceEntityId: `dependabot:${payload.repository.id}:${entity.number}`, providerEntityId: String(entity.number), installationId: payload.installation?.id ?? null, repositoryId: payload.repository.id, repositoryName: payload.repository.full_name,
          actorId: payload.sender.id, title: entity.security_advisory.summary, providerRevision: entity.updated_at,
          invalidatesPending: ['fixed', 'dismissed', 'auto_dismissed'].includes(action) || entity.state !== 'open',
          details: { kind: 'dependabot_alert', number: entity.number, state: entity.state, dependency: entity.dependency.package.name, ecosystem: entity.dependency.package.ecosystem, manifestPath: entity.dependency.manifest_path,
            affectedRange: entity.security_vulnerability.vulnerable_version_range, availableFix: entity.security_vulnerability.first_patched_version?.identifier ?? null, ghsa: entity.security_advisory.ghsa_id, cve: entity.security_advisory.cve_id, identifiers: (entity.security_advisory.identifiers ?? []).map(item => item.value) } }
      } else throw new IngressError(422, 'EVENT_UNSUPPORTED', true)
    } else if (frame.route.source === 'sentry') {
      if (frame.eventKind === 'event_alert') {
        const payload = sentryEvent.parse(raw), event = payload.data.event
        action = payload.action; allowed(action, ['triggered'])
        facts = { ...common, sourceEntityId: `sentry-issue:${event.project}:${event.issue_id}`, providerEntityId: event.issue_id, installationId: payload.installation.uuid, providerProjectIds: [event.project], actorId: payload.actor.id,
          ruleIds: [payload.data.triggered_rule], title: event.title, providerRevision: event.datetime,
          details: { kind: 'sentry_issue', status: 'unresolved', eventId: event.event_id, environment: event.environment ?? event.tags?.find(tag => tag[0] === 'environment')?.[1] ?? null,
            release: typeof event.release === 'string' ? event.release : event.release?.version ?? null,
            exceptions: (event.exception?.values ?? []).map(exception => ({ type: exception.type ?? null, value: exception.value ?? null,
              frames: (exception.stacktrace?.frames ?? []).map(frame => ({ filename: frame.filename ?? null, function: frame.function ?? null, line: frame.lineno ?? null, column: frame.colno ?? null, inApp: frame.in_app ?? null })) })) } }
      } else if (frame.eventKind === 'issue') {
        const payload = sentryIssue.parse(raw), issue = payload.data.issue
        action = payload.action; allowed(action, ['created', 'resolved', 'assigned', 'archived', 'unresolved'])
        facts = { ...common, sourceEntityId: `sentry-issue:${issue.project.id}:${issue.id}`, providerEntityId: issue.id, installationId: payload.installation.uuid, providerProjectIds: [issue.project.id], actorId: payload.actor.id,
          title: issue.title, context: issue.culprit ?? '', providerRevision: issue.lastSeen, invalidatesPending: issue.status !== 'unresolved' || ['resolved', 'archived'].includes(action),
          details: { kind: 'sentry_issue', status: issue.status, eventId: null, environment: null, release: null, exceptions: [] } }
      } else if (frame.eventKind === 'metric_alert') {
        const payload = sentryMetric.parse(raw), alert = payload.data.metric_alert, rule = alert.alert_rule
        action = payload.action; allowed(action, ['critical', 'warning', 'resolved'])
        if (alert.organization_id !== rule.organization_id || [...alert.projects].sort().join('\0') !== [...rule.projects].sort().join('\0')) throw new IngressError(422, 'PROJECT_MISMATCH', true)
        facts = { ...common, sourceEntityId: `sentry-metric:${alert.organization_id}:${alert.id}`, providerEntityId: alert.id, installationId: payload.installation.uuid, organizationId: alert.organization_id, providerProjectIds: alert.projects,
          actorId: payload.actor.id, ruleIds: [rule.id], title: payload.data.description_title, context: payload.data.description_text, providerRevision: rule.date_modified,
          invalidatesPending: action === 'resolved', details: { kind: 'sentry_metric', environment: rule.environment ?? null, aggregate: rule.aggregate, query: rule.query, windowMinutes: rule.time_window, startedAt: alert.date_started, closedAt: alert.date_closed ?? null } }
      } else throw new IngressError(422, 'EVENT_UNSUPPORTED', true)
    } else {
      const payload = genericApmPayloadSchema.parse(raw)
      if (payload.evidence.some(artifact => artifact.projectId !== frame.route.projectId)) throw new IngressError(422, 'PROJECT_MISMATCH', true)
      action = payload.action
      facts = { ...common, sourceEntityId: `apm:${digestJson([payload.senderId, payload.providerProjectId, payload.fingerprint]).slice(7)}`, providerEntityId: payload.fingerprint, providerProjectIds: [payload.providerProjectId], actorId: payload.senderId, ruleIds: [payload.ruleId], title: payload.title, context: payload.context,
        providerRevision: payload.revision, invalidatesPending: action === 'resolved',
        details: { kind: 'apm', fingerprint: payload.fingerprint, environment: payload.environment, observationWindow: payload.observationWindow, commit: payload.commit, release: payload.release, metrics: payload.metrics, evidence: payload.evidence } }
    }
    facts.labels = [...new Set(facts.labels)].sort()
    const { nativeProviderTimestamp: _timestamp, ...revisionFacts } = facts
    const normalized = normalizedIngressFactsSchema.parse({ ...facts, observationDigest: digestJson({ action, ...revisionFacts }) })
    const envelope = {
      schemaVersion: 1 as const, id: `envelope:${digestJson([frame.route.source, frame.route.id, frame.deliveryId, frame.bodyDigest]).slice(7)}`,
      projectId: frame.route.projectId, policyRevision: frame.route.policyRevision, source: frame.route.source, adapterVersion: frame.route.providerVersion,
      routeId: frame.route.id, deliveryId: frame.deliveryId, eventKind: frame.eventKind, action, bodyDigest: frame.bodyDigest, receivedAt: frame.receivedAt,
      signingKeyId: frame.route.signingKeyId, authentication: 'verified' as const,
      ...(frame.authenticatedProviderAt === undefined ? {} : { providerAt: frame.authenticatedProviderAt }),
    }
    return { envelope, facts: normalized }
  } catch (error) {
    if (error instanceof IngressError) throw error
    throw new IngressError(422, 'PAYLOAD_INVALID', true)
  }
}
