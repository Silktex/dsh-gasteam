import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DarkFactoryReleaseStore,
  ReleaseConflictError,
  ReleaseQueueError,
  CANARY_ACCEPTED_DOMAIN,
} from '../../src/darkfactory/release-store.ts'
import { HostKeyRegistry } from '../../src/darkfactory/verification-signer.ts'
import { digestJson } from '../../src/darkfactory/json.ts'

function sampleCandidate(projectId: string, id: string, environment = 'production') {
  return {
    schemaVersion: 1 as const,
    id,
    projectId,
    policyRevision: 1,
    repository: { provider: 'github', repositoryId: '42', canonicalName: 'deepseek/service' },
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
  }
}

describe('DarkFactoryReleaseStore', () => {
  it('initializes store, writes journal file, and enforces exclusive fcntl locking', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-store-init-'))
    try {
      const store1 = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })
      expect(store1.projectId).toBe('proj-1')

      // Verify journal file exists
      const journalStat = await stat(join(directory, 'darkfactory/proj-1/release.jsonl'))
      expect(journalStat.isFile()).toBe(true)

      // Concurrent open on same directory must fail with file ownership error
      await expect(
        DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' }),
      ).rejects.toThrow()

      await store1.close()

      // After close, opening again succeeds
      const store2 = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })
      expect(store2.projectId).toBe('proj-1')
      await store2.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('enforces idempotency and rejects conflicting enqueue attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-store-idempotent-'))
    try {
      const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })
      const candidate = sampleCandidate('proj-1', 'rel-1')

      // 1. Initial queue
      const queued1 = await store.queueRelease(candidate)
      expect(queued1.state).toBe('queued')
      expect(queued1.revision).toBe(1)
      expect(queued1.fencingToken).toBe(1)

      // 2. Idempotent re-queue returns identical record
      const queued2 = await store.queueRelease(candidate)
      expect(queued2).toEqual(queued1)

      // 3. Conflicting input with same ID throws ReleaseConflictError
      const conflicting = { ...candidate, commit: 'b'.repeat(40) }
      await expect(store.queueRelease(conflicting)).rejects.toThrow(ReleaseConflictError)

      // 4. Duplicate (environment, integrationReceiptId) with different ID throws ReleaseConflictError
      const duplicateWork = { ...candidate, id: 'rel-2' }
      await expect(store.queueRelease(duplicateWork)).rejects.toThrow(ReleaseConflictError)

      // 5. Cross-project submission throws ReleaseConflictError
      const crossProject = sampleCandidate('other-proj', 'rel-3')
      await expect(store.queueRelease(crossProject)).rejects.toThrow(ReleaseConflictError)

      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('validates full lifecycle progression: queued -> deploying -> observing -> accepted and emits verifiable Ed25519 receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-store-lifecycle-'))
    const keyRegistry = new HostKeyRegistry()
    const { keyId, publicKeyPem } = keyRegistry.generateKey('release-signer-proj-1')

    try {
      const store = await DarkFactoryReleaseStore.open({
        directory,
        projectId: 'proj-1',
        keyRegistry,
      })
      const candidate = sampleCandidate('proj-1', 'rel-1')
      await store.queueRelease(candidate)

      // 1. Cannot emit receipt while queued
      await expect(store.emitCompletionReceipt(candidate.id)).rejects.toThrow(
        /requires state: 'accepted'/,
      )

      // 2. Transition to deploying
      const deploying = await store.transitionRelease(candidate.id, 'deploying')
      expect(deploying.state).toBe('deploying')
      expect(deploying.revision).toBe(2)

      // 3. Transition to observing requires deadlines
      await expect(store.transitionRelease(candidate.id, 'observing')).rejects.toThrow(
        /Observed release requires deadlines/,
      )

      const canaryStartedAt = new Date().toISOString()
      const canaryDeadline = new Date(Date.now() + 600_000).toISOString()
      const promotionDeadline = new Date(Date.now() + 1_200_000).toISOString()

      const observing = await store.transitionRelease(candidate.id, 'observing', {
        canaryStartedAt,
        canaryDeadline,
        promotionDeadline,
      })
      expect(observing.state).toBe('observing')
      expect(observing.revision).toBe(3)

      // 4. Transition to accepted requires telemetryIds
      await expect(store.transitionRelease(candidate.id, 'accepted')).rejects.toThrow(
        /Accepted release requires telemetry references/,
      )

      const accepted = await store.transitionRelease(candidate.id, 'accepted', {
        telemetryIds: ['verdict-1'],
      })
      expect(accepted.state).toBe('accepted')
      expect(accepted.revision).toBe(4)

      // 5. Accepted is terminal; further transitions throw
      await expect(store.transitionRelease(candidate.id, 'deploying')).rejects.toThrow(
        /Illegal release lifecycle transition/,
      )

      // 6. Emit signed canary-accepted completion receipt
      const receiptResult = await store.emitCompletionReceipt(candidate.id)
      expect(receiptResult.receiptId).toMatch(/^df-receipt-canary-[a-f0-9]{32}$/)
      expect(receiptResult.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/)

      // Verify Ed25519 signature cryptographically against public key
      const { attestationHash, signature } = receiptResult.receipt
      const messageBytes = Buffer.from(`${CANARY_ACCEPTED_DOMAIN}\n${attestationHash}`, 'utf8')
      const publicKey = createPublicKey(publicKeyPem)
      const valid = verify(null, messageBytes, publicKey, Buffer.from(signature, 'base64'))
      expect(valid).toBe(true)

      // 7. Idempotent emit returns identical receipt
      const secondEmit = await store.emitCompletionReceipt(candidate.id)
      expect(secondEmit.receiptId).toBe(receiptResult.receiptId)
      expect(secondEmit.signature).toBe(receiptResult.signature)

      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('handles rollback and quarantine lifecycles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-store-rollback-'))
    try {
      const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })
      const candidate1 = sampleCandidate('proj-1', 'rel-rb-1')
      await store.queueRelease(candidate1)
      await store.transitionRelease(candidate1.id, 'deploying')

      // Rollback path: deploying -> rollback_queued -> rolled_back
      const rbQueued = await store.transitionRelease(candidate1.id, 'rollback_queued', {
        rollbackIntegrationId: 'rb-int-1',
        diagnosticTaskId: 'diag-1',
      })
      expect(rbQueued.state).toBe('rollback_queued')

      const rolledBack = await store.transitionRelease(candidate1.id, 'rolled_back')
      expect(rolledBack.state).toBe('rolled_back')

      // Terminal state cannot transition
      await expect(store.transitionRelease(candidate1.id, 'deploying')).rejects.toThrow(
        /Illegal release lifecycle transition/,
      )

      // Quarantine path requires healthEscalationId
      const candidate2 = sampleCandidate('proj-1', 'rel-quarantine-1')
      await store.queueRelease(candidate2)
      await expect(store.transitionRelease(candidate2.id, 'quarantined')).rejects.toThrow(
        /Quarantined release requires health inbox reference/,
      )

      const quarantined = await store.transitionRelease(candidate2.id, 'quarantined', {
        healthEscalationId: 'escalation-1',
      })
      expect(quarantined.state).toBe('quarantined')

      // Quarantined is terminal
      await expect(store.transitionRelease(candidate2.id, 'deploying')).rejects.toThrow(
        /Illegal release lifecycle transition/,
      )

      await store.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reconciles in-flight operations after restart with success, and quarantines unreachable bridge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-store-reconcile-'))
    try {
      const store = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })
      const candidate = sampleCandidate('proj-1', 'rel-rec-1')
      await store.queueRelease(candidate)

      const intent = {
        schemaVersion: 1 as const,
        id: 'intent-1',
        projectId: 'proj-1',
        policyRevision: 1,
        environment: 'production',
        releaseId: candidate.id,
        operationId: 'op-rec-1',
        fencingToken: 1,
        commit: candidate.commit,
        artifactDigest: candidate.artifact.digest,
        protocolVersion: 1 as const,
        keyId: 'bridge-key',
        timestamp: new Date().toISOString(),
        operation: 'deployCanary' as const,
        expectedPriorDeployment: 'dep-0',
        policyDigest: candidate.policyDigest,
      }

      await store.recordOperationIntent(candidate.id, intent)
      await store.transitionRelease(candidate.id, 'deploying')
      await store.close()

      // Re-open store (simulating restart)
      const reopened = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })

      // Mock bridge that returns succeeded
      const mockBridgeSuccess = {
        async status(operationId: string) {
          return {
            schemaVersion: 1 as const,
            id: `status-${operationId}`,
            projectId: 'proj-1',
            policyRevision: 1,
            environment: 'production',
            releaseId: candidate.id,
            operationId,
            fencingToken: 1,
            commit: candidate.commit,
            artifactDigest: candidate.artifact.digest,
            protocolVersion: 1 as const,
            providerRevision: 1,
            status: 'succeeded' as const,
            deploymentId: 'dep-live-1',
            requestDigest: digestJson(intent),
            observedAt: new Date().toISOString(),
          }
        },
      }

      const result = await reopened.reconcileAfterRestart(mockBridgeSuccess)
      expect(result.reconciled).toBe(1)
      expect(result.activeReleaseId).toBe(candidate.id)

      const recovered = reopened.getRelease(candidate.id)
      expect(recovered?.operationReceipts).toHaveLength(1)
      expect(recovered?.operationReceipts[0]!.status).toBe('succeeded')

      await reopened.close()

      // Re-open again and test unreachable bridge triggers quarantine
      const reopened2 = await DarkFactoryReleaseStore.open({ directory, projectId: 'proj-1' })
      const candidate2 = sampleCandidate('proj-1', 'rel-rec-2')
      await reopened2.queueRelease(candidate2)
      const intent2 = { ...intent, id: 'intent-2', releaseId: candidate2.id, operationId: 'op-rec-2' }
      await reopened2.recordOperationIntent(candidate2.id, intent2)
      // Must first accept candidate 1 to free production environment
      await reopened2.transitionRelease(candidate.id, 'observing', {
        canaryStartedAt: new Date().toISOString(),
        canaryDeadline: new Date(Date.now() + 600_000).toISOString(),
        promotionDeadline: new Date(Date.now() + 1_200_000).toISOString(),
      })
      await reopened2.transitionRelease(candidate.id, 'accepted', { telemetryIds: ['tel-1'] })

      await reopened2.transitionRelease(candidate2.id, 'deploying')

      const mockBridgeFailure = {
        async status() {
          throw new Error('Bridge unreachable network timeout')
        },
      }

      const resultFailure = await reopened2.reconcileAfterRestart(mockBridgeFailure)
      expect(resultFailure.reconciled).toBe(1)
      const quarantined = reopened2.getRelease(candidate2.id)
      expect(quarantined?.state).toBe('quarantined')
      expect(quarantined?.healthEscalationId).toBeDefined()

      await reopened2.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
