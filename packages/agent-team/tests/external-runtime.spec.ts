import { expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalRuntimeStore } from '../src/external-runtime.ts'

it('syncs launch intent before a supervisor may create an OS process and preserves it across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    const intent = await store.prepareLaunch({ attemptId: 'attempt-a', generation: 2, provider: 'codex-cli', runtimeIdentity: { provider: 'codex-cli', kind: 'new', attemptId: 'attempt-a', generation: 2, executable: '/opt/codex', version: '0.153.4', cwd: '/worktree', model: 'gpt-5.6-codex', sandbox: 'workspace-write' }, admission: { executable: '/opt/codex', configuredExecutable: '/configured/codex', version: '0.153.4', cwd: '/worktree', model: 'gpt-5.6-codex', sandbox: 'workspace-write', executableVerification: 'verified', authStatus: 'authenticated' }, inputSha256: 'a'.repeat(64), spool: { directory: '/spool/a', stdout: '/spool/a/out', stderr: '/spool/a/err', maxBytes: 100 }, supervision: { containment: 'pid-namespace', terminateGraceMs: 50 } }, 0)
    expect(intent.phase).toBe('launch-intent')
    await store.close()
    const restored = await ExternalRuntimeStore.open(directory)
    expect(restored.get('attempt-a', 2)).toMatchObject({ phase: 'launch-intent', provider: 'codex-cli' })
    await restored.recordProcessStarted('attempt-a', 2, { pid: 42, birthId: '123' }, 1)
    await restored.recordCancellation('attempt-a', 2, 'operator', 2)
    await restored.recordExit('attempt-a', 2, { code: 0, signal: null }, 3)
    expect(restored.get('attempt-a', 2)).toMatchObject({ phase: 'cancelling', retainsCapacity: true })
    await restored.recordGroupStopped('attempt-a', 2, { receiptId: 'stop-a', process: { pid: 42, birthId: '123' }, groupEmpty: true }, 4)
    expect(restored.get('attempt-a', 2)).toMatchObject({ phase: 'cancelled', terminal: { outcome: 'cancelled' }, retainsCapacity: false })
    await restored.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('accepts a report only after exact observed thread, result, completed turn, and positive terminal receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    await store.prepareLaunch({ attemptId: 'attempt-d', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new', attemptId: 'attempt-d', generation: 1 } }, 0)
    await store.recordProcessStarted('attempt-d', 1, { pid: 44, birthId: '125' }, 1)
    await store.recordThread('attempt-d', 1, 'thread-d', 2)
    await store.recordResult('attempt-d', 1, 'bounded fixture report', 3)
    await store.recordTurnCompleted('attempt-d', 1, 4)
    await store.recordExit('attempt-d', 1, { code: 0, signal: null }, 5)
    await store.recordGroupStopped('attempt-d', 1, { receiptId: 'stop-d', process: { pid: 44, birthId: '125' }, groupEmpty: true }, 6, true)
    expect(store.get('attempt-d', 1)).toMatchObject({ phase: 'completed', threadId: 'thread-d', result: 'bounded fixture report', retainsCapacity: false })
    await store.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('fences output received after cancellation and retains unknown ownership capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    await store.prepareLaunch({ attemptId: 'attempt-a', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new', attemptId: 'attempt-a', generation: 1 } })
    await store.recordOutput('attempt-a', 1, { type: 'message', text: 'before cancellation' })
    await store.recordCancellation('attempt-a', 1, 'operator')
    await store.recordOutput('attempt-a', 1, { type: 'message', text: 'late output' })
    expect(store.get('attempt-a', 1)).toMatchObject({ acceptedOutputCount: 1, fencedOutputCount: 1, phase: 'cancelling' })
    await store.markUncertain('attempt-a', 1, 'lifetime lock remains held')
    expect(store.get('attempt-a', 1)).toMatchObject({ phase: 'uncertain', retainsCapacity: true })
    await store.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('deduplicates the exact cancellation intent while a restarted observer retries delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    await store.prepareLaunch({ attemptId: 'attempt-cancel-replay', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new', attemptId: 'attempt-cancel-replay', generation: 1 } }, 0)
    await store.recordProcessStarted('attempt-cancel-replay', 1, { pid: 46, birthId: '127' }, 1)
    const [first, replay] = await Promise.all([
      store.recordCancellation('attempt-cancel-replay', 1, 'operator cancellation', 2),
      store.recordCancellation('attempt-cancel-replay', 1, 'operator cancellation', 3),
    ])
    expect(replay).toMatchObject({ revision: first.revision, cancellation: { reason: 'operator cancellation', requestedAt: 2 } })
    await expect(store.recordCancellation('attempt-cancel-replay', 1, 'changed cancellation reason', 4)).rejects.toThrow(/immutable/i)
    const journal = await readFile(join(directory, 'external-runtime.jsonl'), 'utf8')
    expect(journal.split('"type":"external/cancel"')).toHaveLength(2)
    await store.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('drains queued idempotent writes before close so a fresh observer sees one cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    await store.prepareLaunch({ attemptId: 'attempt-close-replay', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new', attemptId: 'attempt-close-replay', generation: 1 } }, 0)
    const pending = Promise.all([store.recordCancellation('attempt-close-replay', 1, 'operator', 1), store.recordCancellation('attempt-close-replay', 1, 'operator', 2)])
    await store.close(); await pending
    const restored = await ExternalRuntimeStore.open(directory)
    expect(restored.get('attempt-close-replay', 1)).toMatchObject({ cancellation: { reason: 'operator', requestedAt: 1 } })
    expect((await readFile(join(directory, 'external-runtime.jsonl'), 'utf8')).split('"type":"external/cancel"')).toHaveLength(2)
    await restored.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('persists an immutable provider usage receipt without estimating missing fields or cost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    await store.prepareLaunch({ attemptId: 'attempt-usage', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new', attemptId: 'attempt-usage', generation: 1 } }, 0)
    await expect(store.recordUsage('attempt-usage', 1, { inputTokens: 3 }, 1)).rejects.toThrow(/completed turn/i)
    await expect(store.recordUsage('attempt-usage', 1, { inputTokens: undefined }, 1)).rejects.toThrow(/at least one/i)
    await store.recordTurnCompleted('attempt-usage', 1, 1)
    const usage = await store.recordUsage('attempt-usage', 1, { inputTokens: 3, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 }, 1)
    expect(usage.usage).toEqual({ inputTokens: 3, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, runtimeRevision: usage.revision })
    await expect(store.recordUsage('attempt-usage', 1, { inputTokens: 4 }, 2)).rejects.toThrow(/immutable/i)
    await store.close()
    const restored = await ExternalRuntimeStore.open(directory)
    await expect(restored.recordUsage('attempt-usage', 1, { inputTokens: 3, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1 }, 2)).resolves.toMatchObject({ revision: usage.revision, usage: { runtimeRevision: usage.revision } })
    await restored.recordCancellation('attempt-usage', 1, 'operator cancellation', 3)
    await expect(restored.recordUsage('attempt-usage', 1, { inputTokens: 3 }, 4)).rejects.toThrow(/immutable/i)
    await restored.close()
    const cancelled = await ExternalRuntimeStore.open(directory)
    await cancelled.prepareLaunch({ attemptId: 'attempt-usage-cancelled', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new', attemptId: 'attempt-usage-cancelled', generation: 1 } }, 0)
    await cancelled.recordCancellation('attempt-usage-cancelled', 1, 'cancel before provider report', 1)
    await expect(cancelled.recordUsage('attempt-usage-cancelled', 1, { inputTokens: 3 }, 2)).rejects.toThrow(/fenced/i)
    await cancelled.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('does not treat a zero CLI leader exit or absent output as completion without a group-empty receipt and turn receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    await store.prepareLaunch({ attemptId: 'attempt-b', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new', attemptId: 'attempt-b', generation: 1 } }, 0)
    await store.recordProcessStarted('attempt-b', 1, { pid: 43, birthId: '124' }, 1)
    await store.recordExit('attempt-b', 1, { code: 0, signal: null }, 2)
    expect(store.get('attempt-b', 1)).toMatchObject({ phase: 'running', retainsCapacity: true, processExit: { code: 0 } })
    await store.recordGroupStopped('attempt-b', 1, { receiptId: 'stop-b', process: { pid: 43, birthId: '124' }, groupEmpty: true }, 3, false)
    expect(store.get('attempt-b', 1)).toMatchObject({ phase: 'failed', terminal: { outcome: 'failed' }, retainsCapacity: false })
    await store.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('replays exact durable exit and terminal receipts without regressing a completed attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    await store.prepareLaunch({ attemptId: 'attempt-replay', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new', attemptId: 'attempt-replay', generation: 1 } }, 0)
    await store.recordProcessStarted('attempt-replay', 1, { pid: 45, birthId: '126' }, 1)
    await store.recordThread('attempt-replay', 1, 'thread-replay', 2)
    await store.recordResult('attempt-replay', 1, 'replay result', 3)
    await store.recordTurnCompleted('attempt-replay', 1, 4)
    await store.recordExit('attempt-replay', 1, { code: 0, signal: null }, 5)
    const afterExit = store.get('attempt-replay', 1)!
    await expect(store.recordExit('attempt-replay', 1, { code: 0, signal: null }, 6)).resolves.toMatchObject({ revision: afterExit.revision })
    const receipt = { receiptId: 'stop-replay', process: { pid: 45, birthId: '126' }, groupEmpty: true as const }
    await store.recordGroupStopped('attempt-replay', 1, receipt, 7, true)
    const completed = store.get('attempt-replay', 1)!
    await expect(store.recordGroupStopped('attempt-replay', 1, receipt, 8, true)).resolves.toMatchObject({ phase: 'completed', revision: completed.revision })
    await store.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects malformed durable runtime events during replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    await store.close()
    await appendFile(join(directory, 'external-runtime.jsonl'), '{"version":1,"sequence":1,"type":"external/intent","intent":{"attemptId":"bad"}}\n')
    await expect(ExternalRuntimeStore.open(directory)).rejects.toThrow(/Invalid catalog|runtimeIdentity|provider/i)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps a launch spool binding immutable on replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    const launch = { attemptId: 'attempt-c', generation: 1, provider: 'fixture', runtimeIdentity: { provider: 'fixture', kind: 'new' as const, attemptId: 'attempt-c', generation: 1 }, spool: { directory: '/spool/a', stdout: '/spool/a/out', stderr: '/spool/a/err', maxBytes: 100 } }
    await store.prepareLaunch(launch, 0)
    await expect(store.prepareLaunch({ ...launch, spool: { ...launch.spool, maxBytes: 101 } }, 1)).rejects.toThrow(/immutable/i)
    await store.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
