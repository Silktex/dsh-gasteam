/** Native signing references:
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 * https://github.com/getsentry/sentry-docs/blob/master/docs/integrations/integration-platform/webhooks.mdx
 * Neither native signature binds transport headers or establishes original freshness.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import z from 'zod'
import { digestSchema, idSchema, revisionSchema, timestampSchema } from './contracts/common.ts'
import { digestBytes } from './json.ts'

export const ingressRouteSchema = z.strictObject({
  id: idSchema, projectId: idSchema, source: z.enum(['github', 'sentry', 'apm']),
  providerVersion: idSchema, policyRevision: revisionSchema, signingKeyId: idSchema,
})
export type IngressRoute = z.output<typeof ingressRouteSchema>
export interface IngressRequest { method: string; path: string; headers: readonly (readonly [string, string])[]; body: Uint8Array }
export class IngressError extends Error {
  constructor(readonly status: number, readonly code: string, readonly authenticated = false) { super(`Dark Factory ingress rejected: ${code}`); this.name = 'IngressError' }
}
const unixSeconds = z.string().regex(/^(?:0|[1-9][0-9]{0,11})$/)
const sentryTimestamp = z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/)
export const GENERIC_INGRESS_DOMAIN = 'gasteam.darkfactory.ingress.v1'
export const GENERIC_INGRESS_HEADERS = {
  keyId: 'x-darkfactory-key-id', deliveryId: 'x-darkfactory-delivery-id',
  timestamp: 'x-darkfactory-timestamp', signature: 'x-darkfactory-signature-256',
} as const
export function ingressPath(route: Pick<IngressRoute, 'source' | 'id'>): string { return `/darkfactory/v1/ingress/${route.source}/${route.id}` }
/** UTF-8, seven newline-separated fields, no trailing newline; digest includes sha256: tag. */
export function genericIngressSigningInput(input: { method: string; path: string; keyId: string; deliveryId: string; timestamp: string; bodyDigest: string }): string {
  if (input.method !== 'POST' || !/^\/darkfactory\/v1\/ingress\/apm\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.path) ||
    !idSchema.safeParse(input.keyId).success || !idSchema.safeParse(input.deliveryId).success ||
    !unixSeconds.safeParse(input.timestamp).success || !digestSchema.safeParse(input.bodyDigest).success) throw new IngressError(401, 'AUTHENTICATION_INVALID')
  return [GENERIC_INGRESS_DOMAIN, input.method, input.path, input.keyId, input.deliveryId, input.timestamp, input.bodyDigest].join('\n')
}
export interface AuthenticatedIngress {
  readonly route: Readonly<IngressRoute>; readonly bodyDigest: `sha256:${string}`; readonly receivedAt: string
  readonly deliveryId: string; readonly eventKind: string
  /** An authenticated generic timestamp only; native receive/header times cannot establish freshness. */
  readonly authenticatedProviderAt?: string
  readonly nativeProviderTimestamp?: string
}
const bodies = new WeakMap<AuthenticatedIngress, Uint8Array>()
/** Host-only access for normalization; a forged metadata object has no authenticated bytes. */
export function authenticatedIngressBody(frame: AuthenticatedIngress): Uint8Array {
  const bytes = bodies.get(frame)
  if (!bytes) throw new IngressError(401, 'AUTHENTICATION_REQUIRED')
  return Uint8Array.from(bytes)
}
function headersOf(headers: IngressRequest['headers'], maxBytes: number): Map<string, string> {
  let size = 0
  const result = new Map<string, string>()
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string')) throw new IngressError(400, 'HEADERS_INVALID')
    const [name, value] = pair
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    if (size > maxBytes) throw new IngressError(413, 'HEADERS_TOO_LARGE')
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x1f\x7f]/.test(value)) throw new IngressError(400, 'HEADERS_INVALID')
    const key = name.toLowerCase()
    if (result.has(key)) throw new IngressError(400, 'HEADERS_AMBIGUOUS')
    result.set(key, value)
  }
  return result
}
export function authenticateIngress(input: {
  route: IngressRoute; request: IngressRequest; secret: string | Uint8Array; receivedAt: string; maxBodyBytes?: number; maxHeaderBytes?: number
}): AuthenticatedIngress {
  const parsed = ingressRouteSchema.safeParse(input.route)
  if (!parsed.success || !timestampSchema.safeParse(input.receivedAt).success) throw new IngressError(503, 'HOST_CONFIGURATION_INVALID')
  const route = parsed.data, request = input.request
  const maxBodyBytes = input.maxBodyBytes ?? 1_048_576, maxHeaderBytes = input.maxHeaderBytes ?? 16_384
  if (![maxBodyBytes, maxHeaderBytes].every(limit => Number.isSafeInteger(limit) && limit > 0 && limit <= 16_777_216)) throw new IngressError(503, 'HOST_CONFIGURATION_INVALID')
  if (!(request.body instanceof Uint8Array)) throw new IngressError(400, 'BODY_INVALID')
  if (request.body.byteLength > maxBodyBytes) throw new IngressError(413, 'BODY_TOO_LARGE')
  if (request.method !== 'POST' || request.path !== ingressPath(route)) throw new IngressError(404, 'ROUTE_MISMATCH')
  const headers = headersOf(request.headers, maxHeaderBytes)
  if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') throw new IngressError(415, 'CONTENT_ENCODING_UNSUPPORTED')
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(headers.get('content-type') ?? '')) throw new IngressError(415, 'CONTENT_TYPE_UNSUPPORTED')
  const length = headers.get('content-length')
  if (length !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) !== request.body.byteLength || headers.has('transfer-encoding'))) throw new IngressError(400, 'CONTENT_LENGTH_INVALID')
  if ((typeof input.secret === 'string' && (!input.secret || !input.secret.isWellFormed())) || (!(typeof input.secret === 'string') && (!(input.secret instanceof Uint8Array) || !input.secret.byteLength))) throw new IngressError(503, 'SECRET_UNAVAILABLE')
  const body = Uint8Array.from(request.body), bodyDigest = digestBytes(body)
  let deliveryId: string, eventKind: string, signature: string, signed: string | Uint8Array = body
  let authenticatedProviderAt: string | undefined, nativeProviderTimestamp: string | undefined
  if (route.source === 'github') {
    deliveryId = headers.get('x-github-delivery') ?? ''
    eventKind = headers.get('x-github-event') ?? ''
    signature = headers.get('x-hub-signature-256') ?? ''
    if (!/^sha256=[a-f0-9]{64}$/.test(signature)) throw new IngressError(401, 'AUTHENTICATION_INVALID')
    signature = signature.slice(7)
  } else if (route.source === 'sentry') {
    deliveryId = headers.get('request-id') ?? ''
    eventKind = headers.get('sentry-hook-resource') ?? ''
    signature = headers.get('sentry-hook-signature') ?? ''
    nativeProviderTimestamp = headers.get('sentry-hook-timestamp')
    if (!sentryTimestamp.safeParse(nativeProviderTimestamp).success) throw new IngressError(401, 'AUTHENTICATION_INVALID')
  } else {
    const keyId = headers.get(GENERIC_INGRESS_HEADERS.keyId) ?? ''
    deliveryId = headers.get(GENERIC_INGRESS_HEADERS.deliveryId) ?? ''
    const timestamp = headers.get(GENERIC_INGRESS_HEADERS.timestamp) ?? ''
    eventKind = 'alert'
    signature = headers.get(GENERIC_INGRESS_HEADERS.signature) ?? ''
    if (!/^sha256=[a-f0-9]{64}$/.test(signature) || keyId !== route.signingKeyId) throw new IngressError(401, 'AUTHENTICATION_INVALID')
    signature = signature.slice(7)
    signed = genericIngressSigningInput({ method: request.method, path: request.path, keyId, deliveryId, timestamp, bodyDigest })
    const nowSeconds = Date.parse(input.receivedAt) / 1000
    if (!Number.isFinite(nowSeconds) || Math.abs(nowSeconds - Number(timestamp)) > 300) throw new IngressError(401, 'AUTHENTICATION_EXPIRED')
    authenticatedProviderAt = new Date(Number(timestamp) * 1000).toISOString()
  }
  if (!idSchema.safeParse(deliveryId).success || !idSchema.safeParse(eventKind).success || !/^[a-f0-9]{64}$/.test(signature)) throw new IngressError(401, 'AUTHENTICATION_INVALID')
  const expected = createHmac('sha256', input.secret).update(signed).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new IngressError(401, 'AUTHENTICATION_INVALID')
  const frame: AuthenticatedIngress = Object.freeze({ route: Object.freeze(route), bodyDigest, receivedAt: input.receivedAt, deliveryId, eventKind,
    ...(authenticatedProviderAt === undefined ? {} : { authenticatedProviderAt }), ...(nativeProviderTimestamp === undefined ? {} : { nativeProviderTimestamp }) })
  bodies.set(frame, body)
  return frame
}
