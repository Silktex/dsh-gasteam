/** Persisted integration validation and monotonic execution phases. */

import { isDeepStrictEqual } from 'node:util'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamBranchName, TeamCommitId, TeamIntegrationId, TeamIntegrationSnapshot, TeamIntegrationReviewReceipt } from './types.ts'

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).transform(value => brandString<TeamCommitId>(value))
const branch = z.string().min(1).transform(value => brandString<TeamBranchName>(value))
const reviewReceipt = z.object({
  integrationId: z.string().min(1).transform(value => brandString<TeamIntegrationId>(value)),
  sourceCommit: commit,
  targetCommit: commit,
  candidateCommit: commit,
  reviewGate: z.string().min(1).max(256),
  reviewId: z.string().min(1).max(256),
}).strict() as z.ZodType<TeamIntegrationReviewReceipt>

/** Strict durable integration fields; phase-dependent fields are checked during projection. */
export const integrationSchema = z.object({
  id: z.string().min(1).transform(value => brandString<TeamIntegrationId>(value)),
  memberId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  provider: z.string().min(1),
  repository: z.string().refine(isAbsolute),
  cwd: z.string().refine(isAbsolute),
  sourceBranch: branch,
  sourceCommit: commit,
  targetBranch: branch,
  verification: z.array(z.object({ command: z.string().min(1), args: z.array(z.string()) }).strict()).min(1),
  reviewGate: z.string().min(1).max(256).optional(),
  reviewReceipt: reviewReceipt.optional(),
  failureKind: z.literal('verification').optional(),
  previousCandidates: z.array(z.object({ cwd: z.string().refine(isAbsolute), targetCommit: commit, candidateCommit: commit,
    error: z.string().min(1), reviewReceipt: reviewReceipt.optional() }).strict()).max(3).optional(),
  phase: z.enum(['queued', 'running', 'verified', 'merged', 'failed']),
  targetCommit: commit.optional(),
  candidateCommit: commit.optional(),
  error: z.string().min(1).optional(),
}).strict() as z.ZodType<TeamIntegrationSnapshot>

/**
 * Validate a durable integration transition before replacing the prior snapshot.
 * @param prior - previous snapshot, absent on queue admission.
 * @param next - decoded next snapshot.
 */
export function assertIntegrationTransition(prior: TeamIntegrationSnapshot | undefined, next: TeamIntegrationSnapshot): void {
  const retry = prior?.phase === 'verified' && next.phase === 'queued'
  const approval = prior?.phase === 'verified' && next.phase === 'verified'
    && prior.reviewReceipt === undefined && next.reviewReceipt !== undefined
  const allowed = prior === undefined ? next.phase === 'queued'
    : prior.phase === 'queued' ? next.phase === 'running' || next.phase === 'failed'
      : prior.phase === 'running' ? next.phase === 'verified' || next.phase === 'failed'
        : prior.phase === 'verified' && (next.phase === 'merged' || next.phase === 'failed' || retry || approval)
  if (!allowed) throw new Error('invalid Team integration phase transition')
  if (prior !== undefined) {
    for (const key of ['id', 'memberId', 'provider', 'repository', 'sourceBranch', 'sourceCommit', 'targetBranch', 'reviewGate'] as const) {
      if (prior[key] !== next[key]) throw new Error('Team integration changed immutable inputs')
    }
    if (retry) {
      const history = prior.previousCandidates ?? []
      const expected = [...history, { cwd: prior.cwd, targetCommit: prior.targetCommit, candidateCommit: prior.candidateCommit,
        error: next.previousCandidates?.at(-1)?.error, ...(prior.reviewReceipt === undefined ? {} : { reviewReceipt: prior.reviewReceipt }) }]
      if (history.length >= 3 || !isDeepStrictEqual(next.previousCandidates, expected)
        || next.cwd !== `${history[0]?.cwd ?? prior.cwd}.retry-${history.length + 1}`) {
        throw new Error('invalid Team integration retry history')
      }
    } else if (prior.cwd !== next.cwd || !isDeepStrictEqual(prior.previousCandidates, next.previousCandidates)) {
      throw new Error('Team integration changed candidate history')
    }
    if (JSON.stringify(prior.verification) !== JSON.stringify(next.verification)
      || !retry && prior.targetCommit !== undefined && prior.targetCommit !== next.targetCommit
      || !retry && prior.candidateCommit !== undefined && prior.candidateCommit !== next.candidateCommit
      || !approval && !retry && !isDeepStrictEqual(prior.reviewReceipt, next.reviewReceipt)) {
      throw new Error('Team integration changed recorded verification inputs')
    }
  }
  if (next.failureKind !== undefined && (next.phase !== 'failed' || prior?.phase !== 'running')) throw new Error('Invalid integration failure classification')
  if (prior === undefined && next.previousCandidates !== undefined) throw new Error('new Team integration has retry history')
  if (next.reviewReceipt !== undefined && (next.reviewGate === undefined
    || next.reviewReceipt.integrationId !== next.id
    || next.reviewReceipt.sourceCommit !== next.sourceCommit
    || next.reviewReceipt.targetCommit !== next.targetCommit
    || next.reviewReceipt.candidateCommit !== next.candidateCommit
    || next.reviewReceipt.reviewGate !== next.reviewGate)) {
    throw new Error('Team integration review receipt does not bind the current candidate')
  }
  if (next.phase === 'queued' || next.phase === 'running') {
    if (next.reviewReceipt !== undefined) throw new Error('unverified Team integration has a review receipt')
  }
  if (next.phase === 'merged' && next.reviewGate !== undefined && next.reviewReceipt === undefined) {
    throw new Error('gated Team integration cannot merge without a review receipt')
  }
  if ((next.phase === 'running' || next.phase === 'verified' || next.phase === 'merged') && next.targetCommit === undefined
    || (next.phase === 'verified' || next.phase === 'merged') && next.candidateCommit === undefined
    || (next.phase === 'queued' || next.phase === 'running') && next.candidateCommit !== undefined
    || next.phase === 'queued' && next.targetCommit !== undefined
    || (next.phase === 'failed') !== (next.error !== undefined)) {
    throw new Error('Team integration phase fields are inconsistent')
  }
}
