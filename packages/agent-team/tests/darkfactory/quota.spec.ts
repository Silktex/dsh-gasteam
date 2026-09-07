import { describe, it, expect, beforeEach } from 'vitest'
import { ZodError } from 'zod'
import {
  DarkFactoryQuotaManager,
  QuotaManagerError,
  QuotaStaleError,
  QuotaExhaustedError,
  EmergencyReserveBreachError,
  NoEligiblePoolError,
  InvalidEmergencyGrantError,
  UnrecognizedEmergencyPurposeError,
  CrossProjectQuotaError,
  UnknownPoolError,
  UnitMismatchError,
  StaleSnapshotError,
  PolicyRejectionError,
  compareTime,
  type QuotaPoolConfig,
} from '../../src/darkfactory/quota-manager.ts'
import {
  type ProviderQuotaV1,
  type ReservationV1,
  type UsageEventPayload,
  type UsageEventV1,
} from '../../src/darkfactory/contracts/economics.ts'
import { type ArtifactRef } from '../../src/darkfactory/contracts/common.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { assertContractSemantics } from '../../src/darkfactory/contracts/semantics.ts'
import { InMemoryRedisAdapter } from '../../src/darkfactory/redis-adapter.ts'
import { DarkFactoryFleetStore } from '../../src/darkfactory/fleet-store.ts'

// --- Deterministic Test Helpers ---

export interface TestClock {
  now: () => string
  set: (isoTime: string) => void
  advanceMs: (ms: number) => void
  advanceSec: (sec: number) => void
}

export function makeTestClock(initialIso = '2026-09-06T22:00:00.000Z'): TestClock {
  let currentTime = initialIso
  return {
    now: () => currentTime,
    set: (iso: string) => {
      currentTime = iso
    },
    advanceMs: (ms: number) => {
      const d = new Date(currentTime)
      d.setTime(d.getTime() + ms)
      currentTime = d.toISOString()
    },
    advanceSec: (sec: number) => {
      const d = new Date(currentTime)
      d.setTime(d.getTime() + sec * 1000)
      currentTime = d.toISOString()
    },
  }
}

export function createMockQuotasConfig(): QuotaPoolConfig[] {
  return [
    {
      id: 'pool-sub-primary',
      provider: 'subscription',
      adapterId: 'adapter-azure-openai',
      secretRef: { kind: 'env', name: 'SEC_AZURE_QUOTA' },
      ttlMs: 300_000,
    },
    {
      id: 'pool-sub-secondary',
      provider: 'subscription',
      adapterId: 'adapter-bedrock',
      secretRef: { kind: 'env', name: 'SEC_BEDROCK_QUOTA' },
      ttlMs: 300_000,
    },
    {
      id: 'pool-metered-fallback',
      provider: 'metered',
      adapterId: 'adapter-direct-api',
      secretRef: { kind: 'env', name: 'SEC_DIRECT_API' },
      ttlMs: 300_000,
      enabled: true,
    },
  ]
}

export function createMockProviderQuota(
  overrides?: Partial<ProviderQuotaV1>,
  skipSemantics = false,
): ProviderQuotaV1 {
  const at = overrides?.observedAt ?? '2026-09-06T22:00:00.000Z'
  const observedMs = Date.parse(at)
  const windowEnd = overrides?.windowEnd ?? new Date(observedMs + 86_400_000).toISOString()
  const expiresAt = overrides?.expiresAt ?? new Date(observedMs + 300_000).toISOString()
  const resetAt = overrides?.resetAt ?? windowEnd
  const snapshot: ProviderQuotaV1 = {
    schemaVersion: 1,
    id: 'quota-snap-primary-1',
    projectId: 'proj-fleet-1',
    policyRevision: 1,
    fleetId: 'fleet-primary',
    accountId: 'acc-corp-1',
    poolId: 'pool-sub-primary',
    unit: 'tokens',
    total: 1_000_000,
    observedRemaining: 800_000,
    windowStart: '2026-09-06T00:00:00.000Z',
    windowEnd,
    resetAt,
    observedAt: at,
    expiresAt,
    adapter: 'adapter-azure-openai',
    adapterVersion: 'v1',
    source: {
      projectId: 'proj-fleet-1',
      id: 'art-quota-source-1',
      mediaType: 'application/json',
      sizeBytes: 512,
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
    },
    authority: 'provider',
    watermark: 'evt-watermark-0',
    ...overrides,
  }
  if (!skipSemantics) {
    assertContractSemantics('ProviderQuotaV1', snapshot)
  }
  return snapshot
}

export function createMockArtifactRef(id = 'art-evidence-1', projectId = 'proj-fleet-1'): ArtifactRef {
  return {
    projectId,
    id,
    mediaType: 'application/json',
    sizeBytes: 1024,
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }
}

export function createMockUsageEvent(overrides?: Partial<UsageEventPayload>): UsageEventV1 {
  const payload: UsageEventPayload = {
    schemaVersion: 1,
    id: 'usage-evt-1',
    projectId: 'proj-fleet-1',
    policyRevision: 1,
    fleetId: 'fleet-primary',
    hostId: 'host-worker-1',
    attemptId: 'att-attempt-1',
    generation: 1,
    provider: 'prov-deepseek',
    accountId: 'acc-corp-1',
    modelVersion: 'deepseek-v3',
    requestId: 'req-req-1',
    streamSequence: 1,
    pricingRevision: 1,
    usageAt: '2026-09-06T22:01:00.000Z',
    inputTokens: 1000,
    cacheTokens: 0,
    outputTokens: 500,
    reasoningTokens: 0,
    countingSemantics: 'exclusive-categories',
    billedCostMicros: 6000,
    currency: 'USD',
    reservationId: 'res-reservation-1',
    ...overrides,
  }
  const event: UsageEventV1 = {
    ...payload,
    eventDigest: digestJson(payload),
  }
  assertContractSemantics('UsageEventV1', event)
  return event
}

export function createMockReservation(overrides?: Partial<ReservationV1>): ReservationV1 {
  const res: ReservationV1 = {
    schemaVersion: 1,
    id: 'res-reservation-1',
    projectId: 'proj-fleet-1',
    policyRevision: 1,
    fleetId: 'fleet-primary',
    hostId: 'host-worker-1',
    accountId: 'acc-corp-1',
    attemptId: 'att-attempt-1',
    generation: 1,
    requestId: 'req-req-1',
    authorityEpoch: 'epoch-1',
    fencingToken: 1,
    pricingRevision: 1,
    currency: 'USD',
    maxCostMicros: 100_000,
    maxTokens: 100_000,
    maxRequests: 10,
    quotaPoolIds: ['pool-sub-primary'],
    purpose: 'routine',
    purposeEvidence: [],
    createdAt: '2026-09-06T22:00:30.000Z',
    reconcileBy: '2026-09-06T22:15:00.000Z',
    accountingDay: '2026-09-06',
    accountingMonth: '2026-09',
    state: 'reserved',
    ...overrides,
  }
  assertContractSemantics('ReservationV1', res)
  return res
}

// ============================================================================
// Tier 1: Feature Coverage (F17 - F23, 7 Tests per Feature = 49 Cases)
// ============================================================================

describe('DF-16 Tier 1: Feature Tests', () => {
  let clock: TestClock
  let manager: DarkFactoryQuotaManager

  beforeEach(() => {
    clock = makeTestClock('2026-09-06T22:00:00.000Z')
    manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })
  })

  // --- Feature 17: Authenticated Quota Adapter & Snapshot Ingestion ---
  describe('Feature 17: Authenticated Quota Adapter & Snapshot Ingestion', () => {
    it('TC-DF16-T1-F17-01: Register valid subscription quota snapshot', () => {
      const snap = createMockProviderQuota()
      manager.registerSnapshot(snap)

      expect(manager.getSnapshot('pool-sub-primary')).toEqual(snap)
      const evaluation = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evaluation.classification).toBe('AVAILABLE')
      expect(evaluation.effectiveAvailable).toBe(800_000)
    })

    it('TC-DF16-T1-F17-02: Reject malformed snapshot failing Zod schema', () => {
      const badSnap = {
        ...createMockProviderQuota(),
        total: -100, // Invalid counter
      }
      expect(() => manager.registerSnapshot(badSnap as any)).toThrow(ZodError)
    })

    it('TC-DF16-T1-F17-03: Reject snapshot with observedRemaining > total', () => {
      const badSnap = createMockProviderQuota(
        {
          total: 1000,
          observedRemaining: 1500,
        },
        true,
      )
      expect(() => manager.registerSnapshot(badSnap)).toThrow('Remaining quota exceeds total')
    })

    it('TC-DF16-T1-F17-04: Reject inverted timestamp windows', () => {
      const badSnap = createMockProviderQuota(
        {
          observedAt: '2026-09-06T22:10:00.000Z',
          expiresAt: '2026-09-06T22:05:00.000Z',
        },
        true,
      )
      expect(() => manager.registerSnapshot(badSnap)).toThrow(/Invalid quota expiry time order/)
    })

    it('TC-DF16-T1-F17-05: Reject snapshot for unconfigured pool ID', () => {
      const unconfSnap = createMockProviderQuota({
        id: 'snap-unconf',
        poolId: 'unknown-pool',
      })
      expect(() => manager.registerSnapshot(unconfSnap)).toThrow(UnknownPoolError)
    })

    it('TC-DF16-T1-F17-06: Ingest newer snapshot cleans obsolete unreflected usage', () => {
      const snap1 = createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' })
      manager.registerSnapshot(snap1)

      const evt1 = createMockUsageEvent({
        id: 'evt-1',
        usageAt: '2026-09-06T22:01:00.000Z',
        inputTokens: 50_000,
        outputTokens: 0,
        cacheTokens: 0,
        reasoningTokens: 0,
      })
      manager.recordUsage('pool-sub-primary', evt1)

      let evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.unreflectedUsage).toBe(50_000)

      // Snap 2 observed at 22:02:00 reflects evt1
      clock.set('2026-09-06T22:02:00.000Z')
      const snap2 = createMockProviderQuota({
        id: 'snap-2',
        observedAt: '2026-09-06T22:02:00.000Z',
        observedRemaining: 750_000,
        watermark: 'evt-1',
      })
      manager.registerSnapshot(snap2)

      evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.unreflectedUsage).toBe(0)
      expect(evalRes.effectiveAvailable).toBe(750_000)
    })

    it('TC-DF16-T1-F17-07: Idempotent snapshot re-registration', () => {
      const snap = createMockProviderQuota()
      manager.registerSnapshot(snap)
      manager.registerSnapshot(snap)

      expect(manager.getSnapshot('pool-sub-primary')).toEqual(snap)
      expect(manager.evaluateAvailableQuota('pool-sub-primary').effectiveAvailable).toBe(800_000)
    })
  })

  // --- Feature 18: Quota 5-Minute TTL and Freshness Window ---
  describe('Feature 18: Quota 5-Minute TTL and Freshness Window', () => {
    it('TC-DF16-T1-F18-01: Fresh snapshot within 5-minute TTL evaluates fresh', () => {
      const snap = createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' })
      manager.registerSnapshot(snap)

      clock.advanceSec(120) // 2 minutes later
      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.isFresh).toBe(true)
      expect(evalRes.classification).toBe('AVAILABLE')
    })

    it('TC-DF16-T1-F18-02: Snapshot past 5-minute TTL marked STALE', () => {
      const snap = createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' })
      manager.registerSnapshot(snap)

      clock.advanceMs(300_001) // 300s + 1ms
      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.isFresh).toBe(false)
      expect(evalRes.classification).toBe('STALE')
    })

    it('TC-DF16-T1-F18-03: Provider resetAt shortens default 5-minute TTL', () => {
      const snap = createMockProviderQuota({
        observedAt: '2026-09-06T22:00:00.000Z',
        resetAt: '2026-09-06T22:01:00.000Z',
        windowEnd: '2026-09-06T22:01:00.000Z',
        expiresAt: '2026-09-06T22:01:00.000Z',
      })
      manager.registerSnapshot(snap)

      clock.advanceSec(61) // Past resetAt
      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.isFresh).toBe(false)
      expect(evalRes.classification).toBe('STALE')
    })

    it('TC-DF16-T1-F18-04: Provider expiresAt shortens default 5-minute TTL', () => {
      const snap = createMockProviderQuota({
        observedAt: '2026-09-06T22:00:00.000Z',
        expiresAt: '2026-09-06T22:01:30.000Z',
      })
      manager.registerSnapshot(snap)

      clock.advanceSec(91) // Past expiresAt
      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.isFresh).toBe(false)
      expect(evalRes.classification).toBe('STALE')
    })

    it('TC-DF16-T1-F18-05: Calendar windowEnd triggers STALE', () => {
      const snap = createMockProviderQuota({
        observedAt: '2026-09-06T22:00:00.000Z',
        windowEnd: '2026-09-06T22:03:00.000Z',
        resetAt: '2026-09-06T22:03:00.000Z',
        expiresAt: '2026-09-06T22:03:00.000Z',
      })
      manager.registerSnapshot(snap)

      clock.advanceSec(181) // Past windowEnd
      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.isFresh).toBe(false)
      expect(evalRes.classification).toBe('STALE')
    })

    it('TC-DF16-T1-F18-06: Stale pool fails closed for routine and emergency', () => {
      const snap = createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' })
      manager.registerSnapshot(snap)

      clock.advanceSec(301) // Stale

      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 1000,
          purpose: 'routine',
          candidatePoolIds: ['pool-sub-primary'],
        }),
      ).toThrow(QuotaStaleError)

      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 1000,
          purpose: 'canary-recovery',
          purposeEvidence: [createMockArtifactRef()],
          candidatePoolIds: ['pool-sub-primary'],
        }),
      ).toThrow(QuotaStaleError)
    })

    it('TC-DF16-T1-F18-07: Fresh snapshot arrival recovers pool from STALE', () => {
      const snap1 = createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' })
      manager.registerSnapshot(snap1)

      clock.advanceSec(305)
      expect(manager.classifyPool('pool-sub-primary')).toBe('STALE')

      // Ingest fresh snapshot at new clock
      const freshSnap = createMockProviderQuota({
        id: 'snap-fresh-2',
        observedAt: clock.now(),
        expiresAt: '2026-09-06T22:10:05.000Z',
        windowStart: '2026-09-06T22:00:00.000Z',
        windowEnd: '2026-09-07T00:00:00.000Z',
        resetAt: '2026-09-07T00:00:00.000Z',
      })
      manager.registerSnapshot(freshSnap)

      expect(manager.classifyPool('pool-sub-primary')).toBe('AVAILABLE')
    })
  })

  // --- Feature 19: Provider Snapshot Watermark & Watermark Calculation ---
  describe('Feature 19: Provider Snapshot Watermark & Watermark Calculation', () => {
    it('TC-DF16-T1-F19-01: Baseline watermark math with zero unreflected usage', () => {
      manager.registerSnapshot(createMockProviderQuota())
      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.effectiveAvailable).toBe(800_000)
      expect(evalRes.unreflectedUsage).toBe(0)
      expect(evalRes.activeReservations).toBe(0)
    })

    it('TC-DF16-T1-F19-02: Deduct unreflected local usage occurring strictly after watermark', () => {
      manager.registerSnapshot(createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' }))

      const evt = createMockUsageEvent({
        usageAt: '2026-09-06T22:00:10.000Z',
        inputTokens: 30_000,
        outputTokens: 20_000,
        cacheTokens: 0,
        reasoningTokens: 0,
      })
      manager.recordUsage('pool-sub-primary', evt)

      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.unreflectedUsage).toBe(50_000)
      expect(evalRes.effectiveAvailable).toBe(750_000)
    })

    it('TC-DF16-T1-F19-03: Prevent double subtraction of usage before watermark', () => {
      manager.registerSnapshot(createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' }))

      // Event occurred 5s before observedAt -> already reflected in observedRemaining
      const evt = createMockUsageEvent({
        usageAt: '2026-09-06T21:59:55.000Z',
        inputTokens: 100_000,
        outputTokens: 0,
        cacheTokens: 0,
        reasoningTokens: 0,
      })
      manager.recordUsage('pool-sub-primary', evt)

      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.unreflectedUsage).toBe(0)
      expect(evalRes.effectiveAvailable).toBe(800_000)
    })

    it('TC-DF16-T1-F19-04: Deduct active outstanding reservations', () => {
      manager.registerSnapshot(createMockProviderQuota())
      const res = createMockReservation({ maxTokens: 120_000 })
      manager.recordReservation('pool-sub-primary', res)

      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.activeReservations).toBe(120_000)
      expect(evalRes.effectiveAvailable).toBe(680_000)
    })

    it('TC-DF16-T1-F19-05: Settle reservation without phantom capacity bounce', () => {
      manager.registerSnapshot(createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' }))
      const res = createMockReservation({
        id: 'res-1',
        maxTokens: 120_000,
        createdAt: '2026-09-06T22:00:05.000Z',
      })
      manager.recordReservation('pool-sub-primary', res)

      // Reservation settles with actual 30k tokens
      manager.settleReservation('pool-sub-primary', 'res-1', 30_000)

      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.activeReservations).toBe(0)
      expect(evalRes.unreflectedUsage).toBe(30_000)
      expect(evalRes.effectiveAvailable).toBe(770_000)
    })

    it('TC-DF16-T1-F19-06: Cancel reservation restores capacity', () => {
      manager.registerSnapshot(createMockProviderQuota())
      const res = createMockReservation({ id: 'res-cancel', maxTokens: 100_000 })
      manager.recordReservation('pool-sub-primary', res)
      expect(manager.evaluateAvailableQuota('pool-sub-primary').effectiveAvailable).toBe(700_000)

      manager.cancelReservation('pool-sub-primary', 'res-cancel')
      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.activeReservations).toBe(0)
      expect(evalRes.effectiveAvailable).toBe(800_000)
    })

    it('TC-DF16-T1-F19-07: Advance watermark on new snapshot clears covered local events', () => {
      manager.registerSnapshot(createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' }))

      const evt1 = createMockUsageEvent({ id: 'evt-1', usageAt: '2026-09-06T22:00:10.000Z', inputTokens: 20_000, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 })
      const evt2 = createMockUsageEvent({ id: 'evt-2', usageAt: '2026-09-06T22:00:20.000Z', inputTokens: 30_000, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 })
      manager.recordUsage('pool-sub-primary', evt1)
      manager.recordUsage('pool-sub-primary', evt2)
      expect(manager.evaluateAvailableQuota('pool-sub-primary').unreflectedUsage).toBe(50_000)

      // Snapshot 2 at 22:00:30 covers both events
      const snap2 = createMockProviderQuota({
        id: 'snap-2',
        observedAt: '2026-09-06T22:00:30.000Z',
        observedRemaining: 750_000,
        watermark: 'evt-2',
      })
      manager.registerSnapshot(snap2)

      const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.unreflectedUsage).toBe(0)
      expect(evalRes.effectiveAvailable).toBe(750_000)
    })
  })

  // --- Feature 20: Routing Waterfall Order ---
  describe('Feature 20: Routing Waterfall Order', () => {
    it('TC-DF16-T1-F20-01: Routine request routes to Primary Subscription', () => {
      manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', observedRemaining: 800_000 }))
      manager.registerSnapshot(createMockProviderQuota({ id: 'snap-sec', poolId: 'pool-sub-secondary', observedRemaining: 800_000 }))

      const result = manager.selectPoolForRequest({
        requestedUnits: 10_000,
        purpose: 'routine',
      })
      expect(result.poolId).toBe('pool-sub-primary')
      expect(result.mode).toBe('subscription')
      expect(result.emergency).toBe(false)
    })

    it('TC-DF16-T1-F20-02: Fallback to Alternative Subscription when Primary exhausted', () => {
      // Primary at 5% (50k / 1M) -> RESERVED_EMERGENCY_ONLY
      manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', observedRemaining: 50_000 }))
      // Secondary healthy
      manager.registerSnapshot(createMockProviderQuota({ id: 'snap-sec', poolId: 'pool-sub-secondary', observedRemaining: 800_000 }))

      const result = manager.selectPoolForRequest({
        requestedUnits: 10_000,
        purpose: 'routine',
      })
      expect(result.poolId).toBe('pool-sub-secondary')
      expect(result.mode).toBe('subscription')
      expect(result.emergency).toBe(false)
    })

    it('TC-DF16-T1-F20-03: Sequential evaluation of multiple alternative subscriptions', () => {
      const cfg: QuotaPoolConfig[] = [
        { id: 'sub-1', provider: 'subscription', adapterId: 'ad', secretRef: { kind: 'env', name: 'S1' }, ttlMs: 300_000 },
        { id: 'sub-2', provider: 'subscription', adapterId: 'ad', secretRef: { kind: 'env', name: 'S2' }, ttlMs: 300_000 },
        { id: 'sub-3', provider: 'subscription', adapterId: 'ad', secretRef: { kind: 'env', name: 'S3' }, ttlMs: 300_000 },
      ]
      const mgr = new DarkFactoryQuotaManager({ quotasConfig: cfg, clock: () => clock.now(), projectId: 'proj-fleet-1' })

      mgr.registerSnapshot(createMockProviderQuota({ id: 's1', poolId: 'sub-1', observedRemaining: 50_000 })) // 5%
      mgr.registerSnapshot(createMockProviderQuota({ id: 's2', poolId: 'sub-2', observedRemaining: 50_000 })) // 5%
      mgr.registerSnapshot(createMockProviderQuota({ id: 's3', poolId: 'sub-3', observedRemaining: 500_000 })) // 50%

      const res = mgr.selectPoolForRequest({ requestedUnits: 10_000, purpose: 'routine' })
      expect(res.poolId).toBe('sub-3')
    })

    it('TC-DF16-T1-F20-04: Fallback to Metered Deployment when all subscriptions at reserve', () => {
      manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', observedRemaining: 50_000 }))
      manager.registerSnapshot(createMockProviderQuota({ id: 'snap-sec', poolId: 'pool-sub-secondary', observedRemaining: 50_000 }))
      manager.registerSnapshot(createMockProviderQuota({ id: 'snap-met', poolId: 'pool-metered-fallback', observedRemaining: 500_000 }))

      const result = manager.selectPoolForRequest({
        requestedUnits: 10_000,
        purpose: 'routine',
      })
      expect(result.poolId).toBe('pool-metered-fallback')
      expect(result.mode).toBe('metered')
    })

    it('TC-DF16-T1-F20-05: Fail-closed when all subscriptions and metered exhausted', () => {
      manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', observedRemaining: 50_000 }))
      manager.registerSnapshot(createMockProviderQuota({ id: 'snap-sec', poolId: 'pool-sub-secondary', observedRemaining: 50_000 }))
      manager.registerSnapshot(createMockProviderQuota({ id: 'snap-met', poolId: 'pool-metered-fallback', observedRemaining: 0 }))

      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 10_000,
          purpose: 'routine',
        }),
      ).toThrow(NoEligiblePoolError)
    })

    it('TC-DF16-T1-F20-06: Respect explicit candidatePoolIds filter', () => {
      manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', observedRemaining: 800_000 }))
      manager.registerSnapshot(createMockProviderQuota({ id: 'snap-sec', poolId: 'pool-sub-secondary', observedRemaining: 800_000 }))

      const result = manager.selectPoolForRequest({
        requestedUnits: 10_000,
        purpose: 'routine',
        candidatePoolIds: ['pool-sub-secondary'],
      })
      expect(result.poolId).toBe('pool-sub-secondary')
    })

    it('TC-DF16-T1-F20-07: Filter pools by unit type', () => {
      const cfg: QuotaPoolConfig[] = [
        { id: 'pool-token', provider: 'subscription', adapterId: 'ad1', secretRef: { kind: 'env', name: 'S1' }, ttlMs: 300_000 },
        { id: 'pool-req', provider: 'subscription', adapterId: 'ad2', secretRef: { kind: 'env', name: 'S2' }, ttlMs: 300_000 },
      ]
      const mgr = new DarkFactoryQuotaManager({ quotasConfig: cfg, clock: () => clock.now(), projectId: 'proj-fleet-1' })
      mgr.registerSnapshot(createMockProviderQuota({ id: 's-tok', poolId: 'pool-token', unit: 'tokens', observedRemaining: 500_000 }))
      mgr.registerSnapshot(createMockProviderQuota({ id: 's-req', poolId: 'pool-req', unit: 'requests', total: 1000, observedRemaining: 500 }))

      const result = mgr.selectPoolForRequest({
        requestedUnits: 5,
        unit: 'requests',
        purpose: 'routine',
      })
      expect(result.poolId).toBe('pool-req')
    })
  })

  // --- Feature 21: 10% Emergency Reserve Boundary & Pool Classification ---
  describe('Feature 21: 10% Emergency Reserve Boundary & Pool Classification', () => {
    it('TC-DF16-T1-F21-01: Classify pool with > 10% capacity as AVAILABLE', () => {
      manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_001 }))
      expect(manager.classifyPool('pool-sub-primary')).toBe('AVAILABLE')
    })

    it('TC-DF16-T1-F21-02: Classify pool with <= 10% capacity as RESERVED_EMERGENCY_ONLY', () => {
      manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_000 }))
      expect(manager.classifyPool('pool-sub-primary')).toBe('RESERVED_EMERGENCY_ONLY')
    })

    it('TC-DF16-T1-F21-03: Permit routine request leaving >= 10% in pool', () => {
      manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 150_000 }))
      const result = manager.selectPoolForRequest({
        requestedUnits: 50_000,
        purpose: 'routine',
        candidatePoolIds: ['pool-sub-primary'],
      })
      expect(result.poolId).toBe('pool-sub-primary')
      expect(result.remainingAfterRequest).toBe(100_000)
    })

    it('TC-DF16-T1-F21-04: Reject routine request leaving < 10% in pool', () => {
      manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 150_000 }))
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 50_001,
          purpose: 'routine',
          candidatePoolIds: ['pool-sub-primary'],
        }),
      ).toThrow(EmergencyReserveBreachError)
    })

    it('TC-DF16-T1-F21-05: Reject routine request on RESERVED_EMERGENCY_ONLY pool', () => {
      manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_000 }))
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 1,
          purpose: 'routine',
          candidatePoolIds: ['pool-sub-primary'],
        }),
      ).toThrow(EmergencyReserveBreachError)
    })

    it('TC-DF16-T1-F21-06: Permit emergency request to consume into 10% reserve', () => {
      manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_000 }))
      const result = manager.selectPoolForRequest({
        requestedUnits: 40_000,
        purpose: 'canary-recovery',
        purposeEvidence: [createMockArtifactRef()],
        candidatePoolIds: ['pool-sub-primary'],
      })
      expect(result.emergency).toBe(true)
      expect(result.remainingAfterRequest).toBe(60_000)
    })

    it('TC-DF16-T1-F21-07: Configurable reserveFraction parameter', () => {
      const customMgr = new DarkFactoryQuotaManager({
        quotasConfig: createMockQuotasConfig(),
        reserveFraction: 0.15, // 15%
        clock: () => clock.now(),
        projectId: 'proj-fleet-1',
      })
      customMgr.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 140_000 }))
      expect(customMgr.classifyPool('pool-sub-primary')).toBe('RESERVED_EMERGENCY_ONLY')
    })
  })

  // --- Feature 22: Typed Emergency Purposes Validation ---
  describe('Feature 22: Typed Emergency Purposes Validation', () => {
    beforeEach(() => {
      manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_000 }))
    })

    it('TC-DF16-T1-F22-01: Accept valid canary-recovery emergency purpose', () => {
      const res = manager.selectPoolForRequest({
        requestedUnits: 10_000,
        purpose: 'canary-recovery',
        purposeEvidence: [createMockArtifactRef()],
        candidatePoolIds: ['pool-sub-primary'],
      })
      expect(res.emergency).toBe(true)
    })

    it('TC-DF16-T1-F22-02: Accept valid verified-p0-security emergency purpose', () => {
      const res = manager.selectPoolForRequest({
        requestedUnits: 10_000,
        purpose: 'verified-p0-security',
        purposeEvidence: [createMockArtifactRef()],
        candidatePoolIds: ['pool-sub-primary'],
      })
      expect(res.emergency).toBe(true)
    })

    it('TC-DF16-T1-F22-03: Accept valid production-invariant-recovery purpose', () => {
      const res = manager.selectPoolForRequest({
        requestedUnits: 10_000,
        purpose: 'production-invariant-recovery',
        purposeEvidence: [createMockArtifactRef()],
        candidatePoolIds: ['pool-sub-primary'],
      })
      expect(res.emergency).toBe(true)
    })

    it('TC-DF16-T1-F22-04: Reject untyped plain-text priority strings', () => {
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 10_000,
          purpose: 'P0' as any,
          purposeEvidence: [createMockArtifactRef()],
        }),
      ).toThrow(UnrecognizedEmergencyPurposeError)

      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 10_000,
          purpose: 'CRITICAL' as any,
          purposeEvidence: [createMockArtifactRef()],
        }),
      ).toThrow(UnrecognizedEmergencyPurposeError)
    })

    it('TC-DF16-T1-F22-05: Reject model-prompt claims of urgency', () => {
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 10_000,
          purpose: 'model-urgent-fix' as any,
          purposeEvidence: [createMockArtifactRef()],
        }),
      ).toThrow(UnrecognizedEmergencyPurposeError)
    })

    it('TC-DF16-T1-F22-06: Reject emergency purpose disabled in fleet config', () => {
      const strictMgr = new DarkFactoryQuotaManager({
        quotasConfig: createMockQuotasConfig(),
        allowedEmergencyPurposes: ['canary-recovery'],
        clock: () => clock.now(),
        projectId: 'proj-fleet-1',
      })
      strictMgr.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_000 }))

      expect(() =>
        strictMgr.selectPoolForRequest({
          requestedUnits: 10_000,
          purpose: 'production-invariant-recovery',
          purposeEvidence: [createMockArtifactRef()],
        }),
      ).toThrow(UnrecognizedEmergencyPurposeError)
    })

    it('TC-DF16-T1-F22-07: Reject routine purpose attempting to access emergency reserve', () => {
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 5_000,
          purpose: 'routine',
          candidatePoolIds: ['pool-sub-primary'],
        }),
      ).toThrow(EmergencyReserveBreachError)
    })
  })

  // --- Feature 23: Emergency Purpose Grant Registry & Evidence Linking ---
  describe('Feature 23: Emergency Purpose Grant Registry & Evidence Linking', () => {
    beforeEach(() => {
      manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_000 }))
    })

    it('TC-DF16-T1-F23-01: Valid emergency grant with verified artifact reference', () => {
      const res = manager.selectPoolForRequest({
        requestedUnits: 20_000,
        purpose: 'canary-recovery',
        purposeEvidence: [createMockArtifactRef()],
        candidatePoolIds: ['pool-sub-primary'],
      })
      expect(res.emergency).toBe(true)
    })

    it('TC-DF16-T1-F23-02: Reject emergency request with empty purposeEvidence: []', () => {
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 20_000,
          purpose: 'canary-recovery',
          purposeEvidence: [],
        }),
      ).toThrow(InvalidEmergencyGrantError)
    })

    it('TC-DF16-T1-F23-03: Reject emergency request with omitted purposeEvidence', () => {
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 20_000,
          purpose: 'canary-recovery',
        }),
      ).toThrow(InvalidEmergencyGrantError)
    })

    it('TC-DF16-T1-F23-04: Reject cross-project artifact reference in purposeEvidence', () => {
      const crossArtifact = createMockArtifactRef('art-cross', 'other-proj')
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 20_000,
          purpose: 'canary-recovery',
          purposeEvidence: [crossArtifact],
        }),
      ).toThrow(CrossProjectQuotaError)
    })

    it('TC-DF16-T1-F23-05: Reject malformed artifact digest format in evidence', () => {
      const malformedArtifact = {
        ...createMockArtifactRef(),
        digest: 'invalid-digest-not-sha256',
      }
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 20_000,
          purpose: 'canary-recovery',
          purposeEvidence: [malformedArtifact as any],
        }),
      ).toThrow(InvalidEmergencyGrantError)
    })

    it('TC-DF16-T1-F23-06: Enforce maximum 32 grant evidence artifacts', () => {
      const thirtyThreeArtifacts: ArtifactRef[] = []
      for (let i = 0; i < 33; i++) {
        thirtyThreeArtifacts.push(createMockArtifactRef(`art-${i}`))
      }
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 20_000,
          purpose: 'canary-recovery',
          purposeEvidence: thirtyThreeArtifacts,
        }),
      ).toThrow(InvalidEmergencyGrantError)
    })

    it('TC-DF16-T1-F23-07: Reject duplicate evidence artifact references', () => {
      const art = createMockArtifactRef('art-dup-1')
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 20_000,
          purpose: 'canary-recovery',
          purposeEvidence: [art, art],
        }),
      ).toThrow(InvalidEmergencyGrantError)
    })
  })
})

// ============================================================================
// Tier 2: Boundary & Corner Cases (16 Test Cases)
// ============================================================================

describe('DF-16 Tier 2: Boundary and Corner Tests', () => {
  let clock: TestClock
  let manager: DarkFactoryQuotaManager

  beforeEach(() => {
    clock = makeTestClock('2026-09-06T22:00:00.000Z')
    manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })
  })

  it('TC-DF16-T2-B01: TTL Freshness at 299s', () => {
    manager.registerSnapshot(createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' }))
    clock.advanceMs(299_000) // 299s
    const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes.isFresh).toBe(true)
    expect(evalRes.classification).toBe('AVAILABLE')
  })

  it('TC-DF16-T2-B02: TTL Boundary at 299.999s', () => {
    manager.registerSnapshot(createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' }))
    clock.advanceMs(299_999)
    const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes.isFresh).toBe(true)
    expect(evalRes.classification).toBe('AVAILABLE')
  })

  it('TC-DF16-T2-B03: TTL Expiry at exactly 300s', () => {
    manager.registerSnapshot(createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' }))
    clock.advanceMs(300_000)
    const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes.isFresh).toBe(false)
    expect(evalRes.classification).toBe('STALE')
  })

  it('TC-DF16-T2-B04: TTL Stale at 300.001s / 301s', () => {
    manager.registerSnapshot(createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.000Z' }))
    clock.advanceMs(300_001)
    const evalRes1 = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes1.isFresh).toBe(false)
    expect(evalRes1.classification).toBe('STALE')

    clock.advanceMs(999) // 301s
    const evalRes2 = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes2.isFresh).toBe(false)
    expect(evalRes2.classification).toBe('STALE')
  })

  it('TC-DF16-T2-B05: 10% Reserve at 10.001%', () => {
    manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_010 }))
    const res = manager.selectPoolForRequest({
      requestedUnits: 10,
      purpose: 'routine',
      candidatePoolIds: ['pool-sub-primary'],
    })
    expect(res.remainingAfterRequest).toBe(100_000)
  })

  it('TC-DF16-T2-B06: 10% Reserve Boundary at 10.000%', () => {
    manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 100_000 }))
    expect(manager.classifyPool('pool-sub-primary')).toBe('RESERVED_EMERGENCY_ONLY')
    expect(() =>
      manager.selectPoolForRequest({
        requestedUnits: 1,
        purpose: 'routine',
        candidatePoolIds: ['pool-sub-primary'],
      }),
    ).toThrow(EmergencyReserveBreachError)
  })

  it('TC-DF16-T2-B07: 10% Reserve at 9.999%', () => {
    manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 99_990 }))
    expect(() =>
      manager.selectPoolForRequest({
        requestedUnits: 1,
        purpose: 'routine',
        candidatePoolIds: ['pool-sub-primary'],
      }),
    ).toThrow(EmergencyReserveBreachError)

    const res = manager.selectPoolForRequest({
      requestedUnits: 10_000,
      purpose: 'canary-recovery',
      purposeEvidence: [createMockArtifactRef()],
      candidatePoolIds: ['pool-sub-primary'],
    })
    expect(res.remainingAfterRequest).toBe(89_990)
  })

  it('TC-DF16-T2-B08: Routine Request leaving exactly 10.000%', () => {
    manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 150_000 }))
    const res = manager.selectPoolForRequest({
      requestedUnits: 50_000,
      purpose: 'routine',
      candidatePoolIds: ['pool-sub-primary'],
    })
    expect(res.remainingAfterRequest).toBe(100_000)
  })

  it('TC-DF16-T2-B09: Routine Request leaving 9.999%', () => {
    manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 150_000 }))
    expect(() =>
      manager.selectPoolForRequest({
        requestedUnits: 50_001,
        purpose: 'routine',
        candidatePoolIds: ['pool-sub-primary'],
      }),
    ).toThrow(EmergencyReserveBreachError)
  })

  it('TC-DF16-T2-B10: Zero Remaining Boundary (0 units)', () => {
    manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 0 }))
    expect(manager.classifyPool('pool-sub-primary')).toBe('EXHAUSTED')
    expect(() =>
      manager.selectPoolForRequest({
        requestedUnits: 1,
        purpose: 'canary-recovery',
        purposeEvidence: [createMockArtifactRef()],
        candidatePoolIds: ['pool-sub-primary'],
      }),
    ).toThrow(QuotaExhaustedError)
  })

  it('TC-DF16-T2-B11: Over-subscription Clamping', () => {
    manager.registerSnapshot(createMockProviderQuota({ total: 1_000_000, observedRemaining: 1_000_000 }))
    // Unreflected usage 1.2M exceeds 1.0M
    const res = manager.evaluateAvailableQuota('pool-sub-primary', 1_200_000, 0)
    expect(res.effectiveAvailable).toBe(0)
    expect(res.classification).toBe('EXHAUSTED')
  })

  it('TC-DF16-T2-B12: Sub-millisecond RFC 3339 Timestamps', () => {
    const snap = createMockProviderQuota({ observedAt: '2026-09-06T22:00:00.123Z' })
    manager.registerSnapshot(snap)

    const evt1 = createMockUsageEvent({ id: 'e1', usageAt: '2026-09-06T22:00:00.1234Z', inputTokens: 500, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 })
    const evt2 = createMockUsageEvent({ id: 'e2', usageAt: '2026-09-06T22:00:00.124Z', inputTokens: 600, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 })
    manager.recordUsage('pool-sub-primary', evt1)
    manager.recordUsage('pool-sub-primary', evt2)

    const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes.unreflectedUsage).toBe(1100)
  })

  it('TC-DF16-T2-B13: Native Unit Segregation: tokens', () => {
    manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', unit: 'tokens' }))
    expect(() =>
      manager.selectPoolForRequest({
        requestedUnits: 5,
        unit: 'requests',
        purpose: 'routine',
        candidatePoolIds: ['pool-sub-primary'],
      }),
    ).toThrow(UnitMismatchError)
  })

  it('TC-DF16-T2-B14: Native Unit Segregation: requests', () => {
    const cfg: QuotaPoolConfig[] = [
      { id: 'pool-req', provider: 'subscription', adapterId: 'ad', secretRef: { kind: 'env', name: 'S' }, ttlMs: 300_000 },
    ]
    const mgr = new DarkFactoryQuotaManager({ quotasConfig: cfg, clock: () => clock.now(), projectId: 'proj-fleet-1' })
    mgr.registerSnapshot(createMockProviderQuota({ poolId: 'pool-req', unit: 'requests', total: 1000, observedRemaining: 500 }))

    const res = mgr.evaluateAvailableQuota('pool-req')
    expect(res.unit).toBe('requests')
    expect(res.reserveLimit).toBe(100)
  })

  it('TC-DF16-T2-B15: Native Unit Segregation: credits', () => {
    const cfg: QuotaPoolConfig[] = [
      { id: 'pool-cred', provider: 'subscription', adapterId: 'ad', secretRef: { kind: 'env', name: 'S' }, ttlMs: 300_000 },
    ]
    const mgr = new DarkFactoryQuotaManager({ quotasConfig: cfg, clock: () => clock.now(), projectId: 'proj-fleet-1' })
    mgr.registerSnapshot(createMockProviderQuota({ poolId: 'pool-cred', unit: 'credits', total: 50_000, observedRemaining: 25_000 }))

    const res = mgr.evaluateAvailableQuota('pool-cred')
    expect(res.unit).toBe('credits')
    expect(res.reserveLimit).toBe(5_000)
  })

  it('TC-DF16-T2-B16: Zero Quota Total (total: 0)', () => {
    manager.registerSnapshot(createMockProviderQuota({ total: 0, observedRemaining: 0 }))
    const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes.classification).toBe('EXHAUSTED')
    expect(evalRes.reserveLimit).toBe(0)
    expect(isNaN(evalRes.reserveLimit)).toBe(false)
  })
})

// ============================================================================
// Tier 3: State Transitions & Cross-Feature Interactions (6 Test Cases)
// ============================================================================

describe('DF-16 Tier 3: Cross-Feature Interactions', () => {
  let clock: TestClock

  beforeEach(() => {
    clock = makeTestClock('2026-09-06T22:00:00.000Z')
  })

  it('TC-DF16-T3-X01: Waterfall Progression During Multi-Attempt Bursts', () => {
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })

    // Pool A (Primary): Total 1M, Available 250k (reserve = 100k)
    manager.registerSnapshot(createMockProviderQuota({ id: 's-a', poolId: 'pool-sub-primary', total: 1_000_000, observedRemaining: 250_000 }))
    // Pool B (Secondary): Total 1M, Available 300k (reserve = 100k)
    manager.registerSnapshot(createMockProviderQuota({ id: 's-b', poolId: 'pool-sub-secondary', total: 1_000_000, observedRemaining: 300_000 }))
    // Pool C (Metered): Total 1M, Available 500k
    manager.registerSnapshot(createMockProviderQuota({ id: 's-c', poolId: 'pool-metered-fallback', total: 1_000_000, observedRemaining: 500_000 }))

    // 1. Request 1 for 100k -> Routes to Pool A (leaves 150k >= 100k)
    const res1 = manager.selectPoolForRequest({ requestedUnits: 100_000, purpose: 'routine' })
    expect(res1.poolId).toBe('pool-sub-primary')
    manager.recordReservation('pool-sub-primary', createMockReservation({ id: 'r-1', maxTokens: 100_000 }))

    // 2. Request 2 for 60k -> Pool A has 150k left; 150k - 60k = 90k < 100k (breach). Waterfall routes to Pool B (leaves 240k >= 100k)
    const res2 = manager.selectPoolForRequest({ requestedUnits: 60_000, purpose: 'routine' })
    expect(res2.poolId).toBe('pool-sub-secondary')
    manager.recordReservation('pool-sub-secondary', createMockReservation({ id: 'r-2', maxTokens: 60_000 }))

    // 3. Request 3 for 160k -> Pool A has 150k left (breach). Pool B has 240k left; 240k - 160k = 80k < 100k (breach).
    // Routes to Pool C (Metered)
    const res3 = manager.selectPoolForRequest({ requestedUnits: 160_000, purpose: 'routine' })
    expect(res3.poolId).toBe('pool-metered-fallback')
    expect(res3.mode).toBe('metered')
  })

  it('TC-DF16-T3-X02: Monotonic Watermark Convergence with Asynchronous Usage Events', () => {
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })

    // S1 at T0 (800,000)
    manager.registerSnapshot(createMockProviderQuota({ id: 's-1', poolId: 'pool-sub-primary', observedAt: '2026-09-06T22:00:00.000Z', observedRemaining: 800_000 }))

    // E1 at T1 (40,000)
    manager.recordUsage('pool-sub-primary', createMockUsageEvent({ id: 'e-1', usageAt: '2026-09-06T22:00:10.000Z', inputTokens: 40_000, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 }))
    expect(manager.evaluateAvailableQuota('pool-sub-primary').effectiveAvailable).toBe(760_000)

    // E2 at T2 (60,000)
    manager.recordUsage('pool-sub-primary', createMockUsageEvent({ id: 'e-2', usageAt: '2026-09-06T22:00:20.000Z', inputTokens: 60_000, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 }))
    expect(manager.evaluateAvailableQuota('pool-sub-primary').effectiveAvailable).toBe(700_000)

    // S2 at T1.5 (22:00:15) reflecting E1 but not E2 -> observedRemaining = 760,000
    manager.registerSnapshot(createMockProviderQuota({
      id: 's-2',
      poolId: 'pool-sub-primary',
      observedAt: '2026-09-06T22:00:15.000Z',
      observedRemaining: 760_000,
      watermark: 'e-1',
    }))

    // Effective available must remain precisely 700,000 without double-deduction or bounce
    const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes.unreflectedUsage).toBe(60_000) // E2 remains
    expect(evalRes.effectiveAvailable).toBe(700_000)
  })

  it('TC-DF16-T3-X03: Concurrent Routine Rejection and Emergency Admission at Reserve Boundary', () => {
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })
    manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', total: 1_000_000, observedRemaining: 100_000 }))

    // Routine request rejected
    expect(() =>
      manager.selectPoolForRequest({
        requestedUnits: 5000,
        purpose: 'routine',
        candidatePoolIds: ['pool-sub-primary'],
      }),
    ).toThrow(EmergencyReserveBreachError)

    // Emergency request admitted down to 50,000
    const em1 = manager.selectPoolForRequest({
      requestedUnits: 50_000,
      purpose: 'canary-recovery',
      purposeEvidence: [createMockArtifactRef()],
      candidatePoolIds: ['pool-sub-primary'],
    })
    expect(em1.remainingAfterRequest).toBe(50_000)

    manager.recordReservation('pool-sub-primary', createMockReservation({ id: 'res-em1', maxTokens: 50_000 }))

    // Emergency request consumes down to 0
    const em2 = manager.selectPoolForRequest({
      requestedUnits: 50_000,
      purpose: 'canary-recovery',
      purposeEvidence: [createMockArtifactRef()],
      candidatePoolIds: ['pool-sub-primary'],
    })
    expect(em2.remainingAfterRequest).toBe(0)

    manager.recordReservation('pool-sub-primary', createMockReservation({ id: 'res-em2', maxTokens: 50_000 }))

    // Overdraft request rejected
    expect(() =>
      manager.selectPoolForRequest({
        requestedUnits: 1,
        purpose: 'canary-recovery',
        purposeEvidence: [createMockArtifactRef()],
        candidatePoolIds: ['pool-sub-primary'],
      }),
    ).toThrow(QuotaExhaustedError)
  })

  it('TC-DF16-T3-X04: Automatic Durable Quota Pause and Resumption via FleetStore Hook', async () => {
    const adapter = new InMemoryRedisAdapter()
    const fleetStore = new DarkFactoryFleetStore({
      adapter,
      config: {
        fleetId: 'fleet-primary',
        authorityEpoch: 'epoch-1',
        financialCaps: {
          fleetDailyCostMicros: 50_000_000,
          fleetMonthlyCostMicros: 1_000_000_000,
          projectDailyCostMicros: 10_000_000,
          projectMonthlyCostMicros: 200_000_000,
          hostDailyCostMicros: 5_000_000,
          hostMonthlyCostMicros: 100_000_000,
        },
        routineWatermark: 0.95,
        reserveFraction: 0.1,
        quotas: createMockQuotasConfig(),
        emergencyPurposes: ['canary-recovery', 'verified-p0-security', 'production-invariant-recovery'],
      },
    })

    // FleetStore already has active manual pause
    await fleetStore.pause('manual')
    expect(await fleetStore.getActivePauses()).toContain('manual')

    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      fleetStore,
      projectId: 'proj-fleet-1',
    })

    // Subscriptions at 5%, metered at 0
    manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', total: 1_000_000, observedRemaining: 50_000 }))
    manager.registerSnapshot(createMockProviderQuota({ id: 's2', poolId: 'pool-sub-secondary', total: 1_000_000, observedRemaining: 50_000 }))
    manager.registerSnapshot(createMockProviderQuota({ id: 's3', poolId: 'pool-metered-fallback', total: 1_000_000, observedRemaining: 0 }))

    // Evaluating routine request triggers quota pause
    expect(() => manager.selectPoolForRequest({ requestedUnits: 10_000, purpose: 'routine' })).toThrow(NoEligiblePoolError)
    await manager.waitForHooks()

    const pausesAfterExhaustion = await fleetStore.getActivePauses()
    expect(pausesAfterExhaustion).toContain('manual')
    expect(pausesAfterExhaustion).toContain('quota')

    // Snapshot arrives restoring Primary Subscription
    manager.registerSnapshot(createMockProviderQuota({
      id: 's-recovered',
      poolId: 'pool-sub-primary',
      total: 1_000_000,
      observedRemaining: 500_000,
      observedAt: clock.now(),
    }))
    await manager.waitForHooks()

    const pausesAfterRecovery = await fleetStore.getActivePauses()
    expect(pausesAfterRecovery).toContain('manual')
    expect(pausesAfterRecovery).not.toContain('quota')
  })

  it('TC-DF16-T3-X05: Reservation Lifecycle Integration (Reserve -> Stream Usage -> Settle Buffer Release)', () => {
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })
    manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', observedRemaining: 500_000 }))

    // 1. Reserve 100,000 tokens
    const res = createMockReservation({ id: 'res-stream', maxTokens: 100_000 })
    manager.recordReservation('pool-sub-primary', res)
    expect(manager.evaluateAvailableQuota('pool-sub-primary').effectiveAvailable).toBe(400_000)

    // 2. Streamed usage events arrive
    const e1 = createMockUsageEvent({ id: 'e1', reservationId: 'res-stream', usageAt: '2026-09-06T22:01:00.000Z', inputTokens: 20_000, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 })
    const e2 = createMockUsageEvent({ id: 'e2', reservationId: 'res-stream', usageAt: '2026-09-06T22:01:30.000Z', inputTokens: 30_000, outputTokens: 0, cacheTokens: 0, reasoningTokens: 0 })
    manager.recordUsage('pool-sub-primary', e1)
    manager.recordUsage('pool-sub-primary', e2)

    // 3. Settle reservation with settled 50,000 tokens
    manager.settleReservation('pool-sub-primary', 'res-stream', 50_000)

    const evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
    expect(evalRes.activeReservations).toBe(0)
    expect(evalRes.unreflectedUsage).toBe(50_000)
    expect(evalRes.effectiveAvailable).toBe(450_000) // Buffer 50k returned cleanly
  })

  it('TC-DF16-T3-X06: Rolling TTL Expiries Cascading Fallback Across Multiple Pools', () => {
    const cfg: QuotaPoolConfig[] = [
      { id: 'pool-a', provider: 'subscription', adapterId: 'ad1', secretRef: { kind: 'env', name: 'A' }, ttlMs: 300_000 },
      { id: 'pool-b', provider: 'subscription', adapterId: 'ad2', secretRef: { kind: 'env', name: 'B' }, ttlMs: 350_000 },
    ]
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: cfg,
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })

    // Pool A observed at T0, TTL 300s (expires at T0 + 300s)
    manager.registerSnapshot(createMockProviderQuota({ id: 's-a', poolId: 'pool-a', observedAt: '2026-09-06T22:00:00.000Z' }))
    // Pool B observed at T0, TTL 350s (expires at T0 + 350s)
    manager.registerSnapshot(createMockProviderQuota({
      id: 's-b',
      poolId: 'pool-b',
      observedAt: '2026-09-06T22:00:00.000Z',
      expiresAt: '2026-09-06T22:10:00.000Z',
      windowEnd: '2026-09-06T22:10:00.000Z',
      resetAt: '2026-09-06T22:10:00.000Z',
    }))

    // At T0 + 200s: both fresh -> routes to Pool A (Primary)
    clock.advanceSec(200)
    expect(manager.selectPoolForRequest({ requestedUnits: 1000, purpose: 'routine' }).poolId).toBe('pool-a')

    // At T0 + 305s: Pool A expired (TTL 300s) -> routes to Pool B (TTL 350s)
    clock.advanceSec(105) // Now at 305s
    expect(manager.selectPoolForRequest({ requestedUnits: 1000, purpose: 'routine' }).poolId).toBe('pool-b')

    // At T0 + 355s: Pool B expired (TTL 350s) -> fail-closed
    clock.advanceSec(50) // Now at 355s
    expect(() => manager.selectPoolForRequest({ requestedUnits: 1000, purpose: 'routine' })).toThrow(NoEligiblePoolError)
  })
})

// ============================================================================
// Tier 4: Real-World Operational Scenarios (5 Test Cases)
// ============================================================================

describe('DF-16 Tier 4: Real-World Operational Scenarios', () => {
  let clock: TestClock

  beforeEach(() => {
    clock = makeTestClock('2026-09-06T22:00:00.000Z')
  })

  it('TC-DF16-T4-S01: Production Multi-Cloud Provider Failover and Self-Healing', () => {
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })

    // Azure primary and Bedrock secondary
    manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', observedRemaining: 800_000 }))
    manager.registerSnapshot(createMockProviderQuota({ id: 's-bedrock', poolId: 'pool-sub-secondary', observedRemaining: 800_000 }))

    // At 200s, Bedrock receives fresh routine snapshot
    clock.advanceSec(200)
    manager.registerSnapshot(createMockProviderQuota({
      id: 's-bedrock-fresh',
      poolId: 'pool-sub-secondary',
      observedAt: clock.now(),
      observedRemaining: 780_000,
    }))

    // Azure outage: no new snapshots arrive for Azure, 105s more elapse (Azure at 305s > 300s TTL; Bedrock at 105s < 300s TTL)
    clock.advanceSec(105)

    // Traffic seamlessly routes to Bedrock secondary
    const failoverResult = manager.selectPoolForRequest({ requestedUnits: 10_000, purpose: 'routine' })
    expect(failoverResult.poolId).toBe('pool-sub-secondary')

    // Azure recovers and emits new snapshot
    manager.registerSnapshot(createMockProviderQuota({
      id: 's-azure-recovered',
      poolId: 'pool-sub-primary',
      observedAt: clock.now(),
      observedRemaining: 800_000,
    }))

    // Traffic automatically shifts back to Azure primary
    const recoveredResult = manager.selectPoolForRequest({ requestedUnits: 10_000, purpose: 'routine' })
    expect(recoveredResult.poolId).toBe('pool-sub-primary')
  })

  it('TC-DF16-T4-S02: Canary Deployment Telemetry Breach Recovery under Exhausted Quota', () => {
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })

    // Heavy routine load has drawn all subscription pools down to 10%
    manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', total: 1_000_000, observedRemaining: 100_000 }))
    manager.registerSnapshot(createMockProviderQuota({ id: 's2', poolId: 'pool-sub-secondary', total: 1_000_000, observedRemaining: 100_000 }))
    manager.registerSnapshot(createMockProviderQuota({ id: 's3', poolId: 'pool-metered-fallback', total: 1_000_000, observedRemaining: 0 }))

    // Routine admission blocked
    expect(() => manager.selectPoolForRequest({ requestedUnits: 5000, purpose: 'routine' })).toThrow(NoEligiblePoolError)

    // Canary telemetry breach creates canary-recovery request
    const canaryEvidence = createMockArtifactRef('art-canary-telemetry-breach')
    const emergencyResult = manager.selectPoolForRequest({
      requestedUnits: 25_000,
      purpose: 'canary-recovery',
      purposeEvidence: [canaryEvidence],
    })

    expect(emergencyResult.emergency).toBe(true)
    expect(emergencyResult.poolId).toBe('pool-sub-primary')
    expect(emergencyResult.remainingAfterRequest).toBe(75_000)
  })

  it('TC-DF16-T4-S03: Critical P0 Security Advisory Ingestion During 95% Spend Watermark Pause', () => {
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })

    manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', total: 1_000_000, observedRemaining: 100_000 }))

    // Security advisory remediation arrives
    const secEvidence = createMockArtifactRef('art-cve-p0-audit-receipt')
    const emergencyResult = manager.selectPoolForRequest({
      requestedUnits: 30_000,
      purpose: 'verified-p0-security',
      purposeEvidence: [secEvidence],
    })

    expect(emergencyResult.emergency).toBe(true)
    expect(emergencyResult.poolId).toBe('pool-sub-primary')
    expect(emergencyResult.remainingAfterRequest).toBe(70_000)
  })

  it('TC-DF16-T4-S04: Heterogeneous Multi-Unit Fleet (Tokens, Requests, Credits Segregation)', () => {
    const heterogeneousConfig: QuotaPoolConfig[] = [
      { id: 'pool-tokens-deepseek', provider: 'subscription', adapterId: 'ad1', secretRef: { kind: 'env', name: 'S1' }, ttlMs: 300_000 },
      { id: 'pool-requests-o1', provider: 'subscription', adapterId: 'ad2', secretRef: { kind: 'env', name: 'S2' }, ttlMs: 300_000 },
      { id: 'pool-credits-claude', provider: 'subscription', adapterId: 'ad3', secretRef: { kind: 'env', name: 'S3' }, ttlMs: 300_000 },
    ]
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: heterogeneousConfig,
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })

    manager.registerSnapshot(createMockProviderQuota({ id: 's-tok', poolId: 'pool-tokens-deepseek', unit: 'tokens', total: 100_000_000, observedRemaining: 80_000_000 }))
    manager.registerSnapshot(createMockProviderQuota({ id: 's-req', poolId: 'pool-requests-o1', unit: 'requests', total: 5_000, observedRemaining: 4_000 }))
    manager.registerSnapshot(createMockProviderQuota({ id: 's-cred', poolId: 'pool-credits-claude', unit: 'credits', total: 50_000, observedRemaining: 30_000 }))

    const tokenRes = manager.selectPoolForRequest({ requestedUnits: 50_000, unit: 'tokens', purpose: 'routine' })
    expect(tokenRes.poolId).toBe('pool-tokens-deepseek')

    const requestRes = manager.selectPoolForRequest({ requestedUnits: 10, unit: 'requests', purpose: 'routine' })
    expect(requestRes.poolId).toBe('pool-requests-o1')

    const creditRes = manager.selectPoolForRequest({ requestedUnits: 500, unit: 'credits', purpose: 'routine' })
    expect(creditRes.poolId).toBe('pool-credits-claude')
  })

  it('TC-DF16-T4-S05: Disaster Recovery and Invariant Repair (production-invariant-recovery)', () => {
    const manager = new DarkFactoryQuotaManager({
      quotasConfig: createMockQuotasConfig(),
      clock: () => clock.now(),
      projectId: 'proj-fleet-1',
    })

    manager.registerSnapshot(createMockProviderQuota({ poolId: 'pool-sub-primary', total: 1_000_000, observedRemaining: 100_000 }))

    const invariantEvidence = createMockArtifactRef('art-invariant-journal-snapshot')
    const emergencyResult = manager.selectPoolForRequest({
      requestedUnits: 50_000,
      purpose: 'production-invariant-recovery',
      purposeEvidence: [invariantEvidence],
    })

    expect(emergencyResult.emergency).toBe(true)
    expect(emergencyResult.poolId).toBe('pool-sub-primary')
    expect(emergencyResult.remainingAfterRequest).toBe(50_000)
  })

  // ============================================================================
  // Tier 5: Iteration 2 Adversarial Hardening & Remediation Tests
  // ============================================================================

  describe('DF-16 Tier 5: Iteration 2 Adversarial Hardening & Remediation Tests', () => {
    let clock: TestClock

    beforeEach(() => {
      clock = makeTestClock('2026-09-06T22:00:00.000Z')
    })

    // --- Remediation 1: Settlement Watermark Math (Mid-Attempt Snapshot Arrival) ---
    it('TC-DF16-T5-R01: Settlement with mid-attempt snapshot arrival asserts zero phantom capacity bounce', () => {
      const manager = new DarkFactoryQuotaManager({
        quotasConfig: createMockQuotasConfig(),
        clock: () => clock.now(),
        projectId: 'proj-fleet-1',
      })

      // T0: Snapshot S0 observed at 22:00:00 with 800,000 remaining
      manager.registerSnapshot(createMockProviderQuota({
        id: 's-0',
        poolId: 'pool-sub-primary',
        total: 1_000_000,
        observedRemaining: 800_000,
        observedAt: '2026-09-06T22:00:00.000Z',
      }))

      // T1 = T0 + 5s: Create and record reservation for 100,000 tokens
      clock.advanceSec(5)
      const res1 = createMockReservation({
        id: 'res-mid-attempt',
        quotaPoolIds: ['pool-sub-primary'],
        maxTokens: 100_000,
        createdAt: clock.now(), // 22:00:05
      })
      manager.recordReservation('pool-sub-primary', res1)

      let evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.activeReservations).toBe(100_000)
      expect(evalRes.unreflectedUsage).toBe(0)
      expect(evalRes.effectiveAvailable).toBe(700_000)

      // T2 = T0 + 10s: Provider snapshot S1 arrives (observedAt: 22:00:10).
      // Since attempt is still running, provider has not reflected this attempt yet.
      clock.advanceSec(5)
      manager.registerSnapshot(createMockProviderQuota({
        id: 's-1',
        poolId: 'pool-sub-primary',
        total: 1_000_000,
        observedRemaining: 800_000,
        observedAt: clock.now(), // 22:00:10
      }))

      evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.activeReservations).toBe(100_000)
      expect(evalRes.unreflectedUsage).toBe(0)
      expect(evalRes.effectiveAvailable).toBe(700_000)

      // T3 = T0 + 15s: Attempt finishes and settles with actualTokens = 30,000
      clock.advanceSec(5) // 22:00:15
      manager.settleReservation('pool-sub-primary', 'res-mid-attempt', 30_000)

      // ZERO PHANTOM CAPACITY BOUNCE:
      // Active reservation is gone (0 tokens).
      // Settled tokens (30,000) MUST be retained in unreflectedUsage because S1 was observed at 22:00:10 (< settlement at 22:00:15).
      // Effective available must be 800,000 - 30,000 = 770,000 (NOT 800,000!).
      evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.activeReservations).toBe(0)
      expect(evalRes.unreflectedUsage).toBe(30_000)
      expect(evalRes.effectiveAvailable).toBe(770_000)

      // T4 = T0 + 20s: Subsequent provider snapshot S2 arrives reflecting the settled usage (observedRemaining: 770,000)
      clock.advanceSec(5)
      manager.registerSnapshot(createMockProviderQuota({
        id: 's-2',
        poolId: 'pool-sub-primary',
        total: 1_000_000,
        observedRemaining: 770_000,
        observedAt: clock.now(), // 22:00:20
      }))

      evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.unreflectedUsage).toBe(0) // pruned because entry.timestamp (22:00:15) <= S2 (22:00:20)
      expect(evalRes.effectiveAvailable).toBe(770_000)
    })

    // --- Remediation 2: Clock Skew at Ingestion (> 60s in future throws QuotaStaleError) ---
    it('TC-DF16-T5-R02: Snapshot with forward clock skew > 60s throws QuotaStaleError and does not update pool', () => {
      const manager = new DarkFactoryQuotaManager({
        quotasConfig: createMockQuotasConfig(),
        clock: () => clock.now(),
        projectId: 'proj-fleet-1',
      })

      // Valid initial snapshot at 22:00:00
      const initialSnap = createMockProviderQuota({
        id: 's-valid',
        poolId: 'pool-sub-primary',
        total: 1_000_000,
        observedRemaining: 800_000,
        observedAt: '2026-09-06T22:00:00.000Z',
      })
      manager.registerSnapshot(initialSnap)

      // Snapshot with +60.001s forward clock skew (22:01:00.001Z) MUST throw QuotaStaleError
      const skewedSnap = createMockProviderQuota({
        id: 's-skewed',
        poolId: 'pool-sub-primary',
        total: 1_000_000,
        observedRemaining: 900_000,
        observedAt: '2026-09-06T22:01:00.001Z',
      })

      expect(() => manager.registerSnapshot(skewedSnap)).toThrow(QuotaStaleError)

      // Confirm pool snapshot was NOT corrupted/updated
      const currentSnap = manager.getSnapshot('pool-sub-primary')
      expect(currentSnap?.id).toBe('s-valid')
      expect(manager.evaluateAvailableQuota('pool-sub-primary').effectiveAvailable).toBe(800_000)

      // Snapshot with exactly +60.000s forward clock skew is permitted (boundary check)
      const boundarySnap = createMockProviderQuota({
        id: 's-boundary',
        poolId: 'pool-sub-primary',
        total: 1_000_000,
        observedRemaining: 800_000,
        observedAt: '2026-09-06T22:01:00.000Z',
      })
      expect(() => manager.registerSnapshot(boundarySnap)).not.toThrow()
      expect(manager.getSnapshot('pool-sub-primary')?.id).toBe('s-boundary')
    })

    // --- Remediation 3 & 6: Single-Pool Waterfall Exhaustion Pause & Quota Resume Idempotency ---
    it('TC-DF16-T5-R03: Single-pool waterfall exhaustion triggers quota pause on FleetStore with resume idempotency', async () => {
      const redis = new InMemoryRedisAdapter()
      const fleetStore = new DarkFactoryFleetStore({
        adapter: redis,
        config: {
          fleetId: 'fleet-single-test',
          authorityEpoch: 'epoch-single-1',
          windowType: 'sliding',
          dailyCapSpendMicros: 10_000_000,
          monthlyCapSpendMicros: 100_000_000,
          pauseReasons: [],
          quotas: [],
        },
        clock: () => clock.now(),
      })

      // Manager with exactly one pool configured
      const singleConfig: QuotaPoolConfig[] = [
        { id: 'pool-single', provider: 'subscription', adapterId: 'ad-single', secretRef: { kind: 'env', name: 'SEC' }, ttlMs: 300_000 },
      ]
      const manager = new DarkFactoryQuotaManager({
        quotasConfig: singleConfig,
        clock: () => clock.now(),
        fleetStore,
        projectId: 'proj-fleet-1',
      })

      manager.registerSnapshot(createMockProviderQuota({
        poolId: 'pool-single',
        total: 10_000,
        observedRemaining: 10_000,
        observedAt: clock.now(),
      }))

      // Add independent manual pause on FleetStore
      await fleetStore.pause('manual')
      let pauses = await fleetStore.getActivePauses()
      expect(pauses).toEqual(['manual'])

      // Request 9,001 units (breaches 10% emergency reserve floor of 1,000 units on single pool)
      expect(() =>
        manager.selectPoolForRequest({ requestedUnits: 9001, purpose: 'routine' }),
      ).toThrow(EmergencyReserveBreachError)

      await manager.waitForHooks()

      // FleetStore MUST have active 'quota' pause in addition to 'manual'
      pauses = await fleetStore.getActivePauses()
      expect(pauses).toContain('manual')
      expect(pauses).toContain('quota')

      // Recovery: Register fresh snapshot with sufficient capacity (20,000 total, 20,000 remaining)
      clock.advanceSec(10)
      manager.registerSnapshot(createMockProviderQuota({
        id: 'snap-recovered',
        poolId: 'pool-single',
        total: 20_000,
        observedRemaining: 20_000,
        observedAt: clock.now(),
      }))

      await manager.waitForHooks()

      // Quota pause must be cleared, while manual pause remains intact
      pauses = await fleetStore.getActivePauses()
      expect(pauses).toContain('manual')
      expect(pauses).not.toContain('quota')

      // Idempotency: Registering another routine snapshot while quota is not paused should be a clean no-op
      clock.advanceSec(10)
      manager.registerSnapshot(createMockProviderQuota({
        id: 'snap-second',
        poolId: 'pool-single',
        total: 20_000,
        observedRemaining: 19_000,
        observedAt: clock.now(),
      }))
      await manager.waitForHooks()

      pauses = await fleetStore.getActivePauses()
      expect(pauses).toContain('manual')
      expect(pauses).not.toContain('quota')
    })

    // --- Remediation 4: Late Stream Usage After Settlement (Zero Double Counting) ---
    it('TC-DF16-T5-R04: Late stream event arrival after settlement replaces synthetic entry asserting zero double-counting', () => {
      const manager = new DarkFactoryQuotaManager({
        quotasConfig: createMockQuotasConfig(),
        clock: () => clock.now(),
        projectId: 'proj-fleet-1',
      })

      manager.registerSnapshot(createMockProviderQuota({
        id: 'snap-base',
        poolId: 'pool-sub-primary',
        total: 1_000_000,
        observedRemaining: 500_000,
        observedAt: clock.now(),
      }))

      // 1. Record reservation for 100,000 tokens
      const res = createMockReservation({
        id: 'res-late-stream',
        quotaPoolIds: ['pool-sub-primary'],
        maxTokens: 100_000,
        createdAt: clock.now(),
      })
      manager.recordReservation('pool-sub-primary', res)

      let evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.activeReservations).toBe(100_000)
      expect(evalRes.unreflectedUsage).toBe(0)
      expect(evalRes.effectiveAvailable).toBe(400_000)

      // 2. Settle reservation before stream events arrive with actualTokens = 50,000
      clock.advanceSec(5)
      manager.settleReservation('pool-sub-primary', 'res-late-stream', 50_000)

      evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.activeReservations).toBe(0)
      expect(evalRes.unreflectedUsage).toBe(50_000) // synthetic settled:res-late-stream
      expect(evalRes.effectiveAvailable).toBe(450_000)

      // 3. Late arriving stream event for 'res-late-stream' with 50,000 tokens
      const lateEvent = createMockUsageEvent({
        id: 'evt-late-stream-1',
        reservationId: 'res-late-stream',
        usageAt: clock.now(),
        inputTokens: 50_000,
        outputTokens: 0,
        cacheTokens: 0,
        reasoningTokens: 0,
      })
      manager.recordUsage('pool-sub-primary', lateEvent)

      // ZERO DOUBLE COUNTING:
      // The synthetic entry 'settled:res-late-stream' must have been removed and replaced by evt-late-stream-1.
      // Total unreflected usage must remain exactly 50,000 (NOT 100,000).
      evalRes = manager.evaluateAvailableQuota('pool-sub-primary')
      expect(evalRes.unreflectedUsage).toBe(50_000)
      expect(evalRes.effectiveAvailable).toBe(450_000)
    })

    // --- Remediation 5: Input Validation (NaN and Non-Finite Rejection) ---
    it('TC-DF16-T5-R05: requestedUnits = NaN and non-finite numbers throw ERR_INVALID_REQUEST', () => {
      const manager = new DarkFactoryQuotaManager({
        quotasConfig: createMockQuotasConfig(),
        clock: () => clock.now(),
        projectId: 'proj-fleet-1',
      })

      manager.registerSnapshot(createMockProviderQuota({
        poolId: 'pool-sub-primary',
        total: 1_000_000,
        observedRemaining: 800_000,
        observedAt: clock.now(),
      }))

      // NaN routine request throws ERR_INVALID_REQUEST
      expect(() =>
        manager.selectPoolForRequest({ requestedUnits: NaN, purpose: 'routine' }),
      ).toThrow(QuotaManagerError)

      try {
        manager.selectPoolForRequest({ requestedUnits: NaN, purpose: 'routine' })
      } catch (err: any) {
        expect(err.code).toBe('ERR_INVALID_REQUEST')
        expect(err.message).toContain('greater than zero')
      }

      // NaN emergency request throws ERR_INVALID_REQUEST
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: NaN,
          purpose: 'canary-recovery',
          purposeEvidence: [createMockArtifactRef()],
        }),
      ).toThrow(QuotaManagerError)

      // -Infinity throws ERR_INVALID_REQUEST
      try {
        manager.selectPoolForRequest({ requestedUnits: -Infinity, purpose: 'routine' })
      } catch (err: any) {
        expect(err.code).toBe('ERR_INVALID_REQUEST')
      }

      // +Infinity throws ERR_INVALID_REQUEST / QuotaManagerError
      try {
        manager.selectPoolForRequest({ requestedUnits: Infinity, purpose: 'routine' })
      } catch (err: any) {
        expect(err instanceof QuotaManagerError).toBe(true)
        expect(err.code).toBe('ERR_INVALID_REQUEST')
      }

      // 0 and negative numbers throw ERR_INVALID_REQUEST
      expect(() =>
        manager.selectPoolForRequest({ requestedUnits: 0, purpose: 'routine' }),
      ).toThrow(QuotaManagerError)

      expect(() =>
        manager.selectPoolForRequest({ requestedUnits: -500, purpose: 'routine' }),
      ).toThrow(QuotaManagerError)
    })

    // --- Remediation 7: Metered Pool Opt-In Default ---
    it('TC-DF16-T5-R06: Metered deployment defaults to enabled: false unless explicitly configured with enabled: true', () => {
      const configWithDefaultMetered: QuotaPoolConfig[] = [
        {
          id: 'pool-sub-1',
          provider: 'subscription',
          adapterId: 'ad1',
          secretRef: { kind: 'env', name: 'S1' },
          ttlMs: 300_000,
        },
        {
          id: 'pool-metered-unspecified',
          provider: 'metered',
          adapterId: 'ad2',
          secretRef: { kind: 'env', name: 'S2' },
          ttlMs: 300_000,
          // enabled omitted: must default to false!
        },
        {
          id: 'pool-metered-explicit',
          provider: 'metered',
          adapterId: 'ad3',
          secretRef: { kind: 'env', name: 'S3' },
          ttlMs: 300_000,
          enabled: true,
        },
      ]

      const manager = new DarkFactoryQuotaManager({
        quotasConfig: configWithDefaultMetered,
        clock: () => clock.now(),
        projectId: 'proj-fleet-1',
      })

      // Exhaust primary subscription (leave at 10% reserve)
      manager.registerSnapshot(createMockProviderQuota({
        id: 's-sub-1',
        poolId: 'pool-sub-1',
        total: 100_000,
        observedRemaining: 10_000,
        observedAt: clock.now(),
      }))

      // Register snapshots for both metered pools
      manager.registerSnapshot(createMockProviderQuota({
        id: 's-met-unspec',
        poolId: 'pool-metered-unspecified',
        total: 500_000,
        observedRemaining: 500_000,
        observedAt: clock.now(),
      }))
      manager.registerSnapshot(createMockProviderQuota({
        id: 's-met-exp',
        poolId: 'pool-metered-explicit',
        total: 500_000,
        observedRemaining: 500_000,
        observedAt: clock.now(),
      }))

      // Request falls over: should skip 'pool-metered-unspecified' (disabled by default) and route to 'pool-metered-explicit'
      const routeResult = manager.selectPoolForRequest({ requestedUnits: 50_000, purpose: 'routine' })
      expect(routeResult.poolId).toBe('pool-metered-explicit')
      expect(routeResult.mode).toBe('metered')

      // If explicit metered is disabled, and candidate filter targets unspecified metered, it fails closed
      expect(() =>
        manager.selectPoolForRequest({
          requestedUnits: 50_000,
          purpose: 'routine',
          candidatePoolIds: ['pool-metered-unspecified'],
        }),
      ).toThrow(NoEligiblePoolError)

      // Dynamically enabling unspecified metered pool allows it to be selected
      manager.setPoolEnabled('pool-metered-unspecified', true)
      const afterEnableRoute = manager.selectPoolForRequest({
        requestedUnits: 50_000,
        purpose: 'routine',
        candidatePoolIds: ['pool-metered-unspecified'],
      })
      expect(afterEnableRoute.poolId).toBe('pool-metered-unspecified')
    })
  })
})
