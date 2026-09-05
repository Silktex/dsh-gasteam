/** Converts provider-owned liveness evidence into safe durable health observations. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { AttemptHealthObservation } from './health.ts'
import type {} from './index.ts'

export interface HealthRuntimeAttempt {
  readonly attemptId: string
  readonly generation: number
  readonly provider: 'dsh' | 'external'
  readonly runtimeId: string
  readonly work: AttemptHealthObservation['work']
}

export type DshRuntimeEvidence =
  | { readonly availability: 'available'; readonly runtimeId: string; readonly execution: 'known-active-operation'; readonly operationId: string }
  | { readonly availability: 'available'; readonly runtimeId: string; readonly execution: 'idle' }
  | { readonly availability: 'available'; readonly runtimeId: string; readonly execution: 'unknown'; readonly cursor: string }
  | { readonly availability: 'unavailable' | 'unknown' }

export interface LiveDshRuntimeAttempt {
  readonly attemptId: string
  readonly teamId: string
  readonly runtimeId: string
}

/**
 * Reads the process-local DSH registry and its append-only operation receipts.
 * A persisted `tool/call` is only a requested operation. The in-memory dispatch
 * handle is installed after pre-execution policy/approval and removed only when
 * the dispatch settles; both it and the exact live assignment are required.
 */
export class DshHealthRuntimeObserver {
  /** Per-dispatch token, not rootCallId: nested calls share a root call id. */
  private readonly active = new Map<string, Map<ToolExecutionToken, string>>()
  private readonly dispose: () => void

  constructor(private readonly ctx: Context) {
    this.dispose = ctx.on('tools/execute', async (execution, next) => {
      if (execution.agent === undefined) return await next()
      const runtimeId = String(execution.agent.id)
      const operationId = String(execution.rootCallId)
      let operations = this.active.get(runtimeId)
      if (operations === undefined) this.active.set(runtimeId, operations = new Map())
      operations.set(execution.token, operationId)
      try { return await next() }
      finally {
        operations.delete(execution.token)
        if (operations.size === 0) this.active.delete(runtimeId)
      }
    })
  }

  close(): void { this.dispose() }

  observe(attempt: LiveDshRuntimeAttempt): DshRuntimeEvidence {
    const lead = this.ctx.agents.get(SessionId(attempt.teamId))
    const runtime = this.ctx.agents.get(SessionId(attempt.runtimeId))
    if (!lead || !runtime || this.ctx.agentTeams.tryMembership(lead)?.role !== 'lead') return { availability: 'unknown' }
    const member = this.ctx.agentTeams.listMembers(lead).find(item => item.id === attempt.runtimeId)
    if (!member || member.name !== attempt.attemptId || runtime.session.header.parentSession !== lead.id) return { availability: 'unknown' }
    const operationId = this.active.get(attempt.runtimeId)?.values().next().value as string | undefined
    if (operationId !== undefined) return { availability: 'available', runtimeId: attempt.runtimeId, execution: 'known-active-operation', operationId }
    return { availability: 'available', runtimeId: attempt.runtimeId, execution: 'unknown', cursor: String(runtime.session.seq) }
  }
}

export interface HealthRuntimeSources {
  dsh(attempt: HealthRuntimeAttempt): Promise<DshRuntimeEvidence>
  /** Fresh supervisor ownership proof; a durable external record alone is historical evidence. */
  external(attempt: HealthRuntimeAttempt): Promise<ExternalRuntimeEvidence>
}

export type ExternalRuntimeEvidence =
  | { readonly availability: 'available'; readonly execution: 'known-active-operation'; readonly operationId: string }
  | { readonly availability: 'unavailable' | 'unknown'; readonly execution: 'unknown' }

/**
 * An observation bridge deliberately has no recovery methods. In particular,
 * silence, an idle DSH session, or uncertain external ownership cannot nudge,
 * stop, or replace an attempt.
 */
export class HealthRuntimeObservationAdapter {
  constructor(private readonly sources: HealthRuntimeSources) {}

  async observe(attempt: HealthRuntimeAttempt): Promise<AttemptHealthObservation> {
    if (attempt.provider === 'dsh') return this.fromDsh(attempt, await this.sources.dsh(attempt))
    return this.fromExternal(attempt, await this.sources.external(attempt))
  }

  private fromDsh(attempt: HealthRuntimeAttempt, evidence: DshRuntimeEvidence): AttemptHealthObservation {
    if (evidence.availability !== 'available' || evidence.runtimeId !== attempt.runtimeId) return unavailable(attempt)
    if (evidence.execution === 'known-active-operation') return active(attempt, evidence.operationId)
    if (evidence.execution === 'unknown') return unknown(attempt, evidence.cursor)
    return idle(attempt)
  }

  private fromExternal(attempt: HealthRuntimeAttempt, evidence: ExternalRuntimeEvidence): AttemptHealthObservation {
    if (evidence.availability !== 'available' || evidence.execution !== 'known-active-operation') return unavailable(attempt)
    return active(attempt, evidence.operationId)
  }
}

function base(attempt: HealthRuntimeAttempt): Pick<AttemptHealthObservation, 'attemptId' | 'generation' | 'provider' | 'work'> {
  return { attemptId: attempt.attemptId, generation: attempt.generation, provider: attempt.provider, work: attempt.work }
}
function unavailable(attempt: HealthRuntimeAttempt): AttemptHealthObservation { return { ...base(attempt), runtime: { availability: 'unknown', execution: 'unknown' } } }
function unknown(attempt: HealthRuntimeAttempt, cursor: string): AttemptHealthObservation {
  return { ...base(attempt), runtime: { availability: 'available', execution: 'unknown' }, progress: { source: 'session-sequence', cursor } }
}
function idle(attempt: HealthRuntimeAttempt): AttemptHealthObservation { return { ...base(attempt), runtime: { availability: 'available', execution: 'idle' } } }
function active(attempt: HealthRuntimeAttempt, operationId: string): AttemptHealthObservation {
  return { ...base(attempt), runtime: { availability: 'available', execution: 'known-active-operation' }, progress: { source: 'provider', cursor: `operation:${operationId}` } }
}
