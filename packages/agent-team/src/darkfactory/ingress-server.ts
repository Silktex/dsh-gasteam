import type { InboundEnvelopeWithoutArtifact } from './contracts/ingestion.ts'
/** Bounded HTTP custody service. Trust enrichment and task admission are separate host operations. */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { EnabledDarkFactoryConfig } from './config.ts'
import { enabledDarkFactoryConfigSchema } from './config.ts'
import { inboundEnvelopeSchema } from './contracts/index.ts'
import type { SecretRef } from './contracts/index.ts'
import { digestJson } from './json.ts'
import { resolveSecret } from './secrets.ts'
import { authenticateIngress, IngressError } from './ingress-auth.ts'
import { normalizeIngress } from './ingress-adapters.ts'
import { assessIngressScope } from './ingress-scope.ts'
import { DarkFactoryArtifactStore, ArtifactError } from './artifacts.ts'
import { DarkFactoryIngestionStore, IngressEscalationRequiredError } from './ingestion-store.ts'

export interface IngressServerHost {
  directory: string
  stores: ReadonlyMap<string, DarkFactoryIngestionStore>
  artifacts?: DarkFactoryArtifactStore
  /** Host-pinned sanitizer; raw body and transport headers are never persisted by this service. */
  sanitize(facts: ReturnType<typeof normalizeIngress>['facts']): unknown
  /** Must durably create/reuse a receipt in the existing operator inbox before resolving. */
  quarantine(input: { projectId: string; envelopeId: string; reason: string }): Promise<string>
  /** Optional for orchestration fixtures; the coordinator supplies live pinned policy authority. */
  authorize?: (projectId: string, envelopeId: string) => Promise<void>
  resolveSecret?: (ref: SecretRef) => Promise<string>
  clock?: () => number
}
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
class Bucket {
  private tokens: number
  private at: number
  constructor(private readonly perMinute: number, private readonly burst: number, now: number) { this.tokens = burst; this.at = now }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.at) * this.perMinute / 60_000)
    this.at = Math.max(this.at, now)
    if (this.tokens < 1) return false
    this.tokens--; return true
  }
}
async function rawBody(request: IncomingMessage, max: number): Promise<Buffer> {
  const declared = request.headers['content-length']
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new HttpFailure(413, 'BODY_LIMIT')
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new HttpFailure(415, 'ENCODING_UNSUPPORTED')
  const chunks: Buffer[] = []
  let size = 0
  const timeout = setTimeout(() => request.destroy(new HttpFailure(408, 'BODY_TIMEOUT')), 10_000)
  try {
    for await (const value of request.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string)
      size += chunk.length
      if (size > max) throw new HttpFailure(413, 'BODY_LIMIT')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  } finally { clearTimeout(timeout) }
}


export class DarkFactoryIngressServer {
  private readonly pending = new Set<Promise<void>>()
  private closing: Promise<void> | undefined
  private constructor(private readonly server: Server) {}

  static async open(rawPolicy: EnabledDarkFactoryConfig, host: IngressServerHost): Promise<DarkFactoryIngressServer> {
    const policy = enabledDarkFactoryConfigSchema.parse(rawPolicy)
    if (policy.mode !== 'observe') throw new Error('Ingress service currently supports observe custody only')
    if (policy.ingestion.transport.kind !== 'listener') throw new Error('Ingress listener requires loopback listener transport behind the configured TLS gateway')
    if (!isAbsolute(host.directory) || await realpath(host.directory) !== host.directory) throw new Error('Ingress directory must be an existing canonical absolute directory')
    if (policy.projectIds.some(id => !host.stores.has(id))) throw new Error('Ingress project store is not registered')
    const artifacts = host.artifacts ?? await DarkFactoryArtifactStore.open(host.directory, policy.projectIds, policy.limits.maxArtifactBytes, policy.limits.maxArtifactTotalBytes)
    const routes = policy.ingestion.routes.filter(route => route.source !== 'maintenance')
    const secrets = new Map<string, string>()
    for (const route of routes) secrets.set(route.id, await (host.resolveSecret ?? resolveSecret)(route.secretRef))
    const clock = host.clock ?? Date.now
    const globalBucket = new Bucket(Math.min(10_000, policy.ingestion.requestsPerMinute * routes.length), 20, clock())
    const buckets = new Map(routes.map(route => [route.id, new Bucket(policy.ingestion.requestsPerMinute, Math.min(20, policy.ingestion.requestsPerMinute), clock())]))
    const projectOperations = new Map<string, Promise<unknown>>()
    const send = (response: ServerResponse, status: number, value: unknown) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'connection': 'close', ...(status === 429 ? { 'retry-after': '60' } : {}) })
      response.end(JSON.stringify(value))
    }
    let service: DarkFactoryIngressServer
    const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 10_000, headersTimeout: 5_000 }, (request, response) => {
      const operation = (async () => {
        try {
          if (service.pending.size >= 64) throw new HttpFailure(503, 'REQUEST_CAPACITY')
          if (!globalBucket.take(clock())) throw new HttpFailure(429, 'GLOBAL_RATE_LIMIT')
          if (request.method !== 'POST') throw new HttpFailure(405, 'METHOD_UNSUPPORTED')
          const route = routes.find(route => request.url === `/darkfactory/v1/ingress/${route.source}/${route.id}`)
          if (!route) throw new HttpFailure(404, 'ROUTE_UNREGISTERED')
          const body = await rawBody(request, policy.ingestion.maxBodyBytes)
          const headers: [string, string][] = []
          for (let index = 0; index < request.rawHeaders.length; index += 2) headers.push([request.rawHeaders[index]!, request.rawHeaders[index + 1]!])
          const frame = authenticateIngress({
            route: { id: route.id, projectId: route.projectId, source: route.source as 'github' | 'sentry' | 'apm', providerVersion: route.providerVersion, signingKeyId: route.signingKeyId, policyRevision: policy.policyRevision },
            request: { method: 'POST', path: request.url!, headers, body }, secret: secrets.get(route.id)!,
            receivedAt: new Date(clock()).toISOString(), maxBodyBytes: policy.ingestion.maxBodyBytes, maxHeaderBytes: 16_384,
          })
          if (!buckets.get(route.id)!.take(clock())) throw new HttpFailure(429, 'ROUTE_RATE_LIMIT')
          const custody = (projectOperations.get(route.projectId) ?? Promise.resolve()).then(async () => {
            let envelopeFields: InboundEnvelopeWithoutArtifact
            let sanitized: unknown
            let quarantineReason: string | undefined
            try {
              const normalized = normalizeIngress(frame)
              envelopeFields = normalized.envelope
              sanitized = host.sanitize(normalized.facts)
              const scope = assessIngressScope(route, normalized.facts)
              if (!scope.eligibleForReconciliation) quarantineReason = scope.reasons[0] ?? 'SOURCE_SCOPE_DENIED'
            } catch (error) {
              if (!(error instanceof IngressError) || !error.authenticated) throw error
              quarantineReason = error.code
              sanitized = { source: route.source, bodyDigest: frame.bodyDigest, reason: error.code }
              envelopeFields = {
                schemaVersion: 1, id: `envelope:${digestJson([route.source, route.id, frame.deliveryId, frame.bodyDigest]).slice(7)}`,
                projectId: route.projectId, policyRevision: policy.policyRevision, source: frame.route.source,
                adapterVersion: route.providerVersion, routeId: route.id, deliveryId: frame.deliveryId,
                eventKind: ['issues', 'pull_request', 'dependabot_alert', 'issue', 'event_alert', 'metric_alert'].includes(frame.eventKind) ? frame.eventKind : 'unsupported',
                action: 'invalid', bodyDigest: frame.bodyDigest, receivedAt: frame.receivedAt,
                signingKeyId: route.signingKeyId, authentication: 'verified',
                ...(frame.authenticatedProviderAt === undefined ? {} : { providerAt: frame.authenticatedProviderAt }),
              }
            }
            await host.authorize?.(route.projectId, envelopeFields.id)
            const artifact = await artifacts.persist(route.projectId, sanitized)
            const envelope = inboundEnvelopeSchema.parse({ ...envelopeFields, artifact })
            const store = host.stores.get(route.projectId)!
            const input = { envelope, bodySizeBytes: body.length, ...(quarantineReason ? { quarantineReason } : {}) }
            try { return await store.recordReceived(input) } catch (error) {
              if (!(error instanceof IngressEscalationRequiredError)) throw error
              const healthEscalationId = await host.quarantine({ projectId: route.projectId, envelopeId: envelope.id, reason: quarantineReason ?? error.code })
              return await store.recordReceived({ ...input, healthEscalationId })
            }
          })
          projectOperations.set(route.projectId, custody.catch(() => {}))
          const outcome = await custody
          send(response, outcome.duplicate ? 200 : 202, { receipt: outcome.receipt, duplicate: outcome.duplicate, conflict: outcome.conflict })
        } catch (error) {
          if (error instanceof HttpFailure || error instanceof IngressError || error instanceof ArtifactError) send(response, error.status, { error: error.code })
          else send(response, 503, { error: 'CUSTODY_UNAVAILABLE' })
        }
      })()
      service.pending.add(operation)
      void operation.then(() => service.pending.delete(operation), () => service.pending.delete(operation))
    })
    service = new DarkFactoryIngressServer(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(policy.ingestion.transport.kind === 'listener' ? policy.ingestion.transport.port : 0, policy.ingestion.transport.kind === 'listener' ? policy.ingestion.transport.host : '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    return service
  }
  address(): { address: string; port: number } {
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Ingress listener is closed')
    return { address: address.address, port: address.port }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const stopped = new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
      this.server.closeAllConnections()
      await stopped
      await Promise.all(this.pending)
    })()
  }
}
