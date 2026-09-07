/** Durable read-only scanner progress. Page acknowledgement requires host-verified durable entry custody. */
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from '../durable-journal.ts'
import { artifactRefSchema, counterSchema, digestSchema, idSchema, revisionSchema, timestampSchema, uniqueIds } from './contracts/common.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'
import { openFactoryOwnedJournal, migrateFactoryOwnedJournal, type FactoryJournalMigration } from './owned-journal.ts'
import { openFactoryRoot } from './paths.ts'

const hardRecordBytes = 16_777_216, maxPages = 10_000, maxSweeps = 100_000
const intervalSchema = revisionSchema.max(86_400_000), lookbackSchema = counterSchema.max(604_800_000)
const routeSchema = z.strictObject({ projectId: idSchema, routeId: idSchema, initialSince: timestampSchema })
export const githubScanStoreOptionsSchema = z.strictObject({
  routes: z.array(routeSchema).max(256), intervalMs: intervalSchema.default(300_000), lookbackMs: lookbackSchema.default(600_000),
  maxRecordBytes: revisionSchema.min(1024).max(hardRecordBytes).default(65_536), maxJournalBytes: revisionSchema.default(1_073_741_824),
}).refine(value => value.maxJournalBytes >= value.maxRecordBytes && new Set(value.routes.map(route => JSON.stringify([route.projectId, route.routeId]))).size === value.routes.length)
export type GithubScanStoreOptions = z.input<typeof githubScanStoreOptionsSchema>
export const githubScanPageSchema = z.strictObject({ page: revisionSchema.max(maxPages), artifact: artifactRefSchema, entryIds: uniqueIds(100), hasMore: z.boolean(),
  acknowledged: z.boolean(), savedAt: timestampSchema, acknowledgedAt: timestampSchema.optional() })
export const githubScanSweepSchema = z.strictObject({ id: idSchema, since: timestampSchema, cutoff: timestampSchema, intervalMs: intervalSchema, lookbackMs: lookbackSchema, page: revisionSchema.max(maxPages), status: z.enum(['active', 'complete']),
  // Older acknowledged pages remain in the journal; memory retains at most one current/last page.
  pages: z.array(githubScanPageSchema).max(1) })
export const githubScanCursorSchema = z.strictObject({ ...routeSchema.shape, revision: counterSchema, watermark: timestampSchema.nullable(), nextAttemptAt: timestampSchema, sweep: githubScanSweepSchema.optional() })
export type GithubScanPage = z.output<typeof githubScanPageSchema>
export type GithubScanSweep = z.output<typeof githubScanSweepSchema>
export type GithubScanCursor = z.output<typeof githubScanCursorSchema>
export interface GithubScanState { revision: number; head: string | null; journalBytes: number; lastAt: string | null; cursors: GithubScanCursor[]; sweepsStarted: number }
export interface GithubScanResult { cursor: GithubScanCursor; duplicate: boolean }
const fence = { projectId: idSchema, routeId: idSchema, at: timestampSchema, expectedRevision: counterSchema }
export const beginGithubScanSchema = z.strictObject(fence)
export const saveGithubScanPageSchema = z.strictObject({ ...fence, sweepId: idSchema, page: revisionSchema.max(maxPages), artifact: artifactRefSchema, entryIds: uniqueIds(100), hasMore: z.boolean() })
export const acknowledgeGithubScanPageSchema = z.strictObject({ ...fence, sweepId: idSchema, page: revisionSchema.max(maxPages) })
export const deferGithubScanSchema = z.strictObject({ ...fence, sweepId: idSchema, nextAttemptAt: timestampSchema })
const common = { version: z.literal(1), sequence: revisionSchema, previousHash: digestSchema.nullable(), hash: digestSchema, storageBytes: revisionSchema }
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('github-scan-began'), request: beginGithubScanSchema, sweepId: idSchema, initialSince: timestampSchema, intervalMs: intervalSchema, lookbackMs: lookbackSchema }),
  z.strictObject({ ...common, type: z.literal('github-scan-page-saved'), request: saveGithubScanPageSchema }),
  z.strictObject({ ...common, type: z.literal('github-scan-page-acknowledged'), request: acknowledgeGithubScanPageSchema }),
  z.strictObject({ ...common, type: z.literal('github-scan-deferred'), request: deferGithubScanSchema }),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, keyof typeof common> : never : never
type Options = z.output<typeof githubScanStoreOptionsSchema>
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(parseStrictJson(canonicalJson(raw, hardRecordBytes), hardRecordBytes)) } catch { throw new Error('Invalid GitHub scanner input: strict bounded JSON required') }
}
function initial(options: Options): GithubScanState {
  return { revision: 0, head: null, journalBytes: 0, lastAt: null, sweepsStarted: 0,
    cursors: options.routes.map(route => ({ ...route, revision: 0, watermark: null, nextAttemptAt: route.initialSince })) }
}
function assertTime(state: GithubScanState, at: string): void {
  if (state.lastAt && Date.parse(at) < Date.parse(state.lastAt)) throw new Error('GitHub scanner clock moved backwards')
}
function cursorFor(state: GithubScanState, projectId: string, routeId: string): GithubScanCursor {
  const cursor = state.cursors.find(cursor => cursor.projectId === projectId && cursor.routeId === routeId)
  if (!cursor) throw new Error('Unregistered GitHub scanner project or route')
  return cursor
}
function sweepId(cursor: GithubScanCursor, at: string): string { return `df-github-scan-${digestJson([cursor.projectId, cursor.routeId, cursor.revision + 1, cursor.sweep?.id ?? null, at]).slice(7)}` }
function apply(state: GithubScanState, event: Payload): GithubScanResult {
  const request = event.request
  if (request.expectedRevision !== state.revision) throw new Error('Stale GitHub scanner store revision')
  assertTime(state, request.at)
  if (event.type === 'github-scan-began' && !state.cursors.some(cursor => cursor.projectId === request.projectId && cursor.routeId === request.routeId)) {
    if (state.cursors.length >= 1024) throw new Error('GitHub scanner route history capacity exceeded')
    state.cursors.push({ projectId: request.projectId, routeId: request.routeId, initialSince: event.initialSince, revision: 0, watermark: null, nextAttemptAt: event.initialSince })
  }
  const cursor = cursorFor(state, request.projectId, request.routeId)
  if (event.type === 'github-scan-began') {
    // A current registration may differ from the pinned first historical sweep.
    if (cursor.revision === 0) { cursor.initialSince = event.initialSince; cursor.nextAttemptAt = event.initialSince }
    if (Date.parse(request.at) < Date.parse(cursor.nextAttemptAt)) throw new Error('GitHub scanner route is not due')
    if (cursor.sweep?.status === 'active') {
      if (event.sweepId !== cursor.sweep.id) throw new Error('GitHub scanner sweep identity mismatch')
      return { cursor, duplicate: true }
    }
    if (state.sweepsStarted >= maxSweeps) throw new Error('GitHub scanner history capacity exceeded')
    if (event.sweepId !== sweepId(cursor, request.at)) throw new Error('GitHub scanner sweep identity mismatch')
    cursor.initialSince = event.initialSince
    const watermark = cursor.watermark ? Date.parse(cursor.watermark) : undefined
    // Raising initialSince must never jump past already established progress.
    const floor = watermark === undefined ? Date.parse(cursor.initialSince) : Math.min(Date.parse(cursor.initialSince), watermark)
    const since = new Date(Math.max(floor, watermark === undefined ? floor : watermark - event.lookbackMs)).toISOString()
    if (Date.parse(since) > Date.parse(request.at)) throw new Error('GitHub scanner cutoff precedes its source window')
    cursor.sweep = { id: event.sweepId, since, cutoff: request.at, intervalMs: event.intervalMs, lookbackMs: event.lookbackMs, page: 1, status: 'active', pages: [] }
    cursor.nextAttemptAt = request.at; state.sweepsStarted++
  } else {
    const sweep = cursor.sweep
    if (!sweep || sweep.id !== event.request.sweepId) throw new Error('Stale GitHub scanner sweep')
    const previous = sweep.pages[0]
    if (event.type === 'github-scan-page-saved') {
      const request = event.request
      if (request.artifact.projectId !== cursor.projectId) throw new Error('Cross-project GitHub scan artifact denied')
      const same = previous && previous.page === request.page && canonicalJson(previous.artifact) === canonicalJson(request.artifact) &&
        canonicalJson(previous.entryIds) === canonicalJson(request.entryIds) && previous.hasMore === request.hasMore
      if (same) return { cursor, duplicate: true }
      if (sweep.status !== 'active' || request.page !== sweep.page || previous && !previous.acknowledged) throw new Error('Immutable or out-of-order GitHub scan page')
      if (request.page === maxPages && request.hasMore) throw new Error('GitHub scanner page capacity exceeded; continuation remains active')
      if (request.hasMore && request.entryIds.length === 0) throw new Error('Empty GitHub scan page cannot claim continuation')
      sweep.pages = [{ page: request.page, artifact: request.artifact, entryIds: request.entryIds, hasMore: request.hasMore, acknowledged: false, savedAt: request.at }]
    } else if (event.type === 'github-scan-page-acknowledged') {
      if (!previous || previous.page !== event.request.page) throw new Error('GitHub scanner acknowledgement requires its saved page')
      if (previous.acknowledged) return { cursor, duplicate: true }
      if (sweep.status !== 'active' || sweep.page !== previous.page) throw new Error('Stale GitHub scanner page acknowledgement')
      previous.acknowledged = true; previous.acknowledgedAt = request.at
      if (previous.hasMore) sweep.page++
      else {
        sweep.status = 'complete'; cursor.watermark = sweep.cutoff
        const nextAttemptAt = timestampSchema.safeParse(new Date(Date.parse(sweep.cutoff) + sweep.intervalMs).toISOString())
        if (!nextAttemptAt.success) throw new Error('GitHub scanner interval exceeds timestamp range')
        cursor.nextAttemptAt = nextAttemptAt.data
      }
    } else {
      if (sweep.status !== 'active' || Date.parse(event.request.nextAttemptAt) <= Date.parse(request.at)) throw new Error('Invalid GitHub scanner deferral')
      if (Date.parse(event.request.nextAttemptAt) < Date.parse(cursor.nextAttemptAt)) throw new Error('GitHub scanner deferral cannot shorten a delay')
      if (event.request.nextAttemptAt === cursor.nextAttemptAt) return { cursor, duplicate: true }
      cursor.nextAttemptAt = event.request.nextAttemptAt
    }
  }
  cursor.revision++; state.lastAt = request.at
  return { cursor, duplicate: false }
}
function reduce(options: Options, state: GithubScanState, raw: unknown): GithubScanState {
  const event = parse(eventSchema, raw), { hash, ...unsigned } = event
  if (event.previousHash !== state.head || digestJson(unsigned) !== hash) throw new Error('GitHub scanner journal hash chain mismatch')
  const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1
  if (event.storageBytes !== bytes || bytes > options.maxRecordBytes || state.journalBytes > options.maxJournalBytes - bytes) throw new Error('GitHub scanner journal capacity exceeded')
  const next = structuredClone(state)
  if (apply(next, event).duplicate) throw new Error('Duplicate GitHub scanner journal event')
  return { ...next, revision: event.sequence, head: hash, journalBytes: state.journalBytes + bytes }
}
function parseLine(line: string): unknown {
  const event = parseStrictJson(line, hardRecordBytes)
  if (JSON.stringify(event) !== line) throw new Error('Noncanonical GitHub scanner journal encoding')
  return event
}
export class DarkFactoryGithubScanStore {
  private tail: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private queued = 0
  private constructor(private readonly journal: DurableJournal<GithubScanState, Event>, private readonly options: Options) {}
  static async open(directory: string, raw: GithubScanStoreOptions): Promise<DarkFactoryGithubScanStore> {
    const options = parse(githubScanStoreOptionsSchema, raw), root = await openFactoryRoot(directory)
    let journal: DurableJournal<GithubScanState, Event> | undefined
    try {
      journal = await openFactoryOwnedJournal<GithubScanState, Event>(join(root.descriptorPath, 'darkfactory-github-scans.jsonl'), initial(options), (state, event) => reduce(options, state, event), parseLine, options)
      await root.close(); return new DarkFactoryGithubScanStore(journal, options)
    } catch (error) { await journal?.close(); throw error } finally { await root.close() }
  }
  static async migrate(directory: string, raw: GithubScanStoreOptions, migration: FactoryJournalMigration<GithubScanState>) {
    const options = parse(githubScanStoreOptionsSchema, raw), root = await openFactoryRoot(directory)
    try { return await migrateFactoryOwnedJournal<GithubScanState, Event>(join(root.descriptorPath, 'darkfactory-github-scans.jsonl'), initial(options), (state, event) => reduce(options, state, event), parseLine, options, migration, root.path) }
    finally { await root.close() }
  }
  private append(make: (state: GithubScanState) => Payload): Promise<GithubScanResult> {
    if (this.closing) return Promise.reject(new Error('GitHub scanner store is closed'))
    if (this.queued >= 32) return Promise.reject(new Error('GitHub scanner operation capacity exceeded'))
    this.queued++
    const pending = this.tail.then(async () => {
      const state = this.journal.snapshot(), payload = make(state)
      if (!this.options.routes.some(route => route.projectId === payload.request.projectId && route.routeId === payload.request.routeId)) throw new Error('Unregistered GitHub scanner project or route')
      const result = apply(structuredClone(state), payload)
      if (result.duplicate) return structuredClone(result)
      await this.journal.append((state, sequence) => {
        const unsigned = { ...payload, version: 1 as const, sequence, previousHash: state.head, storageBytes: 1 }
        for (;;) {
          const event = { ...unsigned, hash: digestJson(unsigned) } as Event, bytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
          if (bytes === unsigned.storageBytes) return event
          unsigned.storageBytes = bytes
        }
      })
      return structuredClone(result)
    }).finally(() => { this.queued-- })
    this.tail = pending.catch(() => {})
    return pending
  }
  async begin(raw: z.input<typeof beginGithubScanSchema>): Promise<GithubScanResult> {
    const request = parse(beginGithubScanSchema, raw)
    const registration = this.options.routes.find(route => route.projectId === request.projectId && route.routeId === request.routeId)
    if (!registration) throw new Error('Unregistered GitHub scanner project or route')
    return this.append(state => { const cursor = cursorFor(state, request.projectId, request.routeId); return { type: 'github-scan-began', request,
      initialSince: cursor.sweep?.status === 'active' ? cursor.initialSince : registration.initialSince,
      intervalMs: this.options.intervalMs, lookbackMs: this.options.lookbackMs,
      sweepId: cursor.sweep?.status === 'active' ? cursor.sweep.id : sweepId(cursor, request.at) } })
  }
  async savePage(raw: z.input<typeof saveGithubScanPageSchema>): Promise<GithubScanResult> { const request = parse(saveGithubScanPageSchema, raw); return this.append(() => ({ type: 'github-scan-page-saved', request })) }
  /** Host call only: the store cannot infer per-entry custody from opaque IDs. */
  async acknowledgePage(raw: z.input<typeof acknowledgeGithubScanPageSchema>): Promise<GithubScanResult> { const request = parse(acknowledgeGithubScanPageSchema, raw); return this.append(() => ({ type: 'github-scan-page-acknowledged', request })) }
  async defer(raw: z.input<typeof deferGithubScanSchema>): Promise<GithubScanResult> { const request = parse(deferGithubScanSchema, raw); return this.append(() => ({ type: 'github-scan-deferred', request })) }
  due(raw: string): GithubScanCursor[] {
    const at = parse(timestampSchema, raw), state = this.journal.snapshot(); assertTime(state, at)
    return state.cursors.filter(cursor => this.options.routes.some(route => route.projectId === cursor.projectId && route.routeId === cursor.routeId) && Date.parse(cursor.nextAttemptAt) <= Date.parse(at))
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) || a.projectId.localeCompare(b.projectId) || a.routeId.localeCompare(b.routeId)).slice(0, 100)
  }
  snapshot(): GithubScanState { return this.journal.snapshot() }
  close(): Promise<void> { return this.closing ??= this.tail.then(() => this.journal.close()) }
}
