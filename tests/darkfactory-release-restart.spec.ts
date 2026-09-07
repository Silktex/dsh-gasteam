import { fork } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  assertReleaseTransition,
  type ReleaseRecordV1,
} from '../packages/agent-team/src/darkfactory/contracts/release.ts'
import {
  DarkFactoryReleaseStore,
  ReleaseQueueError,
} from '../packages/agent-team/src/darkfactory/release-store.ts'
import type { OperatorEscalation } from '../packages/agent-team/src/health.ts'

interface Snapshot {
  barrier: 'fetch-blocked' | 'recovered' | 'denied' | 'replayed' | 'error'
  pid: number
  requests: number
  releases: ReleaseRecordV1[]
  activeRelease: ReleaseRecordV1 | null
  inbox: OperatorEscalation[]
  operations: { operationId: string; operation: string }[]
  message?: string
}

function launch(mode: 'seed' | 'resume' | 'replay', directory: string) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/darkfactory-release.mjs', import.meta.url)),
    [mode, directory],
    {
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR ?? '/var/tmp',
        HOME: directory,
      },
    },
  )

  const messages: unknown[] = []
  let diagnostics = '',
    ended = false,
    failure: Error | undefined,
    wake: (() => void) | undefined

  child.stdout!.on('data', bytes => {
    diagnostics = (diagnostics + String(bytes)).slice(-65_536)
  })
  child.stderr!.on('data', bytes => {
    diagnostics = (diagnostics + String(bytes)).slice(-65_536)
  })
  child.on('message', value => {
    messages.push(value)
    wake?.()
  })
  child.on('error', error => {
    failure = error
    wake?.()
  })

  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.on('close', (code, signal) => {
      ended = true
      wake?.()
      resolve({ code, signal })
    })
  })

  return {
    async barrier(): Promise<Snapshot> {
      const timeout = setTimeout(() => {
        failure = new Error('Release IPC barrier deadline exceeded')
        wake?.()
      }, 10_000)
      try {
        while (!messages.length) {
          if (failure || ended) {
            throw new Error(`${failure?.message ?? 'Fixture exited'}\n${diagnostics}`)
          }
          await new Promise<void>(resolve => {
            wake = resolve
          })
        }
        const value = messages.shift() as Snapshot
        if (value.barrier === 'error') {
          throw new Error(value.message ?? 'Unknown fixture barrier error')
        }
        return value
      } finally {
        clearTimeout(timeout)
        wake = undefined
      }
    },
    async send(command: 'stop' | 'deny') {
      await new Promise<void>((resolve, reject) => {
        child.send(command, error => (error ? reject(error) : resolve()))
      })
    },
    async stop(crash = false) {
      if (!ended) {
        if (crash) child.kill('SIGKILL')
        else if (child.connected) child.send('stop')
      }
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        const result = await closed
        if (crash ? result.signal !== 'SIGKILL' : result.code !== 0) {
          throw new Error(`Unexpected fixture exit ${JSON.stringify(result)}\n${diagnostics}`)
        }
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

it(
  'recovers release lifecycle after SIGKILL during active deployment at durable intent, preserving token fencing and zero data loss',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'factory-release-restart-'))
    const processes: ReturnType<typeof launch>[] = []

    try {
      await mkdir(join(directory, 'workspace'))

      // 1. Launch in 'seed' mode: queues release and begins deployment
      const initial = launch('seed', directory)
      processes.push(initial)
      const begun = await initial.barrier()

      expect(begun).toMatchObject({
        barrier: 'fetch-blocked',
        requests: 1,
        activeRelease: {
          id: 'release-20260906-001',
          environment: 'production',
          state: 'deploying',
          fencingToken: 1,
          operationIntents: [
            {
              operation: 'deployCanary',
              operationId: 'op-deploy-1',
              fencingToken: 1,
            },
          ],
          operationReceipts: [],
        },
        inbox: [],
      })

      // Verify durable journal on disk before crash
      const journalPath = join(directory, 'workspace/darkfactory/project/release.jsonl')
      const syncedJournal = await readFile(journalPath, 'utf8')
      expect(syncedJournal.length).toBeGreaterThan(0)
      const lastLine = JSON.parse(syncedJournal.trimEnd().split('\n').at(-1)!)
      expect(lastLine.type).toMatch(/release-transitioned|release-operation-intent/)

      // 2. Terminate subprocess abruptly with SIGKILL at durable intent barrier
      await initial.stop(true)
      processes.pop()

      // 3. Restart subprocess in 'resume' mode
      const resumed = launch('resume', directory)
      processes.push(resumed)
      const recovered = await resumed.barrier()

      // Assert process isolation & PID change
      expect(recovered.pid).not.toBe(begun.pid)

      // Assert zero data loss & full identity preservation
      expect(recovered.activeRelease).toMatchObject({
        id: begun.activeRelease!.id,
        environment: 'production',
        commit: begun.activeRelease!.commit,
        artifact: begun.activeRelease!.artifact,
        priorAcceptedReleaseId: begun.activeRelease!.priorAcceptedReleaseId,
        policyDigest: begun.activeRelease!.policyDigest,
        state: 'observing',
      })

      // Assert token fencing monotonically advanced
      expect(recovered.activeRelease!.fencingToken).toBeGreaterThan(
        begun.activeRelease!.fencingToken,
      )
      expect(recovered.activeRelease!.revision).toBeGreaterThan(begun.activeRelease!.revision)

      // Assert in-flight operation resolved with exactly one receipt
      expect(recovered.activeRelease!.operationIntents).toHaveLength(1)
      expect(recovered.activeRelease!.operationReceipts).toHaveLength(1)
      expect(recovered.activeRelease!.operationReceipts[0]).toMatchObject({
        operationId: 'op-deploy-1',
        status: 'succeeded',
        deploymentId: 'dep-canary-001',
      })

      // Assert observation deadlines populated
      expect(recovered.activeRelease!.canaryStartedAt).toBeDefined()
      expect(recovered.activeRelease!.canaryDeadline).toBeDefined()
      expect(recovered.activeRelease!.promotionDeadline).toBeDefined()

      // Assert no duplicate records in store & append-only journal integrity
      expect(recovered.releases).toHaveLength(1)
      const currentJournal = await readFile(journalPath, 'utf8')
      expect(currentJournal.startsWith(syncedJournal)).toBe(true)

      // 4. Send operator deny command (simulating canary telemetry anomaly / revocation)
      await resumed.send('deny')
      const denied = await resumed.barrier()

      expect(denied.barrier).toBe('denied')
      expect(denied.activeRelease).toMatchObject({
        id: 'release-20260906-001',
        state: 'rollback_queued',
        rollbackIntegrationId: 'rollback-int-001',
        diagnosticTaskId: 'diag-task-001',
        healthEscalationId: 'escalation-release-001',
      })

      // Assert health escalation raised in operator inbox under stage 'release'
      expect(denied.inbox).toHaveLength(1)
      expect(denied.inbox[0]).toMatchObject({
        source: 'darkfactory',
        stage: 'release',
        reason: 'CANARY_TELEMETRY_ANOMALY',
        acknowledgement: { actor: 'fixture-lead' },
      })

      // Clean shutdown of resumed process
      await resumed.stop(false)
      processes.pop()

      // 5. Replay from durable storage without making new provider requests
      const replay = launch('replay', directory)
      processes.push(replay)
      const replayed = await replay.barrier()

      expect(replayed.barrier).toBe('replayed')
      expect(replayed.requests).toBe(0) // Zero external transport or provider calls
      expect(replayed.releases).toEqual(denied.releases)
      expect(replayed.inbox).toEqual(denied.inbox)

      await replay.stop(false)
      processes.pop()
    } finally {
      try {
        for (const child of processes.reverse()) await child.stop(true)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  },
  30_000,
)

it('enforces monotonic token fencing and rejects stale revisions or retrofitted inputs', () => {
  const base: ReleaseRecordV1 = {
    schemaVersion: 1,
    id: 'release-fence-test',
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
    state: 'queued',
    revision: 1,
    fencingToken: 5,
    operationIntents: [],
    operationReceipts: [],
    telemetryIds: [],
  }

  // 1. Stale revision must throw
  expect(() => {
    assertReleaseTransition(base, { ...base, revision: 1 })
  }).toThrow('Stale release revision or fencing token')

  // 2. Decreased fencing token must throw
  expect(() => {
    assertReleaseTransition(base, { ...base, revision: 2, fencingToken: 4, state: 'deploying' })
  }).toThrow('Stale release revision or fencing token')

  // 3. Mutated immutable commit SHA must throw
  expect(() => {
    assertReleaseTransition(base, {
      ...base,
      revision: 2,
      fencingToken: 5,
      state: 'deploying',
      commit: 'd'.repeat(40),
    })
  }).toThrow('Release identity and pinned inputs are immutable')

  // 4. Illegal state jump (queued -> accepted) must throw
  expect(() => {
    assertReleaseTransition(base, {
      ...base,
      revision: 2,
      fencingToken: 5,
      state: 'accepted',
      canaryStartedAt: '2026-09-06T12:00:00.000Z',
      canaryDeadline: '2026-09-06T12:15:00.000Z',
      promotionDeadline: '2026-09-06T12:30:00.000Z',
      telemetryIds: ['tel-1'],
    })
  }).toThrow('Illegal release lifecycle transition')

  // 5. Valid transition passes
  expect(() => {
    assertReleaseTransition(base, { ...base, revision: 2, fencingToken: 5, state: 'deploying' })
  }).not.toThrow()
})

it('enforces single-environment FIFO queue and emits signed completion receipt only on accepted release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-release-fifo-'))
  try {
    const store = await DarkFactoryReleaseStore.open({
      directory,
      projectId: 'project',
    })

    const candidate1 = {
      schemaVersion: 1 as const,
      id: 'rel-fifo-001',
      projectId: 'project',
      policyRevision: 1,
      repository: { provider: 'github', repositoryId: '42', canonicalName: 'deepseek/service' },
      environment: 'production',
      componentId: 'service',
      workflowId: 'flow-1',
      integrationReceiptId: 'receipt-1',
      attemptIds: ['attempt-1'],
      specDigests: ['sha256:' + '1'.repeat(64)],
      evidenceHashes: ['sha256:' + '2'.repeat(64)],
      commit: 'a'.repeat(40),
      artifact: {
        projectId: 'project',
        id: 'artifact-1',
        mediaType: 'application/octet-stream',
        sizeBytes: 1024,
        digest: 'sha256:' + '3'.repeat(64),
      },
      priorAcceptedReleaseId: 'baseline-0',
      priorArtifact: {
        projectId: 'project',
        id: 'artifact-0',
        mediaType: 'application/octet-stream',
        sizeBytes: 1024,
        digest: 'sha256:' + '0'.repeat(64),
      },
      policyDigest: 'sha256:' + '5'.repeat(64),
      policySnapshot: {
        projectId: 'project',
        id: 'policy-1',
        mediaType: 'application/json',
        sizeBytes: 512,
        digest: 'sha256:' + '6'.repeat(64),
      },
    }

    const candidate2 = {
      ...candidate1,
      id: 'rel-fifo-002',
      integrationReceiptId: 'receipt-2',
      commit: 'b'.repeat(40),
      artifact: {
        ...candidate1.artifact,
        id: 'artifact-2',
        digest: 'sha256:' + '7'.repeat(64),
      },
    }

    const candidateStaging = {
      ...candidate1,
      id: 'rel-staging-001',
      environment: 'staging',
      integrationReceiptId: 'receipt-staging',
    }

    // 1. Queue both candidates for production
    await store.queueRelease(candidate1)
    await store.queueRelease(candidate2)

    // 2. Queue staging candidate
    await store.queueRelease(candidateStaging)

    // 3. Transition candidate 1 to deploying in production
    await store.transitionRelease(candidate1.id, 'deploying')
    expect(store.getActiveRelease('production')?.id).toBe(candidate1.id)

    // 4. Transition candidate 2 to deploying while candidate 1 is active -> throws ReleaseQueueError
    await expect(store.transitionRelease(candidate2.id, 'deploying')).rejects.toThrow(
      ReleaseQueueError,
    )

    // 5. Transition candidateStaging to deploying in staging -> succeeds (independent environments)
    await store.transitionRelease(candidateStaging.id, 'deploying')
    expect(store.getActiveRelease('staging')?.id).toBe(candidateStaging.id)

    // 6. Calling emitCompletionReceipt on deploying or observing release throws
    await expect(store.emitCompletionReceipt(candidate1.id)).rejects.toThrow(
      /canary-accepted completion receipt requires state: 'accepted'/,
    )

    const now = new Date().toISOString()
    const canaryDeadline = new Date(Date.now() + 600_000).toISOString()
    const promotionDeadline = new Date(Date.now() + 1_200_000).toISOString()

    await store.transitionRelease(candidate1.id, 'observing', {
      canaryStartedAt: now,
      canaryDeadline,
      promotionDeadline,
    })

    await expect(store.emitCompletionReceipt(candidate1.id)).rejects.toThrow(
      /canary-accepted completion receipt requires state: 'accepted'/,
    )

    // 7. Transition candidate 1 to accepted with telemetryIds
    await store.transitionRelease(candidate1.id, 'accepted', {
      telemetryIds: ['verdict-healthy-001'],
    })

    // 8. Now production environment has NO active release
    expect(store.getActiveRelease('production')).toBeNull()

    // 9. Emit completion receipt on accepted release
    const receiptResult = await store.emitCompletionReceipt(candidate1.id)
    expect(receiptResult.receiptId).toMatch(/^df-receipt-canary-[a-f0-9]{32}$/)
    expect(receiptResult.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/)
    expect(receiptResult.receipt.kind).toBe('canary-accepted')
    expect(receiptResult.receipt.releaseId).toBe(candidate1.id)

    // 10. Now candidate 2 can be deployed in production
    await store.transitionRelease(candidate2.id, 'deploying')
    expect(store.getActiveRelease('production')?.id).toBe(candidate2.id)

    await store.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
