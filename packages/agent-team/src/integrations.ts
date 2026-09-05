/** Durable integration admission and serialized verification with recoverable promotion. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamJournal } from './journal.ts'
import type { TeamMembership } from './roster.ts'
import { TeamError, errorMessage } from './error.ts'
import { TeamId } from './types.ts'
import type { TeamIntegrationId, TeamIntegrationProvider, TeamIntegrationSnapshot } from './types.ts'

/** Owns queue admission and one integration runner per Team. */
export class TeamIntegrations {
  private readonly providers = new Map<string, TeamIntegrationProvider>()
  private readonly running = new Set<SessionId>()

  /**
   * @param ctx - exact live Agent registry.
   * @param journal - authoritative Team transactions.
   * @param providerName - configured integration implementation.
   * @param maxPending - maximum unfinished requests.
   */
  constructor(private readonly ctx: Context, private readonly journal: TeamJournal,
    private readonly providerName: string | undefined, private readonly maxPending: number) {}

  /**
   * Register a provider for the mounting plugin lifetime.
   * @param provider - integration implementation.
   * @returns removal of this registration.
   */
  register(provider: TeamIntegrationProvider): () => void {
    if (this.providers.has(provider.name)) throw new TeamError('duplicate Team integration provider', 'TEAM_DUPLICATE_PROVIDER')
    this.providers.set(provider.name, provider)
    return () => { this.providers.delete(provider.name) }
  }

  /**
   * Pin a quiescent worker's committed output into the queue.
   * @param membership - exact Lead authority.
   * @param target - durable worker name.
   * @param signal - admission cancellation.
   * @returns durably queued integration inputs.
   */
  async enqueue(membership: TeamMembership, target: string, signal: AbortSignal): Promise<TeamIntegrationSnapshot> {
    this.assertLead(membership)
    return await this.journal.transact(membership.root.id, async () => {
      signal.throwIfAborted()
      const state = this.journal.state(membership.root)
      const member = state.members.find(candidate => candidate.name === target && candidate.phase === 'active')
      const worktree = state.worktrees.find(candidate => candidate.memberId === member?.id && candidate.phase === 'ready')
      if (member === undefined || worktree === undefined) throw new TeamError('integration requires a ready worker worktree', 'TEAM_WORKTREE_UNAVAILABLE')
      if (this.ctx.agents.get(member.id) !== undefined
        || state.tasks.some(task => task.ownerId === member.id && task.status === 'in_progress')
        || state.messages.some(message => message.targetId === member.id && !state.delivered.includes(message.id))) {
        throw new TeamError('integration worker has live work or pending messages', 'TEAM_WORKTREE_BUSY')
      }
      if (state.integrations.filter(job => job.phase !== 'merged' && job.phase !== 'failed').length >= this.maxPending) {
        throw new TeamError('Team integration queue limit reached', 'TEAM_INTEGRATION_LIMIT')
      }
      const provider = this.provider(this.providerName)
      const id = randomUUID() as TeamIntegrationId
      const spec = await provider.resolve(worktree, id, signal)
      const job: TeamIntegrationSnapshot = { ...spec, id, memberId: member.id, provider: provider.name, phase: 'queued' }
      await this.journal.appendAndFlush(membership.root, 'team/integration', { version: 1, teamId: membership.id, integration: job })
      return structuredClone(job)
    })
  }

  /**
   * Read all integration records, including failures and completed promotions.
   * @param membership - exact Team member.
   * @returns detached integration history.
   */
  list(membership: TeamMembership): TeamIntegrationSnapshot[] {
    return structuredClone(this.journal.state(membership.root).integrations)
  }

  /**
   * Execute the oldest unfinished request or recover its durable promotion phase.
   * @param membership - exact Lead authority.
   * @param signal - execution cancellation.
   * @returns the resulting record, or undefined for an empty queue.
   */
  async run(membership: TeamMembership, signal: AbortSignal): Promise<TeamIntegrationSnapshot | undefined> {
    this.assertLead(membership)
    const { root } = membership
    if (this.running.has(root.id)) throw new TeamError('Team integration runner is busy', 'TEAM_INTEGRATION_BUSY')
    this.running.add(root.id)
    try {
      let job = this.list(membership).find(candidate => candidate.phase !== 'merged' && candidate.phase !== 'failed')
      if (job === undefined) return undefined
      const provider = this.provider(job.provider)
      if (job.phase === 'running') {
        return await this.record(membership, { ...job, phase: 'failed', error: 'Verification was interrupted; candidate checkout is retained. Enqueue a new request.' })
      }
      if (job.phase === 'queued') {
        try {
          const targetCommit = await provider.target(job, signal)
          job = await this.record(membership, { ...job, phase: 'running', targetCommit })
          const candidateCommit = await provider.verify(job, targetCommit, signal)
          job = await this.record(membership, { ...job, phase: 'verified', candidateCommit })
        } catch (error: unknown) {
          // A failed flush may already have appended a verified record. Its candidate must remain recoverable.
          const jobId = job.id
          const durable = this.list(membership).find(candidate => candidate.id === jobId)
          if (durable === undefined) throw new Error('queued integration disappeared from its Lead log')
          if (durable.phase === 'verified') throw error
          return await this.record(membership, { ...durable, phase: 'failed', error: errorMessage(error) })
        }
      }
      if (job.phase !== 'verified' || job.targetCommit === undefined || job.candidateCommit === undefined) {
        throw new TeamError('integration has no verified candidate', 'TEAM_INTEGRATION_CONFLICT')
      }
      // A prior failed flush can leave a verified event visible only in memory.
      await this.ctx.sessions.flush(root.session)
      await provider.promote(job, job.targetCommit, job.candidateCommit, signal)
      return await this.record(membership, { ...job, phase: 'merged' })
    } finally {
      this.running.delete(root.id)
    }
  }

  /**
   * Stop retrying an unfinished request while retaining its candidate checkout.
   * @param membership - exact Lead authority.
   * @param id - current integration identity.
   * @param reason - durable explanation for abandoning the request.
   * @returns failed terminal record.
   */
  async abandon(membership: TeamMembership, id: TeamIntegrationId, reason: string): Promise<TeamIntegrationSnapshot> {
    this.assertLead(membership)
    if (this.running.has(membership.root.id)) throw new TeamError('Team integration runner is busy', 'TEAM_INTEGRATION_BUSY')
    this.running.add(membership.root.id)
    try {
      if (reason.trim() === '') throw new TeamError('integration abandonment requires a reason', 'TEAM_INVALID_ARGUMENT')
      const job = this.list(membership).find(candidate => candidate.id === id)
      if (job === undefined || job.phase === 'merged' || job.phase === 'failed') {
        throw new TeamError('integration request is absent or terminal', 'TEAM_INTEGRATION_CONFLICT')
      }
      return await this.record(membership, { ...job, phase: 'failed', error: reason.trim() })
    } finally {
      this.running.delete(membership.root.id)
    }
  }

  private assertLead(membership: TeamMembership): void {
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can integrate work', 'TEAM_LEAD_REQUIRED')
  }

  private provider(name: string | undefined): TeamIntegrationProvider {
    const provider = name === undefined ? undefined : this.providers.get(name)
    if (provider === undefined) throw new TeamError('configured Team integration provider is not registered', 'TEAM_INTEGRATION_UNAVAILABLE')
    return provider
  }

  private async record(membership: TeamMembership, integration: TeamIntegrationSnapshot): Promise<TeamIntegrationSnapshot> {
    await this.journal.transact(membership.root.id, async () => {
      await this.journal.appendAndFlush(membership.root, 'team/integration', {
        version: 1, teamId: TeamId(membership.root.id), integration,
      })
    })
    return structuredClone(integration)
  }
}
