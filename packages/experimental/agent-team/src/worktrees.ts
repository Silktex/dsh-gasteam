/** Durable worker-worktree provisioning through registered Git providers. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import { TeamId } from './types.ts'
import type { TeamWorktreeProvider, TeamWorktreeSnapshot } from './types.ts'

/** Owns provider lookup and journaled worktree creation and release. */
export class TeamWorktrees {
  private readonly providers = new Map<string, TeamWorktreeProvider>()

  /**
   * @param ctx - context owning live Agent identities.
   * @param journal - authoritative Team transaction owner.
   * @param providerName - configured provider, or absent for a shared checkout.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly providerName: string | undefined,
  ) {}

  /**
   * Add one provider; the service scopes the returned disposer to its caller.
   * @param provider - implementation mounted by a deployment plugin.
   * @returns removal of this exact registration.
   */
  register(provider: TeamWorktreeProvider): () => void {
    if (this.providers.has(provider.name)) throw new TeamError('duplicate Team worktree provider', 'TEAM_DUPLICATE_PROVIDER')
    this.providers.set(provider.name, provider)
    return () => { this.providers.delete(provider.name) }
  }

  /**
   * Record ownership before creating a worker worktree.
   * @param root - exact Lead whose log owns the workspace.
   * @param memberId - already reserved teammate identity.
   * @param signal - creation cancellation.
   * @returns ready worktree, or undefined for shared-checkout deployments.
   */
  async prepare(root: Agent, memberId: SessionId, signal: AbortSignal): Promise<TeamWorktreeSnapshot | undefined> {
    if (this.providerName === undefined) return undefined
    const provider = this.provider(this.providerName)
    const repository = root.session.header.cwd
    if (repository === undefined) throw new TeamError('Team Lead has no workspace directory', 'TEAM_WORKTREE_UNAVAILABLE')
    const spec = await provider.resolve(repository, memberId, signal)
    signal.throwIfAborted()
    const reserved: TeamWorktreeSnapshot = { ...spec, provider: provider.name, memberId, phase: 'reserved' }
    await this.record(root, reserved)
    await provider.provision(spec, signal)
    signal.throwIfAborted()
    const ready: TeamWorktreeSnapshot = { ...reserved, phase: 'ready' }
    await this.record(root, ready)
    return ready
  }

  /**
   * Release a recorded worktree only when the provider confirms safe removal.
   * @param root - exact Lead authorizing cleanup.
   * @param memberId - workspace owner, whose child must be quiescent.
   * @param signal - cleanup cancellation independent of a failed spawn.
   */
  async release(root: Agent, memberId: SessionId, signal: AbortSignal): Promise<void> {
    await this.journal.transact(root.id, async () => {
      signal.throwIfAborted()
      const state = this.journal.state(root)
      const worktree = state.worktrees.find(candidate => candidate.memberId === memberId)
      if (worktree === undefined || worktree.phase === 'released') return
      if (this.ctx.agents.get(memberId) !== undefined
        || state.tasks.some(task => task.ownerId === memberId && task.status === 'in_progress')
        || state.messages.some(message =>
          message.targetId === memberId && !state.delivered.includes(message.id))) {
        throw new TeamError('worktree owner still has a live activation, unfinished task, or queued messages', 'TEAM_WORKTREE_BUSY')
      }
      await this.provider(worktree.provider).release(worktree, signal)
      await this.journal.appendAndFlush(root, 'team/worktree', {
        version: 1, teamId: TeamId(root.id), worktree: { ...worktree, phase: 'released' },
      })
    })
  }

  private provider(name: string): TeamWorktreeProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new TeamError(`Team worktree provider "${name}" is not registered`, 'TEAM_WORKTREE_UNAVAILABLE')
    return provider
  }

  private async record(root: Agent, worktree: TeamWorktreeSnapshot): Promise<void> {
    await this.journal.transact(root.id, async () => {
      await this.journal.appendAndFlush(root, 'team/worktree', { version: 1, teamId: TeamId(root.id), worktree })
    })
  }
}
