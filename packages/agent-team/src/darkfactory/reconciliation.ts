/** Coordinator-owned read-only source reconciliation. No model, workflow, or dispatch authority. */
import z from 'zod'
import type { EnabledDarkFactoryConfig, IngressPolicyRoute } from './config.ts'
import { idSchema, inboundWorkItemSchema } from './contracts/index.ts'
import type { SecretRef } from './contracts/index.ts'
import { DarkFactoryArtifactStore } from './artifacts.ts'
import { DarkFactoryIngestionStore, IngressEscalationRequiredError } from './ingestion-store.ts'
import { reconcileGithubIssue, githubIssueObservationSchema, GithubProviderFailure } from './github-reconciliation.ts'
import { DarkFactoryProviderRequestStore, ProviderRequestDeniedError } from './provider-request-store.ts'
import { reconcileGithubPullRequest, githubPullRequestObservationSchema, githubScannedPullRequestObservationSchema } from './github-pr-reconciliation.ts'
import { reconcileGithubDependabotAlert, githubDependabotObservationSchema } from './github-dependabot-reconciliation.ts'
import { digestJson } from './json.ts'
import { resolveSecret } from './secrets.ts'
import { assertGithubRepository, redactProviderText } from './reconciliation-safety.ts'

export const githubIssueLookupSchema = githubIssueObservationSchema
export const githubReconciliationLookupSchema = z.discriminatedUnion('kind', [githubIssueLookupSchema, githubPullRequestObservationSchema, githubDependabotObservationSchema, githubScannedPullRequestObservationSchema])
type GithubRoute = Extract<IngressPolicyRoute, { source: 'github' }>
const sourceRevocations = new Set(['ISSUE_CLOSED', 'AUTOMATION_LABEL_MISSING', 'AUTHOR_NOT_ALLOWED', 'PULL_REQUEST_CLOSED', 'PULL_REQUEST_FORK', 'PULL_REQUEST_HEAD_MISSING', 'PULL_REQUEST_BASE_MISMATCH', 'PULL_REQUEST_HEAD_MISMATCH'])
class SourceInvalidationAuthorityDenied extends Error {}
export interface ReconciliationHost {
  projects: readonly { id: string; repository: string }[]
  stores: ReadonlyMap<string, DarkFactoryIngestionStore>
  artifacts: DarkFactoryArtifactStore
  authorize(projectId: string, effectId: string): Promise<void>
  quarantine(input: { projectId: string; envelopeId: string; reason: string }): Promise<string>
  resolveSecret?: (reference: SecretRef) => Promise<string>
  transport?: typeof fetch
  clock?: () => number
  /** Shared coordinator-wide accounting; standalone legacy hosts retain bounded start leases. */
  requestBudget?: DarkFactoryProviderRequestStore
  beforeDrain?: () => Promise<void>
}

export class DarkFactoryReconciler {
  private readonly abort = new AbortController()
  private pending: Promise<void> | undefined
  private readonly previousSecrets = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private constructor(private readonly policy: EnabledDarkFactoryConfig, private readonly host: ReconciliationHost,
    private readonly routes: GithubRoute[], private readonly secrets: Map<string, string>) {}

  static async open(policy: EnabledDarkFactoryConfig, host: ReconciliationHost): Promise<DarkFactoryReconciler> {
    if (policy.mode !== 'observe') throw new Error('Only observe reconciliation is implemented')
    const routes = policy.ingestion.routes.filter((route): route is GithubRoute => route.source === 'github' && !!route.reconciliation)
    const secrets = new Map<string, string>()
    for (const route of routes) {
      const project = host.projects.find(project => project.id === route.projectId)
      if (!project || !host.stores.has(project.id)) throw new Error('Reconciliation project is not registered')
      await assertGithubRepository(project.repository, route.reconciliation!.repositoryName)
      secrets.set(route.id, await (host.resolveSecret ?? resolveSecret)(route.reconciliation!.credentialRef))
    }
    return new DarkFactoryReconciler(policy, host, routes, secrets)
  }
  start(): void {
    if (this.timer || (!this.routes.length && !this.host.beforeDrain) || this.abort.signal.aborted) return
    // Wake bounded pending custody promptly; retry eligibility lives in the journal.
    this.timer = setInterval(() => { void this.runOnce().catch(() => {}) }, Math.min(1000, this.policy.ingestion.reconciliationIntervalMs))
    this.timer.unref()
    void this.runOnce().catch(() => {})
  }
  runOnce(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve()
    return this.pending ??= this.drain().finally(() => { this.pending = undefined })
  }
  private now(): string { return new Date((this.host.clock ?? Date.now)()).toISOString() }
  private async budgetMutation<T>(operation: (expectedRevision: number) => Promise<T>): Promise<T> {
    const budget = this.host.requestBudget!
    for (let tries = 0; ; tries++) {
      const revision = budget.snapshot().revision
      try { return await operation(revision) } catch (error) {
        if (tries >= 3 || budget.snapshot().revision === revision) throw error
      }
    }
  }
  private async mutate<T>(store: DarkFactoryIngestionStore, operation: (expectedRevision: number) => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      const revision = store.snapshot().revision
      try { return await operation(revision) } catch (error) {
        if (tries >= 3 || store.snapshot().revision === revision) throw error
      }
    }
  }
  private async invalidateSource(store: DarkFactoryIngestionStore, route: GithubRoute, lookup: z.output<typeof githubReconciliationLookupSchema>, observedAt: string, diagnostic: string, envelopeId: string): Promise<void> {
    const registered = route.reconciliation!
    if (lookup.kind === 'dependabot_alert' || lookup.repositoryId !== registered.repositoryId) return
    const source = lookup.kind === 'issue' ? `issue:${registered.repositoryId}:${lookup.providerEntityId}` : `pr:${registered.repositoryId}:${lookup.providerEntityId}`
    if (lookup.sourceEntityId !== (lookup.kind === 'scanned_pull_request' ? `pr-number:${registered.repositoryId}:${lookup.number}` : source)) return
    const url = `https://github.com/${registered.repositoryName}/${lookup.kind === 'issue' ? 'issues' : 'pull'}/${lookup.number}`
    const matches = (item: ReturnType<DarkFactoryIngestionStore['snapshot']>['items'][number]) =>
      item.projectId === route.projectId && item.source === 'github' && item.repository.provider === 'github' && item.repository.repositoryId === registered.repositoryId &&
      item.repository.canonicalName.toLowerCase() === registered.repositoryName.toLowerCase() && item.sourceUrl === url &&
      (lookup.kind === 'scanned_pull_request' ? item.sourceEntityId.startsWith(`pr:${registered.repositoryId}:`) : item.sourceEntityId === source) && !['acknowledged', 'quarantined'].includes(item.state)
    const authorize = async (id: string) => {
      try { await this.host.authorize(route.projectId, `reconcile-revoke-${digestJson([envelopeId, id]).slice(7)}`) }
      catch { throw new SourceInvalidationAuthorityDenied() }
    }
    await authorize(envelopeId)
    for (const original of store.snapshot().items.filter(matches)) {
      for (let attempt = 0; ; attempt++) {
        const current = store.snapshot().items.find(item => item.id === original.id)
        if (!current || !matches(current)) break
        await authorize(current.id)
        const healthEscalationId = await this.host.quarantine({ projectId: route.projectId, envelopeId: current.envelopeId, reason: 'SOURCE_DENIED' })
        await authorize(current.id)
        if (this.abort.signal.aborted) throw new Error('Source invalidation interrupted')
        try {
          await store.transition({ projectId: route.projectId, expectedRevision: current.revision, item: { ...current, state: 'quarantined', revision: current.revision + 1,
            quarantineReason: 'SOURCE_DENIED', healthEscalationId, trust: { ...current.trust, decision: 'revoked', reasons: ['SOURCE_DENIED', diagnostic], checkedAt: observedAt, authorityRevision: this.policy.policyRevision },
          } })
          break
        } catch (error) {
          const latest = store.snapshot().items.find(item => item.id === current.id)
          if (attempt >= 3 || latest?.revision === current.revision) throw error
        }
      }
    }
  }
  private async drain(): Promise<void> {
    await this.host.beforeDrain?.()
    let processed = 0
    const projects = [...this.host.stores]
    const lastChargedProject = this.host.requestBudget?.snapshot().charges.at(-1)?.projectId
    const previous = projects.findIndex(([projectId]) => projectId === lastChargedProject)
    // The actual GET charge is the durable fairness cursor, including interrupted reads.
    const ordered = previous < 0 ? projects : [...projects.slice(previous + 1), ...projects.slice(0, previous + 1)]
    for (const [projectId, store] of ordered) {
      const routeIds = this.routes.filter(route => route.projectId === projectId).map(route => route.id)
      if (!routeIds.length) continue
      for (const candidate of store.pendingReconciliations({ projectId, at: this.now(), limit: 10, routeIds })) {
        if (this.abort.signal.aborted || processed++ >= 10) return
        const envelope = candidate.custody.envelope
        const route = this.routes.find(route => route.id === envelope.routeId)!
        const state = store.snapshot()
        const attachment = state.attachments.find(value => value.envelopeId === envelope.id && value.decision === 'quarantined')
        const attached = state.items.find(value => value.id === candidate.custody.itemId)
        if (candidate.cursor && !candidate.cursor.completedAt && (attachment || attached?.state === 'trusted')) {
          const cursor = candidate.cursor
          try {
            await this.mutate(store, expectedRevision => store.finishReconciliation({ projectId, expectedRevision, envelopeId: envelope.id,
              attempt: cursor.attempts, at: this.now(), outcome: attachment ? 'quarantined' : 'resolved',
              reason: attachment?.reason ?? 'RECONCILIATION_COMPLETE', ...(attachment ? { healthEscalationId: attachment.healthEscalationId! } : {}),
            }))
          } catch { /* Leave the unfinished durable attempt visible for retry. */ }
          continue
        }
        if (this.host.requestBudget) {
          if (!this.host.requestBudget.availability(this.now()).available) return
        } else {
          const recent = [...this.host.stores.values()].flatMap(value => value.snapshot().reconciliations)
            .filter(cursor => cursor.lastAttemptAt && Date.parse(cursor.lastAttemptAt) > Date.parse(this.now()) - 60_000)
          // Compatibility for standalone hosts that have not adopted the shared owner.
          if (recent.length >= 5) return
        }
        try { await this.process(store, route, envelope, candidate.cursor?.attempts ?? 0) } catch {
          // The durable attempt lease retains uncertain work. Never turn an
          // unrecordable failure into a trusted item or a successful completion.
        }
      }
    }
  }
  private async process(store: DarkFactoryIngestionStore, route: GithubRoute,
    envelope: ReturnType<DarkFactoryIngestionStore['snapshot']>['custody'][number]['envelope'], attempts: number): Promise<void> {
    const projectId = route.projectId
    const quarantine = async (reason: Parameters<DarkFactoryIngestionStore['finishReconciliation']>[0]['reason'], attempt: number) => {
      const healthEscalationId = await this.host.quarantine({ projectId, envelopeId: envelope.id, reason })
      await this.mutate(store, expectedRevision => store.finishReconciliation({ projectId, expectedRevision, envelopeId: envelope.id,
        attempt, outcome: 'quarantined', at: this.now(), reason, healthEscalationId }))
    }
    if (attempts >= 3) { await quarantine('RECONCILIATION_EXHAUSTED', attempts); return }
    const cursor = await this.mutate(store, expectedRevision => store.beginReconciliation({ projectId, expectedRevision, envelopeId: envelope.id, at: this.now() }))
    if (envelope.policyRevision !== this.policy.policyRevision) { await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return }
    try { await this.host.authorize(projectId, `reconcile-${envelope.id}`) }
    catch { await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return }
    const state = store.snapshot()
    const itemId = state.custody.find(value => value.envelope.id === envelope.id)?.itemId
    const prior = state.items.find(value => value.id === itemId)
    if (prior?.state === 'trusted') {
      await this.mutate(store, expectedRevision => store.finishReconciliation({ projectId, expectedRevision, envelopeId: envelope.id,
        attempt: cursor.attempts, outcome: 'resolved', at: this.now(), reason: 'RECONCILIATION_COMPLETE' }))
      return
    }
    if (prior?.state === 'received' && prior.envelopeId !== envelope.id) {
      // A previously attached alias waits for its original observation. Re-fetching
      // here would change the alias input's checkedAt and conflict with its receipt.
      if (cursor.attempts >= 3) { await quarantine('RECONCILIATION_EXHAUSTED', cursor.attempts); return }
      await this.mutate(store, expectedRevision => store.finishReconciliation({ projectId, expectedRevision, envelopeId: envelope.id,
        attempt: cursor.attempts, outcome: 'retry', at: this.now(), reason: 'PROVIDER_UNAVAILABLE' }))
      return
    }
    let lookup: z.output<typeof githubReconciliationLookupSchema>
    try {
      const artifact = await this.host.artifacts.read(envelope.artifact)
      lookup = z.object({ lookup: githubReconciliationLookupSchema }).parse(artifact).lookup
      if (envelope.authentication === 'provider-api') {
        const read = envelope.providerRead
        const initiator = 'initiator' in lookup ? lookup.initiator : undefined
        const charge = this.host.requestBudget?.snapshot().charges.find(value => value.id === read.requestReceiptId)
        const evidence = z.object({ responseDigest: z.literal(read.responseDigest), requestReceiptId: z.literal(read.requestReceiptId) }).safeParse(artifact)
        if (!initiator || initiator.scannerId !== read.scannerId || initiator.ruleId !== read.ruleId || !evidence.success ||
          !charge || charge.projectId !== projectId || charge.routeId !== route.id || Date.parse(charge.at) > Date.parse(read.observedAt)) throw new Error('Provider read custody mismatch')
      } else if ('initiator' in lookup && lookup.initiator) throw new Error('Scanner initiator requires provider read custody')
    } catch { await quarantine('ARTIFACT_UNAVAILABLE', cursor.attempts); return }
    const project = this.host.projects.find(value => value.id === projectId)!
    try { await assertGithubRepository(project.repository, route.reconciliation!.repositoryName) }
    catch { await quarantine('SOURCE_DENIED', cursor.attempts); return }
    const secret = await (this.host.resolveSecret ?? resolveSecret)(route.reconciliation!.credentialRef)
    const previousSecret = this.secrets.get(route.id)
    if (previousSecret && previousSecret !== secret) this.previousSecrets.add(previousSecret)
    while (this.previousSecrets.size > 256) this.previousSecrets.delete(this.previousSecrets.values().next().value!)
    this.secrets.set(route.id, secret)
    const providerOptions = { registration: route.reconciliation!, route,
      projectId, policyRevision: this.policy.policyRevision, secret,
      now: () => new Date(this.now()), ...(this.host.transport ? { transport: this.host.transport } : {}), signal: this.abort.signal,
      redactText: (text: string) => redactProviderText(text, [...this.secrets.values(), ...this.previousSecrets]), maxPages: 10, maxBodyBytes: 1_048_576, requestTimeoutMs: 5000,
      ...(this.host.requestBudget ? {
        beforeRequest: async () => {
          try {
            await this.budgetMutation(expectedRevision => this.host.requestBudget!.reserve({ projectId, routeId: route.id, at: this.now(), expectedRevision }))
          } catch (error) {
            throw new GithubProviderFailure(error instanceof ProviderRequestDeniedError && error.reason !== 'CAPACITY' ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
              error instanceof ProviderRequestDeniedError && error.reason !== 'CAPACITY' ? 'RATE_LIMITED' : 'REQUEST_FAILED')
          }
        },
        onRateLimit: async (until: string) => {
          const at = this.now()
          const backoff = new Date(Date.parse(at) + 300_000 * 2 ** (cursor.attempts - 1)).toISOString()
          await this.budgetMutation(expectedRevision => this.host.requestBudget!.block({ at,
            until: Date.parse(until) > Date.parse(backoff) ? until : backoff, reason: 'PROVIDER_RATE_LIMITED', expectedRevision }))
        },
      } : {}),
    }
    const result = lookup.kind === 'issue' ? await reconcileGithubIssue({ ...providerOptions, observed: lookup }) : (lookup.kind === 'pull_request' || lookup.kind === 'scanned_pull_request') ? await reconcileGithubPullRequest({ ...providerOptions, observed: lookup }) : await reconcileGithubDependabotAlert({ ...providerOptions, observed: lookup })
    if (this.abort.signal.aborted) return
    if (result.decision === 'denied') {
      // These native diagnostics follow a successful repository proof and entity GET.
      // Initial PR observation rejection runs before any GET and cannot revoke prior work.
      if (sourceRevocations.has(result.diagnosticCode) && result.requestsUsed >= 2) {
        try { await this.invalidateSource(store, route, lookup, result.checkedAt, result.diagnosticCode, envelope.id) }
        catch (error) {
          if (!(error instanceof SourceInvalidationAuthorityDenied)) throw error
          await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return
        }
      }
      await quarantine('SOURCE_DENIED', cursor.attempts); return
    }
    if (result.decision === 'unresolved') {
      if (cursor.attempts >= 3) { await quarantine('RECONCILIATION_EXHAUSTED', cursor.attempts); return }
      const reason = result.reasons[0] === 'PROVIDER_RATE_LIMITED' ? 'PROVIDER_RATE_LIMITED' : result.reasons[0] === 'PROVIDER_RESPONSE_INVALID' ? 'PROVIDER_RESPONSE_INVALID' : 'PROVIDER_UNAVAILABLE'
      await this.mutate(store, expectedRevision => store.finishReconciliation({ projectId, expectedRevision, envelopeId: envelope.id,
        attempt: cursor.attempts, outcome: 'retry', at: this.now(), reason }))
      return
    }
    if (result.decision !== 'trusted') return
    try { await this.host.authorize(projectId, `reconcile-result-${envelope.id}`) }
    catch { await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return }
    const provenance = await this.host.artifacts.persist(projectId, result.provenance)
    const item = prior?.state === 'received' && prior.envelopeId === envelope.id && prior.sourceRevision === result.sourceRevision ? prior : inboundWorkItemSchema.parse({
      schemaVersion: 1, id: `work:${digestJson([projectId, 'github', result.provenance.sourceEntityId, result.sourceRevision]).slice(7)}`,
      projectId, policyRevision: envelope.policyRevision, envelopeId: envelope.id, source: 'github', sourceEntityId: result.provenance.sourceEntityId,
      sourceRevision: result.sourceRevision, repository: { provider: 'github', repositoryId: lookup.repositoryId, canonicalName: result.issue.repositoryName },
      author: result.issue.authorId, actor: result.issue.actorId, ...('initiator' in lookup && lookup.initiator ? { initiator: lookup.initiator } : {}), title: result.issue.title, context: result.issue.context || '[empty provider context]',
      labels: result.issue.labels.filter(label => idSchema.safeParse(label).success), sourceUrl: result.issue.sourceUrl,
      provenance: [envelope.artifact, provenance], trust: { decision: 'unresolved', reasons: ['PROVIDER_RECONCILIATION_REQUIRED'], checkedAt: result.checkedAt, entityRevision: result.sourceRevision, authorityRevision: this.policy.policyRevision },
      state: 'received', revision: 1,
    })
    let attached
    try {
      attached = await this.mutate(store, expectedRevision => store.attachItem({ projectId, expectedRevision, envelopeId: envelope.id, item }))
    } catch (error) {
      if (!(error instanceof IngressEscalationRequiredError)) throw error
      const healthEscalationId = await this.host.quarantine({ projectId, envelopeId: envelope.id, reason: 'SOURCE_CHANGED' })
      attached = await this.mutate(store, expectedRevision => store.attachItem({ projectId, expectedRevision, envelopeId: envelope.id, item, healthEscalationId }))
    }
    if (attached.receipt.decision === 'quarantined' || !attached.item) { await quarantine('SOURCE_CHANGED', cursor.attempts); return }
    if (attached.item.state === 'received' && attached.item.envelopeId !== envelope.id) {
      // An alias cannot promote the original observation using different initiation authority.
      if (cursor.attempts >= 3) { await quarantine('RECONCILIATION_EXHAUSTED', cursor.attempts); return }
      await this.mutate(store, expectedRevision => store.finishReconciliation({ projectId, expectedRevision, envelopeId: envelope.id,
        attempt: cursor.attempts, outcome: 'retry', at: this.now(), reason: 'PROVIDER_UNAVAILABLE' }))
      return
    }
    if (attached.item.state === 'received') {
      try { await this.host.authorize(projectId, `reconcile-trust-${envelope.id}`) }
      catch { await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return }
      await store.transition({ projectId, expectedRevision: attached.item.revision, item: { ...attached.item,
        state: 'trusted', revision: attached.item.revision + 1, trust: { ...attached.item.trust, decision: 'trusted', reasons: lookup.kind === 'dependabot_alert' ? ['CURRENT_PROVIDER_ALERT_VERIFIED', 'HOST_REGISTERED_SENSOR_RULE'] : envelope.authentication === 'provider-api' ? ['CURRENT_PROVIDER_AUTHORITY_VERIFIED', 'HOST_REGISTERED_SCANNER_RULE'] : ['CURRENT_PROVIDER_AUTHORITY_VERIFIED'], checkedAt: result.checkedAt },
      } })
    }
    await this.mutate(store, expectedRevision => store.finishReconciliation({ projectId, expectedRevision, envelopeId: envelope.id,
      attempt: cursor.attempts, outcome: 'resolved', at: this.now(), reason: 'RECONCILIATION_COMPLETE' }))
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.abort.abort()
    await this.pending
  }
}
