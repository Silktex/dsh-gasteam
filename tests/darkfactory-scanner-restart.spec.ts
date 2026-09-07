import { fork, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { enabledPolicy } from '../packages/agent-team/tests/darkfactory/config-fixture.ts'
import { digestBytes } from '../packages/agent-team/src/darkfactory/json.ts'
import type { GithubScanState } from '../packages/agent-team/src/darkfactory/github-scan-store.ts'
import type { ProviderRequestState } from '../packages/agent-team/src/darkfactory/provider-request-store.ts'
import type { DarkFactoryIngestionStore } from '../packages/agent-team/src/darkfactory/ingestion-store.ts'
const token = 'isolated-scanner-installation-token', at = '2026-09-06T12:00:00.000Z', since = '2026-09-06T11:00:00.000Z'
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/var/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
interface Snapshot { barrier: string; pid: number; scans: GithubScanState; budget: ProviderRequestState; ingestion: ReturnType<DarkFactoryIngestionStore['snapshot']>; page: { entries: unknown[]; requestReceiptId: string }; lookups: unknown[] }
function launch(directory: string, mode: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-scanner.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env })
  let diagnostics = '', ended = false
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000) })
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => { ended = true; resolve({ code, signal }) }))
  const message = new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Scanner IPC deadline: ${diagnostics}`)) }, 10000)
    child.once('message', value => { clearTimeout(timer); const result = value as Snapshot & { message?: string; stack?: string }; result.barrier === 'error' ? reject(new Error(result.stack ?? result.message)) : resolve(result) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Scanner process exited ${code}: ${diagnostics}`)) })
  })
  child.send({ directory, mode })
  return { message, closed, async kill() { if (!ended) child.kill('SIGKILL'); return closed } }
}
const journals = (directory: string) => Promise.all(['darkfactory-github-scans.jsonl', 'darkfactory-provider-requests.jsonl', 'darkfactory/project/ingestion.jsonl'].map(path => readFile(join(directory, 'workspace', path))))

it('finishes a persisted two-entry scan page after SIGKILL without another provider read or fabricated current-entity trust', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-scanner-restart-')), children: ReturnType<typeof launch>[] = [], requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.setHeader('content-type', 'application/json')
    if (request.method !== 'GET' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end('{}'); return }
    if (request.url === '/installation/repositories?per_page=100&page=1') response.end(JSON.stringify({ total_count: 1, repositories: [{ id: 42, full_name: 'Owner/Repo' }] }))
    else if (request.url?.startsWith('/repos/owner/repo/issues?')) response.end(JSON.stringify([7, 8].map(number => ({ id: number + 93, number, updated_at: at, title: 'PRIVATE_SCANNER_NARRATIVE', body: token }))))
    else { response.writeHead(404); response.end('{}') }
  })
  try {
    const repository = join(directory, 'repository'); await mkdir(repository)
    const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args], { env })
    await git('init', '--initial-branch=main'); await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git')
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
    const policy = enabledPolicy(), route = policy.ingestion.routes[0]!
    policy.limits.maxArtifactBytes = 65536; policy.limits.maxArtifactTotalBytes = 1048576
    if (route.source !== 'github') throw new Error('Expected GitHub policy')
    route.repositoryIds = ['42']; route.senderIds = ['host-scanner:fixture']
    route.reconciliation = { apiBaseUrl: `http://127.0.0.1:${address.port}`, installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialKind: 'installation-token',
      credentialRef: { kind: 'file', path: join(directory, 'installation-token') }, fixtureLoopback: true, scan: { scannerId: 'host-scanner:fixture', ruleId: 'rule', initialSince: since, maxPages: 10 } }
    await writeFile(join(directory, 'installation-token'), token, { mode: 0o600 }); await writeFile(join(directory, 'policy.json'), JSON.stringify(policy), { mode: 0o600 })
    const writer = launch(directory, 'partial'); children.push(writer); const before = await writer.message
    expect(before.barrier).toBe('page-and-first-custody-durable')
    expect(requests).toEqual(['/installation/repositories?per_page=100&page=1', `/repos/owner/repo/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(since)}&per_page=100&page=1`])
    expect(before.budget.charges).toHaveLength(2); expect(before.ingestion.custody).toHaveLength(1); expect(before.ingestion.items).toEqual([])
    const cursor = before.scans.cursors[0]!, page = cursor.sweep!.pages[0]!, entries = page.entryIds
    expect(cursor).toMatchObject({ watermark: null, sweep: { status: 'active', since, cutoff: at, page: 1 } })
    expect(page.acknowledged).toBe(false); expect(entries).toHaveLength(2); expect(before.ingestion.custody[0]!.envelope.id).toBe(entries[0])
    expect(before.page.entries).toHaveLength(2); expect(before.page.requestReceiptId).toBe(before.budget.charges[1]!.id)
    const artifact = await readFile(join(directory, 'workspace/darkfactory/project/artifacts', page.artifact.id))
    expect(digestBytes(artifact)).toBe(page.artifact.digest); expect(artifact.length).toBe(page.artifact.sizeBytes)
    const prefix = await journals(directory)
    expect(await writer.kill()).toEqual({ code: null, signal: 'SIGKILL' })
    const reader = launch(directory, 'resume'); children.push(reader); const after = await reader.message
    expect(await reader.closed).toEqual({ code: 0, signal: null }); expect(after.pid).not.toBe(before.pid)
    expect(requests).toHaveLength(2); expect(after.budget).toEqual(before.budget)
    expect(after.ingestion.custody.map(value => value.envelope.id)).toEqual(entries)
    expect(after.ingestion.custody[0]).toEqual(before.ingestion.custody[0]); expect(new Set(after.ingestion.custody.map(value => value.receipt.id)).size).toBe(2)
    expect(after.scans.cursors[0]).toMatchObject({ watermark: at, nextAttemptAt: '2026-09-06T12:05:00.000Z', sweep: { id: cursor.sweep!.id, status: 'complete', pages: [{ acknowledged: true, entryIds: entries }] } })
    expect(after.ingestion.items).toEqual([]); expect(after.ingestion.reconciliations).toEqual([])
    for (const custody of after.ingestion.custody) {
      expect(custody.envelope).toMatchObject({ authentication: 'provider-api', providerRead: { scannerId: 'host-scanner:fixture', ruleId: 'rule', requestReceiptId: before.page.requestReceiptId } })
      expect(custody.envelope).not.toHaveProperty('signingKeyId'); expect(custody.receipt.decision).toBe('received')
    }
    const completed = await journals(directory); completed.forEach((bytes, index) => expect(bytes.subarray(0, prefix[index]!.length)).toEqual(prefix[index]))
    const replay = launch(directory, 'resume'); children.push(replay); const unchanged = await replay.message
    expect(await replay.closed).toEqual({ code: 0, signal: null }); expect(unchanged.pid).not.toBe(after.pid)
    expect(unchanged.scans).toEqual(after.scans); expect(unchanged.ingestion).toEqual(after.ingestion); expect(unchanged.budget).toEqual(after.budget)
    expect(unchanged.page).toEqual(after.page); expect(unchanged.lookups).toEqual(after.lookups); expect(requests).toHaveLength(2)
    expect(await journals(directory)).toEqual(completed)
    const persisted = Buffer.concat(completed).toString('utf8') + artifact.toString('utf8') + JSON.stringify(after.lookups)
    expect(persisted).not.toContain(token); expect(persisted).not.toContain('PRIVATE_SCANNER_NARRATIVE')
  } finally {
    await Promise.all(children.map(child => child.kill())); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true })
  }
}, 30000)
