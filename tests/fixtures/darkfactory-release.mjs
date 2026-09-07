/** Built SDK release lifecycle and crash recovery fixture. No DSH plugin mount, models, or external network. */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  DarkFactoryReleaseStore,
  digestJson,
  canonicalJson,
} from '../../packages/agent-team/lib/darkfactory.js'
import { HealthStore } from '../../packages/agent-team/lib/types/health.js'

const [mode, directory] = process.argv.slice(2)
if (!directory || !['seed', 'resume', 'replay'].includes(mode)) {
  throw new Error('Expected release lifecycle fixture mode and directory')
}

const baseTime = Date.parse('2026-09-06T12:01:00.000Z')
const now = baseTime + (mode === 'seed' ? 0 : 300_001)
const clock = () => new Date(now).toISOString()
const workspace = join(directory, 'workspace')

const send = message =>
  new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('Process IPC channel not open'))
    process.send(message, error => (error ? reject(error) : resolve()))
  })

let store,
  health,
  requests = 0,
  denied = false
const operations = []

function snapshot(barrier) {
  const storeSnapshot = store ? store.snapshot() : { releases: [], queue: [], revision: 0, head: null }
  return {
    barrier,
    pid: process.pid,
    requests,
    releases: storeSnapshot.releases,
    activeRelease: store ? store.getActiveRelease('production') : null,
    inbox: health ? health.listEscalations() : [],
    operations,
  }
}

try {
  health = await HealthStore.open(workspace, {
    dshDeadlineMs: 1000,
    externalDeadlineMs: 1000,
    escalationCooldownMs: 1000,
    maxEscalationsPerCondition: 2,
  })

  store = await DarkFactoryReleaseStore.open({
    directory: workspace,
    projectId: 'project',
    clock,
  })

  // Simulated deployment bridge transport adapter
  const mockBridge = {
    async deployCanary(request) {
      requests++
      operations.push({ operationId: request.operationId, operation: request.operation })
      if (mode === 'seed') {
        // Emit barrier at durable begin while blocked in transport
        await send(snapshot('fetch-blocked'))
        // Block indefinitely until SIGKILL or process termination
        return new Promise(() => {
          // Keep process alive awaiting SIGKILL
        })
      }
      return {
        schemaVersion: 1,
        id: `receipt-${request.operationId}`,
        projectId: request.projectId,
        policyRevision: request.policyRevision,
        environment: request.environment,
        releaseId: request.releaseId,
        operationId: request.operationId,
        fencingToken: request.fencingToken,
        commit: request.commit,
        artifactDigest: request.artifactDigest,
        protocolVersion: 1,
        providerRevision: 1,
        status: 'succeeded',
        deploymentId: 'dep-canary-001',
        requestDigest: digestJson(request),
        observedAt: clock(),
      }
    },
    async status(operationId) {
      requests++
      const requestIntent = {
        schemaVersion: 1,
        id: 'intent-deploy-1',
        projectId: 'project',
        policyRevision: 1,
        environment: 'production',
        releaseId: 'release-20260906-001',
        operationId,
        fencingToken: 1,
        commit: 'c'.repeat(40),
        artifactDigest: 'sha256:' + '3'.repeat(64),
        protocolVersion: 1,
        keyId: 'bridge-key-1',
        timestamp: new Date(baseTime).toISOString(),
        operation: 'deployCanary',
        expectedPriorDeployment: 'dep-baseline',
        policyDigest: 'sha256:' + '5'.repeat(64),
      }
      return {
        schemaVersion: 1,
        id: `receipt-${operationId}`,
        projectId: 'project',
        policyRevision: 1,
        environment: 'production',
        releaseId: 'release-20260906-001',
        operationId,
        fencingToken: 1,
        commit: 'c'.repeat(40),
        artifactDigest: 'sha256:' + '3'.repeat(64),
        protocolVersion: 1,
        providerRevision: 1,
        status: 'succeeded',
        deploymentId: 'dep-canary-001',
        requestDigest: digestJson(requestIntent),
        observedAt: clock(),
      }
    },
  }

  const candidate = {
    schemaVersion: 1,
    id: 'release-20260906-001',
    projectId: 'project',
    policyRevision: 1,
    repository: { provider: 'github', repositoryId: '42', canonicalName: 'deepseek/service' },
    environment: 'production',
    componentId: 'service',
    workflowId: 'release-flow',
    integrationReceiptId: 'integration-receipt-1',
    attemptIds: ['attempt-1'],
    specDigests: ['sha256:' + '1'.repeat(64)],
    evidenceHashes: ['sha256:' + '2'.repeat(64)],
    commit: 'c'.repeat(40),
    artifact: {
      projectId: 'project',
      id: 'artifact-canary',
      mediaType: 'application/octet-stream',
      sizeBytes: 1024,
      digest: 'sha256:' + '3'.repeat(64),
    },
    priorAcceptedReleaseId: 'release-baseline',
    priorArtifact: {
      projectId: 'project',
      id: 'artifact-baseline',
      mediaType: 'application/octet-stream',
      sizeBytes: 1024,
      digest: 'sha256:' + '4'.repeat(64),
    },
    policyDigest: 'sha256:' + '5'.repeat(64),
    policySnapshot: {
      projectId: 'project',
      id: 'artifact-policy',
      mediaType: 'application/json',
      sizeBytes: 512,
      digest: 'sha256:' + '6'.repeat(64),
    },
  }

  if (mode === 'seed') {
    // 1. Queue release
    await store.queueRelease(candidate)

    // 2. Transition to deploying with durable operation intent
    const intent = {
      schemaVersion: 1,
      id: 'intent-deploy-1',
      projectId: 'project',
      policyRevision: 1,
      environment: 'production',
      releaseId: candidate.id,
      operationId: 'op-deploy-1',
      fencingToken: 1,
      commit: candidate.commit,
      artifactDigest: candidate.artifact.digest,
      protocolVersion: 1,
      keyId: 'bridge-key-1',
      timestamp: clock(),
      operation: 'deployCanary',
      expectedPriorDeployment: 'dep-baseline',
      policyDigest: candidate.policyDigest,
    }

    await store.recordOperationIntent(candidate.id, intent)
    await store.transitionRelease(candidate.id, 'deploying')

    // 3. Dispatch to mock bridge (blocks in mode === 'seed')
    await mockBridge.deployCanary(intent)
  }

  process.on('message', async command => {
    try {
      if (command === 'stop') {
        await store.close()
        await health.close()
        process.disconnect()
      } else if (command === 'deny') {
        denied = true
        const active = store.getActiveRelease('production')
        if (!active) throw new Error('No active release to deny')

        // Transition release to rollback_queued
        await store.transitionRelease(active.id, 'rollback_queued', {
          fencingToken: active.fencingToken + 1,
          rollbackIntegrationId: 'rollback-int-001',
          diagnosticTaskId: 'diag-task-001',
          healthEscalationId: 'escalation-release-001',
        })

        // Raise and acknowledge health escalation
        await health.raiseFactoryEscalation(
          {
            schemaVersion: 1,
            projectId: 'project',
            policyRevision: 1,
            stage: 'release',
            reason: 'CANARY_TELEMETRY_ANOMALY',
            effectId: active.id,
            evidenceRefs: ['telemetry-verdict-breach-001'],
            severity: 'warning',
            diagnostics: 'Canary error rate exceeded dual-branch threshold',
          },
          now,
        )

        for (const incident of health.listEscalations()) {
          await health.acknowledge(incident.id, incident.revision, 'fixture-lead', now)
        }

        await send(snapshot('denied'))
      } else {
        throw new Error(`Unknown fixture command: ${command}`)
      }
    } catch (error) {
      await send({ barrier: 'error', message: String(error) })
      process.exitCode = 1
      process.disconnect()
    }
  })

  if (mode === 'resume') {
    // Reconcile pending in-flight operation from journal
    await store.reconcileAfterRestart(mockBridge)
    // Advance to observing state with deadlines
    const active = store.getActiveRelease('production')
    if (active && active.state === 'deploying') {
      await store.transitionRelease(active.id, 'observing', {
        fencingToken: active.fencingToken + 1,
        canaryStartedAt: clock(),
        canaryDeadline: new Date(now + 900_000).toISOString(),
        promotionDeadline: new Date(now + 1_800_000).toISOString(),
      })
    }
    await send(snapshot('recovered'))
  } else if (mode === 'replay') {
    // Replay mode asserts 0 transport requests executed
    await send(snapshot('replayed'))
  }
} catch (error) {
  await send({ barrier: 'error', message: String(error) })
  await store?.close()
  await health?.close()
  process.exitCode = 1
  process.disconnect()
}
