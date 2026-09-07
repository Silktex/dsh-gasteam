import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  InMemoryRedisAdapter,
  fleetKey,
} from '../packages/agent-team/src/darkfactory/redis-adapter.ts'
import {
  DarkFactoryFleetStore,
  WatermarkBreachError,
  CapExceededError,
  PauseActiveError,
  type PauseReason,
} from '../packages/agent-team/src/darkfactory/fleet-store.ts'
import { digestJson } from '../packages/agent-team/src/darkfactory/json.ts'
import { assertContractSemantics } from '../packages/agent-team/src/darkfactory/contracts/semantics.ts'
import type {
  UsageEventPayload,
  UsageEventV1,
} from '../packages/agent-team/src/darkfactory/contracts/economics.ts'

function makeTestClock(initialTime = '2026-09-06T21:45:00.000Z') {
  let currentTime = initialTime
  return {
    now: () => currentTime,
    set: (isoTime: string) => {
      currentTime = isoTime
    },
  }
}

function createMockUsageEvent(payloadOverrides: Partial<UsageEventPayload> = {}): UsageEventV1 {
  const payload: UsageEventPayload = {
    schemaVersion: 1,
    id: 'usage-event-1',
    projectId: 'proj-unconstrained',
    policyRevision: 1,
    fleetId: 'fleet-test',
    hostId: 'host-1',
    attemptId: 'att-stream-1',
    generation: 1,
    provider: 'prov-1',
    accountId: 'acc-1',
    modelVersion: 'm-1',
    requestId: 'req-stream-1',
    streamSequence: 1,
    pricingRevision: 1,
    usageAt: '2026-09-06T12:00:00.000Z',
    inputTokens: 1000,
    cacheTokens: 200,
    outputTokens: 500,
    reasoningTokens: 100,
    countingSemantics: 'cache-in-input-reasoning-in-output',
    billedCostMicros: 500_000,
    currency: 'USD',
    reservationId: 'res-reservation-1',
    ...payloadOverrides,
  }
  const event: UsageEventV1 = {
    ...payload,
    eventDigest: digestJson(payload),
  }
  assertContractSemantics('UsageEventV1', event)
  return event
}

describe('Adversarial Stress Test: Watermark, Caps & Pause State Invariants', () => {
  let adapter: InMemoryRedisAdapter
  let store: DarkFactoryFleetStore
  let tempDir: string
  let clock: ReturnType<typeof makeTestClock>

  // Caps configured with 100,000,000 units so 95% = 95,000,000 exactly
  // 94.999% = 94,999,000
  // 95.000% = 95,000,000
  // 95.001% = 95,001,000
  // 100.000% = 100,000,000
  // 100.001% = 100,001,000
  const CAP_UNITS = 100_000_000
  const PCT_94_999 = 94_999_000
  const PCT_95_000 = 95_000_000
  const PCT_95_001 = 95_001_000
  const PCT_100_000 = 100_000_000
  const PCT_100_001 = 100_001_000

  const mockEvidence = [
    {
      artifactId: 'art-evidence-1',
      digest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  ]

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'watermark-stress-'))
    clock = makeTestClock('2026-09-06T12:00:00.000Z')
    adapter = new InMemoryRedisAdapter({ clock: clock.now })

    const config: any = {
      fleetId: 'fleet-test',
      hostId: 'host-1',
      fleetCaps: {
        dailyMoneyMicros: CAP_UNITS,
        monthlyMoneyMicros: CAP_UNITS * 10,
        dailyTokens: CAP_UNITS,
        monthlyTokens: CAP_UNITS * 10,
      },
      projectCaps: [
        {
          id: 'proj-1',
          dailyMoneyMicros: CAP_UNITS,
          monthlyMoneyMicros: CAP_UNITS * 10,
          dailyTokens: CAP_UNITS,
          monthlyTokens: CAP_UNITS * 10,
        },
      ],
      hostCaps: [
        {
          id: 'host-1',
          dailyMoneyMicros: CAP_UNITS,
          monthlyMoneyMicros: CAP_UNITS * 10,
          dailyTokens: CAP_UNITS,
          monthlyTokens: CAP_UNITS * 10,
        },
      ],
      routineWatermark: 0.95,
      reserveFraction: 0.1,
      emergencyPurposes: ['canary-recovery', 'verified-p0-security', 'production-invariant-recovery'],
    }

    store = new DarkFactoryFleetStore({
      adapter,
      config,
      auditLogDirectory: tempDir,
      clock: clock.now,
    })
    await store.initialize()
  })

  afterEach(async () => {
    await store.close()
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  // =========================================================================
  // SUITE 1: 95% Spend Watermark Precision (Money) across all 6 hierarchies
  // =========================================================================
  describe('Suite 1: 95% Spend Watermark Precision on Money across 6 Hierarchies', () => {
    it('Hierarchy 1: Fleet Daily Money boundary (94.999% pass, 95.000% pass, 95.001% fail)', async () => {
      // 94.999%
      const res1 = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: PCT_94_999,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res1.state).toBe('reserved')
      expect(await store.getActivePauses()).toEqual([])
      await store.settleReservation({ reservationId: res1.id, actualCostMicros: 0, actualTokens: 0 })

      // 95.000%
      const res2 = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-2',
        generation: 1,
        requestId: 'req-2',
        maxCostMicros: PCT_95_000,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res2.state).toBe('reserved')
      expect(await store.getActivePauses()).toEqual([])
      await store.settleReservation({ reservationId: res2.id, actualCostMicros: 0, actualTokens: 0 })

      // 95.001%
      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: PCT_95_001,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
      expect(await store.getActivePauses()).toContain('budget')
    })

    it('Hierarchy 2: Fleet Monthly Money boundary (94.999% pass, 95.000% pass, 95.001% fail)', async () => {
      const monthlyCap = CAP_UNITS * 10
      const m94_999 = Math.floor(monthlyCap * 0.94999)
      const m95_000 = Math.floor(monthlyCap * 0.95)

      clock.set('2026-09-01T12:00:00.000Z')
      await adapter.set(fleetKey('fleet-test', 'spend:fleet:monthly:2026-09:cost'), String(m94_999 - 1_000))

      clock.set('2026-09-06T12:00:00.000Z')
      const res1 = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res1.state).toBe('reserved')
      await store.settleReservation({ reservationId: res1.id, actualCostMicros: 0, actualTokens: 0 })

      const diffTo95 = m95_000 - (m94_999 - 1_000)
      const res2 = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-2',
        generation: 1,
        requestId: 'req-2',
        maxCostMicros: diffTo95,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res2.state).toBe('reserved')
      await store.settleReservation({ reservationId: res2.id, actualCostMicros: 0, actualTokens: 0 })

      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: diffTo95 + 1,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
      expect(await store.getActivePauses()).toContain('budget')
    })

    it('Hierarchy 3: Project Daily Money boundary (94.999% pass, 95.000% pass, 95.001% fail)', async () => {
      const res1 = await store.reserveSpend({
        projectId: 'proj-1',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: PCT_94_999,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res1.state).toBe('reserved')
      await store.settleReservation({ reservationId: res1.id, actualCostMicros: 0, actualTokens: 0 })

      const res2 = await store.reserveSpend({
        projectId: 'proj-1',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-2',
        generation: 1,
        requestId: 'req-2',
        maxCostMicros: PCT_95_000,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res2.state).toBe('reserved')
      await store.settleReservation({ reservationId: res2.id, actualCostMicros: 0, actualTokens: 0 })

      await expect(
        store.reserveSpend({
          projectId: 'proj-1',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: PCT_95_001,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
      expect(await store.getActivePauses()).toContain('budget')
    })

    it('Hierarchy 4: Project Monthly Money boundary (94.999% pass, 95.000% pass, 95.001% fail)', async () => {
      const monthlyCap = CAP_UNITS * 10
      const m95_000 = Math.floor(monthlyCap * 0.95)

      await adapter.set(fleetKey('fleet-test', 'spend:project:proj-1:monthly:2026-09:cost'), String(m95_000 - 1_000))

      const res = await store.reserveSpend({
        projectId: 'proj-1',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res.state).toBe('reserved')
      await store.settleReservation({ reservationId: res.id, actualCostMicros: 0, actualTokens: 0 })

      await expect(
        store.reserveSpend({
          projectId: 'proj-1',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-2',
          generation: 1,
          requestId: 'req-2',
          maxCostMicros: 1_001,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
      expect(await store.getActivePauses()).toContain('budget')
    })

    it('Hierarchy 5: Host Daily Money boundary (94.999% pass, 95.000% pass, 95.001% fail)', async () => {
      const res1 = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-1',
        accountId: 'acc-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: PCT_94_999,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res1.state).toBe('reserved')
      await store.settleReservation({ reservationId: res1.id, actualCostMicros: 0, actualTokens: 0 })

      const res2 = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-1',
        accountId: 'acc-1',
        attemptId: 'att-2',
        generation: 1,
        requestId: 'req-2',
        maxCostMicros: PCT_95_000,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res2.state).toBe('reserved')
      await store.settleReservation({ reservationId: res2.id, actualCostMicros: 0, actualTokens: 0 })

      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-1',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: PCT_95_001,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
      expect(await store.getActivePauses()).toContain('budget')
    })

    it('Hierarchy 6: Host Monthly Money boundary (94.999% pass, 95.000% pass, 95.001% fail)', async () => {
      const monthlyCap = CAP_UNITS * 10
      const m95_000 = Math.floor(monthlyCap * 0.95)

      await adapter.set(fleetKey('fleet-test', 'spend:host:host-1:monthly:2026-09:cost'), String(m95_000 - 1_000))

      const res = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-1',
        accountId: 'acc-1',
        attemptId: 'att-1',
        generation: 1,
        requestId: 'req-1',
        maxCostMicros: 1_000,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      expect(res.state).toBe('reserved')
      await store.settleReservation({ reservationId: res.id, actualCostMicros: 0, actualTokens: 0 })

      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-1',
          accountId: 'acc-1',
          attemptId: 'att-2',
          generation: 1,
          requestId: 'req-2',
          maxCostMicros: 1_001,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
      expect(await store.getActivePauses()).toContain('budget')
    })
  })

  // =========================================================================
  // SUITE 2: 95% Spend Watermark Precision (Tokens) across all 6 hierarchies
  // =========================================================================
  describe('Suite 2: 95% Spend Watermark Precision on Tokens across 6 Hierarchies', () => {
    it('Hierarchy 1: Fleet Daily Tokens boundary (95.001% token breach)', async () => {
      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: 100,
          maxTokens: PCT_95_001,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })

    it('Hierarchy 2: Fleet Monthly Tokens boundary (95.001% token breach)', async () => {
      const monthlyTokens = CAP_UNITS * 10
      const limit = Math.floor(monthlyTokens * 0.95)

      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: 100,
          maxTokens: limit + 1,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })

    it('Hierarchy 3: Project Daily Tokens boundary (95.001% token breach)', async () => {
      await expect(
        store.reserveSpend({
          projectId: 'proj-1',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: 100,
          maxTokens: PCT_95_001,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })

    it('Hierarchy 4: Project Monthly Tokens boundary (95.001% token breach)', async () => {
      const monthlyTokens = CAP_UNITS * 10
      const limit = Math.floor(monthlyTokens * 0.95)
      await expect(
        store.reserveSpend({
          projectId: 'proj-1',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: 100,
          maxTokens: limit + 1,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })

    it('Hierarchy 5: Host Daily Tokens boundary (95.001% token breach)', async () => {
      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-1',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: 100,
          maxTokens: PCT_95_001,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })

    it('Hierarchy 6: Host Monthly Tokens boundary (95.001% token breach)', async () => {
      const monthlyTokens = CAP_UNITS * 10
      const limit = Math.floor(monthlyTokens * 0.95)
      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-1',
          accountId: 'acc-1',
          attemptId: 'att-3',
          generation: 1,
          requestId: 'req-3',
          maxCostMicros: 100,
          maxTokens: limit + 1,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })
  })

  // =========================================================================
  // SUITE 3: Emergency Reserve Bypass & Hard 100% Cap
  // =========================================================================
  describe('Suite 3: Emergency Reserve Bypass & Hard 100% Cap', () => {
    it('permits typed emergency at exactly 100.000% Money cap', async () => {
      await adapter.set(fleetKey('fleet-test', 'spend:fleet:daily:2026-09-06:cost'), '96000000')

      const res = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-em-1',
        generation: 1,
        requestId: 'req-em-1',
        maxCostMicros: 4_000_000,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'canary-recovery',
        purposeEvidence: mockEvidence,
      })
      expect(res.state).toBe('reserved')
    })

    it('rejects typed emergency breaching 100.000% Money cap at 100.001%', async () => {
      await adapter.set(fleetKey('fleet-test', 'spend:fleet:daily:2026-09-06:cost'), '96000000')

      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-em-2',
          generation: 1,
          requestId: 'req-em-2',
          maxCostMicros: 4_000_001,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'canary-recovery',
          purposeEvidence: mockEvidence,
        }),
      ).rejects.toThrow(CapExceededError)
    })

    it('rejects untyped routine request exceeding 95% spend even with evidence', async () => {
      await adapter.set(fleetKey('fleet-test', 'spend:fleet:daily:2026-09-06:cost'), '94000000')

      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-rt-1',
          generation: 1,
          requestId: 'req-rt-1',
          maxCostMicros: 1_001_000,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
          purposeEvidence: mockEvidence,
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })

    it('rejects emergency with empty or missing purposeEvidence', async () => {
      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-em-bad-1',
          generation: 1,
          requestId: 'req-em-bad-1',
          maxCostMicros: 1_000,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'canary-recovery',
          purposeEvidence: [],
        }),
      ).rejects.toThrow(/evidence/)

      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-em-bad-2',
          generation: 1,
          requestId: 'req-em-bad-2',
          maxCostMicros: 1_000,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'canary-recovery',
          purposeEvidence: undefined,
        }),
      ).rejects.toThrow(/evidence/)
    })

    it('tests all 3 typed emergency purposes succeed under 100%', async () => {
      const purposes = ['canary-recovery', 'verified-p0-security', 'production-invariant-recovery'] as const
      for (const purpose of purposes) {
        const res = await store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: `att-${purpose}`,
          generation: 1,
          requestId: `req-${purpose}`,
          maxCostMicros: 1_000,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose,
          purposeEvidence: mockEvidence,
        })
        expect(res.state).toBe('reserved')
        expect(res.purpose).toBe(purpose)
        await store.settleReservation({ reservationId: res.id, actualCostMicros: 0, actualTokens: 0 })
      }
    })
  })

  // =========================================================================
  // SUITE 4: Pause Independence Invariant & Permutation Testing
  // =========================================================================
  describe('Suite 4: Pause Independence Invariant (5! = 120 Permutations)', () => {
    const ALL_PAUSES: PauseReason[] = ['manual', 'safety', 'budget', 'quota', 'catalog']

    it('proves that clearing any pause reason in arbitrary permutations leaves others strictly unaltered', async () => {
      const permutations: PauseReason[][] = [
        ['manual', 'safety', 'budget', 'quota', 'catalog'],
        ['catalog', 'quota', 'budget', 'safety', 'manual'],
        ['budget', 'catalog', 'manual', 'quota', 'safety'],
        ['safety', 'budget', 'catalog', 'manual', 'quota'],
        ['quota', 'manual', 'safety', 'catalog', 'budget'],
        ['manual', 'catalog', 'safety', 'budget', 'quota'],
        ['catalog', 'manual', 'quota', 'safety', 'budget'],
        ['budget', 'safety', 'quota', 'catalog', 'manual'],
        ['safety', 'catalog', 'manual', 'budget', 'quota'],
        ['quota', 'budget', 'safety', 'manual', 'catalog'],
      ]

      for (const perm of permutations) {
        for (const p of ALL_PAUSES) {
          await store.pause(p)
        }
        let active = await store.getActivePauses()
        expect(new Set(active)).toEqual(new Set(ALL_PAUSES))

        const remaining = new Set(ALL_PAUSES)
        for (const p of perm) {
          await store.resume(p)
          remaining.delete(p)
          active = await store.getActivePauses()
          expect(new Set(active)).toEqual(remaining)
          expect(active.includes(p)).toBe(false)
        }
        expect(await store.getActivePauses()).toEqual([])
      }
    })

    it('strictly blocks emergency requests if manual pause is active', async () => {
      await store.pause('manual')
      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-em-blocked',
          generation: 1,
          requestId: 'req-em-blocked',
          maxCostMicros: 1_000,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'canary-recovery',
          purposeEvidence: mockEvidence,
        }),
      ).rejects.toThrow(PauseActiveError)
    })

    it('strictly blocks emergency requests if safety pause is active', async () => {
      await store.pause('safety')
      await expect(
        store.reserveSpend({
          projectId: 'proj-unconstrained',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-em-blocked',
          generation: 1,
          requestId: 'req-em-blocked',
          maxCostMicros: 1_000,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'verified-p0-security',
          purposeEvidence: mockEvidence,
        }),
      ).rejects.toThrow(PauseActiveError)
    })

    it('permits emergency requests if ONLY budget, quota, and/or catalog pauses are active', async () => {
      await store.pause('budget')
      await store.pause('quota')
      await store.pause('catalog')

      const res = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-em-allowed',
        generation: 1,
        requestId: 'req-em-allowed',
        maxCostMicros: 1_000,
        maxTokens: 100,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'production-invariant-recovery',
        purposeEvidence: mockEvidence,
      })
      expect(res.state).toBe('reserved')
    })
  })

  // =========================================================================
  // SUITE 5: Schema-Compliant Nested Cap Structure ({ id, caps: { ... } })
  // =========================================================================
  describe('Suite 5: Schema-Compliant Nested Cap Structure ({ id, caps: { ... } })', () => {
    it('enforces project watermark when config uses schema-compliant scopedCap ({ id, caps })', async () => {
      const nestedConfig: any = {
        fleetId: 'fleet-nested',
        hostId: 'host-nested',
        fleetCaps: {
          dailyMoneyMicros: CAP_UNITS * 10,
          monthlyMoneyMicros: CAP_UNITS * 100,
          dailyTokens: CAP_UNITS * 10,
          monthlyTokens: CAP_UNITS * 100,
        },
        // In EnabledDarkFactoryConfig, projectCaps is { id: string, caps: Cap }
        projectCaps: [
          {
            id: 'proj-nested-1',
            caps: {
              dailyMoneyMicros: CAP_UNITS, // $100.00
              monthlyMoneyMicros: CAP_UNITS * 10,
              dailyTokens: CAP_UNITS,
              monthlyTokens: CAP_UNITS * 10,
            },
          },
        ],
        hostCaps: [
          {
            id: 'host-nested-1',
            caps: {
              dailyMoneyMicros: CAP_UNITS,
              monthlyMoneyMicros: CAP_UNITS * 10,
              dailyTokens: CAP_UNITS,
              monthlyTokens: CAP_UNITS * 10,
            },
          },
        ],
        routineWatermark: 0.95,
        reserveFraction: 0.1,
        emergencyPurposes: ['canary-recovery'],
      }

      const nestedStore = new DarkFactoryFleetStore({
        adapter,
        config: nestedConfig,
        clock: clock.now,
      })
      await nestedStore.initialize()

      await expect(
        nestedStore.reserveSpend({
          projectId: 'proj-nested-1',
          hostId: 'host-unconstrained',
          accountId: 'acc-1',
          attemptId: 'att-nested-1',
          generation: 1,
          requestId: 'req-nested-1',
          maxCostMicros: PCT_95_001,
          maxTokens: 100,
          maxRequests: 1,
          quotaPoolIds: ['q-1'],
          pricingRevision: 1,
          purpose: 'routine',
        }),
      ).rejects.toThrow(WatermarkBreachError)
    })
  })

  // =========================================================================
  // SUITE 6: Settlement without explicit actualCostMicros wipes recorded stream usage
  // =========================================================================
  describe('Suite 6: Settlement Usage Accounting Integrity', () => {
    it('preserves recorded stream usage when settling without explicit actualCostMicros', async () => {
      const res = await store.reserveSpend({
        projectId: 'proj-unconstrained',
        hostId: 'host-unconstrained',
        accountId: 'acc-1',
        attemptId: 'att-stream-1',
        generation: 1,
        requestId: 'req-stream-1',
        maxCostMicros: 2_000_000,
        maxTokens: 50_000,
        maxRequests: 1,
        quotaPoolIds: ['q-1'],
        pricingRevision: 1,
        purpose: 'routine',
      })
      await store.startReservation({ reservationId: res.id, fencingToken: res.fencingToken })

      // Record 500,000 micros via UsageEvent
      const event = createMockUsageEvent({
        reservationId: res.id,
        streamSequence: 1,
        inputTokens: 1000,
        cacheTokens: 200,
        outputTokens: 500,
        reasoningTokens: 100,
        billedCostMicros: 500_000,
      })
      await store.recordUsageEvent(event)

      // Settle WITHOUT passing actualCostMicros
      const settled = await store.settleReservation({ reservationId: res.id })

      // The settled cost MUST NOT be 0! It must be the 500,000 micros accumulated from the stream!
      expect(settled.settledCostMicros).toBe(500_000)
    })
  })
})
