import {
  type ProviderQuotaV1,
  type ReservationV1,
  type UsageEventV1,
  emergencyPurposeSchema,
  providerQuotaSchema,
} from './contracts/economics.ts'
import {
  type ArtifactRef,
  type SecretRef,
  artifactRefSchema,
  assertProjectArtifacts,
} from './contracts/common.ts'
import { assertContractSemantics } from './contracts/semantics.ts'
import type { DarkFactoryConfig } from './config.ts'
import type { DarkFactoryFleetStore } from './fleet-store.ts'

/** Compare RFC 3339 UTC timestamps without dropping sub-millisecond precision. */
export function compareTime(a: string, b: string): number {
  const [secondsA, fractionA = ''] = a.slice(0, -1).split('.')
  const [secondsB, fractionB = ''] = b.slice(0, -1).split('.')
  if (secondsA !== secondsB) return secondsA! < secondsB! ? -1 : 1
  const length = Math.max(fractionA.length, fractionB.length)
  const x = fractionA.padEnd(length, '0')
  const y = fractionB.padEnd(length, '0')
  return x === y ? 0 : x < y ? -1 : 1
}

// --- Domain Error Classes ---

export class QuotaManagerError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = this.constructor.name
    this.code = code
  }
}

export class QuotaStaleError extends QuotaManagerError {
  readonly poolId: string
  readonly observedAt: string
  readonly expiresAt: string
  readonly now: string
  constructor(poolId: string, observedAt: string, expiresAt: string, now?: string) {
    super(`Quota pool "${poolId}" is stale (observedAt: ${observedAt}, expiresAt: ${expiresAt})`, 'ERR_QUOTA_STALE')
    this.poolId = poolId
    this.observedAt = observedAt
    this.expiresAt = expiresAt
    this.now = now ?? ''
  }
}

export class QuotaExhaustedError extends QuotaManagerError {
  readonly poolId: string
  readonly requestedUnits: number
  readonly availableUnits: number
  constructor(poolId: string, requestedUnits = 0, availableUnits = 0) {
    super(`Quota pool "${poolId}" is exhausted: requested ${requestedUnits}, available ${availableUnits}`, 'ERR_QUOTA_EXHAUSTED')
    this.poolId = poolId
    this.requestedUnits = requestedUnits
    this.availableUnits = availableUnits
  }
}

export class EmergencyReserveBreachError extends QuotaManagerError {
  readonly poolId: string
  readonly requestedUnits: number
  readonly availableUnits: number
  readonly reserveLimit: number
  get requested(): number { return this.requestedUnits }
  get available(): number { return this.availableUnits }
  constructor(poolId: string, availableUnits: number, requestedUnits: number, reserveLimit: number) {
    super(
      `Routine request on pool "${poolId}" of ${requestedUnits} units would breach 10% emergency reserve (available: ${availableUnits}, reserve floor: ${reserveLimit})`,
      'ERR_EMERGENCY_RESERVE_BREACH',
    )
    this.poolId = poolId
    this.availableUnits = availableUnits
    this.requestedUnits = requestedUnits
    this.reserveLimit = reserveLimit
  }
}

export class InvalidRequestedUnitsError extends EmergencyReserveBreachError {
  constructor(message = 'Requested units must be greater than zero') {
    super('all', 0, 0, 0)
    this.message = message
    ;(this as any).code = 'ERR_INVALID_REQUEST'
  }
}

export class NoEligiblePoolError extends QuotaManagerError {
  readonly requestedUnits?: number | undefined
  readonly unit?: string | undefined
  readonly purpose?: string | undefined
  readonly triedPoolIds?: string[] | undefined
  constructor(
    reason: string,
    details?: {
      requestedUnits?: number | undefined
      unit?: string | undefined
      purpose?: string | undefined
      triedPoolIds?: string[] | undefined
    },
  ) {
    super(`No eligible quota pool found in waterfall routing: ${reason}`, 'ERR_NO_ELIGIBLE_POOL')
    this.requestedUnits = details?.requestedUnits
    this.unit = details?.unit
    this.purpose = details?.purpose
    this.triedPoolIds = details?.triedPoolIds
  }
}

export class InvalidEmergencyGrantError extends QuotaManagerError {
  readonly reason: string
  readonly purpose?: string | undefined
  constructor(reason: string, purpose?: string) {
    super(`Emergency access denied: invalid or missing emergency grant evidence: ${reason}`, 'ERR_INVALID_EMERGENCY_GRANT')
    this.reason = reason
    this.purpose = purpose
  }
}

export class UnrecognizedEmergencyPurposeError extends QuotaManagerError {
  readonly purpose: string
  constructor(purpose: string) {
    super(
      `Emergency access denied: unrecognized purpose "${purpose}". Permitted purposes: ${emergencyPurposeSchema.options.join(', ')}`,
      'ERR_UNRECOGNIZED_EMERGENCY_PURPOSE',
    )
    this.purpose = purpose
  }
}

export class CrossProjectQuotaError extends QuotaManagerError {
  readonly expectedProjectId: string
  readonly receivedProjectId: string
  get expected(): string { return this.expectedProjectId }
  get actual(): string { return this.receivedProjectId }
  constructor(expected: string, received: string) {
    super(`Cross-project artifact reference: expected project ${expected}, received ${received}`, 'ERR_CROSS_PROJECT_QUOTA')
    this.expectedProjectId = expected
    this.receivedProjectId = received
  }
}

export class UnknownPoolError extends QuotaManagerError {
  readonly poolId: string
  constructor(poolId: string) {
    super(`Unknown quota pool "${poolId}" not configured in fleet quotas`, 'ERR_UNKNOWN_POOL')
    this.poolId = poolId
  }
}

export class UnitMismatchError extends QuotaManagerError {
  readonly poolId: string
  readonly expectedUnit: string
  readonly requestedUnit: string
  constructor(poolId: string, expectedUnit: string, requestedUnit: string) {
    super(`Unit mismatch on pool "${poolId}": pool is configured for "${expectedUnit}", requested "${requestedUnit}"`, 'ERR_UNIT_MISMATCH')
    this.poolId = poolId
    this.expectedUnit = expectedUnit
    this.requestedUnit = requestedUnit
  }
}

export class StaleSnapshotError extends QuotaManagerError {
  readonly poolId: string
  readonly currentObservedAt: string
  readonly incomingObservedAt: string
  constructor(poolId: string, currentObservedAt: string, incomingObservedAt: string) {
    super(`Incoming snapshot for pool ${poolId} is older than current snapshot (current: ${currentObservedAt}, incoming: ${incomingObservedAt})`, 'ERR_STALE_SNAPSHOT')
    this.poolId = poolId
    this.currentObservedAt = currentObservedAt
    this.incomingObservedAt = incomingObservedAt
  }
}

export class PolicyRejectionError extends QuotaManagerError {
  constructor(message: string) {
    super(message, 'ERR_POLICY_REJECTION')
  }
}

// --- Interfaces & Types ---

export type PoolClassification = 'AVAILABLE' | 'RESERVED_EMERGENCY_ONLY' | 'EXHAUSTED' | 'STALE'

export type QuotaUnit = 'tokens' | 'requests' | 'credits'

export interface QuotaPoolConfig {
  id: string
  provider: 'fixture' | 'metered' | 'subscription'
  adapterId: string
  secretRef: SecretRef | { kind: 'env' | 'file'; [k: string]: unknown }
  ttlMs: number
  enabled?: boolean
}

export interface QuotaEvaluationResult {
  poolId: string
  unit: QuotaUnit
  total: number
  observedRemaining: number
  unreflectedUsage: number
  activeReservations: number
  effectiveAvailable: number
  reserveLimit: number
  classification: PoolClassification
  watermark: string
  isFresh: boolean
}

export interface QuotaRouteRequest {
  requestedUnits: number
  unit?: QuotaUnit
  purpose: 'routine' | 'canary-recovery' | 'verified-p0-security' | 'production-invariant-recovery' | (string & {})
  purposeEvidence?: ArtifactRef[]
  candidatePoolIds?: string[]
}

export interface QuotaRouteResult {
  poolId: string
  mode: 'subscription' | 'metered' | 'fixture'
  emergency: boolean
  remainingAfterRequest: number
  reserveLimit: number
}

export interface DarkFactoryQuotaManagerOptions {
  quotasConfig: QuotaPoolConfig[]
  reserveFraction?: number
  clock?: () => string
  fleetStore?: DarkFactoryFleetStore
  projectId?: string
  policyRevision?: number
  allowedEmergencyPurposes?: string[]
  emergencyPurposes?: string[]
}

export type QuotaManagerOptions = DarkFactoryQuotaManagerOptions

interface UnreflectedUsageEntry {
  id: string
  reservationId?: string | undefined
  units: number
  timestamp: string
}

interface ActiveReservationEntry {
  reservation: ReservationV1
  units: number
}

interface PoolInternalState {
  config: QuotaPoolConfig
  snapshot?: ProviderQuotaV1 | undefined
  activeReservations: Map<string, ActiveReservationEntry>
  unreflectedUsageEntries: Map<string, UnreflectedUsageEntry>
}

// --- DarkFactoryQuotaManager Implementation ---

export class DarkFactoryQuotaManager {
  readonly projectId: string
  readonly policyRevision: number
  readonly reserveFraction: number
  readonly allowedEmergencyPurposes: Set<string>
  private readonly clock: () => string
  private readonly fleetStore?: DarkFactoryFleetStore | undefined
  private readonly pools = new Map<string, PoolInternalState>()
  private readonly poolOrder: string[] = []
  private quotaPauseActive = false
  private hookPromise: Promise<void> = Promise.resolve()

  constructor(options: DarkFactoryQuotaManagerOptions) {
    this.projectId = options.projectId ?? 'proj-fleet-1'
    this.policyRevision = options.policyRevision ?? 1
    this.reserveFraction = options.reserveFraction ?? 0.10
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.fleetStore = options.fleetStore

    const allowedPurposes = options.allowedEmergencyPurposes ?? options.emergencyPurposes ?? [
      'canary-recovery',
      'verified-p0-security',
      'production-invariant-recovery',
    ]
    this.allowedEmergencyPurposes = new Set(allowedPurposes)

    for (const poolCfg of options.quotasConfig) {
      const defaultEnabled = poolCfg.provider === 'metered' ? false : true
      this.pools.set(poolCfg.id, {
        config: { ...poolCfg, enabled: poolCfg.enabled ?? defaultEnabled },
        activeReservations: new Map(),
        unreflectedUsageEntries: new Map(),
      })
      this.poolOrder.push(poolCfg.id)
    }
  }

  // --- Snapshot Ingestion & Freshness ---

  registerSnapshot(snapshot: ProviderQuotaV1): void {
    // 1. Zod Schema & Semantics Validation
    providerQuotaSchema.parse(snapshot)
    assertContractSemantics('ProviderQuotaV1', snapshot)

    // 2. Ensure Pool is Configured
    const pool = this.pools.get(snapshot.poolId)
    if (!pool) {
      throw new UnknownPoolError(snapshot.poolId)
    }

    // 3. Authority Validation (Manual fixtures only allowed on fixture pools)
    if (snapshot.authority === 'manual-fixture' && pool.config.provider !== 'fixture') {
      throw new PolicyRejectionError(
        `Manual fixture snapshot not permitted for provider type ${pool.config.provider}`,
      )
    }

    // 3.5 Clock Skew Ingestion Guard (> 60s in future throws QuotaStaleError)
    const nowMs = Date.parse(this.clock())
    const observedAtMs = Date.parse(snapshot.observedAt)
    if (observedAtMs > nowMs + 60_000) {
      throw new QuotaStaleError(snapshot.poolId, snapshot.observedAt, snapshot.expiresAt, this.clock())
    }

    // 4. Monotonic Snapshot Ordering
    if (pool.snapshot) {
      const timeOrder = compareTime(snapshot.observedAt, pool.snapshot.observedAt)
      if (timeOrder < 0) {
        throw new StaleSnapshotError(snapshot.poolId, pool.snapshot.observedAt, snapshot.observedAt)
      }
    }

    // 5. Update Snapshot
    pool.snapshot = snapshot

    // 6. Clear Covered Unreflected Usage
    for (const [id, entry] of pool.unreflectedUsageEntries) {
      if (compareTime(entry.timestamp, snapshot.observedAt) <= 0 || id === snapshot.watermark) {
        pool.unreflectedUsageEntries.delete(id)
      }
    }

    // 7. Check if Quota Pause can be Resumed
    if (this.hasAnyAvailablePool()) {
      this.triggerQuotaResume()
    }
  }

  getSnapshot(poolId: string): ProviderQuotaV1 | undefined {
    return this.pools.get(poolId)?.snapshot
  }

  setPoolEnabled(poolId: string, enabled: boolean): void {
    const pool = this.pools.get(poolId)
    if (!pool) throw new UnknownPoolError(poolId)
    pool.config.enabled = enabled
  }

  // --- Evaluation & Classification ---

  evaluateAvailableQuota(
    poolId: string,
    overrideUnreflected?: number,
    overrideActive?: number,
  ): QuotaEvaluationResult {
    const pool = this.pools.get(poolId)
    if (!pool) {
      throw new UnknownPoolError(poolId)
    }

    if (!pool.snapshot) {
      return {
        poolId,
        unit: 'tokens',
        total: 0,
        observedRemaining: 0,
        unreflectedUsage: 0,
        activeReservations: 0,
        effectiveAvailable: 0,
        reserveLimit: 0,
        classification: 'STALE',
        watermark: '',
        isFresh: false,
      }
    }

    const snap = pool.snapshot
    const isFresh = this.isSnapshotFresh(snap, pool.config.ttlMs)

    // Calculate unreflected usage
    let unreflectedUsage = overrideUnreflected !== undefined ? overrideUnreflected : 0
    if (overrideUnreflected === undefined) {
      for (const entry of pool.unreflectedUsageEntries.values()) {
        unreflectedUsage += entry.units
      }
    }

    // Calculate active reservations
    let activeReservations = overrideActive !== undefined ? overrideActive : 0
    if (overrideActive === undefined) {
      for (const entry of pool.activeReservations.values()) {
        if (snap.unit === 'requests') {
          activeReservations += entry.reservation.maxRequests
        } else if (snap.unit === 'credits') {
          activeReservations += entry.reservation.maxCostMicros
        } else {
          activeReservations += entry.reservation.maxTokens
        }
      }
    }

    // Effective available capacity (clamped to 0)
    const effectiveAvailable = Math.max(0, snap.observedRemaining - unreflectedUsage - activeReservations)
    const reserveLimit = Math.ceil(snap.total * this.reserveFraction)

    let classification: PoolClassification
    if (!isFresh) {
      classification = 'STALE'
    } else if (effectiveAvailable <= 0) {
      classification = 'EXHAUSTED'
    } else if (effectiveAvailable <= reserveLimit) {
      classification = 'RESERVED_EMERGENCY_ONLY'
    } else {
      classification = 'AVAILABLE'
    }

    return {
      poolId,
      unit: snap.unit,
      total: snap.total,
      observedRemaining: snap.observedRemaining,
      unreflectedUsage,
      activeReservations,
      effectiveAvailable,
      reserveLimit,
      classification,
      watermark: snap.watermark,
      isFresh,
    }
  }

  classifyPool(poolId: string): PoolClassification {
    return this.evaluateAvailableQuota(poolId).classification
  }

  private isSnapshotFresh(snapshot: ProviderQuotaV1, configTtlMs?: number): boolean {
    const nowIso = this.clock()
    const nowMs = Date.parse(nowIso)
    const observedAtMs = Date.parse(snapshot.observedAt)

    // Clock skew check: observedAt > now + 60s
    if (observedAtMs > nowMs + 60_000) {
      return false
    }

    // Window checks using compareTime
    if (compareTime(nowIso, snapshot.expiresAt) >= 0) return false
    if (compareTime(nowIso, snapshot.resetAt) >= 0) return false
    if (compareTime(nowIso, snapshot.windowEnd) >= 0) return false

    // TTL check: nowMs >= observedAtMs + ttlMs
    const ttlMs = configTtlMs ?? 300_000
    const ttlExpiryMs = observedAtMs + ttlMs
    if (nowMs >= ttlExpiryMs) return false

    return true
  }

  // --- Waterfall Routing ---

  selectPoolForRequest(params: QuotaRouteRequest): QuotaRouteResult {
    // 1. Validate requestedUnits
    if (!Number.isFinite(params.requestedUnits) || params.requestedUnits <= 0) {
      if (params.requestedUnits === Infinity) {
        throw new InvalidRequestedUnitsError('Requested units must be finite and greater than zero')
      }
      throw new QuotaManagerError('Requested units must be greater than zero', 'ERR_INVALID_REQUEST')
    }

    // 2. Validate Purpose & Evidence
    const isRoutine = params.purpose === 'routine'
    if (!isRoutine) {
      if (
        !emergencyPurposeSchema.options.includes(params.purpose as any) ||
        !this.allowedEmergencyPurposes.has(params.purpose)
      ) {
        throw new UnrecognizedEmergencyPurposeError(params.purpose)
      }

      if (!params.purposeEvidence || params.purposeEvidence.length === 0) {
        throw new InvalidEmergencyGrantError('Emergency reservation requires authority evidence', params.purpose)
      }
      if (params.purposeEvidence.length > 32) {
        throw new InvalidEmergencyGrantError('Emergency purpose evidence exceeds maximum 32 items', params.purpose)
      }

      const seenIds = new Set<string>()
      for (const artifact of params.purposeEvidence) {
        if (seenIds.has(artifact.id)) {
          throw new InvalidEmergencyGrantError(`Duplicate evidence artifact reference: ${artifact.id}`, params.purpose)
        }
        seenIds.add(artifact.id)

        const parsed = artifactRefSchema.safeParse(artifact)
        if (!parsed.success) {
          throw new InvalidEmergencyGrantError(`Malformed artifact reference: ${parsed.error.message}`, params.purpose)
        }
      }

      for (const artifact of params.purposeEvidence) {
        if (this.projectId && artifact.projectId !== this.projectId) {
          throw new CrossProjectQuotaError(this.projectId, artifact.projectId)
        }
      }
    }

    // 3. Build Ordered Waterfall Tiers:
    //    Primary Subscription -> Ordered Alternative Subscriptions -> Explicitly Enabled Metered
    const subscriptionCandidates: string[] = []
    const meteredCandidates: string[] = []

    for (const poolId of this.poolOrder) {
      const pool = this.pools.get(poolId)!
      if (params.candidatePoolIds && !params.candidatePoolIds.includes(poolId)) {
        continue
      }

      if (pool.config.provider === 'subscription' || pool.config.provider === 'fixture') {
        if (pool.config.enabled !== false) {
          subscriptionCandidates.push(poolId)
        }
      } else if (pool.config.provider === 'metered') {
        if (pool.config.enabled === true) {
          meteredCandidates.push(poolId)
        }
      }
    }

    const candidatePools = [...subscriptionCandidates, ...meteredCandidates]
    if (candidatePools.length === 0) {
      this.triggerQuotaPause()
      if (params.candidatePoolIds && params.candidatePoolIds.length > 0) {
        const firstPoolId = params.candidatePoolIds[0]!
        const pool = this.pools.get(firstPoolId)
        if (pool && params.unit && pool.snapshot && pool.snapshot.unit !== params.unit) {
          throw new UnitMismatchError(firstPoolId, pool.snapshot.unit, params.unit)
        }
      }
      throw new NoEligiblePoolError('No enabled candidate pools configured or specified', {
        requestedUnits: params.requestedUnits,
        unit: params.unit,
        purpose: params.purpose,
        triedPoolIds: [],
      })
    }

    let lastBreachError: EmergencyReserveBreachError | undefined
    let lastStaleError: QuotaStaleError | undefined
    let lastExhaustedError: QuotaExhaustedError | undefined
    let unitMismatchError: UnitMismatchError | undefined
    let evaluatedCount = 0
    const triedPoolIds: string[] = []

    // 4. Evaluate Waterfall Candidates
    for (const poolId of candidatePools) {
      const pool = this.pools.get(poolId)!
      const evalResult = this.evaluateAvailableQuota(poolId)

      if (params.unit && evalResult.unit !== params.unit) {
        unitMismatchError = new UnitMismatchError(poolId, evalResult.unit, params.unit)
        continue
      }

      evaluatedCount++
      triedPoolIds.push(poolId)

      if (!evalResult.isFresh || evalResult.classification === 'STALE') {
        lastStaleError = new QuotaStaleError(
          poolId,
          pool.snapshot?.observedAt ?? 'none',
          pool.snapshot?.expiresAt ?? 'none',
          this.clock(),
        )
        continue
      }

      if (evalResult.classification === 'EXHAUSTED') {
        lastExhaustedError = new QuotaExhaustedError(poolId, params.requestedUnits, evalResult.effectiveAvailable)
        continue
      }

      if (isRoutine) {
        if (evalResult.classification === 'RESERVED_EMERGENCY_ONLY') {
          lastBreachError = new EmergencyReserveBreachError(
            poolId,
            evalResult.effectiveAvailable,
            params.requestedUnits,
            evalResult.reserveLimit,
          )
          continue
        }

        // Routine request must leave >= reserveLimit in pool
        if (evalResult.effectiveAvailable - params.requestedUnits < evalResult.reserveLimit) {
          lastBreachError = new EmergencyReserveBreachError(
            poolId,
            evalResult.effectiveAvailable,
            params.requestedUnits,
            evalResult.reserveLimit,
          )
          continue
        }

        // Routine match found!
        return {
          poolId,
          mode: pool.config.provider,
          emergency: false,
          remainingAfterRequest: evalResult.effectiveAvailable - params.requestedUnits,
          reserveLimit: evalResult.reserveLimit,
        }
      } else {
        // Emergency purpose: can consume into reserve down to 0
        if (evalResult.effectiveAvailable - params.requestedUnits < 0) {
          lastExhaustedError = new QuotaExhaustedError(poolId, params.requestedUnits, evalResult.effectiveAvailable)
          continue
        }

        // Emergency match found!
        return {
          poolId,
          mode: pool.config.provider,
          emergency: true,
          remainingAfterRequest: evalResult.effectiveAvailable - params.requestedUnits,
          reserveLimit: evalResult.reserveLimit,
        }
      }
    }

    // 5. If single candidate was tested, rethrow specific error
    if (candidatePools.length === 1) {
      if (unitMismatchError && evaluatedCount === 0) throw unitMismatchError
      this.triggerQuotaPause()
      if (lastExhaustedError) throw lastExhaustedError
      if (lastBreachError) throw lastBreachError
      if (lastStaleError) throw lastStaleError
    }

    // 6. Fail-closed waterfall: trigger quota pause and throw NoEligiblePoolError
    this.triggerQuotaPause()

    if (lastBreachError && evaluatedCount > 0 && !lastExhaustedError && !lastStaleError) {
      throw new NoEligiblePoolError('All candidate pools would breach 10% emergency reserve', {
        requestedUnits: params.requestedUnits,
        unit: params.unit,
        purpose: params.purpose,
        triedPoolIds,
      })
    }

    throw new NoEligiblePoolError(
      evaluatedCount === 0 && unitMismatchError
        ? unitMismatchError.message
        : 'All candidate pools exhausted or stale',
      {
        requestedUnits: params.requestedUnits,
        unit: params.unit,
        purpose: params.purpose,
        triedPoolIds,
      },
    )
  }

  // --- Local Accounting: Reservations, Usage & Settlement ---

  recordReservation(poolId: string, reservation: ReservationV1): void {
    assertContractSemantics('ReservationV1', reservation)
    const pool = this.pools.get(poolId)
    if (!pool) throw new UnknownPoolError(poolId)

    let units = reservation.maxTokens
    if (pool.snapshot?.unit === 'requests') {
      units = reservation.maxRequests
    } else if (pool.snapshot?.unit === 'credits') {
      units = reservation.maxCostMicros
    }

    pool.activeReservations.set(reservation.id, { reservation, units })
  }

  cancelReservation(poolId: string, reservationId: string): void {
    const pool = this.pools.get(poolId)
    if (!pool) throw new UnknownPoolError(poolId)

    pool.activeReservations.delete(reservationId)

    if (this.quotaPauseActive && this.hasAnyAvailablePool()) {
      this.triggerQuotaResume()
    }
  }

  recordUsage(poolId: string, event: UsageEventV1): void {
    assertContractSemantics('UsageEventV1', event)
    const pool = this.pools.get(poolId)
    if (!pool) throw new UnknownPoolError(poolId)

    let units =
      event.countingSemantics === 'exclusive-categories'
        ? event.inputTokens + event.cacheTokens + event.outputTokens + event.reasoningTokens
        : event.inputTokens + event.outputTokens

    if (pool.snapshot?.unit === 'requests') {
      units = 1
    } else if (pool.snapshot?.unit === 'credits') {
      units = event.billedCostMicros
    }

    if (event.reservationId && pool.unreflectedUsageEntries.has(`settled:${event.reservationId}`)) {
      pool.unreflectedUsageEntries.delete(`settled:${event.reservationId}`)
    }

    if (pool.snapshot) {
      if (compareTime(event.usageAt, pool.snapshot.observedAt) <= 0) {
        // Already reflected upstream in provider snapshot; ignore to prevent double subtraction
        return
      }
    }

    pool.unreflectedUsageEntries.set(event.id, {
      id: event.id,
      reservationId: event.reservationId,
      units,
      timestamp: event.usageAt,
    })
  }

  settleReservation(poolId: string, reservationId: string, actualTokens?: number): void {
    const pool = this.pools.get(poolId)
    if (!pool) throw new UnknownPoolError(poolId)

    const active = pool.activeReservations.get(reservationId)
    pool.activeReservations.delete(reservationId)

    let existingUnits = 0
    for (const entry of pool.unreflectedUsageEntries.values()) {
      if (entry.reservationId === reservationId) {
        existingUnits += entry.units
      }
    }

    if (existingUnits === 0 && actualTokens !== undefined && actualTokens > 0) {
      const timestamp = this.clock()
      const snapshotObservedAt = pool.snapshot?.observedAt
      if (!snapshotObservedAt || compareTime(timestamp, snapshotObservedAt) >= 0) {
        pool.unreflectedUsageEntries.set(`settled:${reservationId}`, {
          id: `settled:${reservationId}`,
          reservationId,
          units: actualTokens,
          timestamp,
        })
      }
    }

    if (this.quotaPauseActive && this.hasAnyAvailablePool()) {
      this.triggerQuotaResume()
    }
  }

  // --- Fleet Store Integration Hooks ---

  private triggerQuotaPause(): void {
    if (!this.quotaPauseActive) {
      this.quotaPauseActive = true
      if (this.fleetStore) {
        const p = this.fleetStore.pause('quota').catch(() => {})
        this.hookPromise = this.hookPromise.then(() => p)
      }
    }
  }

  private triggerQuotaResume(): void {
    if (this.quotaPauseActive) {
      this.quotaPauseActive = false
      if (this.fleetStore) {
        const p = this.fleetStore.resume('quota').catch(() => {})
        this.hookPromise = this.hookPromise.then(() => p)
      }
    }
  }

  private hasAnyAvailablePool(): boolean {
    for (const poolId of this.poolOrder) {
      const pool = this.pools.get(poolId)!
      if (pool.config.enabled === false) continue
      const res = this.evaluateAvailableQuota(poolId)
      if (res.classification === 'AVAILABLE') return true
    }
    return false
  }

  async waitForHooks(): Promise<void> {
    await this.hookPromise
  }
}
