import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { DarkFactoryGithubScanStore, type GithubScanStoreOptions } from '../../src/darkfactory/github-scan-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { digestBytes, digestJson } from '../../src/darkfactory/json.ts'
const at = '2026-09-06T12:00:00.000Z', since = '2026-09-06T11:00:00.000Z', later = (ms: number) => new Date(Date.parse(at) + ms).toISOString()
const route = { projectId: 'project', routeId: 'github', initialSince: since }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(overrides: Partial<GithubScanStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'factory-github-scan-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { routes: [route], ...overrides }, filename = join(root, 'darkfactory-github-scans.jsonl')
  let store = await DarkFactoryGithubScanStore.open(root, options); cleanup.push(() => store.close())
  const artifacts = await DarkFactoryArtifactStore.open(root, ['project'], 65536, 1048576); cleanup.push(() => artifacts.settled())
  const artifact = await artifacts.persist('project', { entries: ['issue-1'] })
  const fence = (time = at) => ({ projectId: route.projectId, routeId: route.routeId, at: time, expectedRevision: store.snapshot().revision })
  return { root, options, filename, artifact, get store() { return store }, fence,
    async reopen(changes: Partial<GithubScanStoreOptions> = {}) { await store.close(); store = await DarkFactoryGithubScanStore.open(root, { ...options, ...changes }) },
    begin(time = at) { return store.begin(fence(time)) },
    save(sweepId: string, page: number, hasMore: boolean, time = at) { return store.savePage({ ...fence(time), sweepId, page, artifact, entryIds: ['issue-1'], hasMore }) },
    ack(sweepId: string, page: number, time = at) { return store.acknowledgePage({ ...fence(time), sweepId, page }) },
  }
}
function encode(event: Record<string, unknown>): string {
  for (;;) { const { hash: _hash, ...unsigned } = event; event.hash = digestJson(unsigned); const bytes = Buffer.byteLength(JSON.stringify(event)) + 1; if (event.storageBytes === bytes) return JSON.stringify(event) + '\n'; event.storageBytes = bytes }
}

it('pins cutoff and overlap, replays an unacknowledged page, and advances its watermark only on final durable page acknowledgement', async () => {
  const f = await fixture()
  expect(f.store.due('2026-09-06T10:59:59.999Z')).toEqual([])
  expect(f.store.due(at)).toHaveLength(1)
  const first = (await f.begin()).cursor.sweep!
  expect(first).toMatchObject({ since, cutoff: at, page: 1, status: 'active', pages: [] })
  await f.save(first.id, 1, true)
  const pending = f.store.snapshot(), bytes = await readFile(f.filename)
  await f.reopen(); expect(f.store.snapshot()).toEqual(pending)
  expect(f.store.due(at)[0]!.sweep!.pages[0]).toMatchObject({ acknowledged: false, artifact: f.artifact, entryIds: ['issue-1'] })
  expect((await f.begin()).duplicate).toBe(true); expect((await f.save(first.id, 1, true)).duplicate).toBe(true); expect(await readFile(f.filename)).toEqual(bytes)
  await f.ack(first.id, 1)
  expect(f.store.snapshot().cursors[0]).toMatchObject({ watermark: null, sweep: { page: 2, status: 'active' } })
  await f.save(first.id, 2, false)
  expect(f.store.snapshot().cursors[0]!.sweep!.pages).toHaveLength(1)
  const final = (await f.ack(first.id, 2)).cursor
  expect(final).toMatchObject({ watermark: at, nextAttemptAt: later(300000), sweep: { status: 'complete' } })
  const done = await readFile(f.filename)
  expect((await f.ack(first.id, 2)).duplicate).toBe(true); expect(await readFile(f.filename)).toEqual(done)
  expect(f.store.due(later(299999))).toEqual([])
  await expect(f.begin(later(299999))).rejects.toThrow(/not due/)
  const next = (await f.begin(later(300000))).cursor.sweep!
  expect(next.id).not.toBe(first.id); expect(next.since).toBe(later(-600000)); expect(next.cutoff).toBe(later(300000)); expect(next.page).toBe(1)
})

it('defers an active page without advancing or resetting it and clamps overlap to initialSince', async () => {
  const f = await fixture({ routes: [{ ...route, initialSince: later(-1000) }] }), sweep = (await f.begin()).cursor.sweep!
  await f.save(sweep.id, 1, false)
  await f.store.defer({ ...f.fence(), sweepId: sweep.id, nextAttemptAt: later(300000) })
  const before = f.store.snapshot(); await f.reopen(); expect(f.store.snapshot()).toEqual(before)
  expect(f.store.due(later(299999))).toEqual([]); expect(f.store.due(later(300000))[0]!.sweep).toEqual(before.cursors[0]!.sweep)
  await expect(f.store.defer({ ...f.fence(), sweepId: sweep.id, nextAttemptAt: later(1000) })).rejects.toThrow(/shorten/)
  await f.ack(sweep.id, 1, later(300000))
  expect((await f.begin(later(300000))).cursor.sweep!.since).toBe(later(-1000))
})

it('retains removed routes and old pinned windows while current registrations govern new actions', async () => {
  const f = await fixture(), sweep = (await f.begin()).cursor.sweep!
  await f.save(sweep.id, 1, false)
  const before = f.store.snapshot(); await f.reopen({ routes: [] }); expect(f.store.snapshot()).toEqual(before)
  expect(f.store.due(at)).toEqual([]); await expect(f.ack(sweep.id, 1)).rejects.toThrow(/Unregistered/)
  await f.reopen({ routes: [{ ...route, initialSince: later(3600000) }], intervalMs: 1000, lookbackMs: 0 })
  expect(f.store.snapshot()).toEqual(before)
  await f.ack(sweep.id, 1)
  expect(f.store.snapshot().cursors[0]!.nextAttemptAt).toBe(later(300000))
  const next = (await f.begin(later(300000))).cursor.sweep!
  expect(next.since).toBe(at); expect(next.intervalMs).toBe(1000); expect(next.lookbackMs).toBe(0)
  await f.save(next.id, 1, false, later(300000)); await f.ack(next.id, 1, later(300000))
  expect(f.store.snapshot().cursors[0]!.nextAttemptAt).toBe(later(301000))
})

it('rejects stale/cross-project/secret-bearing or out-of-order mutations without appending', async () => {
  const f = await fixture(), sweep = (await f.begin()).cursor.sweep!, before = await readFile(f.filename)
  await expect(f.store.begin({ ...f.fence(), projectId: 'other' })).rejects.toThrow(/Unregistered/)
  await expect(f.store.begin({ ...f.fence(), expectedRevision: 0 })).rejects.toThrow(/Stale/)
  await expect(f.ack(sweep.id, 1)).rejects.toThrow(/requires/)
  await expect(f.save(sweep.id, 2, false)).rejects.toThrow(/order/)
  await expect(f.store.savePage({ ...f.fence(), sweepId: sweep.id, page: 1, artifact: { ...f.artifact, projectId: 'other' }, entryIds: [], hasMore: false })).rejects.toThrow(/Cross-project/)
  await expect(f.store.savePage({ ...f.fence(), sweepId: sweep.id, page: 1, artifact: f.artifact, entryIds: [], hasMore: true })).rejects.toThrow(/Empty/)
  await expect(f.store.begin({ ...f.fence(), 'PRIVATE_KEY_SENTINEL': 'PRIVATE_VALUE_SENTINEL' } as never)).rejects.toThrow(/^Invalid GitHub scanner input: strict bounded JSON required$/)
  expect(await readFile(f.filename)).toEqual(before)
  await f.save(sweep.id, 1, false)
  const saved = await readFile(f.filename)
  await expect(f.save(sweep.id, 1, true)).rejects.toThrow(/Immutable/)
  await expect(f.save('other-sweep', 1, false)).rejects.toThrow(/Stale/)
  await expect(f.store.savePage({ ...f.fence(), sweepId: sweep.id, page: 1, artifact: f.artifact, entryIds: Array.from({ length: 101 }, (_, index) => `entry-${index}`), hasMore: false })).rejects.toThrow(/^Invalid/)
  expect(await readFile(f.filename)).toEqual(saved)
  const requests = [f.ack(sweep.id, 1, later(1)), f.ack(sweep.id, 1, later(1))]
  expect((await Promise.allSettled(requests)).map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  await expect(f.begin(at)).rejects.toThrow(/clock/); expect(() => f.store.due(at)).toThrow(/clock/)
})

it('enforces byte caps before writes and retains the active sweep on capacity failure', async () => {
  const f = await fixture({ maxRecordBytes: 1024, maxJournalBytes: 1024 }), sweep = (await f.begin()).cursor.sweep!, before = await readFile(f.filename)
  await expect(f.save(sweep.id, 1, false)).rejects.toThrow(/capacity/)
  expect(await readFile(f.filename)).toEqual(before); expect(f.store.snapshot().cursors[0]!.sweep).toEqual(sweep)
  await f.reopen(); expect(f.store.due(at)[0]!.sweep).toEqual(sweep)
})

it('rejects timestamp overflow without publishing a final watermark', async () => {
  const f = await fixture(), end = '9999-12-31T23:59:59.999Z', sweep = (await f.begin(end)).cursor.sweep!
  await f.save(sweep.id, 1, false, end)
  const before = await readFile(f.filename)
  await expect(f.ack(sweep.id, 1, end)).rejects.toThrow(/timestamp range/)
  expect(await readFile(f.filename)).toEqual(before); expect(f.store.snapshot().cursors[0]!.watermark).toBeNull()
})

it.each(['hash', 'identity', 'page', 'clock', 'version', 'duplicate-key', 'partial'])('refuses %s replay tampering without modification', async kind => {
  const f = await fixture(), sweep = (await f.begin()).cursor.sweep!
  await f.save(sweep.id, 1, false); await f.store.close()
  const lines = (await readFile(f.filename, 'utf8')).trimEnd().split('\n'), event = JSON.parse(lines[1]!)
  if (kind === 'hash') event.hash = digestJson('tampered')
  if (kind === 'identity') event.request.sweepId = 'wrong-sweep'
  if (kind === 'page') event.request.page = 2
  if (kind === 'clock') event.request.at = later(-1)
  if (kind === 'version') event.version = 9
  if (kind === 'hash') lines[1] = JSON.stringify(event)
  else if (kind === 'duplicate-key') lines[1] = lines[1]!.replace('{', '{"version":1,')
  else if (kind !== 'partial') lines[1] = encode(event).trimEnd()
  const malformed = lines.join('\n') + '\n' + (kind === 'partial' ? '{"version":1' : '')
  await writeFile(f.filename, malformed)
  await expect(DarkFactoryGithubScanStore.open(f.root, f.options)).rejects.toThrow(/Invalid|Incomplete/)
  await expect(DarkFactoryGithubScanStore.open(f.root, f.options)).rejects.toThrow(/Invalid|Incomplete/)
  expect(await readFile(f.filename, 'utf8')).toBe(malformed)
})

it('keeps native ownership through migration and refuses symlink journals', async () => {
  const f = await fixture(), sweep = (await f.begin()).cursor.sweep!; await f.save(sweep.id, 1, false)
  await expect(DarkFactoryGithubScanStore.open(f.root, f.options)).rejects.toThrow()
  const before = f.store.snapshot(); await f.store.close(); let validations = 0
  await DarkFactoryGithubScanStore.migrate(f.root, f.options, { migrationId: 'scan-fixture', validateReferences: async snapshot => {
    validations++; expect(snapshot).toEqual(before); const reference = snapshot.cursors[0]!.sweep!.pages[0]!.artifact
    expect(reference).toEqual(f.artifact)
    const bytes = await readFile(join(f.root, 'darkfactory/project/artifacts', reference.id))
    expect(bytes.length).toBe(reference.sizeBytes); expect(digestBytes(bytes)).toBe(reference.digest); expect(JSON.parse(bytes.toString('utf8')).entries).toEqual(['issue-1'])
  } })
  expect(validations).toBe(2); await f.reopen(); expect(f.store.snapshot()).toEqual(before); await f.ack(sweep.id, 1)
  expect(f.store.snapshot().cursors[0]!.watermark).toBe(at)
  const target = join(f.root, 'symlink-target'); await writeFile(target, '')
  const other = await fixture(); await other.store.close(); await rm(other.filename); await symlink(target, other.filename)
  await expect(DarkFactoryGithubScanStore.open(other.root, other.options)).rejects.toThrow(); expect(await readFile(target, 'utf8')).toBe('')
})
