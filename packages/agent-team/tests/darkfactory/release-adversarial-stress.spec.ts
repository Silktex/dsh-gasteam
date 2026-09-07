/**
 * Dark Factory Gate 3: Release Lifecycle & Authority (DF-11)
 * Adversarial Stress Test Suite
 *
 * Exhaustively stress-tests:
 * 1. State machine illegal transitions (exhaustive 8x8 matrix + prerequisite checks + immutability)
 * 2. Single-environment FIFO queueing (5 queued, 1 active, strict queue head ordering, multi-env isolation)
 * 3. Token fencing monotonicity (regressive token rejection, revision gaps, append-only history enforcement)
 * 4. Completion receipts (cryptographic Ed25519 verification, tamper resistance, non-accepted state rejection)
 * 5. High-load journaling & restart state durability
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DarkFactoryReleaseStore,
  ReleaseConflictError,
  ReleaseQueueError,
  CANARY_ACCEPTED_DOMAIN,
} from '../../src/darkfactory/release-store.ts'
import {
  assertReleaseTransition,
  releaseTransitions,
  type ReleaseRecordV1,
  type ReleaseStateV1,
  type DeploymentRequestV1,
} from '../../src/darkfactory/contracts/release.ts'
import { HostKeyRegistry } from '../../src/darkfactory/verification-signer.ts'

const ALL_STATES: ReleaseStateV1[] = [
  'queued',
  'deploying',
  'observing',
  'accepted',
  'rollback_queued',
  'rolled_back',
  'failed',
  'quarantined',
]

function makeCandidate(
  projectId: string,
  id: string,
  environment = 'production',
  overrides: Partial<Parameters<DarkFactoryReleaseStore['queueRelease']>[0]> = {},
) {
  return {
    schemaVersion: 1 as const,
    id,
    projectId,
    policyRevision: 1,
    repository: { provider: 'github' as const, repositoryId: '42', canonicalName: 'deepseek/service' },
    environment,
    componentId: 'service',
    workflowId: 'flow-1',
    integrationReceiptId: `int-receipt-${id}`,
    attemptIds: ['attempt-1'],
    specDigests: ['sha256:' + '1'.repeat(64)],
    evidenceHashes: ['sha256:' + '2'.repeat(64)],
    commit: 'a'.repeat(40),
    artifact: {
      projectId,
      id: `art-${id}`,
      mediaType: 'application/octet-stream',
      sizeBytes: 1024,
      digest: 'sha256:' + '3'.repeat(64),
    },
    priorAcceptedReleaseId: 'rel-baseline-0',
    priorArtifact: {
      projectId,
      id: 'art-baseline-0',
      mediaType: 'application/octet-stream',
      sizeBytes: 1024,
      digest: 'sha256:' + '0'.repeat(64),
    },
    policyDigest: 'sha256:' + '5'.repeat(64),
    policySnapshot: {
      projectId,
      id: 'policy-1',
      mediaType: 'application/json',
      sizeBytes: 512,
      digest: 'sha256:' + '6'.repeat(64),
    },
    ...overrides,
  }
}

function makeUniversalValidRecord(
  state: ReleaseStateV1,
  overrides: Partial<ReleaseRecordV1> = {},
): ReleaseRecordV1 {
  const base = makeCandidate('proj-stress', 'rel-valid-1', 'production')
  const now = '2026-09-06T12:00:00.000Z'
  const canaryDeadline = '2026-09-06T12:15:00.000Z'
  const promotionDeadline = '2026-09-06T12:30:00.000Z'

  return {
    ...base,
    state,
    revision: 1,
    fencingToken: 1,
    operationIntents: [],
    operationReceipts: [],
    telemetryIds: ['tel-v1-001'],
    canaryStartedAt: now,
    canaryDeadline,
    promotionDeadline,
    healthEscalationId: 'escalation-001',
    rollbackIntegrationId: 'rb-int-001',
    diagnosticTaskId: 'diag-task-001',
    ...overrides,
  }
}

describe('DarkFactoryReleaseStore Adversarial Stress Harness', () => {
  describe('1. State Transition Machine & Illegal Transitions', () => {
    it('exhaustively evaluates all 64 state transitions across 8 states', () => {
      for (const fromState of ALL_STATES) {
        for (const toState of ALL_STATES) {
          const fromRecord = makeUniversalValidRecord(fromState, { revision: 1, fencingToken: 5 })
          const toRecord = makeUniversalValidRecord(toState, { revision: 2, fencingToken: 5 })

          const allowedTransitions = releaseTransitions[fromState] as readonly string[]
          const isAllowedSelf = allowedTransitions.length > 0 && fromState === toState
          const isAllowedTarget = allowedTransitions.includes(toState)
          const isLegal = isAllowedSelf || isAllowedTarget

          if (isLegal) {
            expect(() => assertReleaseTransition(fromRecord, toRecord)).not.toThrow()
          } else {
            expect(() => assertReleaseTransition(fromRecord, toRecord)).toThrow(
              'Illegal release lifecycle transition',
            )
          }
        }
      }
    })

    it('rejects illegal transitions through DarkFactoryReleaseStore instance', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-transitions-'))
      try {
        const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })
        const candidate = makeCandidate('proj-1', 'rel-illegal-1')
        await store.queueRelease(candidate)

        const now = new Date().toISOString()
        const canaryDeadline = new Date(Date.now() + 600_000).toISOString()
        const promotionDeadline = new Date(Date.now() + 1_200_000).toISOString()

        // 1. queued -> accepted (must fail)
        await expect(
          store.transitionRelease(candidate.id, 'accepted', {
            canaryStartedAt: now,
            canaryDeadline,
            promotionDeadline,
            telemetryIds: ['tel-1'],
          }),
        ).rejects.toThrow(/Illegal release lifecycle transition/)

        // 2. queued -> observing (must fail)
        await expect(
          store.transitionRelease(candidate.id, 'observing', {
            canaryStartedAt: now,
            canaryDeadline,
            promotionDeadline,
          }),
        ).rejects.toThrow(/Illegal release lifecycle transition/)

        // 3. queued -> rollback_queued (must fail)
        await expect(
          store.transitionRelease(candidate.id, 'rollback_queued', {
            rollbackIntegrationId: 'rb-1',
            diagnosticTaskId: 'diag-1',
          }),
        ).rejects.toThrow(/Illegal release lifecycle transition/)

        // 4. queued -> rolled_back (must fail)
        await expect(store.transitionRelease(candidate.id, 'rolled_back')).rejects.toThrow(
          /Illegal release lifecycle transition/,
        )

        // Move to deploying
        await store.transitionRelease(candidate.id, 'deploying')

        // 5. deploying -> accepted directly (bypassing observing, must fail)
        await expect(
          store.transitionRelease(candidate.id, 'accepted', {
            canaryStartedAt: now,
            canaryDeadline,
            promotionDeadline,
            telemetryIds: ['tel-1'],
          }),
        ).rejects.toThrow(/Illegal release lifecycle transition/)

        // 6. deploying -> rolled_back directly (bypassing rollback_queued, must fail)
        await expect(store.transitionRelease(candidate.id, 'rolled_back')).rejects.toThrow(
          /Illegal release lifecycle transition/,
        )

        // Move to observing
        await store.transitionRelease(candidate.id, 'observing', {
          canaryStartedAt: now,
          canaryDeadline,
          promotionDeadline,
        })

        // 7. observing -> deploying (backward transition, must fail)
        await expect(store.transitionRelease(candidate.id, 'deploying')).rejects.toThrow(
          /Illegal release lifecycle transition/,
        )

        // 8. observing -> rolled_back directly (bypassing rollback_queued, must fail)
        await expect(store.transitionRelease(candidate.id, 'rolled_back')).rejects.toThrow(
          /Illegal release lifecycle transition/,
        )

        // Move to accepted
        await store.transitionRelease(candidate.id, 'accepted', { telemetryIds: ['tel-1'] })

        // 9. accepted -> anything (terminal state, all must fail)
        for (const targetState of ALL_STATES) {
          await expect(
            store.transitionRelease(candidate.id, targetState, {
              healthEscalationId: targetState === 'quarantined' ? 'esc-1' : undefined,
              rollbackIntegrationId: targetState === 'rollback_queued' ? 'rb-1' : undefined,
              diagnosticTaskId: targetState === 'rollback_queued' ? 'diag-1' : undefined,
            }),
          ).rejects.toThrow(/Illegal release lifecycle transition/)
        }

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('enforces prerequisite invariants for observing, accepted, and quarantined states', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-prereqs-'))
      try {
        const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })
        const candidate = makeCandidate('proj-1', 'rel-prereq-1')
        await store.queueRelease(candidate)
        await store.transitionRelease(candidate.id, 'deploying')

        // observing missing canaryStartedAt / canaryDeadline / promotionDeadline
        await expect(store.transitionRelease(candidate.id, 'observing')).rejects.toThrow(
          /Observed release requires deadlines/,
        )

        // observing with inverted deadlines (canaryDeadline > promotionDeadline)
        const now = new Date().toISOString()
        await expect(
          store.transitionRelease(candidate.id, 'observing', {
            canaryStartedAt: now,
            canaryDeadline: new Date(Date.now() + 1_000_000).toISOString(),
            promotionDeadline: new Date(Date.now() + 500_000).toISOString(),
          }),
        ).rejects.toThrow(/Invalid promotion deadline time order/)

        // Move to observing with valid deadlines
        await store.transitionRelease(candidate.id, 'observing', {
          canaryStartedAt: now,
          canaryDeadline: new Date(Date.now() + 600_000).toISOString(),
          promotionDeadline: new Date(Date.now() + 1_200_000).toISOString(),
        })

        // accepted without telemetryIds
        await expect(store.transitionRelease(candidate.id, 'accepted')).rejects.toThrow(
          /Accepted release requires telemetry references/,
        )

        // accepted with empty telemetryIds
        await expect(
          store.transitionRelease(candidate.id, 'accepted', { telemetryIds: [] }),
        ).rejects.toThrow(/Accepted release requires telemetry references/)

        // quarantine without healthEscalationId
        const candidate2 = makeCandidate('proj-1', 'rel-prereq-2', 'staging')
        await store.queueRelease(candidate2)
        await expect(store.transitionRelease(candidate2.id, 'quarantined')).rejects.toThrow(
          /Quarantined release requires health inbox reference/,
        )

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('strictly enforces immutability of pinned release attributes across transitions', () => {
      const now = '2026-09-06T12:00:00.000Z'
      const canaryDeadline = '2026-09-06T12:15:00.000Z'
      const promotionDeadline = '2026-09-06T12:30:00.000Z'

      const base: ReleaseRecordV1 = {
        ...makeCandidate('proj-stress', 'rel-valid-1', 'production'),
        state: 'deploying',
        revision: 1,
        fencingToken: 5,
        operationIntents: [],
        operationReceipts: [],
        telemetryIds: [],
      }

      const validObservingTarget = {
        ...base,
        revision: 2,
        state: 'observing' as const,
        canaryStartedAt: now,
        canaryDeadline,
        promotionDeadline,
      }

      // 1. Mutated commit
      expect(() => {
        assertReleaseTransition(base, { ...validObservingTarget, commit: 'f'.repeat(40) })
      }).toThrow('Release identity and pinned inputs are immutable')

      // 2. Mutated artifact digest
      expect(() => {
        assertReleaseTransition(base, {
          ...validObservingTarget,
          artifact: { ...base.artifact, digest: 'sha256:' + '9'.repeat(64) },
        })
      }).toThrow('Release identity and pinned inputs are immutable')

      // 3. Mutated priorAcceptedReleaseId
      expect(() => {
        assertReleaseTransition(base, {
          ...validObservingTarget,
          priorAcceptedReleaseId: 'different-baseline',
        })
      }).toThrow('Release identity and pinned inputs are immutable')

      // 4. Mutated priorArtifact
      expect(() => {
        assertReleaseTransition(base, {
          ...validObservingTarget,
          priorArtifact: { ...base.priorArtifact, digest: 'sha256:' + '8'.repeat(64) },
        })
      }).toThrow('Release identity and pinned inputs are immutable')

      // 5. Mutated policyDigest
      expect(() => {
        assertReleaseTransition(base, {
          ...validObservingTarget,
          policyDigest: 'sha256:' + '7'.repeat(64),
        })
      }).toThrow('Release identity and pinned inputs are immutable')

      // 6. Mutated deadlines after they are set
      const observingBase = { ...validObservingTarget, revision: 2 }
      expect(() => {
        assertReleaseTransition(observingBase, {
          ...observingBase,
          revision: 3,
          canaryDeadline: '2026-09-06T12:20:00.000Z',
          state: 'accepted',
          telemetryIds: ['tel-1'],
        })
      }).toThrow('Recorded release deadlines and recovery references are immutable')
    })
  })

  describe('2. Single-Environment Concurrency & Strict FIFO Queueing', () => {
    it('enqueues 5 releases for the same environment and rigorously enforces FIFO execution order and single-owner custody', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-fifo-'))
      try {
        const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-fifo' })

        const r1 = makeCandidate('proj-fifo', 'cand-001', 'production')
        const r2 = makeCandidate('proj-fifo', 'cand-002', 'production')
        const r3 = makeCandidate('proj-fifo', 'cand-003', 'production')
        const r4 = makeCandidate('proj-fifo', 'cand-004', 'production')
        const r5 = makeCandidate('proj-fifo', 'cand-005', 'production')

        // 1. Enqueue 5 releases in order
        await store.queueRelease(r1)
        await store.queueRelease(r2)
        await store.queueRelease(r3)
        await store.queueRelease(r4)
        await store.queueRelease(r5)

        // Verify initial store snapshot
        const snapshotInitial = store.snapshot()
        expect(snapshotInitial.queue.map(r => r.id)).toEqual([
          'cand-001',
          'cand-002',
          'cand-003',
          'cand-004',
          'cand-005',
        ])
        expect(store.getActiveRelease('production')).toBeNull()

        // 2. Stress FIFO ordering: attempts to deploy any candidate other than head (cand-001) must fail
        for (const skipped of [r2, r3, r4, r5]) {
          await expect(store.transitionRelease(skipped.id, 'deploying')).rejects.toThrow(
            ReleaseQueueError,
          )
          await expect(store.transitionRelease(skipped.id, 'deploying')).rejects.toThrow(
            `Release ${skipped.id} is not at head of environment queue; head is cand-001`,
          )
        }

        // 3. Deploy head (cand-001) -> succeeds
        await store.transitionRelease(r1.id, 'deploying')
        expect(store.getActiveRelease('production')?.id).toBe('cand-001')

        // 4. Stress single active release invariant: while cand-001 is deploying, no one else can deploy
        for (const blocked of [r2, r3, r4, r5]) {
          await expect(store.transitionRelease(blocked.id, 'deploying')).rejects.toThrow(
            `Environment production already has active release: cand-001`,
          )
        }

        // Advance cand-001 to observing
        const now = new Date().toISOString()
        await store.transitionRelease(r1.id, 'observing', {
          canaryStartedAt: now,
          canaryDeadline: new Date(Date.now() + 600_000).toISOString(),
          promotionDeadline: new Date(Date.now() + 1_200_000).toISOString(),
        })
        expect(store.getActiveRelease('production')?.id).toBe('cand-001')

        // Still blocked while observing
        await expect(store.transitionRelease(r2.id, 'deploying')).rejects.toThrow(
          `Environment production already has active release: cand-001`,
        )

        // 5. Complete cand-001 -> accepted
        await store.transitionRelease(r1.id, 'accepted', { telemetryIds: ['tel-v1'] })
        expect(store.getActiveRelease('production')).toBeNull()

        // 6. Queue head is now cand-002. Cand-003, cand-004, cand-005 cannot jump the queue!
        for (const skipped of [r3, r4, r5]) {
          await expect(store.transitionRelease(skipped.id, 'deploying')).rejects.toThrow(
            `Release ${skipped.id} is not at head of environment queue; head is cand-002`,
          )
        }

        // 7. Deploy cand-002 -> succeeds
        await store.transitionRelease(r2.id, 'deploying')
        expect(store.getActiveRelease('production')?.id).toBe('cand-002')

        // Move cand-002 to observing then rollback_queued
        await store.transitionRelease(r2.id, 'observing', {
          canaryStartedAt: now,
          canaryDeadline: new Date(Date.now() + 600_000).toISOString(),
          promotionDeadline: new Date(Date.now() + 1_200_000).toISOString(),
        })
        await store.transitionRelease(r2.id, 'rollback_queued', {
          rollbackIntegrationId: 'rb-int-002',
          diagnosticTaskId: 'diag-002',
        })

        // cand-002 in rollback_queued STILL holds active custody!
        expect(store.getActiveRelease('production')?.id).toBe('cand-002')
        await expect(store.transitionRelease(r3.id, 'deploying')).rejects.toThrow(
          `Environment production already has active release: cand-002`,
        )

        // cand-002 rolls back to terminal state
        await store.transitionRelease(r2.id, 'rolled_back')
        expect(store.getActiveRelease('production')).toBeNull()

        // 8. Queue head is now cand-003. Simulate failure/cancellation of cand-003 directly from queued
        await expect(store.transitionRelease(r4.id, 'deploying')).rejects.toThrow(
          `Release cand-004 is not at head of environment queue; head is cand-003`,
        )

        await store.transitionRelease(r3.id, 'failed')
        expect(store.getActiveRelease('production')).toBeNull()

        // Now cand-004 is head of queue
        await expect(store.transitionRelease(r5.id, 'deploying')).rejects.toThrow(
          `Release cand-005 is not at head of environment queue; head is cand-004`,
        )

        // Deploy cand-004
        await store.transitionRelease(r4.id, 'deploying')
        expect(store.getActiveRelease('production')?.id).toBe('cand-004')

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('isolates queues across multiple independent environments concurrently', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-multienv-'))
      try {
        const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-env' })

        const prod1 = makeCandidate('proj-env', 'prod-001', 'production')
        const prod2 = makeCandidate('proj-env', 'prod-002', 'production')
        const stg1 = makeCandidate('proj-env', 'stg-001', 'staging')
        const stg2 = makeCandidate('proj-env', 'stg-002', 'staging')

        await store.queueRelease(prod1)
        await store.queueRelease(stg1)
        await store.queueRelease(prod2)
        await store.queueRelease(stg2)

        // Both staging and production heads can deploy concurrently without blocking
        await store.transitionRelease(prod1.id, 'deploying')
        await store.transitionRelease(stg1.id, 'deploying')

        expect(store.getActiveRelease('production')?.id).toBe('prod-001')
        expect(store.getActiveRelease('staging')?.id).toBe('stg-001')

        // prod-002 is blocked by prod-001, but stg-001 does not block prod
        await expect(store.transitionRelease(prod2.id, 'deploying')).rejects.toThrow(
          `Environment production already has active release: prod-001`,
        )
        await expect(store.transitionRelease(stg2.id, 'deploying')).rejects.toThrow(
          `Environment staging already has active release: stg-001`,
        )

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })

  describe('3. Token Fencing Monotonicity & Replay Rejection', () => {
    it('generates strictly monotonic fencing tokens across sequential release enqueues', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-fencing-tokens-'))
      try {
        const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-tokens' })

        for (let i = 1; i <= 10; i++) {
          const candidate = makeCandidate('proj-tokens', `cand-fence-${i}`, 'production')
          const queued = await store.queueRelease(candidate)
          expect(queued.fencingToken).toBe(i)
        }

        const releases = store.listReleases('production')
        expect(releases).toHaveLength(10)
        expect(releases.map(r => r.fencingToken)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('rejects stale or decreased fencing tokens during transition', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-stale-token-'))
      try {
        const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-stale' })
        const candidate = makeCandidate('proj-stale', 'cand-stale-1')
        const queued = await store.queueRelease(candidate)
        expect(queued.fencingToken).toBe(1)

        // Attempt transition with fencingToken = 0 (violates revisionSchema >= 1)
        await expect(
          store.transitionRelease(candidate.id, 'deploying', { fencingToken: 0 }),
        ).rejects.toThrow(/Too small/)

        // Bump fencingToken to 10
        await store.transitionRelease(candidate.id, 'deploying', { fencingToken: 10 })
        const current = store.getRelease(candidate.id)
        expect(current?.fencingToken).toBe(10)

        // Attempt transition with fencingToken = 9 (decreased from 10, violates monotonicity)
        await expect(
          store.transitionRelease(candidate.id, 'deploying', { fencingToken: 9 }),
        ).rejects.toThrow('Stale release revision or fencing token')

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('rejects stale or skipped revisions in assertReleaseTransition', () => {
      const base = makeUniversalValidRecord('deploying', { revision: 5, fencingToken: 10 })

      // Same revision (stale)
      expect(() => {
        assertReleaseTransition(base, { ...base, revision: 5, state: 'deploying' })
      }).toThrow('Stale release revision or fencing token')

      // Decreasing revision (regressive)
      expect(() => {
        assertReleaseTransition(base, { ...base, revision: 4, state: 'deploying' })
      }).toThrow('Stale release revision or fencing token')

      // Skipped revision (+2 instead of +1)
      expect(() => {
        assertReleaseTransition(base, { ...base, revision: 7, state: 'deploying' })
      }).toThrow('Stale release revision or fencing token')
    })

    it('strictly enforces append-only integrity on operationIntents, operationReceipts, and telemetryIds', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-append-only-'))
      try {
        const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-append' })
        const candidate = makeCandidate('proj-append', 'cand-app-1')
        await store.queueRelease(candidate)
        await store.transitionRelease(candidate.id, 'deploying')

        const intent1: DeploymentRequestV1 = {
          schemaVersion: 1,
          id: 'intent-001',
          projectId: 'proj-append',
          policyRevision: 1,
          environment: 'production',
          releaseId: candidate.id,
          operationId: 'op-001',
          fencingToken: 1,
          commit: candidate.commit,
          artifactDigest: candidate.artifact.digest,
          protocolVersion: 1,
          keyId: 'key-1',
          timestamp: new Date().toISOString(),
          operation: 'deployCanary',
          expectedPriorDeployment: 'dep-base',
          policyDigest: candidate.policyDigest,
        }

        await store.recordOperationIntent(candidate.id, intent1)
        const withIntent = store.getRelease(candidate.id)!
        expect(withIntent.operationIntents).toHaveLength(1)

        // Attempt to truncate operationIntents to empty array
        await expect(
          store.transitionRelease(candidate.id, 'deploying', { operationIntents: [] }),
        ).rejects.toThrow('Release operation and telemetry history is append-only')

        // Attempt to overwrite intent1 with a modified intent
        const mutatedIntent = { ...intent1, operation: 'promote' as const }
        await expect(
          store.transitionRelease(candidate.id, 'deploying', {
            operationIntents: [mutatedIntent],
          }),
        ).rejects.toThrow('Release operation and telemetry history is append-only')

        // Valid append succeeds
        const intent2: DeploymentRequestV1 = {
          ...intent1,
          id: 'intent-002',
          operationId: 'op-002',
          operation: 'promote',
        }
        await store.recordOperationIntent(candidate.id, intent2)
        expect(store.getRelease(candidate.id)!.operationIntents).toHaveLength(2)

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })

  describe('4. Completion Receipts & Cryptographic Ed25519 Authority', () => {
    it('rejects emitCompletionReceipt for all non-accepted states and non-existent releases', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-receipts-reject-'))
      try {
        const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-rcpt' })

        // 1. Non-existent release throws
        await expect(store.emitCompletionReceipt('non-existent-rel')).rejects.toThrow(
          'Release not found: non-existent-rel',
        )

        // 2. Queued release throws
        const cand1 = makeCandidate('proj-rcpt', 'cand-rcpt-1')
        await store.queueRelease(cand1)
        await expect(store.emitCompletionReceipt(cand1.id)).rejects.toThrow(
          /canary-accepted completion receipt requires state: 'accepted'/,
        )

        // 3. Deploying release throws
        await store.transitionRelease(cand1.id, 'deploying')
        await expect(store.emitCompletionReceipt(cand1.id)).rejects.toThrow(
          /canary-accepted completion receipt requires state: 'accepted'/,
        )

        // 4. Observing release throws
        const now = new Date().toISOString()
        await store.transitionRelease(cand1.id, 'observing', {
          canaryStartedAt: now,
          canaryDeadline: new Date(Date.now() + 600_000).toISOString(),
          promotionDeadline: new Date(Date.now() + 1_200_000).toISOString(),
        })
        await expect(store.emitCompletionReceipt(cand1.id)).rejects.toThrow(
          /canary-accepted completion receipt requires state: 'accepted'/,
        )

        // 5. Rollback_queued release throws
        await store.transitionRelease(cand1.id, 'rollback_queued', {
          rollbackIntegrationId: 'rb-1',
          diagnosticTaskId: 'diag-1',
        })
        await expect(store.emitCompletionReceipt(cand1.id)).rejects.toThrow(
          /canary-accepted completion receipt requires state: 'accepted'/,
        )

        // 6. Rolled_back release throws
        await store.transitionRelease(cand1.id, 'rolled_back')
        await expect(store.emitCompletionReceipt(cand1.id)).rejects.toThrow(
          /canary-accepted completion receipt requires state: 'accepted'/,
        )

        // 7. Quarantined release throws
        const cand2 = makeCandidate('proj-rcpt', 'cand-rcpt-2', 'staging')
        await store.queueRelease(cand2)
        await store.transitionRelease(cand2.id, 'quarantined', { healthEscalationId: 'esc-1' })
        await expect(store.emitCompletionReceipt(cand2.id)).rejects.toThrow(
          /canary-accepted completion receipt requires state: 'accepted'/,
        )

        // 8. Failed release throws
        const cand3 = makeCandidate('proj-rcpt', 'cand-rcpt-3', 'canary-test')
        await store.queueRelease(cand3)
        await store.transitionRelease(cand3.id, 'failed')
        await expect(store.emitCompletionReceipt(cand3.id)).rejects.toThrow(
          /canary-accepted completion receipt requires state: 'accepted'/,
        )

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('emits cryptographically valid Ed25519 canary-accepted completion receipts and defeats adversarial tampering', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-ed25519-'))
      const keyRegistry = new HostKeyRegistry()
      const { publicKeyPem } = keyRegistry.generateKey('release-signer-proj-crypto')

      try {
        const store = await DarkFactoryReleaseStore.open({
          directory,
          projectId: 'proj-crypto',
          keyRegistry,
        })

        const candidate = makeCandidate('proj-crypto', 'cand-crypto-1')
        await store.queueRelease(candidate)
        await store.transitionRelease(candidate.id, 'deploying')
        const now = new Date().toISOString()
        await store.transitionRelease(candidate.id, 'observing', {
          canaryStartedAt: now,
          canaryDeadline: new Date(Date.now() + 600_000).toISOString(),
          promotionDeadline: new Date(Date.now() + 1_200_000).toISOString(),
        })
        await store.transitionRelease(candidate.id, 'accepted', {
          telemetryIds: ['verdict-telemetry-001'],
        })

        // 1. Emit completion receipt
        const emitted = await store.emitCompletionReceipt(candidate.id)
        expect(emitted.receipt.kind).toBe('canary-accepted')
        expect(emitted.receipt.releaseId).toBe(candidate.id)
        expect(emitted.receipt.commit).toBe(candidate.commit)
        expect(emitted.receipt.artifactDigest).toBe(candidate.artifact.digest)
        expect(emitted.receipt.telemetryIds).toEqual(['verdict-telemetry-001'])

        // 2. Cryptographic verification with host public key
        const { attestationHash, signature } = emitted.receipt
        const messageBytes = Buffer.from(`${CANARY_ACCEPTED_DOMAIN}\n${attestationHash}`, 'utf8')
        const hostPublicKey = createPublicKey(publicKeyPem)

        const isValid = verify(null, messageBytes, hostPublicKey, Buffer.from(signature, 'base64'))
        expect(isValid).toBe(true)

        // 3. Adversarial Attack A: Tampered Signature Bytes
        const corruptedSigBuffer = Buffer.from(signature, 'base64')
        corruptedSigBuffer[0] = (corruptedSigBuffer[0]! ^ 0xff) // Flip bits of 1st byte
        const corruptedSigBase64 = corruptedSigBuffer.toString('base64')
        const isCorruptedSigValid = verify(
          null,
          messageBytes,
          hostPublicKey,
          Buffer.from(corruptedSigBase64, 'base64'),
        )
        expect(isCorruptedSigValid).toBe(false)

        // 4. Adversarial Attack B: Tampered Attestation Hash
        const tamperedHash = 'sha256:' + 'f'.repeat(64)
        const tamperedMessage = Buffer.from(`${CANARY_ACCEPTED_DOMAIN}\n${tamperedHash}`, 'utf8')
        const isTamperedHashValid = verify(
          null,
          tamperedMessage,
          hostPublicKey,
          Buffer.from(signature, 'base64'),
        )
        expect(isTamperedHashValid).toBe(false)

        // 5. Adversarial Attack C: Tampered Domain Separation
        const wrongDomainMessage = Buffer.from(`gasteam/fake-domain/v1\n${attestationHash}`, 'utf8')
        const isWrongDomainValid = verify(
          null,
          wrongDomainMessage,
          hostPublicKey,
          Buffer.from(signature, 'base64'),
        )
        expect(isWrongDomainValid).toBe(false)

        // 6. Adversarial Attack D: Attestation with Different Ed25519 Key
        const foreignKeys = generateKeyPairSync('ed25519')
        const isForeignPublicKeyValid = verify(
          null,
          messageBytes,
          foreignKeys.publicKey,
          Buffer.from(signature, 'base64'),
        )
        expect(isForeignPublicKeyValid).toBe(false)

        // 7. Idempotency: second call returns identical receipt without duplicating journal
        const secondEmit = await store.emitCompletionReceipt(candidate.id)
        expect(secondEmit.receiptId).toBe(emitted.receiptId)
        expect(secondEmit.signature).toBe(emitted.signature)
        expect(secondEmit.receipt).toEqual(emitted.receipt)

        await store.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })

  describe('5. High-Load Journaling & Restart State Durability', () => {
    it('endures high-volume sequential enqueues, restarts cleanly, and preserves queue integrity', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'release-stress-restart-durability-'))
      try {
        // Phase 1: Open store and enqueue 20 releases across 2 environments
        const store1 = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-durable' })
        for (let i = 1; i <= 10; i++) {
          await store1.queueRelease(makeCandidate('proj-durable', `prod-cand-${i}`, 'production'))
          await store1.queueRelease(makeCandidate('proj-durable', `stg-cand-${i}`, 'staging'))
        }

        // Deploy head of production
        await store1.transitionRelease('prod-cand-1', 'deploying')
        const now = new Date().toISOString()
        await store1.transitionRelease('prod-cand-1', 'observing', {
          canaryStartedAt: now,
          canaryDeadline: new Date(Date.now() + 600_000).toISOString(),
          promotionDeadline: new Date(Date.now() + 1_200_000).toISOString(),
        })

        // Verify state before restart
        expect(store1.getActiveRelease('production')?.id).toBe('prod-cand-1')
        expect(store1.getActiveRelease('staging')).toBeNull()
        await store1.close()

        // Phase 2: Restart from disk (re-open same directory)
        const store2 = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-durable' })

        // Assert full recovery
        expect(store2.getActiveRelease('production')?.id).toBe('prod-cand-1')
        expect(store2.getActiveRelease('staging')).toBeNull()

        const prodReleases = store2.listReleases('production')
        expect(prodReleases).toHaveLength(10)
        expect(prodReleases.map(r => r.fencingToken)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

        // Verify out-of-order deploy still blocked after restart
        await expect(store2.transitionRelease('prod-cand-2', 'deploying')).rejects.toThrow(
          `Environment production already has active release: prod-cand-1`,
        )

        // Complete prod-cand-1 post-restart
        await store2.transitionRelease('prod-cand-1', 'accepted', { telemetryIds: ['tel-post-restart'] })
        expect(store2.getActiveRelease('production')).toBeNull()

        // Now prod-cand-2 can deploy
        await store2.transitionRelease('prod-cand-2', 'deploying')
        expect(store2.getActiveRelease('production')?.id).toBe('prod-cand-2')

        // Verify staging head can deploy post-restart
        await store2.transitionRelease('stg-cand-1', 'deploying')
        expect(store2.getActiveRelease('staging')?.id).toBe('stg-cand-1')

        await store2.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })
})
