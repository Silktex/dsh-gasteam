import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processFixture } from './support/process-fixture.ts'
it('excludes a competing integration process and releases canonical ownership after SIGKILL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-integration-owner-'))
  const processes: ReturnType<typeof processFixture>[] = []
  try {
    const seed = processFixture('seed', directory)
    processes.push(seed)
    await seed.barrier()
    await seed.stop()
    processes.pop()
    const owner = processFixture('integration-owner', directory)
    processes.push(owner)
    expect(await owner.barrier()).toMatchObject({ acquired: true })
    const contender = processFixture('integration-owner', directory)
    processes.push(contender)
    expect(await contender.barrier()).toMatchObject({ acquired: false, error: expect.stringContaining('busy') })
    await contender.stop()
    processes.pop()
    await owner.stop(true)
    processes.pop()
    const successor = processFixture('integration-owner', directory)
    processes.push(successor)
    expect(await successor.barrier()).toMatchObject({ acquired: true })
  } finally {
    try { for (const process of processes.reverse()) await process.stop() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)
