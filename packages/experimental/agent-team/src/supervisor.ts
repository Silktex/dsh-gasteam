/** Opt-in background patrol using child-session progress as a worker heartbeat. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { TeamError, errorMessage } from './error.ts'
import type {} from './index.ts'

export const name = 'agent-team-supervisor'
export const inject = ['agentTeams', 'agents']

/** Supervisor scheduling and recovery instruction. */
export interface Config {
  /** Interval between non-overlapping patrols. */
  readonly scanIntervalMs: number
  /** Unchanged child-session interval before an owned task needs recovery. */
  readonly staleAfterMs: number
  /** Durable instruction delivered when an unchanged worker is restarted. */
  readonly recoveryMessage: string
}

export const Config: z<Config> = z.object({
  scanIntervalMs: z.number().step(1).min(1).default(1_000),
  staleAfterMs: z.number().step(1).min(1).default(60_000),
  recoveryMessage: z.string().default('Supervisor recovery: continue your unfinished shared tasks. Inspect current files and task revisions before writing; preserve completed work and report verification.'),
})

interface Observation {
  readonly eventCount: number
  readonly since: number
  readonly exhausted: boolean
}

/**
 * Mount a bounded patrol whose progress observations reset on plugin activation.
 * @param ctx - Team service and exact live Agents.
 * @param config - polling interval, inactivity threshold, and recovery instruction.
 */
export function apply(ctx: Context, config: Config): void {
  if (![config.scanIntervalMs, config.staleAfterMs].every(value => Number.isSafeInteger(value) && value > 0)
    || config.recoveryMessage.trim() === '') throw new TeamError('invalid Team supervisor configuration', 'TEAM_INVALID_CONFIG')
  ctx.effect(() => {
    const controller = new AbortController()
    const observations = new Map<SessionId, Observation>()
    let running: Promise<void> | undefined
    const patrol = async (): Promise<void> => {
      const seen = new Set<SessionId>()
      for (const lead of ctx.agents.list()) {
        if (ctx.agentTeams.tryMembership(lead)?.role !== 'lead') continue
        const tasks = ctx.agentTeams.listTasks(lead)
        for (const member of ctx.agentTeams.listMembers(lead)) {
          controller.signal.throwIfAborted()
          if (member.role !== 'teammate' || member.status === 'failed' || member.status === 'provisioning'
            || member.worktree?.phase === 'released'
            || !tasks.some(task => task.ownerName === member.name && task.status === 'in_progress')) continue
          seen.add(member.id)
          const eventCount = ctx.agents.get(member.id)?.session.events.length ?? -1
          const observation = observations.get(member.id)
          const now = Date.now()
          if (observation === undefined || observation.eventCount !== eventCount) {
            observations.set(member.id, { eventCount, since: now, exhausted: false })
            continue
          }
          if (observation.exhausted || now - observation.since < config.staleAfterMs) continue
          let exhausted = false
          try {
            await ctx.agentTeams.recoverTeammate(lead, {
              target: member.name, observedEventCount: eventCount, reason: config.recoveryMessage,
            }, controller.signal)
          } catch (error: unknown) {
            if (controller.signal.aborted) return
            exhausted = error instanceof TeamError && error.code === 'TEAM_RECOVERY_LIMIT'
            if (!(error instanceof TeamError) || !['TEAM_RECOVERY_STALE', 'TEAM_RECOVERY_NOT_NEEDED'].includes(error.code)) {
              ctx.logger.warn(`Team supervisor for "${member.name}": ${errorMessage(error)}`)
            }
          }
          observations.set(member.id, { eventCount, since: Date.now(), exhausted })
        }
      }
      for (const id of observations.keys()) if (!seen.has(id)) observations.delete(id)
    }
    const timer = setInterval(() => {
      if (running !== undefined) return
      running = patrol().catch((error: unknown) => {
        if (!controller.signal.aborted) ctx.logger.warn(`Team supervisor patrol failed: ${errorMessage(error)}`)
      }).finally(() => { running = undefined })
    }, config.scanIntervalMs)
    return async () => {
      clearInterval(timer)
      controller.abort(new TeamError('Team supervisor disposed', 'TEAM_DISPOSED'))
      await running
    }
  }, 'agentTeams.supervisor()')
}
