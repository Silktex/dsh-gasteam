/** Optional provider for verified Git integration into an explicitly configured branch. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GitIntegrationProvider } from './git-integration-provider.ts'
import type { GitIntegrationConfig } from './git-integration-provider.ts'
import type {} from './index.ts'

export const name = 'agent-team-git-integration'
export const inject = ['agentTeams']

/** Explicit target, verification commands, and execution timeouts. */
export type Config = GitIntegrationConfig

export const Config: z<Config> = z.object({
  providerName: z.string().default('git'),
  targetBranch: z.string().required(),
  verification: z.array(z.object({ command: z.string().required(), args: z.array(z.string()).required() })).min(1).required(),
  commandTimeoutMs: z.number().step(1).min(1).default(30_000),
  verificationTimeoutMs: z.number().step(1).min(1).default(300_000),
})

/**
 * Register Git integration for this plugin lifetime.
 * @param ctx - context with the Team service.
 * @param config - validated deployment inputs.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.agentTeams.registerIntegrationProvider(new GitIntegrationProvider(config))
}
