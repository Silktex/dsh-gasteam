/** Authoritative same-repository PR reads only. No checkout, merge, diff execution,
 * or permission for fork code. The Issues reader never validates PRs implicitly.
 * https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */
import z from 'zod'
import { scannerInitiatorSchema } from './contracts/ingestion.ts'
import { commitSchema, idSchema } from './contracts/common.ts'
import { digestJson } from './json.ts'
import {
  githubIssueObservationSchema, githubCurrentIssueSchema, githubProviderIdSchema, githubRepositoryNameSchema,
  GithubProviderFailure, reconcileGithubResource,
  type GithubIssueProvenance, type GithubResourceOptions, type GithubResourceResult, type ReconciledGithubIssue,
} from './github-reconciliation.ts'

export const githubPullRequestObservationSchema = githubIssueObservationSchema.extend({
  kind: z.literal('pull_request'), baseRepositoryId: idSchema, headRepositoryId: idSchema.nullable(),
  baseCommit: commitSchema, headCommit: commitSchema, fork: z.boolean(),
})
export const githubScannedPullRequestObservationSchema = githubIssueObservationSchema.extend({ kind: z.literal('scanned_pull_request'), initiator: scannerInitiatorSchema })
export const githubPullRequestReconciliationObservationSchema = z.union([githubPullRequestObservationSchema, githubScannedPullRequestObservationSchema])
export type GithubScannedPullRequestObservation = z.output<typeof githubScannedPullRequestObservationSchema>
export type GithubPullRequestObservation = z.output<typeof githubPullRequestObservationSchema>
export interface GithubPullRequestRevision {
  repositoryId: string; repositoryName: string; sha: string; ref: string
}
export interface ReconciledGithubPullRequest extends ReconciledGithubIssue {
  kind: 'pull_request'; base: GithubPullRequestRevision; head: GithubPullRequestRevision
}
export interface GithubPullRequestProvenance extends Omit<GithubIssueProvenance, 'resource'> {
  resource: 'pull_request'; base: GithubPullRequestRevision; head: GithubPullRequestRevision
}
export type GithubPullRequestReconciliationOptions = GithubResourceOptions<GithubPullRequestObservation | GithubScannedPullRequestObservation>
export type GithubPullRequestReconciliationResult = GithubResourceResult<{ sourceRevision: string; issue: ReconciledGithubPullRequest; provenance: GithubPullRequestProvenance }>
const repository = z.object({ id: githubProviderIdSchema, full_name: githubRepositoryNameSchema })
// Refs remain inert provenance strings. Full SHAs, never provider merge_commit_sha,
// identify the actual base/head snapshots; future checkout uses host Git APIs.
const side = z.object({ sha: commitSchema, ref: z.string().min(1).max(1024), repo: repository.nullable() })
const pullRequest = githubCurrentIssueSchema.extend({ base: side, head: side, merged: z.boolean(), draft: z.boolean() })

export async function reconcileGithubPullRequest(options: GithubPullRequestReconciliationOptions): Promise<GithubPullRequestReconciliationResult> {
  return reconcileGithubResource(options, githubPullRequestReconciliationObservationSchema, async context => {
    const { pinned, observed, route, get, redact } = context
    const parsed = pullRequest.safeParse(await get(`/repos/${pinned.repositoryName.split('/').map(encodeURIComponent).join('/')}/pulls/${observed.number}`))
    if (!parsed.success) throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID')
    const current = parsed.data
    if ((observed.kind !== 'scanned_pull_request' && current.id !== observed.providerEntityId) || current.number !== observed.number) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_ID_MISMATCH')
    if (!current.head.repo) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_HEAD_MISSING')
    if (!current.base.repo || current.base.repo.id !== pinned.repositoryId || current.base.repo.full_name.toLowerCase() !== pinned.repositoryName.toLowerCase()) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_BASE_MISMATCH')
    if (current.head.repo.id !== current.base.repo.id) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_FORK')
    if (current.head.repo.full_name.toLowerCase() !== pinned.repositoryName.toLowerCase()) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_HEAD_MISMATCH')
    if (current.state !== 'open' || current.merged) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_CLOSED')
    if (!route.bindings.authorIds.includes(current.user.id)) throw new GithubProviderFailure('SOURCE_DENIED', 'AUTHOR_NOT_ALLOWED')
    if (!route.bindings.automationRules.some(rule => route.ruleIds.includes(rule.ruleId) && (!observed.initiator || rule.ruleId === observed.initiator.ruleId) && current.labels.some(label => label.name === rule.automationLabel))) throw new GithubProviderFailure('SOURCE_DENIED', 'AUTOMATION_LABEL_MISSING')
    if (new Set(current.labels.map(label => label.id)).size !== current.labels.length) throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID')
    const labels = [...current.labels].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const base: GithubPullRequestRevision = { repositoryId: current.base.repo.id, repositoryName: pinned.repositoryName, sha: current.base.sha, ref: current.base.ref }
    const head: GithubPullRequestRevision = { repositoryId: current.head.repo.id, repositoryName: pinned.repositoryName, sha: current.head.sha, ref: current.head.ref }
    const sourceRevision = digestJson({ resource: 'pull_request', repositoryId: pinned.repositoryId, providerEntityId: current.id, number: current.number,
      authorId: current.user.id, title: current.title, body: current.body, labels, state: current.state, updatedAt: current.updated_at,
      merged: current.merged, draft: current.draft, base, head })
    const sanitizedBase = { ...base, ref: redact(base.ref, 1024) }, sanitizedHead = { ...head, ref: redact(head.ref, 1024) }
    const issue: ReconciledGithubPullRequest = { kind: 'pull_request', id: current.id, number: current.number, repositoryName: pinned.repositoryName, authorId: current.user.id, actorId: observed.actorId,
      title: redact(current.title, 1024), context: redact(current.body ?? '', 16384), labels: labels.map(label => redact(label.name, 128)), updatedAt: current.updated_at,
      sourceUrl: `https://github.com/${pinned.repositoryName}/pull/${current.number}`, base: sanitizedBase, head: sanitizedHead }
    const provenance: GithubPullRequestProvenance = { ...context.provenance('pull_request', sourceRevision), providerEntityId: current.id, sourceEntityId: `pr:${pinned.repositoryId}:${current.id}`, base: sanitizedBase, head: sanitizedHead }
    return { sourceRevision, issue, provenance }
  }, (observed, pinned) => {
    if (observed.kind === 'scanned_pull_request') return
    // A known initial fork stays denied even if a later response claims same-repo.
    if (observed.headRepositoryId === null) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_HEAD_MISSING')
    if (observed.fork || observed.headRepositoryId !== observed.baseRepositoryId) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_FORK')
    if (observed.baseRepositoryId !== pinned.repositoryId) throw new GithubProviderFailure('SOURCE_DENIED', 'PULL_REQUEST_BASE_MISMATCH')
  })
}
