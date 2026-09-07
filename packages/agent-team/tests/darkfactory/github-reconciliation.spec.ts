import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { reconcileGithubIssue, type GithubIssueReconciliationOptions } from '../../src/darkfactory/github-reconciliation.ts'
import { ingressPolicyRouteSchema, githubReconciliationRegistrationSchema } from '../../src/darkfactory/config.ts'
import { enabledPolicy } from './config-fixture.ts'

const registration = githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'FIXTURE_TOKEN' }, credentialKind: 'installation-token' })
const current = () => ({ id: 100, number: 7, title: 'Repair', body: 'Untrusted provider content', user: { id: 12 }, labels: [{ id: 3, name: 'automate' }], state: 'open', updated_at: '2026-09-06T12:00:00Z' })
const repositories = () => ({ total_count: 1, repositories: [{ id: 42, full_name: 'Owner/Repo', url: 'https://attacker.invalid/never' }] })
const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
function options(overrides: Partial<GithubIssueReconciliationOptions> = {}): GithubIssueReconciliationOptions {
  return { registration, observed: { kind: 'issue', repositoryId: '42', providerEntityId: '100', actorId: '12', installationId: '10', number: 7, sourceEntityId: 'github:issue:42:100' },
    route: ingressPolicyRouteSchema.parse({ ...enabledPolicy().ingestion.routes[0], repositoryIds: ['42'], senderIds: ['12'], bindings: { installationIds: ['10'], authorIds: ['12'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] } }),
    projectId: 'project', policyRevision: 1, secret: 'fixture-installation-secret', redactText: value => value, now: () => new Date('2026-09-06T12:01:00Z'),
    transport: async url => String(url).includes('/installation/repositories') ? json(repositories()) : json(current()), ...overrides }
}
function transport(values: (() => Response)[]) { let calls = 0; const urls: string[] = []; return { get calls() { return calls }, urls, fetch: (async (url, init) => { urls.push(String(url)); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual'); const next = values[calls++]; if (!next) throw new Error('unexpected request'); return next() }) as typeof fetch } }

describe('authoritative GitHub issue reconciliation', () => {
  it('pins repository identity and uses only host paths; revisions include raw execution fields before redaction', async () => {
    const mock = transport([() => json(repositories()), () => json({ ...current(), body: 'fixture-installation-secret', html_url: 'https://attacker.invalid', extension: { harmless: true } })])
    const result = await reconcileGithubIssue(options({ transport: mock.fetch }))
    expect(result.decision).toBe('trusted')
    if (result.decision !== 'trusted') throw new Error('fixture')
    expect(result.issue).toMatchObject({ id: '100', authorId: '12', actorId: '12', sourceUrl: 'https://github.com/owner/repo/issues/7', context: '[REDACTED]' })
    expect(result.provenance).toMatchObject({ credentialBinding: 'host-pinned-installation-token', sourceEntityId: 'github:issue:42:100', requestsUsed: 2 })
    expect(JSON.stringify(result)).not.toContain('fixture-installation-secret')
    expect(mock.urls).toEqual(['https://api.github.com/installation/repositories?per_page=100&page=1', 'https://api.github.com/repos/owner/repo/issues/7'])
    for (const patch of [{ title: 'Changed' }, { body: 'changed' }, { labels: [{ id: 4, name: 'automate' }] }, { updated_at: '2026-09-06T12:00:01Z' }]) {
      const changed = await reconcileGithubIssue(options({ transport: async url => String(url).includes('/installation/') ? json(repositories()) : json({ ...current(), ...patch }) }))
      expect(changed.decision === 'trusted' && changed.sourceRevision).not.toBe(result.sourceRevision)
    }
  })
  it('denies mismatched host bindings and unsupported sources before requesting', async () => {
    for (const patch of [{ installationId: '11' }, { repositoryId: '99' }, { actorId: '99' }, { kind: 'pull_request' }]) {
      const mock = transport([])
      const result = await reconcileGithubIssue(options({ observed: { ...options().observed, ...patch } as GithubIssueReconciliationOptions['observed'], transport: mock.fetch }))
      expect(result.decision).toBe('denied'); expect(mock.calls).toBe(0)
    }
    for (const apiBaseUrl of ['https://attacker.invalid', 'https://api.github.com/anything', 'http://127.0.0.1:9000']) expect((await reconcileGithubIssue(options({ registration: { ...registration, apiBaseUrl } }))).diagnosticCode).toBe('CONFIGURATION_INVALID')
    expect((await reconcileGithubIssue(options({ registration: { ...registration, repositoryName: '../repo' } }))).diagnosticCode).toBe('CONFIGURATION_INVALID')
  })
  it('checks repository ID and registered full name before issue lookup', async () => {
    for (const [value, code] of [[{ total_count: 1, repositories: [{ id: 42, full_name: 'attacker/repo' }] }, 'REPOSITORY_NAME_MISMATCH'], [{ total_count: 0, repositories: [] }, 'REPOSITORY_NOT_VISIBLE']] as const) {
      const mock = transport([() => json(value)])
      expect((await reconcileGithubIssue(options({ transport: mock.fetch }))).diagnosticCode).toBe(code)
      expect(mock.calls).toBe(1)
    }
  })
  it('denies current closed issues, missing labels, disallowed authors, wrong IDs and PRs', async () => {
    for (const [patch, code] of [[{ state: 'closed' }, 'ISSUE_CLOSED'], [{ labels: [] }, 'AUTOMATION_LABEL_MISSING'], [{ user: { id: 99 } }, 'AUTHOR_NOT_ALLOWED'], [{ id: 101 }, 'ISSUE_ID_MISMATCH'], [{ number: 8 }, 'ISSUE_ID_MISMATCH'], [{ pull_request: null }, 'PULL_REQUEST_UNSUPPORTED']] as const) {
      const mock = transport([() => json(repositories()), () => json({ ...current(), ...patch })])
      expect(await reconcileGithubIssue(options({ transport: mock.fetch }))).toMatchObject({ decision: 'denied', reasons: ['SOURCE_DENIED'], diagnosticCode: code })
    }
  })
  it('bounds pagination and ignores provider next-page URLs', async () => {
    const page = { total_count: 101, repositories: Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, full_name: `owner/repo${i}` })) }
    const mock = transport([() => json(page, { link: '<https://attacker.invalid>; rel="next"' }), () => json({ total_count: 101, repositories: [{ id: 42, full_name: 'owner/repo' }] }), () => json(current())])
    expect((await reconcileGithubIssue(options({ transport: mock.fetch }))).decision).toBe('trusted')
    expect(mock.urls[1]).toBe('https://api.github.com/installation/repositories?per_page=100&page=2')
    const limited = transport([() => json(page)])
    expect(await reconcileGithubIssue(options({ transport: limited.fetch, maxPages: 1 }))).toMatchObject({ decision: 'unresolved', diagnosticCode: 'PAGINATION_LIMIT', requestsUsed: 1 })
    expect((await reconcileGithubIssue(options({ maxPages: 11 }))).diagnosticCode).toBe('CONFIGURATION_INVALID')
  })
  it('returns fixed unresolved provider errors and refuses redirects', async () => {
    for (const [status, headers, reason] of [[429, {}, 'PROVIDER_RATE_LIMITED'], [403, { 'x-ratelimit-remaining': '0' }, 'PROVIDER_RATE_LIMITED'], [403, { 'retry-after': '2' }, 'PROVIDER_RATE_LIMITED'], [401, {}, 'PROVIDER_UNAVAILABLE'], [404, {}, 'PROVIDER_UNAVAILABLE'], [500, {}, 'PROVIDER_UNAVAILABLE'], [301, { location: 'https://attacker.invalid' }, 'PROVIDER_RESPONSE_INVALID']] as const) {
      const mock = transport([() => new Response('fixture-installation-secret', { status, headers })])
      const result = await reconcileGithubIssue(options({ transport: mock.fetch }))
      expect(result).toMatchObject({ decision: 'unresolved', reasons: [reason], requestsUsed: 1 }); expect(JSON.stringify(result)).not.toContain('fixture-installation-secret')
    }
    const limited = transport([() => json(repositories(), { 'x-ratelimit-remaining': '0' })])
    expect((await reconcileGithubIssue(options({ transport: limited.fetch }))).reasons).toEqual(['PROVIDER_RATE_LIMITED']); expect(limited.calls).toBe(1)
  })
  it('rejects malformed, ambiguous, oversized and invalid authoritative data', async () => {
    for (const body of ['{"total_count":0,"total_count":1,"repositories":[]}', '{"secret":"fixture-installation-secret"}', 'x'.repeat(500)]) {
      const result = await reconcileGithubIssue(options({ maxBodyBytes: 400, transport: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) }))
      expect(result).toMatchObject({ decision: 'unresolved', reasons: ['PROVIDER_RESPONSE_INVALID'] }); expect(JSON.stringify(result)).not.toContain('fixture-installation-secret')
    }
    for (const patch of [{ labels: ['automate'] }, { user: null }, { updated_at: 'yesterday' }, { body: 'x'.repeat(16385) }, { labels: [{ id: 3, name: 'automate' }, { id: 3, name: 'other' }] }]) {
      const mock = transport([() => json(repositories()), () => json({ ...current(), ...patch })])
      expect((await reconcileGithubIssue(options({ transport: mock.fetch }))).reasons).toEqual(['PROVIDER_RESPONSE_INVALID'])
    }
    expect((await reconcileGithubIssue(options({ redactText: () => { throw new Error('fixture-installation-secret') } }))).diagnosticCode).toBe('REDACTION_FAILED')
    const unicode = await reconcileGithubIssue(options({ redactText: () => 'a'.repeat(1023) + '😀' }))
    expect(unicode.decision === 'trusted' && unicode.issue.title.isWellFormed()).toBe(true)
  })
  it('aborts stalled transport and stalled response bodies with bounded deadlines', async () => {
    const pending: typeof fetch = async () => new Promise(() => {})
    expect((await reconcileGithubIssue(options({ transport: pending, requestTimeoutMs: 10 }))).diagnosticCode).toBe('REQUEST_TIMEOUT')
    let cancelled = false
    expect((await reconcileGithubIssue(options({ transport: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } }), requestTimeoutMs: 10 }))).diagnosticCode).toBe('REQUEST_TIMEOUT')
    expect(cancelled).toBe(true)
    const controller = new AbortController()
    const promise = reconcileGithubIssue(options({ transport: pending, signal: controller.signal }))
    controller.abort()
    expect((await promise).reasons).toEqual(['PROVIDER_UNAVAILABLE'])
  })
  it('uses real fetch against an explicit loopback fixture with installation auth and GET only', async () => {
    const seen: string[] = [], reservations: number[] = []
    const server = createServer((request, response) => {
      seen.push(request.url ?? '')
      expect(reservations).toHaveLength(seen.length)
      expect(request.method).toBe('GET'); expect(request.headers.authorization).toBe('Bearer fixture-installation-secret'); expect(request.headers['x-github-api-version']).toBe('2026-03-10')
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(request.url?.startsWith('/installation/') ? repositories() : current()))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture')
      const result = await reconcileGithubIssue(options({ transport: undefined, beforeRequest: async () => { reservations.push(reservations.length + 1) }, registration: { ...registration, apiBaseUrl: `http://127.0.0.1:${address.port}`, fixtureLoopback: true } }))
      expect(result.decision).toBe('trusted'); expect(seen).toHaveLength(2)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})

it('awaits normalized cooldown persistence for rate errors with exact retry/reset deadlines', async () => {
  const reset = String(Date.parse('2026-09-06T12:07:00Z') / 1000)
  for (const [status, headers, until] of [
    [429, { 'retry-after': '5' }, '2026-09-06T12:01:05.000Z'],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, '2026-09-06T12:07:00.000Z'],
    [429, { 'retry-after': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, '2026-09-06T12:07:00.000Z'],
    [429, { 'retry-after': '864000' }, '2026-09-16T12:01:00.000Z'],
    [429, { 'retry-after': '00000000000000864000' }, '2026-09-16T12:01:00.000Z'],
  ] as const) {
    const recorded: string[] = [], mock = transport([() => new Response('private provider error', { status, headers })])
    const result = await reconcileGithubIssue(options({ transport: mock.fetch, onRateLimit: async deadline => { await Promise.resolve(); recorded.push(deadline) } }))
    expect(result).toMatchObject({ diagnosticCode: 'RATE_LIMITED', requestsUsed: 1 })
    expect(recorded).toEqual([until]); expect(mock.calls).toBe(1)
    expect(JSON.stringify(result)).not.toContain('private provider error')
  }
})
it('uses a fixed one-minute fallback for absent, malformed, past and unrepresentable deadlines', async () => {
  for (const headers of [{}, { 'retry-after': '-1' }, { 'retry-after': '1e9' }, { 'retry-after': '9007199254740991' },
    { 'retry-after': 'Infinity' }, { 'retry-after': 'private-provider-string' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999999999' }]) {
    const recorded: string[] = []
    const result = await reconcileGithubIssue(options({ transport: async () => new Response('', { status: 429, headers }), onRateLimit: until => { recorded.push(until) } }))
    expect(result.diagnosticCode).toBe('RATE_LIMITED'); expect(recorded).toEqual(['2026-09-06T12:02:00.000Z'])
  }
})
it('records exhausted-success cooldown before any next GET and also on the final successful response', async () => {
  const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-09-06T12:07:00Z') / 1000) }
  const first = transport([() => json(repositories(), headers)]), recorded: string[] = []
  expect((await reconcileGithubIssue(options({ transport: first.fetch, onRateLimit: until => { recorded.push(until) } }))).diagnosticCode).toBe('RATE_LIMITED')
  expect(first.calls).toBe(1); expect(recorded).toEqual(['2026-09-06T12:07:00.000Z'])
  const last = transport([() => json(repositories()), () => json(current(), headers)])
  expect((await reconcileGithubIssue(options({ transport: last.fetch, onRateLimit: until => { recorded.push(until) } }))).decision).toBe('trusted')
  expect(last.calls).toBe(2); expect(recorded).toHaveLength(2)
})
it('halts requests when reservation or cooldown hooks fail or exceed the request deadline', async () => {
  for (const hook of [async () => { throw new Error('private storage error') }, async () => new Promise<void>(() => {})]) {
    const before = transport([])
    const result = await reconcileGithubIssue(options({ transport: before.fetch, beforeRequest: hook, requestTimeoutMs: 10 }))
    expect(result.decision).toBe('unresolved'); expect(before.calls).toBe(0); expect(JSON.stringify(result)).not.toContain('private storage error')
    for (const response of [() => new Response('', { status: 429 }), () => json(repositories(), { 'x-ratelimit-remaining': '0' })]) {
      const after = transport([response])
      const limited = await reconcileGithubIssue(options({ transport: after.fetch, onRateLimit: hook, requestTimeoutMs: 10 }))
      expect(limited.decision).toBe('unresolved'); expect(after.calls).toBe(1)
      expect(JSON.stringify(limited)).not.toContain('private storage error')
    }
  }
})
