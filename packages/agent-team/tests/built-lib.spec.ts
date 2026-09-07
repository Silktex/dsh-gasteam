/** Plain-Node smoke for the built Agent Teams service and Remote contribution. */

import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(packageDir, '../..')
const artifact = (path: string): string => join(root, path)
const artifactUrl = (path: string): string => pathToFileURL(artifact(path)).href

describe('Agent Teams built LIB service', () => {
  it('loads the Dark Factory contracts under plain Node without starting a service', async () => {
    const result = await runPlainNode(`
      import assert from 'node:assert/strict'
      const factory = await import(${JSON.stringify(artifactUrl('packages/agent-team/lib/darkfactory.js'))})
      assert.deepEqual(Object.keys(factory.contractJsonSchemas()), Object.keys(factory.contracts))
      assert.ok(Object.keys(factory.authorityJsonSchemas()).length >= 3)
      assert.equal(typeof factory.DarkFactoryReconciler.open, 'function')
      assert.equal(typeof factory.validateReferenceGraph, 'function')
      assert.equal(typeof factory.validateReferenceSnapshot, 'function')
      for (const owner of [factory.DarkFactoryPolicyStore, factory.DarkFactoryIngestionStore, factory.DarkFactoryAdmissionStore, factory.DarkFactoryCompilationStore]) assert.equal(typeof owner.migrate, 'function')
      assert.equal(typeof factory.DarkFactoryAdmissionStore.open, 'function')
      assert.equal(typeof factory.DarkFactoryAdmissionController, 'function')
      assert.equal(typeof factory.DarkFactoryCompilationStore.open, 'function')
      assert.equal(typeof factory.DarkFactoryCompilationController, 'function')
      assert.equal(typeof factory.DarkFactoryProviderRequestStore.open, 'function')
      assert.equal(typeof factory.DarkFactoryGithubScanStore.open, 'function')
      assert.equal(typeof factory.DarkFactoryGithubScanner.open, 'function')
      assert.equal(typeof factory.readGithubScanPage, 'function')
      assert.equal(typeof factory.reconcileGithubDependabotAlert, 'function')
      assert.equal(typeof factory.reconcileGithubPullRequest, 'function')
      assert.equal(typeof factory.DarkFactoryMonitoringReconciler.open, 'function')
      assert.equal(typeof factory.reconcileSentrySource, 'function')
      assert.equal(typeof factory.reconcileApmSource, 'function')
      assert.equal(typeof factory.readMonitoringResource, 'function')
      assert.equal(typeof factory.MonitoringProviderFailure, 'function')
      assert.equal(typeof factory.sentryReconciliationLookupSchema, 'object')
      assert.equal(typeof factory.sentryReconciliationLookupSchema.parse, 'function')
      assert.equal(typeof factory.apmReconciliationLookupSchema, 'object')
      assert.equal(typeof factory.apmReconciliationLookupSchema.parse, 'function')
      assert.equal(factory.darkFactoryTemplate.steps.length, 5)
      assert.equal(typeof factory.validateFactoryReferenceGraph, 'function')
      assert.equal(typeof factory.createFactoryContractCodec, 'function')
      assert.equal(Object.keys(factory.factoryReferenceGraphJsonSchemas()).length, 4)
      assert.equal(typeof factory.DarkFactoryReleaseStore.open, 'function')
      assert.equal(typeof factory.DeploymentWebhookBridge.start, 'function')
      assert.equal(typeof factory.DarkFactoryTelemetryEngine, 'function')
      assert.equal(typeof factory.DarkFactoryRollbackController, 'function')
      assert.equal(typeof factory.DarkFactoryFleetStore, 'function')
      assert.equal(typeof factory.InMemoryRedisAdapter, 'function')
      assert.equal(typeof factory.DarkFactoryQuotaManager, 'function')
      assert.equal(typeof factory.DarkFactoryModelCatalog, 'function')
      assert.equal(typeof factory.normalizeHeadroomHeaders, 'function')
      assert.deepEqual(factory.parseDarkFactoryConfig(), { schemaVersion: 1, enabled: false })
      assert.equal(factory.canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}')
      assert.throws(() => factory.parseStrictJson('{"x":1,"x":2}'))
    `)
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
  })
  it('loads the Host service and its generated browser contribution under plain Node', async () => {
    const urls = {
      host: artifactUrl('packages/agent-team/lib/index.js'),
      remote: artifactUrl('packages/agent-team/lib/typert.remote-client.js'),
    }
    const script = `
      const host = await import(${JSON.stringify(urls.host)})
      const remote = await import(${JSON.stringify(urls.remote)})
      console.log(JSON.stringify({
        className: host.default.name,
        methods: remote.default.descriptors.map(descriptor => descriptor.id),
      }))
    `

    const result = await runPlainNode(script)
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      className: string
      methods: string[]
    }
    expect(output).toEqual({
      className: 'TeamService',
      methods: [
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/scheduling',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/controlScheduling',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/reviewReports',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/acceptReport',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/createTask',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/updateTask',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/createWorkflow',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/inspectWorkflow',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/resumeWorkflow',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/planWorkspaceBatch',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/inspectWorkspaceBatch',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/subscribeWorkspaceBatch',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/workspaceBatchInbox',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/acknowledgeWorkspaceBatchNotification',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/workspaceDashboard',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/workspaceDashboardPage',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/workspaceActivityPage',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/healthInbox',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/acknowledgeHealth',
        '@deepseek-ai/dsh-experimental-agent-team#agentTeams/view',
      ],
    })
  })
})

function runPlainNode(script: string): Promise<{
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolveRun({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout,
        stderr,
      })
    })
  })
}
