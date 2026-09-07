/** Host-only durable custody. Receiving authenticated bytes never grants task dispatch authority. */
import { join } from 'node:path'
import { ensureFactoryDirectory } from './paths.ts'
import z from 'zod'
import { DurableJournal } from '../durable-journal.ts'
import { openFactoryOwnedJournal, migrateFactoryOwnedJournal, type FactoryJournalMigration } from './owned-journal.ts'
import { counterSchema, idSchema, revisionSchema, digestSchema, timestampSchema } from './contracts/common.ts'
import { inboundEnvelopeSchema, inboundWorkItemSchema, ingressReceiptSchema, assertIngestionTransition, assertIngressOrigin } from './contracts/ingestion.ts'
import { assertContractSemantics } from './contracts/semantics.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'

export class IngressEscalationRequiredError extends Error {
  constructor(readonly code: 'DELIVERY_CONFLICT_REQUIRES_ESCALATION' | 'SOURCE_CHANGE_REQUIRES_ESCALATION' | 'QUARANTINE_REQUIRES_ESCALATION' | 'ATTACHMENT_CONFLICT_REQUIRES_ESCALATION') { super('Quarantine requires a durable health escalation reference') }
}
const hardRecordBytes = 16_777_216
const limitsSchema = z.strictObject({
  projectId: idSchema, maxBodyBytes: revisionSchema.max(hardRecordBytes).default(1_048_576),
  maxQueueItems: revisionSchema.max(100_000).default(10_000), maxRecordBytes: revisionSchema.max(hardRecordBytes).default(hardRecordBytes),
  maxJournalBytes: revisionSchema.default(1_073_741_824),
}).refine(value => value.maxJournalBytes >= value.maxRecordBytes)
export type IngestionStoreOptions = z.input<typeof limitsSchema>
export const recordReceivedRequestSchema = z.strictObject({
  envelope: inboundEnvelopeSchema, bodySizeBytes: counterSchema, item: inboundWorkItemSchema.optional(), healthEscalationId: idSchema.optional(), quarantineReason: idSchema.optional(),
})
export const ingressTransitionRequestSchema = z.strictObject({ projectId: idSchema, expectedRevision: revisionSchema, item: inboundWorkItemSchema })
const custodySchema = z.strictObject({ envelope: inboundEnvelopeSchema, receipt: ingressReceiptSchema, itemId: idSchema.optional(), healthEscalationId: idSchema.optional(), quarantineReason: idSchema.optional() })
const resultSchema = z.strictObject({ receipt: ingressReceiptSchema, duplicate: z.boolean(), conflict: z.boolean(), itemId: idSchema.optional(), healthEscalationId: idSchema.optional(), quarantineReason: idSchema.optional() })
export type IngressCustodyResult = z.output<typeof resultSchema>
type Item = z.output<typeof inboundWorkItemSchema>
type Custody = z.output<typeof custodySchema>
type Request = z.output<typeof recordReceivedRequestSchema>
export const reconciliationReasonSchema = z.enum(['FETCH_STARTED', 'AUTHORITY_UNRESOLVED', 'RECONCILED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_RESPONSE_INVALID', 'SOURCE_DENIED', 'SOURCE_CHANGED', 'RECONCILIATION_EXHAUSTED', 'RECONCILIATION_COMPLETE', 'ARTIFACT_UNAVAILABLE', 'ATTACHMENT_CONFLICT'])
const storeFence = { projectId: idSchema, expectedRevision: counterSchema, envelopeId: idSchema }
export const attachIngressItemRequestSchema = z.strictObject({ ...storeFence, item: inboundWorkItemSchema, healthEscalationId: idSchema.optional() })
export const beginReconciliationRequestSchema = z.strictObject({ ...storeFence, at: timestampSchema })
export const finishReconciliationRequestSchema = z.strictObject({ ...storeFence, attempt: revisionSchema.max(3), outcome: z.enum(['retry', 'resolved', 'quarantined']), at: timestampSchema, reason: reconciliationReasonSchema, healthEscalationId: idSchema.optional() })
export const pendingReconciliationsRequestSchema = z.strictObject({ projectId: idSchema, at: timestampSchema, limit: revisionSchema.max(100), routeIds: z.array(idSchema).max(256).refine(ids => new Set(ids).size === ids.length).optional() })
export const reconciliationCursorSchema = z.strictObject({
  projectId: idSchema, envelopeId: idSchema, revision: revisionSchema, attempts: revisionSchema.max(3),
  lastAttemptAt: timestampSchema, nextAttemptAt: timestampSchema, lastReason: reconciliationReasonSchema,
  status: z.enum(['pending', 'resolved', 'quarantined']), completedAt: timestampSchema.optional(), healthEscalationId: idSchema.optional(),
})
export const attachmentReceiptSchema = z.strictObject({
  id: idSchema, projectId: idSchema, envelopeId: idSchema, itemDigest: digestSchema, itemId: idSchema.optional(),
  decision: z.enum(['attached', 'quarantined']), reason: reconciliationReasonSchema.optional(), healthEscalationId: idSchema.optional(),
})
export type ReconciliationCursor = z.output<typeof reconciliationCursorSchema>
export type IngressAttachmentReceipt = z.output<typeof attachmentReceiptSchema>
export interface IngressAttachmentResult { receipt: IngressAttachmentReceipt; item?: Item; duplicate: boolean }
type AttachmentRequest = z.output<typeof attachIngressItemRequestSchema>
const retryMilliseconds = 300_000
interface State { revision: number; journalBytes: number; head: string | null; custody: Custody[]; items: Item[]; attachments: IngressAttachmentReceipt[]; reconciliations: ReconciliationCursor[]; aliases: { key: string; custodyId: string }[]; audits: { id: string; receiptId: string; duplicate: boolean; conflict: boolean }[] }
const common = { version: z.literal(1), sequence: revisionSchema, previousHash: digestSchema.nullable(), hash: digestSchema, createdAt: timestampSchema, storageBytes: revisionSchema }
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('received'), request: recordReceivedRequestSchema, result: resultSchema }),
  z.strictObject({ ...common, type: z.literal('transition'), request: ingressTransitionRequestSchema }),
  z.strictObject({ ...common, type: z.literal('attached'), request: attachIngressItemRequestSchema, comparisonVersion: z.literal(2).optional() }),
  z.strictObject({ ...common, type: z.literal('reconciliation-began'), request: beginReconciliationRequestSchema }),
  z.strictObject({ ...common, type: z.literal('reconciliation-finished'), request: finishReconciliationRequestSchema }),
])
type Event = z.output<typeof eventSchema>
type EventPayload = Event extends infer E ? E extends Event ? Omit<E, keyof typeof common> : never : never
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { try { return schema.parse(parseStrictJson(canonicalJson(raw), hardRecordBytes)) } catch { throw new Error('Invalid ingress authority input: strict bounded JSON required') } }
function deliveryKey(envelope: Request['envelope']): string { return canonicalJson(envelope.authentication === 'provider-api' ? ['provider-api', envelope.source, envelope.routeId, envelope.deliveryId] : [envelope.source, envelope.routeId, envelope.deliveryId]) }
function bodyKey(envelope: Request['envelope']): string { return canonicalJson(envelope.authentication === 'provider-api' ? ['provider-api', envelope.source, envelope.routeId, envelope.bodyDigest] : [envelope.source, envelope.routeId, envelope.bodyDigest]) }
function workKey(item: Item): string { return canonicalJson([item.projectId, item.source, item.sourceEntityId, item.sourceRevision]) }
function project(input: { projectId: string }, limits: z.output<typeof limitsSchema>): void { if (input.projectId !== limits.projectId) throw new Error('Cross-project ingress authority denied') }
function initialItem(item: Item, envelope: Request['envelope']): void {
  assertContractSemantics('InboundWorkItemV1', item)
  if (item.projectId !== envelope.projectId || item.policyRevision !== envelope.policyRevision || item.envelopeId !== envelope.id || item.source !== envelope.source) throw new Error('Ingress item/envelope identity mismatch')
  assertIngressOrigin(item, envelope)
  if (item.state !== 'received' || item.revision !== 1 || item.trust.decision !== 'unresolved' || item.quarantineReason || item.healthEscalationId) throw new Error('Initial ingress item must be received with unresolved trust')
}
function receive(state: State, request: Request, sequence: number): { result: IngressCustodyResult; custody?: Custody; item?: Item; alias?: { key: string; custodyId: string } } {
  const { envelope, item } = request
  const alias = state.aliases.find(alias => alias.key === deliveryKey(envelope))
  const prior = alias && state.custody.find(custody => custody.receipt.id === alias.custodyId)
  const conflict = !!prior && prior.envelope.bodyDigest !== envelope.bodyDigest
  let existing: Custody | undefined
  if (conflict) existing = state.custody.find(custody => custody.quarantineReason === 'DELIVERY_ID_CONFLICT' && deliveryKey(custody.envelope) === deliveryKey(envelope) && custody.envelope.bodyDigest === envelope.bodyDigest)
  else existing = prior || state.custody.find(custody => custody.quarantineReason !== 'DELIVERY_ID_CONFLICT' && bodyKey(custody.envelope) === bodyKey(envelope))
  if (existing) return { result: { receipt: existing.receipt, duplicate: true, conflict, ...(existing.itemId ? { itemId: existing.itemId } : {}), ...(existing.healthEscalationId ? { healthEscalationId: existing.healthEscalationId, quarantineReason: existing.quarantineReason } : {}) }, ...(!alias && !conflict ? { alias: { key: deliveryKey(envelope), custodyId: existing.receipt.id } } : {}) }
  if (state.custody.some(custody => custody.envelope.id === envelope.id)) throw new Error('Immutable envelope ID reused for different custody')
  const existingWork = item && state.items.find(candidate => workKey(candidate) === workKey(item))
  const activePriorRevision = item && !existingWork && state.items.some(candidate => candidate.source === item.source && candidate.sourceEntityId === item.sourceEntityId && !['acknowledged', 'quarantined'].includes(candidate.state))
  const quarantineReason = conflict ? 'DELIVERY_ID_CONFLICT' : activePriorRevision ? 'SOURCE_CHANGED' : request.quarantineReason
  if (quarantineReason && !request.healthEscalationId) throw new IngressEscalationRequiredError(conflict ? 'DELIVERY_CONFLICT_REQUIRES_ESCALATION' : activePriorRevision ? 'SOURCE_CHANGE_REQUIRES_ESCALATION' : 'QUARANTINE_REQUIRES_ESCALATION')
  let newItem: Item | undefined = !conflict && !existingWork ? item : undefined
  if (newItem && state.items.some(candidate => candidate.id === newItem!.id)) throw new Error('Immutable work item ID reused')
  if (newItem && quarantineReason) newItem = { ...newItem, state: 'quarantined', quarantineReason, healthEscalationId: request.healthEscalationId }
  const itemId = existingWork?.id ?? newItem?.id
  const receipt = ingressReceiptSchema.parse({ schemaVersion: 1, id: `ingress:${sequence}`, projectId: envelope.projectId, policyRevision: envelope.policyRevision, envelopeId: envelope.id, bodyDigest: envelope.bodyDigest, receivedAt: envelope.receivedAt, duplicateCount: 0, decision: quarantineReason ? 'quarantined' : 'received' })
  const custody = custodySchema.parse({ envelope, receipt, ...(itemId ? { itemId } : {}), ...(quarantineReason ? { quarantineReason, healthEscalationId: request.healthEscalationId } : {}) })
  return { result: { receipt, duplicate: false, conflict, ...(itemId ? { itemId } : {}), ...(quarantineReason ? { quarantineReason, healthEscalationId: request.healthEscalationId } : {}) }, custody, ...(newItem ? { item: newItem } : {}),
    ...(!conflict ? { alias: { key: deliveryKey(envelope), custodyId: receipt.id } } : {}) }
}
function fencedCustody(state: State, request: z.output<typeof beginReconciliationRequestSchema> | AttachmentRequest | z.output<typeof finishReconciliationRequestSchema>, limits: z.output<typeof limitsSchema>): Custody {
  project(request, limits)
  if (request.expectedRevision !== state.revision) throw new Error('Stale ingress store revision')
  const custody = state.custody.find(entry => entry.envelope.id === request.envelopeId)
  if (!custody || custody.receipt.decision !== 'received' || custody.quarantineReason) throw new Error('Successful ingress custody required')
  return custody
}
function executionDigest(item: Item, scannerComparison = false): string {
  const { id, envelopeId, provenance, trust, revision, state, quarantineReason, healthEscalationId, ...content } = item
  if (scannerComparison) { const { actor, initiator, ...execution } = content; return digestJson(execution) }
  return digestJson(content)
}
function attach(state: State, request: AttachmentRequest, sequence: number, limits: z.output<typeof limitsSchema>, comparisonVersion?: 2): IngressAttachmentResult {
  const custody = fencedCustody(state, request, limits)
  initialItem(request.item, custody.envelope)
  if (!request.item.provenance.some(ref => canonicalJson(ref) === canonicalJson(custody.envelope.artifact))) throw new Error('Ingress attachment custody provenance mismatch')
  const itemDigest = digestJson(request.item)
  const previous = state.attachments.find(receipt => receipt.envelopeId === request.envelopeId && receipt.itemDigest === itemDigest)
  if (previous) {
    const item = state.items.find(item => item.id === previous.itemId)
    return { receipt: previous, ...(item ? { item } : {}), duplicate: true }
  }
  if (state.reconciliations.some(cursor => cursor.envelopeId === request.envelopeId && cursor.status !== 'pending') || state.attachments.some(receipt => receipt.envelopeId === request.envelopeId && receipt.decision === 'quarantined')) throw new Error('Quarantined ingress attachment is immutable')
  const sameWork = state.items.find(item => workKey(item) === workKey(request.item))
  const original = state.items.find(item => item.id === custody.itemId)
  const scannerComparison = comparisonVersion === 2 && !!(sameWork?.initiator || request.item.initiator)
  const changedSource = !sameWork && state.items.some(item => item.source === request.item.source && item.sourceEntityId === request.item.sourceEntityId && !['acknowledged', 'quarantined'].includes(item.state))
  const conflict = !!original || !!sameWork && (sameWork.state === 'quarantined' || executionDigest(sameWork, scannerComparison) !== executionDigest(request.item, scannerComparison)) || state.items.some(item => item.id === request.item.id && workKey(item) !== workKey(request.item))
  const reason = changedSource ? 'SOURCE_CHANGED' as const : conflict ? 'ATTACHMENT_CONFLICT' as const : undefined
  if (reason && !request.healthEscalationId) throw new IngressEscalationRequiredError(changedSource ? 'SOURCE_CHANGE_REQUIRES_ESCALATION' : 'ATTACHMENT_CONFLICT_REQUIRES_ESCALATION')
  const receipt: IngressAttachmentReceipt = {
    id: `attachment:${sequence}`, projectId: request.projectId, envelopeId: request.envelopeId, itemDigest,
    decision: reason ? 'quarantined' : 'attached', ...(reason ? { reason, healthEscalationId: request.healthEscalationId! } : { itemId: sameWork?.id ?? request.item.id }),
  }
  state.attachments.push(receipt)
  if (reason) return { receipt, duplicate: false }
  const item = sameWork ?? request.item
  if (!sameWork) state.items.push(item)
  custody.itemId = item.id
  return { receipt, item, duplicate: !!sameWork }
}
function nextAttemptAt(at: string): string {
  const value = new Date(Date.parse(at) + retryMilliseconds)
  if (!Number.isFinite(value.getTime())) throw new Error('Invalid reconciliation deadline')
  return value.toISOString()
}
function reconcile(state: State, event: Extract<Event, { type: 'reconciliation-began' | 'reconciliation-finished' }>, limits: z.output<typeof limitsSchema>): void {
  const request = event.request
  const custody = fencedCustody(state, request, limits)
  if (Date.parse(request.at) < Date.parse(custody.envelope.receivedAt)) throw new Error('Reconciliation predates custody')
  const cursor = state.reconciliations.find(entry => entry.envelopeId === request.envelopeId)
  if (cursor && cursor.status !== 'pending') throw new Error('Terminal reconciliation is immutable')
  if (event.type === 'reconciliation-began') {
    if (state.attachments.some(receipt => receipt.envelopeId === request.envelopeId && receipt.decision === 'quarantined')) throw new Error('Quarantined ingress attachment is immutable')
    if (cursor && (cursor.attempts >= 3 || Date.parse(cursor.nextAttemptAt) > Date.parse(request.at))) throw new Error('Reconciliation attempt is not due or exhausted')
    const next: ReconciliationCursor = { projectId: request.projectId, envelopeId: request.envelopeId, revision: (cursor?.revision ?? 0) + 1, attempts: (cursor?.attempts ?? 0) + 1, lastAttemptAt: request.at, nextAttemptAt: nextAttemptAt(request.at), lastReason: 'FETCH_STARTED', status: 'pending' }
    state.reconciliations = [...state.reconciliations.filter(entry => entry.envelopeId !== request.envelopeId), next]
    return
  }
  const finish = event.request
  if (!cursor || cursor.attempts !== finish.attempt || cursor.completedAt || Date.parse(finish.at) < Date.parse(cursor.lastAttemptAt)) throw new Error('Stale reconciliation attempt')
  if (finish.outcome === 'retry' && !['PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_RESPONSE_INVALID'].includes(finish.reason) || finish.outcome === 'resolved' && !['RECONCILED', 'RECONCILIATION_COMPLETE'].includes(finish.reason) || finish.outcome === 'quarantined' && ['FETCH_STARTED', 'RECONCILED', 'RECONCILIATION_COMPLETE'].includes(finish.reason) || finish.outcome !== 'quarantined' && finish.healthEscalationId) throw new Error('Reconciliation outcome reason mismatch')
  if (finish.outcome === 'retry' && cursor.attempts >= 3) throw new Error('Exhausted reconciliation requires quarantine')
  if (finish.outcome === 'resolved') {
    const item = state.items.find(item => item.id === custody.itemId)
    if (!item || item.trust.decision !== 'trusted' || !['trusted', 'compiled', 'admitted', 'acknowledged'].includes(item.state)) throw new Error('Resolved reconciliation requires separately trusted work')
  }
  if (finish.outcome === 'quarantined' && !finish.healthEscalationId) throw new IngressEscalationRequiredError('QUARANTINE_REQUIRES_ESCALATION')
  Object.assign(cursor, { revision: cursor.revision + 1, status: finish.outcome === 'retry' ? 'pending' : finish.outcome, lastReason: finish.reason, completedAt: finish.at, nextAttemptAt: nextAttemptAt(finish.at), ...(finish.healthEscalationId ? { healthEscalationId: finish.healthEscalationId } : {}) })
}
function reduce(limits: z.output<typeof limitsSchema>, state: State, raw: unknown): State {
  const event = eventSchema.parse(raw)
  const { hash, ...unsigned } = event
  if (event.previousHash !== state.head || digestJson(unsigned) !== hash) throw new Error('Ingress journal hash chain mismatch')
  const measured = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1
  if (event.storageBytes !== measured || measured > limits.maxRecordBytes || measured > hardRecordBytes || state.journalBytes > limits.maxJournalBytes - measured) throw new Error('Ingress journal capacity exceeded')
  const next = structuredClone(state)
  if (event.type === 'received') {
    const { envelope, item } = event.request
    project(envelope, limits)
    assertContractSemantics('InboundEnvelopeV1', envelope)
    if (envelope.authentication === 'provider-api' && event.request.bodySizeBytes !== envelope.artifact.sizeBytes) throw new Error('Provider-read observation byte size mismatch')
    if (event.request.bodySizeBytes > limits.maxBodyBytes) throw new Error('Ingress body capacity exceeded')
    if (item) initialItem(item, envelope)
    const outcome = receive(next, event.request, event.sequence)
    if (canonicalJson(outcome.result) !== canonicalJson(event.result)) throw new Error('Ingress custody receipt mismatch')
    if (outcome.custody) {
      const pending = next.custody.filter(custody => !custody.quarantineReason && !next.reconciliations.some(cursor => cursor.envelopeId === custody.envelope.id && cursor.status === 'quarantined') && (!custody.itemId || !['acknowledged', 'quarantined'].includes(next.items.find(item => item.id === custody.itemId)?.state ?? 'received'))).length
      if (!outcome.custody.quarantineReason && pending >= limits.maxQueueItems) throw new Error('Ingress queue capacity exceeded')
      next.custody.push(outcome.custody)
    }
    if (outcome.item) next.items.push(outcome.item)
    if (outcome.alias) next.aliases.push(outcome.alias)
    next.audits.push({ id: `observation:${event.sequence}`, receiptId: outcome.result.receipt.id, duplicate: outcome.result.duplicate, conflict: outcome.result.conflict })
  } else if (event.type === 'attached') {
    attach(next, event.request, event.sequence, limits, event.comparisonVersion)
  } else if (event.type === 'reconciliation-began' || event.type === 'reconciliation-finished') {
    reconcile(next, event, limits)
  } else {
    project(event.request, limits)
    const from = next.items.find(item => item.id === event.request.item.id)
    if (!from || from.revision !== event.request.expectedRevision) throw new Error('Stale ingress item revision')
    assertIngestionTransition(from, event.request.item)
    next.items = next.items.map(item => item.id === from.id ? event.request.item : item)
  }
  return { ...next, revision: event.sequence, head: hash, journalBytes: state.journalBytes + measured }
}
export class DarkFactoryIngestionStore {
  private constructor(private readonly journal: DurableJournal<State, Event>, private readonly clock: () => string, private readonly limits: z.output<typeof limitsSchema>) {}
  static async open(directory: string, raw: IngestionStoreOptions, clock: () => string = () => new Date().toISOString()): Promise<DarkFactoryIngestionStore> {
    const options = parse(limitsSchema, raw)
    const partition = await ensureFactoryDirectory(directory, options.projectId)
    let journal: DurableJournal<State, Event> | undefined
    try {
      journal = await openFactoryOwnedJournal<State, Event>(join(partition.descriptorPath, 'ingestion.jsonl'), { revision: 0, journalBytes: 0, head: null, custody: [], items: [], attachments: [], reconciliations: [], aliases: [], audits: [] }, (state, event) => reduce(options, state, event), line => { const event = parseStrictJson(line, hardRecordBytes); if (JSON.stringify(event) !== line) throw new Error('Noncanonical ingress journal encoding'); return event }, { maxRecordBytes: options.maxRecordBytes, maxJournalBytes: options.maxJournalBytes })
      await partition.close()
      return new DarkFactoryIngestionStore(journal, clock, options)
    } catch (error) { await journal?.close(); throw error } finally { await partition.close() }
  }

  /** Offline layout migration. Native replay and host reference validation must both succeed. */
  static async migrate(directory: string, raw: IngestionStoreOptions, migration: FactoryJournalMigration<State>) {
    const options = parse(limitsSchema, raw), partition = await ensureFactoryDirectory(directory, options.projectId)
    try {
      return await migrateFactoryOwnedJournal<State, Event>(join(partition.descriptorPath, 'ingestion.jsonl'), { revision: 0, journalBytes: 0, head: null, custody: [], items: [], attachments: [], reconciliations: [], aliases: [], audits: [] },
        (state, event) => reduce(options, state, event), line => { const event = parseStrictJson(line, hardRecordBytes); if (JSON.stringify(event) !== line) throw new Error('Noncanonical ingress journal encoding'); return event },
        { maxRecordBytes: options.maxRecordBytes, maxJournalBytes: options.maxJournalBytes }, migration, partition.path)
    } finally { await partition.close() }
  }

  private append(make: (state: State, sequence: number) => EventPayload): Promise<State> {
    return this.journal.append((state, sequence) => {
      const payload = { ...make(state, sequence), version: 1 as const, sequence, previousHash: state.head, createdAt: timestampSchema.parse(this.clock()), storageBytes: 1 }
      let event: Event
      // Decimal length stabilizes in a handful of iterations; hash width is fixed.
      for (;;) {
        event = { ...payload, hash: digestJson(payload) } as Event
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
        if (bytes === payload.storageBytes) return event
        payload.storageBytes = bytes
      }
    })
  }
  async recordReceived(raw: z.input<typeof recordReceivedRequestSchema>): Promise<IngressCustodyResult> {
    const request = parse(recordReceivedRequestSchema, raw)
    let result!: IngressCustodyResult
    await this.append((state, sequence) => { result = receive(state, request, sequence).result; return { type: 'received', request, result } })
    return structuredClone(result)
  }
  async transition(raw: z.input<typeof ingressTransitionRequestSchema>): Promise<Item> {
    const request = parse(ingressTransitionRequestSchema, raw)
    const state = await this.append(() => ({ type: 'transition', request }))
    return state.items.find(item => item.id === request.item.id)!
  }
  async attachItem(raw: z.input<typeof attachIngressItemRequestSchema>): Promise<IngressAttachmentResult> {
    const request = parse(attachIngressItemRequestSchema, raw)
    let result!: IngressAttachmentResult
    await this.append((state, sequence) => { result = attach(structuredClone(state), request, sequence, this.limits, 2); return { type: 'attached', request, comparisonVersion: 2 } })
    return structuredClone(result)
  }
  async beginReconciliation(raw: z.input<typeof beginReconciliationRequestSchema>): Promise<ReconciliationCursor> {
    const request = parse(beginReconciliationRequestSchema, raw)
    const state = await this.append(() => ({ type: 'reconciliation-began', request }))
    return state.reconciliations.find(cursor => cursor.envelopeId === request.envelopeId)!
  }
  async finishReconciliation(raw: z.input<typeof finishReconciliationRequestSchema>): Promise<ReconciliationCursor> {
    const request = parse(finishReconciliationRequestSchema, raw)
    const state = await this.append(() => ({ type: 'reconciliation-finished', request }))
    return state.reconciliations.find(cursor => cursor.envelopeId === request.envelopeId)!
  }
  pendingReconciliations(raw: z.input<typeof pendingReconciliationsRequestSchema>): { custody: Custody; cursor?: ReconciliationCursor }[] {
    const request = parse(pendingReconciliationsRequestSchema, raw)
    project(request, this.limits)
    const state = this.snapshot()
    return state.custody.flatMap(custody => {
      if (custody.receipt.decision !== 'received' || custody.quarantineReason || request.routeIds && !request.routeIds.includes(custody.envelope.routeId)) return []
      const cursor = state.reconciliations.find(entry => entry.envelopeId === custody.envelope.id)
      if (cursor && (cursor.status !== 'pending' || Date.parse(cursor.nextAttemptAt) > Date.parse(request.at))) return []
      if (!cursor && Date.parse(custody.envelope.receivedAt) > Date.parse(request.at)) return []
      return [{ custody, ...(cursor ? { cursor } : {}) }]
    }).sort((a, b) => Date.parse(a.cursor?.nextAttemptAt ?? a.custody.envelope.receivedAt) - Date.parse(b.cursor?.nextAttemptAt ?? b.custody.envelope.receivedAt) || a.custody.receipt.id.localeCompare(b.custody.receipt.id)).slice(0, request.limit)
  }
  snapshot(): State { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }
}
