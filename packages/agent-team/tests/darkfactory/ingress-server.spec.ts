import { afterEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdtemp, open, readFile, readdir, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DarkFactoryIngressServer, type IngressServerHost } from '../../src/darkfactory/ingress-server.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { digestBytes, digestJson } from '../../src/darkfactory/json.ts'
import { enabledPolicy } from './config-fixture.ts'

const secret = 'synthetic-webhook-test-key', marker = 'raw-secret-DO-NOT-PERSIST'
const now = Date.parse('2026-09-06T12:00:00Z')
const directories: string[] = [], servers: DarkFactoryIngressServer[] = [], stores: DarkFactoryIngestionStore[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
function payload(title = 'Empty request fails') {
  return JSON.stringify({ action: 'opened', repository: { id: 'repository', full_name: 'example/service' }, sender: { id: 'sender' }, installation: { id: 10 },
    issue: { id: 42, number: 1, title, body: marker, user: { id: 'sender' }, labels: [{ name: 'automate' }], state: 'open', updated_at: '2026-09-06T11:00:00Z' },
    credentials: marker })
}
async function persistedText(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? persistedText(join(directory, entry.name)) : readFile(join(directory, entry.name), 'utf8')))).join('\n')
}
async function serve(options: { rate?: number; maxBodyBytes?: number; maxQueueItems?: number; maxArtifactBytes?: number; maxArtifactTotalBytes?: number; beforeOpen?: (directory: string) => Promise<void>; beforeQuarantine?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-http-')); directories.push(directory)
  const policy = enabledPolicy()
  policy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
  policy.limits.maxArtifactBytes = options.maxArtifactBytes ?? 1_048_576
  policy.limits.maxArtifactTotalBytes = options.maxArtifactTotalBytes ?? policy.limits.maxArtifactTotalBytes
  policy.ingestion.requestsPerMinute = options.rate ?? 10
  policy.ingestion.maxBodyBytes = options.maxBodyBytes ?? 1000
  policy.ingestion.maxQueueItems = options.maxQueueItems ?? policy.ingestion.maxQueueItems
  const storeOptions = { projectId: 'project', maxBodyBytes: policy.ingestion.maxBodyBytes, maxQueueItems: policy.ingestion.maxQueueItems }
  const store = await DarkFactoryIngestionStore.open(directory, storeOptions, () => new Date(now).toISOString()); stores.push(store)
  const healthFile = join(directory, 'fixture-health-inbox.jsonl')
  const host: IngressServerHost = {
    directory, stores: new Map([['project', store]]), resolveSecret: async () => secret, clock: () => now,
    sanitize: facts => ({ sourceEntityId: facts.sourceEntityId, trust: facts.trust, context: '[redacted]', kind: facts.details.kind }),
    quarantine: async input => {
      await options.beforeQuarantine?.()
      const id = `health:${digestJson(input).slice(7, 31)}`
      const file = await open(healthFile, 'a+', 0o600)
      try {
        const existing = await file.readFile('utf8')
        if (!existing.split('\n').filter(Boolean).some(line => JSON.parse(line).id === id)) await file.writeFile(`${JSON.stringify({ id, ...input })}\n`)
        await file.sync()
      } finally { await file.close() }
      const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
      return id
    },
  }
  await options.beforeOpen?.(directory)
  const server = await DarkFactoryIngressServer.open(policy, host); servers.push(server)
  return { server, store, directory, storeOptions, healthFile, policy, host, artifactDirectory: join(directory, 'darkfactory/project/artifacts') }
}
interface Response { status: number; body: Record<string, any>; text: string; headers: Record<string, string | string[] | undefined> }
function post(server: DarkFactoryIngressServer, body = payload(), options: { delivery?: string; signature?: string; path?: string; headers?: Record<string, string | string[]>; chunked?: boolean } = {}): Promise<Response> {
  const address = server.address()
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: address.address, port: address.port, method: 'POST', path: options.path ?? '/darkfactory/v1/ingress/github/route', agent: false,
      headers: { 'content-type': 'application/json', 'x-github-delivery': options.delivery ?? 'delivery-1', 'x-github-event': 'issues',
        'x-hub-signature-256': options.signature ?? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        ...(!options.chunked ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...options.headers },
    }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk })
      response.on('error', reject)
      response.on('end', () => { let parsed = {}; try { parsed = JSON.parse(text) } catch {} resolve({ status: response.statusCode!, body: parsed, text, headers: response.headers }) })
    })
    request.setTimeout(3000, () => request.destroy(new Error('HTTP fixture deadline exceeded')))
    request.on('error', reject)
    if (options.chunked) { request.write(body.slice(0, 20)); request.end(body.slice(20)) } else request.end(body)
  })
}

describe('real loopback ingress custody service', () => {
  it('acknowledges durable custody, deduplicates delivery and body aliases, and replays after shutdown', async () => {
    const fixture = await serve()
    expect(fixture.server.address()).toMatchObject({ address: '127.0.0.1', port: expect.any(Number) })
    expect(fixture.server.address().port).toBeGreaterThan(0)
    const first = await post(fixture.server)
    expect(first).toMatchObject({ status: 202, body: { duplicate: false, conflict: false, receipt: { decision: 'received', projectId: 'project', bodyDigest: digestBytes(payload()) } } })
    expect(fixture.store.snapshot().custody).toHaveLength(1)
    for (const delivery of ['delivery-1', 'delivery-2']) {
      const retry = await post(fixture.server, payload(), { delivery })
      expect(retry).toMatchObject({ status: 200, body: { duplicate: true, conflict: false, receipt: first.body.receipt } })
    }
    const snapshot = fixture.store.snapshot()
    expect(snapshot.custody).toHaveLength(1); expect(snapshot.audits).toHaveLength(3)
    expect(snapshot.items).toEqual([])
    await fixture.server.close(); await fixture.store.close()
    const replayed = await DarkFactoryIngestionStore.open(fixture.directory, fixture.storeOptions); stores.push(replayed)
    expect(replayed.snapshot()).toEqual(snapshot)
  })
  it('persists only host-sanitized artifacts and safe custody metadata', async () => {
    const fixture = await serve()
    expect((await post(fixture.server, payload(marker), { headers: { authorization: `Bearer ${marker}` } })).status).toBe(202)
    const names = await readdir(fixture.artifactDirectory)
    expect(names).toHaveLength(1)
    const bytes = await readFile(join(fixture.artifactDirectory, names[0]!))
    expect(JSON.parse(bytes.toString())).toEqual({ sourceEntityId: 'issue:repository:42', trust: 'unresolved', context: '[redacted]', kind: 'issue' })
    const artifact = fixture.store.snapshot().custody[0]!.envelope.artifact
    expect(artifact.digest).toBe(digestBytes(bytes)); expect(artifact.sizeBytes).toBe(bytes.length)
    const disk = await persistedText(fixture.directory)
    expect(disk).not.toContain(marker); expect(disk).not.toContain(secret); expect(disk).not.toContain('authorization')
  })
  it('rejects forged signatures before creating artifacts or custody', async () => {
    const fixture = await serve()
    expect(await post(fixture.server, payload(), { signature: `sha256=${'0'.repeat(64)}` })).toMatchObject({ status: 401, body: { error: 'AUTHENTICATION_INVALID' } })
    expect(fixture.store.snapshot().custody).toEqual([])
    expect(await readdir(fixture.artifactDirectory)).toEqual([])
    expect(await persistedText(fixture.directory)).not.toContain(marker)
  })
  it('durably quarantines a delivery ID reused with different bytes and deduplicates that quarantine', async () => {
    const fixture = await serve()
    await post(fixture.server)
    const changed = payload('Changed source content')
    const conflict = await post(fixture.server, changed)
    expect(conflict).toMatchObject({ status: 202, body: { conflict: true, duplicate: false, receipt: { decision: 'quarantined' } } })
    const custody = fixture.store.snapshot().custody
    expect(custody).toHaveLength(2)
    expect(custody[1]).toMatchObject({ quarantineReason: 'DELIVERY_ID_CONFLICT', healthEscalationId: expect.any(String) })
    const health = (await readFile(fixture.healthFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(health).toContainEqual(expect.objectContaining({ id: custody[1]!.healthEscalationId, projectId: 'project' }))
    expect(await post(fixture.server, changed)).toMatchObject({ status: 200, body: { conflict: true, duplicate: true, receipt: conflict.body.receipt } })
    expect(fixture.store.snapshot().custody).toHaveLength(2)
  })
  it('takes durable quarantine custody of authenticated malformed JSON without persisting its bytes', async () => {
    const fixture = await serve()
    const malformed = `{"secret":"${marker}","secret":"duplicate"}`
    const result = await post(fixture.server, malformed)
    expect(result).toMatchObject({ status: 202, body: { receipt: { decision: 'quarantined', bodyDigest: digestBytes(malformed) } } })
    const custody = fixture.store.snapshot().custody
    expect(custody).toHaveLength(1)
    expect(custody[0]!.healthEscalationId).toBeTruthy()
    expect(await readFile(fixture.healthFile, 'utf8')).toContain(custody[0]!.healthEscalationId!)
    expect(await persistedText(fixture.directory)).not.toContain(marker)
    expect(await post(fixture.server, malformed)).toMatchObject({ status: 200, body: { duplicate: true, receipt: result.body.receipt } })
  })
  it('redacts unsupported authenticated native event headers before quarantine persistence', async () => {
    const fixture = await serve(), headerSecret = 'header-secret-DO-NOT-PERSIST'
    const result = await post(fixture.server, payload(), { headers: { 'x-github-event': headerSecret } })
    expect(result).toMatchObject({ status: 202, body: { receipt: { decision: 'quarantined' } } })
    expect(fixture.store.snapshot().custody[0]).toMatchObject({ envelope: { eventKind: 'unsupported' }, quarantineReason: 'EVENT_UNSUPPORTED', healthEscalationId: expect.any(String) })
    expect(await persistedText(fixture.directory)).not.toContain(headerSecret)
    expect(await persistedText(fixture.directory)).not.toContain(marker)
  })
  it('bounds declared bodies, parser headers, duplicate headers and registered routes', async () => {
    const fixture = await serve()
    expect((await post(fixture.server, 'x'.repeat(1001))).status).toBe(413)
    expect((await post(fixture.server, payload(), { headers: { 'x-oversized': 'x'.repeat(17000) } })).status).toBe(431)
    expect((await post(fixture.server, payload(), { headers: { 'x-github-delivery': ['delivery-1', 'delivery-2'] } })).status).toBe(400)
    expect((await post(fixture.server, payload(), { path: '/darkfactory/v1/ingress/github/unregistered' })).status).toBe(404)
    expect((await post(fixture.server, payload(), { headers: { 'content-encoding': 'gzip' } })).status).toBe(415)
    expect(fixture.store.snapshot().custody).toEqual([])
  })
  it('bounds streamed bodies without trusting content-length', async () => {
    const fixture = await serve()
    expect((await post(fixture.server, 'x'.repeat(1001), { chunked: true })).status).toBe(413)
    expect(fixture.store.snapshot().custody).toEqual([])
  })
  it('applies per-route and global token buckets before acknowledging excess requests', async () => {
    const fixture = await serve({ rate: 1 })
    expect((await post(fixture.server)).status).toBe(202)
    expect(await post(fixture.server)).toMatchObject({ status: 429, headers: { 'retry-after': '60' } })
    expect(fixture.store.snapshot().audits).toHaveLength(1)
    const global = await serve()
    for (let index = 0; index < 20; index++) expect((await post(global.server, '', { path: '/unknown' })).status).toBe(404)
    expect(await post(global.server, '', { path: '/unknown' })).toMatchObject({ status: 429, body: { error: 'GLOBAL_RATE_LIMIT' } })
  })
  it('bounds orphan artifacts after queue saturation, preserves duplicate receipts at capacity, and accounts for orphans on restart', async () => {
    const artifactBytes = Buffer.byteLength(JSON.stringify({ sourceEntityId: 'issue:repository:42', trust: 'unresolved', context: '[redacted]', kind: 'issue' }))
    const fixture = await serve({ rate: 20, maxQueueItems: 1, maxArtifactBytes: artifactBytes, maxArtifactTotalBytes: artifactBytes * 2 })
    const first = await post(fixture.server)
    expect(first.status).toBe(202)
    const uniqueBody = (id: number) => {
      const value = JSON.parse(payload()); value.issue.id = id
      return JSON.stringify(value)
    }
    // The first refused custody can already have a published artifact; its exposure must remain accounted for.
    expect(await post(fixture.server, uniqueBody(43), { delivery: 'delivery-43' })).toMatchObject({ status: 503, body: { error: 'CUSTODY_UNAVAILABLE' } })
    const fullInventory = await readdir(fixture.artifactDirectory)
    expect(fullInventory).toHaveLength(2)
    for (let id = 44; id <= 49; id++) {
      expect(await post(fixture.server, uniqueBody(id), { delivery: `delivery-${id}` })).toMatchObject({ status: 503, body: { error: 'ARTIFACT_CAPACITY' } })
      expect(await readdir(fixture.artifactDirectory)).toEqual(fullInventory)
    }
    expect(fixture.store.snapshot().custody).toHaveLength(1)
    expect(await post(fixture.server)).toMatchObject({ status: 200, body: { duplicate: true, receipt: first.body.receipt } })
    const onDiskBytes = (await Promise.all(fullInventory.map(name => readFile(join(fixture.artifactDirectory, name))))).reduce((sum, bytes) => sum + bytes.length, 0)
    expect(onDiskBytes).toBe(fixture.policy.limits.maxArtifactTotalBytes)
    await fixture.server.close()
    const restarted = await DarkFactoryIngressServer.open(fixture.policy, fixture.host); servers.push(restarted)
    expect(await post(restarted, uniqueBody(50), { delivery: 'delivery-50' })).toMatchObject({ status: 503, body: { error: 'ARTIFACT_CAPACITY' } })
    expect(await post(restarted)).toMatchObject({ status: 200, body: { duplicate: true, receipt: first.body.receipt } })
    expect(await readdir(fixture.artifactDirectory)).toEqual(fullInventory)
  })
  it('rejects a symlinked artifact directory before listening and leaves the external directory untouched', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'factory-http-outside-')); directories.push(outside)
    await expect(serve({ beforeOpen: directory => symlink(outside, join(directory, 'darkfactory/project/artifacts'), 'dir') })).rejects.toThrow(/Unsafe .*directory/)
    expect(await readdir(outside)).toEqual([])
  })
  it('rejects a symlinked project ancestor with no artifact child before creating anything outside custody', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'factory-http-parent-outside-')); directories.push(outside)
    await expect(serve({ beforeOpen: async directory => {
      // Keep the actual store descriptor on its original inode while replacing the listener's pathname ancestor.
      await rename(join(directory, 'darkfactory/project'), join(directory, 'owned-project'))
      await symlink(outside, join(directory, 'darkfactory/project'), 'dir')
    } })).rejects.toThrow(/Unsafe .*directory/)
    expect(await readdir(outside)).toEqual([])
  })
  it('waits for pending durable quarantine work during controlled shutdown', async () => {
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fixture = await serve({ beforeQuarantine: async () => { entered(); await gate } })
    await post(fixture.server)
    const pending = post(fixture.server, payload('Changed for shutdown')).catch(error => error)
    await waiting
    let closed = false
    const closing = fixture.server.close().then(() => { closed = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
    } finally { release() }
    await closing; await pending
    expect(fixture.store.snapshot().custody[1]).toMatchObject({ quarantineReason: 'DELIVERY_ID_CONFLICT', healthEscalationId: expect.any(String) })
    expect(() => fixture.server.address()).toThrow(/closed/)
    await fixture.server.close()
  })
})
