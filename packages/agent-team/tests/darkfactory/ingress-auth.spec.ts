import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authenticateIngress, authenticatedIngressBody, genericIngressSigningInput, ingressPath, type IngressRoute, type IngressRequest } from '../../src/darkfactory/ingress-auth.ts'
import { digestBytes } from '../../src/darkfactory/json.ts'

const receivedAt = '2026-09-06T12:00:00.000Z'
const route: IngressRoute = { id: 'route', projectId: 'project', source: 'github', providerVersion: 'v1', policyRevision: 1, signingKeyId: 'key' }
const secret = 'synthetic-test-key'
function request(body = Buffer.from('{ "action": "opened" }')): IngressRequest {
  return { method: 'POST', path: ingressPath(route), body, headers: [['content-type', 'application/json'], ['x-github-event', 'issues'], ['x-github-delivery', 'delivery'], ['x-hub-signature-256', `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`]] }
}
function apm(timestamp = String(Date.parse(receivedAt) / 1000)) {
  const apmRoute: IngressRoute = { ...route, source: 'apm' }
  const body = Buffer.from('{}'), path = ingressPath(apmRoute)
  const signing = genericIngressSigningInput({ method: 'POST', path, keyId: route.signingKeyId, deliveryId: 'delivery', timestamp, bodyDigest: digestBytes(body) })
  const req: IngressRequest = { method: 'POST', path, body, headers: [['content-type', 'application/json'], ['x-darkfactory-key-id', 'key'], ['x-darkfactory-delivery-id', 'delivery'], ['x-darkfactory-timestamp', timestamp], ['x-darkfactory-signature-256', `sha256=${createHmac('sha256', secret).update(signing).digest('hex')}`]] }
  return { route: apmRoute, request: req, secret, receivedAt }
}
describe('ingress raw-byte authentication', () => {
  it('matches GitHub official signature vector and never reserializes raw JSON', () => {
    const official = request(Buffer.from('Hello, World!'))
    official.headers = [['content-type', 'application/json'], ['x-github-event', 'issues'], ['x-github-delivery', 'delivery'], ['x-hub-signature-256', 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17']]
    expect(authenticateIngress({ route, request: official, receivedAt, secret: "It's a Secret to Everybody" }).bodyDigest).toBe(digestBytes(official.body))
    const raw = request()
    const frame = authenticateIngress({ route, request: raw, receivedAt, secret })
    raw.body[0] = 0
    expect(Buffer.from(authenticatedIngressBody(frame)).toString()).toBe('{ "action": "opened" }')
    const changed = request(); changed.body = Buffer.from('{"action":"opened"}')
    expect(() => authenticateIngress({ route, request: changed, receivedAt, secret })).toThrow('AUTHENTICATION_INVALID')
    expect(() => authenticatedIngressBody({ ...frame })).toThrow('AUTHENTICATION_REQUIRED')
  })
  it('rejects ambiguous headers, compression, size limits and invalid framing before normalization', () => {
    for (const [extra, expected] of [
      [['X-GitHub-Delivery', 'other'], 'HEADERS_AMBIGUOUS'],
      [['content-encoding', 'gzip'], 'CONTENT_ENCODING_UNSUPPORTED'],
      [['content-length', '1000'], 'CONTENT_LENGTH_INVALID'],
      [['bad\nheader', 'value'], 'HEADERS_INVALID'],
    ] as const) {
      const req = request(); req.headers = [...req.headers, extra]
      expect(() => authenticateIngress({ route, request: req, receivedAt, secret })).toThrow(expected)
    }
    expect(() => authenticateIngress({ route, request: request(), receivedAt, secret, maxBodyBytes: 2 })).toThrow('BODY_TOO_LARGE')
    expect(() => authenticateIngress({ route, request: request(), receivedAt, secret, maxHeaderBytes: 2 })).toThrow('HEADERS_TOO_LARGE')
    expect(() => authenticateIngress({ route, request: { ...request(), path: '/other' }, receivedAt, secret })).toThrow('ROUTE_MISMATCH')
  })
  it('authenticates Sentry body only and never treats a timestamp header as signed freshness', () => {
    const sentryRoute: IngressRoute = { ...route, source: 'sentry' }, body = Buffer.from('{"action":"triggered"}')
    const req: IngressRequest = { method: 'POST', path: ingressPath(sentryRoute), body, headers: [['content-type', 'application/json'], ['request-id', 'delivery'], ['sentry-hook-resource', 'event_alert'], ['sentry-hook-timestamp', '1'], ['sentry-hook-signature', createHmac('sha256', secret).update(body).digest('hex')]] }
    const frame = authenticateIngress({ route: sentryRoute, request: req, receivedAt, secret })
    expect(frame.nativeProviderTimestamp).toBe('1')
    expect(frame.authenticatedProviderAt).toBeUndefined()
    req.headers = req.headers.map(([key, value]) => [key, key === 'sentry-hook-timestamp' ? '100' : value])
    expect(authenticateIngress({ route: sentryRoute, request: req, receivedAt, secret }).nativeProviderTimestamp).toBe('100')
  })
  it('binds every generic framing field and enforces the five-minute window', () => {
    const input = apm()
    expect(authenticateIngress(input).authenticatedProviderAt).toBe(receivedAt)
    for (const name of ['x-darkfactory-key-id', 'x-darkfactory-delivery-id', 'x-darkfactory-timestamp']) {
      const changed = apm()
      changed.request.headers = changed.request.headers.map(([key, value]) => [key, key === name ? (key.endsWith('timestamp') ? String(Number(value) + 1) : 'other') : value])
      expect(() => authenticateIngress(changed)).toThrow('AUTHENTICATION_INVALID')
    }
    const now = Date.parse(receivedAt) / 1000
    for (const offset of [-301, 301]) expect(() => authenticateIngress(apm(String(now + offset)))).toThrow('AUTHENTICATION_EXPIRED')
    for (const offset of [-300, 300]) expect(() => authenticateIngress(apm(String(now + offset)))).not.toThrow()
    expect(() => genericIngressSigningInput({ method: 'POST', path: '/darkfactory/v1/ingress/apm/route', keyId: 'key\nother', deliveryId: 'delivery', timestamp: String(now), bodyDigest: digestBytes('{}') })).toThrow('AUTHENTICATION_INVALID')
  })
})
