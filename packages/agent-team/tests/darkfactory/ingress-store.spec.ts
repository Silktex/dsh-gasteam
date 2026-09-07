import { appendFile, mkdir, mkdtemp, open as openFile, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureFactoryDirectory } from '../../src/darkfactory/paths.ts'
import { DarkFactoryIngestionStore, type IngestionStoreOptions } from '../../src/darkfactory/ingestion-store.ts'
import { inboundEnvelopeSchema, inboundWorkItemSchema } from '../../src/darkfactory/contracts/ingestion.ts'
import { examples } from './fixtures.ts'
import { digestJson } from '../../src/darkfactory/json.ts'

const dirs: string[] = []
const stores: DarkFactoryIngestionStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
function request(index = 1, body = String(index % 10).repeat(64)) {
  const envelope = inboundEnvelopeSchema.parse({ ...examples.InboundEnvelopeV1, id: `envelope-${index}`, deliveryId: `delivery-${index}`, bodyDigest: `sha256:${body}` })
  const item = inboundWorkItemSchema.parse({ ...examples.InboundWorkItemV1, id: `work-${index}`, envelopeId: envelope.id, sourceRevision: `sha256:${body}`, state: 'received', trust: { ...examples.InboundWorkItemV1.trust, decision: 'unresolved', entityRevision: `sha256:${body}` } })
  return { envelope, item, bodySizeBytes: 100 }
}
async function open(overrides: Partial<IngestionStoreOptions> = {}, directory?: string) {
  directory ??= await mkdtemp(join(tmpdir(), 'factory-ingress-'))
  if (!dirs.includes(directory)) dirs.push(directory)
  const store = await DarkFactoryIngestionStore.open(directory, { projectId: 'project-1', ...overrides }, () => '2026-09-06T12:00:00Z')
  stores.push(store)
  return { store, directory, filename: join(directory, 'darkfactory/project-1/ingestion.jsonl') }
}

describe('durable ingress custody', () => {
  it('atomically deduplicates transport, body aliases and work identities across replay', async () => {
    const { store, directory, filename } = await open()
    const first = request()
    const result = await store.recordReceived(first)
    expect(result).toMatchObject({ duplicate: false, conflict: false, itemId: 'work-1', receipt: { decision: 'received', duplicateCount: 0 } })
    const duplicates = await Promise.all([store.recordReceived(first), store.recordReceived(request(2, '1'.repeat(64)))])
    for (const duplicate of duplicates) expect(duplicate).toEqual({ ...result, duplicate: true })
    expect(store.snapshot().items).toHaveLength(1)
    expect(store.snapshot().custody).toHaveLength(1)
    expect(store.snapshot().audits).toHaveLength(3)
    const nextTransport = request(3)
    nextTransport.item.sourceRevision = first.item.sourceRevision
    nextTransport.item.trust.entityRevision = first.item.sourceRevision
    expect((await store.recordReceived(nextTransport)).itemId).toBe('work-1')
    expect(store.snapshot().items).toHaveLength(1)
    const snapshot = store.snapshot()
    expect(snapshot.journalBytes).toBe((await readFile(filename)).byteLength)
    await expect(DarkFactoryIngestionStore.open(directory, { projectId: 'project-1' })).rejects.toThrow()
    await store.close()
    const replay = await open({}, directory)
    expect(replay.store.snapshot()).toEqual(snapshot)
    expect((await replay.store.recordReceived(first)).receipt).toEqual(result.receipt)
  })

  it('quarantines reused delivery identities without mutating originals, including aliased deliveries', async () => {
    const { store } = await open()
    const first = await store.recordReceived(request())
    await store.recordReceived(request(2, '1'.repeat(64)))
    const conflict = { ...request(4), envelope: { ...request(4).envelope, deliveryId: 'delivery-2' } }
    await expect(store.recordReceived(conflict)).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT_REQUIRES_ESCALATION' })
    const result = await store.recordReceived({ ...conflict, healthEscalationId: 'health-conflict' })
    expect(result).toMatchObject({ conflict: true, duplicate: false, quarantineReason: 'DELIVERY_ID_CONFLICT', healthEscalationId: 'health-conflict', receipt: { decision: 'quarantined' } })
    expect((await store.recordReceived(conflict)).receipt).toEqual(result.receipt)
    expect(store.snapshot().custody[0]!.receipt).toEqual(first.receipt)
    expect(store.snapshot().items).toHaveLength(1)
    expect(store.snapshot().items[0]!.state).toBe('received')
  })

  it('keeps initial trust unresolved and records source-change quarantine against active immutable work', async () => {
    const { store } = await open()
    const invalid = request()
    invalid.item.trust.decision = 'trusted'
    await expect(store.recordReceived(invalid)).rejects.toThrow(/unresolved/)
    await store.recordReceived(request())
    await expect(store.recordReceived(request(2))).rejects.toThrow(/health escalation/)
    const changed = await store.recordReceived({ ...request(2), healthEscalationId: 'health-source-change' })
    expect(changed.quarantineReason).toBe('SOURCE_CHANGED')
    expect(store.snapshot().items.map(item => item.state)).toEqual(['received', 'quarantined'])
    expect(store.snapshot().items[0]!.trust.decision).toBe('unresolved')
  })

  it('records authenticated quarantine custody without normalized work and deduplicates its body', async () => {
    const { store } = await open()
    const input = { envelope: request().envelope, bodySizeBytes: 100, quarantineReason: 'UNSUPPORTED_PAYLOAD', healthEscalationId: 'health-payload' }
    const result = await store.recordReceived(input)
    expect(result.receipt.decision).toBe('quarantined')
    const duplicate = await store.recordReceived({ ...input, envelope: request(2, '1'.repeat(64)).envelope })
    expect(duplicate).toEqual({ ...result, duplicate: true })
    expect(store.snapshot().items).toEqual([])
  })

  it('enforces scoped CAS, immutable source data and terminal quarantine with a health reference', async () => {
    const { store } = await open()
    const input = request()
    await store.recordReceived(input)
    const trusted = { ...input.item, state: 'trusted' as const, revision: 2, trust: { ...input.item.trust, decision: 'trusted' as const } }
    await expect(store.transition({ projectId: 'other', expectedRevision: 1, item: trusted })).rejects.toThrow(/Cross-project/)
    await expect(store.transition({ projectId: 'project-1', expectedRevision: 2, item: trusted })).rejects.toThrow(/Stale/)
    await expect(store.transition({ projectId: 'project-1', expectedRevision: 1, item: { ...trusted, title: 'rewritten source' } })).rejects.toThrow(/immutable/)
    await store.transition({ projectId: 'project-1', expectedRevision: 1, item: trusted })
    const quarantine = { ...trusted, revision: 3, state: 'quarantined' as const, quarantineReason: 'SOURCE_REVOKED', healthEscalationId: 'health-revoked' }
    await store.transition({ projectId: 'project-1', expectedRevision: 2, item: quarantine })
    await expect(store.transition({ projectId: 'project-1', expectedRevision: 3, item: { ...trusted, revision: 4 } })).rejects.toThrow(/Illegal/)
  })

  it('bounds bodies, queue, records and aggregate journal bytes before durable acknowledgment', async () => {
    const body = await open({ maxBodyBytes: 99 })
    await expect(body.store.recordReceived(request())).rejects.toThrow(/body capacity/)
    expect(await readFile(body.filename, 'utf8')).toBe('')
    const queue = await open({ maxQueueItems: 1 })
    const first = await queue.store.recordReceived({ envelope: request().envelope, bodySizeBytes: 100 })
    await expect(queue.store.recordReceived({ envelope: request(2).envelope, bodySizeBytes: 100 })).rejects.toThrow(/queue capacity/)
    expect((await queue.store.recordReceived({ envelope: request().envelope, bodySizeBytes: 100 })).receipt).toEqual(first.receipt)
    const record = await open({ maxRecordBytes: 100 })
    await expect(record.store.recordReceived(request())).rejects.toThrow(/journal capacity/)
    expect(await readFile(record.filename, 'utf8')).toBe('')
    const journal = await open({ maxRecordBytes: 4000, maxJournalBytes: 4000 })
    await journal.store.recordReceived(request())
    const bytes = await readFile(journal.filename)
    await expect(journal.store.recordReceived(request())).rejects.toThrow(/journal capacity/)
    expect(await readFile(journal.filename)).toEqual(bytes)
  })

  it('rejects cross-project and unsafe raw inputs without leaking attacker values or appending', async () => {
    const { store, filename } = await open()
    const input = request()
    await expect(store.recordReceived({ ...input, envelope: { ...input.envelope, projectId: 'other' } })).rejects.toThrow(/Cross-project/)
    await expect(store.recordReceived({ ...input, item: { ...input.item, projectId: 'other' } })).rejects.toThrow()
    await expect(store.recordReceived({ ...input, 'sensitive-key': 'secret-value' } as never)).rejects.toThrow('Invalid ingress authority input: strict bounded JSON required')
    await expect(DarkFactoryIngestionStore.open('/var/tmp', { projectId: '../escape' })).rejects.toThrow(/Invalid ingress/)
    expect(await readFile(filename, 'utf8')).toBe('')
  })

  it.each(['partial', 'unknown', 'duplicate', 'whitespace'])('preserves and refuses %s journal bytes', async kind => {
    const { store, directory, filename } = await open()
    await store.recordReceived(request())
    await store.close()
    if (kind === 'partial') await appendFile(filename, '{')
    else {
      let bytes = await readFile(filename, 'utf8')
      if (kind === 'unknown') bytes = bytes.replace('"version":1', '"version":2')
      if (kind === 'duplicate') bytes = bytes.replace('"version":1', '"version":1,"version":1')
      if (kind === 'whitespace') bytes = ' ' + bytes
      await writeFile(filename, bytes)
    }
    const evidence = await readFile(filename)
    await expect(DarkFactoryIngestionStore.open(directory, { projectId: 'project-1' })).rejects.toThrow(/Invalid|Incomplete/)
    expect(await readFile(filename)).toEqual(evidence)
  })
})

describe('provider-read custody and versioned cross-transport attachments', () => {
  function observations() {
    const webhook = request()
    webhook.envelope.bodyDigest = webhook.envelope.artifact.digest
    const { signingKeyId: _key, ...fields } = webhook.envelope as typeof examples.InboundEnvelopeV1
    const envelope = inboundEnvelopeSchema.parse({ ...fields, id: 'scan-envelope', authentication: 'provider-api',
      providerRead: { scannerId: 'host-scanner:github', ruleId: 'rule', requestReceiptId: 'request-1', responseDigest: digestJson('provider-response'), observedAt: fields.receivedAt } })
    const item = inboundWorkItemSchema.parse({ ...webhook.item, envelopeId: envelope.id, actor: 'host-scanner:github',
      initiator: { kind: 'host-scanner', scannerId: 'host-scanner:github', ruleId: 'rule' }, provenance: [envelope.artifact] })
    return { webhook, scanner: { envelope, item, bodySizeBytes: envelope.artifact.sizeBytes } }
  }
  const fence = (store: DarkFactoryIngestionStore, envelopeId: string) => ({ projectId: 'project-1', expectedRevision: store.snapshot().revision, envelopeId })
  it.each([false, true])('dedupes scanner and webhook work in both orders (scanner first: %s) while retaining the original unresolved authority', async scannerFirst => {
    const { store, directory, filename } = await open(), input = observations()
    const first = scannerFirst ? input.scanner : input.webhook, second = scannerFirst ? input.webhook : input.scanner
    const a = await store.recordReceived({ envelope: first.envelope, bodySizeBytes: first.bodySizeBytes })
    const original = await store.attachItem({ ...fence(store, first.envelope.id), item: first.item })
    const b = await store.recordReceived({ envelope: second.envelope, bodySizeBytes: second.bodySizeBytes })
    // Identical delivery ID/body digest in different transport namespaces is separate custody.
    expect(b.duplicate).toBe(false); expect(b.receipt.id).not.toBe(a.receipt.id)
    const alias = await store.attachItem({ ...fence(store, second.envelope.id), item: second.item })
    expect(alias).toMatchObject({ duplicate: true, receipt: { decision: 'attached', itemId: first.item.id } })
    expect(alias.item).toEqual(original.item)
    expect(alias.item).toMatchObject({ state: 'received', trust: { decision: 'unresolved' }, actor: first.item.actor, envelopeId: first.envelope.id })
    expect(store.snapshot().items).toHaveLength(1)
    const journal = (await readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(journal.filter(event => event.type === 'attached').every(event => event.comparisonVersion === 2)).toBe(true)
    const snapshot = store.snapshot(); await store.close()
    const replay = (await open({}, directory)).store
    expect(replay.snapshot()).toEqual(snapshot)
    expect((await replay.attachItem({ ...fence(replay, second.envelope.id), item: second.item })).receipt).toEqual(alias.receipt)
    expect((await replay.recordReceived({ envelope: { ...input.scanner.envelope, id: 'scan-retry', deliveryId: 'scan-redelivery' }, bodySizeBytes: input.scanner.bodySizeBytes })).duplicate).toBe(true)
  })
  it('requires exact custody initiator and observation bytes, and never relaxes same-envelope or execution content matching', async () => {
    const { store, filename } = await open(), { scanner } = observations()
    const empty = await readFile(filename)
    await expect(store.recordReceived({ envelope: scanner.envelope, bodySizeBytes: scanner.bodySizeBytes + 1 })).rejects.toThrow(/byte size/)
    expect(await readFile(filename)).toEqual(empty)
    await store.recordReceived({ envelope: scanner.envelope, bodySizeBytes: scanner.bodySizeBytes })
    for (const item of [{ ...scanner.item, actor: 'human' }, { ...scanner.item, initiator: { ...scanner.item.initiator!, ruleId: 'other' } }, { ...scanner.item, initiator: undefined }]) {
      const value = JSON.parse(JSON.stringify(item))
      await expect(store.attachItem({ ...fence(store, scanner.envelope.id), item: value })).rejects.toThrow(/actor|initiator/)
    }
    const original = await store.attachItem({ ...fence(store, scanner.envelope.id), item: scanner.item })
    await expect(store.attachItem({ ...fence(store, scanner.envelope.id), item: { ...scanner.item, context: 'changed' } })).rejects.toMatchObject({ code: 'ATTACHMENT_CONFLICT_REQUIRES_ESCALATION' })
    const envelope = { ...scanner.envelope, id: 'next-scan', deliveryId: 'next-scan', bodyDigest: digestJson('new-observation'), artifact: { ...scanner.envelope.artifact, digest: digestJson('new-observation') } }
    await store.recordReceived({ envelope, bodySizeBytes: scanner.bodySizeBytes })
    await expect(store.attachItem({ ...fence(store, envelope.id), item: { ...scanner.item, envelopeId: envelope.id, title: 'changed', provenance: [envelope.artifact] } })).rejects.toMatchObject({ code: 'ATTACHMENT_CONFLICT_REQUIRES_ESCALATION' })
    expect(store.snapshot().items).toEqual([original.item])
  })
  it('preserves non-scanner actor conflicts and their original unversioned journal replay', async () => {
    const { store, directory, filename } = await open(), first = request(), second = request(2)
    second.item.sourceRevision = first.item.sourceRevision; second.item.trust.entityRevision = first.item.sourceRevision
    second.item.actor = 'another-webhook-actor'
    for (const input of [first, second]) await store.recordReceived({ envelope: input.envelope, bodySizeBytes: input.bodySizeBytes })
    await store.attachItem({ ...fence(store, first.envelope.id), item: first.item })
    await expect(store.attachItem({ ...fence(store, second.envelope.id), item: second.item })).rejects.toMatchObject({ code: 'ATTACHMENT_CONFLICT_REQUIRES_ESCALATION' })
    await store.attachItem({ ...fence(store, second.envelope.id), item: second.item, healthEscalationId: 'actual-health-reference' })
    const expected = store.snapshot(); await store.close()
    // Restore the original event layout, whose attachment comparator included actor.
    const events = (await readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    let previousHash = null
    const lines = events.map(event => {
      delete event.comparisonVersion; delete event.hash; event.previousHash = previousHash
      for (;;) {
        const complete = { ...event, hash: digestJson(event) }, bytes = JSON.stringify(complete) + '\n'
        if (Buffer.byteLength(bytes) === event.storageBytes) { previousHash = complete.hash; return bytes }
        event.storageBytes = Buffer.byteLength(bytes)
      }
    }).join('')
    await writeFile(filename, lines)
    const replay = (await open({}, directory)).store.snapshot()
    expect(replay.items).toEqual(expected.items); expect(replay.attachments).toEqual(expected.attachments)
    expect(replay.aliases).toEqual(expected.aliases)
    expect(await readFile(filename, 'utf8')).toBe(lines)
  })
})


describe('factory storage path containment', () => {
  async function roots() {
    const root = await mkdtemp(join(tmpdir(), 'factory-safe-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'factory-outside-'))
    dirs.push(root, outside)
    return { root, outside }
  }
  it.each(['darkfactory', 'project', 'artifacts'].flatMap(component => [true, false].map(exists => ({ component, exists }))))('rejects a $component symlink with target existing=$exists before writing any outside child', async ({ component, exists }) => {
    const { root, outside } = await roots()
    if (component !== 'darkfactory') await mkdir(join(root, 'darkfactory'))
    if (component === 'artifacts') await mkdir(join(root, 'darkfactory', 'project-1'))
    const target = component === 'darkfactory' ? join(root, 'darkfactory') : component === 'project' ? join(root, 'darkfactory', 'project-1') : join(root, 'darkfactory', 'project-1', 'artifacts')
    await symlink(exists ? outside : join(outside, 'absent-target'), target)
    await expect(ensureFactoryDirectory(root, 'project-1', 'artifacts')).rejects.toThrow(/Unsafe/)
    if (component !== 'artifacts') await expect(DarkFactoryIngestionStore.open(root, { projectId: 'project-1' })).rejects.toThrow(/Unsafe/)
    expect(await readdir(outside)).toEqual([])
  })
  it('rejects symlinked coordinator roots and nondirectory components', async () => {
    const { root, outside } = await roots()
    await symlink(outside, join(root, 'aliased-root'))
    await expect(ensureFactoryDirectory(join(root, 'aliased-root'), 'project-1')).rejects.toThrow(/Unsafe/)
    expect(await readdir(outside)).toEqual([])
    await writeFile(join(root, 'darkfactory'), 'preserve this file')
    await expect(ensureFactoryDirectory(root, 'project-1')).rejects.toThrow(/Unsafe/)
    expect(await readFile(join(root, 'darkfactory'), 'utf8')).toBe('preserve this file')
  })
  it.each([false, true])('refuses a journal symlink with target existing=%s and preserves outside bytes', async exists => {
    const { root, outside } = await roots()
    const partition = await ensureFactoryDirectory(root, 'project-1')
    await partition.close()
    const target = join(outside, 'target.jsonl')
    if (exists) await writeFile(target, 'outside sentinel')
    await symlink(target, join(root, 'darkfactory', 'project-1', 'ingestion.jsonl'))
    await expect(DarkFactoryIngestionStore.open(root, { projectId: 'project-1' })).rejects.toThrow()
    if (exists) expect(await readFile(target, 'utf8')).toBe('outside sentinel')
    else expect(await readdir(outside)).toEqual([])
  })
  it('keeps child access on the pinned directory after its display path is replaced by a symlink', async () => {
    const { root, outside } = await roots()
    const partition = await ensureFactoryDirectory(root, 'project-1', 'artifacts')
    try {
      await rename(partition.path, join(root, 'retained-artifacts'))
      await symlink(outside, partition.path)
      await writeFile(join(partition.descriptorPath, 'probe'), 'pinned')
      expect(await readFile(join(root, 'retained-artifacts', 'probe'), 'utf8')).toBe('pinned')
      expect(await readdir(outside)).toEqual([])
    } finally { await partition.close() }
  })
})


it('rejects oversized unterminated ingress replay at the configured streaming bound and releases ownership', async () => {
  const { store, directory, filename } = await open({ maxRecordBytes: 1024 })
  await store.close()
  const file = await openFile(filename, 'w')
  try { await file.truncate(134_217_728) } finally { await file.close() }
  const before = await stat(filename)
  await expect(DarkFactoryIngestionStore.open(directory, { projectId: 'project-1', maxRecordBytes: 1024 })).rejects.toThrow(/record byte limit/)
  const after = await stat(filename)
  expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs])
  // Failed replay retained no process ownership; replacing the fixture explicitly permits reopening.
  await writeFile(filename, '')
  const restored = await open({ maxRecordBytes: 1024 }, directory)
  expect(restored.store.snapshot().revision).toBe(0)
})

describe('durable reconciliation attachments and retry cursors', () => {
  const at = '2026-09-06T12:00:00Z'
  const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString()
  const fence = (store: DarkFactoryIngestionStore, envelopeId = 'envelope-1') => ({ projectId: 'project-1', expectedRevision: store.snapshot().revision, envelopeId })
  async function custody(store: DarkFactoryIngestionStore, input = request()) {
    return store.recordReceived({ envelope: input.envelope, bodySizeBytes: input.bodySizeBytes })
  }

  it('replays attached unresolved work and stable receipt, then resolves only after separate trust transition', async () => {
    const { store, directory } = await open()
    const input = request()
    const received = await custody(store)
    await store.beginReconciliation({ ...fence(store), at })
    const attached = await store.attachItem({ ...fence(store), item: input.item })
    expect(attached).toMatchObject({ duplicate: false, receipt: { decision: 'attached', itemId: input.item.id }, item: { state: 'received', trust: { decision: 'unresolved' } } })
    await expect(store.finishReconciliation({ ...fence(store), attempt: 1, outcome: 'resolved', at, reason: 'RECONCILIATION_COMPLETE' })).rejects.toThrow(/separately trusted/)
    const snapshot = store.snapshot()
    await store.close()
    const replay = (await open({}, directory)).store
    expect(replay.snapshot()).toEqual(snapshot)
    const duplicate = await replay.attachItem({ ...fence(replay), item: input.item })
    expect(duplicate.receipt).toEqual(attached.receipt)
    expect(duplicate.duplicate).toBe(true)
    expect(replay.snapshot().items).toHaveLength(1)
    await replay.transition({ projectId: 'project-1', expectedRevision: 1, item: { ...input.item, state: 'trusted', revision: 2, trust: { ...input.item.trust, decision: 'trusted' } } })
    const resolved = await replay.finishReconciliation({ ...fence(replay), attempt: 1, outcome: 'resolved', at, reason: 'RECONCILIATION_COMPLETE' })
    expect(resolved).toMatchObject({ status: 'resolved', attempts: 1, lastAttemptAt: at })
    expect(replay.snapshot().custody[0]!.receipt).toEqual(received.receipt)
    expect(replay.pendingReconciliations({ projectId: 'project-1', at: later(20), limit: 100 })).toEqual([])
    await expect(replay.beginReconciliation({ ...fence(replay), at: later(20) })).rejects.toThrow(/Terminal/)
  })

  it('aliases equal execution content across envelopes without replacing provenance or trusted state', async () => {
    const { store } = await open()
    const input = request()
    await custody(store, input)
    await store.attachItem({ ...fence(store), item: input.item })
    const trusted = await store.transition({ projectId: 'project-1', expectedRevision: 1, item: { ...input.item, state: 'trusted', revision: 2, trust: { ...input.item.trust, decision: 'trusted' } } })
    const other = request(2)
    other.item.sourceRevision = input.item.sourceRevision
    other.item.trust.entityRevision = input.item.sourceRevision
    other.item.trust.checkedAt = later(5)
    await custody(store, other)
    const result = await store.attachItem({ ...fence(store, other.envelope.id), item: other.item })
    expect(result).toMatchObject({ duplicate: true, receipt: { decision: 'attached', itemId: input.item.id } })
    expect(result.item).toEqual(trusted)
    expect(store.snapshot().items).toEqual([trusted])
    expect(store.snapshot().custody[1]!.itemId).toBe(input.item.id)
  })

  it('rejects stale, cross-project, wrong provenance, privileged and unknown attachment inputs without writes', async () => {
    const { store, filename } = await open()
    const input = request()
    await custody(store)
    const good = { ...fence(store), item: input.item }
    const before = await readFile(filename)
    await expect(store.attachItem({ ...good, expectedRevision: 0 })).rejects.toThrow(/Stale/)
    await expect(store.attachItem({ ...good, projectId: 'other' })).rejects.toThrow(/Cross-project/)
    await expect(store.attachItem({ ...good, item: { ...input.item, policyRevision: 99 } })).rejects.toThrow(/identity/)
    await expect(store.attachItem({ ...good, item: { ...input.item, provenance: [{ ...input.item.provenance[0]!, id: 'other-artifact' }] } })).rejects.toThrow(/provenance/)
    await expect(store.attachItem({ ...good, item: { ...input.item, state: 'trusted', trust: { ...input.item.trust, decision: 'trusted' } } })).rejects.toThrow(/unresolved/)
    await expect(store.attachItem({ ...good, 'secret-bearing-field': true } as never)).rejects.toThrow('Invalid ingress authority input: strict bounded JSON required')
    expect(await readFile(filename)).toEqual(before)
  })

  it('requires real escalation for source/content conflicts and preserves original work and custody', async () => {
    const { store } = await open()
    const input = request()
    const original = await custody(store)
    await store.attachItem({ ...fence(store), item: input.item })
    const changed = request(2)
    await custody(store, changed)
    await expect(store.attachItem({ ...fence(store, changed.envelope.id), item: changed.item })).rejects.toMatchObject({ code: 'SOURCE_CHANGE_REQUIRES_ESCALATION' })
    const quarantine = await store.attachItem({ ...fence(store, changed.envelope.id), item: changed.item, healthEscalationId: 'health-source' })
    expect(quarantine.receipt).toMatchObject({ decision: 'quarantined', reason: 'SOURCE_CHANGED', healthEscalationId: 'health-source' })
    expect((await store.attachItem({ ...fence(store, changed.envelope.id), item: changed.item })).receipt).toEqual(quarantine.receipt)
    const conflict = request(3)
    conflict.item.sourceRevision = input.item.sourceRevision
    conflict.item.trust.entityRevision = input.item.sourceRevision
    conflict.item.title = 'different execution content'
    await custody(store, conflict)
    await expect(store.attachItem({ ...fence(store, conflict.envelope.id), item: conflict.item })).rejects.toMatchObject({ code: 'ATTACHMENT_CONFLICT_REQUIRES_ESCALATION' })
    await store.attachItem({ ...fence(store, conflict.envelope.id), item: conflict.item, healthEscalationId: 'health-content' })
    expect(store.snapshot().items).toEqual([input.item])
    expect(store.snapshot().custody[0]!.receipt).toEqual(original.receipt)
    const quarantined = request(4)
    await store.recordReceived({ envelope: quarantined.envelope, bodySizeBytes: 100, quarantineReason: 'SOURCE_DENIED', healthEscalationId: 'health-denied' })
    await expect(store.attachItem({ ...fence(store, quarantined.envelope.id), item: quarantined.item })).rejects.toThrow(/Successful ingress custody/)
  })

  it('persists retry leases and exhaustion so a restarted third attempt can quarantine without a fourth fetch', async () => {
    const { store, directory } = await open()
    await custody(store)
    const first = await store.beginReconciliation({ ...fence(store), at })
    expect(first).toMatchObject({ attempts: 1, status: 'pending', nextAttemptAt: later(5), lastAttemptAt: at })
    expect(store.pendingReconciliations({ projectId: 'project-1', at, limit: 10 })).toEqual([])
    await expect(store.beginReconciliation({ ...fence(store), at })).rejects.toThrow(/not due/)
    await expect(store.finishReconciliation({ ...fence(store), attempt: 2, outcome: 'retry', at, reason: 'PROVIDER_UNAVAILABLE' })).rejects.toThrow(/Stale/)
    await store.finishReconciliation({ ...fence(store), attempt: 1, outcome: 'retry', at, reason: 'PROVIDER_UNAVAILABLE' })
    await store.close()
    const replay = (await open({}, directory)).store
    expect(replay.pendingReconciliations({ projectId: 'project-1', at: later(5), limit: 10 })[0]!.cursor).toMatchObject({ attempts: 1, lastReason: 'PROVIDER_UNAVAILABLE' })
    await replay.beginReconciliation({ ...fence(replay), at: later(5) })
    await replay.finishReconciliation({ ...fence(replay), attempt: 2, outcome: 'retry', at: later(5), reason: 'PROVIDER_RATE_LIMITED' })
    await replay.beginReconciliation({ ...fence(replay), at: later(10) })
    await replay.close()
    const crashed = (await open({}, directory)).store
    expect(crashed.pendingReconciliations({ projectId: 'project-1', at: later(15), limit: 1 })[0]!.cursor!.attempts).toBe(3)
    await expect(crashed.beginReconciliation({ ...fence(crashed), at: later(15) })).rejects.toThrow(/exhausted/)
    await expect(crashed.finishReconciliation({ ...fence(crashed), attempt: 3, outcome: 'retry', at: later(15), reason: 'PROVIDER_UNAVAILABLE' })).rejects.toThrow(/Exhausted/)
    await expect(crashed.finishReconciliation({ ...fence(crashed), attempt: 3, outcome: 'quarantined', at: later(15), reason: 'RECONCILIATION_EXHAUSTED' })).rejects.toThrow(/health escalation/)
    const final = await crashed.finishReconciliation({ ...fence(crashed), attempt: 3, outcome: 'quarantined', at: later(15), reason: 'RECONCILIATION_EXHAUSTED', healthEscalationId: 'health-exhausted' })
    expect(final).toMatchObject({ status: 'quarantined', attempts: 3, lastAttemptAt: later(10), healthEscalationId: 'health-exhausted' })
    expect(crashed.pendingReconciliations({ projectId: 'project-1', at: later(20), limit: 100 })).toEqual([])
    await expect(crashed.attachItem({ ...fence(crashed), item: request().item })).rejects.toThrow(/Quarantined/)
  })

  it('filters configured routes before bounded pending selection and sanitizes cursor inputs', async () => {
    const { store, filename } = await open()
    await custody(store)
    const second = request(2)
    second.envelope.routeId = 'route-selected'
    await custody(store, second)
    const selected = store.pendingReconciliations({ projectId: 'project-1', at, limit: 1, routeIds: ['route-selected'] })
    expect(selected.map(entry => entry.custody.envelope.id)).toEqual(['envelope-2'])
    expect(() => store.pendingReconciliations({ projectId: 'project-1', at, limit: 101 })).toThrow(/strict bounded JSON/)
    expect(() => store.pendingReconciliations({ projectId: 'other', at, limit: 1 })).toThrow(/Cross-project/)
    const before = await readFile(filename)
    await expect(store.beginReconciliation({ ...fence(store), at, unknown: 'secret' } as never)).rejects.toThrow(/strict bounded JSON/)
    await expect(store.finishReconciliation({ ...fence(store), attempt: 1, outcome: 'retry', at, reason: 'arbitrary-sensitive-diagnostic' } as never)).rejects.toThrow(/strict bounded JSON/)
    expect(await readFile(filename)).toEqual(before)
  })

  it('applies existing byte capacity before attachment or cursor writes', async () => {
    const { store, filename } = await open({ maxRecordBytes: 2048, maxJournalBytes: 2048 })
    await custody(store)
    const before = await readFile(filename)
    await expect(store.attachItem({ ...fence(store), item: { ...request().item, context: 'x'.repeat(5000) } })).rejects.toThrow(/capacity/)
    expect(await readFile(filename)).toEqual(before)
    let capacityReached = false
    for (let index = 0; index < 3; index++) {
      const bytes = await readFile(filename)
      try {
        await store.beginReconciliation({ ...fence(store), at: later(index * 5) })
      } catch (error) {
        expect(String(error)).toMatch(/capacity/)
        expect(await readFile(filename)).toEqual(bytes)
        capacityReached = true
        break
      }
      const startedBytes = await readFile(filename)
      try {
        await store.finishReconciliation({ ...fence(store), attempt: index + 1, outcome: index === 2 ? 'quarantined' : 'retry', at: later(index * 5), reason: index === 2 ? 'RECONCILIATION_EXHAUSTED' : 'PROVIDER_UNAVAILABLE', ...(index === 2 ? { healthEscalationId: 'health-exhausted' } : {}) })
      } catch (error) {
        expect(String(error)).toMatch(/capacity/)
        expect(await readFile(filename)).toEqual(startedBytes)
        capacityReached = true
        break
      }
    }
    expect(capacityReached).toBe(true)
  })

  it('fences concurrent begins and rejects inconsistent outcome diagnostics without mutation', async () => {
    const { store, filename } = await open()
    await custody(store)
    const begin = { ...fence(store), at }
    const outcomes = await Promise.allSettled([store.beginReconciliation(begin), store.beginReconciliation(begin)])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    const before = await readFile(filename)
    await expect(store.finishReconciliation({ ...fence(store), attempt: 1, outcome: 'retry', at, reason: 'RECONCILIATION_COMPLETE' })).rejects.toThrow(/reason mismatch/)
    await expect(store.finishReconciliation({ ...fence(store), attempt: 1, outcome: 'quarantined', at, reason: 'RECONCILED', healthEscalationId: 'health-invalid' })).rejects.toThrow(/reason mismatch/)
    expect(await readFile(filename)).toEqual(before)
    expect(store.snapshot().reconciliations[0]!.attempts).toBe(1)
  })

})
