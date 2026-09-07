/** Host-owned orchestration only. Durable admission and every materialized task remain held. */
import z from 'zod'
import { FactoryMaterializationConflictError } from '../workflow-runtime.ts'
import { admissionIntentInputSchema, AdmissionConflictError, DarkFactoryAdmissionStore, planAdmission, type AdmissionRecord } from './admission-store.ts'
import { DarkFactoryIngestionStore } from './ingestion-store.ts'
import { assertAdmissionMatchesSpec } from './contracts/spec.ts'
import { digestSchema, idSchema, revisionSchema, uniqueIds } from './contracts/common.ts'
import { type InboundWorkItemV1 } from './contracts/ingestion.ts'
import { canonicalJson, parseStrictJson } from './json.ts'

export const admitFactoryWorkRequestSchema = z.strictObject({ projectId: idSchema, itemId: idSchema, intent: admissionIntentInputSchema })
const materializationReceiptSchema = z.strictObject({ workflowId: idSchema, workflowDigest: digestSchema, taskIds: uniqueIds(256).min(1) })
export const resumeFactoryAdmissionsRequestSchema = z.strictObject({ projectId: idSchema, limit: revisionSchema.max(100) })
export interface AdmissionControllerHost {
  admissions: DarkFactoryAdmissionStore
  ingestion: DarkFactoryIngestionStore
  materialize(record: AdmissionRecord): Promise<{ workflowId: string; workflowDigest: string; taskIds: string[] }>
  authorize(record: AdmissionRecord): Promise<boolean>
  quarantine(input: { projectId: string; admissionId: string; reason: string; evidenceRefs: string[] }): Promise<string>
}
export class AdmissionMaterializationPendingError extends Error {
  readonly code = 'ADMISSION_MATERIALIZATION_PENDING'
  constructor() { super('Admission materialization is unconfirmed; durable intent remains held for retry') }
}
export class AdmissionAuthorityDeniedError extends Error {
  readonly code = 'ADMISSION_AUTHORITY_DENIED'
  constructor() { super('Admission authority denied; work remains held') }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(parseStrictJson(canonicalJson(raw), 16_777_216)) } catch { throw new Error('Invalid admission controller input: strict bounded JSON required') }
}
function sameSource(item: InboundWorkItemV1, record: AdmissionRecord): boolean {
  const spec = record.intent.spec
  return item.projectId === record.projectId && item.policyRevision === spec.policyRevision &&
    ['envelopeId', 'source', 'sourceEntityId', 'sourceRevision'].every(key => item[key as keyof InboundWorkItemV1] === spec.source[key as keyof typeof spec.source])
}
export class DarkFactoryAdmissionController {
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  constructor(private readonly host: AdmissionControllerHost) {}
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queued >= 32) return Promise.reject(new Error('Admission controller queue capacity exceeded'))
    this.queued++
    const pending = this.tail.then(operation).finally(() => { this.queued-- })
    this.tail = pending.catch(() => {})
    return pending
  }
  private record(id: string): AdmissionRecord {
    const record = this.host.admissions.snapshot().admissions.find(record => record.id === id)
    if (!record) throw new Error('Admission intent unavailable')
    return record
  }
  private item(record: AdmissionRecord): InboundWorkItemV1 {
    const matches = this.host.ingestion.snapshot().items.filter(item => sameSource(item, record))
    if (matches.length !== 1) throw new Error('Admission source work binding unavailable')
    return matches[0]!
  }
  private async mutate<T>(operation: (expectedRevision: number) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const revision = this.host.admissions.snapshot().revision
      try { return await operation(revision) } catch (error) {
        if (attempt >= 3 || this.host.admissions.snapshot().revision === revision) throw error
      }
    }
  }
  private async transition(record: AdmissionRecord, target: 'compiled' | 'admitted' | 'acknowledged'): Promise<void> {
    await this.authorize(record)
    const fromState = { compiled: 'trusted', admitted: 'compiled', acknowledged: 'admitted' }[target]
    for (let attempt = 0; ; attempt++) {
      const item = this.item(record)
      if (item.state === target) return
      if (item.state !== fromState || item.trust.decision !== 'trusted') throw new Error('Admission ingestion lifecycle mismatch')
      try {
        await this.host.ingestion.transition({ projectId: record.projectId, expectedRevision: item.revision, item: { ...item, state: target, revision: item.revision + 1 } })
        return
      } catch (error) {
        if (attempt >= 3 || this.item(record).revision === item.revision) throw error
        await this.authorize(record)
      }
    }
  }
  private async quarantine(record: AdmissionRecord, reason: string): Promise<AdmissionRecord> {
    record = this.record(record.id)
    const item = this.item(record)
    const healthEscalationId = record.healthEscalationId ?? item.healthEscalationId ?? parse(idSchema, await this.host.quarantine({
      projectId: record.projectId, admissionId: record.id, reason, evidenceRefs: [record.id, record.intent.spec.id, item.id],
    }))
    if (!['acknowledged', 'quarantined'].includes(record.status)) {
      record = (await this.mutate(expectedRevision => this.host.admissions.quarantine({ projectId: record.projectId, expectedRevision, admissionId: record.id, reason, healthEscalationId }))).record
    }
    for (let attempt = 0; ; attempt++) {
      const current = this.item(record)
      if (current.state === 'acknowledged' || current.state === 'quarantined') return record
      try {
        await this.host.ingestion.transition({ projectId: record.projectId, expectedRevision: current.revision, item: { ...current, state: 'quarantined', revision: current.revision + 1, quarantineReason: record.quarantineReason ?? reason, healthEscalationId } })
        return record
      } catch (error) {
        if (attempt >= 3 || this.item(record).revision === current.revision) throw error
      }
    }
  }
  private async authorize(record: AdmissionRecord): Promise<void> {
    let allowed = false
    try { allowed = await this.host.authorize(structuredClone(record)) === true } catch { /* Unavailable authority fails closed. */ }
    if (allowed) return
    await this.quarantine(record, 'AUTHORITY_REVOKED')
    throw new AdmissionAuthorityDeniedError()
  }
  private async continue(record: AdmissionRecord): Promise<AdmissionRecord> {
    record = this.record(record.id)
    assertAdmissionMatchesSpec(record.receipt, record.intent.spec)
    let item = this.item(record)
    if (record.status === 'quarantined') return this.quarantine(record, record.quarantineReason!)
    if (item.state === 'quarantined') return record.status === 'acknowledged' ? record : this.quarantine(record, item.quarantineReason!)
    if (record.status === 'acknowledged' && item.state === 'acknowledged') return record
    const allowed = { intended: ['trusted', 'compiled'], materialized: ['compiled', 'admitted'], acknowledged: ['admitted', 'acknowledged'] }
    if (!allowed[record.status].includes(item.state)) throw new Error('Admission recovery lifecycle mismatch')
    if (item.state === 'trusted') await this.transition(record, 'compiled')
    if (record.status === 'intended') {
      await this.authorize(record)
      let materialized: Awaited<ReturnType<AdmissionControllerHost['materialize']>>
      try { materialized = await this.host.materialize(structuredClone(record)) } catch (error) {
        if (error instanceof FactoryMaterializationConflictError) return this.quarantine(record, 'MATERIALIZATION_CONFLICT')
        throw new AdmissionMaterializationPendingError()
      }
      // A successful host return still has to match the complete immutable plan.
      try { materialized = parse(materializationReceiptSchema, materialized) } catch { return this.quarantine(record, 'MATERIALIZATION_CONFLICT') }
      try {
        record = (await this.mutate(expectedRevision => this.host.admissions.recordMaterialized({ projectId: record.projectId, expectedRevision, admissionId: record.id, ...materialized }))).record
      } catch (error) {
        if (materialized.workflowId !== record.intent.workflowId || materialized.workflowDigest !== record.intent.spec.workflowDigest || canonicalJson(materialized.taskIds) !== canonicalJson(record.receipt.taskIds)) return this.quarantine(record, 'MATERIALIZATION_CONFLICT')
        throw new AdmissionMaterializationPendingError()
      }
    }
    item = this.item(record)
    if (item.state === 'compiled') await this.transition(record, 'admitted')
    if (record.status === 'materialized') {
      await this.authorize(record)
      record = (await this.mutate(expectedRevision => this.host.admissions.acknowledge({ projectId: record.projectId, expectedRevision, admissionId: record.id }))).record
    }
    if (this.item(record).state === 'admitted') await this.transition(record, 'acknowledged')
    return this.record(record.id)
  }
  async admit(raw: z.input<typeof admitFactoryWorkRequestSchema>): Promise<AdmissionRecord> {
    const request = parse(admitFactoryWorkRequestSchema, raw)
    return this.serialize(async () => {
      const plan = planAdmission(request.intent)
      const item = this.host.ingestion.snapshot().items.find(item => item.id === request.itemId)
      if (!item || item.projectId !== request.projectId || request.intent.spec.projectId !== request.projectId ||
        item.policyRevision !== request.intent.spec.policyRevision || ['envelopeId', 'source', 'sourceEntityId', 'sourceRevision'].some(key => item[key as keyof InboundWorkItemV1] !== request.intent.spec.source[key as keyof typeof request.intent.spec.source])) throw new Error('Admission requested work/spec identity mismatch')
      const existing = this.host.admissions.snapshot().admissions.find(record => record.intent.workKey === plan.workKey)
      if (existing) {
        if (existing.intent.intentDigest !== plan.intentDigest) {
          await this.quarantine(existing, 'ADMISSION_INTENT_CONFLICT')
          throw new AdmissionConflictError()
        }
        return this.continue(existing)
      }
      if (item.state !== 'trusted' || item.trust.decision !== 'trusted') throw new Error('Admission requires existing trusted work')
      const result = await this.mutate(expectedRevision => this.host.admissions.begin({ projectId: request.projectId, expectedRevision, intent: request.intent }))
      return this.continue(result.record)
    })
  }
  async resume(raw: z.input<typeof resumeFactoryAdmissionsRequestSchema>): Promise<AdmissionRecord[]> {
    const request = parse(resumeFactoryAdmissionsRequestSchema, raw)
    return this.serialize(async () => {
      const records = this.host.admissions.snapshot().admissions
      if (records.some(record => record.projectId !== request.projectId)) throw new Error('Cross-project admission resume denied')
      const pending = records.filter(record => {
        const item = this.item(record)
        return record.status !== 'acknowledged' && record.status !== 'quarantined' || !['acknowledged', 'quarantined'].includes(item.state)
      }).slice(0, request.limit)
      const results: AdmissionRecord[] = []
      for (const record of pending) results.push(await this.continue(record))
      return results
    })
  }
  async settled(): Promise<void> { await this.tail }
}
