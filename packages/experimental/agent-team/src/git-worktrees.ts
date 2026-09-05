/** Optional Git worktree provider for isolated Team worker checkouts. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GitWorktreeProvider } from './git-worktree-provider.ts'
import type { GitWorktreeConfig } from './git-worktree-provider.ts'
import type {} from './index.ts'

export const name = 'agent-team-git-worktrees'
export const inject = ['agentTeams']

/** Git-worktree deployment configuration. */
export type Config = GitWorktreeConfig

export const Config: z<Config> = z.object({
  providerName: z.string().default('git'),
  directory: z.string().required(),
  branchPrefix: z.string().default('dsh-team'),
  commandTimeoutMs: z.number().step(1).min(1).default(30_000),
})

/**
 * Mount the configured Git worktree provider.
 * @param ctx - context with the Team service.
 * @param config - validated Git deployment choices.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.agentTeams.registerWorktreeProvider(new GitWorktreeProvider(config))
}
