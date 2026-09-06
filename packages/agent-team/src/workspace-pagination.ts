import { rm } from 'node:fs/promises'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { projectWorkspaceDashboardSnapshot, workspaceDashboardCollectionSchema, workspaceDashboardPageRequestSchema, workspaceDashboardPageSchema, type WorkspaceDashboardCollection, type WorkspaceDashboardPage, type WorkspaceDashboardPageRequest, type WorkspaceDashboardView } from './workspace-dashboard.ts'

const MAX_SNAPSHOTS = 32
const MAX_ROWS = 8_192
const MAX_BYTES = 4 * 1024 * 1024
type PageValues = WorkspaceDashboardView[WorkspaceDashboardCollection]
type Snapshot = { readonly id: string; readonly callerId: string; readonly revision: string; readonly collection: WorkspaceDashboardCollection; readonly values?: PageValues; readonly directory?: string; readonly truncated: boolean; readonly rows: number; readonly bytes: number }
type Cursor = { readonly snapshotId: string; readonly collection: WorkspaceDashboardCollection; readonly snapshotRevision: string; readonly offset: number }
export class WorkspacePageSnapshotStore {
  private readonly key = randomBytes(32)
  private readonly snapshots = new Map<string, Snapshot>()
  private closing: Promise<void> | undefined
  private rows = 0
  private bytes = 0
  constructor(private readonly limits = { snapshots: MAX_SNAPSHOTS, rows: MAX_ROWS, bytes: MAX_BYTES }) {}
  capture(callerId: string, collection: WorkspaceDashboardCollection, view: WorkspaceDashboardView): Snapshot {
    if (this.closing !== undefined) throw new Error('Workspace page store is closed')
    const values = view[collection]
    const json = JSON.stringify(values)
    const bytes = Buffer.byteLength(json)
    const rows = values.length
    const revision = createHash('sha256').update(json).digest('hex')
    const retainedInMemory = rows <= this.limits.rows && bytes <= this.limits.bytes
    const snapshot: Snapshot = retainedInMemory
      ? { id: randomUUID(), callerId, revision, collection, values: structuredClone(values), truncated: view[`${collection}Truncated` as keyof WorkspaceDashboardView] as boolean, rows, bytes }
      : { id: randomUUID(), callerId, revision, collection, directory: this.writeSnapshot(values), truncated: view[`${collection}Truncated` as keyof WorkspaceDashboardView] as boolean, rows, bytes }
    this.snapshots.set(snapshot.id, snapshot); if (retainedInMemory) { this.rows += rows; this.bytes += bytes }
    this.evict(); return snapshot
  }
  page(callerId: string, request: WorkspaceDashboardPageRequest, create: () => unknown): WorkspaceDashboardPage {
    const parsed = workspaceDashboardPageRequestSchema.parse(request)
    let snapshot: Snapshot
    let offset = 0
    if (parsed.cursor === undefined) snapshot = this.capture(callerId, parsed.collection, projectWorkspaceDashboardSnapshot(create()))
    else {
      const cursor = this.decode(parsed.cursor)
      if (cursor.collection !== parsed.collection) throw new Error('WORKSPACE_PAGE_STALE: cursor collection does not match')
      snapshot = this.snapshots.get(cursor.snapshotId)!
      if (!snapshot || snapshot.callerId !== callerId || snapshot.collection !== parsed.collection || snapshot.revision !== cursor.snapshotRevision) throw new Error('WORKSPACE_PAGE_STALE: snapshot is unavailable; restart collection')
      this.snapshots.delete(snapshot.id); this.snapshots.set(snapshot.id, snapshot)
      offset = cursor.offset
    }
    const pageSize = parsed.pageSize ?? 64
    if (offset > snapshot.rows) throw new Error('WORKSPACE_PAGE_STALE: cursor offset is invalid; restart collection')
    const items = snapshot.values === undefined ? this.readPage(snapshot.directory!, offset, Math.min(pageSize, snapshot.rows - offset)) : snapshot.values.slice(offset, offset + pageSize)
    const next = offset + pageSize < snapshot.rows ? this.encode({ snapshotId: snapshot.id, collection: parsed.collection, snapshotRevision: snapshot.revision, offset: offset + pageSize }) : undefined
    return workspaceDashboardPageSchema.parse({ collection: parsed.collection, snapshotRevision: snapshot.revision, items, ...(next === undefined ? {} : { nextCursor: next }), truncated: snapshot.truncated })
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      for (const snapshot of this.snapshots.values()) {
        if (snapshot.directory !== undefined) await rm(snapshot.directory, { recursive: true, force: true })
      }
      this.snapshots.clear(); this.rows = 0; this.bytes = 0
    })()
  }
  private evict(): void { while (this.snapshots.size > this.limits.snapshots || this.rows > this.limits.rows || this.bytes > this.limits.bytes) { const first = this.snapshots.values().next().value as Snapshot | undefined; if (!first) return; this.snapshots.delete(first.id); if (first.values !== undefined) { this.rows -= first.rows; this.bytes -= first.bytes } if (first.directory !== undefined) rmSync(first.directory, { recursive: true, force: true }) } }
  private writeSnapshot(values: PageValues): string {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-workspace-page-'))
    try {
      for (let offset = 0; offset < values.length; offset += 256) writeFileSync(join(directory, `${offset}.json`), JSON.stringify(values.slice(offset, offset + 256)), { mode: 0o600 })
      return directory
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }
  private readPage(directory: string, offset: number, pageSize: number): PageValues { const start = Math.floor(offset / 256) * 256; const local = offset - start; const first = JSON.parse(readFileSync(join(directory, `${start}.json`), 'utf8')) as PageValues; const needed = local + pageSize; if (needed <= first.length) return first.slice(local, needed) as PageValues; const second = JSON.parse(readFileSync(join(directory, `${start + 256}.json`), 'utf8')) as PageValues; return [...first.slice(local), ...second.slice(0, needed - first.length)] as PageValues }
  private encode(value: Cursor): string { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}` }
  private decode(raw: string): Cursor { const [payload, signature, ...rest] = raw.split('.'); if (!payload || !signature || rest.length || createHmac('sha256', this.key).update(payload).digest('base64url') !== signature) throw new Error('WORKSPACE_PAGE_STALE: cursor is invalid; restart collection'); try { return cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))) } catch { throw new Error('WORKSPACE_PAGE_STALE: cursor is invalid; restart collection') } }
}
const cursorSchema = workspaceDashboardPageRequestSchema.pick({ collection: true }).extend({ snapshotId: z.string().uuid(), snapshotRevision: z.string().regex(/^[0-9a-f]{64}$/), offset: z.number().int().min(0) }).strict()
