import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DarkFactoryObserver } from '../../src/darkfactory/observer.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { HealthStore } from '../../src/health.ts'
import { githubReconciliationRegistrationSchema, enabledDarkFactoryConfigSchema } from '../../src/darkfactory/config.ts'
import { runGit } from '../../src/git-command.ts'
import { enabledPolicy } from './config-fixture.ts'

it('discovers a missed GitHub issue through the actual observer without a webhook and persists scanner custody', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-scanner-observer-'))
  const secret = 'scanner-fixture-hmac', token = 'scanner-fixture-token', requests: string[] = []
  const previous = process.env.DF_SCANNER_OBSERVER_SECRET, previousToken = process.env.DF_SCANNER_OBSERVER_TOKEN
  process.env.DF_SCANNER_OBSERVER_SECRET = secret; process.env.DF_SCANNER_OBSERVER_TOKEN = token
  const issue = { id: 100, number: 7, title: 'missed issue', body: 'provider context', user: { id: 12 }, labels: [{ id: 1, name: 'automate' }], state: 'open', updated_at: new Date().toISOString() }
  const provider = createServer((request, response) => {
    requests.push(request.url!)
    expect(request.method).toBe('GET'); expect(request.headers.authorization).toBe(`Bearer ${token}`)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url!.startsWith('/installation/repositories') ? { total_count: 1, repositories: [{ id: 42, full_name: 'owner/repo' }] } : request.url!.includes('/issues?') ? [issue] : issue))
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('fixture address')
  let observer: DarkFactoryObserver | undefined, health: HealthStore | undefined, restored: DarkFactoryIngestionStore | undefined
  try {
    await runGit(directory, ['init', '--quiet'], new AbortController().signal, 5000)
    await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], new AbortController().signal, 5000)
    const policy = enabledPolicy(), route = policy.ingestion.routes[0]!
    if (route.source !== 'github') throw new Error('fixture route')
    policy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }; policy.ingestion.maxBodyBytes = 65536
    policy.limits.maxArtifactBytes = 65536; policy.limits.maxJournalRecordBytes = 1_048_576; policy.limits.maxJournalBytes = 16_777_216
    route.repositoryIds = ['42']; route.senderIds = ['12', 'host-scanner:repository']; route.secretRef = { kind: 'env', name: 'DF_SCANNER_OBSERVER_SECRET' }
    route.bindings = { installationIds: ['10'], authorIds: ['12'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] }
    route.reconciliation = githubReconciliationRegistrationSchema.parse({ apiBaseUrl: `http://127.0.0.1:${address.port}`, fixtureLoopback: true, installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'DF_SCANNER_OBSERVER_TOKEN' }, credentialKind: 'installation-token', scan: { scannerId: 'host-scanner:repository', ruleId: 'rule', initialSince: '2026-01-01T00:00:00.000Z' } })
    health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
    observer = await DarkFactoryObserver.open(directory, enabledDarkFactoryConfigSchema.parse(policy), (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs), [{ id: 'project', repository: directory }])
    const journalPath = join(directory, 'darkfactory/project/ingestion.jsonl')
    const deadline = Date.now() + 4000
    while (!(await readFile(journalPath, 'utf8')).includes('HOST_REGISTERED_SCANNER_RULE') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    await observer.close(); observer = undefined
    restored = await DarkFactoryIngestionStore.open(directory, { projectId: 'project', maxBodyBytes: policy.ingestion.maxBodyBytes, maxQueueItems: policy.ingestion.maxQueueItems, maxRecordBytes: policy.limits.maxJournalRecordBytes, maxJournalBytes: policy.limits.maxJournalBytes })
    const item = restored.snapshot().items[0]!
    expect(item).toMatchObject({ state: 'trusted', author: '12', actor: 'host-scanner:repository', sourceEntityId: 'issue:42:100',
      initiator: { kind: 'host-scanner', scannerId: 'host-scanner:repository', ruleId: 'rule' } })
    expect(restored.snapshot().custody).toHaveLength(1)
    const envelope = restored.snapshot().custody[0]!.envelope
    expect(envelope.authentication).toBe('provider-api'); expect(envelope).not.toHaveProperty('signingKeyId')
    expect(JSON.stringify(restored.snapshot())).not.toContain(token)
    expect(requests).toHaveLength(4)
    expect(requests[1]).toContain('/repos/owner/repo/issues?state=all&sort=updated&direction=asc&since=')
    expect(requests[3]).toBe('/repos/owner/repo/issues/7')
    const scanBytes = await readFile(join(directory, 'darkfactory-github-scans.jsonl'), 'utf8')
    expect(scanBytes).toContain('github-scan-page-acknowledged')
    expect(health.listEscalations()).toHaveLength(0)
  } finally {
    await observer?.close(); await restored?.close(); await health?.close()
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
    if (previous === undefined) delete process.env.DF_SCANNER_OBSERVER_SECRET; else process.env.DF_SCANNER_OBSERVER_SECRET = previous
    if (previousToken === undefined) delete process.env.DF_SCANNER_OBSERVER_TOKEN; else process.env.DF_SCANNER_OBSERVER_TOKEN = previousToken
    await rm(directory, { recursive: true, force: true })
  }
})
