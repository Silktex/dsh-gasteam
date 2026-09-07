import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parseDarkFactoryConfig } from '../../packages/agent-team/src/darkfactory/config.ts'

it('validates the shipped complete observe policy with inert future-runtime placeholders and no invented gate receipts', async () => {
  const source = await readFile(resolve('examples/darkfactory-observe.json'), 'utf8')
  const policy = parseDarkFactoryConfig(source)
  expect(policy).toEqual(JSON.parse(source))
  expect(policy.enabled).toBe(true)
  if (!policy.enabled) throw new Error('Example must enable explicit observe custody')
  expect(policy.mode).toBe('observe')
  expect(policy.delivery).toEqual({ enabled: false })
  expect(policy.models.compression).toEqual({ enabled: false })
  expect(policy.notifications.destinations).toEqual([])
  expect(policy.fleet.routineWatermark).toBe(0.95)
  expect(policy.fleet.reserveFraction).toBe(0.1)
  expect(policy.ingestion.transport).toEqual({ kind: 'listener', host: '127.0.0.1', port: 9100 })
  const route = policy.ingestion.routes[0]!
  expect(route).toMatchObject({ source: 'github', projectId: policy.projectIds[0], secretRef: { kind: 'env', name: 'GASTEAM_GITHUB_WEBHOOK_SECRET' }, bindings: { installationIds: ['REPLACE_GITHUB_INSTALLATION_ID'], authorIds: ['REPLACE_GITHUB_AUTHOR_ID'], automationRules: [{ ruleId: 'authorized-issue', automationLabel: 'darkfactory:execute' }] } })
  expect(new URL(policy.models.endpoint).hostname).toBe('example.invalid')
  expect(new URL(policy.fleet.redis.endpoint).hostname).toBe('example.invalid')
  const keys: string[] = []
  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) { keys.push(key); collect(child) }
  }
  collect(JSON.parse(source))
  expect(keys.some(key => /gate.*receipt|qualification.*receipt|password|secretValue|apiKey|accessToken/i.test(key))).toBe(false)
  expect(parseDarkFactoryConfig()).toEqual({ schemaVersion: 1, enabled: false })
})
