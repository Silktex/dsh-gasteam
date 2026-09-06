/** Trusted bridge between durable attempts and exact-parent in-process Team operations. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AssignmentStore, AttemptToken, AttemptRecord } from './assignments.ts'
import { latestTurnEnd } from './turn-evidence.ts'
import { RuntimeDrain } from './runtime-drain.ts'
import { nextAssignmentRetryAt } from './assignment-retry-policy.ts'
import { TeamTaskId } from './types.ts'
import type {} from './index.ts'

const tokenOf = (record: AttemptRecord): AttemptToken => ({
  attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision,
})

/** Host-only adapter; the coordinator owns project grants, task scheduling, and adapter lifetime. */
export class DshAssignmentRuntime {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly drains: RuntimeDrain
  constructor(private readonly ctx: Context, private readonly assignments: AssignmentStore, drainTimeoutMs = 30_000, private readonly recoverInterrupted = false, drains?: RuntimeDrain, private readonly clock: () => number = Date.now) {
    this.drains = drains ?? new RuntimeDrain(drainTimeoutMs)
  }

  /** Host shutdown shares pending drain handles with cancellation/reconciliation. */
  async drain(lead: Agent, runtimeIds: readonly string[]): Promise<void> {
    for (const runtimeId of runtimeIds) {
      await this.drains.wait(`${lead.id}:${runtimeId}`, () => this.ctx.subagents.drainContinuableChildren(lead, [SessionId(runtimeId)]))
    }
  }

  start(lead: Agent, token: AttemptToken): Promise<AttemptRecord> {
    return this.serialize(async () => {
      const record = this.resolve(lead, token)
      if (record.phase === 'active') return record
      if (record.phase !== 'reserved') throw new Error('A stale or terminal attempt cannot start a runtime')
      if (!['spawn', 'fork'].includes(record.provider)) throw new Error('DSH assignment provider must support spawn or fork')
      const existing = this.ctx.agentTeams.listMembers(lead).find(member => member.id === record.runtimeId)
      if (existing !== undefined) {
        // Reconcile a child created before the assignment activation edge; never create another child.
        const stored = await this.ctx.sessionPersistence.inspect(SessionId(record.runtimeId))
        if (stored.meta.parentSession !== lead.id || existing.status === 'failed') throw new Error('Reserved child requires explicit provisioning repair')
        if (!stored.events.some(event => event.type === 'user/message'
          && event.data.content.some(block => block.type === 'text' && block.text === this.prompt(record)))) {
          throw new Error('Reserved runtime does not contain this assignment checkpoint')
        }
        return this.assignments.activate(tokenOf(record))
      }
      try {
        await this.ctx.agentTeams.spawnReservedTeammate(lead, {
          name: record.attemptId, description: record.checkpoint.task.subject.slice(0, 200),
          prompt: [{ type: 'text', text: this.prompt(record) }], context: record.provider === 'fork' ? 'fork' : 'fresh',
          provider: record.provider, signal: new AbortController().signal,
        }, record.runtimeId)
        return await this.assignments.activate(tokenOf(record))
      } catch (error) {
        const diagnostic = `DSH admission failed: ${error instanceof Error ? error.message : String(error)}`
        const retryable = this.retryability(diagnostic)
        if (retryable === undefined) throw new Error(`Provisioning ownership is uncertain; preserve the reservation: ${diagnostic}`)
        await this.drain(lead, [record.runtimeId])
        if (this.ctx.agents.get(SessionId(record.runtimeId)) !== undefined) throw new Error('Provisioning ownership is uncertain; preserve the reservation')
        // A rejected spawn may still have created then drained a child. The
        // drain proves quiescence, not that the provider never started it.
        const priorFailures = this.assignments.list().filter(candidate => candidate.projectId === record.projectId
          && candidate.teamId === record.teamId && candidate.taskId === record.taskId && candidate.provisioning !== undefined).length
        await this.assignments.provisionFailed(tokenOf(record), { runtimeId: record.runtimeId, kind: 'stopped', receipt: `dsh/provision-drained:${lead.id}:${record.runtimeId}` }, diagnostic,
          nextAssignmentRetryAt(record.retryPolicy, priorFailures, this.clock()), retryable)
        throw error
      }
    })
  }

  observe(lead: Agent, token: AttemptToken): Promise<AttemptRecord> {
    return this.serialize(async () => {
      let record = this.resolve(lead, token)
      if (record.phase === 'terminal') return record
      if (record.phase === 'stopping') return this.retireAfterDrain(lead, record)
      if (this.ctx.agents.get(SessionId(record.runtimeId)) !== undefined || record.phase === 'reserved') return record
      const stored = await this.ctx.sessionPersistence.inspect(SessionId(record.runtimeId))
      if (stored.meta.parentSession !== lead.id) throw new Error('Runtime parent does not match assignment authority')
      const end = latestTurnEnd(stored.events)
      if (end?.type === 'turn/end' && end.data.reason.kind === 'completed') {
        const answer = stored.events.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn)
        const result = answer?.type === 'assistant/message'
          ? answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim() : ''
        if (result !== '') record = await this.assignments.report(tokenOf(record), result)
        else record = await this.assignments.stop(tokenOf(record), 'DSH worker ended without a textual report; inspect its persisted artifacts')
      } else {
        if (this.recoverInterrupted) {
          const member = this.ctx.agentTeams.listMembers(lead).find(member => member.id === record.runtimeId)
          if (member?.name !== record.attemptId) throw new Error('Interrupted runtime ownership is uncertain')
          const observedSequence = stored.events.filter(event => event.type !== 'session/end-seed').at(-1)?.seq ?? 0
          if (record.recovery?.observedSequence !== observedSequence) {
            if ((record.recovery?.count ?? 0) >= record.retryPolicy.maxAttempts) {
              const stopping = await this.assignments.stop(tokenOf(record), 'DSH interrupted-worker recovery budget exhausted')
              return this.retireAfterDrain(lead, stopping)
            }
            record = await this.assignments.recover(tokenOf(record), observedSequence,
              nextAssignmentRetryAt(record.retryPolicy, record.recovery?.count ?? 0, this.clock()), randomUUID())
          }
          if (this.clock() < record.recovery!.notBefore) return record
          await this.ctx.agentTeams.sendReservedMessage(lead, {
            target: record.attemptId, delivery: 'wakeup', signal: new AbortController().signal,
            content: [{ type: 'text', text: `${this.prompt(record)}\nContinue the interrupted assignment in its existing worktree. Inspect preserved output before editing; do not repeat completed work.` }],
          }, record.recovery!.messageId)
          return record
        }
        record = await this.assignments.stop(tokenOf(record), `DSH worker requires recovery: ${end?.type === 'turn/end' ? end.data.reason.kind : 'no terminal turn evidence'}`)
      }
      return this.retireAfterDrain(lead, record)
    })
  }

  cancel(lead: Agent, token: AttemptToken, reason: string): Promise<AttemptRecord> {
    return this.serialize(async () => {
      const record = this.resolve(lead, token)
      if (record.phase === 'terminal') return record
      const stopping = record.phase === 'stopping' ? record : await this.assignments.stop(tokenOf(record), reason)
      return this.retireAfterDrain(lead, stopping)
    })
  }

  private async retireAfterDrain(lead: Agent, record: AttemptRecord): Promise<AttemptRecord> {
    const member = this.ctx.agentTeams.listMembers(lead).find(member => member.id === record.runtimeId)
    if (member?.name !== record.attemptId) throw new Error('Runtime ownership is uncertain; preserve the assignment for reconciliation')
    await this.drain(lead, [record.runtimeId])
    if (this.ctx.agents.get(SessionId(record.runtimeId)) !== undefined) throw new Error('DSH runtime remains resident; assignment cannot retire')
    return this.assignments.retire(tokenOf(record), {
      runtimeId: record.runtimeId, kind: 'stopped', receipt: `dsh/drainContinuableChildren:${lead.id}:${record.runtimeId}`,
    })
  }

  private resolve(lead: Agent, token: AttemptToken): AttemptRecord {
    const record = this.assignments.list().find(record => record.attemptId === token.attemptId)
    if (this.ctx.agents.get(lead.id) !== lead || this.ctx.agentTeams.tryMembership(lead)?.role !== 'lead' || record?.teamId !== lead.id) {
      throw new Error('DSH assignment requires exact registered-parent authority')
    }
    if (record.generation !== token.generation || record.revision !== token.expectedRevision) throw new Error('Stale DSH assignment token')
    this.ctx.agentTeams.getTask(lead, TeamTaskId(record.taskId))
    return record
  }

  private prompt(record: AttemptRecord): string {
    return JSON.stringify({
      assignment: { assignmentId: record.assignmentId, attemptId: record.attemptId, generation: record.generation,
        projectId: record.projectId, teamId: record.teamId, taskId: record.taskId, workerId: record.workerId },
      checkpoint: record.checkpoint,
      ...(record.repair ? { repair: record.repair } : {}),
      instruction: 'Execute the checkpoint and report evidence. Your report is not task acceptance; verification and integration are separate obligations.',
    })
  }

  /** Only a classified admission outcome may free a never-started reservation. */
  private retryability(diagnostic: string): boolean | undefined {
    if (/\bauth(?:entication|orization)?\b|\binvalid\b|\bpolicy\b|\bunsupported\b|\bnot found\b/i.test(diagnostic)) return false
    if (/\btemporary\b|\btimed? ?out\b|\b(?:econn|network|connection|rate limit)\b|\b(?:provider|spawn|fork) (?:failed|unavailable)\b/i.test(diagnostic)) return true
    return undefined
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }
}
