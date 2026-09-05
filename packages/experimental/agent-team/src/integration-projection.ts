/** Persisted integration validation and monotonic execution phases. */

import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamBranchName, TeamCommitId, TeamIntegrationId, TeamIntegrationSnapshot } from './types.ts'

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).transform(value => brandString<TeamCommitId>(value))
const branch = z.string().min(1).transform(value => brandString<TeamBranchName>(value))

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
  const allowed = prior === undefined ? next.phase === 'queued'
    : prior.phase === 'queued' ? next.phase === 'running' || next.phase === 'failed'
      : prior.phase === 'running' ? next.phase === 'verified' || next.phase === 'failed'
        : prior.phase === 'verified' && (next.phase === 'merged' || next.phase === 'failed')
  if (!allowed) throw new Error('invalid Team integration phase transition')
  if (prior !== undefined) {
    for (const key of ['id', 'memberId', 'provider', 'repository', 'cwd', 'sourceBranch', 'sourceCommit', 'targetBranch'] as const) {
      if (prior[key] !== next[key]) throw new Error('Team integration changed immutable inputs')
    }
    if (JSON.stringify(prior.verification) !== JSON.stringify(next.verification)
      || prior.targetCommit !== undefined && prior.targetCommit !== next.targetCommit
      || prior.candidateCommit !== undefined && prior.candidateCommit !== next.candidateCommit) {
      throw new Error('Team integration changed recorded verification inputs')
    }
  }
  if ((next.phase === 'running' || next.phase === 'verified' || next.phase === 'merged') && next.targetCommit === undefined
    || (next.phase === 'verified' || next.phase === 'merged') && next.candidateCommit === undefined
    || (next.phase === 'queued' || next.phase === 'running') && next.candidateCommit !== undefined
    || next.phase === 'queued' && next.targetCommit !== undefined
    || (next.phase === 'failed') !== (next.error !== undefined)) {
    throw new Error('Team integration phase fields are inconsistent')
  }
}
