import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { readGithubScanPage, type GithubScanPageOptions } from '../../src/darkfactory/github-scan-provider.ts'
import { githubReconciliationRegistrationSchema, ingressPolicyRouteSchema } from '../../src/darkfactory/config.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { enabledPolicy } from './config-fixture.ts'
const row = (id = 100, number = 7) => ({ id, number, updated_at: '2026-09-06T12:00:00Z', title: 'private-provider-title', body: 'private-provider-body', state: 'closed', labels: [], user: { id: 999 }, html_url: 'https://attacker.invalid' })
const repositories = () => ({ total_count: 1, repositories: [{ id: 42, full_name: 'Owner/Repo' }] })
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } })
function fixture(rows: unknown = [row()]) {
  const requests: string[] = [], charged: number[] = [], cooldowns: string[] = []
  const options: GithubScanPageOptions = {
    registration: githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'FIXTURE_TOKEN' }, credentialKind: 'installation-token' }),
    route: ingressPolicyRouteSchema.parse({ ...enabledPolicy().ingestion.routes[0], repositoryIds: ['42'], senderIds: ['registered-webhook-actor'], bindings: { installationIds: ['10'], authorIds: ['registered-author'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] } }),
    projectId: 'project', policyRevision: 1, secret: 'fixture-installation-token', redactText: value => value,
    now: () => new Date('2026-09-06T12:01:00Z'), since: '2026-09-06T11:00:00Z', cutoff: '2026-09-06T12:00:00Z', page: 1,
    beforeRequest: async () => { charged.push(charged.length + 1) }, onRateLimit: async until => { cooldowns.push(until) },
    transport: async (url, init) => {
      requests.push(String(url)); expect(charged).toHaveLength(requests.length)
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-installation-token')
      return String(url).includes('/installation/repositories') ? json(repositories()) : json(rows, { link: '<https://attacker.invalid>; rel="next"' })
    },
  }
  return { options, requests, charged, cooldowns }
}
it('discovers closed/unlabelled issues with host-built pagination, repository proof and one charge per GET', async () => {
  const raw = [row()], f = fixture(raw), result = await readGithubScanPage(f.options)
  expect(result.decision).toBe('trusted'); if (result.decision !== 'trusted') throw new Error('fixture')
  expect(result).toMatchObject({ entries: [{ kind: 'issue', sourceEntityId: 'issue:42:100', providerEntityId: '100', repositoryId: '42', installationId: '10', number: 7, updatedAt: '2026-09-06T12:00:00Z' }], hasMore: false, responseDigest: digestJson(raw), requestsUsed: 2 })
  expect(JSON.stringify(result)).not.toContain('private-provider'); expect(JSON.stringify(result)).not.toContain('actorId')
  expect(f.requests).toEqual(['https://api.github.com/installation/repositories?per_page=100&page=1', 'https://api.github.com/repos/owner/repo/issues?state=all&sort=updated&direction=asc&since=2026-09-06T11%3A00%3A00Z&per_page=100&page=1'])
})
it('marks PR rows as number-based discovery without misrepresenting list issue IDs as PR IDs', async () => {
  const result = await readGithubScanPage(fixture([{ ...row(), pull_request: { url: 'https://attacker.invalid/no-fetch' } }]).options)
  expect(result.decision).toBe('trusted')
  if (result.decision === 'trusted') expect(result.entries).toEqual([{ kind: 'pull_request', sourceEntityId: 'pr-number:42:7', providerEntityId: '100', repositoryId: '42', installationId: '10', number: 7, updatedAt: '2026-09-06T12:00:00Z' }])
})
it('keeps post-cutoff and reordered mutable entries and never reports a full page as complete', async () => {
  const values = Array.from({ length: 100 }, (_, index) => ({ ...row(100 + index, 1 + index), updated_at: index % 2 ? '2026-09-06T11:30:00Z' : '2026-09-06T12:00:30Z' }))
  const f = fixture(values); f.options.page = 10000
  const result = await readGithubScanPage(f.options)
  expect(result.decision).toBe('trusted'); if (result.decision === 'trusted') { expect(result.entries).toHaveLength(100); expect(result.entries[0]!.updatedAt).toBe(values[0]!.updated_at); expect(result.hasMore).toBe(true) }
  expect(f.requests[1]).toContain('page=10000')
  const empty = await readGithubScanPage(fixture([]).options)
  expect(empty.decision === 'trusted' && empty.hasMore).toBe(false)
})
it('rejects invalid page bounds and impossible scan windows before any request', async () => {
  for (const patch of [{ page: 0 }, { page: 10001 }, { page: 1.5 }, { since: 'invalid' }, { cutoff: '2026-09-06T10:00:00Z' }, { cutoff: '2026-09-06T12:02:00Z' }]) {
    const f = fixture(); Object.assign(f.options, patch)
    expect((await readGithubScanPage(f.options)).decision).toBe('denied'); expect(f.requests).toHaveLength(0)
  }
})
it('rejects wrong registration/repository proof without relying on any fabricated actor allowlist', async () => {
  const configured = fixture(); configured.options.registration.repositoryId = '99'
  expect((await readGithubScanPage(configured.options)).decision).toBe('denied'); expect(configured.requests).toHaveLength(0)
  const proof = fixture(); proof.options.transport = async () => json({ total_count: 1, repositories: [{ id: 42, full_name: 'attacker/repo' }] })
  expect((await readGithubScanPage(proof.options)).diagnosticCode).toBe('REPOSITORY_NAME_MISMATCH')
})
it('rejects oversized, duplicate, malformed or ambiguous entry identities', async () => {
  for (const rows of [Array.from({ length: 101 }, (_, index) => row(100 + index, index + 1)), [row(), row()], [row(), row(101, 7)], [{ ...row(), id: 1.2 }], [{ ...row(), number: 0 }], [{ ...row(), updated_at: 'invalid' }], [{ ...row(), pull_request: null }], {}]) {
    expect((await readGithubScanPage(fixture(rows).options)).diagnosticCode).toBe('RESPONSE_INVALID')
  }
})
it('digests original bounded page data even when only ignored narrative changes', async () => {
  const first = await readGithubScanPage(fixture().options), second = await readGithubScanPage(fixture([{ ...row(), body: 'changed private narrative' }]).options)
  if (first.decision !== 'trusted' || second.decision !== 'trusted') throw new Error('fixture')
  expect(first.entries).toEqual(second.entries); expect(first.responseDigest).not.toBe(second.responseDigest)
})
it('propagates budget hooks, rate deadlines and cancellation without a later request', async () => {
  const rate = fixture(); rate.options.transport = async () => new Response('private-provider-error', { status: 429, headers: { 'retry-after': '120' } })
  const result = await readGithubScanPage(rate.options)
  expect(result.diagnosticCode).toBe('RATE_LIMITED'); expect(rate.cooldowns).toEqual(['2026-09-06T12:03:00.000Z']); expect(JSON.stringify(result)).not.toContain('private-provider-error')
  const refused = fixture(); refused.options.beforeRequest = async () => { throw new Error('private-budget-error') }
  expect((await readGithubScanPage(refused.options)).decision).toBe('unresolved'); expect(refused.requests).toHaveLength(0)
  const stopped = fixture(), controller = new AbortController(); controller.abort(); stopped.options.signal = controller.signal
  expect((await readGithubScanPage(stopped.options)).decision).toBe('unresolved'); expect(stopped.requests).toHaveLength(0)
})
it('enforces shared body and stalled-request limits', async () => {
  const large = fixture(); large.options.maxBodyBytes = 10
  expect((await readGithubScanPage(large.options)).diagnosticCode).toBe('RESPONSE_INVALID')
  const stalled = fixture(); stalled.options.requestTimeoutMs = 10; stalled.options.transport = async () => new Promise<Response>(() => {})
  expect((await readGithubScanPage(stalled.options)).diagnosticCode).toBe('REQUEST_TIMEOUT')
})
it('uses real loopback HTTP and never follows provider pagination URLs', async () => {
  const f = fixture(), paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url!); expect(f.charged).toHaveLength(paths.length)
    expect(request.headers.authorization).toBe('Bearer fixture-installation-token')
    response.setHeader('content-type', 'application/json'); response.setHeader('link', '<https://attacker.invalid>; rel="next"')
    response.end(JSON.stringify(request.url!.startsWith('/installation/') ? repositories() : [row()]))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture')
    f.options.transport = undefined; f.options.registration = { ...f.options.registration, fixtureLoopback: true, apiBaseUrl: `http://127.0.0.1:${address.port}` }
    expect((await readGithubScanPage(f.options)).decision).toBe('trusted'); expect(paths).toHaveLength(2)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
