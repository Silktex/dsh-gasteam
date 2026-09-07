import { fork } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { enabledPolicy } from '../packages/agent-team/tests/darkfactory/config-fixture.ts'
import type { DarkFactoryIngestionStore } from '../packages/agent-team/src/darkfactory/ingestion-store.ts'
import type { DarkFactoryPolicyStore } from '../packages/agent-team/src/darkfactory/policy-store.ts'
import type { DarkFactoryProviderRequestStore } from '../packages/agent-team/src/darkfactory/provider-request-store.ts'
import type { OperatorEscalation } from '../packages/agent-team/src/health.ts'

const sentrySecret = 'isolated-sentry-secret'
const sentryToken = 'isolated-sentry-api-token-secret'

interface Snapshot {
  barrier: string
  pid: number
  requests: number
  ingestion: ReturnType<DarkFactoryIngestionStore['snapshot']>
  inbox: OperatorEscalation[]
  authority: ReturnType<DarkFactoryPolicyStore['snapshot']>
  budget: ReturnType<DarkFactoryProviderRequestStore['snapshot']>
}

function launch(mode: 'seed' | 'resume' | 'replay', directory: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-monitoring.mjs', import.meta.url)), [mode, directory], {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR ?? '/var/tmp',
      HOME: directory,
      DF_SENTRY_WEBHOOK_SECRET: sentrySecret,
      DF_SENTRY_TOKEN: sentryToken,
    },
  })
  const messages: unknown[] = []
  let diagnostics = '', ended = false, failure: Error | undefined, wake: (() => void) | undefined
  child.stdout!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-65_536) })
  child.stderr!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-65_536) })
  child.on('message', value => { messages.push(value); wake?.() })
  child.on('error', error => { failure = error; wake?.() })
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('close', (code, signal) => { ended = true; wake?.(); resolve({ code, signal }) }))
  return {
    async barrier(): Promise<Snapshot> {
      const timeout = setTimeout(() => { failure = new Error('Monitoring IPC deadline exceeded'); wake?.() }, 10_000)
      try {
        while (!messages.length) {
          if (failure || ended) throw new Error(`${failure?.message ?? 'Fixture exited'}\n${diagnostics}`)
          await new Promise<void>(resolve => { wake = resolve })
        }
        const value = messages.shift() as Snapshot & { message?: string }
        if (value.barrier === 'error') throw new Error(value.message)
        return value
      } finally { clearTimeout(timeout); wake = undefined }
    },
    async send(command: 'deny') { await new Promise<void>((resolve, reject) => child.send(command, error => error ? reject(error) : resolve())) },
    async stop(crash = false) {
      if (!ended) { if (crash) child.kill('SIGKILL'); else if (child.connected) child.send('stop') }
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        const result = await closed
        if (crash ? result.signal !== 'SIGKILL' : result.code !== 0) throw new Error(`Unexpected fixture exit ${JSON.stringify(result)}\n${diagnostics}`)
      } finally { clearTimeout(timeout) }
    },
  }
}

async function persistedText(directory: string): Promise<string> {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? persistedText(join(directory, entry.name)) : readFile(join(directory, entry.name), 'utf8')))).join('\n')
}

it('recovers a built SDK monitoring reconciliation after SIGKILL at durable begin, then preserves real revocation inbox state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-monitoring-restart-'))
  const processes: ReturnType<typeof launch>[] = []
  try {
    const repository = join(directory, 'repository')
    await mkdir(repository); await mkdir(join(directory, 'workspace'))
    await execa('git', ['init', '--quiet'], { cwd: repository })
    await execa('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: repository })

    const policy = enabledPolicy()
    policy.ingestion.routes = [{
      id: 'sentry-route',
      projectId: 'project',
      source: 'sentry',
      providerVersion: 'sentry-v1',
      signingKeyId: 'sentry-key',
      secretRef: { kind: 'env', name: 'DF_SENTRY_WEBHOOK_SECRET' },
      repositoryIds: ['42'],
      senderIds: ['12'],
      ruleIds: ['rule'],
      bindings: {
        installationIds: ['10'],
        organizationIds: ['20'],
        providerProjects: [{ id: '42', slug: 'service', organizationId: '20' }],
        environments: [{ providerEnvironment: 'production', environmentId: 'production' }],
        ruleMappings: [{ ruleId: 'rule', automationLabel: 'automate', resource: 'issue', providerRule: null }],
      },
      reconciliation: {
        apiBaseUrl: 'https://sentry.io',
        fixtureLoopback: false,
        publicSourceBaseUrl: 'https://sentry.io',
        installationId: '10',
        organizationId: '20',
        organizationSlug: 'acme',
        providerProjectId: '42',
        projectSlug: 'service',
        repositoryId: '42',
        repositoryName: 'owner/repo',
        sensorPrincipalId: 'host-sensor:sentry',
        productionEnvironmentId: 'production',
        credentialRef: { kind: 'env', name: 'DF_SENTRY_TOKEN' },
        credentialKind: 'api-token',
        maxAgeMs: 3600000,
      },
    }]

    await writeFile(join(directory, 'policy.json'), JSON.stringify(policy))
    const initial = launch('seed', directory); processes.push(initial)
    const begun = await initial.barrier()
    expect(begun).toMatchObject({
      barrier: 'fetch-blocked',
      requests: 1,
      ingestion: { items: [], attachments: [], reconciliations: [{ attempts: 1, status: 'pending', lastReason: 'FETCH_STARTED' }] },
      inbox: [],
    })
    const receipt = begun.ingestion.custody[0]!.receipt
    expect(begun.authority[0]!.decisions).toMatchObject([{ decision: 'allow', effect: 'ingress' }])
    expect(begun.budget.charges).toHaveLength(1)

    const journal = join(directory, 'workspace/darkfactory/project/ingestion.jsonl')
    const synced = await readFile(journal, 'utf8')
    expect(JSON.parse(synced.trimEnd().split('\n').at(-1)!)).toMatchObject({ type: 'reconciliation-began', request: { envelopeId: receipt.envelopeId } })

    // SIGKILL the process at durable begin while blocked in transport
    await initial.stop(true); processes.pop()

    // Resume from storage
    const resumed = launch('resume', directory); processes.push(resumed)
    const recovered = await resumed.barrier()
    expect(recovered.pid).not.toBe(begun.pid)
    expect(recovered).toMatchObject({
      barrier: 'recovered',
      requests: 3,
      ingestion: { reconciliations: [{ attempts: 2, status: 'resolved', lastReason: 'RECONCILIATION_COMPLETE' }] },
      inbox: [],
    })
    expect(recovered.ingestion.items).toHaveLength(1)
    expect(recovered.ingestion.items[0]).toMatchObject({ state: 'trusted', revision: 2, trust: { decision: 'trusted' } })
    expect(recovered.ingestion.custody[0]!.receipt).toEqual(receipt)
    expect((await readFile(journal, 'utf8')).startsWith(synced)).toBe(true)
    expect(recovered.ingestion.reconciliations[0]!.lastAttemptAt).toBe('2026-09-06T12:06:00.001Z')

    // Send deny / resolution webhook to invalidate active work
    await resumed.send('deny')
    const denied = await resumed.barrier()
    expect(denied.ingestion.items).toHaveLength(1)
    expect(denied.ingestion.items[0]).toMatchObject({
      state: 'quarantined',
      trust: { decision: 'revoked', reasons: expect.arrayContaining(['SOURCE_DENIED', 'SENTRY_RESOLVED']) },
    })
    expect(denied.ingestion.reconciliations[1]).toMatchObject({ attempts: 1, status: 'quarantined', lastReason: 'SOURCE_DENIED' })
    expect(denied.inbox).toHaveLength(2)
    expect(denied.inbox[0]).toMatchObject({ source: 'darkfactory', stage: 'trust', reason: 'SOURCE_DENIED', acknowledgement: { actor: 'fixture-lead' } })
    expect(denied.inbox[1]).toMatchObject({ source: 'darkfactory', stage: 'trust', reason: 'SOURCE_DENIED', acknowledgement: { actor: 'fixture-lead' } })
    expect(denied.ingestion.reconciliations[1]!.healthEscalationId).toBe(denied.inbox[1]!.id)
    expect(denied.inbox[0]).not.toHaveProperty('attemptId')
    expect(denied.inbox[0]).not.toHaveProperty('taskId')
    expect(denied.inbox[1]).not.toHaveProperty('attemptId')
    expect(denied.inbox[1]).not.toHaveProperty('taskId')

    await resumed.stop(); processes.pop()

    // Replay from durable storage without making new provider requests
    const replay = launch('replay', directory); processes.push(replay)
    const replayed = await replay.barrier()
    expect(replayed.requests).toBe(0)
    expect(replayed.ingestion).toEqual(denied.ingestion)
    expect(replayed.inbox).toEqual(denied.inbox)
    expect(replayed.authority).toEqual(denied.authority)
    expect(await persistedText(join(directory, 'workspace'))).not.toContain(sentryToken)
  } finally {
    try { for (const child of processes.reverse()) await child.stop() } finally { await rm(directory, { recursive: true, force: true }) }
  }
}, 30_000)
