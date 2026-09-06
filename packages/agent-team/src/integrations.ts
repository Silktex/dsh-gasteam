/** Durable integration admission and serialized verification with recoverable promotion. */

import { isDeepStrictEqual } from 'node:util'
import z from 'zod'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamJournal } from './journal.ts'
import type { TeamMembership } from './roster.ts'
import { acquireIntegrationOwnership } from './integration-ownership.ts'
import { TeamError, errorMessage } from './error.ts'
import { TeamId } from './types.ts'
import type { TeamExternalIntegrationWorktree, TeamIntegrationAdmission, TeamIntegrationId, TeamIntegrationProvider, TeamIntegrationReviewReceipt, TeamIntegrationSnapshot, TeamIntegrationSpec, TeamWorktreeSnapshot } from './types.ts'

const admissionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), repository: z.string().min(1), targetBranch: z.string().min(1),
  verification: z.array(z.object({ command: z.string().min(1), args: z.array(z.string()) }).strict()).min(1),
  reviewGate: z.string().min(1).max(256).optional(),
}).strict()
const reviewReceiptSchema = z.object({
  integrationId: z.string().min(1), sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  targetCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), candidateCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  reviewGate: z.string().min(1).max(256), reviewId: z.string().min(1).max(256),
}).strict()
function matchesAdmissionInputs(spec: TeamIntegrationSpec | TeamIntegrationSnapshot, admission: TeamIntegrationAdmission): boolean {
  return spec.sourceCommit === admission.sourceCommit && spec.repository === admission.repository
    && spec.targetBranch === admission.targetBranch && isDeepStrictEqual(spec.verification, admission.verification)
}
function matchesAdmission(spec: TeamIntegrationSnapshot, admission: TeamIntegrationAdmission): boolean {
  return matchesAdmissionInputs(spec, admission) && spec.reviewGate === admission.reviewGate
}

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
    private readonly providerName: string | undefined, private readonly maxPending: number,
    private readonly authorizeReview: (membership: TeamMembership, receipt: TeamIntegrationReviewReceipt) => boolean = () => false) {}

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
  async enqueue(membership: TeamMembership, target: string, signal: AbortSignal, admission?: TeamIntegrationAdmission): Promise<TeamIntegrationSnapshot> {
    this.assertLead(membership)
    if (admission !== undefined) admissionSchema.parse(admission)
    return await this.journal.transact(membership.root.id, async () => {
      signal.throwIfAborted()
      const state = this.journal.state(membership.root)
      const member = state.members.find(candidate => candidate.name === target && candidate.phase === 'active')
      const existing = admission === undefined ? undefined : state.integrations.find(job => job.id === admission.id)
      if (existing !== undefined) {
        if (existing.memberId !== member?.id || !matchesAdmission(existing, admission!)) throw new TeamError('Integration identity has different pinned inputs', 'TEAM_INTEGRATION_CONFLICT')
        // A prior append may have succeeded before its flush failed. Re-acknowledge only after durability.
        await this.ctx.sessions.flush(membership.root.session)
        return structuredClone(existing)
      }
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
      const id = admission?.id ?? randomUUID() as TeamIntegrationId
      const spec = await provider.resolve(worktree, id, signal)
      if (admission !== undefined && !matchesAdmissionInputs(spec, admission)) throw new TeamError('Resolved worker commit or integration policy differs from the submission', 'TEAM_INTEGRATION_CONFLICT')
      const job: TeamIntegrationSnapshot = { ...spec, id, memberId: member.id, provider: provider.name, phase: 'queued',
        ...(admission?.reviewGate === undefined ? {} : { reviewGate: admission.reviewGate }) }
      await this.journal.appendAndFlush(membership.root, 'team/integration', { version: 1, teamId: membership.id, integration: job })
      return structuredClone(job)
    })
  }

  /**
   * Host-only admission for a provider-owned checkout. This deliberately does
   * not relax member lookup in `enqueue`: the external receipt is explicit,
   * immutable, and carried into the integration journal for later acceptance.
   */
  async enqueueExternal(membership: TeamMembership, external: TeamExternalIntegrationWorktree, signal: AbortSignal, admission: TeamIntegrationAdmission): Promise<TeamIntegrationSnapshot> {
    this.assertLead(membership)
    admissionSchema.parse(admission)
    if (external.repository !== admission.repository || external.runtimeId.trim() === '') throw new TeamError('External integration receipt disagrees with pinned admission', 'TEAM_INTEGRATION_CONFLICT')
    return await this.journal.transact(membership.root.id, async () => {
      signal.throwIfAborted()
      const state = this.journal.state(membership.root)
      const existing = state.integrations.find(job => job.id === admission.id)
      if (existing !== undefined) {
        if (!matchesAdmission(existing, admission) || !isDeepStrictEqual(existing.externalOwner, external)) throw new TeamError('External integration identity has different pinned inputs', 'TEAM_INTEGRATION_CONFLICT')
        await this.ctx.sessions.flush(membership.root.session)
        return structuredClone(existing)
      }
      if (state.integrations.filter(job => job.phase !== 'merged' && job.phase !== 'failed').length >= this.maxPending) throw new TeamError('Team integration queue limit reached', 'TEAM_INTEGRATION_LIMIT')
      const provider = this.provider(this.providerName)
      const id = admission.id
      const worktree: TeamWorktreeSnapshot = { memberId: external.runtimeId as SessionId, provider: 'external-provider', phase: 'ready', repository: external.repository, cwd: external.cwd, branch: external.branch, baseCommit: external.baseCommit }
      const spec = await provider.resolve(worktree, id, signal)
      if (!matchesAdmissionInputs(spec, admission)) throw new TeamError('Resolved external commit or integration policy differs from the submission', 'TEAM_INTEGRATION_CONFLICT')
      const job: TeamIntegrationSnapshot = { ...spec, id, memberId: external.runtimeId as SessionId, externalOwner: structuredClone(external), provider: provider.name, phase: 'queued', ...(admission.reviewGate === undefined ? {} : { reviewGate: admission.reviewGate }) }
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
   * Persist a host-authorized workflow review receipt for exactly one verified candidate.
   * @param membership - exact Lead authority.
   * @param receipt - external review identity and candidate binding.
   * @returns the durably authorized integration snapshot.
   */
  async approve(membership: TeamMembership, receipt: TeamIntegrationReviewReceipt): Promise<TeamIntegrationSnapshot> {
    this.assertLead(membership)
    reviewReceiptSchema.parse(receipt)
    return await this.journal.transact(membership.root.id, async () => {
      const job = this.journal.state(membership.root).integrations.find(candidate => candidate.id === receipt.integrationId)
      if (job === undefined) throw new TeamError('integration review receipt has no admitted integration', 'TEAM_INTEGRATION_CONFLICT')
      if (job.reviewReceipt !== undefined) {
        if (!isDeepStrictEqual(job.reviewReceipt, receipt)) throw new TeamError('integration already has a different review receipt', 'TEAM_INTEGRATION_CONFLICT')
        // A prior receipt append may have succeeded before its flush failed, including after promotion.
        await this.ctx.sessions.flush(membership.root.session)
        return structuredClone(job)
      }
      if (job.phase !== 'verified' || job.reviewGate === undefined || job.targetCommit === undefined || job.candidateCommit === undefined
        || job.sourceCommit !== receipt.sourceCommit || job.targetCommit !== receipt.targetCommit || job.candidateCommit !== receipt.candidateCommit
        || job.reviewGate !== receipt.reviewGate) {
        throw new TeamError('integration review receipt does not match the current verified candidate', 'TEAM_INTEGRATION_CONFLICT')
      }
      if (!this.authorizeReview(membership, structuredClone(receipt))) {
        throw new TeamError('integration review receipt was not authorized by the host', 'TEAM_INTEGRATION_REVIEW_DENIED')
      }
      const approved = { ...job, reviewReceipt: structuredClone(receipt) }
      await this.journal.appendAndFlush(membership.root, 'team/integration', {
        version: 1, teamId: TeamId(membership.root.id), integration: approved,
      })
      return structuredClone(approved)
    })
  }

  /**
   * Execute the oldest unfinished request or recover its durable promotion phase.
   * @param membership - exact Lead authority.
   * @param signal - execution cancellation.
   * @returns the resulting record, or undefined for an empty queue.
   */
  async run(membership: TeamMembership, signal: AbortSignal, id?: TeamIntegrationId): Promise<TeamIntegrationSnapshot | undefined> {
    this.assertLead(membership)
    const { root } = membership
    if (this.running.has(root.id)) throw new TeamError('Team integration runner is busy', 'TEAM_INTEGRATION_BUSY')
    this.running.add(root.id)
    let release: (() => Promise<void>) | undefined
    try {
      let job = id === undefined
        ? this.list(membership).find(candidate => candidate.phase !== 'merged' && candidate.phase !== 'failed')
        : this.list(membership).find(candidate => candidate.id === id && candidate.phase !== 'merged' && candidate.phase !== 'failed')
      if (job === undefined) return undefined
      const provider = this.provider(job.provider)
      release = await acquireIntegrationOwnership(job.repository, job.targetBranch, signal)
      if (job.phase === 'running') {
        return await this.record(membership, { ...job, phase: 'failed', error: 'Verification was interrupted; candidate checkout is retained. Enqueue a new request.' })
      }
      if (job.phase === 'queued') {
        let verifying = false
        try {
          const targetCommit = await provider.target(job, signal)
          job = await this.record(membership, { ...job, phase: 'running', targetCommit })
          verifying = true
          const candidateCommit = await provider.verify(job, targetCommit, signal)
          job = await this.record(membership, { ...job, phase: 'verified', candidateCommit })
        } catch (error: unknown) {
          // A failed flush may already have appended a verified record. Its candidate must remain recoverable.
          const jobId = job.id
          const durable = this.list(membership).find(candidate => candidate.id === jobId)
          if (durable === undefined) throw new Error('queued integration disappeared from its Lead log')
          if (durable.phase === 'verified') throw error
          return await this.record(membership, { ...durable, phase: 'failed', ...(verifying ? { failureKind: 'verification' as const } : {}), error: errorMessage(error) })
        }
      }
      if (job.phase !== 'verified' || job.targetCommit === undefined || job.candidateCommit === undefined) {
        throw new TeamError('integration has no verified candidate', 'TEAM_INTEGRATION_CONFLICT')
      }
      if (job.reviewGate !== undefined && job.reviewReceipt === undefined) return structuredClone(job)
      // A prior failed flush can leave a verified event visible only in memory.
      await this.ctx.sessions.flush(root.session)
      try {
        await provider.promote(job, job.targetCommit, job.candidateCommit, signal)
      } catch (error: unknown) {
        // Providers can be separately bundled plugins with a distinct TeamError constructor.
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'TEAM_INTEGRATION_STALE') throw error
        const history = job.previousCandidates ?? []
        if (history.length >= 3) {
          return await this.record(membership, { ...job, phase: 'failed', error: `Target movement retry limit reached: ${errorMessage(error)}. Candidate checkouts are retained.` })
        }
        const { targetCommit, candidateCommit, reviewReceipt, ...inputs } = job
        return await this.record(membership, {
          ...inputs, phase: 'queued', cwd: `${history[0]?.cwd ?? job.cwd}.retry-${history.length + 1}`,
          previousCandidates: [...history, { cwd: job.cwd, targetCommit, candidateCommit, error: errorMessage(error),
            ...(reviewReceipt === undefined ? {} : { reviewReceipt }) }],
        })
      }
      return await this.record(membership, { ...job, phase: 'merged' })
    } finally {
      try { await release?.() } finally { this.running.delete(root.id) }
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
