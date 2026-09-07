/** Bounded host-pinned monitoring reads; no provider URL can redirect credentials. */
import { digestJson, parseStrictJson } from './json.ts'

export type MonitoringReason = 'SOURCE_DENIED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_RESPONSE_INVALID'
export class MonitoringProviderFailure extends Error {
  constructor(readonly reason: MonitoringReason, readonly diagnostic: string) { super(reason) }
}
export interface MonitoringResultBase { reasons: string[]; diagnosticCode: string; checkedAt: string; requestsUsed: number }
export type MonitoringResult<T extends object> = (MonitoringResultBase & { decision: 'trusted' } & T) |
  (MonitoringResultBase & { decision: 'denied' | 'unresolved' })
export interface MonitoringReadOptions {
  apiBaseUrl: string; fixtureLoopback?: boolean; secret: string; redactText: (text: string) => string
  now?: () => Date; signal?: AbortSignal; transport?: typeof fetch
  beforeRequest?: () => void | Promise<void>; onRateLimit?: (until: string) => void | Promise<void>
  requestTimeoutMs?: number; totalTimeoutMs?: number; maxBodyBytes?: number
}
export interface MonitoringReadContext {
  readonly checkedAt: string; now(): Date; get(path: string): Promise<unknown>; redact(text: string, limit: number): string
  responseDigests(): string[]; requestsUsed(): number
}
export async function readMonitoringResource<T extends object>(options: MonitoringReadOptions, read: (context: MonitoringReadContext) => Promise<T>): Promise<MonitoringResult<T>> {
  let requestsUsed = 0
  const hostNow = () => options.now?.() ?? new Date()
  const digests: string[] = []
  const fail = (reason: MonitoringReason, diagnostic: string): MonitoringResult<T> => ({ decision: reason === 'SOURCE_DENIED' ? 'denied' : 'unresolved',
    reasons: [reason], diagnosticCode: /^[A-Z][A-Z0-9_]{0,127}$/.test(diagnostic) ? diagnostic : 'REQUEST_FAILED', checkedAt: hostNow().toISOString(), requestsUsed })
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000, totalTimeoutMs = options.totalTimeoutMs ?? 15000, maxBodyBytes = options.maxBodyBytes ?? 1048576
  let origin: URL
  try {
    origin = new URL(options.apiBaseUrl)
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (options.fixtureLoopback ? origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) : origin.protocol !== 'https:') ||
      typeof options.secret !== 'string' || !options.secret.length || options.secret.length > 8192 || /[\r\n]/.test(options.secret) || typeof options.redactText !== 'function' ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10000 ||
      !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 15000 ||
      !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1048576) throw new Error('configuration')
  } catch { return fail('SOURCE_DENIED', 'CONFIGURATION_INVALID') }
  const deadline = performance.now() + totalTimeoutMs
  let exhausted = false
  function rateLimitUntil(headers: Headers): string {
    const now = (options.now?.() ?? new Date()).getTime(), dates: number[] = [], maxDate = 253402300799999
    const add = (raw: string | null, relative: boolean) => {
      const seconds = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN, at = (relative ? now : 0) + seconds * 1000
      dates.push(Number.isSafeInteger(seconds) && Number.isSafeInteger(at) && at > now && at <= maxDate ? at : now + 60000)
    }
    if (headers.has('retry-after')) add(headers.get('retry-after'), true)
    for (const prefix of ['x-ratelimit', 'x-sentry-rate-limit']) if (headers.get(`${prefix}-remaining`) === '0') add(headers.get(`${prefix}-reset`), false)
    return new Date(dates.length ? Math.max(...dates) : now + 60000).toISOString()
  }
  async function get(path: string): Promise<unknown> {
    const url = new URL(path, origin)
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== origin.origin || url.username || url.password || url.hash) throw new MonitoringProviderFailure('SOURCE_DENIED', 'REQUEST_ORIGIN_MISMATCH')
    if (options.signal?.aborted) throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_ABORTED')
    if (exhausted) throw new MonitoringProviderFailure('PROVIDER_RATE_LIMITED', 'RATE_LIMITED')
    if (requestsUsed >= 10) throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_LIMIT')
    const timeoutMs = Math.min(requestTimeoutMs, deadline - performance.now())
    if (timeoutMs <= 0) throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, abortExternal: (() => void) | undefined
    try {
      return await Promise.race([
        (async () => {
          await options.beforeRequest?.()
          if (controller.signal.aborted) throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')
          requestsUsed++
          const response = await (options.transport ?? fetch)(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
            headers: { Accept: 'application/json', Authorization: `Bearer ${options.secret}`, 'User-Agent': 'gasteam-darkfactory' } })
          const discard = () => { void response.body?.cancel().catch(() => {}) }
          if (controller.signal.aborted) { discard(); throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT') }
          if (response.redirected || response.url && response.url !== url.href || response.status >= 300 && response.status < 400) { discard(); throw new MonitoringProviderFailure('PROVIDER_RESPONSE_INVALID', 'REDIRECT_REFUSED') }
          const rate = response.status === 429 || response.status === 403 && (response.headers.has('retry-after') || ['x-ratelimit-remaining', 'x-sentry-rate-limit-remaining'].some(header => response.headers.get(header) === '0'))
          exhausted = rate || ['x-ratelimit-remaining', 'x-sentry-rate-limit-remaining'].some(header => response.headers.get(header) === '0')
          if (exhausted) {
            try { await options.onRateLimit?.(rateLimitUntil(response.headers)) } catch (error) { discard(); throw error }
            if (controller.signal.aborted) { discard(); throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT') }
          }
          if (rate) { discard(); throw new MonitoringProviderFailure('PROVIDER_RATE_LIMITED', 'RATE_LIMITED') }
          if (response.status !== 200) { discard(); throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'HTTP_FAILURE') }
          const length = response.headers.get('content-length')
          if (!/^application\/(?:json|[a-z0-9.-]+\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
            length !== null && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes) || !response.body) { discard(); throw new MonitoringProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID') }
          const reader = response.body.getReader(), chunks: Uint8Array[] = []
          let bytes = 0
          const abort = () => { void reader.cancel().catch(() => {}) }
          controller.signal.addEventListener('abort', abort, { once: true })
          try {
            while (true) {
              const chunk = await reader.read()
              if (controller.signal.aborted) throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')
              if (chunk.done) break
              bytes += chunk.value.byteLength
              if (bytes > maxBodyBytes) throw new MonitoringProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_TOO_LARGE')
              chunks.push(chunk.value)
            }
            let value: unknown
            try { value = parseStrictJson(Buffer.concat(chunks), maxBodyBytes) } catch { throw new MonitoringProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID') }
            digests.push(digestJson(value)); return value
          } finally { controller.signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock() }
        })(),
        new Promise<never>((_, reject) => {
          abortExternal = () => { controller.abort(); reject(new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_ABORTED')) }
          options.signal?.addEventListener('abort', abortExternal, { once: true })
          if (options.signal?.aborted) abortExternal()
          timer = setTimeout(() => { controller.abort(); reject(new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_TIMEOUT')) }, timeoutMs)
        }),
      ])
    } catch (error) { if (error instanceof MonitoringProviderFailure) throw error; throw new MonitoringProviderFailure('PROVIDER_UNAVAILABLE', 'REQUEST_FAILED') }
    finally { if (timer) clearTimeout(timer); if (abortExternal) options.signal?.removeEventListener('abort', abortExternal) }
  }
  try {
    const result = await read({
      get checkedAt() { return hostNow().toISOString() },
      now() { return hostNow() },
      get, responseDigests: () => [...digests], requestsUsed: () => requestsUsed,
      redact(text, limit) {
        let output: string
        try { output = options.redactText(text) } catch { throw new MonitoringProviderFailure('PROVIDER_RESPONSE_INVALID', 'REDACTION_FAILED') }
        if (typeof output !== 'string' || !output.isWellFormed() || !Number.isSafeInteger(limit) || limit < 0 || limit > 16384) throw new MonitoringProviderFailure('PROVIDER_RESPONSE_INVALID', 'REDACTION_FAILED')
        const bounded = output.split(options.secret).join('[REDACTED]').slice(0, limit)
        return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded
      },
    })
    const checkedAt = (result as { checkedAt?: string }).checkedAt ?? hostNow().toISOString()
    return { decision: 'trusted', reasons: ['RECONCILED'], diagnosticCode: 'RECONCILED', checkedAt, requestsUsed, ...result }
  } catch (error) { return error instanceof MonitoringProviderFailure ? fail(error.reason, error.diagnostic) : fail('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID') }
}
