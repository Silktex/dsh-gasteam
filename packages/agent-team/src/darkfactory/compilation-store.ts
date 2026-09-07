/** Host-only compiler ownership. This journal never invokes a model or activates admitted work. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from '../durable-journal.ts'
import { pinWorkflowDefinition, validateWorkflowTemplate } from '../workflows.ts'
import { admissionIntentInputSchema, planAdmission } from './admission-store.ts'
import { artifactRefSchema, counterSchema, digestSchema, idSchema, revisionSchema, timestampSchema } from './contracts/common.ts'
import { admissionReceiptSchema, assertAdmissionMatchesSpec, compilerOutcomeSchema } from './contracts/spec.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'
import { openFactoryOwnedJournal, migrateFactoryOwnedJournal, type FactoryJournalMigration } from './owned-journal.ts'
import { ensureFactoryDirectory } from './paths.ts'
import { compilerCursorSchema, compilerHostContextSchema, compilerProposalSchema, SpecCompilerSession } from './spec-compiler.ts'

const hardRecordBytes = 16_777_216, proposalBytes = 1_048_576
export const compilationIntentInputSchema = z.strictObject({
  context: compilerHostContextSchema,
  registeredLeadId: admissionIntentInputSchema.shape.registeredLeadId,
  workflow: admissionIntentInputSchema.shape.workflow,
  policyRefs: admissionIntentInputSchema.shape.policyRefs,
})
export type CompilationIntentInput = z.input<typeof compilationIntentInputSchema>
const optionsSchema = z.strictObject({
  projectId: idSchema, registeredLeadId: idSchema,
  workflowTemplates: z.array(admissionIntentInputSchema.shape.workflow.shape.template).min(1).max(256),
  maxRecordBytes: revisionSchema.min(1024).max(hardRecordBytes).default(hardRecordBytes),
  maxJournalBytes: revisionSchema.default(1_073_741_824), maxIntents: revisionSchema.max(100_000).default(10_000),
}).refine(value => value.maxJournalBytes >= value.maxRecordBytes)
export type CompilationStoreOptions = z.input<typeof optionsSchema>
export const compilationReasonSchema = z.enum(['SOURCE_CHANGED', 'AUTHORITY_DENIED', 'COMPILER_REJECTED', 'COMPILER_ATTEMPT_UNCERTAIN', 'COMPILER_RESPONSE_INVALID', 'COMPILATION_INTENT_CONFLICT', 'ADMISSION_CONFLICT', 'ADMISSION_QUARANTINED'])
export const normalizedCompilerResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('proposal'), proposal: compilerProposalSchema }),
  z.strictObject({ kind: z.literal('malformed'), digest: digestSchema, bytes: counterSchema.max(proposalBytes), evidenceRefs: z.array(artifactRefSchema).max(8) }),
])
export type NormalizedCompilerResult = z.output<typeof normalizedCompilerResultSchema>
/** The caller must sanitize intended spec narrative before calling. Invalid bytes and negative explanations never persist. */
export function normalizeCompilerResult(raw: unknown): NormalizedCompilerResult {
  let bytes: Uint8Array
  try {
    if (typeof raw === 'string') {
      if (Buffer.byteLength(raw, 'utf8') > proposalBytes) throw new Error()
      bytes = Buffer.from(raw, 'utf8')
    } else if (raw instanceof Uint8Array) {
      if (raw.byteLength > proposalBytes) throw new Error()
      bytes = Uint8Array.from(raw)
    } else bytes = Buffer.from(canonicalJson(raw, proposalBytes), 'utf8')
  } catch { throw new Error('Invalid bounded compiler response') }
  try {
    const proposal = compilerProposalSchema.parse(parseStrictJson(bytes, proposalBytes))
    return { kind: 'proposal', proposal: proposal.outcome === 'COMPILED' ? proposal : { outcome: proposal.outcome, reasons: [`MODEL_REPORTED_${proposal.outcome}`] } }
  } catch { return { kind: 'malformed', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.byteLength, evidenceRefs: [] } }
}
const fence = { projectId: idSchema, expectedRevision: counterSchema }
export const beginCompilationRequestSchema = z.strictObject({ ...fence, intent: compilationIntentInputSchema })
export const startCompilationAttemptRequestSchema = z.strictObject({ ...fence, compilationId: idSchema })
export const completeCompilationAttemptRequestSchema = z.strictObject({ ...fence, compilationId: idSchema, attemptId: idSchema, result: normalizedCompilerResultSchema })
export const recordCompilationAdmissionRequestSchema = z.strictObject({ ...fence, compilationId: idSchema, receipt: admissionReceiptSchema })
export const quarantineCompilationRequestSchema = z.strictObject({ ...fence, compilationId: idSchema, reason: compilationReasonSchema, healthEscalationId: idSchema })
const evaluationSchema = z.strictObject({ outcome: compilerOutcomeSchema, disposition: z.enum(['compiled', 'schema-repair', 'quarantined']), cursor: compilerCursorSchema })
export interface CompilationAttempt {
  id: string; number: 1 | 2; phase: 'initial' | 'repair'; status: 'intended' | 'evaluated'; createdAt: string
  result?: NormalizedCompilerResult; evaluation?: z.output<typeof evaluationSchema>; completedAt?: string
}
export interface CompilationRecord {
  id: string; projectId: string; revision: number; sourceKey: string; intentDigest: string
  intent: z.output<typeof compilationIntentInputSchema>; cursor: z.output<typeof compilerCursorSchema>
  status: 'ready' | 'attempting' | 'repair' | 'rejected' | 'compiled' | 'admitted' | 'quarantined'
  attempts: CompilationAttempt[]; admissionIntent?: z.output<typeof admissionIntentInputSchema>; admissionReceipt?: z.output<typeof admissionReceiptSchema>
  quarantineReason?: z.output<typeof compilationReasonSchema>; healthEscalationId?: string; createdAt: string; updatedAt: string
}
export interface CompilationResult { record: CompilationRecord; duplicate: boolean }
export interface CompilationState { revision: number; head: string | null; journalBytes: number; compilations: CompilationRecord[] }
const common = { version: z.literal(1), sequence: revisionSchema, previousHash: digestSchema.nullable(), hash: digestSchema, storageBytes: revisionSchema, createdAt: timestampSchema }
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('compilation-began'), request: beginCompilationRequestSchema }),
  z.strictObject({ ...common, type: z.literal('compilation-attempt-started'), request: startCompilationAttemptRequestSchema, attemptId: idSchema }),
  z.strictObject({ ...common, type: z.literal('compilation-attempt-completed'), request: completeCompilationAttemptRequestSchema, evaluation: evaluationSchema, admissionIntent: admissionIntentInputSchema.optional() }),
  z.strictObject({ ...common, type: z.literal('compilation-admission-recorded'), request: recordCompilationAdmissionRequestSchema }),
  z.strictObject({ ...common, type: z.literal('compilation-quarantined'), request: quarantineCompilationRequestSchema }),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, keyof typeof common> : never : never
export class CompilationConflictError extends Error {
  readonly code = 'COMPILATION_INTENT_CONFLICT'
  constructor() { super('Immutable compilation identity or result conflicts') }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(parseStrictJson(canonicalJson(raw, hardRecordBytes), hardRecordBytes)) } catch { throw new Error('Invalid compilation authority input: strict bounded JSON required') }
}
function optionsFor(raw: CompilationStoreOptions) {
  const options = parse(optionsSchema, raw)
  try {
    options.workflowTemplates.forEach(validateWorkflowTemplate)
    if (new Set(options.workflowTemplates.map(template => `${template.id}:${template.version}`)).size !== options.workflowTemplates.length) throw new Error()
  } catch { throw new Error('Invalid compilation workflow registry') }
  return options
}
function pin(options: z.output<typeof optionsSchema>, intent: z.output<typeof compilationIntentInputSchema>) {
  try {
    const session = new SpecCompilerSession(intent.context), ingress = intent.context.ingress
    if (ingress.projectId !== options.projectId || intent.registeredLeadId !== options.registeredLeadId) throw new Error()
    if (!options.workflowTemplates.some(template => canonicalJson(template) === canonicalJson(intent.workflow.template))) throw new Error()
    if (digestJson(pinWorkflowDefinition(intent.workflow.template, intent.workflow.parameters)) !== intent.context.workflowDigest) throw new Error()
    const sourceKey = digestJson([ingress.projectId, ingress.source, ingress.sourceEntityId, ingress.sourceRevision])
    return { id: `df-compilation-${sourceKey.slice(7)}`, sourceKey, intentDigest: digestJson(intent), cursor: session.cursor }
  } catch { throw new Error('Invalid compilation host, registration or workflow binding') }
}
function evaluationFor(record: CompilationRecord, result: NormalizedCompilerResult) {
  if (result.kind === 'malformed' && result.evidenceRefs.some(ref => ref.projectId !== record.projectId)) throw new Error('Cross-project compiler evidence denied')
  if (result.kind === 'proposal' && canonicalJson(normalizeCompilerResult(result.proposal)) !== canonicalJson(result)) throw new Error('Compiler proposal is not normalized')
  const session = new SpecCompilerSession(record.intent.context, record.cursor)
  const evaluation = session.evaluate(result.kind === 'proposal' ? result.proposal : null, record.intent.context.ingress)
  if (evaluation.disposition !== 'compiled') return { evaluation }
  if (evaluation.outcome.outcome !== 'COMPILED') throw new Error('Invalid native compiler evaluation')
  const { context: _context, ...pins } = record.intent
  const input = { ...pins, spec: evaluation.outcome.spec, compilerOutcome: evaluation.outcome, compilerCursor: evaluation.cursor }
  // Planning also checks exact compiler/spec/workflow bindings before any result is durable.
  planAdmission(input)
  return { evaluation, admissionIntent: input }
}
function recordFor(state: CompilationState, id: string): CompilationRecord {
  const record = state.compilations.find(record => record.id === id)
  if (!record) throw new Error('Unknown compilation intent')
  return record
}
const attemptId = (record: CompilationRecord, number: number) => `df-compile-attempt-${digestJson([record.id, record.intentDigest, number]).slice(7)}`
function completionFor(options: z.output<typeof optionsSchema>, record: CompilationRecord, request: z.output<typeof completeCompilationAttemptRequestSchema>): Extract<Payload, { type: 'compilation-attempt-completed' }> {
  const index = record.attempts.findIndex(attempt => attempt.id === request.attemptId)
  if (index < 0) throw new Error('Unknown compiler attempt')
  // A completed-attempt retry uses its original cursor, including a previous repair.
  const cursor = index === 0 ? new SpecCompilerSession(record.intent.context).cursor : record.attempts[index - 1]!.evaluation?.cursor
  if (!cursor) throw new Error('Compiler attempt has no preceding durable evaluation')
  const before = { ...record, cursor }
  let result = request.result
  let payload: Extract<Payload, { type: 'compilation-attempt-completed' }> = { type: 'compilation-attempt-completed', request, ...evaluationFor(before, result) }
  // Reserve an upper bound for common event metadata and future CAS digit growth.
  // Over-limit results become a digest-only malformed response, not an unrecordable success.
  const fits = () => { try { canonicalJson(payload, options.maxRecordBytes - 512); return true } catch { return false } }
  if (!fits()) {
    result = result.kind === 'proposal'
      ? { kind: 'malformed', digest: digestJson(result.proposal), bytes: Buffer.byteLength(canonicalJson(result.proposal, proposalBytes), 'utf8'), evidenceRefs: [] }
      : { ...result, evidenceRefs: [] }
    payload = { type: 'compilation-attempt-completed', request: { ...request, result }, ...evaluationFor(before, result) }
    if (!fits()) throw new Error('Compilation result cannot fit bounded journal record')
  }
  return payload
}
function reservedBytes(options: z.output<typeof optionsSchema>, state: CompilationState): number {
  const terminal = Math.min(options.maxRecordBytes, 2048)
  let reserved = 0
  for (const record of state.compilations) {
    if (record.status === 'admitted' || record.status === 'quarantined') continue
    // Attempt completion and admission acknowledgement each consume at most one
    // full record; every nonterminal intent retains a bounded quarantine record.
    const needed = terminal + options.maxRecordBytes * (record.status === 'attempting' ? 2 : record.status === 'compiled' ? 1 : 0)
    if (reserved > options.maxJournalBytes - needed) throw new Error('Compilation journal capacity exceeded')
    reserved += needed
  }
  return reserved
}
function apply(options: z.output<typeof optionsSchema>, state: CompilationState, event: Payload, at: string): CompilationResult {
  if (event.request.projectId !== options.projectId) throw new Error('Cross-project compilation authority denied')
  if (event.request.expectedRevision !== state.revision) throw new Error('Stale compilation store revision')
  if (event.type === 'compilation-began') {
    const intent = event.request.intent, pinned = pin(options, intent)
    const previous = state.compilations.find(record => record.sourceKey === pinned.sourceKey)
    if (previous) {
      if (previous.intentDigest !== pinned.intentDigest) throw new CompilationConflictError()
      return { record: previous, duplicate: true }
    }
    if (state.compilations.length >= options.maxIntents) throw new Error('Compilation intent capacity exceeded')
    const record: CompilationRecord = { ...pinned, projectId: options.projectId, revision: 1, intent, status: 'ready', attempts: [], createdAt: at, updatedAt: at }
    state.compilations.push(record)
    return { record, duplicate: false }
  }
  const record = recordFor(state, event.request.compilationId)
  if (Date.parse(at) < Date.parse(record.updatedAt)) throw new Error('Compilation clock moved backwards')
  if (event.type === 'compilation-attempt-started') {
    if (record.status === 'attempting') {
      if (event.attemptId !== record.attempts.at(-1)?.id) throw new CompilationConflictError()
      return { record, duplicate: true }
    }
    if ((record.status !== 'ready' && record.status !== 'repair') || record.attempts.length >= 2 || record.cursor.phase === 'finished') throw new Error('Compiler attempt cannot be resampled')
    const number = (record.attempts.length + 1) as 1 | 2
    if (event.attemptId !== attemptId(record, number)) throw new CompilationConflictError()
    record.attempts.push({ id: event.attemptId, number, phase: record.cursor.phase, status: 'intended', createdAt: at })
    record.status = 'attempting'
  } else if (event.type === 'compilation-attempt-completed') {
    const attempt = record.attempts.find(attempt => attempt.id === event.request.attemptId)
    if (!attempt) throw new Error('Unknown compiler attempt')
    if (attempt.status === 'evaluated') {
      if (canonicalJson(attempt.result) !== canonicalJson(event.request.result) || canonicalJson(attempt.evaluation) !== canonicalJson(event.evaluation)) throw new CompilationConflictError()
      const expected = attempt.evaluation?.disposition === 'compiled' ? record.admissionIntent : undefined
      if ((expected === undefined) !== (event.admissionIntent === undefined) || (expected && canonicalJson(admissionIntentInputSchema.parse(expected)) !== canonicalJson(event.admissionIntent))) throw new CompilationConflictError()
      return { record, duplicate: true }
    }
    if (record.status !== 'attempting' || record.attempts.at(-1)?.id !== attempt.id) throw new Error('Terminal compilation is immutable')
    const computed = evaluationFor(record, event.request.result)
    if (canonicalJson(computed) !== canonicalJson({ evaluation: event.evaluation, ...(event.admissionIntent ? { admissionIntent: event.admissionIntent } : {}) })) throw new Error('Compiler evaluation or admission pins do not match native replay')
    attempt.status = 'evaluated'; attempt.result = event.request.result; attempt.evaluation = computed.evaluation; attempt.completedAt = at
    record.cursor = computed.evaluation.cursor
    record.status = computed.evaluation.disposition === 'compiled' ? 'compiled' : computed.evaluation.disposition === 'schema-repair' ? 'repair' : 'rejected'
    if (computed.admissionIntent) record.admissionIntent = computed.admissionIntent
  } else if (event.type === 'compilation-admission-recorded') {
    if (record.admissionReceipt) {
      if (canonicalJson(record.admissionReceipt) !== canonicalJson(event.request.receipt)) throw new CompilationConflictError()
      return { record, duplicate: true }
    }
    if (record.status !== 'compiled' || !record.admissionIntent) throw new Error('Compilation has no admissible native result')
    const intent = planAdmission(record.admissionIntent), spec = intent.spec, receipt = event.request.receipt
    assertAdmissionMatchesSpec(receipt, spec)
    const expected = { schemaVersion: 1, id: intent.admissionId, projectId: record.projectId, policyRevision: spec.policyRevision, source: spec.source,
      specId: spec.id, specDigest: spec.specDigest, policyDigest: spec.policyDigest, workflowId: intent.workflowId, workflowDigest: spec.workflowDigest,
      taskIds: intent.plannedSteps.map(step => step.taskId), state: 'acknowledged', revision: 3 }
    if (canonicalJson(receipt) !== canonicalJson(expected)) throw new CompilationConflictError()
    record.admissionReceipt = receipt; record.status = 'admitted'
  } else {
    if (record.status === 'quarantined' && record.quarantineReason === event.request.reason && record.healthEscalationId === event.request.healthEscalationId) return { record, duplicate: true }
    if (record.status === 'admitted' || record.status === 'quarantined') throw new Error('Terminal compilation is immutable')
    record.status = 'quarantined'; record.quarantineReason = event.request.reason; record.healthEscalationId = event.request.healthEscalationId
  }
  record.revision++; record.updatedAt = at
  return { record, duplicate: false }
}
function reduce(options: z.output<typeof optionsSchema>, state: CompilationState, raw: unknown): CompilationState {
  const event = parse(eventSchema, raw), { hash, ...unsigned } = event
  if (event.previousHash !== state.head || digestJson(unsigned) !== hash) throw new Error('Compilation journal hash chain mismatch')
  const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1
  if (bytes !== event.storageBytes || bytes > options.maxRecordBytes || state.journalBytes > options.maxJournalBytes - bytes) throw new Error('Compilation journal capacity exceeded')
  const next = structuredClone(state)
  apply(options, next, event, event.createdAt)
  if (state.journalBytes + bytes > options.maxJournalBytes - reservedBytes(options, next)) throw new Error('Compilation journal capacity exceeded')
  return { ...next, revision: event.sequence, head: hash, journalBytes: state.journalBytes + bytes }
}
const initial = (): CompilationState => ({ revision: 0, head: null, journalBytes: 0, compilations: [] })
function parseLine(line: string): unknown {
  const event = parseStrictJson(line, hardRecordBytes)
  if (JSON.stringify(event) !== line) throw new Error('Noncanonical compilation journal encoding')
  return event
}
export class DarkFactoryCompilationStore {
  private constructor(private readonly journal: DurableJournal<CompilationState, Event>, private readonly options: z.output<typeof optionsSchema>, private readonly clock: () => string) {}
  static async open(directory: string, raw: CompilationStoreOptions, clock: () => string = () => new Date().toISOString()) {
    const options = optionsFor(raw), partition = await ensureFactoryDirectory(directory, options.projectId)
    let journal: DurableJournal<CompilationState, Event> | undefined
    try {
      journal = await openFactoryOwnedJournal<CompilationState, Event>(join(partition.descriptorPath, 'compilation.jsonl'), initial(), (state, event) => reduce(options, state, event), parseLine, options)
      await partition.close()
      return new DarkFactoryCompilationStore(journal, options, clock)
    } catch (error) { await journal?.close(); throw error } finally { await partition.close() }
  }
  static async migrate(directory: string, raw: CompilationStoreOptions, migration: FactoryJournalMigration<CompilationState>) {
    const options = optionsFor(raw), partition = await ensureFactoryDirectory(directory, options.projectId)
    try { return await migrateFactoryOwnedJournal<CompilationState, Event>(join(partition.descriptorPath, 'compilation.jsonl'), initial(), (state, event) => reduce(options, state, event), parseLine, options, migration, partition.path) }
    finally { await partition.close() }
  }
  private async append(make: (state: CompilationState) => Payload): Promise<CompilationResult> {
    let result!: CompilationResult
    await this.journal.append((state, sequence) => {
      const payload = make(state), createdAt = parse(timestampSchema, this.clock())
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
  async begin(raw: z.input<typeof beginCompilationRequestSchema>) { const request = parse(beginCompilationRequestSchema, raw); return this.append(() => ({ type: 'compilation-began', request })) }
  async startAttempt(raw: z.input<typeof startCompilationAttemptRequestSchema>) {
    const request = parse(startCompilationAttemptRequestSchema, raw)
    return this.append(state => {
      const record = recordFor(state, request.compilationId)
      return { type: 'compilation-attempt-started', request, attemptId: record.status === 'attempting' ? record.attempts.at(-1)!.id : attemptId(record, record.attempts.length + 1) }
    })
  }
  async completeAttempt(raw: z.input<typeof completeCompilationAttemptRequestSchema>) {
    const request = parse(completeCompilationAttemptRequestSchema, raw)
    if (request.result.kind === 'proposal') request.result = normalizeCompilerResult(request.result.proposal)
    return this.append(state => {
      const record = recordFor(state, request.compilationId), attempt = record.attempts.find(attempt => attempt.id === request.attemptId)
      if (!attempt) throw new Error('Unknown compiler attempt')
      const payload = completionFor(this.options, record, request)
      if (attempt.status === 'evaluated') {
        if (canonicalJson(attempt.result) !== canonicalJson(payload.request.result)) throw new CompilationConflictError()
      }
      return payload
    })
  }
  async recordAdmission(raw: z.input<typeof recordCompilationAdmissionRequestSchema>) { const request = parse(recordCompilationAdmissionRequestSchema, raw); return this.append(() => ({ type: 'compilation-admission-recorded', request })) }
  async quarantine(raw: z.input<typeof quarantineCompilationRequestSchema>) { const request = parse(quarantineCompilationRequestSchema, raw); return this.append(() => ({ type: 'compilation-quarantined', request })) }
  snapshot(): CompilationState { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }
}
