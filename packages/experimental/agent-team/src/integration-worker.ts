/** Opt-in background execution of each live Lead's durable integration queue. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TeamError, errorMessage } from './error.ts'
import type {} from './index.ts'

export const name = 'agent-team-integration-worker'
export const inject = ['agentTeams', 'agents']

/** Integration queue scheduling. */
export interface Config {
  /** Delay between non-overlapping queue scans. */
  readonly scanIntervalMs: number
}

export const Config: z<Config> = z.object({
  scanIntervalMs: z.number().step(1).min(1).default(1_000),
})

/**
 * Mount a queue worker whose subprocesses settle before plugin disposal.
 * @param ctx - Team service and live Lead registry.
 * @param config - validated scan interval.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isSafeInteger(config.scanIntervalMs) || config.scanIntervalMs < 1 || !ctx.agentTeams.integrationEnabled) {
    throw new TeamError('integration worker requires a configured provider and positive scan interval', 'TEAM_INVALID_CONFIG')
  }
  ctx.effect(() => {
    const controller = new AbortController()
    let running: Promise<void> | undefined
    const scan = async (): Promise<void> => {
      for (const lead of ctx.agents.list()) {
        controller.signal.throwIfAborted()
        if (ctx.agentTeams.tryMembership(lead)?.role !== 'lead') continue
        try {
          await ctx.agentTeams.runIntegration(lead, controller.signal)
        } catch (error: unknown) {
          if (!controller.signal.aborted && !(error instanceof TeamError && error.code === 'TEAM_INTEGRATION_BUSY')) {
            ctx.logger.warn(`Team integration for "${lead.id}": ${errorMessage(error)}`)
          }
        }
      }
    }
    const timer = setInterval(() => {
      if (running !== undefined) return
      running = scan().catch((error: unknown) => {
        if (!controller.signal.aborted) ctx.logger.warn(`Team integration scan failed: ${errorMessage(error)}`)
      }).finally(() => { running = undefined })
    }, config.scanIntervalMs)
    return async () => {
      clearInterval(timer)
      controller.abort(new TeamError('Team integration worker disposed', 'TEAM_DISPOSED'))
      await running
    }
  }, 'agentTeams.integrationWorker()')
}
