/** Missed-delivery discovery persists page evidence and per-entity custody before advancing a cursor. */
import z from 'zod'
import type { EnabledDarkFactoryConfig, IngressPolicyRoute } from './config.ts'
import { digestSchema, idSchema, revisionSchema, timestampSchema } from './contracts/common.ts'
import { inboundEnvelopeSchema, scannerIdSchema } from './contracts/ingestion.ts'
import { DarkFactoryGithubScanStore, type GithubScanCursor } from './github-scan-store.ts'
import { readGithubScanPage, githubScanEntrySchema } from './github-scan-provider.ts'
import { DarkFactoryProviderRequestStore, ProviderRequestDeniedError } from './provider-request-store.ts'
import { GithubProviderFailure } from './github-reconciliation.ts'
import { digestJson } from './json.ts'
import { assertGithubRepository, redactProviderText } from './reconciliation-safety.ts'
import { resolveSecret } from './secrets.ts'
import type { ReconciliationHost } from './reconciliation.ts'

type Route = Extract<IngressPolicyRoute, { source: 'github' }>
export interface GithubScannerHost extends Omit<ReconciliationHost, 'requestBudget'> {
  requestBudget: DarkFactoryProviderRequestStore
  scanStore: DarkFactoryGithubScanStore
}
const pageArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: idSchema, routeId: idSchema, policyRevision: revisionSchema,
  scannerId: scannerIdSchema, ruleId: idSchema, sweepId: idSchema, page: revisionSchema.max(10000),
  checkedAt: timestampSchema, requestReceiptId: idSchema, responseDigest: digestSchema,
  entries: z.array(githubScanEntrySchema).max(100), hasMore: z.boolean(),
})
type PageArtifact = z.output<typeof pageArtifactSchema>
function envelopeId(page: PageArtifact, index: number): string {
  return `envelope:${digestJson([page.projectId, page.routeId, page.sweepId, page.page, index, page.entries[index]]).slice(7)}`
}
export class DarkFactoryGithubScanner {
  private readonly abort = new AbortController()
  private pending: Promise<void> | undefined
  private constructor(private readonly policy: EnabledDarkFactoryConfig, private readonly host: GithubScannerHost, private readonly routes: Route[]) {}
  static async open(policy: EnabledDarkFactoryConfig, host: GithubScannerHost): Promise<DarkFactoryGithubScanner> {
    if (policy.mode !== 'observe') throw new Error('Only observe scanning is implemented')
    const routes = policy.ingestion.routes.filter((route): route is Route => route.source === 'github' && !!route.reconciliation?.scan)
    for (const route of routes) {
      const project = host.projects.find(project => project.id === route.projectId)
      const scan = route.reconciliation!.scan!
      if (!project || !host.stores.has(project.id) || !route.senderIds.includes(scan.scannerId) || !route.ruleIds.includes(scan.ruleId) ||
        route.bindings.automationRules.filter(rule => rule.ruleId === scan.ruleId).length !== 1) throw new Error('Invalid registered GitHub scanner')
      await assertGithubRepository(project.repository, route.reconciliation!.repositoryName)
    }
    return new DarkFactoryGithubScanner(policy, host, routes)
  }
  private now(): string { return new Date((this.host.clock ?? Date.now)()).toISOString() }
  runOnce(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve()
    return this.pending ??= this.drain().finally(() => { this.pending = undefined })
  }
  private async mutate<T>(owner: { snapshot(): { revision: number } }, write: (revision: number) => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      const revision = owner.snapshot().revision
      try { return await write(revision) } catch (error) {
        if (tries >= 3 || revision === owner.snapshot().revision) throw error
      }
    }
  }
  private async defer(cursor: GithubScanCursor): Promise<void> {
    const at = this.now(), availability = this.host.requestBudget.availability(at)
    const next = Math.max(Date.parse(at) + 300000, Date.parse(availability.nextAttemptAt ?? at))
    await this.mutate(this.host.scanStore, expectedRevision => this.host.scanStore.defer({ projectId: cursor.projectId, routeId: cursor.routeId,
      sweepId: cursor.sweep!.id, at, nextAttemptAt: new Date(next).toISOString(), expectedRevision }))
  }
  private async drain(): Promise<void> {
    const due = this.host.scanStore.due(this.now())
    // One route per wake and at most ten pages. Persisted due times give every route a turn.
    const candidate = due.find(cursor => this.routes.some(route => route.id === cursor.routeId && route.projectId === cursor.projectId))
    if (!candidate) return
    const route = this.routes.find(route => route.id === candidate.routeId && route.projectId === candidate.projectId)!
    let cursor = candidate
    let requestsThisWake = 0
    try {
      if (!cursor.sweep || cursor.sweep.status === 'complete') {
        if (!this.host.requestBudget.availability(this.now()).available) return
        cursor = (await this.mutate(this.host.scanStore, expectedRevision => this.host.scanStore.begin({ projectId: route.projectId, routeId: route.id, at: this.now(), expectedRevision }))).cursor
      }
      for (let count = 0; count < route.reconciliation!.scan!.maxPages && !this.abort.signal.aborted; count++) {
        const sweep = cursor.sweep!
        let saved = sweep.pages.find(page => page.page === sweep.page && !page.acknowledged)
        if (!saved) {
          // Leave capacity for custody reconciliation in the same coordinator wake.
          if (requestsThisWake >= 10) { await this.defer(cursor); return }
          if (!this.host.requestBudget.availability(this.now()).available) { await this.defer(cursor); return }
          await this.host.authorize(route.projectId, `scan-${sweep.id}-${sweep.page}`)
          const project = this.host.projects.find(project => project.id === route.projectId)!
          await assertGithubRepository(project.repository, route.reconciliation!.repositoryName)
          const secret = await (this.host.resolveSecret ?? resolveSecret)(route.reconciliation!.credentialRef)
          const charges: string[] = []
          const result = await readGithubScanPage({ route, registration: route.reconciliation!, projectId: route.projectId,
            policyRevision: this.policy.policyRevision, secret, since: sweep.since, cutoff: sweep.cutoff, page: sweep.page,
            now: () => new Date(this.now()), signal: this.abort.signal, ...(this.host.transport ? { transport: this.host.transport } : {}),
            redactText: text => redactProviderText(text, [secret]), requestTimeoutMs: 5000,
            beforeRequest: async () => {
              if (requestsThisWake >= 11) throw new GithubProviderFailure('PROVIDER_RATE_LIMITED', 'RATE_LIMITED')
              try {
                const charge = await this.mutate(this.host.requestBudget, expectedRevision => this.host.requestBudget.reserve({ projectId: route.projectId, routeId: route.id, at: this.now(), expectedRevision }))
                requestsThisWake++; charges.push(charge.id)
              } catch (error) {
                throw new GithubProviderFailure(error instanceof ProviderRequestDeniedError && error.reason !== 'CAPACITY' ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', 'REQUEST_FAILED')
              }
            },
            onRateLimit: async until => {
              const at = this.now()
              await this.mutate(this.host.requestBudget, expectedRevision => this.host.requestBudget.block({ at,
                until: new Date(Math.max(Date.parse(until), Date.parse(at) + 300000)).toISOString(), reason: 'PROVIDER_RATE_LIMITED', expectedRevision }))
            },
          })
          if (this.abort.signal.aborted) return
          if (result.decision !== 'trusted') {
            if (result.reasons[0] !== 'PROVIDER_RATE_LIMITED') await this.host.quarantine({ projectId: route.projectId, envelopeId: sweep.id, reason: result.reasons[0] ?? 'PROVIDER_UNAVAILABLE' })
            await this.defer(cursor); return
          }
          if (!charges.length || charges.length !== result.requestsUsed) throw new Error('Scanner request charge is missing')
          await this.host.authorize(route.projectId, `scan-result-${sweep.id}-${sweep.page}`)
          const scan = route.reconciliation!.scan!
          const page = pageArtifactSchema.parse({ schemaVersion: 1, projectId: route.projectId, routeId: route.id, policyRevision: this.policy.policyRevision,
            scannerId: scan.scannerId, ruleId: scan.ruleId, sweepId: sweep.id, page: sweep.page, checkedAt: this.now(),
            requestReceiptId: charges.at(-1), responseDigest: result.responseDigest, entries: result.entries, hasMore: result.hasMore })
          const artifact = await this.host.artifacts.persist(route.projectId, page)
          cursor = (await this.mutate(this.host.scanStore, expectedRevision => this.host.scanStore.savePage({ projectId: route.projectId, routeId: route.id,
            sweepId: sweep.id, page: sweep.page, artifact, entryIds: page.entries.map((_, index) => envelopeId(page, index)), hasMore: page.hasMore, at: this.now(), expectedRevision }))).cursor
          saved = cursor.sweep!.pages[0]!
        }
        const page = pageArtifactSchema.parse(await this.host.artifacts.read(saved.artifact))
        if (page.projectId !== route.projectId || page.routeId !== route.id || page.sweepId !== sweep.id || page.page !== saved.page ||
          page.hasMore !== saved.hasMore || digestJson(saved.entryIds) !== digestJson(page.entries.map((_, index) => envelopeId(page, index)))) throw new Error('Scanner page evidence mismatch')
        const charge = this.host.requestBudget.snapshot().charges.find(receipt => receipt.id === page.requestReceiptId)
        if (!charge || charge.projectId !== page.projectId || charge.routeId !== page.routeId || Date.parse(charge.at) > Date.parse(page.checkedAt)) throw new Error('Scanner request evidence mismatch')
        await this.host.authorize(route.projectId, `scan-custody-${page.sweepId}-${page.page}`)
        const store = this.host.stores.get(route.projectId)!
        const held = new Set(store.snapshot().custody.map(custody => custody.envelope.id))
        for (const [index, entry] of page.entries.entries()) {
          if (this.abort.signal.aborted) return
          const id = envelopeId(page, index)
          if (held.has(id)) continue
          const initiator = { kind: 'host-scanner', scannerId: page.scannerId, ruleId: page.ruleId } as const
          const lookup = { kind: entry.kind === 'pull_request' ? 'scanned_pull_request' : 'issue', sourceEntityId: entry.sourceEntityId,
            providerEntityId: entry.providerEntityId, repositoryId: entry.repositoryId, actorId: page.scannerId, installationId: entry.installationId, number: entry.number, initiator }
          const artifact = await this.host.artifacts.persist(route.projectId, { lookup, sweepId: page.sweepId, page: page.page, updatedAt: entry.updatedAt,
            responseDigest: page.responseDigest, requestReceiptId: page.requestReceiptId, policyRevision: page.policyRevision })
          const envelope = inboundEnvelopeSchema.parse({ schemaVersion: 1, id, projectId: page.projectId, policyRevision: page.policyRevision,
            source: 'github', adapterVersion: 'github-provider-scan-v1', routeId: page.routeId, deliveryId: `scan:${id.slice(9)}`,
            eventKind: entry.kind === 'issue' ? 'issues' : 'pull_request', action: 'scan', bodyDigest: artifact.digest, receivedAt: page.checkedAt,
            authentication: 'provider-api', providerRead: { scannerId: page.scannerId, ruleId: page.ruleId, requestReceiptId: page.requestReceiptId,
              responseDigest: page.responseDigest, observedAt: page.checkedAt }, artifact })
          await this.host.authorize(route.projectId, `scan-entry-${id}`)
          await store.recordReceived({ envelope, bodySizeBytes: artifact.sizeBytes })
          held.add(id)
        }
        const durableIds = new Set(store.snapshot().custody.map(custody => custody.envelope.id))
        if (!saved.entryIds.every(id => durableIds.has(id))) throw new Error('Scanner page custody is incomplete')
        await this.host.authorize(route.projectId, `scan-checkpoint-${page.sweepId}-${page.page}`)
        cursor = (await this.mutate(this.host.scanStore, expectedRevision => this.host.scanStore.acknowledgePage({ projectId: route.projectId, routeId: route.id,
          sweepId: sweep.id, page: saved.page, at: this.now(), expectedRevision }))).cursor
        if (cursor.sweep!.status === 'complete') return
      }
      if (!this.abort.signal.aborted) await this.defer(cursor)
    } catch {
      if (this.abort.signal.aborted) return
      await this.host.quarantine({ projectId: route.projectId, envelopeId: cursor.sweep?.id ?? `scan-route:${route.id}`, reason: 'SCANNER_EVIDENCE_UNRESOLVED' })
      if (cursor.sweep?.status === 'active') await this.defer(cursor)
    }
  }
  async close(): Promise<void> { this.abort.abort(); await this.pending }
}
