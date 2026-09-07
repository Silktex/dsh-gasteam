import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DarkFactoryObserver } from '../../src/darkfactory/observer.ts'
import { DarkFactoryIngestionStore } from '../../src/darkfactory/ingestion-store.ts'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
import { HealthStore } from '../../src/health.ts'
import { githubReconciliationRegistrationSchema, enabledDarkFactoryConfigSchema } from '../../src/darkfactory/config.ts'
import { runGit } from '../../src/git-command.ts'
import { enabledPolicy } from './config-fixture.ts'
import { dependabotAlertFixture } from './dependabot-reconciliation-fixture.ts'

it('observes a signed Dependabot webhook through real loopback REST and persists only explicit sensor authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-dependabot-observer-'))
  const secret = 'dependabot-fixture-hmac', token = 'dependabot-fixture-token', requests: string[] = []
  const previous = process.env.DF_DEPENDABOT_OBSERVER_SECRET, previousToken = process.env.DF_DEPENDABOT_OBSERVER_TOKEN
  process.env.DF_DEPENDABOT_OBSERVER_SECRET = secret; process.env.DF_DEPENDABOT_OBSERVER_TOKEN = token
  const provider = createServer((request, response) => {
    requests.push(request.url!)
    expect(request.method).toBe('GET'); expect(request.headers.authorization).toBe(`Bearer ${token}`)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url!.startsWith('/installation/repositories') ? { total_count: 1, repositories: [{ id: 42, full_name: 'owner/repo' }] } : dependabotAlertFixture()))
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
    route.repositoryIds = ['42']; route.senderIds = ['12']; route.secretRef = { kind: 'env', name: 'DF_DEPENDABOT_OBSERVER_SECRET' }
    route.bindings = { installationIds: ['10'], authorIds: ['host-sensor:dependabot'], automationRules: [{ ruleId: 'rule', automationLabel: 'automate' }] }
    route.reconciliation = githubReconciliationRegistrationSchema.parse({ apiBaseUrl: `http://127.0.0.1:${address.port}`, fixtureLoopback: true, installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialRef: { kind: 'env', name: 'DF_DEPENDABOT_OBSERVER_TOKEN' }, credentialKind: 'installation-token', dependabot: { sensorPrincipalId: 'host-sensor:dependabot', ruleId: 'rule' } })
    health = await HealthStore.open(directory, { dshDeadlineMs: 1000, externalDeadlineMs: 1000, escalationCooldownMs: 1000, maxEscalationsPerCondition: 2 })
    observer = await DarkFactoryObserver.open(directory, enabledDarkFactoryConfigSchema.parse(policy), (input, at, cooldownMs) => health!.raiseFactoryEscalation(input, at, cooldownMs), [{ id: 'project', repository: directory }])
    const body = JSON.stringify({ action: 'created', repository: { id: 42, full_name: 'owner/repo' }, installation: { id: 10 }, sender: { id: 12 }, alert: dependabotAlertFixture(), secrets: 'webhook-secret-marker' })
    const receipt = await fetch(`http://127.0.0.1:${observer.status().port}/darkfactory/v1/ingress/github/route`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'dependabot_alert', 'x-github-delivery': 'dependabot-delivery', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body })
    expect(receipt.status).toBe(202)
    const journalPath = join(directory, 'darkfactory/project/ingestion.jsonl')
    const deadline = Date.now() + 4000
    while (!(await readFile(journalPath, 'utf8')).includes('HOST_REGISTERED_SENSOR_RULE') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    await observer.close(); observer = undefined
    restored = await DarkFactoryIngestionStore.open(directory, { projectId: 'project', maxBodyBytes: policy.ingestion.maxBodyBytes, maxQueueItems: policy.ingestion.maxQueueItems, maxRecordBytes: policy.limits.maxJournalRecordBytes, maxJournalBytes: policy.limits.maxJournalBytes })
    const item = restored.snapshot().items[0]!
    expect(item).toMatchObject({ state: 'trusted', author: 'host-sensor:dependabot', actor: 'host-sensor:dependabot', sourceEntityId: 'dependabot:42:7' })
    const artifacts = await DarkFactoryArtifactStore.open(directory, ['project'], policy.limits.maxArtifactBytes, policy.limits.maxArtifactTotalBytes)
    const lookup = await artifacts.read(item.provenance[0]!), evidence = await artifacts.read(item.provenance[1]!)
    expect(lookup).toMatchObject({ lookup: { kind: 'dependabot_alert', actorId: '12', providerEntityId: '7', number: 7 } })
    expect(evidence).toMatchObject({ identityBinding: 'host-configured-dependabot-sensor', webhookActorId: '12', resource: 'dependabot_alert' })
    expect(JSON.stringify([lookup, evidence, restored.snapshot()])).not.toContain('webhook-secret-marker')
    expect(JSON.stringify([lookup, evidence, restored.snapshot()])).not.toContain(token)
    expect(requests).toEqual(['/installation/repositories?per_page=100&page=1', '/repos/owner/repo/dependabot/alerts/7'])
    expect(health.listEscalations()).toHaveLength(0)
  } finally {
    await observer?.close(); await restored?.close(); await health?.close()
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()))
    if (previous === undefined) delete process.env.DF_DEPENDABOT_OBSERVER_SECRET; else process.env.DF_DEPENDABOT_OBSERVER_SECRET = previous
    if (previousToken === undefined) delete process.env.DF_DEPENDABOT_OBSERVER_TOKEN; else process.env.DF_DEPENDABOT_OBSERVER_TOKEN = previousToken
    await rm(directory, { recursive: true, force: true })
  }
})
