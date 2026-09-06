import { describe, expect, it } from 'vitest'
import { WorkspacePageSnapshotStore } from '../src/workspace-pagination.ts'
import type { WorkspaceDashboardView } from '../src/workspace-dashboard.ts'

const view = (ids: string[]): WorkspaceDashboardView => ({ projects: ids.map((id, index) => ({ id, revision: index, paused: false, capacity: 1, active: 0 })), projectsTruncated: false, attempts: [], attemptsTruncated: false, workflows: [], workflowsTruncated: false, batches: [], batchesTruncated: false, queue: [], queueTruncated: false, integrations: [], integrationsTruncated: false, escalations: [], escalationsTruncated: false })
describe('WorkspacePageSnapshotStore', () => {
  it('pins a page sequence through later live changes without skips or duplicates', () => {
    const store = new WorkspacePageSnapshotStore()
    const first = store.page('operator', { collection: 'projects', pageSize: 1 }, () => view(['one', 'two']))
    const second = store.page('operator', { collection: 'projects', pageSize: 1, cursor: first.nextCursor }, () => view(['new', 'one', 'two']))
    expect(first.items.map(item => item.id)).toEqual(['one'])
    expect(second.items.map(item => item.id)).toEqual(['two'])
  })
  it('rejects foreign and evicted continuations visibly', () => {
    const store = new WorkspacePageSnapshotStore({ snapshots: 1, rows: 8_192, bytes: 4 * 1024 * 1024 })
    const first = store.page('operator', { collection: 'projects', pageSize: 1 }, () => view(['one', 'two']))
    expect(() => store.page('other', { collection: 'projects', cursor: first.nextCursor }, () => view([]))).toThrow(/WORKSPACE_PAGE_STALE/)
    store.page('operator', { collection: 'projects' }, () => view(['three']))
    expect(() => store.page('operator', { collection: 'projects', cursor: first.nextCursor }, () => view([]))).toThrow(/WORKSPACE_PAGE_STALE/)
  })
  it('bounds only the requested collection, so another long collection cannot make it unavailable', () => {
    const store = new WorkspacePageSnapshotStore()
    const large = { ...view(Array.from({ length: 5_000 }, (_, index) => `p-${index}`)), attempts: Array.from({ length: 5_000 }, (_, index) => ({ attemptId: `a-${index}`, generation: 1, revision: 1, projectId: 'p-0', teamId: 'team', taskId: `t-${index}`, phase: 'active' as const })), attemptsTruncated: true }
    const page = store.page('operator', { collection: 'projects', pageSize: 1 }, () => large)
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeTruthy()
  })
  it('spills an over-budget requested collection and reaches its final row', async () => {
    const rows = new WorkspacePageSnapshotStore({ snapshots: 2, rows: 1, bytes: 1_000_000 })
    const first = rows.page('operator', { collection: 'projects', pageSize: 1 }, () => view(['one', 'two']))
    const last = rows.page('operator', { collection: 'projects', pageSize: 1, cursor: first.nextCursor }, () => view([]))
    expect(last.items.map(item => item.id)).toEqual(['two'])
    const bytes = new WorkspacePageSnapshotStore({ snapshots: 2, rows: 8_192, bytes: 16 })
    expect(bytes.page('operator', { collection: 'projects' }, () => view(['one'])).items).toHaveLength(1)
    await rows.close(); await bytes.close()
  })
})
