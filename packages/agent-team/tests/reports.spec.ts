import { afterEach, expect, it } from 'vitest'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReportStore } from '../src/reports.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-reports-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = await ReportStore.open(directory)
  cleanup.push(() => store.close())
  const input = { projectId: 'project', teamId: 'team', taskId: 'task', attemptId: 'attempt-1', generation: 1, expectedRevision: 4,
    expectedTaskRevision: 7, report: 'Observed evidence', criteria: 'State evidence', reviewerId: 'lead', rationale: 'Evidence satisfies the criteria.' }
  return { directory, store, input }
}

it('replays immutable report-review intent and acknowledges it once', async () => {
  const { directory, store, input } = await fixture()
  const pending = await store.record(input)
  await store.close()
  const restored = await ReportStore.open(directory)
  cleanup.push(() => restored.close())
  expect(await restored.record(input)).toEqual(pending)
  expect(await restored.accepted(pending.id)).toEqual({ ...pending, phase: 'accepted' })
  expect(await restored.accepted(pending.id)).toEqual({ ...pending, phase: 'accepted' })
  for (const patch of [{ report: 'Different report' }, { criteria: 'Different criteria' }, { rationale: 'Different rationale' }, { expectedTaskRevision: 8 }]) {
    await expect(restored.record({ ...input, ...patch })).rejects.toThrow(/immutable inputs/)
  }
})

it('rejects a second writer and malformed report replay', async () => {
  const { directory, store, input } = await fixture()
  await expect(ReportStore.open(directory)).rejects.toThrow(/already owned/)
  await expect(store.record({ ...input, rationale: '' })).rejects.toThrow()
  await store.record(input)
  await store.close()
  await appendFile(join(directory, 'reports.jsonl'), '{"version":1,"sequence":2,"type":"report/accepted","id":"missing"}\n')
  await expect(ReportStore.open(directory)).rejects.toThrow(/restore.*backup/)
})
