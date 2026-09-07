import { expect, it } from 'vitest'
import { readMonitoringResource, type MonitoringReadOptions } from '../../src/darkfactory/monitoring-reconciliation.ts'

const now = '2026-09-06T12:00:00.000Z'
const base: MonitoringReadOptions = { apiBaseUrl: 'https://monitor.example.test', secret: 'PRIVATE_MONITOR_TOKEN', redactText: text => text, now: () => new Date(now) }
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
it('charges before every fixed-origin GET and redacts token-bearing narrative without changing response digests', async () => {
  const events: string[] = []
  const result = await readMonitoringResource({ ...base, beforeRequest: async () => { events.push('charge') }, transport: async (url, init) => {
    events.push('GET'); expect(String(url)).toMatch(/^https:\/\/monitor.example.test\//)
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Authorization: `Bearer ${base.secret}` } })
    return json({ message: base.secret })
  } }, async context => {
    await context.get('/one'); await context.get('/two')
    return { title: context.redact(`value ${base.secret}`, 1024), digests: context.responseDigests() }
  })
  expect(events).toEqual(['charge', 'GET', 'charge', 'GET'])
  expect(result).toMatchObject({ decision: 'trusted', requestsUsed: 2, title: 'value [REDACTED]' })
  expect(JSON.stringify(result)).not.toContain(base.secret)
  if (result.decision === 'trusted') expect(result.digests).toHaveLength(2)
})
it.each(['https://other.example.test/path', '//other.example.test/path', 'relative', '/path#fragment'])('rejects unsafe callback path %s before charging', async path => {
  let charged = 0
  const result = await readMonitoringResource({ ...base, beforeRequest: () => { charged++ } }, async context => ({ value: await context.get(path) }))
  expect(result).toMatchObject({ decision: 'denied', requestsUsed: 0 }); expect(charged).toBe(0)
})
it.each([
  { response: () => new Response('', { status: 302, headers: { location: 'https://other.example.test' } }), diagnosticCode: 'REDIRECT_REFUSED' },
  { response: () => new Response('{"key":1,"key":2}', { headers: { 'content-type': 'application/json' } }), diagnosticCode: 'RESPONSE_INVALID' },
  { response: () => new Response('plain', { headers: { 'content-type': 'text/html' } }), diagnosticCode: 'RESPONSE_INVALID' },
  { response: () => json({ value: 'x'.repeat(100) }), diagnosticCode: 'RESPONSE_TOO_LARGE' },
])('rejects bounded invalid provider responses: $diagnosticCode', async ({ response, diagnosticCode }) => {
  const result = await readMonitoringResource({ ...base, maxBodyBytes: 32, transport: async () => response() }, async context => ({ value: await context.get('/one') }))
  expect(result).toMatchObject({ decision: 'unresolved', diagnosticCode, requestsUsed: 1 })
})
it.each([
  { headers: { 'retry-after': '864000' }, until: '2026-09-16T12:00:00.000Z' },
  { headers: { 'x-sentry-rate-limit-remaining': '0', 'x-sentry-rate-limit-reset': String(Date.parse(now) / 1000 + 900) }, until: '2026-09-06T12:15:00.000Z' },
  { headers: { 'retry-after': 'invalid' }, until: '2026-09-06T12:01:00.000Z' },
])('persists a conservative provider cooldown before returning: $until', async ({ headers, until }) => {
  const saved: string[] = []
  const result = await readMonitoringResource({ ...base, transport: async () => json({}, headers as Record<string, string>, 429), onRateLimit: async value => { saved.push(value) } }, async context => ({ value: await context.get('/one') }))
  expect(result).toMatchObject({ decision: 'unresolved', reasons: ['PROVIDER_RATE_LIMITED'] }); expect(saved).toEqual([until])
})
it('persists exhausted successful-response limits before preventing another GET', async () => {
  let calls = 0, saved = false
  const result = await readMonitoringResource({ ...base, transport: async () => { calls++; return json({}, { 'x-sentry-rate-limit-remaining': '0' }) }, onRateLimit: () => { saved = true } }, async context => {
    await context.get('/one'); expect(saved).toBe(true); return { value: await context.get('/two') }
  })
  expect(result).toMatchObject({ decision: 'unresolved', reasons: ['PROVIDER_RATE_LIMITED'], requestsUsed: 1 }); expect(calls).toBe(1)
})
it('does not transport after a delayed accounting hook outlives the request deadline', async () => {
  let release!: () => void, calls = 0
  const waiting = new Promise<void>(resolve => { release = resolve })
  const result = await readMonitoringResource({ ...base, requestTimeoutMs: 10, beforeRequest: () => waiting, transport: async () => { calls++; return json({}) } }, async context => ({ value: await context.get('/one') }))
  expect(result).toMatchObject({ decision: 'unresolved', diagnosticCode: 'REQUEST_TIMEOUT', requestsUsed: 0 })
  release(); await new Promise(resolve => setTimeout(resolve, 5)); expect(calls).toBe(0)
})
it('halts subsequent reads if cooldown persistence fails and emits only fixed diagnostics', async () => {
  let calls = 0
  const result = await readMonitoringResource({ ...base, transport: async () => { calls++; return json({}, { 'retry-after': '60' }, 429) },
    onRateLimit: () => { throw new Error(base.secret) } }, async context => { await context.get('/one'); return { value: await context.get('/two') } })
  expect(calls).toBe(1); expect(result).toMatchObject({ decision: 'unresolved', diagnosticCode: 'REQUEST_FAILED' }); expect(JSON.stringify(result)).not.toContain(base.secret)
})
it('requires explicit loopback fixture opt-in and bounds actual requests', async () => {
  let calls = 0
  const options = { ...base, apiBaseUrl: 'http://127.0.0.1', transport: async () => { calls++; return json({}) } }
  expect(await readMonitoringResource(options, async context => ({ value: await context.get('/one') }))).toMatchObject({ decision: 'denied', requestsUsed: 0 })
  const result = await readMonitoringResource({ ...options, fixtureLoopback: true }, async context => {
    for (let index = 0; index < 11; index++) await context.get(`/value/${index}`)
    return {}
  })
  expect(result).toMatchObject({ decision: 'unresolved', diagnosticCode: 'REQUEST_LIMIT', requestsUsed: 10 }); expect(calls).toBe(10)
})
it('evaluates freshness and failure times against host time after transport rather than pre-request time', async () => {
  let currentTime = Date.parse('2026-09-06T12:00:00.000Z')
  const options: MonitoringReadOptions = {
    ...base,
    now: () => new Date(currentTime),
    transport: async () => {
      currentTime += 2000
      return json({ ok: true })
    },
  }
  const result = await readMonitoringResource(options, async context => {
    expect(context.checkedAt).toBe('2026-09-06T12:00:00.000Z')
    await context.get('/one')
    expect(context.checkedAt).toBe('2026-09-06T12:00:02.000Z')
    return { checkedAt: context.checkedAt, value: 42 }
  })
  expect(result).toMatchObject({ decision: 'trusted', checkedAt: '2026-09-06T12:00:02.000Z' })
})
