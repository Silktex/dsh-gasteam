import { describe, expect, it } from 'vitest'
import { githubReconciliationRegistrationSchema, ingressPolicyRouteSchema } from '../../src/darkfactory/config.ts'
import { reconcileGithubPullRequest, type GithubPullRequestReconciliationOptions } from '../../src/darkfactory/github-pr-reconciliation.ts'
import { enabledPolicy } from './config-fixture.ts'

const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40)
const repo = () => ({ id: 42, full_name: 'Owner/Repo' })
const current = () => ({ id: 100, number: 7, title: 'Repair', body: 'Provider markdown remains untrusted', user: { id: 12 }, labels: [{ id: 3, name: 'automate' }], state: 'open', updated_at: '2026-09-06T12:00:00Z', merged: false, draft: false,
  base: { repo: repo(), sha: baseSha, ref: 'main' }, head: { repo: repo(), sha: headSha, ref: 'repair' },
  html_url: 'https://attacker.invalid/not-authority', diff_url: 'https://attacker.invalid/no-fetch', merge_commit_sha: 'c'.repeat(40) })
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } })
function fixture(patch: Record<string, unknown> = {}) {
  const requests: string[] = []
  const options: GithubPullRequestReconciliationOptions = {
    registration: githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'FIXTURE_TOKEN' }, credentialKind: 'installation-token' }),
    observed: { kind: 'pull_request', repositoryId: '42', providerEntityId: '100', actorId: '12', installationId: '10', number: 7, sourceEntityId: 'pr:42:100', baseRepositoryId: '42', headRepositoryId: '42', baseCommit: baseSha, headCommit: headSha, fork: false },
    route: ingressPolicyRouteSchema.parse({ ...enabledPolicy().ingestion.routes[0], repositoryIds: ['42'], senderIds: ['12'], bindings: { installationIds: ['10'], authorIds: ['12'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] } }),
    projectId: 'project', policyRevision: 1, secret: 'fixture-installation-secret', redactText: value => value, now: () => new Date('2026-09-06T12:01:00Z'),
    transport: async (url, init) => {
      requests.push(String(url)); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-installation-secret')
      return String(url).includes('/installation/') ? json({ total_count: 1, repositories: [repo()] }) : json({ ...current(), ...patch })
    },
  }
  return { options, requests }
}

describe('authoritative same-repository GitHub PR reader', () => {
  it('fetches actual PR once after installation visibility and pins base/head SHAs, not test-merge SHA or payload URLs', async () => {
    const f = fixture(), result = await reconcileGithubPullRequest(f.options)
    expect(result.decision).toBe('trusted')
    if (result.decision !== 'trusted') throw new Error('fixture')
    expect(result.issue).toMatchObject({ kind: 'pull_request', sourceUrl: 'https://github.com/owner/repo/pull/7', base: { repositoryId: '42', repositoryName: 'owner/repo', sha: baseSha, ref: 'main' }, head: { repositoryId: '42', sha: headSha, ref: 'repair' } })
    expect(result.provenance).toMatchObject({ resource: 'pull_request', sourceRevision: result.sourceRevision, base: result.issue.base, head: result.issue.head, requestsUsed: 2 })
    expect(result.provenance.responseDigests).toHaveLength(2)
    expect(f.requests).toEqual(['https://api.github.com/installation/repositories?per_page=100&page=1', 'https://api.github.com/repos/owner/repo/pulls/7'])
  })
  it('pins current revisions when base/head or execution fields change after delivery', async () => {
    const initial = await reconcileGithubPullRequest(fixture().options)
    if (initial.decision !== 'trusted') throw new Error('fixture')
    for (const patch of [{ head: { ...current().head, sha: 'd'.repeat(40) } }, { base: { ...current().base, sha: 'e'.repeat(64) } }, { head: { ...current().head, ref: 'new-branch' } }, { body: 'changed' }, { draft: true }, { labels: [{ id: 9, name: 'automate' }] }]) {
      const changed = await reconcileGithubPullRequest(fixture(patch).options)
      expect(changed.decision).toBe('trusted')
      expect(changed.decision === 'trusted' && changed.sourceRevision).not.toBe(initial.sourceRevision)
    }
  })
  it('refuses initially observed forks or absent heads even if the current response looks same-repository', async () => {
    for (const patch of [{ fork: true }, { headRepositoryId: '99' }, { headRepositoryId: null }, { baseRepositoryId: '99', headRepositoryId: '99' }]) {
      const f = fixture(); Object.assign(f.options.observed, patch)
      expect((await reconcileGithubPullRequest(f.options)).decision).toBe('denied'); expect(f.requests).toHaveLength(0)
    }
  })
  it('denies current forks, deleted head repositories, mismatched base/head identities and closed or merged PRs', async () => {
    for (const [patch, code] of [
      [{ head: { ...current().head, repo: { id: 99, full_name: 'attacker/fork' } } }, 'PULL_REQUEST_FORK'],
      [{ head: { ...current().head, repo: null } }, 'PULL_REQUEST_HEAD_MISSING'],
      [{ base: { ...current().base, repo: null } }, 'PULL_REQUEST_BASE_MISMATCH'],
      [{ base: { ...current().base, repo: { id: 99, full_name: 'owner/repo' } } }, 'PULL_REQUEST_BASE_MISMATCH'],
      [{ base: { ...current().base, repo: { id: 42, full_name: 'attacker/repo' } } }, 'PULL_REQUEST_BASE_MISMATCH'],
      [{ head: { ...current().head, repo: { id: 42, full_name: 'attacker/repo' } } }, 'PULL_REQUEST_HEAD_MISMATCH'],
      [{ state: 'closed' }, 'PULL_REQUEST_CLOSED'], [{ merged: true }, 'PULL_REQUEST_CLOSED'], [{ id: 101 }, 'PULL_REQUEST_ID_MISMATCH'],
      [{ labels: [] }, 'AUTOMATION_LABEL_MISSING'], [{ user: { id: 99 } }, 'AUTHOR_NOT_ALLOWED'],
    ] as const) {
      const result = await reconcileGithubPullRequest(fixture(patch).options)
      expect(result).toMatchObject({ decision: 'denied', reasons: ['SOURCE_DENIED'], diagnosticCode: code, requestsUsed: 2 })
    }
    const f = fixture(); f.options.observed.actorId = '99'
    expect((await reconcileGithubPullRequest(f.options)).diagnosticCode).toBe('ACTOR_NOT_ALLOWED'); expect(f.requests).toHaveLength(0)
  })
  it('rejects malformed/ambiguous provider data and incomplete commit identities', async () => {
    for (const patch of [{ head: { ...current().head, sha: 'abcdef1' } }, { base: { ...current().base, sha: 'refs/heads/main' } }, { base: { ...current().base, ref: '' } }, { labels: ['automate'] }, { merged: 'false' }]) expect((await reconcileGithubPullRequest(fixture(patch).options)).reasons).toEqual(['PROVIDER_RESPONSE_INVALID'])
    const f = fixture(), transport = f.options.transport!
    f.options.transport = async (url, init) => String(url).includes('/pulls/') ? new Response('{"id":100,"id":101}', { headers: { 'content-type': 'application/json' } }) : transport(url, init)
    expect((await reconcileGithubPullRequest(f.options)).reasons).toEqual(['PROVIDER_RESPONSE_INVALID'])
    Object.assign(f.options.observed, { headCommit: 'short', extra: 'untrusted' })
    expect((await reconcileGithubPullRequest(f.options)).diagnosticCode).toBe('OBSERVATION_INVALID')
  })
  it('reuses the shared eleven-GET pagination ceiling without following Link or body URLs', async () => {
    const f = fixture()
    f.options.transport = async url => {
      f.requests.push(String(url))
      if (String(url).includes('/pulls/')) return json(current())
      const page = Number(new URL(String(url)).searchParams.get('page'))
      return json({ total_count: 1000, repositories: Array.from({ length: 100 }, (_, i) => page === 10 && i === 99 ? repo() : { id: 1000 + page * 100 + i, full_name: `owner/repo-${page}-${i}` }) }, { link: '<https://attacker.invalid/next>; rel="next"' })
    }
    expect(await reconcileGithubPullRequest(f.options)).toMatchObject({ decision: 'trusted', requestsUsed: 11 })
    expect(f.requests).toHaveLength(11); expect(f.requests.every(url => url.startsWith('https://api.github.com/'))).toBe(true)
    f.options.maxPages = 9
    expect(await reconcileGithubPullRequest(f.options)).toMatchObject({ decision: 'unresolved', diagnosticCode: 'PAGINATION_LIMIT', requestsUsed: 9 })
  })
  it('shares provider rate, redirect, deadline and cancellation failures with the issue reader', async () => {
    for (const [status, reason] of [[429, 'PROVIDER_RATE_LIMITED'], [302, 'PROVIDER_RESPONSE_INVALID'], [503, 'PROVIDER_UNAVAILABLE']] as const) {
      const f = fixture(), transport = f.options.transport!
      f.options.transport = async (url, init) => String(url).includes('/pulls/') ? new Response('fixture-installation-secret', { status, headers: { location: 'https://attacker.invalid/' } }) : transport(url, init)
      const result = await reconcileGithubPullRequest(f.options)
      expect(result).toMatchObject({ decision: 'unresolved', reasons: [reason] }); expect(JSON.stringify(result)).not.toContain('fixture-installation-secret')
    }
    const f = fixture(), transport = f.options.transport!
    f.options.transport = async (url, init) => String(url).includes('/pulls/') ? new Promise(() => {}) : transport(url, init)
    f.options.totalTimeoutMs = 15
    expect((await reconcileGithubPullRequest(f.options)).diagnosticCode).toBe('REQUEST_TIMEOUT')
    const controller = new AbortController(); controller.abort(); f.options.signal = controller.signal
    expect(await reconcileGithubPullRequest(f.options)).toMatchObject({ decision: 'unresolved', requestsUsed: 0 })
  })
  it('redacts bounded provider narrative and refs while keeping the original source revision', async () => {
    const patch = { body: 'fixture-installation-secret', head: { ...current().head, ref: 'fixture-installation-secret' } }
    const f = fixture(patch), result = await reconcileGithubPullRequest(f.options)
    expect(result.decision).toBe('trusted'); expect(JSON.stringify(result)).not.toContain('fixture-installation-secret')
    if (result.decision !== 'trusted') throw new Error('fixture')
    f.options.redactText = () => 'different redaction'
    const changed = await reconcileGithubPullRequest(f.options)
    expect(changed.decision === 'trusted' && changed.sourceRevision).toBe(result.sourceRevision)
  })
})
