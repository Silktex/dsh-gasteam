/** Bridges a durable non-code assignment to the strictly supervised external runtime. */
import { isAbsolute, join, resolve } from 'node:path'
import type { VerifiedCodexExecutionPolicy } from './codex-admission.ts'
import type { AssignmentStore, AttemptRecord, AttemptToken, ExternalProviderPolicy } from './assignments.ts'
import type { ExternalRuntimeRecord, ExternalRuntimeStore } from './external-runtime.ts'
import { ExternalAssignmentRuntime } from './external-assignment-runtime.ts'
import { RuntimeDrain } from './runtime-drain.ts'
import { ExternalCodeWorktreeProvider } from './external-code-worktree.ts'
import type { ExternalCodeWorktreeReceipt } from './external-code-worktree.ts'

export interface ExternalNonCodeProviderPolicy extends ExternalProviderPolicy {
  readonly admission: VerifiedCodexExecutionPolicy
}

const token = (record: AttemptRecord): AttemptToken => ({ attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })

/**
 * This adapter never creates a Team member. Report work has no checkout;
 * explicitly opted-in code work receives a provider-owned immutable checkout.
 * It leaves capacity reserved whenever the external runtime cannot prove
 * terminal ownership.
 */
export class ExternalNonCodeAssignmentAdapter {
  private readonly worktrees = new ExternalCodeWorktreeProvider()
  constructor(
    private readonly assignments: AssignmentStore,
    private readonly externalStore: ExternalRuntimeStore,
    private readonly runtime: ExternalAssignmentRuntime,
    private readonly policy: ExternalNonCodeProviderPolicy,
    private readonly startEnabled = true,
    private readonly drains = new RuntimeDrain(Math.min(30_000, Math.max(1_000, policy.terminateGraceMs * 2 + 2_000))),
  ) { validate(policy) }

  /** This policy owns non-code work for its selected project even while recovery-only. */
  ownsProject(projectId: string): boolean { return this.policy.projectId === projectId }
  /** Code routing is an additional explicit project policy, never a fallback. */
  ownsCodeProject(projectId: string): boolean { return this.ownsProject(projectId) && this.policy.codeWorktreeDirectory !== undefined }
  ownsTask(projectId: string, nonCode: boolean): boolean { return nonCode ? this.ownsProject(projectId) : this.ownsCodeProject(projectId) }
  /** A recovery-only adapter may observe/cancel retained work but must never launch new work. */
  canStartProject(projectId: string): boolean { return this.startEnabled && this.ownsProject(projectId) }
  reservationPolicy(): ExternalProviderPolicy { return structuredClone(this.policy) }
  matchesReservation(record: AttemptRecord): boolean {
    try { this.assertRecord(record); return true } catch { return false }
  }
  isCodeAssignment(record: AttemptRecord): boolean {
    try { this.assertRecord(record); return this.isCode(record) } catch { return false }
  }
  /** Positive terminal code receipt plus the exact provider-owned checkout. */
  async submissionWorktree(record: AttemptRecord): Promise<ExternalCodeWorktreeReceipt> {
    this.assertRecord(record)
    if (!this.isCode(record)) throw new Error('External report work has no Git submission capability')
    const external = this.externalStore.get(record.attemptId, record.generation)
    if (record.phase !== 'terminal' || record.stopReason || external?.terminal?.outcome !== 'completed' || external.result === undefined) {
      throw new Error('External code submission requires a positive completed runtime receipt')
    }
    return await this.worktrees.restore(this.worktreeIntent(record))
  }

  async start(record: AttemptRecord): Promise<AttemptRecord> {
    this.assertRecord(record)
    if (!this.startEnabled) throw new Error('External provider recovery mode cannot launch a new effect; restore the immutable admitted policy')
    // Git provisioning receives its own immutable receipt before it creates a
    // checkout. A crash between receipt and runtime intent re-enters ensure()
    // and only restores this exact checkout; it never deletes an ambiguous path.
    const worktree = this.isCode(record) ? await this.worktrees.ensure(this.worktreeIntent(record)) : undefined
    const observed = await this.runtime.start(this.launch(record, worktree))
    return await this.reconcile(record, observed)
  }

  async observe(record: AttemptRecord): Promise<AttemptRecord> {
    this.assertRecord(record)
    if (this.isCode(record)) await this.worktrees.restore(this.worktreeIntent(record))
    // A restart may find a durable reservation before the first external launch
    // intent. That edge has no OS effect yet, so re-enter the idempotent start
    // path; an active record without intent remains fenced instead.
    if (this.externalStore.get(record.attemptId, record.generation) === undefined) {
      if (record.phase === 'reserved') return await this.start(record)
      throw new Error('Active external assignment lacks a durable launch intent; preserve capacity')
    }
    const observed = await this.runtime.observe(record.attemptId, record.generation, this.directory(record))
    return await this.reconcile(record, observed)
  }

  /** Fresh, read-only helper ownership evidence for health patrols. */
  async health(record: AttemptRecord): Promise<{ availability: 'available' | 'unknown'; execution: 'known-active-operation' | 'unknown' }> {
    try {
      this.assertRecord(record)
      return await this.runtime.health(record.attemptId, record.generation, this.directory(record))
    } catch { return { availability: 'unknown', execution: 'unknown' } }
  }

  /** Shutdown uses shared deadline handles and a recoverable interruption receipt. */
  async drain(records: readonly AttemptRecord[]): Promise<void> {
    const selected = records.filter(record => record.provider === 'external' && record.phase !== 'terminal')
    const results = await Promise.allSettled(selected.map(record => this.drains.wait(`${record.attemptId}:${record.generation}`, () => this.interruptForShutdown(record))))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'External provider shutdown lacks a positive terminal proof; preserve coordinator ownership')
  }

  private async interruptForShutdown(original: AttemptRecord): Promise<void> {
    this.assertRecord(original)
    let current = this.assignments.list().find(record => record.attemptId === original.attemptId)
    if (current === undefined || current.phase === 'terminal') return
    const existing = this.externalStore.get(current.attemptId, current.generation)
    if (existing === undefined) {
      if (current.phase !== 'reserved') throw new Error('Active external assignment lacks durable launch intent during shutdown')
      await this.assignments.interrupt(token(current), { runtimeId: current.runtimeId, kind: 'never-started', receipt: 'external/shutdown-no-launch-intent' })
      return
    }
    if (existing.terminal === undefined) await this.runtime.cancel(current.attemptId, current.generation, this.directory(current), 'Coordinator shutdown')
    while (true) {
      const observed = await this.runtime.observe(current.attemptId, current.generation, this.directory(current))
      if (observed.terminal !== undefined) {
        current = this.assignments.list().find(record => record.attemptId === original.attemptId)
        if (current === undefined || current.phase === 'terminal') return
        // A completed terminal receipt was already positively observed before
        // shutdown. Preserve its report rather than replacing completed work.
        if (observed.terminal.outcome === 'completed' && observed.result !== undefined) {
          await this.reconcile(current, observed)
          return
        }
        await this.assignments.interrupt(token(current), { runtimeId: current.runtimeId, kind: 'stopped', receipt: `external/${observed.terminal.receipt.receiptId}` })
        return
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
  }

  async cancel(record: AttemptRecord, reason: string): Promise<AttemptRecord> {
    this.assertRecord(record)
    if (record.phase === 'terminal') return record
    const existing = this.externalStore.get(record.attemptId, record.generation)
    if (existing === undefined && record.phase === 'reserved') {
      return await this.assignments.retire(token(record), { runtimeId: record.runtimeId, kind: 'never-started', receipt: 'external/no-launch-intent' })
    }
    let stopping = record.phase === 'stopping' ? record : await this.assignments.stop(token(record), reason)
    if (existing === undefined) return stopping
    if (existing.terminal !== undefined) return await this.reconcile(stopping, existing)
    await this.runtime.cancel(stopping.attemptId, stopping.generation, this.directory(stopping), reason)
    return await this.observe(stopping)
  }

  private async reconcile(record: AttemptRecord, external: ExternalRuntimeRecord): Promise<AttemptRecord> {
    let current = this.assignments.list().find(item => item.attemptId === record.attemptId)
    if (current === undefined) throw new Error('External assignment disappeared from durable ownership')
    if (current.phase === 'terminal') return current
    if (external.phase === 'running' || external.phase === 'cancelling') {
      return current.phase === 'reserved' ? await this.assignments.activate(token(current)) : current
    }
    if (external.phase === 'launch-intent' || external.phase === 'uncertain') return current
    if (current.phase === 'reserved') current = await this.assignments.activate(token(current))
    if (external.terminal === undefined) return current
    if (external.terminal.outcome === 'cancelled' && external.cancellation?.reason === 'Coordinator shutdown' && current.phase !== 'stopping') {
      return await this.assignments.interrupt(token(current), { runtimeId: current.runtimeId, kind: 'stopped', receipt: `external/${external.terminal.receipt.receiptId}` })
    }
    if (external.terminal.outcome === 'completed' && external.result !== undefined && current.phase !== 'stopping') {
      if (current.result === undefined) current = await this.assignments.report(token(current), external.result)
    } else if (current.phase !== 'stopping') {
      current = await this.assignments.stop(token(current), external.terminal.outcome === 'cancelled'
        ? 'External runtime cancelled without a prior assignment cancellation receipt'
        : 'External runtime failed or completed without a final report')
    }
    if (current.phase === 'terminal') return current
    return await this.assignments.retire(token(current), {
      runtimeId: current.runtimeId, kind: 'stopped', receipt: `external/${external.terminal.receipt.receiptId}`,
    })
  }

  private launch(record: AttemptRecord, worktree?: ExternalCodeWorktreeReceipt) {
    const pinned = this.pinned(record)
    return { attemptId: record.attemptId, generation: record.generation, directory: this.directory(record), verifiedAdmission: pinned.admission,
      prompt: { assignment: { assignmentId: record.assignmentId, attemptId: record.attemptId, generation: record.generation, projectId: record.projectId, teamId: record.teamId, taskId: record.taskId, workerId: record.workerId }, checkpoint: record.checkpoint,
        instruction: this.isCode(record)
          ? 'Perform the pinned code task in this isolated external worktree. Commit the completed changes and report concise verification evidence. Do not send external messages.'
          : 'Produce an evidence-backed report satisfying the pinned non-code criteria. Do not create a Git submission or send external messages.' },
      maxSpoolBytes: pinned.maxSpoolBytes, terminateGraceMs: pinned.terminateGraceMs,
      ...(worktree === undefined ? {} : { worktree }) }
  }

  private directory(record: AttemptRecord): string { return join(this.pinned(record).directory, record.attemptId) }
  private pinned(record: AttemptRecord): ExternalProviderPolicy {
    if (record.externalPolicy === undefined) throw new Error('External assignment lacks its immutable provider admission; manual recovery is required')
    return record.externalPolicy
  }
  private assertRecord(record: AttemptRecord): void {
    if (record.provider !== 'external') throw new Error('External adapter requires an external-provider assignment')
    if (this.isCode(record) && record.externalPolicy?.codeWorktreeDirectory === undefined) throw new Error('External provider remains non-code only without an immutable code worktree policy')
    const pinned = this.pinned(record)
    if (pinned.projectId !== record.projectId || !samePolicy(pinned, this.policy)) throw new Error('External provider configuration does not match the immutable assignment policy; manual recovery is required')
  }
  private isCode(record: AttemptRecord): boolean { return record.checkpoint.task.nonCodeCriteria === undefined }
  private worktreeIntent(record: AttemptRecord) {
    const directory = this.pinned(record).codeWorktreeDirectory
    if (directory === undefined) throw new Error('External code task lacks immutable worktree directory')
    return { attemptId: record.attemptId, generation: record.generation, runtimeId: record.runtimeId, repository: this.pinned(record).admission.cwd, directory }
  }
}

function validate(policy: ExternalNonCodeProviderPolicy): void {
  if (!isAbsolute(policy.directory) || policy.directory !== resolve(policy.directory)) throw new Error('External provider requires a canonical absolute directory')
  if (policy.codeWorktreeDirectory !== undefined && (!isAbsolute(policy.codeWorktreeDirectory) || policy.codeWorktreeDirectory !== resolve(policy.codeWorktreeDirectory))) throw new Error('External code worktree directory requires a canonical absolute path')
  if (!Number.isSafeInteger(policy.maxSpoolBytes) || policy.maxSpoolBytes < 1 || policy.maxSpoolBytes > 16 * 1024 * 1024) throw new Error('Invalid external provider spool limit')
  if (!Number.isSafeInteger(policy.terminateGraceMs) || policy.terminateGraceMs < 1 || policy.terminateGraceMs > 300_000) throw new Error('Invalid external provider termination grace')
}

function samePolicy(left: ExternalProviderPolicy, right: ExternalProviderPolicy): boolean { return JSON.stringify(left) === JSON.stringify(right) }
