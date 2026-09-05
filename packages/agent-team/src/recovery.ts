/** Bounded, journaled recovery of teammates that still own unfinished tasks. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamJournal } from './journal.ts'
import type { TeamRoster } from './roster.ts'
import type { TeamMailbox } from './mailbox.ts'
import { resolveActiveMember } from './roster.ts'
import { TeamError } from './error.ts'
import { TeamId } from './types.ts'
import type { RecoverTeammateRequest, TeamRecoverySnapshot } from './types.ts'

/** Owns recovery admission, lifetime attempt limits, and wakeup delivery. */
export class TeamRecovery {
  private readonly recovering = new Set<SessionId>()
  /**
   * @param ctx - live Agent registry.
   * @param journal - durable Team transactions.
   * @param roster - exact member authority and activation teardown.
   * @param mailbox - durable follow-up delivery.
   * @param maxAttempts - lifetime recovery budget per teammate.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly roster: TeamRoster,
    private readonly mailbox: TeamMailbox,
    private readonly maxAttempts: number,
  ) {}

  /**
   * Retry an unchanged stalled worker without releasing its task ownership.
   * @param caller - exact live Lead.
   * @param request - observed session progress and recovery instruction.
   * @param signal - cancellation through teardown and wakeup admission.
   * @returns the durable attempt record; failures also consume their admitted attempt.
   */
  async recover(caller: Agent, request: RecoverTeammateRequest, signal: AbortSignal): Promise<TeamRecoverySnapshot> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can recover teammates', 'TEAM_LEAD_REQUIRED')
    const root = membership.root
    const recovery = await this.journal.transact(root.id, async () => {
      signal.throwIfAborted()
      const state = this.journal.state(root)
      const target = resolveActiveMember(root, state, request.target)
      if (target.id === root.id) throw new TeamError('the Lead cannot recover itself', 'TEAM_INVALID_TARGET')
      if (!state.tasks.some(task => task.ownerId === target.id && task.status === 'in_progress')) {
        throw new TeamError('teammate has no unfinished owned task', 'TEAM_RECOVERY_NOT_NEEDED')
      }
      if (this.recovering.has(target.id)) throw new TeamError('teammate recovery is already running', 'TEAM_RECOVERY_STALE')
      const eventCount = this.ctx.agents.get(target.id)?.session.seq ?? -1
      if (eventCount !== request.observedEventCount || state.messages.some(message =>
        message.targetId === target.id && !state.delivered.includes(message.id))) {
        throw new TeamError('teammate progressed or has pending mail since observation', 'TEAM_RECOVERY_STALE')
      }
      const attempt = (state.recoveries.find(recovery => recovery.memberId === target.id)?.attempt ?? 0) + 1
      if (attempt > this.maxAttempts) throw new TeamError('teammate recovery budget exhausted', 'TEAM_RECOVERY_LIMIT')
      const recovery: TeamRecoverySnapshot = {
        memberId: target.id, attempt, observedEventCount: eventCount, reason: request.reason,
      }
      await this.journal.appendAndFlush(root, 'team/recovery', { version: 1, teamId: TeamId(root.id), recovery })
      this.recovering.add(target.id)
      return recovery
    })
    try {
      signal.throwIfAborted()
      await this.roster.stopTeammates(root, [recovery.memberId])
      signal.throwIfAborted()
      await this.mailbox.send(root, {
        target: request.target, delivery: 'wakeup', signal,
        content: [{ type: 'text', text: request.reason }],
      })
      return recovery
    } finally {
      this.recovering.delete(recovery.memberId)
    }
  }
}
