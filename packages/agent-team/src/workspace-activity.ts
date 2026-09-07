/** Bounded, operator-scoped cursors over the coordinator's owned JSONL journals. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const MAX_LIMIT = 128
const TAIL_BYTES = 64 * 1024
const CHUNK_BYTES = 64 * 1024
const MAX_ROW_BYTES = 1024 * 1024
const MAX_SOURCE_BYTES = 512 * 1024
const MAX_DATE_MS = 8_640_000_000_000_000
// Fixed top-level coordinator journals only. Dynamic per-batch journals require a
// separately authorized registry expansion; cursor data never supplies a path.
const sourceNames = ['coordinator', 'projects', 'assignments', 'dispatch', 'submissions', 'reports', 'health', 'health-recovery', 'workflows', 'workflow-runtime', 'coordinator-batches', 'merge-batch-registry', 'execution', 'candidate-retention', 'external-runtime'] as const
export type WorkspaceActivitySource = typeof sourceNames[number]
const sources = Object.fromEntries([
  ['coordinator', 'coordinator.jsonl'], ['projects', 'projects.jsonl'], ['assignments', 'assignments.jsonl'], ['dispatch', 'dispatch.jsonl'], ['submissions', 'submissions.jsonl'], ['reports', 'reports.jsonl'], ['health', 'health.jsonl'], ['health-recovery', 'health-recovery.jsonl'], ['workflows', 'workflows.jsonl'], ['workflow-runtime', 'workflow-runtime.jsonl'], ['coordinator-batches', 'coordinator-batches.jsonl'], ['merge-batch-registry', 'merge-batches.jsonl'], ['execution', 'execution.jsonl'], ['candidate-retention', 'candidate-retention.jsonl'], ['external-runtime', 'external-runtime.jsonl'],
]) as Record<WorkspaceActivitySource, string>

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const sourceSchema = z.enum(sourceNames)
const offsetSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const cursorSchema = z.object({ workspaceId: id, callerId: id, offsets: z.record(sourceSchema, offsetSchema), skipPrefixes: z.record(sourceSchema, z.boolean()), nextSource: z.number().int().min(0).max(sourceNames.length - 1) }).strict()
const activityItemSchema = z.object({
  ref: z.object({ workspaceId: id, source: sourceSchema, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  type: z.string().min(1).max(256), timestampMs: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
  projectId: id.optional(), teamId: id.optional(), taskId: id.optional(), attemptId: id.optional(), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()
export type WorkspaceActivityItem = z.output<typeof activityItemSchema>
export const workspaceActivityRequestSchema = z.object({ cursor: z.string().min(1).max(8_192).optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional() }).strict()
export type WorkspaceActivityRequest = z.output<typeof workspaceActivityRequestSchema>
export const workspaceActivityPageSchema = z.object({ items: z.array(activityItemSchema).max(MAX_LIMIT), nextCursor: z.string().min(1).max(8_192), historyTruncated: z.boolean(), ordering: z.literal('per-source-sequence') }).strict()
export type WorkspaceActivityPage = z.output<typeof workspaceActivityPageSchema>
type Cursor = z.output<typeof cursorSchema>
type Context = Pick<WorkspaceActivityItem, 'projectId' | 'teamId' | 'taskId' | 'attemptId' | 'generation'>

/** Does not retain journal rows. Cursors contain byte offsets only and are MAC-bound to the configured workspace and operator. */
export class WorkspaceActivityReader {
  private readonly key = randomBytes(32)
  private closing: Promise<void> | undefined
  constructor(private readonly directory: string, private readonly workspaceId: string) {}
  async page(callerId: string, request: WorkspaceActivityRequest): Promise<WorkspaceActivityPage> {
    if (this.closing !== undefined) throw new Error('Workspace activity reader is closed')
    const parsed = workspaceActivityRequestSchema.parse(request)
    const initial = parsed.cursor === undefined
    const cursor = initial ? this.initialCursor(callerId) : this.decode(parsed.cursor!)
    if (cursor.workspaceId !== this.workspaceId || cursor.callerId !== callerId) throw new Error('WORKSPACE_ACTIVITY_STALE: cursor is not owned by this operator workspace')
    const offsets = { ...cursor.offsets }, skipPrefixes = { ...cursor.skipPrefixes }
    let historyTruncated = false
    if (initial) for (const source of sourceNames) {
      const filename = join(this.directory, sources[source])
      let size: number
      try { size = (await stat(filename)).size } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (size > TAIL_BYTES) { offsets[source] = size - TAIL_BYTES; skipPrefixes[source] = true; historyTruncated = true }
    }
    const limit = parsed.limit ?? 64
    const items: WorkspaceActivityItem[] = []
    let nextSource = cursor.nextSource
    for (let count = 0; count < sourceNames.length && items.length < limit; count++) {
      const index = (cursor.nextSource + count) % sourceNames.length
      const source = sourceNames[index]!
      const filename = join(this.directory, sources[source])
      let size: number
      try { size = (await stat(filename)).size } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { nextSource = (index + 1) % sourceNames.length; continue }; throw error }
      if (offsets[source] > size) throw new Error('WORKSPACE_ACTIVITY_STALE: journal was replaced; restart activity')
      const rows = await this.readCompleteRows(filename, offsets[source], skipPrefixes[source], source, limit - items.length)
      offsets[source] = rows.offset; skipPrefixes[source] = rows.skipPrefix
      items.push(...rows.items); nextSource = (index + 1) % sourceNames.length
    }
    return workspaceActivityPageSchema.parse({ items, nextCursor: this.encode({ workspaceId: this.workspaceId, callerId, offsets, skipPrefixes, nextSource }), historyTruncated, ordering: 'per-source-sequence' })
  }
  close(): Promise<void> { return this.closing ??= Promise.resolve() }
  private initialCursor(callerId: string): Cursor { return { workspaceId: this.workspaceId, callerId, offsets: Object.fromEntries(sourceNames.map(source => [source, 0])) as Cursor['offsets'], skipPrefixes: Object.fromEntries(sourceNames.map(source => [source, false])) as Cursor['skipPrefixes'], nextSource: 0 } }
  private async readCompleteRows(filename: string, offset: number, skipPrefix: boolean, source: WorkspaceActivitySource, limit: number): Promise<{ items: WorkspaceActivityItem[]; offset: number; skipPrefix: boolean }> {
    if (limit === 0) return { items: [], offset, skipPrefix }
    const file = await open(filename, 'r')
    try {
      const items: WorkspaceActivityItem[] = []; let consumed = 0
      while (items.length < limit && (items.length === 0 || consumed < MAX_SOURCE_BYTES)) {
        const row = await this.nextCompleteLine(file, offset, source)
        if (row === undefined) break
        const advanced = row.end - offset
        if (skipPrefix) { offset = row.end; consumed += advanced; skipPrefix = false; continue }
        items.push(parseRow(row.bytes, this.workspaceId, source)); consumed += advanced; offset = row.end
      }
      return { items, offset, skipPrefix }
    } finally { await file.close() }
  }
  /** Seek a newline using byte positions; UTF-8 character positions are never file offsets. */
  private async nextCompleteLine(file: Awaited<ReturnType<typeof open>>, offset: number, source: WorkspaceActivitySource): Promise<{ bytes: Buffer; end: number } | undefined> {
    const chunks: Buffer[] = []; let total = 0
    while (total < MAX_ROW_BYTES) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, MAX_ROW_BYTES - total))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset + total)
      if (bytesRead === 0) return undefined
      const chunk = buffer.subarray(0, bytesRead); const newline = chunk.indexOf(0x0a)
      if (newline >= 0) { chunks.push(chunk.subarray(0, newline)); return { bytes: Buffer.concat(chunks), end: offset + total + newline + 1 } }
      chunks.push(chunk); total += bytesRead
      if (bytesRead < buffer.length) return undefined
    }
    throw new Error(`WORKSPACE_ACTIVITY_ROW_TOO_LARGE: durable row in ${source} exceeds ${MAX_ROW_BYTES} bytes`)
  }
  private encode(value: Cursor): string { const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}` }
  private decode(raw: string): Cursor {
    const [payload, signature, ...rest] = raw.split('.'); const expected = payload === undefined ? Buffer.alloc(0) : createHmac('sha256', this.key).update(payload).digest()
    let received: Buffer; try { received = signature === undefined ? Buffer.alloc(0) : Buffer.from(signature, 'base64url') } catch { received = Buffer.alloc(0) }
    if (!payload || !signature || rest.length || received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('WORKSPACE_ACTIVITY_STALE: cursor is invalid; restart activity')
    try { return cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))) } catch { throw new Error('WORKSPACE_ACTIVITY_STALE: cursor is invalid; restart activity') }
  }
}
function parseRow(bytes: Buffer, workspaceId: string, source: WorkspaceActivitySource): WorkspaceActivityItem {
  const line = bytes.toString('utf8'); if (!Buffer.from(line, 'utf8').equals(bytes)) throw new Error(`WORKSPACE_ACTIVITY_CORRUPT: invalid UTF-8 durable line in ${source}`)
  let value: unknown; try { value = JSON.parse(line) } catch { throw new Error(`WORKSPACE_ACTIVITY_CORRUPT: malformed durable line in ${source}`) }
  const raw = z.object({ version: z.literal(1), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), type: z.string().min(1).max(256), observedAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional() }).passthrough().safeParse(value)
  if (!raw.success) throw new Error(`WORKSPACE_ACTIVITY_CORRUPT: invalid durable event in ${source}`)
  return { ref: { workspaceId, source, sequence: raw.data.sequence }, type: raw.data.type, ...(raw.data.observedAt === undefined ? {} : { timestampMs: raw.data.observedAt }), ...context(value) }
}
function context(value: unknown): Context {
  const factory = z.object({ type: z.enum(['health/factory-escalated', 'health/factory-resolved']), input: z.object({ projectId: id }).passthrough() }).passthrough().safeParse(value)
  if (factory.success) return { projectId: factory.data.input.projectId }
  const shape = z.object({ projectId: id.optional(), teamId: id.optional(), taskId: id.optional(), attemptId: id.optional(), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), work: z.object({ projectId: id.optional(), teamId: id.optional(), taskId: id.optional() }).passthrough().optional() }).passthrough().safeParse(value)
  if (!shape.success) return {}; const work = shape.data.work
  return { ...(shape.data.projectId === undefined ? work?.projectId === undefined ? {} : { projectId: work.projectId } : { projectId: shape.data.projectId }), ...(shape.data.teamId === undefined ? work?.teamId === undefined ? {} : { teamId: work.teamId } : { teamId: shape.data.teamId }), ...(shape.data.taskId === undefined ? work?.taskId === undefined ? {} : { taskId: work.taskId } : { taskId: shape.data.taskId }), ...(shape.data.attemptId === undefined ? {} : { attemptId: shape.data.attemptId }), ...(shape.data.generation === undefined ? {} : { generation: shape.data.generation }) }
}
