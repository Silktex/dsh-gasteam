/** Bounded discovery only: an issues-list page never attests actor authority or
 * work eligibility. GitHub lists PRs here with an ISSUE id, not the PR id; callers
 * must fetch /pulls/{number} before constructing actual PR reconciliation input.
 * Mutable updated-sorted pagination is not a snapshot or watermark proof.
 * https://docs.github.com/en/rest/issues/issues#list-repository-issues
 */
import z from 'zod'
import { idSchema, timestampSchema } from './contracts/common.ts'
import { digestJson } from './json.ts'
import { githubProviderIdSchema, GithubProviderFailure, readGithubRegisteredResource,
  type GithubIssueReconciliationOptions, type GithubResourceResult } from './github-reconciliation.ts'

export const githubScanPageRequestSchema = z.strictObject({ since: timestampSchema, cutoff: timestampSchema, page: z.number().int().min(1).max(10000) })
export const githubScanEntrySchema = z.strictObject({
  kind: z.enum(['issue', 'pull_request']), sourceEntityId: idSchema, providerEntityId: idSchema,
  repositoryId: idSchema, installationId: idSchema, number: z.number().int().positive().safe(), updatedAt: timestampSchema,
})
export type GithubScanEntry = z.output<typeof githubScanEntrySchema>
export type GithubScanPageOptions = Omit<GithubIssueReconciliationOptions, 'observed'> & z.input<typeof githubScanPageRequestSchema>
export type GithubScanPageResult = GithubResourceResult<{ entries: GithubScanEntry[]; responseDigest: string; hasMore: boolean }>
const pageSchema = z.array(z.object({ id: githubProviderIdSchema, number: z.number().int().positive().safe(), updated_at: timestampSchema,
  pull_request: z.object({}).optional(),
})).max(100)

export async function readGithubScanPage(options: GithubScanPageOptions): Promise<GithubScanPageResult> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString()
  const request = githubScanPageRequestSchema.safeParse({ since: options.since, cutoff: options.cutoff, page: options.page })
  if (!request.success || Date.parse(request.data.since) > Date.parse(request.data.cutoff) || Date.parse(request.data.cutoff) > Date.parse(checkedAt)) return {
    decision: 'denied', reasons: ['SOURCE_DENIED'], diagnosticCode: 'CONFIGURATION_INVALID', checkedAt, requestsUsed: 0,
  }
  return readGithubRegisteredResource(options, async ({ pinned, get }) => {
    const query = new URLSearchParams({ state: 'all', sort: 'updated', direction: 'asc', since: request.data.since, per_page: '100', page: String(request.data.page) })
    const raw = await get(`/repos/${pinned.repositoryName.split('/').map(encodeURIComponent).join('/')}/issues?${query}`)
    const parsed = pageSchema.safeParse(raw)
    if (!parsed.success || new Set(parsed.data.map(value => value.id)).size !== parsed.data.length || new Set(parsed.data.map(value => value.number)).size !== parsed.data.length) throw new GithubProviderFailure('PROVIDER_RESPONSE_INVALID', 'RESPONSE_INVALID')
    const entries = parsed.data.map(value => {
      const kind = value.pull_request === undefined ? 'issue' : 'pull_request'
      return githubScanEntrySchema.parse({ kind,
        sourceEntityId: kind === 'issue' ? `issue:${pinned.repositoryId}:${value.id}` : `pr-number:${pinned.repositoryId}:${value.number}`,
        // For PR list rows this is the list ISSUE id, exclusively discovery evidence.
        providerEntityId: value.id, repositoryId: pinned.repositoryId, installationId: pinned.installationId, number: value.number, updatedAt: value.updated_at,
      })
    })
    // Do not discard entries beyond cutoff or stop when one crosses it. Updated
    // items can move between mutable pages; preserve them for caller reconciliation.
    // A full final allowed page still reports hasMore, requiring caller truncation
    // handling rather than falsely declaring this scan complete.
    return { entries, responseDigest: digestJson(raw), hasMore: parsed.data.length === 100 }
  })
}
