/** Host-owned monitoring reconciliation: durable custody and trust only, never execution. */
import type { EnabledDarkFactoryConfig, IngressPolicyRoute } from './config.ts'
import { inboundWorkItemSchema } from './contracts/index.ts'
import type { InboundEnvelopeV1 } from './contracts/index.ts'
import { DarkFactoryIngestionStore, IngressEscalationRequiredError } from './ingestion-store.ts'
import type { ReconciliationHost } from './reconciliation.ts'
import { sentryReconciliationLookupSchema, reconcileSentrySource } from './sentry-reconciliation.ts'
import { apmReconciliationLookupSchema, reconcileApmSource } from './apm-reconciliation.ts'
import { MonitoringProviderFailure } from './monitoring-reconciliation.ts'
import { ProviderRequestDeniedError } from './provider-request-store.ts'
import { digestJson } from './json.ts'
import { resolveSecret } from './secrets.ts'
import { assertGithubRepository, redactProviderText } from './reconciliation-safety.ts'

type MonitoringRoute = Extract<IngressPolicyRoute, { source: 'sentry' | 'apm' }>
type Reason = Parameters<DarkFactoryIngestionStore['finishReconciliation']>[0]['reason']
const active = new Set(['trusted', 'compiled', 'admitted', 'acknowledged'])
const revocations = new Set(['APM_RESOLVED', 'APM_RULE_NOT_ALLOWED', 'APM_ENVIRONMENT_NOT_ALLOWED', 'SENTRY_RESOLVED', 'SENTRY_ENVIRONMENT_NOT_ALLOWED'])
class AuthorityDenied extends Error {}

export class DarkFactoryMonitoringReconciler {
  private readonly abort = new AbortController()
  private pending: Promise<void> | undefined
  private readonly previousSecrets = new Set<string>()
  private constructor(private readonly policy: EnabledDarkFactoryConfig, private readonly host: ReconciliationHost,
    private readonly routes: MonitoringRoute[], private readonly secrets: Map<string, string>) {}

  static async open(policy: EnabledDarkFactoryConfig, host: ReconciliationHost): Promise<DarkFactoryMonitoringReconciler> {
    if (policy.mode !== 'observe') throw new Error('Only observe monitoring reconciliation is implemented')
    const routes = policy.ingestion.routes.filter((route): route is MonitoringRoute => (route.source === 'sentry' || route.source === 'apm') && !!route.reconciliation)
    if (routes.length && !host.requestBudget) throw new Error('Monitoring reconciliation requires a shared provider budget')
    const secrets = new Map<string, string>()
    for (const route of routes) {
      const project = host.projects.find(value => value.id === route.projectId)
      if (!project || !host.stores.has(project.id)) throw new Error('Monitoring reconciliation project is not registered')
      await assertGithubRepository(project.repository, route.reconciliation!.repositoryName)
      try { secrets.set(route.id, await (host.resolveSecret ?? resolveSecret)(route.reconciliation!.credentialRef)) }
      catch { throw new Error('Monitoring reconciliation credentials unavailable') }
    }
    return new DarkFactoryMonitoringReconciler(policy, host, routes, secrets)
  }
  runOnce(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve()
    return this.pending ??= this.drain().finally(() => { this.pending = undefined })
  }
  private now(): string { return new Date((this.host.clock ?? Date.now)()).toISOString() }
  private async mutate<T>(owner: { snapshot(): { revision: number } }, operation: (revision: number) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const revision = owner.snapshot().revision
      try { return await operation(revision) } catch (error) {
        if (attempt >= 3 || owner.snapshot().revision === revision) throw error
      }
    }
  }
  private async authorize(projectId: string, effectId: string): Promise<void> {
    try { await this.host.authorize(projectId, effectId) } catch { throw new AuthorityDenied() }
    if (this.abort.signal.aborted) throw new Error('Monitoring reconciliation interrupted')
  }
  private async drain(): Promise<void> {
    let processed = 0
    const wake = { requests: 0 }
    const projects = [...this.host.stores]
    const lastProject = this.host.requestBudget?.snapshot().charges.at(-1)?.projectId
    const previous = projects.findIndex(([id]) => id === lastProject)
    const ordered = previous < 0 ? projects : [...projects.slice(previous + 1), ...projects.slice(0, previous + 1)]
    for (const [projectId, store] of ordered) {
      const routeIds = this.routes.filter(route => route.projectId === projectId).map(route => route.id)
      if (!routeIds.length) continue
      for (const candidate of store.pendingReconciliations({ projectId, routeIds, at: this.now(), limit: 10 })) {
        if (this.abort.signal.aborted || processed++ >= 10) return
        const envelope = candidate.custody.envelope
        const route = this.routes.find(value => value.id === envelope.routeId && value.projectId === projectId)!
        // Exhaustion and already durable results can settle without additional GET capacity.
        const state = store.snapshot()
        const item = state.items.find(value => value.id === candidate.custody.itemId)
        const durableResult = candidate.cursor && !candidate.cursor.completedAt && ((item && active.has(item.state)) || state.attachments.some(value => value.envelopeId === envelope.id && value.decision === 'quarantined'))
        if (!durableResult && (candidate.cursor?.attempts ?? 0) < 3 && (wake.requests >= 10 || !this.host.requestBudget!.availability(this.now()).available)) return
        try { await this.process(store, route, envelope, candidate.cursor?.attempts ?? 0, wake) } catch {
          // An uncertain append or callback retains the journaled lease for restart.
        }
      }
    }
  }
  private async invalidate(store: DarkFactoryIngestionStore, route: MonitoringRoute, sourceEntityId: string, checkedAt: string, diagnostic: string, envelopeId: string): Promise<void> {
    const registration = route.reconciliation!
    const matches = (item: ReturnType<DarkFactoryIngestionStore['snapshot']>['items'][number]) => item.projectId === route.projectId && item.source === route.source && item.sourceEntityId === sourceEntityId &&
      item.repository.provider === 'github' && item.repository.repositoryId === registration.repositoryId && item.repository.canonicalName.toLowerCase() === registration.repositoryName.toLowerCase() && !['acknowledged', 'quarantined'].includes(item.state)
    await this.authorize(route.projectId, `monitor-revoke-${envelopeId}`)
    for (const original of store.snapshot().items.filter(matches)) {
      for (let retry = 0; ; retry++) {
        const current = store.snapshot().items.find(item => item.id === original.id)
        if (!current || !matches(current)) break
        const effect = `monitor-revoke-${digestJson([envelopeId, current.id]).slice(7)}`
        await this.authorize(route.projectId, effect)
        const healthEscalationId = await this.host.quarantine({ projectId: route.projectId, envelopeId: current.envelopeId, reason: 'SOURCE_DENIED' })
        await this.authorize(route.projectId, effect)
        try {
          await store.transition({ projectId: route.projectId, expectedRevision: current.revision, item: { ...current, state: 'quarantined', revision: current.revision + 1, healthEscalationId, quarantineReason: 'SOURCE_DENIED',
            trust: { ...current.trust, decision: 'revoked', reasons: ['SOURCE_DENIED', diagnostic], checkedAt, authorityRevision: this.policy.policyRevision } } })
          break
        } catch (error) { if (retry >= 3 || store.snapshot().items.find(item => item.id === current.id)?.revision === current.revision) throw error }
      }
    }
  }
  private async process(store: DarkFactoryIngestionStore, route: MonitoringRoute, envelope: InboundEnvelopeV1, attempts: number, wake: { requests: number }): Promise<void> {
    const projectId = route.projectId
    const finish = (attempt: number, outcome: 'resolved' | 'retry' | 'quarantined', reason: Reason, healthEscalationId?: string) =>
      this.mutate(store, expectedRevision => store.finishReconciliation({ projectId, expectedRevision, envelopeId: envelope.id, attempt, outcome, reason, at: this.now(), ...(healthEscalationId ? { healthEscalationId } : {}) }))
    const quarantine = async (reason: Reason, attempt: number) => {
      const ref = await this.host.quarantine({ projectId, envelopeId: envelope.id, reason })
      await finish(attempt, 'quarantined', reason, ref)
    }
    const snapshot = store.snapshot()
    const prior = snapshot.items.find(item => item.id === snapshot.custody.find(value => value.envelope.id === envelope.id)?.itemId)
    const attachment = snapshot.attachments.find(value => value.envelopeId === envelope.id && value.decision === 'quarantined')
    const unfinished = snapshot.reconciliations.find(value => value.envelopeId === envelope.id && !value.completedAt)
    if (unfinished && (attachment || (prior && active.has(prior.state)))) {
      await finish(unfinished.attempts, attachment ? 'quarantined' : 'resolved', attachment?.reason ?? 'RECONCILIATION_COMPLETE', attachment?.healthEscalationId)
      return
    }
    if (attempts >= 3) { await quarantine('RECONCILIATION_EXHAUSTED', attempts); return }
    const cursor = await this.mutate(store, expectedRevision => store.beginReconciliation({ projectId, expectedRevision, envelopeId: envelope.id, at: this.now() }))
    if (envelope.policyRevision !== this.policy.policyRevision || envelope.source !== route.source || envelope.authentication !== 'verified' || envelope.signingKeyId !== route.signingKeyId || envelope.adapterVersion !== route.providerVersion) {
      await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return
    }
    try { await this.authorize(projectId, `monitor-${envelope.id}`) } catch (error) { if (!(error instanceof AuthorityDenied)) throw error; await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return }
    if (prior && active.has(prior.state)) { await finish(cursor.attempts, 'resolved', 'RECONCILIATION_COMPLETE'); return }
    if (prior?.state === 'quarantined') { await quarantine('SOURCE_DENIED', cursor.attempts); return }
    const retry = async (reason: Reason) => cursor.attempts >= 3 ? quarantine('RECONCILIATION_EXHAUSTED', cursor.attempts) : finish(cursor.attempts, 'retry', reason).then(() => {})
    if (prior?.state === 'received' && prior.envelopeId !== envelope.id) { await retry('PROVIDER_UNAVAILABLE'); return }
    let lookup
    try {
      const artifact = await this.host.artifacts.read(envelope.artifact)
      const raw = (artifact as { lookup?: unknown }).lookup
      lookup = route.source === 'sentry' ? sentryReconciliationLookupSchema.parse(raw) : apmReconciliationLookupSchema.parse(raw)
    } catch { await quarantine('ARTIFACT_UNAVAILABLE', cursor.attempts); return }
    try { await assertGithubRepository(this.host.projects.find(value => value.id === projectId)!.repository, route.reconciliation!.repositoryName) }
    catch { await quarantine('SOURCE_DENIED', cursor.attempts); return }
    let secret: string
    try { secret = await (this.host.resolveSecret ?? resolveSecret)(route.reconciliation!.credentialRef) }
    catch { await retry('PROVIDER_UNAVAILABLE'); return }
    const old = this.secrets.get(route.id)
    if (old && old !== secret) this.previousSecrets.add(old)
    while (this.previousSecrets.size > 256) this.previousSecrets.delete(this.previousSecrets.values().next().value!)
    this.secrets.set(route.id, secret)
    const budget = this.host.requestBudget!
    const options = { projectId, policyRevision: this.policy.policyRevision, secret, signal: this.abort.signal,
      now: () => new Date(this.now()), ...(this.host.transport ? { transport: this.host.transport } : {}),
      redactText: (text: string) => redactProviderText(text, [...this.secrets.values(), ...this.previousSecrets]), maxBodyBytes: 1_048_576, requestTimeoutMs: 5000, totalTimeoutMs: 15_000,
      beforeRequest: async () => {
        if (wake.requests >= 11) throw new MonitoringProviderFailure('PROVIDER_RATE_LIMITED', 'REQUEST_LIMIT')
        try { await this.mutate(budget, expectedRevision => budget.reserve({ projectId, routeId: route.id, at: this.now(), expectedRevision })) }
        catch (error) { throw new MonitoringProviderFailure(error instanceof ProviderRequestDeniedError && error.reason !== 'CAPACITY' ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', 'REQUEST_FAILED') }
        wake.requests++
      },
      onRateLimit: async (until: string) => {
        const at = this.now(), backoff = new Date(Date.parse(at) + 300_000 * 2 ** (cursor.attempts - 1)).toISOString()
        await this.mutate(budget, expectedRevision => budget.block({ at, until: Date.parse(until) > Date.parse(backoff) ? until : backoff, reason: 'PROVIDER_RATE_LIMITED', expectedRevision }))
      },
    }
    const result = route.source === 'sentry'
      ? await reconcileSentrySource({ ...options, route, registration: route.reconciliation!, observed: sentryReconciliationLookupSchema.parse(lookup) })
      : await reconcileApmSource({ ...options, route, registration: route.reconciliation!, observed: apmReconciliationLookupSchema.parse(lookup) })
    if (this.abort.signal.aborted) return
    if (result.decision === 'denied') {
      if (result.requestsUsed > 0 && revocations.has(result.diagnosticCode)) {
        try { await this.invalidate(store, route, lookup.sourceEntityId, result.checkedAt, result.diagnosticCode, envelope.id) }
        catch (error) { if (!(error instanceof AuthorityDenied)) throw error; await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return }
      }
      await quarantine('SOURCE_DENIED', cursor.attempts); return
    }
    if (result.decision === 'unresolved') {
      await retry(result.reasons[0] === 'PROVIDER_RATE_LIMITED' ? 'PROVIDER_RATE_LIMITED' : result.reasons[0] === 'PROVIDER_RESPONSE_INVALID' ? 'PROVIDER_RESPONSE_INVALID' : 'PROVIDER_UNAVAILABLE'); return
    }
    if (result.decision !== 'trusted') return
    try { await this.authorize(projectId, `monitor-result-${envelope.id}`) } catch (error) { if (!(error instanceof AuthorityDenied)) throw error; await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return }
    const provenance = await this.host.artifacts.persist(projectId, result.provenance)
    const item = prior?.state === 'received' && prior.envelopeId === envelope.id && prior.sourceRevision === result.sourceRevision ? prior : inboundWorkItemSchema.parse({
      schemaVersion: 1, id: `work:${digestJson([projectId, route.source, lookup.sourceEntityId, result.sourceRevision]).slice(7)}`, projectId, policyRevision: envelope.policyRevision,
      envelopeId: envelope.id, source: route.source, sourceEntityId: lookup.sourceEntityId, sourceRevision: result.sourceRevision, ...result.item,
      provenance: [envelope.artifact, provenance], trust: { decision: 'unresolved', reasons: ['PROVIDER_RECONCILIATION_REQUIRED'], checkedAt: result.checkedAt, entityRevision: result.sourceRevision, authorityRevision: this.policy.policyRevision }, state: 'received', revision: 1,
    })
    let attached
    try { attached = await this.mutate(store, expectedRevision => store.attachItem({ projectId, expectedRevision, envelopeId: envelope.id, item })) }
    catch (error) {
      if (!(error instanceof IngressEscalationRequiredError)) throw error
      const healthEscalationId = await this.host.quarantine({ projectId, envelopeId: envelope.id, reason: 'SOURCE_CHANGED' })
      attached = await this.mutate(store, expectedRevision => store.attachItem({ projectId, expectedRevision, envelopeId: envelope.id, item, healthEscalationId }))
    }
    if (attached.receipt.decision === 'quarantined' || !attached.item) { await quarantine('SOURCE_CHANGED', cursor.attempts); return }
    if (attached.item.state === 'quarantined') { await quarantine('SOURCE_DENIED', cursor.attempts); return }
    if (attached.item.state === 'received' && attached.item.envelopeId !== envelope.id) { await retry('PROVIDER_UNAVAILABLE'); return }
    if (attached.item.state === 'received') {
      try { await this.authorize(projectId, `monitor-trust-${envelope.id}`) } catch (error) { if (!(error instanceof AuthorityDenied)) throw error; await quarantine('AUTHORITY_UNRESOLVED', cursor.attempts); return }
      await store.transition({ projectId, expectedRevision: attached.item.revision, item: { ...attached.item, state: 'trusted', revision: attached.item.revision + 1,
        trust: { ...attached.item.trust, decision: 'trusted', reasons: ['CURRENT_PROVIDER_EVIDENCE_VERIFIED', 'HOST_REGISTERED_SENSOR_RULE'], checkedAt: result.checkedAt } } })
    }
    await finish(cursor.attempts, 'resolved', 'RECONCILIATION_COMPLETE')
  }
  async close(): Promise<void> { this.abort.abort(); await this.pending }
}
