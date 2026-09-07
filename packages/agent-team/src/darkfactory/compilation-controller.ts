/** Host-owned compiler orchestration. Its callbacks confer no live service authority. */
import z from 'zod'
import { DarkFactoryAdmissionController, AdmissionMaterializationPendingError } from './admission-controller.ts'
import { DarkFactoryCompilationStore, compilationIntentInputSchema, normalizeCompilerResult, type CompilationRecord } from './compilation-store.ts'
import { DarkFactoryIngestionStore } from './ingestion-store.ts'
import { assertIngestionTransition, type InboundWorkItemV1 } from './contracts/ingestion.ts'
import { idSchema, revisionSchema } from './contracts/common.ts'
import { canonicalJson, parseStrictJson } from './json.ts'
import type { CompilerHostContext } from './spec-compiler.ts'

export const compileFactoryWorkRequestSchema = z.strictObject({ projectId: idSchema, intent: compilationIntentInputSchema })
export const resumeFactoryCompilationsRequestSchema = z.strictObject({ projectId: idSchema, limit: revisionSchema.max(100) })
const optionsSchema = z.strictObject({ callbackDeadlineMs: revisionSchema.max(60_000).default(30_000), maxQueued: revisionSchema.max(32).default(32) })
export type CompilationControllerOptions = z.input<typeof optionsSchema>
export interface CompilationCallbackInput { attemptId: string; context: CompilerHostContext; phase: 'initial' | 'repair'; signal: AbortSignal }
export type CompilationRecovery = { status: 'completed'; proposal: unknown } | { status: 'definitely-not-started' } | { status: 'unknown' }
export interface CompilationControllerHost {
  compilations: DarkFactoryCompilationStore
  ingestion: DarkFactoryIngestionStore
  admissions: DarkFactoryAdmissionController
  authorize(input: { record: CompilationRecord; current: InboundWorkItemV1; stage: 'compile' | 'result' | 'admission'; signal: AbortSignal }): Promise<boolean>
  compile(input: CompilationCallbackInput): Promise<unknown>
  recover(input: CompilationCallbackInput): Promise<CompilationRecovery>
  quarantine(input: { projectId: string; compilationId: string; itemId: string; reason: string; evidenceRefs: string[]; signal: AbortSignal }): Promise<string>
}
export class CompilationPendingError extends Error {
  readonly code = 'COMPILATION_PENDING'
  constructor() { super('Compilation remains durably pending; callback or handoff completion is unconfirmed') }
}
export class CompilationStoppedError extends Error {
  readonly code = 'COMPILATION_STOPPED'
  constructor() { super('Compilation controller stopped; durable work awaits recovery') }
}
class CallbackUnavailableError extends Error { constructor() { super('Compiler host callback unavailable') } }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(parseStrictJson(canonicalJson(raw, 1_048_576), 1_048_576)) } catch { throw new Error('Invalid bounded compilation controller input') }
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b) }

export class DarkFactoryCompilationController {
  private readonly options: z.output<typeof optionsSchema>
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private stopped = false
  private readonly aborters = new Set<AbortController>()
  // This remains set after timeout until the actual compiler/recovery promise settles.
  private activeCompiler: Promise<unknown> | undefined
  constructor(private readonly host: CompilationControllerHost, options: CompilationControllerOptions = {}) { this.options = optionsSchema.parse(options) }
  private running(): void { if (this.stopped) throw new CompilationStoppedError() }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new CompilationStoppedError())
    if (this.queued >= this.options.maxQueued) return Promise.reject(new CompilationPendingError())
    this.queued++
    const pending = this.tail.then(() => { this.running(); return operation() }).finally(() => { this.queued-- })
    this.tail = pending.catch(() => {})
    return pending
  }
  private async callback<T>(operation: (signal: AbortSignal) => Promise<T>, compiler = false): Promise<T> {
    this.running()
    if (compiler && this.activeCompiler) throw new CompilationPendingError()
    const aborter = new AbortController(); this.aborters.add(aborter)
    const actual = Promise.resolve().then(() => { this.running(); return operation(aborter.signal) })
    if (compiler) this.activeCompiler = actual
    void actual.finally(() => { if (this.activeCompiler === actual) this.activeCompiler = undefined }).catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.stopped ? new CompilationStoppedError() : new CallbackUnavailableError())
      aborter.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => aborter.abort(), this.options.callbackDeadlineMs)
    })
    try { return await Promise.race([actual, interrupted]) }
    catch (error) { if (error instanceof CompilationStoppedError) throw error; throw new CallbackUnavailableError() }
    finally { clearTimeout(timer); if (onAbort) aborter.signal.removeEventListener('abort', onAbort); this.aborters.delete(aborter) }
  }
  private record(id: string): CompilationRecord {
    const record = this.host.compilations.snapshot().compilations.find(value => value.id === id)
    if (!record) throw new Error('Compilation record unavailable')
    return record
  }
  private current(record: CompilationRecord): InboundWorkItemV1 {
    const item = this.host.ingestion.snapshot().items.find(value => value.id === record.intent.context.ingress.id)
    if (!item || item.projectId !== record.projectId) throw new Error('Compilation source unavailable')
    return item
  }
  private async mutate<T>(operation: (expectedRevision: number) => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      this.running()
      const revision = this.host.compilations.snapshot().revision
      try { return await operation(revision) } catch (error) {
        if (retry >= 3 || this.host.compilations.snapshot().revision === revision) throw error
      }
    }
  }
  private exactSource(record: CompilationRecord, current: InboundWorkItemV1, handoff: boolean): boolean {
    let expected = structuredClone(record.intent.context.ingress)
    if (same(expected, current)) return true
    if (!handoff) return false
    for (const state of ['compiled', 'admitted', 'acknowledged'] as const) {
      const next = { ...expected, state, revision: expected.revision + 1 }
      assertIngestionTransition(expected, next); expected = next
      if (same(expected, current)) return true
    }
    return false
  }
  private async quarantine(record: CompilationRecord, reason: Parameters<DarkFactoryCompilationStore['quarantine']>[0]['reason'], existingHealthId?: string): Promise<CompilationRecord> {
    this.running(); record = this.record(record.id)
    let current = this.current(record)
    const healthEscalationId = record.healthEscalationId ?? existingHealthId ?? current.healthEscalationId ?? parse(idSchema, await this.callback(signal => this.host.quarantine({
      projectId: record.projectId, compilationId: record.id, itemId: current.id, reason, evidenceRefs: [record.id, current.id], signal,
    })))
    if (record.status !== 'quarantined') await this.mutate(expectedRevision => this.host.compilations.quarantine({ projectId: record.projectId, expectedRevision, compilationId: record.id, reason, healthEscalationId }))
    record = this.record(record.id)
    for (let retry = 0; ; retry++) {
      this.running(); current = this.current(record)
      // Native terminal records cannot be rewritten; acknowledged tasks remain held.
      if (current.state === 'quarantined' || current.state === 'acknowledged') return record
      try {
        await this.host.ingestion.transition({ projectId: record.projectId, expectedRevision: current.revision, item: { ...current, state: 'quarantined', revision: current.revision + 1, quarantineReason: record.quarantineReason!, healthEscalationId: record.healthEscalationId! } })
        return record
      } catch (error) { if (retry >= 3 || this.current(record).revision === current.revision) throw error }
    }
  }
  private async authorize(record: CompilationRecord, stage: 'compile' | 'result' | 'admission'): Promise<boolean> {
    this.running()
    const ordered = this.host.compilations.snapshot().compilations, position = ordered.findIndex(value => value.id === record.id)
    if (position < 0) throw new Error('Compilation record unavailable')
    const source = record.intent.context.ingress
    // Native append order is authoritative. A newer pending intent must never
    // invalidate its predecessor during recovery. Admitted workflows remain held
    // and active until a future release lifecycle provides an explicit endpoint.
    if (ordered.slice(0, position).some(prior => {
      const previous = prior.intent.context.ingress
      return prior.status !== 'quarantined' && previous.projectId === source.projectId && previous.source === source.source && previous.sourceEntityId === source.sourceEntityId && previous.sourceRevision !== source.sourceRevision
    })) { await this.quarantine(record, 'SOURCE_CHANGED'); return false }
    let current = this.current(record)
    if (!this.exactSource(record, current, stage === 'admission')) { await this.quarantine(record, 'SOURCE_CHANGED'); return false }
    let allowed = false
    try { allowed = await this.callback(signal => this.host.authorize({ record: structuredClone(record), current: structuredClone(current), stage, signal })) === true }
    catch (error) { if (error instanceof CompilationStoppedError) throw error }
    this.running(); current = this.current(record)
    if (!this.exactSource(record, current, stage === 'admission')) { await this.quarantine(record, 'SOURCE_CHANGED'); return false }
    if (!allowed) { await this.quarantine(record, 'AUTHORITY_DENIED'); return false }
    return true
  }
  private async attempt(record: CompilationRecord, recover: boolean, recoveryCount = 0): Promise<CompilationRecord> {
    const attempt = record.attempts.at(-1)!
    const callbackInput = { attemptId: attempt.id, context: structuredClone(record.intent.context), phase: attempt.phase }
    let proposal: unknown
    if (recover) {
      if (recoveryCount >= 1) return this.quarantine(record, 'COMPILER_ATTEMPT_UNCERTAIN')
      recoveryCount++
      let recovery: CompilationRecovery
      try { recovery = await this.callback(signal => this.host.recover({ ...callbackInput, signal }), true) }
      catch (error) { if (error instanceof CompilationStoppedError || error instanceof CompilationPendingError) throw error; return this.quarantine(record, 'COMPILER_ATTEMPT_UNCERTAIN') }
      if (recovery?.status === 'completed') proposal = recovery.proposal
      else if (recovery?.status !== 'definitely-not-started') return this.quarantine(record, 'COMPILER_ATTEMPT_UNCERTAIN')
      else recover = false
    }
    if (!recover) {
      if (!await this.authorize(record, 'compile')) return this.record(record.id)
      try { proposal = await this.callback(signal => this.host.compile({ ...callbackInput, signal }), true) }
      catch (error) {
        if (error instanceof CompilationStoppedError || error instanceof CompilationPendingError) throw error
        // A timed-out promise may still execute; never start recovery beside it.
        if (this.activeCompiler) return this.quarantine(record, 'COMPILER_ATTEMPT_UNCERTAIN')
        return this.attempt(record, true, recoveryCount)
      }
    }
    if (!await this.authorize(record, 'result')) return this.record(record.id)
    let result: ReturnType<typeof normalizeCompilerResult>
    try { result = normalizeCompilerResult(proposal) } catch { return this.quarantine(record, 'COMPILER_RESPONSE_INVALID') }
    await this.mutate(expectedRevision => this.host.compilations.completeAttempt({ projectId: record.projectId, expectedRevision, compilationId: record.id, attemptId: attempt.id, result }))
    return this.record(record.id)
  }
  private async continue(record: CompilationRecord): Promise<CompilationRecord> {
    for (let steps = 0; steps < 6; steps++) {
      this.running(); record = this.record(record.id)
      if (record.status === 'admitted') return record
      if (record.status === 'quarantined') return this.quarantine(record, record.quarantineReason!)
      if (record.status === 'rejected') return this.quarantine(record, 'COMPILER_REJECTED')
      if (record.status === 'compiled') {
        if (!await this.authorize(record, 'admission')) return this.record(record.id)
        if (!record.admissionIntent) throw new Error('Compilation admission intent unavailable')
        let admitted
        try { admitted = await this.callback(() => this.host.admissions.admit({ projectId: record.projectId, itemId: record.intent.context.ingress.id, intent: structuredClone(record.admissionIntent!) }), true) }
        catch (error) {
          if (error instanceof CompilationStoppedError) throw error
          if (error instanceof AdmissionMaterializationPendingError) throw new CompilationPendingError()
          // Source/authority failure can already have quarantined ingestion.
          if (this.current(record).state === 'quarantined') return this.quarantine(record, 'ADMISSION_QUARANTINED', this.current(record).healthEscalationId)
          throw new CompilationPendingError()
        }
        this.running()
        if (admitted.status === 'quarantined') return this.quarantine(record, 'ADMISSION_QUARANTINED', admitted.healthEscalationId)
        if (admitted.status !== 'acknowledged') throw new CompilationPendingError()
        if (!await this.authorize(record, 'admission')) return this.record(record.id)
        await this.mutate(expectedRevision => this.host.compilations.recordAdmission({ projectId: record.projectId, expectedRevision, compilationId: record.id, receipt: admitted.receipt }))
        return this.record(record.id)
      }
      if (this.activeCompiler) throw new CompilationPendingError()
      if (!await this.authorize(record, 'compile')) return this.record(record.id)
      const recover = record.status === 'attempting'
      if (!recover) await this.mutate(expectedRevision => this.host.compilations.startAttempt({ projectId: record.projectId, expectedRevision, compilationId: record.id }))
      record = await this.attempt(this.record(record.id), recover)
    }
    throw new CompilationPendingError()
  }
  async compile(raw: z.input<typeof compileFactoryWorkRequestSchema>): Promise<CompilationRecord> {
    const request = parse(compileFactoryWorkRequestSchema, raw)
    return this.serialize(async () => {
      if (request.intent.context.ingress.projectId !== request.projectId) throw new Error('Cross-project compilation denied')
      const result = await this.mutate(expectedRevision => this.host.compilations.begin({ projectId: request.projectId, expectedRevision, intent: request.intent }))
      return this.continue(result.record)
    })
  }
  async resume(raw: z.input<typeof resumeFactoryCompilationsRequestSchema>): Promise<CompilationRecord[]> {
    const request = parse(resumeFactoryCompilationsRequestSchema, raw)
    return this.serialize(async () => {
      const records = this.host.compilations.snapshot().compilations
      if (records.some(record => record.projectId !== request.projectId)) throw new Error('Cross-project compilation resume denied')
      const pending = records.filter(record => record.status !== 'admitted' && (record.status !== 'quarantined' || !['quarantined', 'acknowledged'].includes(this.current(record).state))).slice(0, request.limit)
      const results: CompilationRecord[] = []
      for (const record of pending) results.push(await this.continue(record))
      return results
    })
  }
  /** Abort bounded waits. Uncooperative host promises retain their invocation fence. */
  async stop(): Promise<void> { this.stopped = true; for (const aborter of this.aborters) aborter.abort(); await this.tail }
  async settled(): Promise<void> { await this.tail }
}
