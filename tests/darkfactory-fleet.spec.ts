import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  InMemoryRedisAdapter,
  fleetKey,
  RESERVE_SPEND_LUA_SCRIPT,
  START_RESERVATION_LUA_SCRIPT,
  RECORD_USAGE_LUA_SCRIPT,
  SETTLE_RESERVATION_LUA_SCRIPT,
  WITHHOLD_RESERVATION_LUA_SCRIPT,
  MANAGE_PAUSES_LUA_SCRIPT,
  GET_SPEND_METRICS_LUA_SCRIPT,
  parseResp,
} from '../packages/agent-team/src/darkfactory/redis-adapter.ts'
import {
  DarkFactoryFleetStore,
  EpochMismatchError,
  WatermarkBreachError,
  CapExceededError,
  PauseActiveError,
  ConflictingDigestError,
  SequenceGapError,
  InvalidReservationTransitionError,
  IllegalReservationTransitionError,
  type SpendMetrics,
} from '../packages/agent-team/src/darkfactory/fleet-store.ts'
import { digestJson } from '../packages/agent-team/src/darkfactory/json.ts'
import { assertContractSemantics } from '../packages/agent-team/src/darkfactory/contracts/semantics.ts'
import type {
  PricingSnapshotV1,
  UsageEventPayload,
  UsageEventV1,
} from '../packages/agent-team/src/darkfactory/contracts/economics.ts'
import type { EnabledDarkFactoryConfig } from '../packages/agent-team/src/darkfactory/config.ts'

// --- Helpers & Fixtures ---

function makeTestClock(initialTime = '2026-09-06T21:45:00.000Z') {
  let currentTime = initialTime
  return {
    now: () => currentTime,
    set: (isoTime: string) => {
      currentTime = isoTime
    },
    advanceMs: (ms: number) => {
      const dt = new Date(currentTime)
      dt.setTime(dt.getTime() + ms)
      currentTime = dt.toISOString()
    },
  }
}

function createMockPricingSnapshot(overrides?: Partial<PricingSnapshotV1>): PricingSnapshotV1 {
  return {
    schemaVersion: 1,
    id: 'pricing-snap-1',
    projectId: 'proj-fleet-1',
    policyRevision: 1,
    provider: 'prov-deepseek',
    accountId: 'acc-corp-1',
    modelVersion: 'deepseek-v3',
    currency: 'USD',
    revision: 1,
    observedAt: '2026-09-06T20:00:00.000Z',
    expiresAt: '2026-09-07T20:00:00.000Z',
    inputMicrosPerMillion: 2_000_000,
    cachedInputMicrosPerMillion: 500_000,
    outputMicrosPerMillion: 8_000_000,
    reasoningMicrosPerMillion: 4_000_000,
    subscriptionFeeMicros: 0,
    source: {
      artifactId: 'art-pricing-1',
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
    },
    ...overrides,
  }
}

function createMockFleetConfig(overrides?: Partial<EnabledDarkFactoryConfig['fleet']>): EnabledDarkFactoryConfig['fleet'] {
  return {
    redis: {
      endpoint: 'rediss://redis.internal.fleet:6379',
      tls: true,
      secretRef: { secretId: 'sec-redis-auth' },
    },
    fleetId: 'fleet-primary',
    hostId: 'host-worker-1',
    fleetCaps: {
      dailyMoneyMicros: 100_000_000,
      monthlyMoneyMicros: 2_000_000_000,
      dailyTokens: 100_000_000,
      monthlyTokens: 2_000_000_000,
    },
    projectCaps: [
      {
        id: 'proj-fleet-1',
        dailyMoneyMicros: 50_000_000, // $50.00 (95% = $47.50)
        monthlyMoneyMicros: 1_000_000_000,
        dailyTokens: 50_000_000,
        monthlyTokens: 1_000_000_000,
      },
    ],
    hostCaps: [
      {
        id: 'host-worker-1',
        dailyMoneyMicros: 20_000_000, // $20.00 (95% = $19.00)
        monthlyMoneyMicros: 400_000_000,
        dailyTokens: 20_000_000,
        monthlyTokens: 400_000_000,
      },
    ],
    requestCeiling: {
      moneyMicros: 5_000_000,
      inputTokens: 128_000,
      outputTokens: 16_000,
      reasoningTokens: 16_000,
      deadlineMs: 60_000,
    },
    attemptCeiling: {
      moneyMicros: 10_000_000,
      tokens: 200_000,
      requests: 5,
      deadlineMs: 180_000,
    },
    pricingSnapshots: [
      {
        id: 'pricing-snap-1',
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
        currency: 'USD',
      },
    ],
    routineWatermark: 0.95,
    reserveFraction: 0.1,
    quotas: [
      {
        id: 'quota-pool-1',
        provider: 'subscription',
        adapterId: 'adapter-azure-openai',
        secretRef: { secretId: 'sec-quota-1' },
        ttlMs: 300_000,
      },
    ],
    emergencyPurposes: [
      'canary-recovery',
      'verified-p0-security',
      'production-invariant-recovery',
    ],
    ...overrides,
  }
}

function createMockUsageEvent(payloadOverrides: Partial<UsageEventPayload> = {}): UsageEventV1 {
  const payload: UsageEventPayload = {
    schemaVersion: 1,
    id: 'usage-event-1',
    projectId: 'proj-fleet-1',
    policyRevision: 1,
    fleetId: 'fleet-primary',
    hostId: 'host-worker-1',
    attemptId: 'att-attempt-1',
    generation: 1,
    provider: 'prov-deepseek',
    accountId: 'acc-corp-1',
    modelVersion: 'deepseek-v3',
    requestId: 'req-request-1',
    streamSequence: 1,
    pricingRevision: 1,
    usageAt: '2026-09-06T21:46:00.000Z',
    inputTokens: 1000,
    cacheTokens: 200,
    outputTokens: 500,
    reasoningTokens: 100,
    countingSemantics: 'cache-in-input-reasoning-in-output',
    billedCostMicros: 5600,
    currency: 'USD',
    reservationId: 'res-reservation-1',
    ...payloadOverrides,
  }
  const event: UsageEventV1 = {
    ...payload,
    eventDigest: digestJson(payload),
  }
  // Validate semantics
  assertContractSemantics('UsageEventV1', event)
  return event
}

describe('DF-15 Redis Authority, Reservations, and Accounting Ledger', () => {
  let adapter: InMemoryRedisAdapter
  let store: DarkFactoryFleetStore
  let clock: ReturnType<typeof makeTestClock>
  let testDir: string
  let auditLogPath: string
  const cleanups: string[] = []

  beforeEach(async () => {
    clock = makeTestClock()
    adapter = new InMemoryRedisAdapter({ clock: clock.now })
    testDir = await mkdtemp(join(tmpdir(), 'fleet-test-'))
    cleanups.push(testDir)
    auditLogPath = join(testDir, 'fleet-audit.jsonl')

    store = new DarkFactoryFleetStore({
      adapter,
      config: createMockFleetConfig(),
      auditLogPath,
      clock: clock.now,
      authorityEpoch: 'epoch-1',
    })
    await store.initialize()
  })

  afterEach(async () => {
    await store.close()
    for (const dir of cleanups.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  describe('DF-15.1 Redis Adapter & Cluster Hash Tagging', () => {
    it('initializes InMemoryRedisAdapter, performs PING, basic GET/SET/DEL', async () => {
      expect(await adapter.ping()).toBe('PONG')
      const key = fleetKey('fleet-primary', 'test-key')
      await adapter.set(key, 'hello-darkfactory')
      expect(await adapter.get(key)).toBe('hello-darkfactory')
      const deleted = await adapter.del(key)
      expect(deleted).toBe(1)
      expect(await adapter.get(key)).toBeNull()
    })

    it('loads Lua scripts via scriptLoad and executes via evalsha with SHA-1 digest', async () => {
      const script = 'return redis.call("PING")'
      const sha = await adapter.scriptLoad(script)
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      const result = await adapter.evalsha(sha, [], [])
      expect(result).toBe('PONG')
    })

    it('formats and validates cluster hash tag {df:fleet:<fleetId>} across all keys', async () => {
      const key = fleetKey('fleet-primary', 'reservations:outstanding')
      expect(key).toBe('{df:fleet:fleet-primary}:reservations:outstanding')
    })

    it('rejects multi-key operations with mismatched cluster hash tags in cluster check mode', async () => {
      const keyA = '{df:fleet:fleet-a}:key1'
      const keyB = '{df:fleet:fleet-b}:key2'
      await expect(adapter.eval('return 1', [keyA, keyB], [])).rejects.toThrow(/CROSSSLOT/)
    })

    it('verifies all 7 canonical server-side Lua scripts are non-empty and well-formed', () => {
      const allScripts = [
        { name: 'RESERVE_SPEND_LUA_SCRIPT', script: RESERVE_SPEND_LUA_SCRIPT, tag: '[df:reserve_spend]' },
        { name: 'START_RESERVATION_LUA_SCRIPT', script: START_RESERVATION_LUA_SCRIPT, tag: '[df:start_reservation]' },
        { name: 'RECORD_USAGE_LUA_SCRIPT', script: RECORD_USAGE_LUA_SCRIPT, tag: '[df:record_usage]' },
        { name: 'SETTLE_RESERVATION_LUA_SCRIPT', script: SETTLE_RESERVATION_LUA_SCRIPT, tag: '[df:settle_reservation]' },
        { name: 'WITHHOLD_RESERVATION_LUA_SCRIPT', script: WITHHOLD_RESERVATION_LUA_SCRIPT, tag: '[df:withhold_reservation]' },
        { name: 'MANAGE_PAUSES_LUA_SCRIPT', script: MANAGE_PAUSES_LUA_SCRIPT, tag: '[df:manage_pauses]' },
        { name: 'GET_SPEND_METRICS_LUA_SCRIPT', script: GET_SPEND_METRICS_LUA_SCRIPT, tag: '[df:get_spend_metrics]' },
      ]

      for (const { name, script, tag } of allScripts) {
        expect(script.trim().length).toBeGreaterThan(100)
        expect(script).toContain(tag)
        expect(script).toContain('redis.call(')

        const sha = createHash('sha1').update(script.trim()).digest('hex').toLowerCase()
        expect(sha).toMatch(/^[0-9a-f]{40}$/)
      }
    })

    it('loads all 7 Lua scripts into InMemoryRedisAdapter via scriptLoad', async () => {
      const testAdapter = new InMemoryRedisAdapter()
      const allScripts = [
        RESERVE_SPEND_LUA_SCRIPT,
        START_RESERVATION_LUA_SCRIPT,
        RECORD_USAGE_LUA_SCRIPT,
        SETTLE_RESERVATION_LUA_SCRIPT,
        WITHHOLD_RESERVATION_LUA_SCRIPT,
        MANAGE_PAUSES_LUA_SCRIPT,
        GET_SPEND_METRICS_LUA_SCRIPT,
      ]
      for (const script of allScripts) {
        const sha = await testAdapter.scriptLoad(script)
        expect(sha).toMatch(/^[0-9a-f]{40}$/)
      }
    })

    it('correctly calculates total frame bytesConsumed in parseResp when an array element returns an error', () => {
      // RESP Array: *2\r\n-ERR custom failure\r\n+OK\r\n
      // The error element is -ERR custom failure\r\n (21 bytes)
      // The array header is *2\r\n (4 bytes)
      // The second element is +OK\r\n (5 bytes)
      // Total frame length: 4 + 21 + 5 = 30 bytes
      const raw = Buffer.from('*2\r\n-ERR custom failure\r\n+OK\r\n', 'utf8')
      const result = parseResp(raw)
      expect(result).not.toBeNull()
      expect(result?.isError).toBe(true)
      expect(result?.value).toBe('ERR custom failure')
      expect(result?.bytesConsumed).toBe(30)
    })
  })

  describe('DF-15.2 Monotonic Fencing Tokens & Epoch Fencing', () => {
    it('assigns strictly increasing monotonic fencing tokens to sequential reservations', async () => {
      const r1 = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      const r2 = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-2',
        generation: 1,
        requestId: 'req-2',
        maxCostMicros: 1_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(r1.fencingToken).toBe(1)
      expect(r2.fencingToken).toBe(2)
    })

    it('rejects reservation request presenting mismatched authorityEpoch', async () => {
      const staleStore = new DarkFactoryFleetStore({
        adapter,
        config: createMockFleetConfig(),
        clock: clock.now,
        authorityEpoch: 'epoch-stale-0',
      })
      await expect(
        staleStore.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-1',
          generation: 1,
          requestId: 'req-1',
          maxCostMicros: 1_000_000,
          maxTokens: 50_000,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(EpochMismatchError)
    })

    it('invalidates in-flight reservations when Redis primary rolls over authorityEpoch', async () => {
      const reservation = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      // Simulate administrative epoch failover in Redis
      await adapter.set(fleetKey('fleet-primary', 'epoch'), 'epoch-2')

      await expect(
        store.startReservation({
          reservationId: reservation.id,
          fencingToken: reservation.fencingToken,
        }),
      ).rejects.toThrow(EpochMismatchError)
    })

    it('rejects worker operations attempting to use stale fencing tokens', async () => {
      const reservation = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await expect(
        store.startReservation({
          reservationId: reservation.id,
          fencingToken: reservation.fencingToken - 1,
        }),
      ).rejects.toThrow(/fencing token/)
    })
  })

  describe('DF-15.3 Reservation Lifecycle State Machine', () => {
    it('progresses normal request through reserved -> started -> settled', async () => {
      const reservation = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 2_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(reservation.state).toBe('reserved')

      await store.startReservation({
        reservationId: reservation.id,
        fencingToken: reservation.fencingToken,
      })
      const started = await store.getReservation(reservation.id)
      expect(started?.state).toBe('started')

      const settled = await store.settleReservation({
        reservationId: reservation.id,
        actualCostMicros: 500_000,
        actualTokens: 10_000,
      })
      expect(settled.settledCostMicros).toBe(500_000)
      const finalState = await store.getReservation(reservation.id)
      expect(finalState?.state).toBe('settled')
    })

    it('cancels unstarted request directly from reserved -> settled with zero usage', async () => {
      const reservation = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 2_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      const settled = await store.settleReservation({
        reservationId: reservation.id,
        actualCostMicros: 0,
        actualTokens: 0,
      })
      expect(settled.settledCostMicros).toBe(0)
      const finalState = await store.getReservation(reservation.id)
      expect(finalState?.state).toBe('settled')
    })

    it('transitions started -> reconciling upon receiving out-of-order stream gap', async () => {
      const reservation = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 2_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({
        reservationId: reservation.id,
        fencingToken: reservation.fencingToken,
      })

      // Send sequence 2 directly (missing sequence 1)
      const event = createMockUsageEvent({
        reservationId: reservation.id,
        streamSequence: 2,
      })
      const result = await store.recordUsageEvent(event)
      expect(result.status).toBe('buffered_gap')

      const updated = await store.getReservation(reservation.id)
      expect(updated?.state).toBe('reconciling')
    })

    it('transitions directly to withheld upon conflicting digest', async () => {
      const reservation = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 2_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({
        reservationId: reservation.id,
        fencingToken: reservation.fencingToken,
      })

      const ev1 = createMockUsageEvent({
        reservationId: reservation.id,
        streamSequence: 1,
        inputTokens: 500,
      })
      await store.recordUsageEvent(ev1)

      // Send conflicting event for sequence 1
      const evConflicting = createMockUsageEvent({
        reservationId: reservation.id,
        streamSequence: 1,
        inputTokens: 600,
      })
      await expect(store.recordUsageEvent(evConflicting)).rejects.toThrow(ConflictingDigestError)

      const finalState = await store.getReservation(reservation.id)
      expect(finalState?.state).toBe('withheld')
    })

    it('rejects illegal state transitions from terminal states (settled / withheld)', async () => {
      const reservation = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.settleReservation({
        reservationId: reservation.id,
        actualCostMicros: 0,
        actualTokens: 0,
      })

      await expect(
        store.startReservation({
          reservationId: reservation.id,
          fencingToken: reservation.fencingToken,
        }),
      ).rejects.toThrow(InvalidReservationTransitionError)
    })

    it('preserves accumulated stream usage when settling without explicit actualCostMicros or actualTokens', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-stream-settle-default',
        generation: 1,
        requestId: 'req-stream-settle-default',
        maxCostMicros: 2_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })

      // Record chunk 1 (200,000 micros, 1000 input, 200 output)
      const ev1 = createMockUsageEvent({
        reservationId: res.id,
        streamSequence: 1,
        inputTokens: 1000,
        cacheTokens: 0,
        outputTokens: 200,
        reasoningTokens: 0,
        countingSemantics: 'exclusive-categories',
        billedCostMicros: 200_000,
      })
      await store.recordUsageEvent(ev1)

      // Record chunk 2 (300,000 micros, 1500 input, 300 output)
      const ev2 = createMockUsageEvent({
        reservationId: res.id,
        streamSequence: 2,
        inputTokens: 1500,
        cacheTokens: 0,
        outputTokens: 300,
        reasoningTokens: 0,
        countingSemantics: 'exclusive-categories',
        billedCostMicros: 300_000,
      })
      await store.recordUsageEvent(ev2)

      // Settle WITHOUT passing actualCostMicros or actualTokens
      const settlement = await store.settleReservation({ reservationId: res.id })

      // MUST retain accumulated stream totals: 500,000 micros and 3,000 tokens
      expect(settlement.settledCostMicros).toBe(500_000)
      expect(settlement.settledTokens).toBe(3_000)
      expect(settlement.refundedCostMicros).toBe(1_500_000) // 2M - 500k
      expect(settlement.refundedTokens).toBe(47_000) // 50k - 3k
      expect(settlement.state).toBe('settled')
    })

    it('strictly forbids transition from settled to withheld and throws IllegalReservationTransitionError', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-settle-to-withheld',
        generation: 1,
        requestId: 'req-settle-to-withheld',
        maxCostMicros: 500_000,
        maxTokens: 10_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })
      await store.settleReservation({
        reservationId: res.id,
        actualCostMicros: 50_000,
        actualTokens: 1_000,
      })

      // State is now settled
      const settledRes = await store.getReservation(res.id)
      expect(settledRes?.state).toBe('settled')

      // Attempt to withhold the settled reservation
      await expect(
        store.withholdReservation(res.id, 'MALICIOUS_REVERT_ATTEMPT'),
      ).rejects.toThrow(IllegalReservationTransitionError)

      // Verify reservation remains settled in store
      const postAttemptRes = await store.getReservation(res.id)
      expect(postAttemptRes?.state).toBe('settled')
      expect(postAttemptRes?.quarantineReason).toBeUndefined()
    })
  })

  describe('DF-15.4 95% Spend Watermark & Durable Budget Pause', () => {
    it('permits routine reservation when total spend is strictly below 95% cap', async () => {
      // Project daily cap: $50.00. 95% watermark: $47.50 (47,500,000 micros)
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-unbounded',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 47_000_000, // $47.00
        maxTokens: 100_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res.state).toBe('reserved')
      expect(await store.getActivePauses()).toEqual([])
    })

    it('permits routine reservation landing exactly on the 95.000% watermark boundary', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-unbounded',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 47_500_000, // Exactly 95% of $50.00
        maxTokens: 100_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res.state).toBe('reserved')
      expect(await store.getActivePauses()).toEqual([])
    })

    it('rejects routine reservation breaching 95% watermark by 1 micro and activates budget pause', async () => {
      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-unbounded',
          accountId: 'acc-corp-1',
          attemptId: 'att-1',
          generation: 1,
          requestId: 'req-1',
          maxCostMicros: 47_500_001, // 95% + 1 micro
          maxTokens: 100_000,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)

      // Budget pause must be activated in Redis
      const pauses = await store.getActivePauses()
      expect(pauses).toContain('budget')
    })

    it('rejects subsequent routine requests immediately when budget pause is active', async () => {
      await store.pause('budget')
      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-1',
          generation: 1,
          requestId: 'req-1',
          maxCostMicros: 100,
          maxTokens: 10,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(PauseActiveError)
    })

    it('enforces watermark across all hierarchical caps: Fleet, Project, and Host', async () => {
      // Host daily cap is $20.00. 95% is $19.00
      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-1',
          generation: 1,
          requestId: 'req-1',
          maxCostMicros: 19_500_000, // $19.50 breaches Host cap
          maxTokens: 10_000,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })

    it('rejects routine reservation breaching 95% token watermark and activates budget pause', async () => {
      // Project daily tokens cap: 50,000,000. 95% limit: 47,500,000
      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-tk-breach-1',
          generation: 1,
          requestId: 'req-tk-breach-1',
          maxCostMicros: 1_000,
          maxTokens: 47_500_001, // 1 token over 95%
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)

      const activePauses = await store.getActivePauses()
      expect(activePauses).toContain('budget')
    })

    it('enforces watermark and caps when config provides schema-compliant scopedCap ({ id, caps })', async () => {
      const nestedConfig = createMockFleetConfig({
        projectCaps: [
          {
            id: 'proj-nested-1',
            caps: {
              dailyMoneyMicros: 10_000_000, // 95% = 9,500,000
              monthlyMoneyMicros: 100_000_000,
              dailyTokens: 10_000_000, // 95% = 9,500,000
              monthlyTokens: 100_000_000,
            },
          } as any,
        ],
        hostCaps: [
          {
            id: 'host-nested-1',
            caps: {
              dailyMoneyMicros: 5_000_000, // 95% = 4,750,000
              monthlyMoneyMicros: 50_000_000,
              dailyTokens: 5_000_000,
              monthlyTokens: 50_000_000,
            },
          } as any,
        ],
      })

      const nestedStore = new DarkFactoryFleetStore({
        adapter,
        config: nestedConfig,
        clock: clock.now,
      })
      await nestedStore.initialize()

      // Project money breach
      await expect(
        nestedStore.reserveSpend({
          projectId: 'proj-nested-1',
          hostId: 'host-nested-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-nested-money',
          generation: 1,
          requestId: 'req-nested-money',
          maxCostMicros: 9_500_001,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)

      await nestedStore.resume('budget')

      // Project token breach
      await expect(
        nestedStore.reserveSpend({
          projectId: 'proj-nested-1',
          hostId: 'host-nested-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-nested-token',
          generation: 1,
          requestId: 'req-nested-token',
          maxCostMicros: 100,
          maxTokens: 9_500_001,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })
  })

  describe('DF-15.5 Emergency Headroom Bypass & Hard 100% Cap', () => {
    it('allows typed emergency request to bypass 95% watermark up to 100% cap', async () => {
      // Saturate to 96%
      await store.pause('budget')
      // Fill spend counters to $48.00 (96%)
      await adapter.set(fleetKey('fleet-primary', 'spend:project:proj-fleet-1:daily:2026-09-06:cost'), '48000000')

      const emergencyRes = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-em-1',
        generation: 1,
        requestId: 'req-em-1',
        maxCostMicros: 1_500_000, // $1.50 -> brings to $49.50 (99% <= 100%)
        maxTokens: 10_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'canary-recovery',
        purposeEvidence: [
          {
            artifactId: 'art-canary-breach',
            digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
          },
        ],
      })
      expect(emergencyRes.state).toBe('reserved')
      expect(emergencyRes.purpose).toBe('canary-recovery')
    })

    it('rejects emergency request that would exceed 100% cap', async () => {
      await adapter.set(fleetKey('fleet-primary', 'spend:project:proj-fleet-1:daily:2026-09-06:cost'), '48000000')

      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-em-1',
          generation: 1,
          requestId: 'req-em-1',
          maxCostMicros: 2_500_000, // Brings total to $50.50 (101% > 100%)
          maxTokens: 10_000,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'canary-recovery',
          purposeEvidence: [
            {
              artifactId: 'art-canary-breach',
              digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            },
          ],
        }),
      ).rejects.toThrow(CapExceededError)
    })

    it('rejects emergency claim with empty purpose evidence', async () => {
      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-em-1',
          generation: 1,
          requestId: 'req-em-1',
          maxCostMicros: 1_000_000,
          maxTokens: 10_000,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'canary-recovery',
          purposeEvidence: [],
        }),
      ).rejects.toThrow()
    })

    it('permits emergency request when quota or catalog pauses are active', async () => {
      await store.pause('quota')
      await store.pause('catalog')

      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-em-1',
        generation: 1,
        requestId: 'req-em-1',
        maxCostMicros: 1_000_000,
        maxTokens: 10_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'verified-p0-security',
        purposeEvidence: [
          {
            artifactId: 'art-p0-receipt',
            digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
          },
        ],
      })
      expect(res.state).toBe('reserved')
    })

    it('strictly blocks emergency request when manual or safety pause is active', async () => {
      await store.pause('manual')
      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-em-1',
          generation: 1,
          requestId: 'req-em-1',
          maxCostMicros: 1_000_000,
          maxTokens: 10_000,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'verified-p0-security',
          purposeEvidence: [
            {
              artifactId: 'art-p0-receipt',
              digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
            },
          ],
        }),
      ).rejects.toThrow(PauseActiveError)
    })

    it('allows typed emergency request to bypass 95% token watermark up to 100% token cap', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-unbounded',
        accountId: 'acc-corp-1',
        attemptId: 'att-em-tk-pass',
        generation: 1,
        requestId: 'req-em-tk-pass',
        maxCostMicros: 1_000,
        maxTokens: 49_000_000, // Above 95% (47.5M), under 100% (50M)
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'canary-recovery',
        purposeEvidence: [
          {
            artifactId: 'art-evidence-1',
            digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
          },
        ],
      })
      expect(res.state).toBe('reserved')
      expect(res.maxTokens).toBe(49_000_000)
    })

    it('rejects emergency request that would exceed 100% token cap', async () => {
      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-unbounded',
          accountId: 'acc-corp-1',
          attemptId: 'att-em-tk-fail',
          generation: 1,
          requestId: 'req-em-tk-fail',
          maxCostMicros: 1_000,
          maxTokens: 50_000_001, // 1 token over 100% cap
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'canary-recovery',
          purposeEvidence: [
            {
              artifactId: 'art-evidence-1',
              digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
            },
          ],
        }),
      ).rejects.toThrow(CapExceededError)
    })
  })

  describe('DF-15.6 Five Independent Durable Pause Reasons', () => {
    it('activates and resumes each of the five independent pause reasons', async () => {
      const reasons = ['manual', 'safety', 'budget', 'quota', 'catalog'] as const
      for (const reason of reasons) {
        await store.pause(reason)
        expect(await store.getActivePauses()).toContain(reason)
        await store.resume(reason)
        expect(await store.getActivePauses()).not.toContain(reason)
      }
    })

    it('maintains multiple concurrent pause reasons in durable set', async () => {
      await store.pause('safety')
      await store.pause('budget')
      await store.pause('catalog')

      const active = await store.getActivePauses()
      expect(active).toHaveLength(3)
      expect(active).toEqual(expect.arrayContaining(['safety', 'budget', 'catalog']))
    })

    it('clearing one pause reason never clears or modifies other active reasons', async () => {
      await store.pause('safety')
      await store.pause('budget')
      await store.pause('catalog')

      await store.resume('budget')

      const active = await store.getActivePauses()
      expect(active).toHaveLength(2)
      expect(active).toEqual(expect.arrayContaining(['safety', 'catalog']))
      expect(active).not.toContain('budget')
    })

    it('resuming an inactive pause reason is a deterministic no-op', async () => {
      await store.pause('manual')
      await store.resume('quota') // Was never paused
      expect(await store.getActivePauses()).toEqual(['manual'])
    })

    it('aggregates all active pause reasons in routine admission rejection errors', async () => {
      await store.pause('budget')
      await store.pause('quota')

      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-1',
          generation: 1,
          requestId: 'req-1',
          maxCostMicros: 1_000,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(/budget.*quota|quota.*budget/)
    })

    it('queries spend metrics including pauses, fencing token, and authority epoch via getSpendMetrics', async () => {
      const initialMetrics = await store.getSpendMetrics()
      expect(initialMetrics.pauses).toEqual([])
      expect(typeof initialMetrics.fencing).toBe('number')
      expect(initialMetrics.epoch).toBe('epoch-1')

      await store.pause('catalog')
      await store.pause('budget')

      const pausedMetrics = await store.getSpendMetrics()
      expect(new Set(pausedMetrics.pauses)).toEqual(new Set(['catalog', 'budget']))
      expect(pausedMetrics.epoch).toBe('epoch-1')

      await store.resume('catalog')
      await store.resume('budget')
      expect(await store.getActivePauses()).toEqual([])
    })
  })

  describe('DF-15.7 Pricing Snapshot Bounding & Counting Semantics', () => {
    it('calculates worst-case request ceiling reservation cost from pricing snapshot', () => {
      const snapshot = createMockPricingSnapshot()
      const ceiling = {
        inputTokens: 100_000,
        outputTokens: 10_000,
        reasoningTokens: 10_000,
      }
      // 100k * $2/M = $0.20 (200,000 micros)
      // 10k * $8/M = $0.08 (80,000 micros)
      // 10k * $4/M = $0.04 (40,000 micros)
      // Total = 320,000 micros
      const maxCost = DarkFactoryFleetStore.computeMaxCostMicros(ceiling, snapshot)
      expect(maxCost).toBe(320_000)
    })

    it('calculates billed cost under exclusive-categories counting semantics', () => {
      const snapshot = createMockPricingSnapshot()
      const tokens = {
        inputTokens: 1000,
        cacheTokens: 500,
        outputTokens: 200,
        reasoningTokens: 100,
      }
      // 1000 * 2 + 500 * 0.5 + 200 * 8 + 100 * 4 = 2000 + 250 + 1600 + 400 = 4250 micros
      const cost = DarkFactoryFleetStore.computeBilledCostMicros(
        tokens,
        'exclusive-categories',
        snapshot,
      )
      expect(cost).toBe(4250)
    })

    it('calculates billed cost under cache-in-input-reasoning-in-output semantics', () => {
      const snapshot = createMockPricingSnapshot()
      const tokens = {
        inputTokens: 1000, // 400 cached -> 600 uncached
        cacheTokens: 400,
        outputTokens: 500, // 100 reasoning -> 400 pure output
        reasoningTokens: 100,
      }
      // 600 * 2 + 400 * 0.5 + 400 * 8 + 100 * 4 = 1200 + 200 + 3200 + 400 = 5000 micros
      const cost = DarkFactoryFleetStore.computeBilledCostMicros(
        tokens,
        'cache-in-input-reasoning-in-output',
        snapshot,
      )
      expect(cost).toBe(5000)
    })

    it('rejects usage events where subcounts exceed reported totals', () => {
      expect(() =>
        createMockUsageEvent({
          countingSemantics: 'cache-in-input-reasoning-in-output',
          inputTokens: 100,
          cacheTokens: 200,
          outputTokens: 100,
          reasoningTokens: 0,
        }),
      ).toThrow(/Usage subcounts exceed provider totals/)
    })
  })

  describe('DF-15.8 Stream Sequence Gap Tracking & Contiguous Auto-Drain', () => {
    it('processes contiguous sequence chunks (1, 2, 3) immediately', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 10_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })

      const e1 = await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 1 }))
      const e2 = await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 2 }))
      const e3 = await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 3 }))

      expect(e1.status).toBe('recorded')
      expect(e2.status).toBe('recorded')
      expect(e3.status).toBe('recorded')
      const current = await store.getReservation(res.id)
      expect(current?.state).toBe('started')
    })

    it('buffers out-of-order chunk and transitions reservation to reconciling', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 10_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })

      await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 1 }))
      const gapRes = await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 3 }))

      expect(gapRes.status).toBe('buffered_gap')
      const current = await store.getReservation(res.id)
      expect(current?.state).toBe('reconciling')
    })

    it('automatically drains contiguous buffered chunks when missing gap chunk arrives', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 10_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })

      await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 1 }))
      await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 3 }))
      await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 4 }))

      // Now supply missing chunk 2
      const drainResult = await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 2 }))
      expect(drainResult.status).toBe('recorded')

      const current = await store.getReservation(res.id)
      expect(current?.state).toBe('started')
    })

    it('blocks reservation settlement while unresolved gaps remain in buffer', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 10_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })
      await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 2 }))

      await expect(
        store.settleReservation({
          reservationId: res.id,
          actualCostMicros: 5000,
          actualTokens: 100,
        }),
      ).rejects.toThrow(SequenceGapError)
    })

    it('transitions reservation to withheld when reconcileBy deadline expires with gaps', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 10_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })
      await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 2 }))

      // Advance clock past reconcileBy deadline (default: +60s)
      clock.advanceMs(120_000)

      await store.reconcileDeadlines()
      const finalState = await store.getReservation(res.id)
      expect(finalState?.state).toBe('withheld')
    })
  })

  describe('DF-15.9 Idempotency & Conflicting Digest Quarantine', () => {
    it('returns duplicate_ignored on identical retry of recorded sequence chunk', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 10_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })

      const event = createMockUsageEvent({ reservationId: res.id, streamSequence: 1 })
      const first = await store.recordUsageEvent(event)
      expect(first.status).toBe('recorded')

      const retry = await store.recordUsageEvent(event)
      expect(retry.status).toBe('duplicate_ignored')
    })

    it('transitions reservation to withheld on conflicting digest for same sequence', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 10_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })

      const eventA = createMockUsageEvent({ reservationId: res.id, streamSequence: 1, inputTokens: 500 })
      const eventB = createMockUsageEvent({ reservationId: res.id, streamSequence: 1, inputTokens: 600 })

      await store.recordUsageEvent(eventA)
      await expect(store.recordUsageEvent(eventB)).rejects.toThrow(ConflictingDigestError)

      const finalState = await store.getReservation(res.id)
      expect(finalState?.state).toBe('withheld')
    })

    it('rejects new usage events on already settled reservation', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 10_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.settleReservation({ reservationId: res.id, actualCostMicros: 0, actualTokens: 0 })

      await expect(
        store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 1 })),
      ).rejects.toThrow(InvalidReservationTransitionError)
    })

    it('atomically removes reservation from active_reservations set when quarantined due to conflicting digest', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-quarantine-active-cleanup',
        generation: 1,
        requestId: 'req-quarantine-active-cleanup',
        maxCostMicros: 1_000_000,
        maxTokens: 20_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })

      const activeKey = fleetKey('fleet-primary', 'active_reservations')
      const initialActive = await adapter.eval<string[]>(
        'return redis.call("SMEMBERS", KEYS[1])',
        [activeKey],
        [],
      )
      expect(initialActive).toContain(res.id)

      const evA = createMockUsageEvent({
        reservationId: res.id,
        streamSequence: 1,
        inputTokens: 500,
        billedCostMicros: 50_000,
      })
      await store.recordUsageEvent(evA)

      // Send conflicting event for same sequence
      const evConflicting = createMockUsageEvent({
        reservationId: res.id,
        streamSequence: 1,
        inputTokens: 999,
        billedCostMicros: 99_000,
      })
      await expect(store.recordUsageEvent(evConflicting)).rejects.toThrow(ConflictingDigestError)

      const postRes = await store.getReservation(res.id)
      expect(postRes?.state).toBe('withheld')
      expect(postRes?.quarantineReason).toBe('ERR_CONFLICTING_EVENT_DIGEST')

      // Verify removed from active_reservations set
      const remainingActive = await adapter.eval<string[]>(
        'return redis.call("SMEMBERS", KEYS[1])',
        [activeKey],
        [],
      )
      expect(remainingActive).not.toContain(res.id)

      const isMember = await adapter.eval<number>(
        'return redis.call("SISMEMBER", KEYS[1], ARGV[1])',
        [activeKey],
        [res.id],
      )
      expect(isMember).toBe(0)
    })
  })

  describe('DF-15.10 Append-Only JSONL Audit Logging', () => {
    it('initializes and appends immutable audit records to local JSONL file', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })
      await store.recordUsageEvent(createMockUsageEvent({ reservationId: res.id, streamSequence: 1 }))
      await store.settleReservation({ reservationId: res.id, actualCostMicros: 5600, actualTokens: 1000 })

      const content = await readFile(auditLogPath, 'utf8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(4)

      const events = lines.map(line => JSON.parse(line))
      expect(events[0].eventType).toBe('reservation-created')
      expect(events[1].eventType).toBe('reservation-started')
      expect(events[2].eventType).toBe('usage-recorded')
      expect(events[3].eventType).toBe('reservation-settled')
    })

    it('verifies append-only integrity (prior lines never mutated)', async () => {
      await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      const initialContent = await readFile(auditLogPath, 'utf8')

      await store.pause('manual')
      const updatedContent = await readFile(auditLogPath, 'utf8')

      expect(updatedContent.startsWith(initialContent)).toBe(true)
    })

    it('audit records contain all canonical identifiers and fencing tokens', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-fleet-1',
        hostId: 'host-worker-1',
        accountId: 'acc-corp-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['quota-pool-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      const content = await readFile(auditLogPath, 'utf8')
      const event = JSON.parse(content.trim())
      expect(event).toMatchObject({
        schemaVersion: 1,
        reservationId: res.id,
        fencingToken: res.fencingToken,
        projectId: 'proj-fleet-1',
        costMicros: 1_000_000,
      })
    })

    it('fails closed when Redis is unavailable without substituting audit log for authority', async () => {
      // Simulate Redis disconnect
      await adapter.quit()

      await expect(
        store.reserveSpend({
          projectId: 'proj-fleet-1',
          hostId: 'host-worker-1',
          accountId: 'acc-corp-1',
          attemptId: 'att-1',
          generation: 1,
          requestId: 'req-1',
          maxCostMicros: 1_000_000,
          maxTokens: 50_000,
          maxRequests: 1,
          quotaPoolIds: ['quota-pool-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow()
    })
  })
})
