import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DarkFactoryProviderRequestStore, ProviderRequestDeniedError, type ProviderRequestStoreOptions } from '../../src/darkfactory/provider-request-store.ts'
import { digestJson } from '../../src/darkfactory/json.ts'

const at = '2026-09-06T12:00:00.000Z', later = (ms: number) => new Date(Date.parse(at) + ms).toISOString()
const routes = [{ projectId: 'project-a', routeId: 'github-a' }, { projectId: 'project-b', routeId: 'github-b' }]
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture(extra: Partial<ProviderRequestStoreOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-provider-budget-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  let options = { routes, ...extra }, store = await DarkFactoryProviderRequestStore.open(directory, options)
  cleanups.push(() => store.close())
  return { directory, filename: join(directory, 'darkfactory-provider-requests.jsonl'), get store() { return store }, get options() { return options },
    reserve(when = at, route = routes[0]!) { return store.reserve({ ...route, at: when, expectedRevision: store.snapshot().revision }) },
    async reopen(changed: Partial<ProviderRequestStoreOptions> = {}) { const snapshot = store.snapshot(); await store.close(); options = { ...options, ...changed }; store = await DarkFactoryProviderRequestStore.open(directory, options); expect(store.snapshot()).toEqual(snapshot) },
  }
}
function encode(event: Record<string, unknown>) {
  const { hash: _hash, ...unsigned } = event
  for (;;) {
    const updated = { ...unsigned, hash: digestJson(unsigned) }, bytes = JSON.stringify(updated) + '\n'
    if (Buffer.byteLength(bytes) === unsigned.storageBytes) return bytes
    unsigned.storageBytes = Buffer.byteLength(bytes)
  }
}

describe('shared durable provider request budget', () => {
  it('syncs 55 concurrent globally shared charges and refuses the next without a denial append', async () => {
    const f = await fixture()
    const receipts = await Promise.all(Array.from({ length: 55 }, (_, expectedRevision) => f.store.reserve({ ...routes[expectedRevision % 2]!, expectedRevision, at })))
    expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(55)
    expect(f.store.snapshot().charges).toEqual(receipts)
    expect(f.store.availability(at)).toEqual({ available: 0, nextAttemptAt: later(60_000) })
    const bytes = await readFile(f.filename)
    expect(bytes.byteLength).toBe(f.store.snapshot().journalBytes)
    expect(bytes.toString('utf8').trim().split('\n')).toHaveLength(55)
    await expect(f.reserve()).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_DENIED', reason: 'RATE_LIMITED', nextAttemptAt: later(60_000) })
    for (let index = 0; index < 5; index++) await expect(f.reserve(later(59_999))).rejects.toBeInstanceOf(ProviderRequestDeniedError)
    expect(await readFile(f.filename)).toEqual(bytes)
    await f.reopen()
    expect(f.store.availability(later(59_999)).available).toBe(0)
    expect(f.store.availability(later(60_000))).toEqual({ available: 55 })
    const next = await f.reserve(later(60_000))
    expect(receipts.some(receipt => receipt.id === next.id)).toBe(false)
    expect(f.store.snapshot().charges).toHaveLength(56)
  })

  it('charges uncertain calls across restart and never treats repeated request fields as free duplicates', async () => {
    const f = await fixture(), first = await f.reserve()
    // Transport could have failed or the process could have died before observing its response.
    await f.reopen()
    expect(f.store.availability(at).available).toBe(54)
    const second = await f.reserve()
    expect(second.id).not.toBe(first.id)
    expect(f.store.snapshot().charges).toEqual([first, second])
    const bytes = await readFile(f.filename)
    await expect(f.store.reserve({ ...routes[0]!, at, expectedRevision: 2, chargeId: first.id } as never)).rejects.toThrow(/^Invalid provider request authority input/)
    expect(await readFile(f.filename)).toEqual(bytes)
  })

  it('retains old route history after removal and applies a reduced current cap only to new requests', async () => {
    const f = await fixture()
    await f.reserve(); await f.reserve(later(1000)); await f.reserve(later(2000))
    await f.reopen({ routes: [routes[1]!], requestsPerMinute: 2 })
    const bytes = await readFile(f.filename)
    await expect(f.reserve(later(3000))).rejects.toThrow(/Unregistered/)
    expect(f.store.availability(later(3000))).toEqual({ available: 0, nextAttemptAt: later(61_000) })
    await expect(f.reserve(later(60_000), routes[1])).rejects.toMatchObject({ reason: 'RATE_LIMITED', nextAttemptAt: later(61_000) })
    expect(await readFile(f.filename)).toEqual(bytes)
    await f.reserve(later(61_000), routes[1])
    expect(f.store.snapshot().charges).toHaveLength(4)
    await f.reopen({ routes: [] })
    expect(f.store.snapshot().charges.slice(0, 3).every(receipt => receipt.projectId === 'project-a')).toBe(true)
    await expect(f.reserve(later(62_000), routes[1])).rejects.toThrow(/Unregistered/)
  })

  it('persists provider and legacy cooldowns, never shortens them, and keeps checks read-only', async () => {
    const f = await fixture()
    const legacy = await f.store.block({ at, until: later(60_000), reason: 'LEGACY_WITHHOLDING', expectedRevision: 0 })
    expect(legacy).toMatchObject({ reason: 'LEGACY_WITHHOLDING', until: later(60_000) })
    await f.reopen()
    const before = await readFile(f.filename)
    expect(f.store.availability(at)).toEqual({ available: 0, nextAttemptAt: later(60_000) })
    await expect(f.reserve()).rejects.toMatchObject({ reason: 'COOLDOWN', nextAttemptAt: later(60_000) })
    expect(await readFile(f.filename)).toEqual(before)
    await f.store.block({ at: later(1000), until: later(120_000), reason: 'PROVIDER_RATE_LIMITED', expectedRevision: 1 })
    await f.store.block({ at: later(2000), until: later(30_000), reason: 'PROVIDER_RATE_LIMITED', expectedRevision: 2 })
    await f.reopen()
    expect(f.store.snapshot().blockedUntil).toBe(later(120_000))
    expect(f.store.availability(later(60_000))).toEqual({ available: 0, nextAttemptAt: later(120_000) })
    await expect(f.reserve(later(119_999))).rejects.toMatchObject({ reason: 'COOLDOWN' })
    await f.reserve(later(120_000))
  })

  it('rejects backwards clocks, cross-project route pairing, stale CAS and secret-bearing extensions without writes', async () => {
    const f = await fixture(); await f.reserve(later(1000))
    const before = await readFile(f.filename)
    await expect(f.reserve(at)).rejects.toThrow(/^Provider request clock moved backwards$/)
    expect(() => f.store.availability(at)).toThrow(/^Provider request clock moved backwards$/)
    await expect(f.store.block({ at, until: later(60_000), reason: 'PROVIDER_RATE_LIMITED', expectedRevision: 1 })).rejects.toThrow(/clock/)
    await expect(f.store.block({ at: later(1000), until: at, reason: 'PROVIDER_RATE_LIMITED', expectedRevision: 1 })).rejects.toThrow(/interval/)
    await expect(f.store.reserve({ projectId: 'project-a', routeId: 'github-b', at: later(1000), expectedRevision: 1 })).rejects.toThrow(/Unregistered/)
    await expect(f.store.reserve({ ...routes[0]!, at: later(1000), expectedRevision: 0 })).rejects.toThrow(/Stale/)
    await expect(f.store.reserve({ ...routes[0]!, at: later(1000), expectedRevision: 1, ['secret-in-key']: 'secret-in-value' } as never)).rejects.toThrow(/^Invalid provider request authority input: strict bounded JSON required$/)
    expect(await readFile(f.filename)).toEqual(before)
    const requests = [f.store.reserve({ ...routes[0]!, at: later(1000), expectedRevision: 1 }), f.store.reserve({ ...routes[1]!, at: later(1000), expectedRevision: 1 })]
    expect((await Promise.allSettled(requests)).map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  })

  it('enforces charge, block, and byte caps without unbounded denial history', async () => {
    const charges = await fixture({ maxCharges: 1 }); await charges.reserve()
    const original = await readFile(charges.filename)
    await expect(charges.reserve(later(60_000))).rejects.toMatchObject({ reason: 'CAPACITY' })
    expect(charges.store.availability(later(60_000))).toEqual({ available: 0 })
    expect(await readFile(charges.filename)).toEqual(original)
    await charges.reopen()
    const blocks = await fixture({ maxBlocks: 1 })
    await blocks.store.block({ at, until: later(1), reason: 'PROVIDER_RATE_LIMITED', expectedRevision: 0 })
    await expect(blocks.store.block({ at: later(2), until: later(3), reason: 'LEGACY_WITHHOLDING', expectedRevision: 1 })).rejects.toMatchObject({ reason: 'CAPACITY' })
    const bytes = await fixture({ maxRecordBytes: 1024, maxJournalBytes: 1024 })
    await bytes.reserve(); await bytes.reserve()
    const before = await readFile(bytes.filename)
    await expect(bytes.reserve()).rejects.toMatchObject({ reason: 'CAPACITY' })
    expect(await readFile(bytes.filename)).toEqual(before)
    await bytes.reopen()
    await expect(DarkFactoryProviderRequestStore.open(bytes.directory, { routes, requestsPerMinute: 56 })).rejects.toThrow(/^Invalid provider request authority input/)
  })

  it.each(['receipt', 'clock', 'hash', 'unknown', 'duplicate', 'partial'] as const)('rejects %s replay corruption without changing bytes or leaking ownership', async kind => {
    const f = await fixture(); await f.reserve(); await f.reserve(later(1000)); await f.store.close()
    const lines = (await readFile(f.filename, 'utf8')).trim().split('\n'), event = JSON.parse(lines[1]!)
    if (kind === 'receipt') event.receiptId = 'forged'
    if (kind === 'clock') {
      event.request.at = later(-1)
      event.receiptId = `df-provider-${digestJson([event.sequence, event.previousHash, event.type, event.request]).slice(7)}`
    }
    if (kind === 'hash') event.hash = digestJson('corrupt')
    if (kind === 'unknown') event.version = 3
    if (kind === 'receipt' || kind === 'clock' || kind === 'unknown') lines[1] = encode(event).trim()
    if (kind === 'hash') lines[1] = JSON.stringify(event)
    if (kind === 'duplicate') lines[1] = lines[1]!.replace('{', '{"version":1,')
    const bad = lines.join('\n') + '\n' + (kind === 'partial' ? '{"version":1' : '')
    await writeFile(f.filename, bad)
    await expect(DarkFactoryProviderRequestStore.open(f.directory, f.options)).rejects.toThrow(/Invalid|Incomplete/)
    await expect(DarkFactoryProviderRequestStore.open(f.directory, f.options)).rejects.toThrow(/Invalid|Incomplete/)
    expect(await readFile(f.filename, 'utf8')).toBe(bad)
  })

  it('retains one owner through migration and fresh native append, refusing final symlinks', async () => {
    const f = await fixture(); await f.reserve()
    const before = f.store.snapshot(), bytes = await readFile(f.filename)
    await expect(DarkFactoryProviderRequestStore.open(f.directory, f.options)).rejects.toThrow()
    await expect(DarkFactoryProviderRequestStore.migrate(f.directory, f.options, { migrationId: 'owned', validateReferences: async () => {} })).rejects.toThrow()
    await f.store.close()
    let calls = 0
    const result = await DarkFactoryProviderRequestStore.migrate(f.directory, f.options, { migrationId: 'provider-budget', validateReferences: async state => { calls++; expect(state).toEqual(before) } })
    expect(calls).toBe(2); expect(await readFile(result.backup)).toEqual(bytes)
    await f.reopen(); await f.reserve()
    expect(await readFile(result.backup)).toEqual(bytes)
    expect((await readFile(result.target)).subarray(0, bytes.length)).toEqual(bytes)
    const unsafe = await fixture(); await unsafe.store.close(); await rm(unsafe.filename)
    const outside = join(unsafe.directory, 'outside.jsonl'); await writeFile(outside, 'unchanged')
    await symlink(outside, unsafe.filename)
    await expect(DarkFactoryProviderRequestStore.open(unsafe.directory, unsafe.options)).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('unchanged')
  })
})
