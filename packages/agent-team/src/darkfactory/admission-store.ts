/** Host-only admission intent journal. Materialization is evidence; this store never opens dispatch. */
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from '../durable-journal.ts'
import { openFactoryOwnedJournal, migrateFactoryOwnedJournal, type FactoryJournalMigration } from './owned-journal.ts'
import { pinWorkflowDefinition, validateWorkflowTemplate, workflowTemplateSchema } from '../workflows.ts'
import { counterSchema, digestSchema, idSchema, revisionSchema, timestampSchema, uniqueIds } from './contracts/common.ts'
import { admissionReceiptSchema, assertAdmissionMatchesSpec, compilerOutcomeSchema, executableSpecSchema, verifyExecutableSpec } from './contracts/spec.ts'
import { compilerCursorSchema } from './spec-compiler.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'
import { ensureFactoryDirectory } from './paths.ts'

const hardRecordBytes = 16_777_216
const parametersSchema = z.record(idSchema, z.union([z.string().max(16_384), z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length <= 256)
const optionsSchema = z.strictObject({
  projectId: idSchema, registeredLeadId: idSchema, workflowTemplates: z.array(workflowTemplateSchema).min(1).max(256),
  maxRecordBytes: revisionSchema.min(1024).max(hardRecordBytes).default(hardRecordBytes),
  maxJournalBytes: revisionSchema.default(1_073_741_824), maxIntents: revisionSchema.max(100_000).default(10_000),
}).refine(value => value.maxJournalBytes >= value.maxRecordBytes)
export type AdmissionStoreOptions = z.input<typeof optionsSchema>
export const admissionIntentInputSchema = z.strictObject({
  registeredLeadId: idSchema, spec: executableSpecSchema, compilerOutcome: compilerOutcomeSchema, compilerCursor: compilerCursorSchema,
  workflow: z.strictObject({ template: workflowTemplateSchema, parameters: parametersSchema }),
  policyRefs: z.strictObject({ policyRecordId: idSchema, decisionReceiptId: idSchema }),
})
const fence = { projectId: idSchema, expectedRevision: counterSchema }
export const beginAdmissionRequestSchema = z.strictObject({ ...fence, intent: admissionIntentInputSchema })
export const materializedAdmissionRequestSchema = z.strictObject({ ...fence, admissionId: idSchema, workflowId: idSchema, workflowDigest: digestSchema, taskIds: uniqueIds(256).min(1) })
export const acknowledgeAdmissionRequestSchema = z.strictObject({ ...fence, admissionId: idSchema })
export const quarantineAdmissionRequestSchema = z.strictObject({ ...fence, admissionId: idSchema, reason: idSchema, healthEscalationId: idSchema })
export const admissionIntentSchema = admissionIntentInputSchema.extend({
  workKey: digestSchema, intentDigest: digestSchema, admissionId: idSchema, workflowId: idSchema, definition: workflowTemplateSchema,
  plannedSteps: z.array(z.strictObject({ stepId: idSchema, intentId: idSchema, taskId: idSchema })).min(1).max(256),
})
export const admissionRecordSchema = z.strictObject({
  id: idSchema, projectId: idSchema, revision: revisionSchema, intent: admissionIntentSchema, receipt: admissionReceiptSchema,
  status: z.enum(['intended', 'materialized', 'acknowledged', 'quarantined']), barrier: z.literal('closed'),
  createdAt: timestampSchema, updatedAt: timestampSchema, quarantineReason: idSchema.optional(), healthEscalationId: idSchema.optional(),
})
export type AdmissionIntent = z.output<typeof admissionIntentSchema>
export type AdmissionRecord = z.output<typeof admissionRecordSchema>
export interface AdmissionResult { record: AdmissionRecord; duplicate: boolean }
interface State { revision: number; head: string | null; journalBytes: number; admissions: AdmissionRecord[] }
const common = { version: z.literal(1), sequence: revisionSchema, previousHash: digestSchema.nullable(), hash: digestSchema, storageBytes: revisionSchema, createdAt: timestampSchema }
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('admission-began'), request: z.strictObject({ ...fence, intent: admissionIntentSchema }) }),
  z.strictObject({ ...common, type: z.literal('admission-materialized'), request: materializedAdmissionRequestSchema }),
  z.strictObject({ ...common, type: z.literal('admission-acknowledged'), request: acknowledgeAdmissionRequestSchema }),
  z.strictObject({ ...common, type: z.literal('admission-quarantined'), request: quarantineAdmissionRequestSchema }),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, keyof typeof common> : never : never
export class AdmissionConflictError extends Error {
  readonly code = 'ADMISSION_INTENT_CONFLICT'
  constructor() { super('Immutable admission work identity has different intent') }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(parseStrictJson(canonicalJson(raw), hardRecordBytes)) } catch { throw new Error('Invalid admission authority input: strict bounded JSON required') }
}
/** Deterministic identifiers are native workflow/task IDs and contain no provider narrative. */
export function planAdmission(raw: z.input<typeof admissionIntentInputSchema>): AdmissionIntent {
  try {
    const input = parse(admissionIntentInputSchema, raw)
    const spec = verifyExecutableSpec(input.spec)
    if (input.compilerOutcome.outcome !== 'COMPILED' || canonicalJson(input.compilerOutcome.spec) !== canonicalJson(spec) ||
      input.compilerOutcome.projectId !== spec.projectId || input.compilerOutcome.policyRevision !== spec.policyRevision ||
      canonicalJson(input.compilerOutcome.source) !== canonicalJson(spec.source) || input.compilerCursor.phase !== 'finished') throw new Error()
    const definition = pinWorkflowDefinition(input.workflow.template, input.workflow.parameters)
    if (digestJson(definition) !== spec.workflowDigest) throw new Error()
    const workKey = digestJson([spec.projectId, spec.source.source, spec.source.sourceEntityId, spec.source.sourceRevision])
    const identity = digestJson([workKey, spec.specDigest, spec.workflowDigest]).slice(7)
    const workflowId = `df-workflow-${identity}`
    return { ...input, workKey, intentDigest: digestJson(input), admissionId: `df-admission-${digestJson([workKey, spec.specDigest]).slice(7)}`, workflowId, definition,
      plannedSteps: definition.steps.map(step => { const intentId = `df-${digestJson([identity, step.id]).slice(7)}`; return { stepId: step.id, intentId, taskId: `workflow-${intentId}` } }),
    }
  } catch { throw new Error('Invalid admission compiler, spec or workflow binding') }
}
function assertScope(options: z.output<typeof optionsSchema>, request: { projectId: string; expectedRevision: number }, state: State): void {
  if (request.projectId !== options.projectId) throw new Error('Cross-project admission authority denied')
  if (request.expectedRevision !== state.revision) throw new Error('Stale admission store revision')
}
function apply(options: z.output<typeof optionsSchema>, state: State, event: Payload, at: string): AdmissionResult {
  assertScope(options, event.request, state)
  if (event.type === 'admission-began') {
    const { workKey, intentDigest, admissionId, workflowId, definition, plannedSteps, ...input } = event.request.intent
    const intent = planAdmission(input), spec = intent.spec
    if (canonicalJson(intent) !== canonicalJson(event.request.intent)) throw new Error('Admission pinned plan mismatch')
    if (spec.projectId !== options.projectId || intent.registeredLeadId !== options.registeredLeadId) throw new Error('Admission registered project/Lead mismatch')
    if (!options.workflowTemplates.some(template => canonicalJson(template) === canonicalJson(intent.workflow.template))) throw new Error('Admission workflow template is not registered')
    const existing = state.admissions.find(record => record.intent.workKey === intent.workKey)
    if (existing) {
      if (existing.intent.intentDigest !== intent.intentDigest) throw new AdmissionConflictError()
      return { record: existing, duplicate: true }
    }
    if (state.admissions.length >= options.maxIntents) throw new Error('Admission intent capacity exceeded')
    const id = intent.admissionId
    const receipt = admissionReceiptSchema.parse({ schemaVersion: 1, id, projectId: spec.projectId, policyRevision: spec.policyRevision, source: spec.source,
      specId: spec.id, specDigest: spec.specDigest, policyDigest: spec.policyDigest, workflowId: intent.workflowId, workflowDigest: spec.workflowDigest,
      taskIds: intent.plannedSteps.map(step => step.taskId), state: 'intended', revision: 1,
    })
    assertAdmissionMatchesSpec(receipt, spec)
    const record: AdmissionRecord = { id, projectId: spec.projectId, revision: 1, intent, receipt, status: 'intended', barrier: 'closed', createdAt: at, updatedAt: at }
    state.admissions.push(record)
    return { record, duplicate: false }
  }
  const record = state.admissions.find(record => record.id === event.request.admissionId)
  if (!record) throw new Error('Unknown admission intent')
  if (Date.parse(at) < Date.parse(record.updatedAt)) throw new Error('Admission clock moved backwards')
  if (event.type === 'admission-materialized') {
    const request = event.request
    if (request.workflowId !== record.intent.workflowId || request.workflowDigest !== record.intent.spec.workflowDigest || canonicalJson(request.taskIds) !== canonicalJson(record.receipt.taskIds)) throw new Error('Materialized workflow/task receipts differ from admission plan')
    if (record.status === 'materialized' || record.status === 'acknowledged') return { record, duplicate: true }
    if (record.status !== 'intended') throw new Error('Terminal admission is immutable')
    record.status = 'materialized'; record.receipt.state = 'admitted'
  } else if (event.type === 'admission-acknowledged') {
    if (record.status === 'acknowledged') return { record, duplicate: true }
    if (record.status !== 'materialized') throw new Error('Admission must be materialized before acknowledgement')
    record.status = 'acknowledged'; record.receipt.state = 'acknowledged'
  } else {
    if (record.status === 'quarantined' && record.quarantineReason === event.request.reason && record.healthEscalationId === event.request.healthEscalationId) return { record, duplicate: true }
    if (record.status === 'acknowledged' || record.status === 'quarantined') throw new Error('Terminal admission is immutable')
    record.status = 'quarantined'; record.receipt.state = 'quarantined'
    record.quarantineReason = event.request.reason; record.healthEscalationId = event.request.healthEscalationId
  }
  record.revision++; record.receipt.revision++; record.updatedAt = at
  assertAdmissionMatchesSpec(record.receipt, record.intent.spec)
  return { record, duplicate: false }
}
function reduce(options: z.output<typeof optionsSchema>, state: State, raw: unknown): State {
  const event = eventSchema.parse(raw), { hash, ...unsigned } = event
  if (event.previousHash !== state.head || digestJson(unsigned) !== hash) throw new Error('Admission journal hash chain mismatch')
  const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1
  if (event.storageBytes !== bytes || bytes > options.maxRecordBytes || state.journalBytes > options.maxJournalBytes - bytes) throw new Error('Admission journal capacity exceeded')
  const next = structuredClone(state)
  apply(options, next, event, event.createdAt)
  return { ...next, revision: event.sequence, head: hash, journalBytes: state.journalBytes + bytes }
}
export class DarkFactoryAdmissionStore {
  private constructor(private readonly journal: DurableJournal<State, Event>, private readonly options: z.output<typeof optionsSchema>, private readonly clock: () => string) {}
  static async open(directory: string, raw: AdmissionStoreOptions, clock: () => string = () => new Date().toISOString()): Promise<DarkFactoryAdmissionStore> {
    const options = parse(optionsSchema, raw)
    try {
      options.workflowTemplates.forEach(validateWorkflowTemplate)
      if (new Set(options.workflowTemplates.map(template => `${template.id}:${template.version}`)).size !== options.workflowTemplates.length) throw new Error()
    } catch { throw new Error('Invalid admission workflow registry') }
    const partition = await ensureFactoryDirectory(directory, options.projectId)
    let journal: DurableJournal<State, Event> | undefined
    try {
      journal = await openFactoryOwnedJournal<State, Event>(join(partition.descriptorPath, 'admission.jsonl'), { revision: 0, head: null, journalBytes: 0, admissions: [] }, (state, event) => reduce(options, state, event), line => {
        const event = parseStrictJson(line, options.maxRecordBytes)
        if (JSON.stringify(event) !== line) throw new Error('Noncanonical admission journal encoding')
        return event
      }, { maxRecordBytes: options.maxRecordBytes, maxJournalBytes: options.maxJournalBytes })
      return new DarkFactoryAdmissionStore(journal, options, clock)
    } catch (error) { await journal?.close(); throw error } finally { await partition.close() }
  }
  /** Migrate the offline admission layout while preserving the complete immutable intent. */
  static async migrate(directory: string, raw: AdmissionStoreOptions, migration: FactoryJournalMigration<State>) {
    const options = parse(optionsSchema, raw)
    try {
      options.workflowTemplates.forEach(validateWorkflowTemplate)
      if (new Set(options.workflowTemplates.map(template => `${template.id}:${template.version}`)).size !== options.workflowTemplates.length) throw new Error()
    } catch { throw new Error('Invalid admission workflow registry') }
    const partition = await ensureFactoryDirectory(directory, options.projectId)
    try {
      return await migrateFactoryOwnedJournal<State, Event>(join(partition.descriptorPath, 'admission.jsonl'), { revision: 0, head: null, journalBytes: 0, admissions: [] },
        (state, event) => reduce(options, state, event), line => { const event = parseStrictJson(line, options.maxRecordBytes); if (JSON.stringify(event) !== line) throw new Error('Noncanonical admission journal encoding'); return event },
        { maxRecordBytes: options.maxRecordBytes, maxJournalBytes: options.maxJournalBytes }, migration, partition.path)
    } finally { await partition.close() }
  }

  private async append(payload: Payload): Promise<AdmissionResult> {
    let result!: AdmissionResult
    await this.journal.append((state, sequence) => {
      const createdAt = parse(timestampSchema, this.clock())
      result = apply(this.options, structuredClone(state), payload, createdAt)
      const unsigned = { ...payload, version: 1 as const, sequence, previousHash: state.head, storageBytes: 1, createdAt }
      for (;;) {
        const event = { ...unsigned, hash: digestJson(unsigned) } as Event
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
        if (bytes === unsigned.storageBytes) return event
        unsigned.storageBytes = bytes
      }
    })
    return structuredClone(result)
  }
  async begin(raw: z.input<typeof beginAdmissionRequestSchema>): Promise<AdmissionResult> {
    const request = parse(beginAdmissionRequestSchema, raw)
    return this.append({ type: 'admission-began', request: { ...request, intent: planAdmission(request.intent) } })
  }
  async recordMaterialized(raw: z.input<typeof materializedAdmissionRequestSchema>): Promise<AdmissionResult> { return this.append({ type: 'admission-materialized', request: parse(materializedAdmissionRequestSchema, raw) }) }
  async acknowledge(raw: z.input<typeof acknowledgeAdmissionRequestSchema>): Promise<AdmissionResult> { return this.append({ type: 'admission-acknowledged', request: parse(acknowledgeAdmissionRequestSchema, raw) }) }
  async quarantine(raw: z.input<typeof quarantineAdmissionRequestSchema>): Promise<AdmissionResult> { return this.append({ type: 'admission-quarantined', request: parse(quarantineAdmissionRequestSchema, raw) }) }
  snapshot(): State { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }
}
