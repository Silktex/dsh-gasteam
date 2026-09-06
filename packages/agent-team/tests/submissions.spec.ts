import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubmissionStore } from '../src/submissions.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-submissions-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = await SubmissionStore.open(directory)
  cleanup.push(() => store.close())
  const input = { projectId: 'project', teamId: 'team', taskId: 'task', runtimeId: 'runtime', attemptId: 'attempt-1', generation: 1, expectedRevision: 4,
    sourceCommit: 'a'.repeat(40), evidence: 'Committed output', repository: '/repo', targetBranch: 'main', verification: { revision: 2, commands: [{ command: 'node', args: ['test.js'] }] } }
  return { directory, store, input }
}
it('replays pending intent with immutable policy and the same integration identity', async () => {
  const { directory, store, input } = await fixture()
  const pending = await store.submit(input)
  await store.close()
  const restored = await SubmissionStore.open(directory)
  cleanup.push(() => restored.close())
  expect(await restored.submit(input)).toEqual(pending)
  expect(await restored.queued(pending.id)).toEqual({ ...pending, phase: 'queued' })
  expect(await restored.queued(pending.id)).toEqual({ ...pending, phase: 'queued' })
  expect(restored.list()).toHaveLength(1)
  for (const patch of [{ sourceCommit: 'b'.repeat(40) }, { evidence: 'Different' }, { verification: { ...input.verification, revision: 3 } }]) {
    await expect(restored.submit({ ...input, ...patch })).rejects.toThrow(/immutable inputs/)
  }
})
it('persists exact cross-team prerequisite identities with the submission intent', async () => {
  const { directory, store, input } = await fixture()
  const dependencies = [{ submissionId: 'prior-submission', projectId: 'other-project', teamId: 'other-team', taskId: 'other-task', sourceCommit: 'b'.repeat(40), state: 'accepted' as const }]
  const pending = await store.submit({ ...input, dependencies })
  await store.close()
  const restored = await SubmissionStore.open(directory)
  cleanup.push(() => restored.close())
  expect(restored.list()).toEqual([expect.objectContaining({ id: pending.id, dependencies })])
  await expect(restored.submit({ ...input, dependencies: [{ ...dependencies[0]!, taskId: 'different-task' }] })).rejects.toThrow(/immutable inputs/)
})
it('rejects a second writer and malformed source references', async () => {
  const { directory, store, input } = await fixture()
  await expect(SubmissionStore.open(directory)).rejects.toThrow(/already owned/)
  await expect(store.submit({ ...input, sourceCommit: 'HEAD' })).rejects.toThrow()
  expect(store.list()).toEqual([])
})
it('rejects corrupt replay rather than losing submission intent', async () => {
  const { directory, store, input } = await fixture()
  await store.submit(input)
  await store.close()
  await appendFile(join(directory, 'submissions.jsonl'), '{"version":1,"sequence":2,"type":"submission/queued","id":"missing"}\n')
  await expect(SubmissionStore.open(directory)).rejects.toThrow(/restore.*backup/)
})
