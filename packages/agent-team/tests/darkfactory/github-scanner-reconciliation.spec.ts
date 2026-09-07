import { expect, it } from 'vitest'
import { githubReconciliationRegistrationSchema, ingressPolicyRouteSchema } from '../../src/darkfactory/config.ts'
import { reconcileGithubIssue, type GithubIssueReconciliationOptions } from '../../src/darkfactory/github-reconciliation.ts'
import { reconcileGithubPullRequest, type GithubPullRequestReconciliationOptions } from '../../src/darkfactory/github-pr-reconciliation.ts'
import { enabledPolicy } from './config-fixture.ts'
const scannerId = 'host-scanner:repository', baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40)
const repository = () => ({ id: 42, full_name: 'owner/repo' })
const current = () => ({ id: 100, number: 7, title: 'Repair', body: 'Current authoritative text', user: { id: 12 }, labels: [{ id: 3, name: 'automate' }], state: 'open', updated_at: '2026-09-06T12:00:00Z' })
const pullRequest = () => ({ ...current(), id: 500, merged: false, draft: false, base: { repo: repository(), sha: baseSha, ref: 'main' }, head: { repo: repository(), sha: headSha, ref: 'repair' } })
function fixture(pr = false, patch: Record<string, unknown> = {}) {
  let calls = 0
  const registration = githubReconciliationRegistrationSchema.parse({ installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'FIXTURE_TOKEN' }, credentialKind: 'installation-token', scan: { scannerId, ruleId: 'rule', initialSince: '2026-09-06T00:00:00Z' } })
  const route = ingressPolicyRouteSchema.parse({ ...enabledPolicy().ingestion.routes[0], repositoryIds: ['42'], senderIds: ['12', scannerId], bindings: { installationIds: ['10'], authorIds: ['12'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] } })
  const shared = { registration, route, projectId: 'project', policyRevision: 1, secret: 'fixture-installation-secret', redactText: (value: string) => value, now: () => new Date('2026-09-06T12:01:00Z'),
    transport: (async (url: string | URL | Request) => { calls++; return new Response(JSON.stringify(String(url).includes('/installation/') ? { total_count: 1, repositories: [repository()] } : { ...(pr ? pullRequest() : current()), ...patch }), { headers: { 'content-type': 'application/json' } }) }) as typeof fetch }
  const observed = { repositoryId: '42', installationId: '10', providerEntityId: '100', number: 7, actorId: scannerId, sourceEntityId: 'issue:42:100', initiator: { kind: 'host-scanner' as const, scannerId, ruleId: 'rule' } }
  const issue: GithubIssueReconciliationOptions = { ...shared, observed: { ...observed, kind: 'issue' } }
  const pull: GithubPullRequestReconciliationOptions = { ...shared, observed: { ...observed, kind: 'scanned_pull_request', sourceEntityId: 'pr-number:42:7' } }
  return { issue, pull, get calls() { return calls } }
}
it('uses explicit scanner initiation with current human author and preserves source revision identity with webhook reads', async () => {
  const f = fixture(), scanned = await reconcileGithubIssue(f.issue)
  const webhook = fixture().issue; delete webhook.observed.initiator; webhook.observed.actorId = '12'
  const delivered = await reconcileGithubIssue(webhook)
  expect(scanned.decision).toBe('trusted'); expect(delivered.decision).toBe('trusted')
  if (scanned.decision !== 'trusted' || delivered.decision !== 'trusted') throw new Error('fixture')
  expect(scanned.sourceRevision).toBe(delivered.sourceRevision)
  expect(scanned.issue).toMatchObject({ authorId: '12', actorId: scannerId })
  expect(scanned.provenance).toMatchObject({ sourceEntityId: 'issue:42:100', initiator: { kind: 'host-scanner', scannerId, ruleId: 'rule' } })
  expect(delivered.provenance.initiator).toBeUndefined()
})
it.each(['missing-grant', 'wrong-scanner', 'wrong-rule', 'wrong-actor', 'sender-not-allowed'] as const)('rejects %s scanner initiation before GET', async mutation => {
  for (const pr of [false, true]) {
    const f = fixture(pr), options = pr ? f.pull : f.issue
    if (mutation === 'missing-grant') delete options.registration.scan
    if (mutation === 'wrong-scanner') options.observed.initiator!.scannerId = 'host-scanner:other'
    if (mutation === 'wrong-rule') options.observed.initiator!.ruleId = 'other-rule'
    if (mutation === 'wrong-actor') options.observed.actorId = '12'
    if (mutation === 'sender-not-allowed') options.route.senderIds = ['12']
    const result = pr ? await reconcileGithubPullRequest(f.pull) : await reconcileGithubIssue(f.issue)
    expect(result).toMatchObject({ decision: 'denied', diagnosticCode: 'ACTOR_NOT_ALLOWED', requestsUsed: 0 }); expect(f.calls).toBe(0)
  }
})
it('requires the scanner-specific automation rule rather than another valid route label', async () => {
  const f = fixture(); if (f.issue.route.source !== 'github') throw new Error('fixture')
  f.issue.route.ruleIds.push('different-rule')
  f.issue.route.bindings.automationRules.push({ ruleId: 'different-rule', automationLabel: 'automate' })
  f.issue.route.bindings.automationRules[0]!.automationLabel = 'scanner-only'
  expect((await reconcileGithubIssue(f.issue)).diagnosticCode).toBe('AUTOMATION_LABEL_MISSING')
})
it('resolves a scanned PR list issue ID to the true current PR ID and canonical source identity', async () => {
  const f = fixture(true), scanned = await reconcileGithubPullRequest(f.pull)
  expect(scanned.decision).toBe('trusted'); if (scanned.decision !== 'trusted') throw new Error('fixture')
  expect(f.pull.observed.providerEntityId).toBe('100')
  expect(scanned.issue).toMatchObject({ id: '500', authorId: '12', actorId: scannerId, base: { sha: baseSha }, head: { sha: headSha } })
  expect(scanned.provenance).toMatchObject({ providerEntityId: '500', sourceEntityId: 'pr:42:500', initiator: { kind: 'host-scanner', scannerId, ruleId: 'rule' } })
  const webhook = fixture(true).pull
  webhook.observed = { kind: 'pull_request', repositoryId: '42', installationId: '10', providerEntityId: '500', number: 7, actorId: '12', sourceEntityId: 'pr:42:500', baseRepositoryId: '42', headRepositoryId: '42', baseCommit: baseSha, headCommit: headSha, fork: false }
  const delivered = await reconcileGithubPullRequest(webhook)
  expect(delivered.decision === 'trusted' && delivered.sourceRevision).toBe(scanned.sourceRevision)
})
it.each([
  [{ head: { ...pullRequest().head, repo: { id: 99, full_name: 'other/fork' } } }, 'PULL_REQUEST_FORK'],
  [{ head: { ...pullRequest().head, repo: null } }, 'PULL_REQUEST_HEAD_MISSING'],
  [{ base: { ...pullRequest().base, repo: { id: 99, full_name: 'other/repo' } } }, 'PULL_REQUEST_BASE_MISMATCH'],
  [{ state: 'closed' }, 'PULL_REQUEST_CLOSED'], [{ merged: true }, 'PULL_REQUEST_CLOSED'],
  [{ user: { id: 99 } }, 'AUTHOR_NOT_ALLOWED'], [{ labels: [] }, 'AUTOMATION_LABEL_MISSING'],
  [{ number: 8 }, 'PULL_REQUEST_ID_MISMATCH'], [{ head: { ...pullRequest().head, sha: 'short' } }, 'RESPONSE_INVALID'],
] as const)('preserves current PR rejection %s', async (patch, diagnosticCode) => {
  expect((await reconcileGithubPullRequest(fixture(true, patch).pull)).diagnosticCode).toBe(diagnosticCode)
})
it('pins changed actual PR commits discovered after a list observation', async () => {
  const original = await reconcileGithubPullRequest(fixture(true).pull), changed = await reconcileGithubPullRequest(fixture(true, { head: { ...pullRequest().head, sha: 'c'.repeat(40) } }).pull)
  expect(original.decision).toBe('trusted'); expect(changed.decision).toBe('trusted')
  if (original.decision === 'trusted' && changed.decision === 'trusted') { expect(changed.sourceRevision).not.toBe(original.sourceRevision); expect(changed.issue.head.sha).toBe('c'.repeat(40)) }
})
it('requires an explicit initiator marker for a reserved host-scanner principal', async () => {
  const f = fixture(); delete f.issue.observed.initiator
  expect((await reconcileGithubIssue(f.issue)).diagnosticCode).toBe('ACTOR_NOT_ALLOWED')
  expect(f.calls).toBe(0)
})
