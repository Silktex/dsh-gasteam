/** Read-only current Dependabot alert evidence and explicit host sensor authority.
 * The REST response has no author/current event actor. Both normalized work
 * principals are host-configured; the signed webhook sender is only provenance.
 * GitHub App installation tokens need Dependabot alerts repository read access.
 * https://docs.github.com/en/rest/dependabot/alerts#get-a-dependabot-alert
 */
import z from 'zod'
import { safePathSchema } from './contracts/common.ts'
import { canonicalJson, digestJson } from './json.ts'
import {
  githubIssueObservationSchema, GithubProviderFailure, reconcileGithubResource,
  type GithubIssueProvenance, type GithubResourceOptions, type GithubResourceResult, type ReconciledGithubIssue,
} from './github-reconciliation.ts'

export const githubDependabotObservationSchema = githubIssueObservationSchema.extend({ kind: z.literal('dependabot_alert') })
export type GithubDependabotObservation = z.output<typeof githubDependabotObservationSchema>
const short = z.string().min(1).max(1024), severity = z.enum(['low', 'medium', 'high', 'critical'])
const packageSchema = z.object({ ecosystem: z.string().min(1).max(128), name: z.string().min(1).max(256) })
const vulnerabilitySchema = z.object({ package: packageSchema, severity, vulnerable_version_range: short,
  first_patched_version: z.object({ identifier: short }).nullable() })
const ghsa = z.string().regex(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/), cve = z.string().regex(/^CVE-[0-9]{4}-[0-9]{4,}$/).max(128)
export const githubCurrentDependabotAlertSchema = z.object({
  number: z.number().int().positive().safe(), state: z.enum(['open', 'fixed', 'dismissed', 'auto_dismissed']),
  dependency: z.object({ package: packageSchema, manifest_path: safePathSchema, scope: z.enum(['runtime', 'development']), relationship: z.enum(['direct', 'indirect', 'unknown']).optional() }),
  security_advisory: z.object({ ghsa_id: ghsa, cve_id: cve.nullable(), summary: short, description: z.string().max(16384), severity,
    identifiers: z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('GHSA'), value: ghsa }), z.object({ type: z.literal('CVE'), value: cve })])).min(1).max(32),
    vulnerabilities: z.array(vulnerabilitySchema).min(1).max(256), published_at: z.iso.datetime(), updated_at: z.iso.datetime(), withdrawn_at: z.iso.datetime().nullable(),
  }),
  security_vulnerability: vulnerabilitySchema, created_at: z.iso.datetime(), updated_at: z.iso.datetime(),
  dismissed_at: z.iso.datetime().nullable(), fixed_at: z.iso.datetime().nullable(),
})
export interface ReconciledGithubDependabotAlert extends ReconciledGithubIssue {
  kind: 'dependabot_alert'
  dependency: { package: string; ecosystem: string; manifestPath: string; scope: 'runtime' | 'development'; relationship: 'direct' | 'indirect' | 'unknown' }
  advisory: { ghsa: string; cve: string | null; identifiers: string[]; severity: 'low' | 'medium' | 'high' | 'critical'; affectedRange: string; availableFix: string | null; updatedAt: string }
}
export interface GithubDependabotProvenance extends Omit<GithubIssueProvenance, 'resource'> {
  resource: 'dependabot_alert'; identityBinding: 'host-configured-dependabot-sensor'; sensorPrincipalId: string; ruleId: string; automationLabel: string
  webhookActorId: string; webhookActorBinding: 'signed-webhook-observation-not-current-provider'
  dependency: ReconciledGithubDependabotAlert['dependency']; advisory: ReconciledGithubDependabotAlert['advisory']
}
export type GithubDependabotReconciliationOptions = GithubResourceOptions<GithubDependabotObservation>
export type GithubDependabotReconciliationResult = GithubResourceResult<{ sourceRevision: string; issue: ReconciledGithubDependabotAlert; provenance: GithubDependabotProvenance }>

export async function reconcileGithubDependabotAlert(options: GithubDependabotReconciliationOptions): Promise<GithubDependabotReconciliationResult> {
  return reconcileGithubResource(options, githubDependabotObservationSchema, async context => {
    const { observed, pinned, route, get, redact } = context, sensor = pinned.dependabot
    if (!sensor || !route.bindings.authorIds.includes(sensor.sensorPrincipalId)) throw new GithubProviderFailure('SOURCE_DENIED', 'DEPENDABOT_POLICY_REQUIRED')
    const rules = route.bindings.automationRules.filter(rule => rule.ruleId === sensor.ruleId && route.ruleIds.includes(rule.ruleId))
    if (rules.length !== 1) throw new GithubProviderFailure('SOURCE_DENIED', 'DEPENDABOT_RULE_NOT_ALLOWED')
    const rule = rules[0]!
    const parsed = githubCurrentDependabotAlertSchema.safeParse(await get(`/repos/${pinned.repositoryName.split('/').map(encodeURIComponent).join('/')}/dependabot/alerts/${observed.number}`))
    if (!parsed.success) throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID')
    const current = parsed.data, advisory = current.security_advisory, vulnerability = current.security_vulnerability
    if (current.number !== observed.number) throw new GithubProviderFailure('SOURCE_DENIED', 'DEPENDABOT_ID_MISMATCH')
    if (current.state !== 'open') throw new GithubProviderFailure('SOURCE_DENIED', 'DEPENDABOT_CLOSED')
    if (advisory.withdrawn_at !== null) throw new GithubProviderFailure('SOURCE_DENIED', 'DEPENDABOT_ADVISORY_WITHDRAWN')
    if (canonicalJson(current.dependency.package) !== canonicalJson(vulnerability.package) || !advisory.vulnerabilities.some(value => canonicalJson(value) === canonicalJson(vulnerability))) throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'DEPENDABOT_PACKAGE_MISMATCH')
    if (Date.parse(current.updated_at) < Date.parse(current.created_at) || Date.parse(advisory.updated_at) < Date.parse(advisory.published_at) ||
      new Set(advisory.identifiers.map(value => value.value)).size !== advisory.identifiers.length ||
      !advisory.identifiers.some(value => value.type === 'GHSA' && value.value === advisory.ghsa_id) ||
      advisory.identifiers.some(value => value.type === 'GHSA' ? value.value !== advisory.ghsa_id : value.value !== advisory.cve_id)) throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID')
    const identifiers = [...advisory.identifiers].sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
    const vulnerabilities = [...advisory.vulnerabilities].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0)
    const sourceRevision = digestJson({ resource: 'dependabot_alert', repositoryId: pinned.repositoryId,
      ...current, security_advisory: { ...advisory, identifiers, vulnerabilities } })
    const dependency: ReconciledGithubDependabotAlert['dependency'] = { package: redact(current.dependency.package.name, 256), ecosystem: redact(current.dependency.package.ecosystem, 128),
      manifestPath: redact(current.dependency.manifest_path, 1024), scope: current.dependency.scope, relationship: current.dependency.relationship ?? 'unknown' }
    const normalizedAdvisory: ReconciledGithubDependabotAlert['advisory'] = { ghsa: redact(advisory.ghsa_id, 128), cve: advisory.cve_id === null ? null : redact(advisory.cve_id, 128),
      identifiers: identifiers.map(value => redact(value.value, 128)), severity: vulnerability.severity, affectedRange: redact(vulnerability.vulnerable_version_range, 1024),
      availableFix: vulnerability.first_patched_version === null ? null : redact(vulnerability.first_patched_version.identifier, 1024), updatedAt: advisory.updated_at }
    const issue: ReconciledGithubDependabotAlert = { kind: 'dependabot_alert', id: String(current.number), number: current.number, repositoryName: pinned.repositoryName,
      authorId: sensor.sensorPrincipalId, actorId: sensor.sensorPrincipalId, title: redact(advisory.summary, 1024),
      context: redact(canonicalJson({ description: advisory.description, dependency, advisory: normalizedAdvisory }), 16384), labels: [rule.automationLabel],
      sourceUrl: `https://github.com/${pinned.repositoryName}/security/dependabot/${current.number}`, updatedAt: current.updated_at, dependency, advisory: normalizedAdvisory }
    const provenance: GithubDependabotProvenance = { ...context.provenance('dependabot_alert', sourceRevision), actorId: sensor.sensorPrincipalId,
      identityBinding: 'host-configured-dependabot-sensor', sensorPrincipalId: sensor.sensorPrincipalId, ruleId: rule.ruleId, automationLabel: rule.automationLabel,
      webhookActorId: observed.actorId, webhookActorBinding: 'signed-webhook-observation-not-current-provider', dependency, advisory: normalizedAdvisory }
    return { sourceRevision, issue, provenance }
  }, (observed, pinned) => {
    if (!pinned.dependabot) throw new GithubProviderFailure('SOURCE_DENIED', 'DEPENDABOT_POLICY_REQUIRED')
    if (observed.providerEntityId !== String(observed.number) || observed.sourceEntityId !== `dependabot:${observed.repositoryId}:${observed.number}`) throw new GithubProviderFailure('SOURCE_DENIED', 'DEPENDABOT_ID_MISMATCH')
  })
}
