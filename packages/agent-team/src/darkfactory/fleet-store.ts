import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { digestJson } from './json.ts'
import {
  type RedisClientAdapter,
  fleetKey,
  RESERVE_SPEND_LUA_SCRIPT,
  START_RESERVATION_LUA_SCRIPT,
  RECORD_USAGE_LUA_SCRIPT,
  SETTLE_RESERVATION_LUA_SCRIPT,
  WITHHOLD_RESERVATION_LUA_SCRIPT,
  MANAGE_PAUSES_LUA_SCRIPT,
  GET_SPEND_METRICS_LUA_SCRIPT,
} from './redis-adapter.ts'
import {
  type PricingSnapshotV1,
  type ReservationV1,
  type UsageEventV1,
  reservationSchema,
} from './contracts/economics.ts'
import { assertContractSemantics } from './contracts/semantics.ts'
import type { EnabledDarkFactoryConfig } from './config.ts'

export type PauseReason = 'manual' | 'safety' | 'budget' | 'quota' | 'catalog'

export interface SpendMetrics {
  pauses: PauseReason[]
  fencing: number
  epoch: string
  fencingToken?: number | undefined
  authorityEpoch?: string | undefined
  activeReservationsCount?: number | undefined
  outstandingCostMicros?: number | undefined
  outstandingTokens?: number | undefined
}

// --- Domain Error Classes ---

export class FleetStoreError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = this.constructor.name
    this.code = code
  }
}

export class EpochMismatchError extends FleetStoreError {
  constructor(expected: string, actual: string) {
    super(`Authority epoch mismatch: expected ${expected}, got ${actual}`, 'ERR_EPOCH_MISMATCH')
  }
}

export class PauseActiveError extends FleetStoreError {
  readonly reasons: PauseReason[]
  constructor(reasons: PauseReason[]) {
    super(`Fleet operations paused due to active reasons: ${reasons.join(', ')}`, 'ERR_FLEET_PAUSED')
    this.reasons = reasons
  }
}

export class WatermarkBreachError extends FleetStoreError {
  readonly scope: string
  readonly window: string
  readonly metric: string
  readonly proposed: number
  readonly limit: number
  constructor(scope: string, window: string, metric: string, proposed: number, limit: number) {
    super(
      `Routine spend watermark (95%) breached on ${scope} ${window} ${metric}: proposed ${proposed} exceeds limit ${limit}`,
      'ERR_WATERMARK_BREACHED',
    )
    this.scope = scope
    this.window = window
    this.metric = metric
    this.proposed = proposed
    this.limit = limit
  }
}

export class CapExceededError extends FleetStoreError {
  readonly scope: string
  readonly window: string
  readonly metric: string
  readonly proposed: number
  readonly cap: number
  constructor(scope: string, window: string, metric: string, proposed: number, cap: number) {
    super(
      `Cap exceeded on ${scope} ${window} ${metric}: proposed ${proposed} exceeds cap ${cap}`,
      'ERR_CAP_EXCEEDED',
    )
    this.scope = scope
    this.window = window
    this.metric = metric
    this.proposed = proposed
    this.cap = cap
  }
}

export class StaleFencingTokenError extends FleetStoreError {
  constructor(current: number, provided: number) {
    super(`Stale fencing token: current is ${current}, provided ${provided}`, 'ERR_STALE_FENCING_TOKEN')
  }
}

export class ConflictingDigestError extends FleetStoreError {
  readonly sequence: number
  constructor(sequence: number) {
    super(
      `Conflicting eventDigest detected for stream sequence ${sequence}; reservation quarantined to withheld`,
      'ERR_CONFLICTING_EVENT_DIGEST',
    )
    this.sequence = sequence
  }
}

export class SequenceGapError extends FleetStoreError {
  constructor(missingSeq?: number) {
    super(
      missingSeq !== undefined
        ? `Cannot settle reservation with unresolved sequence gap at sequence ${missingSeq}`
        : 'Cannot settle reservation with unresolved sequence gaps in buffer',
      'ERR_UNRESOLVED_SEQUENCE_GAPS',
    )
  }
}

export class IllegalReservationTransitionError extends FleetStoreError {
  constructor(message: string) {
    super(message, 'ERR_INVALID_TRANSITION')
  }
}

export const InvalidReservationTransitionError = IllegalReservationTransitionError
export type InvalidReservationTransitionError = IllegalReservationTransitionError

export class ReconciliationDeadlineExpiredError extends FleetStoreError {
  constructor(reservationId: string, deadline: string) {
    super(
      `Reconciliation deadline ${deadline} expired with unresolved sequence gaps for reservation ${reservationId}`,
      'ERR_RECONCILIATION_DEADLINE_EXPIRED',
    )
  }
}

export class UsageSemanticError extends FleetStoreError {
  constructor(message: string) {
    super(message, 'ERR_USAGE_SEMANTICS_VIOLATION')
  }
}

// --- Options & Interfaces ---

export interface DarkFactoryFleetStoreOptions {
  adapter: RedisClientAdapter
  config: EnabledDarkFactoryConfig['fleet']
  auditLogPath?: string | undefined
  auditLogDirectory?: string | undefined
  authorityEpoch?: string | undefined
  policyRevision?: number | undefined
  clock?: (() => string) | undefined
}

export interface ReservationRequestParams {
  projectId: string
  hostId: string
  accountId: string
  attemptId: string
  generation: number
  requestId: string
  pricingRevision: number
  pricingSnapshot?: PricingSnapshotV1 | undefined
  maxCostMicros: number
  maxTokens: number
  maxRequests: number
  quotaPoolIds: string[]
  purpose: 'routine' | 'canary-recovery' | 'verified-p0-security' | 'production-invariant-recovery'
  purposeEvidence?: ReservationV1['purposeEvidence'] | undefined
  reconcileBy?: string | undefined
  deadlineMs?: number | undefined
}

export interface RecordUsageEventResult {
  status: 'recorded' | 'buffered_gap' | 'duplicate_ignored' | 'conflict_quarantined'
  sequence: number
  lastReconciledSequence?: number | undefined
  missingSequence?: number | undefined
}

export interface SettlementResult {
  reservationId: string
  state: 'settled' | 'withheld'
  settledCostMicros: number
  settledTokens: number
  refundedCostMicros: number
  refundedTokens: number
}

// --- DarkFactoryFleetStore Implementation ---

export class DarkFactoryFleetStore {
  readonly adapter: RedisClientAdapter
  readonly config: EnabledDarkFactoryConfig['fleet']
  readonly fleetId: string
  readonly authorityEpoch: string
  readonly policyRevision: number
  readonly projectId: string
  readonly auditLogPath: string | null
  private readonly clock: () => string

  constructor(options: DarkFactoryFleetStoreOptions) {
    this.adapter = options.adapter
    this.config = options.config
    this.fleetId = options.config.fleetId
    this.authorityEpoch = options.authorityEpoch ?? 'epoch-1'
    this.policyRevision = options.policyRevision ?? 1
    this.projectId = options.config.projectCaps?.[0]?.id ?? 'default-project'
    this.clock = options.clock ?? (() => new Date().toISOString())

    if (options.auditLogPath) {
      this.auditLogPath = options.auditLogPath
    } else if (options.auditLogDirectory) {
      this.auditLogPath = join(options.auditLogDirectory, 'fleet-audit.jsonl')
    } else {
      this.auditLogPath = null
    }
  }

  async initialize(): Promise<void> {
    // 1. Initialize epoch in Redis if not present
    const epochKey = fleetKey(this.fleetId, 'epoch')
    const existing = await this.adapter.get(epochKey)
    if (!existing) {
      await this.adapter.set(epochKey, this.authorityEpoch)
    }

    // 2. Ensure audit directory exists
    if (this.auditLogPath) {
      await mkdir(dirname(this.auditLogPath), { recursive: true }).catch(() => {})
    }
  }

  async close(): Promise<void> {
    // No-op for now; adapter lifecycle is managed by caller or test runner
  }

  // --- Reservation Management ---

  async reserveSpend(params: ReservationRequestParams): Promise<ReservationV1> {
    // 1. Validate purpose evidence for non-routine requests
    if (params.purpose !== 'routine') {
      if (!params.purposeEvidence || params.purposeEvidence.length === 0) {
        throw new Error('Emergency reservation requires authority evidence')
      }
    }

    const now = this.clock()
    const accountingDay = now.slice(0, 10) // YYYY-MM-DD
    const accountingMonth = now.slice(0, 7) // YYYY-MM
    const reservationId = `res-${randomUUID()}`
    const deadlineMs = params.deadlineMs ?? this.config.requestCeiling?.deadlineMs ?? 60_000
    const reconcileBy =
      params.reconcileBy ?? new Date(new Date(now).getTime() + deadlineMs).toISOString()

    const baseReservation: Omit<ReservationV1, 'fencingToken'> = {
      schemaVersion: 1,
      id: reservationId,
      projectId: params.projectId,
      policyRevision: this.policyRevision,
      fleetId: this.fleetId,
      hostId: params.hostId,
      accountId: params.accountId,
      attemptId: params.attemptId,
      generation: params.generation,
      requestId: params.requestId,
      authorityEpoch: this.authorityEpoch,
      pricingRevision: params.pricingRevision,
      currency: 'USD',
      maxCostMicros: params.maxCostMicros,
      maxTokens: params.maxTokens,
      maxRequests: params.maxRequests,
      quotaPoolIds: params.quotaPoolIds,
      purpose: params.purpose,
      purposeEvidence: params.purposeEvidence ?? [],
      createdAt: now,
      reconcileBy,
      accountingDay,
      accountingMonth,
      state: 'reserved',
    }

    const keys = [
      fleetKey(this.fleetId, 'pauses'),
      fleetKey(this.fleetId, 'epoch'),
      fleetKey(this.fleetId, 'fencing'),
      fleetKey(this.fleetId, 'active_reservations'),
    ]

    const args = [
      this.authorityEpoch,
      reservationId,
      params.projectId,
      params.hostId,
      params.purpose,
      params.maxCostMicros,
      params.maxTokens,
      accountingDay,
      accountingMonth,
      JSON.stringify({
        fleetCaps: this.config.fleetCaps,
        projectCaps: this.config.projectCaps,
        hostCaps: this.config.hostCaps,
      }),
      String(this.config.routineWatermark ?? 0.95),
      reconcileBy,
      now,
      JSON.stringify(baseReservation),
    ]

    try {
      const rawResult = await this.adapter.eval<string>(RESERVE_SPEND_LUA_SCRIPT, keys, args)
      const reservation = JSON.parse(rawResult) as ReservationV1

      // Validate contract semantics
      assertContractSemantics('ReservationV1', reservation)

      // Append to JSONL audit mirror
      await this.appendAuditLog({
        eventType: 'reservation-created',
        reservationId: reservation.id,
        fencingToken: reservation.fencingToken,
        costMicros: reservation.maxCostMicros,
        tokens: reservation.maxTokens,
        payload: reservation,
      })

      return reservation
    } catch (err: any) {
      this.translateAndRethrow(err)
      throw err
    }
  }

  async startReservation(params: { reservationId: string; fencingToken: number }): Promise<void> {
    const keys = [
      fleetKey(this.fleetId, `reservation:${params.reservationId}`),
      fleetKey(this.fleetId, 'epoch'),
    ]
    const args = [params.fencingToken, this.authorityEpoch]

    try {
      await this.adapter.eval(START_RESERVATION_LUA_SCRIPT, keys, args)

      await this.appendAuditLog({
        eventType: 'reservation-started',
        reservationId: params.reservationId,
        fencingToken: params.fencingToken,
      })
    } catch (err: any) {
      this.translateAndRethrow(err)
      throw err
    }
  }

  async getReservation(reservationId: string): Promise<ReservationV1 | null> {
    const key = fleetKey(this.fleetId, `reservation:${reservationId}`)
    const raw = await this.adapter.get(key)
    if (!raw) return null
    return JSON.parse(raw) as ReservationV1
  }

  async recordUsageEvent(event: UsageEventV1): Promise<RecordUsageEventResult> {
    // 1. Assert contract semantics (digest match, subcounts valid, etc.)
    assertContractSemantics('UsageEventV1', event)

    const totalTokens =
      event.countingSemantics === 'exclusive-categories'
        ? event.inputTokens + (event.cacheTokens ?? 0) + event.outputTokens + (event.reasoningTokens ?? 0)
        : event.inputTokens + event.outputTokens
    const keys = [
      fleetKey(this.fleetId, `reservation:${event.reservationId}`),
      fleetKey(this.fleetId, `res:${event.reservationId}:digests`),
      fleetKey(this.fleetId, `res:${event.reservationId}:buffer`),
      fleetKey(this.fleetId, 'active_reservations'),
    ]
    const args = [
      event.streamSequence,
      event.eventDigest,
      event.billedCostMicros,
      totalTokens,
      JSON.stringify(event),
    ]

    try {
      const raw = await this.adapter.eval<string>(RECORD_USAGE_LUA_SCRIPT, keys, args)
      const parsed = JSON.parse(raw) as RecordUsageEventResult

      if (parsed.status === 'conflict_quarantined') {
        await this.appendAuditLog({
          eventType: 'reservation-withheld',
          reservationId: event.reservationId,
          reason: 'ERR_CONFLICTING_EVENT_DIGEST',
          payload: event,
        })
        throw new ConflictingDigestError(event.streamSequence)
      }

      if (parsed.status === 'recorded') {
        await this.appendAuditLog({
          eventType: 'usage-recorded',
          reservationId: event.reservationId,
          costMicros: event.billedCostMicros,
          tokens: totalTokens,
          payload: event,
        })
      }

      return parsed
    } catch (err: any) {
      this.translateAndRethrow(err)
      throw err
    }
  }

  async settleReservation(params: {
    reservationId: string
    actualCostMicros?: number | undefined
    actualTokens?: number | undefined
  }): Promise<SettlementResult> {
    const now = this.clock()
    const keys = [
      fleetKey(this.fleetId, `reservation:${params.reservationId}`),
      fleetKey(this.fleetId, `res:${params.reservationId}:buffer`),
      fleetKey(this.fleetId, 'active_reservations'),
    ]
    const args = [
      now,
      params.actualCostMicros !== undefined ? params.actualCostMicros : -1,
      params.actualTokens !== undefined ? params.actualTokens : -1,
    ]

    try {
      const raw = await this.adapter.eval<string>(SETTLE_RESERVATION_LUA_SCRIPT, keys, args)
      const result = JSON.parse(raw) as SettlementResult

      await this.appendAuditLog({
        eventType: 'reservation-settled',
        reservationId: params.reservationId,
        costMicros: result.settledCostMicros,
        tokens: result.settledTokens,
        payload: result,
      })

      return result
    } catch (err: any) {
      this.translateAndRethrow(err)
      throw err
    }
  }

  async withholdReservation(reservationId: string, reason: string): Promise<void> {
    const keys = [
      fleetKey(this.fleetId, `reservation:${reservationId}`),
      fleetKey(this.fleetId, 'active_reservations'),
    ]
    const args = [reason]

    try {
      await this.adapter.eval(WITHHOLD_RESERVATION_LUA_SCRIPT, keys, args)

      await this.appendAuditLog({
        eventType: 'reservation-withheld',
        reservationId,
        reason,
      })
    } catch (err: any) {
      this.translateAndRethrow(err)
      throw err
    }
  }

  // --- Pauses Management ---

  async pause(reason: PauseReason): Promise<void> {
    const keys = [fleetKey(this.fleetId, 'pauses')]
    const args = ['pause', reason]
    await this.adapter.eval(MANAGE_PAUSES_LUA_SCRIPT, keys, args)

    await this.appendAuditLog({
      eventType: 'pause-updated',
      reason,
      pauses: await this.getActivePauses(),
    })
  }

  async resume(reason: PauseReason): Promise<void> {
    const keys = [fleetKey(this.fleetId, 'pauses')]
    const args = ['resume', reason]
    await this.adapter.eval(MANAGE_PAUSES_LUA_SCRIPT, keys, args)

    await this.appendAuditLog({
      eventType: 'pause-updated',
      reason,
      pauses: await this.getActivePauses(),
    })
  }

  async getActivePauses(): Promise<PauseReason[]> {
    const pausesKey = fleetKey(this.fleetId, 'pauses')
    const keys = [pausesKey]
    const members = await this.adapter.eval<string[]>(
      '-- [df:get_active_pauses]\nreturn redis.call("SMEMBERS", KEYS[1])',
      keys,
      [],
    )
    return (members ?? []) as PauseReason[]
  }

  async getSpendMetrics(): Promise<SpendMetrics> {
    const keys = [
      fleetKey(this.fleetId, 'pauses'),
      fleetKey(this.fleetId, 'fencing'),
      fleetKey(this.fleetId, 'epoch'),
      fleetKey(this.fleetId, 'active_reservations'),
    ]
    try {
      const raw = await this.adapter.eval<string>(GET_SPEND_METRICS_LUA_SCRIPT, keys, [])
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      return {
        pauses: (parsed.pauses ?? []) as PauseReason[],
        fencing: Number(parsed.fencing ?? 0),
        epoch: String(parsed.epoch ?? this.authorityEpoch),
        fencingToken: Number(parsed.fencing ?? 0),
        authorityEpoch: String(parsed.epoch ?? this.authorityEpoch),
        activeReservationsCount: Number(parsed.activeReservationsCount ?? 0),
        outstandingCostMicros: Number(parsed.outstandingCostMicros ?? 0),
        outstandingTokens: Number(parsed.outstandingTokens ?? 0),
      }
    } catch (err: any) {
      this.translateAndRethrow(err)
      throw err
    }
  }

  // --- Deadline Reconciliation ---

  async reconcileDeadlines(): Promise<string[]> {
    const now = this.clock()
    const activeKey = fleetKey(this.fleetId, 'active_reservations')
    const activeIds = (await this.adapter.eval<string[]>(
      '-- [df:get_active_ids]\nreturn redis.call("SMEMBERS", KEYS[1])',
      [activeKey],
      [],
    )) ?? []

    const withheld: string[] = []

    for (const id of activeIds) {
      const resKey = fleetKey(this.fleetId, `reservation:${id}`)
      const raw = await this.adapter.get(resKey)
      if (!raw) continue
      const res = JSON.parse(raw) as ReservationV1
      if (res.reconcileBy && now >= res.reconcileBy) {
        // If state is reconciling or has buffer, withhold it
        const bufferKey = fleetKey(this.fleetId, `res:${id}:buffer`)
        const bufferCount = await this.adapter.eval<number>(
          '-- [df:check_buffer]\nreturn redis.call("ZCARD", KEYS[1])',
          [bufferKey],
          [],
        )
        if (bufferCount > 0 || res.state === 'reconciling') {
          await this.withholdReservation(id, 'ERR_RECONCILIATION_DEADLINE_EXPIRED')
          withheld.push(id)
        }
      }
    }

    return withheld
  }

  // --- Static Pricing & Math Helpers ---

  static computeMaxCostMicros(
    ceiling: { inputTokens: number; outputTokens: number; reasoningTokens?: number | undefined },
    snapshot: PricingSnapshotV1,
  ): number {
    const inputCost = (ceiling.inputTokens * snapshot.inputMicrosPerMillion) / 1_000_000
    const outputCost = (ceiling.outputTokens * snapshot.outputMicrosPerMillion) / 1_000_000
    const reasoningCost = ((ceiling.reasoningTokens ?? 0) * snapshot.reasoningMicrosPerMillion) / 1_000_000
    return Math.ceil(inputCost + outputCost + reasoningCost)
  }

  static computeBilledCostMicros(
    tokens: {
      inputTokens: number
      cacheTokens?: number | undefined
      outputTokens: number
      reasoningTokens?: number | undefined
    },
    semantics: 'exclusive-categories' | 'cache-in-input-reasoning-in-output',
    snapshot: PricingSnapshotV1,
  ): number {
    const cacheTokens = tokens.cacheTokens ?? 0
    const reasoningTokens = tokens.reasoningTokens ?? 0

    if (semantics === 'exclusive-categories') {
      const inputCost = (tokens.inputTokens * snapshot.inputMicrosPerMillion) / 1_000_000
      const cacheCost = (cacheTokens * snapshot.cachedInputMicrosPerMillion) / 1_000_000
      const outputCost = (tokens.outputTokens * snapshot.outputMicrosPerMillion) / 1_000_000
      const reasoningCost = (reasoningTokens * snapshot.reasoningMicrosPerMillion) / 1_000_000
      return Math.ceil(inputCost + cacheCost + outputCost + reasoningCost)
    } else {
      if (cacheTokens > tokens.inputTokens || reasoningTokens > tokens.outputTokens) {
        throw new UsageSemanticError('Usage subcounts exceed provider totals')
      }
      const uncachedInput = tokens.inputTokens - cacheTokens
      const pureOutput = tokens.outputTokens - reasoningTokens

      const inputCost = (uncachedInput * snapshot.inputMicrosPerMillion) / 1_000_000
      const cacheCost = (cacheTokens * snapshot.cachedInputMicrosPerMillion) / 1_000_000
      const outputCost = (pureOutput * snapshot.outputMicrosPerMillion) / 1_000_000
      const reasoningCost = (reasoningTokens * snapshot.reasoningMicrosPerMillion) / 1_000_000
      return Math.ceil(inputCost + cacheCost + outputCost + reasoningCost)
    }
  }

  // --- Internal Helpers ---

  private async appendAuditLog(entry: {
    eventType:
      | 'reservation-created'
      | 'reservation-started'
      | 'usage-recorded'
      | 'reservation-settled'
      | 'reservation-withheld'
      | 'pause-updated'
    reservationId?: string | undefined
    fencingToken?: number | undefined
    costMicros?: number | undefined
    tokens?: number | undefined
    pauses?: PauseReason[] | undefined
    reason?: string | undefined
    payload?: unknown | undefined
  }): Promise<void> {
    if (!this.auditLogPath) return
    const record = {
      schemaVersion: 1,
      recordId: `audit-${randomUUID()}`,
      projectId: this.projectId,
      policyRevision: this.policyRevision,
      timestamp: this.clock(),
      ...entry,
      payloadDigest: digestJson(entry.payload ?? entry),
    }
    const line = JSON.stringify(record) + '\n'
    await appendFile(this.auditLogPath, line, 'utf8')
  }

  private translateAndRethrow(err: any): void {
    const msg = String(err?.message ?? '')
    if (msg.includes('ERR_EPOCH_MISMATCH')) {
      const match = msg.match(/expected\s+([^\s,]+).*active\s+is\s+([^\s,]+)/i)
      throw new EpochMismatchError(match?.[1] ?? this.authorityEpoch, match?.[2] ?? 'unknown')
    }
    if (msg.includes('ERR_PAUSED_SAFETY_OR_MANUAL') || msg.includes('ERR_PAUSED_ROUTINE')) {
      const parts = msg.split(':')
      const reasons = (parts[1] ? parts[1].split(',') : ['manual']) as PauseReason[]
      throw new PauseActiveError(reasons)
    }
    if (msg.includes('ERR_WATERMARK_BREACHED')) {
      const parts = msg.split(':')
      throw new WatermarkBreachError(
        parts[1] ?? 'Fleet',
        parts[2] ?? 'Daily',
        parts[3] ?? 'money',
        Number(parts[4] ?? 0),
        Number(parts[5] ?? 0),
      )
    }
    if (msg.includes('ERR_CAP_EXCEEDED')) {
      const parts = msg.split(':')
      throw new CapExceededError(
        parts[1] ?? 'Fleet',
        parts[2] ?? 'Daily',
        parts[3] ?? 'money',
        Number(parts[4] ?? 0),
        Number(parts[5] ?? 0),
      )
    }
    if (msg.includes('ERR_STALE_FENCING_TOKEN')) {
      throw new StaleFencingTokenError(1, 0)
    }
    if (msg.includes('ERR_CONFLICTING_EVENT_DIGEST')) {
      throw new ConflictingDigestError(1)
    }
    if (msg.includes('ERR_UNRESOLVED_SEQUENCE_GAPS')) {
      throw new SequenceGapError()
    }
    if (msg.includes('ERR_INVALID_TRANSITION')) {
      throw new IllegalReservationTransitionError(msg)
    }
  }
}
