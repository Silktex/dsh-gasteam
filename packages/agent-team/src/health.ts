/** Durable, observational attempt health and operator escalation state. */
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const workSchema = z.object({
  projectId: id, teamId: id, taskId: id,
  state: z.enum(['active', 'dependency-wait', 'operator-wait', 'failed', 'unavailable']),
}).strict()
const runtimeSchema = z.object({
  availability: z.enum(['available', 'unavailable', 'unknown']),
  /** `known-active-operation` requires provider evidence; a session sequence alone is never enough. */
  execution: z.enum(['known-active-operation', 'idle', 'waiting', 'failed', 'unknown']),
}).strict()
const progressSchema = z.object({ source: z.enum(['session-sequence', 'durable-checkpoint', 'provider']), cursor: z.string().trim().min(1).max(16_384) }).strict()
const observationSchema = z.object({
  attemptId: id, generation: positive, provider: z.enum(['dsh', 'external', 'unknown']), work: workSchema, runtime: runtimeSchema,
  progress: progressSchema.optional(), diagnostic: z.string().trim().min(1).max(16_384).optional(), evidenceRef: id.optional(),
}).strict()
const healthSchema = z.object({
  attemptId: id, generation: positive, provider: z.enum(['dsh', 'external', 'unknown']), work: workSchema,
  classification: z.enum(['progressing', 'idle', 'dependency-wait', 'operator-wait', 'stale', 'unavailable', 'failed']),
  certainty: z.enum(['known', 'uncertain']), deadlineMs: positive, escalationCooldownMs: time, maxEscalationsPerCondition: positive,
  deadlineAt: time, observedAt: time,
  lastProgress: progressSchema.extend({ observedAt: time }).strict().optional(), revision: positive,
  diagnostic: z.string().trim().min(1).max(16_384).optional(), evidenceRef: id.optional(),
  terminalClearance: z.object({ source: z.enum(['accepted-report', 'accepted-submission', 'accepted-integration']), receiptId: id, at: time }).strict().optional(),
}).strict()
const escalationSchema = z.object({
  id: id, attemptId: id, generation: positive, condition: z.enum(['stale', 'failed']),
  severity: z.enum(['warning', 'critical']), source: z.literal('health'), diagnostics: z.string().min(1).max(16_384), work: workSchema,
  revision: positive, cooldownUntil: time,
  acknowledgement: z.object({ actor: z.string().trim().min(1).max(512), at: time }).strict().optional(),
  resolution: z.object({ reason: z.enum(['condition-cleared', 'accepted-terminal']), source: z.enum(['health-observation', 'accepted-report', 'accepted-submission', 'accepted-integration']), at: time }).strict().optional(),
}).strict()
export const healthConfigSchema = z.object({
  dshDeadlineMs: positive, externalDeadlineMs: positive, escalationCooldownMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxEscalationsPerCondition: z.number().int().positive().max(100),
  /** Explicit host authorization for bounded live DSH recovery nudges. */
  recovery: z.object({ maxNudges: z.number().int().positive().max(3) }).strict().optional(),
}).strict()

export type AttemptHealthObservation = z.input<typeof observationSchema>
export type HealthConfig = z.input<typeof healthConfigSchema>
export type AttemptHealth = z.output<typeof healthSchema>
export type OperatorEscalation = z.output<typeof escalationSchema>
export interface HealthInboxRequest { readonly projectId: string }
export interface AcknowledgeHealthRequest extends HealthInboxRequest { readonly escalationId: string; readonly expectedRevision: number }

interface State { health: AttemptHealth[]; escalations: OperatorEscalation[] }
type Payload =
  | { type: 'health/observed'; observation: AttemptHealthObservation; observedAt: number; deadlineMs: number; escalationCooldownMs: number; maxEscalationsPerCondition: number }
  | { type: 'health/escalated'; attemptId: string; generation: number; condition: 'stale' | 'failed'; observedAt: number; cooldownUntil: number }
  | { type: 'health/escalation-acknowledged'; id: string; expectedRevision: number; actor: string; acknowledgedAt: number }
  | { type: 'health/escalation-resolved'; id: string; resolvedAt: number }
  | { type: 'health/attempt-cleared'; attemptId: string; generation: number; source: 'accepted-report' | 'accepted-submission' | 'accepted-integration'; receiptId: string; clearedAt: number }
type Event = Payload & { version: 1; sequence: number }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('health/observed'), observation: observationSchema, observedAt: time, deadlineMs: positive, escalationCooldownMs: time, maxEscalationsPerCondition: positive }).strict(),
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('health/escalated'), attemptId: id, generation: positive, condition: z.enum(['stale', 'failed']), observedAt: time, cooldownUntil: time }).strict(),
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('health/escalation-acknowledged'), id, expectedRevision: positive, actor: z.string().trim().min(1).max(512), acknowledgedAt: time }).strict(),
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('health/escalation-resolved'), id, resolvedAt: time }).strict(),
  z.object({ version: z.literal(1), sequence: positive, type: z.literal('health/attempt-cleared'), attemptId: id, generation: positive, source: z.enum(['accepted-report', 'accepted-submission', 'accepted-integration']), receiptId: id, clearedAt: time }).strict(),
])

function key(input: { attemptId: string; generation: number }): string { return `${input.attemptId}:${input.generation}` }
function safeAdd(left: number, right: number, label: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right) throw new Error(`${label} exceeds the safe integer range`)
  return left + right
}
function sameProgress(left: AttemptHealth['lastProgress'], right: AttemptHealthObservation['progress']): boolean {
  return left?.source === right?.source && left?.cursor === right?.cursor
}
function classify(record: Omit<AttemptHealth, 'classification' | 'certainty' | 'revision'>, runtime: z.output<typeof runtimeSchema>, now: number, changed: boolean): Pick<AttemptHealth, 'classification' | 'certainty'> {
  if (record.work.state === 'failed' || runtime.execution === 'failed') return { classification: 'failed', certainty: 'known' }
  if (record.work.state === 'dependency-wait') return { classification: 'dependency-wait', certainty: 'known' }
  if (record.work.state === 'operator-wait') return { classification: 'operator-wait', certainty: 'known' }
  if (record.work.state === 'unavailable' || runtime.availability !== 'available' || runtime.execution === 'unknown') return { classification: 'unavailable', certainty: 'uncertain' }
  if (changed) return { classification: 'progressing', certainty: 'known' }
  if (runtime.execution === 'known-active-operation' && now < record.deadlineAt) return { classification: 'progressing', certainty: 'known' }
  if (now >= record.deadlineAt) return { classification: 'stale', certainty: 'known' }
  return { classification: 'idle', certainty: 'known' }
}
function diagnostic(record: AttemptHealth): string {
  return record.classification === 'failed'
    ? `${record.diagnostic ?? `Attempt ${record.attemptId} has authoritative failure evidence.`}${record.evidenceRef ? ` [evidence: ${record.evidenceRef}]` : ''}`
    : `Attempt ${record.attemptId} has no authoritative progress since ${record.lastProgress?.observedAt ?? record.observedAt}; its pinned deadline ${record.deadlineAt} elapsed.`
}
function positiveRecovery(record: AttemptHealth): boolean {
  return ['progressing', 'dependency-wait', 'operator-wait'].includes(record.classification)
}

function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw) as Event
  if (event.type === 'health/observed') {
    const observation = event.observation
    const index = state.health.findIndex(record => key(record) === key(observation))
    const prior = state.health[index]
    if (prior && (prior.provider !== observation.provider || prior.work.projectId !== observation.work.projectId || prior.work.teamId !== observation.work.teamId || prior.work.taskId !== observation.work.taskId)) {
      throw new Error('Attempt health binding is immutable')
    }
    if (prior && event.observedAt < prior.observedAt) throw new Error('Attempt health clock moved backwards')
    // Absence means no new authoritative evidence. It must not extend an
    // already-pinned deadline on every patrol.
    const progressChanged = observation.progress !== undefined && !sameProgress(prior?.lastProgress, observation.progress)
    const lastProgress = observation.progress && progressChanged ? { ...observation.progress, observedAt: event.observedAt } : prior?.lastProgress
    const deadlineMs = prior?.deadlineMs ?? event.deadlineMs
    const deadlineAt = progressChanged || !prior ? safeAdd(event.observedAt, deadlineMs, 'Attempt deadline') : prior.deadlineAt
    const base = { attemptId: observation.attemptId, generation: observation.generation, provider: observation.provider, work: observation.work,
      deadlineMs, escalationCooldownMs: prior?.escalationCooldownMs ?? event.escalationCooldownMs,
      maxEscalationsPerCondition: prior?.maxEscalationsPerCondition ?? event.maxEscalationsPerCondition,
      deadlineAt, observedAt: event.observedAt, ...(lastProgress ? { lastProgress } : {}), ...(prior?.terminalClearance ? { terminalClearance: prior.terminalClearance } : {}),
      ...(observation.diagnostic === undefined ? prior?.diagnostic === undefined ? {} : { diagnostic: prior.diagnostic } : { diagnostic: observation.diagnostic }),
      ...(observation.evidenceRef === undefined ? prior?.evidenceRef === undefined ? {} : { evidenceRef: prior.evidenceRef } : { evidenceRef: observation.evidenceRef }) }
    const result = { ...base, ...classify(base, observation.runtime, event.observedAt, progressChanged), revision: (prior?.revision ?? 0) + 1 }
    const health = state.health.map((item, position) => position === index ? result : item)
    return { ...state, health: index < 0 ? [...health, result] : health }
  }
  if (event.type === 'health/escalated') {
    const record = state.health.find(record => key(record) === key(event))
    if (!record || record.classification !== event.condition) throw new Error('Escalation condition is not current')
    if (state.escalations.some(item => key(item) === key(event) && item.condition === event.condition && !item.resolution)) throw new Error('Escalation is already active')
    const escalation: OperatorEscalation = { id: `escalation-${event.sequence}`, attemptId: event.attemptId, generation: event.generation,
      condition: event.condition, severity: event.condition === 'failed' ? 'critical' : 'warning', source: 'health', diagnostics: diagnostic(record), work: record.work,
      revision: 1, cooldownUntil: event.cooldownUntil }
    return { ...state, escalations: [...state.escalations, escalation] }
  }
  if (event.type === 'health/attempt-cleared') {
    const index = state.health.findIndex(record => key(record) === key(event))
    if (index < 0) throw new Error('Unknown health attempt')
    const current = state.health[index]!
    if (current.terminalClearance && (current.terminalClearance.source !== event.source || current.terminalClearance.receiptId !== event.receiptId)) throw new Error('Attempt already has a different terminal clearance')
    const health = state.health.map((record, position) => position !== index ? record : record.terminalClearance ? record
      : { ...record, terminalClearance: { source: event.source, receiptId: event.receiptId, at: event.clearedAt }, revision: record.revision + 1 })
    return { ...state, health, escalations: state.escalations.map(record => key(record) !== key(event) || record.resolution
      ? record : { ...record, resolution: { reason: 'accepted-terminal' as const, source: event.source, at: event.clearedAt }, revision: record.revision + 1 }) }
  }
  const index = state.escalations.findIndex(record => record.id === event.id)
  const current = state.escalations[index]
  if (!current) throw new Error('Unknown escalation')
  if (event.type === 'health/escalation-acknowledged') {
    if (current.resolution || current.revision !== event.expectedRevision) throw new Error('Stale escalation revision')
    const next = { ...current, acknowledgement: { actor: event.actor, at: event.acknowledgedAt }, revision: current.revision + 1 }
    return { ...state, escalations: state.escalations.map((record, position) => position === index ? next : record) }
  }
  if (current.resolution) throw new Error('Escalation is already resolved')
  const health = state.health.find(record => key(record) === key(current))
  if (!health || health.classification === current.condition || !positiveRecovery(health)) throw new Error('Escalation condition is not positively cleared')
  const next = { ...current, resolution: { reason: 'condition-cleared' as const, source: 'health-observation' as const, at: event.resolvedAt }, revision: current.revision + 1 }
  return { ...state, escalations: state.escalations.map((record, position) => position === index ? next : record) }
}

/**
 * HealthStore only observes and escalates. It never sends a nudge, stops a
 * runtime, retires an assignment, or changes task ownership.
 */
export class HealthStore {
  private constructor(private readonly journal: DurableJournal<State, Payload>, private config: z.output<typeof healthConfigSchema>) {}

  static async open(directory: string, config: HealthConfig): Promise<HealthStore> {
    const validated = healthConfigSchema.parse(config)
    return new HealthStore(await DurableJournal.open(join(directory, 'health.jsonl'), { health: [], escalations: [] }, reduce), validated)
  }

  configure(config: HealthConfig): void { this.config = healthConfigSchema.parse(config) }

  async assess(observation: AttemptHealthObservation, observedAt: number): Promise<{ health: AttemptHealth; escalation?: OperatorEscalation }> {
    const input = observationSchema.parse(observation)
    const now = time.parse(observedAt)
    const prior = this.journal.snapshot().health.find(record => key(record) === key(input))
    if (prior && now < prior.observedAt) throw new Error('Attempt health clock moved backwards')
    if (prior && (prior.provider !== input.provider || prior.work.projectId !== input.work.projectId || prior.work.teamId !== input.work.teamId || prior.work.taskId !== input.work.taskId)) {
      throw new Error('Attempt health binding is immutable')
    }
    const deadlineMs = prior?.deadlineMs ?? (input.provider === 'dsh' ? this.config.dshDeadlineMs : this.config.externalDeadlineMs)
    // Validate arithmetic before accepting the observation. The reducer repeats
    // this guard so replay rejects corrupt events too.
    if (!prior || (input.progress !== undefined && !sameProgress(prior.lastProgress, input.progress))) safeAdd(now, deadlineMs, 'Attempt deadline')
    const progressChanged = input.progress !== undefined && !sameProgress(prior?.lastProgress, input.progress)
    const candidateBase = { attemptId: input.attemptId, generation: input.generation, provider: input.provider, work: input.work,
      deadlineMs, escalationCooldownMs: prior?.escalationCooldownMs ?? this.config.escalationCooldownMs,
      maxEscalationsPerCondition: prior?.maxEscalationsPerCondition ?? this.config.maxEscalationsPerCondition,
      deadlineAt: progressChanged || !prior ? safeAdd(now, deadlineMs, 'Attempt deadline') : prior.deadlineAt, observedAt: now,
      ...(input.progress && progressChanged ? { lastProgress: { ...input.progress, observedAt: now } } : prior?.lastProgress ? { lastProgress: prior.lastProgress } : {}),
      ...(prior?.terminalClearance ? { terminalClearance: prior.terminalClearance } : {}),
      ...(input.diagnostic === undefined ? prior?.diagnostic === undefined ? {} : { diagnostic: prior.diagnostic } : { diagnostic: input.diagnostic }),
      ...(input.evidenceRef === undefined ? prior?.evidenceRef === undefined ? {} : { evidenceRef: prior.evidenceRef } : { evidenceRef: input.evidenceRef }) }
    const candidate = { ...candidateBase, ...classify(candidateBase, input.runtime, now, progressChanged), revision: (prior?.revision ?? 0) + 1 }
    const changed = prior === undefined || progressChanged || candidate.classification !== prior.classification || candidate.certainty !== prior.certainty || candidate.diagnostic !== prior.diagnostic || candidate.evidenceRef !== prior.evidenceRef
    let state = changed ? await this.journal.append(() => ({ type: 'health/observed', observation: input, observedAt: now, deadlineMs,
      escalationCooldownMs: candidate.escalationCooldownMs, maxEscalationsPerCondition: candidate.maxEscalationsPerCondition })) : this.journal.snapshot()
    let health = state.health.find(record => key(record) === key(input))!
    for (const escalation of state.escalations.filter(item => key(item) === key(input) && !item.resolution && item.condition !== health.classification && positiveRecovery(health))) {
      state = await this.journal.append(() => ({ type: 'health/escalation-resolved', id: escalation.id, resolvedAt: now }))
    }
    health = state.health.find(record => key(record) === key(input))!
    const condition = health.classification === 'stale' || health.classification === 'failed' ? health.classification : undefined
    const activeEscalation = state.escalations.find(item => key(item) === key(input) && !item.resolution && item.condition === condition)
    let escalation: OperatorEscalation | undefined
    if (condition && !activeEscalation) {
      const history = state.escalations.filter(item => key(item) === key(input) && item.condition === condition)
      const previous = history.at(-1)
      if (history.length < health.maxEscalationsPerCondition && (previous === undefined || now >= previous.cooldownUntil)) {
        state = await this.journal.append(() => ({ type: 'health/escalated', attemptId: input.attemptId, generation: input.generation, condition,
          observedAt: now, cooldownUntil: safeAdd(now, health.escalationCooldownMs, 'Escalation cooldown') }))
        escalation = state.escalations.at(-1)
      }
    }
    return { health: structuredClone(health), ...(escalation ? { escalation: structuredClone(escalation) } : {}) }
  }

  async acknowledge(id: string, expectedRevision: number, actor: string, acknowledgedAt: number): Promise<OperatorEscalation> {
    const state = await this.journal.append(() => ({ type: 'health/escalation-acknowledged', id, expectedRevision, actor, acknowledgedAt }))
    const escalation = state.escalations.find(record => record.id === id)
    if (!escalation) throw new Error('Unknown escalation')
    return structuredClone(escalation)
  }

  /** Only an accepted durable terminal receipt may clear an incident without runtime recovery evidence. */
  async clearAcceptedAttempt(attemptId: string, generation: number, source: 'accepted-report' | 'accepted-submission' | 'accepted-integration', receiptId: string, clearedAt: number): Promise<void> {
    const health = this.journal.snapshot().health.find(record => key(record) === `${attemptId}:${generation}`)
    if (!health || health.terminalClearance) return
    await this.journal.append(() => ({ type: 'health/attempt-cleared', attemptId, generation, source, receiptId, clearedAt }))
  }

  listHealth(): AttemptHealth[] { return this.journal.snapshot().health }
  listEscalations(): OperatorEscalation[] { return this.journal.snapshot().escalations }
  close(): Promise<void> { return this.journal.close() }
}
