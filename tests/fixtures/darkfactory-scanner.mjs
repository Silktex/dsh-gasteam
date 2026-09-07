/** Built native scanner/scan/ingestion/request/artifact owners; no current-entity reconciler or task runtime. */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DarkFactoryGithubScanner, DarkFactoryGithubScanStore, DarkFactoryIngestionStore, DarkFactoryProviderRequestStore,
  DarkFactoryArtifactStore, enabledDarkFactoryConfigSchema } from '../../packages/agent-team/lib/darkfactory.js'
const at = '2026-09-06T12:00:00.000Z'
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
process.on('message', () => {})
process.once('message', async ({ directory, mode }) => {
  let scanner, scans, ingestion, budget, artifacts
  const close = async () => { await scanner?.close(); await scans?.close(); await ingestion?.close(); await budget?.close(); await artifacts?.settled() }
  try {
    const policy = enabledDarkFactoryConfigSchema.parse(JSON.parse(await readFile(join(directory, 'policy.json'), 'utf8')))
    const route = policy.ingestion.routes[0], workspace = join(directory, 'workspace')
    assert.equal(route.source, 'github'); assert.ok(route.reconciliation.scan)
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    scans = await DarkFactoryGithubScanStore.open(workspace, { routes: [{ projectId: route.projectId, routeId: route.id, initialSince: route.reconciliation.scan.initialSince }] })
    ingestion = await DarkFactoryIngestionStore.open(workspace, { projectId: route.projectId })
    budget = await DarkFactoryProviderRequestStore.open(workspace, { routes: [{ projectId: route.projectId, routeId: route.id }], requestsPerMinute: 2 })
    artifacts = await DarkFactoryArtifactStore.open(workspace, [route.projectId], policy.limits.maxArtifactBytes, policy.limits.maxArtifactTotalBytes)
    const snapshot = async barrier => {
      const cursor = scans.snapshot().cursors[0], page = cursor.sweep?.pages[0]
      return { barrier, pid: process.pid, scans: scans.snapshot(), ingestion: ingestion.snapshot(), budget: budget.snapshot(),
        page: page ? await artifacts.read(page.artifact) : null,
        lookups: await Promise.all(ingestion.snapshot().custody.map(custody => artifacts.read(custody.envelope.artifact))) }
    }
    if (mode === 'partial') {
      const received = ingestion.recordReceived.bind(ingestion)
      ingestion.recordReceived = async input => {
        const result = await received(input)
        if (ingestion.snapshot().custody.length === 1) {
          await send(await snapshot('page-and-first-custody-durable'))
          await new Promise(() => {})
        }
        return result
      }
    }
    scanner = await DarkFactoryGithubScanner.open(policy, { projects: [{ id: route.projectId, repository: join(directory, 'repository') }],
      stores: new Map([[route.projectId, ingestion]]), artifacts, requestBudget: budget, scanStore: scans, clock: () => Date.parse(at),
      authorize: async () => {}, quarantine: async () => { throw new Error('Unexpected scanner custody fixture quarantine') } })
    await scanner.runOnce()
    const result = await snapshot('complete')
    await close(); await send(result); process.disconnect()
  } catch (error) {
    try { await close() } catch { /* Preserve original failure. */ }
    await send({ barrier: 'error', message: String(error), stack: error?.stack }); process.exitCode = 1; process.disconnect()
  }
})
