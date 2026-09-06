import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceActivityReader } from '../src/workspace-activity.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function reader(): Promise<{ readonly directory: string; readonly activity: WorkspaceActivityReader }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-activity-')); directories.push(directory)
  return { directory, activity: new WorkspaceActivityReader(directory, 'workspace') }
}
const event = (sequence: number, type = 'project/created') => JSON.stringify({ version: 1, sequence, type })

describe('WorkspaceActivityReader', () => {
  it('returns exact durable references, binds cursors to the operator, and never redelivers a returned row', async () => {
    const { directory, activity } = await reader()
    await writeFile(join(directory, 'coordinator.jsonl'), `${event(1, 'coordinator/created')}\n${event(2, 'project/paused')}\n`)
    const first = await activity.page('operator-a', { limit: 1 })
    expect(first.items).toEqual([{ ref: { workspaceId: 'workspace', source: 'coordinator', sequence: 1 }, type: 'coordinator/created' }])
    const second = await activity.page('operator-a', { cursor: first.nextCursor, limit: 1 })
    expect(second.items).toEqual([{ ref: { workspaceId: 'workspace', source: 'coordinator', sequence: 2 }, type: 'project/paused' }])
    await expect(activity.page('operator-b', { cursor: first.nextCursor })).rejects.toThrow(/WORKSPACE_ACTIVITY_STALE/)
    await expect(activity.page('operator-a', { cursor: `${first.nextCursor}x` })).rejects.toThrow(/WORKSPACE_ACTIVITY_STALE/)
  })

  it('defers an incomplete trailing record without cursor advance, then delivers it when completed', async () => {
    const { directory, activity } = await reader()
    await writeFile(join(directory, 'coordinator.jsonl'), `${event(1)}\n${event(2)}`)
    const first = await activity.page('operator', { limit: 8 })
    expect(first.items.map(item => item.ref.sequence)).toEqual([1])
    const held = await activity.page('operator', { cursor: first.nextCursor, limit: 8 })
    expect(held.items).toEqual([])
    await appendFile(join(directory, 'coordinator.jsonl'), '\n')
    const complete = await activity.page('operator', { cursor: held.nextCursor, limit: 8 })
    expect(complete.items.map(item => item.ref.sequence)).toEqual([2])
  })

  it('surfaces complete corrupt rows and marks an initial tail as incomplete history', async () => {
    const { directory, activity } = await reader()
    await writeFile(join(directory, 'coordinator.jsonl'), `${'x'.repeat(70_000)}\n{not-json}\n`)
    await expect(activity.page('operator', {})).rejects.toThrow(/WORKSPACE_ACTIVITY_CORRUPT/)
    await writeFile(join(directory, 'coordinator.jsonl'), `${'x'.repeat(70_000)}\n${event(1)}\n`)
    const page = await activity.page('operator', {})
    expect(page.historyTruncated).toBe(true)
    expect(page.items.map(item => item.ref.sequence)).toEqual([1])
  })

  it('keeps cursor offsets in bytes across UTF-8 and streams a valid row beyond the tail size', async () => {
    const { directory, activity } = await reader()
    await writeFile(join(directory, 'coordinator.jsonl'), `${event(1, '项目/创建')}\n`)
    const first = await activity.page('operator', { limit: 1 })
    await appendFile(join(directory, 'coordinator.jsonl'), `${event(2, '继续')}\n`)
    const second = await activity.page('operator', { cursor: first.nextCursor, limit: 1 })
    expect(second.items).toEqual([expect.objectContaining({ ref: expect.objectContaining({ sequence: 2 }), type: '继续' })])
    const empty = await activity.page('operator', { cursor: second.nextCursor, limit: 1 })
    await appendFile(join(directory, 'coordinator.jsonl'), `${JSON.stringify({ version: 1, sequence: 3, type: 'large/checkpoint', diagnostic: '界'.repeat(40_000) })}\n`)
    const large = await activity.page('operator', { cursor: empty.nextCursor, limit: 1 })
    expect(large.items).toEqual([expect.objectContaining({ ref: expect.objectContaining({ sequence: 3 }), type: 'large/checkpoint' })])
  })

  it('initializes every source tail before a limited page and round-robins a hot source', async () => {
    const { directory, activity } = await reader()
    await writeFile(join(directory, 'coordinator.jsonl'), `${event(1)}\n${event(2)}\n`)
    await writeFile(join(directory, 'projects.jsonl'), `${JSON.stringify({ version: 1, sequence: 1, type: 'project/large', diagnostic: 'x'.repeat(70_000) })}\n${JSON.stringify({ version: 1, sequence: 2, type: 'project/new' })}\n`)
    const first = await activity.page('operator', { limit: 1 })
    expect(first.historyTruncated).toBe(true)
    const second = await activity.page('operator', { cursor: first.nextCursor, limit: 1 })
    expect(second.items).toEqual([expect.objectContaining({ ref: expect.objectContaining({ source: 'projects', sequence: 2 }) })])
    const third = await activity.page('operator', { cursor: second.nextCursor, limit: 1 })
    expect(third.items).toEqual([expect.objectContaining({ ref: expect.objectContaining({ source: 'coordinator', sequence: 2 }) })])
  })

  it('rejects a complete row beyond the bounded streaming limit instead of retrying it forever', async () => {
    const { directory, activity } = await reader()
    await writeFile(join(directory, 'coordinator.jsonl'), `${JSON.stringify({ version: 1, sequence: 1, type: 'large/checkpoint', diagnostic: 'x'.repeat(1_100_000) })}\n`)
    const initial = await activity.page('operator', {})
    // Initial tail intentionally skips old history. A subsequent appended large row
    // is a visible, recoverable error rather than an unchanged polling cursor.
    await appendFile(join(directory, 'coordinator.jsonl'), `${JSON.stringify({ version: 1, sequence: 2, type: 'large/checkpoint', diagnostic: 'x'.repeat(1_100_000) })}\n`)
    await expect(activity.page('operator', { cursor: initial.nextCursor })).rejects.toThrow(/WORKSPACE_ACTIVITY_ROW_TOO_LARGE/)
  })
})
