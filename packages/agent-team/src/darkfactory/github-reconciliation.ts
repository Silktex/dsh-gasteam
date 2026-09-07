/** Read-only GitHub Issues reconciliation. The host binds an installation token to
 * installationId; /installation/repositories proves that token's repository access,
 * not its installation ID independently. Fetched text remains untrusted input.
 * https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation
 * https://docs.github.com/en/rest/issues/issues#get-an-issue
 */
import z from 'zod'
import { githubReconciliationRegistrationSchema, ingressPolicyRouteSchema, type IngressPolicyRoute } from './config.ts'
import { scannerInitiatorSchema } from './contracts/ingestion.ts'
import { idSchema, revisionSchema } from './contracts/common.ts'
import { digestJson, parseStrictJson } from './json.ts'

export type GithubReconciliationRegistration = z.output<typeof githubReconciliationRegistrationSchema>
export const githubIssueObservationSchema = z.strictObject({
  repositoryId: idSchema, providerEntityId: idSchema, actorId: idSchema, installationId: idSchema,
  initiator: scannerInitiatorSchema.optional(),
  kind: z.literal('issue'), number: z.number().int().positive().safe(), sourceEntityId: idSchema,
})
export type GithubIssueObservation = z.output<typeof githubIssueObservationSchema>
export type GithubReconciliationReason = 'RECONCILED' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_RESPONSE_INVALID' | 'SOURCE_DENIED'
export type GithubReconciliationDiagnostic = 'RECONCILED' | 'CONFIGURATION_INVALID' | 'OBSERVATION_INVALID' | 'INSTALLATION_NOT_ALLOWED' | 'REPOSITORY_NOT_ALLOWED' | 'ACTOR_NOT_ALLOWED' | 'REPOSITORY_NAME_MISMATCH' | 'REPOSITORY_NOT_VISIBLE' | 'PAGINATION_LIMIT' | 'RATE_LIMITED' | 'REQUEST_FAILED' | 'REQUEST_TIMEOUT' | 'HTTP_FAILURE' | 'RESPONSE_INVALID' | 'REDIRECT_REFUSED' | 'ISSUE_ID_MISMATCH' | 'PULL_REQUEST_UNSUPPORTED' | 'ISSUE_CLOSED' | 'AUTHOR_NOT_ALLOWED' | 'AUTOMATION_LABEL_MISSING' | 'REDACTION_FAILED' | 'PULL_REQUEST_FORK' | 'PULL_REQUEST_HEAD_MISSING' | 'PULL_REQUEST_BASE_MISMATCH' | 'PULL_REQUEST_HEAD_MISMATCH' | 'PULL_REQUEST_CLOSED' | 'PULL_REQUEST_ID_MISMATCH' | 'DEPENDABOT_POLICY_REQUIRED' | 'DEPENDABOT_RULE_NOT_ALLOWED' | 'DEPENDABOT_ID_MISMATCH' | 'DEPENDABOT_CLOSED' | 'DEPENDABOT_ADVISORY_WITHDRAWN' | 'DEPENDABOT_PACKAGE_MISMATCH'
export interface ReconciledGithubIssue {
  id: string; number: number; repositoryName: string; authorId: string; actorId: string
  title: string; context: string; labels: string[]; sourceUrl: string; updatedAt: string
}
export interface GithubIssueProvenance {
  schemaVersion: 1; provider: 'github'; resource: 'issue'; projectId: string; routeId: string; policyRevision: number
  installationId: string; credentialBinding: 'host-pinned-installation-token'; repositoryId: string; repositoryName: string
  providerEntityId: string; sourceEntityId: string; actorId: string; checkedAt: string; sourceRevision: string
  responseDigests: string[]; requestsUsed: number; initiator?: z.output<typeof scannerInitiatorSchema>
}
export interface GithubReconciliationResultBase { reasons: GithubReconciliationReason[]; diagnosticCode: GithubReconciliationDiagnostic; checkedAt: string; requestsUsed: number }
export type GithubIssueReconciliationResult = (GithubReconciliationResultBase & { decision: 'trusted'; sourceRevision: string; issue: ReconciledGithubIssue; provenance: GithubIssueProvenance }) | (GithubReconciliationResultBase & { decision: 'denied' }) | (GithubReconciliationResultBase & { decision: 'unresolved' })
export interface GithubIssueReconciliationOptions {
  registration: GithubReconciliationRegistration; observed: GithubIssueObservation; route: IngressPolicyRoute
  projectId: string; policyRevision: number; secret: string; redactText: (value: string) => string
  now?: () => Date; signal?: AbortSignal; transport?: typeof fetch; maxPages?: number; maxBodyBytes?: number; requestTimeoutMs?: number; totalTimeoutMs?: number
  /** Host accounting hook, called before every GET and under the request deadline. */
  beforeRequest?: () => void | Promise<void>
  /** Persist only this normalized UTC deadline, never raw response headers. */
  onRateLimit?: (until: string) => void | Promise<void>
}
export const githubProviderIdSchema = z.union([z.number().int().positive().safe().transform(String), z.string().regex(/^[1-9][0-9]*$/).max(128)])
export const githubRepositoryNameSchema = z.string().max(256).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
const repositoriesSchema = z.object({ total_count: z.number().int().nonnegative().safe(), repositories: z.array(z.object({ id: githubProviderIdSchema, full_name: githubRepositoryNameSchema })).max(100) })
export const githubCurrentIssueSchema = z.object({
  id: githubProviderIdSchema, number: z.number().int().positive().safe(), title: z.string().min(1).max(1024), body: z.string().max(16384).nullable(),
  user: z.object({ id: githubProviderIdSchema }), labels: z.array(z.object({ id: githubProviderIdSchema, name: z.string().min(1).max(128) })).max(100),
  state: z.enum(['open', 'closed']), updated_at: z.iso.datetime(),
})
export class GithubProviderFailure extends Error {
  constructor(readonly reason: GithubReconciliationReason, readonly diagnostic: GithubReconciliationDiagnostic) { super(diagnostic) }
}
const invalid = () => new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID')

type GithubResourceObservation = Omit<GithubIssueObservation, 'kind'>
export type GithubResourceOptions<O extends GithubResourceObservation> = Omit<GithubIssueReconciliationOptions, 'observed'> & { observed: O }
export type GithubResourceFailureResult = (GithubReconciliationResultBase & { decision: 'denied' }) | (GithubReconciliationResultBase & { decision: 'unresolved' })
export type GithubResourceResult<T extends object> = GithubResourceFailureResult | (GithubReconciliationResultBase & { decision: 'trusted' } & T)
export interface GithubResourceContext<O extends GithubResourceObservation> {
  observed: O; pinned: GithubReconciliationRegistration; route: Extract<IngressPolicyRoute, { source: 'github' }>; checkedAt: string
  get(path: string): Promise<unknown>; redact(value: string, limit: number): string
  provenance<R extends string>(resource: R, sourceRevision: string): Omit<GithubIssueProvenance, 'resource'> & { resource: R }
}
/** The registered collection reader establishes repository visibility without inventing an entity actor. */
export interface GithubRegisteredResourceContext {
  pinned: GithubReconciliationRegistration; route: Extract<IngressPolicyRoute, { source: 'github' }>; checkedAt: string
  get(path: string): Promise<unknown>; redact(value: string, limit: number): string
  responseDigests(): string[]; requestsUsed(): number
}
export async function reconcileGithubResource<O extends GithubResourceObservation, T extends object>(
  options: GithubResourceOptions<O>, observationSchema: z.ZodType<O>, read: (context: GithubResourceContext<O>) => Promise<T>,
  validateObservation?: (observed: O, pinned: GithubReconciliationRegistration) => void,
): Promise<GithubResourceResult<T>> {
  let observed: O
  return readGithubRegisteredResource(options, async context => {
    const { pinned, route, checkedAt } = context
    return read({ ...context, observed, provenance: (resource, sourceRevision) => ({
      schemaVersion: 1, provider: 'github', resource, projectId: options.projectId, routeId: route.id, policyRevision: options.policyRevision,
      installationId: pinned.installationId, credentialBinding: 'host-pinned-installation-token', repositoryId: pinned.repositoryId, repositoryName: pinned.repositoryName,
      providerEntityId: observed.providerEntityId, sourceEntityId: observed.sourceEntityId, actorId: observed.actorId,
      checkedAt, sourceRevision, responseDigests: context.responseDigests(), requestsUsed: context.requestsUsed(),
      ...(observed.initiator ? { initiator: observed.initiator } : {}),
    }) })
  }, (pinned, route) => {
    const parsed = observationSchema.safeParse(options.observed)
    if (!parsed.success) throw new GithubProviderFailure('SOURCE_DENIED', 'OBSERVATION_INVALID')
    observed = parsed.data
    if (pinned.installationId !== observed.installationId) throw new GithubProviderFailure('SOURCE_DENIED', 'INSTALLATION_NOT_ALLOWED')
    if (pinned.repositoryId !== observed.repositoryId) throw new GithubProviderFailure('SOURCE_DENIED', 'REPOSITORY_NOT_ALLOWED')
    if (!route.senderIds.includes(observed.actorId)) throw new GithubProviderFailure('SOURCE_DENIED', 'ACTOR_NOT_ALLOWED')
    if (observed.actorId.startsWith('host-scanner:') && !observed.initiator) throw new GithubProviderFailure('SOURCE_DENIED', 'ACTOR_NOT_ALLOWED')
    if (observed.initiator) {
      const scan = pinned.scan
      if (!scan || observed.actorId !== scan.scannerId || observed.initiator.scannerId !== scan.scannerId || observed.initiator.ruleId !== scan.ruleId ||
        !route.ruleIds.includes(scan.ruleId) || route.bindings.automationRules.filter(rule => rule.ruleId === scan.ruleId).length !== 1) throw new GithubProviderFailure('SOURCE_DENIED', 'ACTOR_NOT_ALLOWED')
    }
    validateObservation?.(observed, pinned)
  })
}
/** Shared host-only bounded transport. Adapter paths are built from registered identities. */
export async function readGithubRegisteredResource<T extends object>(
  options: Omit<GithubIssueReconciliationOptions, 'observed'>,
  read: (context: GithubRegisteredResourceContext) => Promise<T>,
  validateRegistration?: (pinned: GithubReconciliationRegistration, route: Extract<IngressPolicyRoute, { source: 'github' }>) => void,
): Promise<GithubResourceResult<T>> {
  let requestsUsed = 0
  const checkedAt = (options.now?.() ?? new Date()).toISOString()
  const fail = (reason: GithubReconciliationReason, diagnosticCode: GithubReconciliationDiagnostic): GithubResourceFailureResult => ({ decision: reason === 'SOURCE_DENIED' ? 'denied' : 'unresolved', reasons: [reason], diagnosticCode, checkedAt, requestsUsed })
  const registration = githubReconciliationRegistrationSchema.safeParse(options.registration)
  const policy = ingressPolicyRouteSchema.safeParse(options.route)
  const maxPages = options.maxPages ?? 10, maxBodyBytes = options.maxBodyBytes ?? 1_048_576
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000, totalTimeoutMs = options.totalTimeoutMs ?? 15_000
  if (!registration.success || !policy.success || policy.data.source !== 'github' || !idSchema.safeParse(options.projectId).success || !revisionSchema.safeParse(options.policyRevision).success || policy.data.projectId !== options.projectId ||
    typeof options.secret !== 'string' || !options.secret.length || options.secret.length > 8192 || /[\r\n]/.test(options.secret) || typeof options.redactText !== 'function' ||
    !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1_048_576 ||
    !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10_000 || !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 15_000) return fail('SOURCE_DENIED', 'CONFIGURATION_INVALID')
  const pinned = registration.data, route = policy.data
  if (pinned.repositoryName.split('/').some(part => part === '.' || part === '..') || (route.reconciliation && digestJson(route.reconciliation) !== digestJson(pinned))) return fail('SOURCE_DENIED', 'CONFIGURATION_INVALID')
  if (!route.bindings.installationIds.includes(pinned.installationId)) return fail('SOURCE_DENIED', 'INSTALLATION_NOT_ALLOWED')
  if (!route.repositoryIds.includes(pinned.repositoryId)) return fail('SOURCE_DENIED', 'REPOSITORY_NOT_ALLOWED')
  const deadline = performance.now() + totalTimeoutMs, responseDigests: string[] = []
  let remaining: number | undefined
  // https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately
  function rateLimitUntil(headers: Headers): string {
    const now = (options.now?.() ?? new Date()).getTime(), maxDate = 253402300799999
    if (!Number.isSafeInteger(now) || now < 0 || now > maxDate - 60_000) throw invalid()
    const candidates: number[] = []
    const deadlineFrom = (raw: string | null, relative: boolean) => {
      const seconds = raw !== null && /^[0-9]+$/.test(raw) ? Number(raw) : NaN
      const at = (relative ? now : 0) + seconds * 1000
      if (Number.isSafeInteger(seconds) && Number.isSafeInteger(at) && at > now && at <= maxDate) candidates.push(at)
      else candidates.push(now + 60_000)
    }
    const retry = headers.get('retry-after')
    if (retry !== null) deadlineFrom(retry, true)
    if (headers.get('x-ratelimit-remaining') === '0') deadlineFrom(headers.get('x-ratelimit-reset'), false)
    // Use every applicable valid deadline; never shorten a server's long reset.
    return new Date(candidates.length ? Math.max(...candidates) : now + 60_000).toISOString()
  }
  async function get(path: string): Promise<unknown> {
    if (options.signal?.aborted) throw new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_FAILED')
    if (remaining === 0) throw new GithubProviderFailure('PROVIDER_RATE_LIMITED', 'RATE_LIMITED')
    const timeoutMs = Math.min(requestTimeoutMs, deadline - performance.now())
    if (timeoutMs <= 0) throw new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortExternal: (() => void) | undefined
    const url = new URL(path, pinned.apiBaseUrl).href
    try {
      return await Promise.race([
        (async () => {
          await options.beforeRequest?.()
          if (controller.signal.aborted) throw new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')
          requestsUsed++
          const response = await (options.transport ?? fetch)(url, { method: 'GET', redirect: 'manual', signal: controller.signal,
            headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${options.secret}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'gasteam-darkfactory' } })
          if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT') }
          const discard = () => { void response.body?.cancel().catch(() => {}) }
          if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) { discard(); throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'REDIRECT_REFUSED') }
          const recordCooldown = async () => {
            await options.onRateLimit?.(rateLimitUntil(response.headers))
            if (controller.signal.aborted) throw new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')
          }
          if (response.status === 429 || response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0')) {
            discard(); await recordCooldown(); throw new GithubProviderFailure('PROVIDER_RATE_LIMITED', 'RATE_LIMITED')
          }
          if (response.status !== 200) { discard(); throw new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'HTTP_FAILURE') }
          const limit = response.headers.get('x-ratelimit-remaining')
          if (limit !== null && /^\d+$/.test(limit) && Number.isSafeInteger(Number(limit))) remaining = Number(limit)
          if (remaining === 0) { try { await recordCooldown() } catch (error) { discard(); throw error } }
          const length = response.headers.get('content-length')
          if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes) || !/^application\/(?:json|vnd\.github\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { discard(); throw invalid() }
          if (!response.body) throw invalid()
          const reader = response.body.getReader(), chunks: Uint8Array[] = []
          let bytes = 0
          const abort = () => { void reader.cancel().catch(() => {}) }
          controller.signal.addEventListener('abort', abort, { once: true })
          try {
            while (true) {
              const chunk = await reader.read()
              if (controller.signal.aborted) throw new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')
              if (chunk.done) break
              bytes += chunk.value.byteLength
              if (bytes > maxBodyBytes) throw invalid()
              chunks.push(chunk.value)
            }
            let parsed: unknown
            try { parsed = parseStrictJson(Buffer.concat(chunks), maxBodyBytes) } catch { throw invalid() }
            responseDigests.push(digestJson(parsed))
            return parsed
          } finally { controller.signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock() }
        })(),
        new Promise<never>((_, reject) => {
          abortExternal = () => { controller.abort(); reject(new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_FAILED')) }
          options.signal?.addEventListener('abort', abortExternal, { once: true })
          if (options.signal?.aborted) abortExternal()
          timer = setTimeout(() => { controller.abort(); reject(new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')) }, timeoutMs)
        }),
      ])
    } catch (error) { if (error instanceof GithubProviderFailure) throw error; throw new GithubProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_FAILED') }
    finally { if (timer) clearTimeout(timer); if (abortExternal) options.signal?.removeEventListener('abort', abortExternal) }
  }
  try {
    validateRegistration?.(pinned, route)
    let visible = false, total: number | undefined
    const seen = new Set<string>()
    for (let page = 1; page <= maxPages; page++) {
      const parsed = repositoriesSchema.safeParse(await get(`/installation/repositories?per_page=100&page=${page}`))
      if (!parsed.success) throw invalid()
      const data = parsed.data
      if (total !== undefined && total !== data.total_count) throw invalid()
      total = data.total_count
      for (const repository of data.repositories) {
        if (seen.has(repository.id)) throw invalid()
        seen.add(repository.id)
        if (repository.id === pinned.repositoryId) {
          if (repository.full_name.toLowerCase() !== pinned.repositoryName.toLowerCase()) return fail('SOURCE_DENIED', 'REPOSITORY_NAME_MISMATCH')
          visible = true
        }
      }
      if (seen.size > total) throw invalid()
      if (visible) break
      if (seen.size === total) return fail('SOURCE_DENIED', 'REPOSITORY_NOT_VISIBLE')
      if (data.repositories.length !== 100) throw invalid()
    }
    if (!visible) return fail('PROVIDER_UNAVAILABLE', 'PAGINATION_LIMIT')
    const redact = (value: string, limit: number) => {
      let result: string
      try { result = options.redactText(value) } catch { throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'REDACTION_FAILED') }
      if (typeof result !== 'string' || !result.isWellFormed()) throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'REDACTION_FAILED')
      const bounded = result.split(options.secret).join('[REDACTED]').slice(0, limit)
      return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded
    }
    const context: GithubRegisteredResourceContext = { pinned, route, checkedAt, get, redact,
      responseDigests: () => [...responseDigests], requestsUsed: () => requestsUsed,
    }
    const value = await read(context)
    return { decision: 'trusted', reasons: ['RECONCILED'], diagnosticCode: 'RECONCILED', checkedAt, requestsUsed, ...value }
  } catch (error) { return error instanceof GithubProviderFailure ? fail(error.reason, error.diagnostic) : fail('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID') }
}

export async function reconcileGithubIssue(options: GithubIssueReconciliationOptions): Promise<GithubIssueReconciliationResult> {
  return reconcileGithubResource(options, githubIssueObservationSchema, async context => {
    const { observed, pinned, route, get, redact } = context
    // Both path components come from host registration, never webhook or API URLs.
    const raw = await get(`/repos/${pinned.repositoryName.split('/').map(encodeURIComponent).join('/')}/issues/${observed.number}`)
    if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'pull_request')) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_UNSUPPORTED')
    const parsed = githubCurrentIssueSchema.safeParse(raw)
    if (!parsed.success) throw invalid()
    const current = parsed.data
    if (current.id !== observed.providerEntityId || current.number !== observed.number) throw new GithubProviderFailure('SOURCE_DENIED', 'ISSUE_ID_MISMATCH')
    if (current.state !== 'open') throw new GithubProviderFailure('SOURCE_DENIED', 'ISSUE_CLOSED')
    if (!route.bindings.authorIds.includes(current.user.id)) throw new GithubProviderFailure('SOURCE_DENIED', 'AUTHOR_NOT_ALLOWED')
    if (!route.bindings.automationRules.some(rule => route.ruleIds.includes(rule.ruleId) && (!observed.initiator || rule.ruleId === observed.initiator.ruleId) && current.labels.some(label => label.name === rule.automationLabel))) throw new GithubProviderFailure('SOURCE_DENIED', 'AUTOMATION_LABEL_MISSING')
    if (new Set(current.labels.map(label => label.id)).size !== current.labels.length) throw invalid()
    const labels = [...current.labels].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const sourceRevision = digestJson({ repositoryId: pinned.repositoryId, providerEntityId: current.id, number: current.number, authorId: current.user.id,
      title: current.title, body: current.body, labels, state: current.state, updatedAt: current.updated_at })
    const issue: ReconciledGithubIssue = { id: current.id, number: current.number, repositoryName: pinned.repositoryName, authorId: current.user.id, actorId: observed.actorId,
      title: redact(current.title, 1024), context: redact(current.body ?? '', 16384), labels: labels.map(label => redact(label.name, 128)), updatedAt: current.updated_at,
      sourceUrl: `https://github.com/${pinned.repositoryName}/issues/${current.number}` }
    const provenance = context.provenance('issue', sourceRevision)
    return { sourceRevision, issue, provenance }
  })
}
