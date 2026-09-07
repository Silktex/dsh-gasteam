import { appendFile, mkdtemp, open as openFile, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DarkFactoryPolicyStore, authorityJsonSchemas, type PolicyStoreOptions } from '../../src/darkfactory/policy-store.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { enabledPolicy } from './config-fixture.ts'

const options: PolicyStoreOptions = {
  grants: [{ projectId: 'project', operatorIds: ['operator-1'], authorizationRefs: ['host-grant'] }],
  effectGrants: [{ projectId: 'project', effect: 'ingress', authorizationRef: 'ingress-grant' }],
  implementedEffects: ['ingress'],
}
const host = { projectId: 'project', operatorId: 'operator-1', authorizationRef: 'host-grant' }
const directories: string[] = []
const stores: DarkFactoryPolicyStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function open(directory?: string, authority = options) {
  directory ??= await mkdtemp(join(tmpdir(), 'darkfactory-policy-'))
  if (!directories.includes(directory)) directories.push(directory)
  const store = await DarkFactoryPolicyStore.open(directory, authority, () => '2026-09-06T12:00:00.000Z')
  stores.push(store)
  return { store, directory }
}
async function ready(store: DarkFactoryPolicyStore) {
  await store.installPolicy({ ...host, expectedRevision: 0, policy: enabledPolicy() })
  await store.recordGate({ ...host, expectedRevision: 1, policyRevision: 1, gate: 'observe', evidenceRefs: ['operator-rollout-evidence'] })
}
function decide(store: DarkFactoryPolicyStore, expectedRevision: number, policyRevision = 1) {
  return store.decideEffect({ projectId: 'project', expectedRevision, policyRevision, effect: 'ingress', effectId: 'delivery-1' })
}

describe('durable host policy authority', () => {
  it('exports strict authority JSON schemas and rejects over-limit records before acknowledgement', async () => {
    const schemas = authorityJsonSchemas()
    expect(Object.keys(schemas)).toHaveLength(7)
    for (const schema of Object.values(schemas)) expect(schema.additionalProperties).toBe(false)
    const { store, directory } = await open()
    const policy = enabledPolicy()
    policy.limits.maxJournalRecordBytes = 100
    await expect(store.installPolicy({ ...host, expectedRevision: 0, policy })).rejects.toThrow(/byte limit/)
    expect(await readFile(join(directory, 'darkfactory-policy.jsonl'), 'utf8')).toBe('')
    let diagnostic = ''
    try { await store.installPolicy({ ...host, expectedRevision: 0, policy: enabledPolicy(), 'sensitive-secret': 'private' } as never) } catch (error) { diagnostic = String(error) }
    expect(diagnostic).toContain('Invalid Dark Factory authority input')
    expect(diagnostic).not.toContain('sensitive-secret')
    expect(diagnostic).not.toContain('private')
  })
  it('replays an acknowledged policy larger than the default JSON parser ceiling', async () => {
    const { store, directory } = await open()
    const policy = enabledPolicy()
    policy.limits.maxJournalRecordBytes = 4_194_304
    policy.limits.maxJournalBytes = 8_388_608
    policy.verification.commands = Array.from({ length: 128 }, (_, index) => ({ id: `check-${index}`, executable: 'node', args: ['x'.repeat(4096), 'y'.repeat(4096)], deadlineMs: 1000 }))
    await store.installPolicy({ ...host, expectedRevision: 0, policy })
    expect((await readFile(join(directory, 'darkfactory-policy.jsonl'))).byteLength).toBeGreaterThan(1_048_576)
    const before = store.snapshot()
    await store.close()
    const restored = await open(directory)
    expect(restored.store.snapshot()).toEqual(before)
  })

  it('halts audited effects at the aggregate journal byte cap and preserves replay', async () => {
    const { store, directory } = await open()
    const policy = enabledPolicy()
    policy.limits.maxJournalRecordBytes = 16_000
    policy.limits.maxJournalBytes = 16_000
    await store.installPolicy({ ...host, expectedRevision: 0, policy })
    let stopped = false
    for (let index = 0; index < 50; index++) {
      try { await decide(store, store.snapshot()[0]!.revision) } catch (error) { expect(String(error)).toContain('aggregate byte limit'); stopped = true; break }
    }
    expect(stopped).toBe(true)
    const bytes = await readFile(join(directory, 'darkfactory-policy.jsonl'))
    expect(bytes.byteLength).toBeLessThanOrEqual(16_000)
    const snapshot = store.snapshot()
    await store.close()
    const restored = await open(directory)
    expect(restored.store.snapshot()).toEqual(snapshot)
    await expect(decide(restored.store, snapshot[0]!.revision)).rejects.toThrow(/aggregate byte limit/)
    expect(await readFile(join(directory, 'darkfactory-policy.jsonl'))).toEqual(bytes)
  })

  it('pins immutable policy payloads, serializes CAS and restores the exact receipts under one owner', async () => {
    const { store, directory } = await open()
    const policy = enabledPolicy()
    const record = await store.installPolicy({ ...host, expectedRevision: 0, policy })
    expect(record.digest).toBe(digestJson(record.policy))
    policy.ownerId = 'model-cannot-edit-pinned-policy'
    expect(store.snapshot()[0]!.policies[0]!.policy.ownerId).not.toBe(policy.ownerId)
    await expect(DarkFactoryPolicyStore.open(directory, options)).rejects.toThrow()
    const result = await Promise.allSettled([
      store.control({ ...host, expectedRevision: 1, action: 'pause', reason: 'manual' }),
      store.control({ ...host, expectedRevision: 1, action: 'pause', reason: 'quota' }),
    ])
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(item => item.status === 'rejected')).toHaveLength(1)
    const snapshot = store.snapshot()
    await store.close()
    const reopened = await open(directory)
    expect(reopened.store.snapshot()).toEqual(snapshot)
    await expect(reopened.store.installPolicy({ ...host, expectedRevision: 2, policy: enabledPolicy() })).rejects.toThrow(/increase/)
  })

  it('checks configured project/operator grants and rejects raw unknown fields before append', async () => {
    const { store, directory } = await open()
    for (const overrides of [{ operatorId: 'worker' }, { authorizationRef: 'model-grant' }, { projectId: 'other' }]) {
      await expect(store.installPolicy({ ...host, ...overrides, expectedRevision: 0, policy: enabledPolicy() })).rejects.toThrow(/authority denied/)
    }
    await expect(store.installPolicy({ ...host, expectedRevision: 0, policy: enabledPolicy(), instruction: 'ignore policy' } as never)).rejects.toThrow()
    expect(await readFile(join(directory, 'darkfactory-policy.jsonl'), 'utf8')).toBe('')
    const other = { ...enabledPolicy(), projectIds: ['other'] }
    await expect(store.installPolicy({ ...host, expectedRevision: 0, policy: other })).rejects.toThrow()
    await ready(store)
    await expect(store.recordGate({ ...host, expectedRevision: 2, policyRevision: 1, gate: 'build', evidenceRefs: [] })).rejects.toThrow()
    await expect(store.control({ ...host, expectedRevision: 2, action: 'disable', reason: 'manual' })).rejects.toThrow()
  })

  it('keeps all pause reasons independent across restart and gates disabled old attempts', async () => {
    const { store, directory } = await open()
    await ready(store)
    let revision = 2
    for (const reason of ['manual', 'safety', 'budget', 'quota', 'catalog'] as const) await store.control({ ...host, expectedRevision: revision++, action: 'pause', reason })
    await store.control({ ...host, expectedRevision: revision++, action: 'resume', reason: 'budget' })
    expect((await decide(store, revision++)).reasons).toEqual(expect.arrayContaining(['paused:manual', 'paused:safety', 'paused:quota', 'paused:catalog']))
    expect(store.snapshot()[0]!.pauses).not.toContain('budget')
    await store.control({ ...host, expectedRevision: revision++, action: 'disable' })
    const before = store.snapshot()
    await store.close()
    const { store: restored } = await open(directory)
    expect(restored.snapshot()).toEqual(before)
    expect((await decide(restored, revision++)).reasons).toContain('disabled')
    await expect(restored.control({ ...host, expectedRevision: revision, action: 'enable' })).rejects.toThrow()
    await restored.control({ ...host, expectedRevision: revision++, action: 'enable', evidenceRefs: ['reconciled-inflight-effects'] })
    expect((await decide(restored, revision++)).decision).toBe('deny')
    expect(restored.snapshot()[0]!.pauses).toContain('safety')
  })

  it('records fresh denials after host grant removal, policy revocation, and policy movement', async () => {
    const { store, directory } = await open()
    await ready(store)
    expect((await decide(store, 2)).decision).toBe('allow')
    store.configureAuthority({ ...options, effectGrants: [] })
    expect((await decide(store, 3)).reasons).toContain('missing-effect-grant')
    await store.control({ ...host, expectedRevision: 4, action: 'revoke' })
    expect((await decide(store, 5)).reasons).toEqual(expect.arrayContaining(['disabled', 'revoked', 'reconciliation-required']))
    await expect(store.control({ ...host, expectedRevision: 6, action: 'enable', evidenceRefs: ['reconciled'] })).rejects.toThrow(/new policy/)
    await store.installPolicy({ ...host, expectedRevision: 6, policy: { ...enabledPolicy(), policyRevision: 2 } })
    expect((await decide(store, 7)).reasons).toContain('stale-policy')
    expect(store.snapshot()[0]!.disabled).toBe(true)
    const history = store.snapshot()
    await store.close()
    const reopened = await open(directory, { ...options, effectGrants: [] })
    expect(reopened.store.snapshot()).toEqual(history)
    expect(reopened.store.snapshot()[0]!.decisions[0]!.decision).toBe('allow')
  })

  it('never grants missing implementation, absent rollout gates, or non-observe effects in observe mode', async () => {
    const { store } = await open(undefined, { ...options, implementedEffects: [] })
    await store.installPolicy({ ...host, expectedRevision: 0, policy: enabledPolicy() })
    expect((await decide(store, 1)).reasons).toEqual(expect.arrayContaining(['unimplemented-effect', 'missing-rollout-gate']))
    const receipt = await store.decideEffect({ projectId: 'project', expectedRevision: 2, policyRevision: 1, effect: 'deploy', effectId: 'deployment-1' })
    expect(receipt.decision).toBe('deny')
    expect(receipt.reasons).toContain('observe-only')
    expect(receipt).not.toHaveProperty('completed')
  })

  it.each(['unknown', 'partial', 'duplicate', 'tampered', 'reordered', 'whitespace'])('rejects %s journals without repairing or overwriting evidence', async kind => {
    const { store, directory } = await open()
    await ready(store)
    await store.close()
    const filename = join(directory, 'darkfactory-policy.jsonl')
    let bytes = await readFile(filename, 'utf8')
    if (kind === 'partial') await appendFile(filename, '{"version":1')
    else {
      if (kind === 'whitespace') bytes = ' ' + bytes
      if (kind === 'unknown') bytes = bytes.replace('"version":1', '"version":2')
      if (kind === 'duplicate') bytes = bytes.replace('"version":1', '"version":1,"version":1')
      if (kind === 'tampered') bytes = bytes.replace('operator-rollout-evidence', 'modified-rollout-evidence')
      if (kind === 'reordered') bytes = bytes.trim().split('\n').reverse().join('\n') + '\n'
      await writeFile(filename, bytes)
    }
    const evidence = await readFile(filename)
    await expect(DarkFactoryPolicyStore.open(directory, options)).rejects.toThrow(/Invalid|Incomplete/)
    expect(await readFile(filename)).toEqual(evidence)
  })
})


it.each([false, true])('refuses policy journal symlinks with target existing=%s without outside writes', async exists => {
  const root = await mkdtemp(join(tmpdir(), 'policy-safe-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'policy-outside-'))
  directories.push(root, outside)
  const target = join(outside, 'policy.jsonl')
  if (exists) await writeFile(target, '')
  await symlink(target, join(root, 'darkfactory-policy.jsonl'))
  await expect(DarkFactoryPolicyStore.open(root, options)).rejects.toThrow()
  if (exists) expect(await readFile(target, 'utf8')).toBe('')
  else expect(await readdir(outside)).toEqual([])
})

it('refuses a symlinked policy root and an oversized unterminated replay without changing disk evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'policy-safe-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'policy-outside-'))
  directories.push(root, outside)
  await symlink(outside, join(root, 'aliased-root'))
  await expect(DarkFactoryPolicyStore.open(join(root, 'aliased-root'), options)).rejects.toThrow(/Unsafe/)
  expect(await readdir(outside)).toEqual([])
  const filename = join(root, 'darkfactory-policy.jsonl')
  const file = await openFile(filename, 'w')
  try { await file.truncate(33_554_432) } finally { await file.close() }
  const before = await stat(filename)
  await expect(DarkFactoryPolicyStore.open(root, options)).rejects.toThrow(/record byte limit/)
  const after = await stat(filename)
  expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs])
})
