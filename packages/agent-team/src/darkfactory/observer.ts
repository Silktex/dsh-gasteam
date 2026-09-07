/** Coordinator-owned observe mode: custody and exceptions, never compiler/model/dispatch calls. */
import { randomUUID } from 'node:crypto'
import type { EnabledDarkFactoryConfig } from './config.ts'
import { digestJson } from './json.ts'
import { DarkFactoryPolicyStore } from './policy-store.ts'
import { DarkFactoryIngestionStore } from './ingestion-store.ts'
import { DarkFactoryIngressServer } from './ingress-server.ts'
import { DarkFactoryArtifactStore } from './artifacts.ts'
import { DarkFactoryMonitoringReconciler } from './monitoring-reconciler.ts'
import { DarkFactoryReconciler } from './reconciliation.ts'
import { DarkFactoryGithubScanStore } from './github-scan-store.ts'
import { DarkFactoryGithubScanner } from './github-scanner.ts'
import { DarkFactoryProviderRequestStore } from './provider-request-store.ts'
import type { FactoryEscalationInput, FactoryEscalation } from '../health.ts'

export class DarkFactoryObserver {
  private server: DarkFactoryIngressServer | undefined
  private closing: Promise<void> | undefined
  private monitoring: DarkFactoryMonitoringReconciler | undefined
  private reconciler: DarkFactoryReconciler | undefined
  private scanStore: DarkFactoryGithubScanStore | undefined
  private scanner: DarkFactoryGithubScanner | undefined
  private requestBudget: DarkFactoryProviderRequestStore | undefined
  private constructor(
    private readonly authority: DarkFactoryPolicyStore,
    private readonly stores: Map<string, DarkFactoryIngestionStore>,
  ) {}

  static async open(directory: string, policy: EnabledDarkFactoryConfig,
    escalate: (input: FactoryEscalationInput, at: number, cooldownMs: number) => Promise<FactoryEscalation>,
    projects: readonly { id: string; repository: string }[] = [],
  ): Promise<DarkFactoryObserver> {
    if (policy.mode !== 'observe') throw new Error('Only observe runtime is implemented')
    const digest = digestJson(policy)
    const authorizationRef = `configuration-${digest.slice(7)}`
    const authority = await DarkFactoryPolicyStore.open(directory, {
      grants: policy.projectIds.map(projectId => ({ projectId, operatorIds: [policy.ownerId], authorizationRefs: [authorizationRef] })),
      effectGrants: policy.projectIds.map(projectId => ({ projectId, effect: 'ingress', authorizationRef })),
      implementedEffects: ['ingress'],
    })
    const stores = new Map<string, DarkFactoryIngestionStore>()
    const observer = new DarkFactoryObserver(authority, stores)
    try {
      for (const projectId of policy.projectIds) {
        let state = authority.snapshot().find(value => value.projectId === projectId)
        const previous = state?.policies.at(-1)
        if (previous?.digest !== digest) {
          await authority.installPolicy({ projectId, expectedRevision: state?.revision ?? 0, operatorId: policy.ownerId, authorizationRef, policy })
          state = authority.snapshot().find(value => value.projectId === projectId)!
        }
        if (!state!.gates.some(gate => gate.policyRevision === policy.policyRevision && gate.gate === 'observe')) {
          // An enabled observe policy is the host operator's authorization for
          // transport custody only. It is never a production qualification receipt.
          await authority.recordGate({ projectId, expectedRevision: state!.revision, operatorId: policy.ownerId, authorizationRef, policyRevision: policy.policyRevision, gate: 'observe', evidenceRefs: [authorizationRef] })
        }
        const store = await DarkFactoryIngestionStore.open(directory, {
          projectId, maxBodyBytes: policy.ingestion.maxBodyBytes, maxQueueItems: policy.ingestion.maxQueueItems,
          maxRecordBytes: policy.limits.maxJournalRecordBytes, maxJournalBytes: policy.limits.maxJournalBytes,
        })
        stores.set(projectId, store)
      }
      let authorityOperations: Promise<unknown> = Promise.resolve()
      const authorize = (projectId: string, effectId: string): Promise<void> => {
        const operation = authorityOperations.then(async () => {
          const state = authority.snapshot().find(value => value.projectId === projectId)!
          const receipt = await authority.decideEffect({ projectId, expectedRevision: state.revision, policyRevision: policy.policyRevision, effect: 'ingress', effectId })
          if (receipt.decision !== 'allow') {
            await escalate({ schemaVersion: 1, projectId, policyRevision: policy.policyRevision, stage: 'ingress',
              reason: 'AUTHORITY_DENIED', effectId, evidenceRefs: [receipt.id], severity: 'critical',
              diagnostics: `Ingress admission denied: ${receipt.reasons.join(', ')}`,
            }, Date.now(), policy.notifications.cooldownMs)
            throw new Error('Ingress authority is paused or revoked')
          }
        })
        authorityOperations = operation.catch(() => {})
        return operation
      }
      for (const projectId of policy.projectIds) await authorize(projectId, `startup-${randomUUID()}`)
      const artifacts = await DarkFactoryArtifactStore.open(directory, policy.projectIds, policy.limits.maxArtifactBytes, policy.limits.maxArtifactTotalBytes)
      const quarantine = async ({ projectId, envelopeId, reason }: { projectId: string; envelopeId: string; reason: string }) => (await escalate({
        schemaVersion: 1, projectId, policyRevision: policy.policyRevision, stage: 'ingress',
        reason, effectId: envelopeId, evidenceRefs: [envelopeId], severity: 'warning',
        diagnostics: `Authenticated ingress requires review: ${reason}`,
      }, Date.now(), policy.notifications.cooldownMs)).id
      const providerRoutes = policy.ingestion.routes.filter(route => 'reconciliation' in route && route.reconciliation)
      if (providerRoutes.length) {
        observer.requestBudget = await DarkFactoryProviderRequestStore.open(directory, {
          routes: providerRoutes.map(route => ({ projectId: route.projectId, routeId: route.id })),
          maxRecordBytes: policy.limits.maxJournalRecordBytes, maxJournalBytes: policy.limits.maxJournalBytes,
        })
        // Legacy standalone readers may have used cursor-based reservations. On
        // startup withhold the remaining minute rather than guessing which GETs ran.
        const now = Date.now()
        let latestAttempt = 0
        for (const store of stores.values()) for (const cursor of store.snapshot().reconciliations) {
          latestAttempt = Math.max(latestAttempt, Date.parse(cursor.lastAttemptAt))
        }
        if (latestAttempt > now - 60_000) {
          const until = new Date(latestAttempt + 60_000).toISOString()
          const state = observer.requestBudget.snapshot()
          if (!state.blockedUntil || Date.parse(state.blockedUntil) < Date.parse(until)) await observer.requestBudget.block({
            at: new Date(now).toISOString(), until, reason: 'LEGACY_WITHHOLDING', expectedRevision: state.revision,
          })
        }
      }
      const scanRoutes = providerRoutes.flatMap(route => route.source === 'github' && route.reconciliation?.scan ? [{ projectId: route.projectId, routeId: route.id, initialSince: route.reconciliation.scan.initialSince }] : [])
      if (scanRoutes.length) {
        observer.scanStore = await DarkFactoryGithubScanStore.open(directory, { routes: scanRoutes,
          intervalMs: policy.ingestion.reconciliationIntervalMs, lookbackMs: 600000,
          maxRecordBytes: policy.limits.maxJournalRecordBytes, maxJournalBytes: policy.limits.maxJournalBytes })
        observer.scanner = await DarkFactoryGithubScanner.open(policy, { projects, stores, artifacts, authorize, quarantine,
          requestBudget: observer.requestBudget!, scanStore: observer.scanStore })
      }
      observer.monitoring = await DarkFactoryMonitoringReconciler.open(policy, { projects, stores, artifacts, authorize, quarantine,
        ...(observer.requestBudget ? { requestBudget: observer.requestBudget } : {}) })
      observer.reconciler = await DarkFactoryReconciler.open(policy, { projects, stores, artifacts, authorize, quarantine,
        ...(observer.requestBudget ? { requestBudget: observer.requestBudget } : {}),
        ...(providerRoutes.some(route => route.source !== 'github') || observer.scanner ? { beforeDrain: async () => {
          await observer.monitoring!.runOnce(); await observer.scanner?.runOnce()
        } } : {}),
      })
      observer.server = await DarkFactoryIngressServer.open(policy, {
        directory, stores, authorize, artifacts,
        sanitize: facts => ({
          sourceEntityId: facts.sourceEntityId, providerEntityId: facts.providerEntityId,
          observationDigest: facts.observationDigest, repositoryId: facts.repositoryId,
          organizationId: facts.organizationId, providerProjectIds: facts.providerProjectIds,
          providerRevision: facts.providerRevision, invalidatesPending: facts.invalidatesPending,
          trust: 'unresolved',
          // Narrative and stack data require a provider enrichment/redaction
          // adapter before compilation. Observe custody preserves lookup facts.
          kind: facts.details.kind,
          ...(facts.details.kind === 'issue' && facts.repositoryId && facts.installationId && facts.actorId ? {
            lookup: { kind: 'issue', sourceEntityId: facts.sourceEntityId, providerEntityId: facts.providerEntityId,
              repositoryId: facts.repositoryId, actorId: facts.actorId, installationId: facts.installationId, number: facts.details.number },
          } : {}),
          ...(facts.details.kind === 'pull_request' && facts.repositoryId && facts.installationId && facts.actorId ? {
            lookup: { kind: 'pull_request', sourceEntityId: facts.sourceEntityId, providerEntityId: facts.providerEntityId,
              repositoryId: facts.repositoryId, actorId: facts.actorId, installationId: facts.installationId, number: facts.details.number,
              baseRepositoryId: facts.details.baseRepositoryId, headRepositoryId: facts.details.headRepositoryId,
              baseCommit: facts.details.baseCommit, headCommit: facts.details.headCommit, fork: facts.details.fork },
          } : {}),
          ...(facts.details.kind === 'dependabot_alert' && facts.repositoryId && facts.installationId && facts.actorId ? {
            lookup: { kind: 'dependabot_alert', sourceEntityId: facts.sourceEntityId, providerEntityId: facts.providerEntityId,
              repositoryId: facts.repositoryId, actorId: facts.actorId, installationId: facts.installationId, number: facts.details.number },
          } : {}),
          ...((facts.details.kind === 'sentry_issue' || facts.details.kind === 'sentry_metric') && facts.installationId && facts.actorId ? {
            lookup: { kind: facts.details.kind, sourceEntityId: facts.sourceEntityId, providerEntityId: facts.providerEntityId,
              installationId: facts.installationId, actorId: facts.actorId, providerProjectIds: facts.providerProjectIds, organizationId: facts.organizationId,
              resource: facts.details.kind === 'sentry_metric' ? 'metric_alert' : facts.details.eventId === null ? 'issue' : 'event_alert',
              providerRule: facts.ruleIds[0] ?? null, eventId: facts.details.kind === 'sentry_issue' ? facts.details.eventId : null },
          } : {}),
          ...(facts.details.kind === 'apm' && facts.actorId && facts.providerProjectIds.length === 1 && facts.ruleIds.length === 1 ? {
            lookup: { kind: 'apm', sourceEntityId: facts.sourceEntityId, providerEntityId: facts.providerEntityId,
              fingerprint: facts.details.fingerprint, actorId: facts.actorId, providerProjectId: facts.providerProjectIds[0], providerRule: facts.ruleIds[0] },
          } : {}),
          ...('number' in facts.details ? { number: facts.details.number } : {}),
        }),
        quarantine,
      })
      observer.reconciler.start()
      return observer
    } catch (error) { await observer.close(); throw error }
  }
  status(): { mode: 'observe'; address: string; port: number } {
    if (!this.server) throw new Error('Observer is not ready')
    return { mode: 'observe', ...this.server.address() }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.server?.close()
      await this.monitoring?.close()
      await this.scanner?.close()
      await this.reconciler?.close()
      await this.scanStore?.close()
      await this.requestBudget?.close()
      for (const store of this.stores.values()) await store.close()
      await this.authority.close()
    })()
  }
}
