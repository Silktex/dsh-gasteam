import { expect, it } from 'vitest'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalRuntimeStore } from '../src/external-runtime.ts'

it('syncs launch intent before a supervisor may create an OS process and preserves it across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-external-runtime-'))
  try {
    const store = await ExternalRuntimeStore.open(directory)
    const intent = await store.prepareLaunch({ attemptId: 'attempt-a', generation: 2, provider: 'codex-cli', runtimeIdentity: { provider: 'codex-cli', kind: 'new', attemptId: 'attempt-a', generation: 2, executable: '/opt/codex', version: '0.153.4', cwd: '/worktree', model: 'gpt-5.6-codex', sandbox: 'workspace-write' } }, 0)
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
