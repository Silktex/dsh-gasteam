import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CandidateRetentionStore } from '../src/candidate-retention.ts'
import { CoordinatorExecution } from '../src/coordinator-execution.ts'

const roots: string[] = []
afterEach(async () => await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), 'agent-team-retention-'))
  roots.push(root)
  return { root, store: await CandidateRetentionStore.open(root) }
}

const input = {
  submissionId: 'submission', integrationId: 'integration', repository: '/repository', targetBranch: 'main',
  cwd: '/candidate', candidateCommit: 'a'.repeat(40), eligibleAt: 100, deadline: 1_100, commandTimeoutMs: 30_000,
}

describe('candidate retention journal', () => {
  it('pins one deadline, persists running before cleanup, and conservatively settles an interrupted running intent', async () => {
    const { root, store } = await openStore()
    expect(await store.enqueue(input)).toMatchObject({ ...input, phase: 'queued' })
    expect(await store.enqueue({ ...input, deadline: 9_999 })).toMatchObject({ deadline: 1_100, phase: 'queued' })
    expect(await store.start('submission')).toMatchObject({ phase: 'running' })
    await store.close()

    const restored = await CandidateRetentionStore.open(root)
    expect(await restored.recoverInterrupted()).toEqual([expect.objectContaining({ phase: 'uncertain', diagnostic: expect.stringMatching(/interrupted/i) })])
    expect(restored.due(9_999)).toEqual([])
    await restored.close()
    expect(await readFile(join(root, 'candidate-retention.jsonl'), 'utf8')).toContain('retention/uncertain')
  })

  it('keeps retained outcomes terminal and makes released retries idempotent', async () => {
    const { store } = await openStore()
    await store.enqueue(input)
    await store.start('submission')
    expect(await store.settle('submission', 'retained', 'candidate is dirty')).toMatchObject({ phase: 'retained' })
    expect(store.due(9_999)).toEqual([])
    await store.close()
  })

  it('preserves a candidate as uncertain when a live Agent cwd aliases it through a symlink', async () => {
    const { root } = await openStore()
    const candidate = join(root, 'candidate')
    const alias = join(root, 'candidate-alias')
    await mkdir(candidate)
    await symlink(candidate, alias)
    const execution = Object.create(CoordinatorExecution.prototype) as {
      ctx: { agents: { list(): { session: { header: { cwd?: string } } }[] } }
      retention: { start(id: string): Promise<{ phase: 'running' }>; settle(id: string, phase: string, diagnostic: string): Promise<void> }
      cleanupCandidate(record: typeof input): Promise<void>
    }
    Object.defineProperty(execution, 'ctx', { value: { agents: { list: () => [{ session: { header: { cwd: alias } } }] } } })
    const outcomes: { id: string; phase: string; diagnostic: string }[] = []
    Object.defineProperty(execution, 'retention', { value: {
      start: async () => ({ phase: 'running' }),
      settle: async (id: string, phase: string, diagnostic: string) => { outcomes.push({ id, phase, diagnostic }) },
    } })
    await execution.cleanupCandidate({ ...input, cwd: candidate })
    expect(outcomes).toEqual([expect.objectContaining({ id: 'submission', phase: 'uncertain', diagnostic: expect.stringMatching(/current working directory/i) })])
  })
})
