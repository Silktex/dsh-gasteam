/** Host-only policy authority. A decision is an audit receipt, never an external-effect completion receipt. */
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from '../durable-journal.ts'
import { openFactoryOwnedJournal, migrateFactoryOwnedJournal, type FactoryJournalMigration } from './owned-journal.ts'
import { openFactoryRoot } from './paths.ts'
import { enabledDarkFactoryConfigSchema } from './config.ts'
import { counterSchema, digestSchema, idSchema, recordFields, revisionSchema, timestampSchema, uniqueIds } from './contracts/common.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'

export const pauseReasonSchema = z.enum(['manual', 'safety', 'budget', 'quota', 'catalog'])
export const factoryEffectSchema = z.enum(['ingress', 'build', 'paid-request', 'publish', 'deploy'])
export const rolloutGateSchema = z.enum(['observe', 'build', 'staging', 'production', 'healthy-qualification', 'rollback-qualification', 'adapter-conformance', 'reconciled', 'goal-0', 'goal-1', 'goal-2', 'goal-3', 'goal-4', 'goal-5'])
const operator = { operatorId: idSchema, authorizationRef: idSchema }
const fence = { projectId: idSchema, expectedRevision: counterSchema }
export const installPolicyRequestSchema = z.strictObject({ ...fence, ...operator, policy: enabledDarkFactoryConfigSchema })
export const recordGateRequestSchema = z.strictObject({ ...fence, ...operator, policyRevision: revisionSchema, gate: rolloutGateSchema, evidenceRefs: uniqueIds().min(1) })
export const controlPolicyRequestSchema = z.strictObject({ ...fence, ...operator, action: z.enum(['pause', 'resume', 'disable', 'enable', 'revoke']), reason: pauseReasonSchema.optional(), evidenceRefs: uniqueIds().default([]) }).superRefine((value, ctx) => {
  if ((value.action === 'pause' || value.action === 'resume') !== (value.reason !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only pause/resume require a pause reason' })
  if (value.action === 'enable' && value.evidenceRefs.length === 0) ctx.addIssue({ code: 'custom', message: 'Enable requires reconciliation evidence' })
})
export const decideEffectRequestSchema = z.strictObject({ ...fence, policyRevision: revisionSchema, effect: factoryEffectSchema, effectId: idSchema })
export const policyRecordSchema = z.strictObject({ ...recordFields, digest: digestSchema, policy: enabledDarkFactoryConfigSchema, ...operator, createdAt: timestampSchema })
export const gateReceiptSchema = z.strictObject({ ...recordFields, ...operator, gate: rolloutGateSchema, policyDigest: digestSchema, evidenceRefs: uniqueIds().min(1), createdAt: timestampSchema })
export const effectDecisionReceiptSchema = z.strictObject({ ...recordFields, effect: factoryEffectSchema, effectId: idSchema, policyDigest: digestSchema, decision: z.enum(['allow', 'deny']), reasons: z.array(idSchema).max(16), authorityRef: idSchema.nullable(), implementationAvailable: z.boolean(), createdAt: timestampSchema })
const optionsSchema = z.strictObject({
  grants: z.array(z.strictObject({ projectId: idSchema, operatorIds: uniqueIds().min(1), authorizationRefs: uniqueIds().min(1) })).max(256),
  effectGrants: z.array(z.strictObject({ projectId: idSchema, effect: factoryEffectSchema, authorizationRef: idSchema })).max(1024).default([]),
  implementedEffects: z.array(factoryEffectSchema).max(5).default([]),
})
export type PolicyStoreOptions = z.input<typeof optionsSchema>
export type PolicyRecord = z.output<typeof policyRecordSchema>
export type GateReceipt = z.output<typeof gateReceiptSchema>
export type EffectDecisionReceipt = z.output<typeof effectDecisionReceiptSchema>
export type PauseReason = z.output<typeof pauseReasonSchema>
export interface PolicyProjectState {
  projectId: string; revision: number; policies: PolicyRecord[]; gates: GateReceipt[]; decisions: EffectDecisionReceipt[]
  pauses: PauseReason[]; disabled: boolean; revoked: boolean; reconciliationRequired: boolean
}
const maximumJournalRecordBytes = 16_777_216
function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  try {
    return schema.parse(parseStrictJson(canonicalJson(raw), maximumJournalRecordBytes))
  } catch { throw new Error('Invalid Dark Factory authority input: strict bounded JSON required') }
}
interface State { projects: PolicyProjectState[]; head: string | null; bytes: number }
const eventFields = { version: z.literal(1), sequence: revisionSchema, previousHash: digestSchema.nullable(), hash: digestSchema, createdAt: timestampSchema }
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventFields, type: z.literal('policy'), request: installPolicyRequestSchema, record: policyRecordSchema }),
  z.strictObject({ ...eventFields, type: z.literal('gate'), request: recordGateRequestSchema, receipt: gateReceiptSchema }),
  z.strictObject({ ...eventFields, type: z.literal('control'), request: controlPolicyRequestSchema }),
  z.strictObject({ ...eventFields, type: z.literal('decision'), request: decideEffectRequestSchema, receipt: effectDecisionReceiptSchema }),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, keyof typeof eventFields> : never : never
function project(state: State, projectId: string): PolicyProjectState | undefined { return state.projects.find(item => item.projectId === projectId) }
function current(state: PolicyProjectState): PolicyRecord { const record = state.policies.at(-1); if (!record) throw new Error('Project policy is missing'); return record }
function assertFence(state: PolicyProjectState | undefined, revision: number): void { if ((state?.revision ?? 0) !== revision) throw new Error('Stale policy state revision') }
function reasons(state: PolicyProjectState, input: z.output<typeof decideEffectRequestSchema>, implemented: boolean, authorityRef: string | null): string[] {
  const policy = current(state)
  const denied: string[] = []
  if (state.disabled) denied.push('disabled')
  if (state.revoked) denied.push('revoked')
  if (state.reconciliationRequired) denied.push('reconciliation-required')
  if (input.policyRevision !== policy.policyRevision) denied.push('stale-policy')
  denied.push(...state.pauses.map(reason => `paused:${reason}`))
  if (!implemented) denied.push('unimplemented-effect')
  if (!authorityRef) denied.push('missing-effect-grant')
  const mode = policy.policy.mode
  if (mode === 'observe' && input.effect !== 'ingress') denied.push('observe-only')
  if (mode === 'build' && (input.effect === 'publish' || input.effect === 'deploy')) denied.push('build-release-held')
  if ((input.effect === 'publish' || input.effect === 'deploy') && !policy.policy.delivery.enabled) denied.push('delivery-disabled')
  const gates = state.gates.filter(gate => gate.policyRevision === policy.policyRevision).map(gate => gate.gate)
  if (!gates.includes(mode)) denied.push('missing-rollout-gate')
  if (mode === 'production' && ['healthy-qualification', 'rollback-qualification', 'adapter-conformance', 'goal-0', 'goal-1', 'goal-2', 'goal-3', 'goal-4', 'goal-5'].some(gate => !gates.includes(gate as z.output<typeof rolloutGateSchema>))) denied.push('missing-production-qualification')
  return denied
}
function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw)
  const { hash, ...unsigned } = event
  if (event.previousHash !== state.head || hash !== digestJson(unsigned)) throw new Error('Policy journal hash chain mismatch')
  const found = project(state, event.request.projectId)
  const configuredLimit = event.type === 'policy' ? event.request.policy.limits.maxJournalRecordBytes : found && current(found).policy.limits.maxJournalRecordBytes
  const eventBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1
  const journalLimit = event.type === 'policy' ? event.request.policy.limits.maxJournalBytes : found && current(found).policy.limits.maxJournalBytes
  if (journalLimit !== undefined && state.bytes > journalLimit - eventBytes) throw new Error('Policy journal aggregate byte limit exceeded')
  if (eventBytes > maximumJournalRecordBytes || (configuredLimit !== undefined && eventBytes > configuredLimit)) throw new Error('Policy journal record byte limit exceeded')
  assertFence(found, event.request.expectedRevision)
  const next = structuredClone(found ?? { projectId: event.request.projectId, revision: 0, policies: [], gates: [], decisions: [], pauses: [], disabled: false, revoked: false, reconciliationRequired: false })
  if (event.type === 'policy') {
    const { policy } = event.request
    if (!policy.projectIds.includes(next.projectId)) throw new Error('Policy does not authorize this project')
    if (policy.policyRevision <= (next.policies.at(-1)?.policyRevision ?? 0)) throw new Error('Policy revision must increase')
    const expected = { schemaVersion: 1, id: `policy:${event.sequence}`, projectId: next.projectId, policyRevision: policy.policyRevision, policy, digest: digestJson(policy), operatorId: event.request.operatorId, authorizationRef: event.request.authorizationRef, createdAt: event.createdAt }
    if (digestJson(expected) !== digestJson(event.record)) throw new Error('Policy receipt mismatch')
    next.policies.push(event.record)
    next.revoked = false
  } else {
    const policy = current(next)
    if (event.type === 'gate') {
      if (event.request.policyRevision !== policy.policyRevision) throw new Error('Gate references stale policy')
      const expected = { schemaVersion: 1, id: `gate:${event.sequence}`, projectId: next.projectId, policyRevision: policy.policyRevision, policyDigest: policy.digest, operatorId: event.request.operatorId, authorizationRef: event.request.authorizationRef, gate: event.request.gate, evidenceRefs: event.request.evidenceRefs, createdAt: event.createdAt }
      if (digestJson(expected) !== digestJson(event.receipt)) throw new Error('Gate receipt mismatch')
      if (next.gates.some(gate => gate.policyRevision === policy.policyRevision && gate.gate === event.request.gate)) throw new Error('Gate already recorded for immutable policy')
      next.gates.push(event.receipt)
    } else if (event.type === 'control') {
      const request = event.request
      if (request.action === 'pause') next.pauses = [...new Set([...next.pauses, request.reason!])]
      if (request.action === 'resume') next.pauses = next.pauses.filter(reason => reason !== request.reason)
      if (request.action === 'disable' || request.action === 'revoke') { next.disabled = true; next.reconciliationRequired = true; next.pauses = [...new Set([...next.pauses, 'safety' as const])] }
      if (request.action === 'revoke') next.revoked = true
      if (request.action === 'enable') {
        if (next.revoked) throw new Error('Revoked authority requires a new policy revision')
        if (!request.evidenceRefs.length) throw new Error('Reconciliation evidence required')
        next.disabled = false; next.reconciliationRequired = false
      }
    } else {
      const receipt = event.receipt
      const denied = reasons(next, event.request, receipt.implementationAvailable, receipt.authorityRef)
      const expected = { schemaVersion: 1, id: `decision:${event.sequence}`, projectId: next.projectId, policyRevision: policy.policyRevision, policyDigest: policy.digest, effect: event.request.effect, effectId: event.request.effectId, decision: denied.length ? 'deny' : 'allow', reasons: denied, authorityRef: receipt.authorityRef, implementationAvailable: receipt.implementationAvailable, createdAt: event.createdAt }
      if (digestJson(expected) !== digestJson(receipt)) throw new Error('Effect receipt mismatch')
      next.decisions.push(receipt)
    }
  }
  next.revision++
  return { projects: [...state.projects.filter(item => item.projectId !== next.projectId), next], head: hash, bytes: state.bytes + eventBytes }
}

/** Do not expose this owner through worker tools. Operators and effect capabilities originate in trusted host configuration. */
export class DarkFactoryPolicyStore {
  private constructor(private readonly journal: DurableJournal<State, Event>, private options: z.output<typeof optionsSchema>, private readonly clock: () => string) {}
  static async open(directory: string, options: PolicyStoreOptions, clock: () => string = () => new Date().toISOString()): Promise<DarkFactoryPolicyStore> {
    const parsed = parseInput(optionsSchema, options)
    const root = await openFactoryRoot(directory)
    let journal: DurableJournal<State, Event> | undefined
    try {
      journal = await openFactoryOwnedJournal<State, Event>(join(root.descriptorPath, 'darkfactory-policy.jsonl'), { projects: [], head: null, bytes: 0 }, reduce, line => { const event = parseStrictJson(line, maximumJournalRecordBytes); if (JSON.stringify(event) !== line) throw new Error('Noncanonical policy journal encoding'); return event }, { maxRecordBytes: maximumJournalRecordBytes, maxJournalBytes: Number.MAX_SAFE_INTEGER })
      await root.close()
      return new DarkFactoryPolicyStore(journal, parsed, clock)
    } catch (error) { await journal?.close(); throw error } finally { await root.close() }
  }

  /** Migrate the offline policy journal; authority grants are never inferred by replay. */
  static async migrate(directory: string, migration: FactoryJournalMigration<State>) {
    const root = await openFactoryRoot(directory)
    try {
      return await migrateFactoryOwnedJournal<State, Event>(join(root.descriptorPath, 'darkfactory-policy.jsonl'), { projects: [], head: null, bytes: 0 }, reduce,
        line => { const event = parseStrictJson(line, maximumJournalRecordBytes); if (JSON.stringify(event) !== line) throw new Error('Noncanonical policy journal encoding'); return event },
        { maxRecordBytes: maximumJournalRecordBytes, maxJournalBytes: Number.MAX_SAFE_INTEGER }, migration, root.path)
    } finally { await root.close() }
  }

  /** Replacing trusted host grants takes effect at the next effect boundary, including old attempts. */
  configureAuthority(raw: PolicyStoreOptions): void { this.options = parseInput(optionsSchema, raw) }
  private authorize(input: { projectId: string; operatorId: string; authorizationRef: string }): void {
    if (!this.options.grants.some(grant => grant.projectId === input.projectId && grant.operatorIds.includes(input.operatorId) && grant.authorizationRefs.includes(input.authorizationRef))) throw new Error('Operator authority denied')
  }
  private append(make: (state: State, sequence: number, createdAt: string) => Payload): Promise<State> {
    return this.journal.append((state, sequence) => {
      const createdAt = timestampSchema.parse(this.clock())
      const unsigned = { ...make(state, sequence, createdAt), createdAt, previousHash: state.head, version: 1 as const, sequence }
      return { ...unsigned, hash: digestJson(unsigned) } as Event
    })
  }
  async installPolicy(raw: z.input<typeof installPolicyRequestSchema>): Promise<PolicyRecord> {
    const request = parseInput(installPolicyRequestSchema, raw)
    const state = await this.append((state, sequence, createdAt) => {
      this.authorize(request); assertFence(project(state, request.projectId), request.expectedRevision)
      return { type: 'policy', request, record: { schemaVersion: 1, id: `policy:${sequence}`, projectId: request.projectId, policyRevision: request.policy.policyRevision, policy: request.policy, digest: digestJson(request.policy), operatorId: request.operatorId, authorizationRef: request.authorizationRef, createdAt } }
    })
    return current(project(state, request.projectId)!)
  }
  async recordGate(raw: z.input<typeof recordGateRequestSchema>): Promise<GateReceipt> {
    const request = parseInput(recordGateRequestSchema, raw)
    const state = await this.append((state, sequence, createdAt) => {
      this.authorize(request); const policy = current(project(state, request.projectId) ?? (() => { throw new Error('Unknown project') })())
      return { type: 'gate', request, receipt: { schemaVersion: 1, id: `gate:${sequence}`, projectId: request.projectId, policyRevision: request.policyRevision, policyDigest: policy.digest, operatorId: request.operatorId, authorizationRef: request.authorizationRef, gate: request.gate, evidenceRefs: request.evidenceRefs, createdAt } }
    })
    return project(state, request.projectId)!.gates.at(-1)!
  }
  async control(raw: z.input<typeof controlPolicyRequestSchema>): Promise<PolicyProjectState> {
    const request = parseInput(controlPolicyRequestSchema, raw)
    const state = await this.append(() => { this.authorize(request); return { type: 'control', request } })
    return project(state, request.projectId)!
  }
  async decideEffect(raw: z.input<typeof decideEffectRequestSchema>): Promise<EffectDecisionReceipt> {
    const request = parseInput(decideEffectRequestSchema, raw)
    const state = await this.append((state, sequence, createdAt) => {
      const found = project(state, request.projectId)
      if (!found) throw new Error('Unknown project')
      const policy = current(found)
      const authorityRef = this.options.effectGrants.find(grant => grant.projectId === request.projectId && grant.effect === request.effect)?.authorizationRef ?? null
      const implementationAvailable = this.options.implementedEffects.includes(request.effect)
      const denied = reasons(found, request, implementationAvailable, authorityRef)
      return { type: 'decision', request, receipt: { schemaVersion: 1, id: `decision:${sequence}`, projectId: request.projectId, policyRevision: policy.policyRevision, policyDigest: policy.digest, effect: request.effect, effectId: request.effectId, decision: denied.length ? 'deny' : 'allow', reasons: denied, authorityRef, implementationAvailable, createdAt } }
    })
    return project(state, request.projectId)!.decisions.at(-1)!
  }
  snapshot(): PolicyProjectState[] { return this.journal.snapshot().projects }
  close(): Promise<void> { return this.journal.close() }
}

/** Supporting authority shapes; these describe receipts, not runtime qualification. */
export function authorityJsonSchemas(): Record<string, z.core.JSONSchema.JSONSchema> {
  const schemas = { PolicyRecordV1: policyRecordSchema, GateReceiptV1: gateReceiptSchema, EffectDecisionReceiptV1: effectDecisionReceiptSchema,
    InstallPolicyRequest: installPolicyRequestSchema, RecordGateRequest: recordGateRequestSchema, ControlPolicyRequest: controlPolicyRequestSchema, DecideEffectRequest: decideEffectRequestSchema }
  return Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema as z.ZodType, { target: 'draft-2020-12' })]))
}
