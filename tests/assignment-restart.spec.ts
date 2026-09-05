import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttemptRecord } from '../packages/agent-team/src/assignments.ts'
import { processFixture } from './support/process-fixture.ts'

it('preserves one active assignment at a real worker progress barrier and releases the crashed process lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-worker-restart-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const first = processFixture('worker', directory)
    processes.push(first)
    const active = await first.barrier<{ barrier: string; record: AttemptRecord; pid: number }>()
    expect(active.barrier).toBe('worker-progress')
    expect(active.record.phase).toBe('active')
    const contender = processFixture('contender', directory)
    processes.push(contender)
    expect(await contender.barrier()).toEqual({ barrier: 'ownership', error: 'Durable journal is already owned by another instance' })
    await contender.stop()
    processes.pop()
    await first.stop(true)
    processes.pop()
    const restored = processFixture('worker-restore', directory)
    processes.push(restored)
    const result = await restored.barrier<{ barrier: string; records: AttemptRecord[]; liveAgents: number; durablePrompts: number; pid: number }>()
    expect(result.barrier).toBe('worker-restored')
    expect(result.pid).not.toBe(active.pid)
    expect(result.liveAgents).toBe(0)
    expect(result.records).toEqual([active.record])
    expect(result.durablePrompts).toBe(1)
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)
