import { fork } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DarkFactoryIngestionStore } from '../packages/agent-team/src/darkfactory/ingestion-store.ts'
import type { OperatorEscalation } from '../packages/agent-team/src/health.ts'
import type { PolicyProjectState } from '../packages/agent-team/src/darkfactory/policy-store.ts'
import { enabledPolicy } from '../packages/agent-team/tests/darkfactory/config-fixture.ts'

const directories: string[] = [], processes: ReturnType<typeof launch>[] = []
interface Snapshot {
  barrier: string; pid: number; validations?: number; reason?: string; reduced?: number
  ingestion: ReturnType<DarkFactoryIngestionStore['snapshot']>; inbox: OperatorEscalation[]
  policies: PolicyProjectState[]
  migration?: { storageLayout: 2; migrationId: string; legacyDigest: string; legacyBytes: number; directory: string; backup: string; target: string }
}
function launch(mode: string, directory: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-migration.mjs', import.meta.url)), [mode, directory], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/var/tmp' },
  })
  let diagnostics = '', ended = false
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000) })
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => { ended = true; resolve({ code, signal }) }))
  const message = new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Migration IPC deadline: ${diagnostics}`)) }, 10000)
    child.once('message', value => { clearTimeout(timer); const snapshot = value as Snapshot & { message?: string }; snapshot.barrier === 'error' ? reject(new Error(snapshot.message)) : resolve(snapshot) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Migration fixture exited ${code}: ${diagnostics}`)) })
  })
  const handle = { message, closed, async kill() { if (!ended) child.kill('SIGKILL'); return closed } }
  processes.push(handle)
  return handle
}
async function run(mode: string, directory: string) {
  const child = launch(mode, directory), snapshot = await child.message
  expect(await child.closed).toEqual({ code: 0, signal: null })
  return snapshot
}
async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'factory-native-migration-')); directories.push(value)
  const policy = enabledPolicy()
  policy.projectIds = ['migration-project']; policy.fleet.projectCaps[0]!.id = 'migration-project'
  const route = policy.ingestion.routes[0]!
  Object.assign(route, { projectId: 'migration-project', providerVersion: 'github-v1', signingKeyId: 'fixture-key', repositoryIds: ['repo-1'], senderIds: ['fixture-actor'] })
  if (route.source === 'github') route.bindings.authorIds = ['fixture-author']
  await writeFile(join(value, 'fixture-policy.json'), JSON.stringify(policy), { mode: 0o600 })
  return value
}
const partition = (directory: string) => join(directory, 'darkfactory/migration-project')
const anchor = (directory: string) => join(partition(directory), 'ingestion.jsonl')
const staging = (directory: string) => join(partition(directory), 'ingestion.jsonl.layout2-fixture-migration')
afterEach(async () => { await Promise.all(processes.splice(0).map(child => child.kill())); await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))) })

it('keeps a SIGKILL-interrupted native migration fail-closed and restores its verified backup only in an isolated directory', async () => {
  const original = await directory(), seeded = await run('seed', original), originalBytes = await readFile(anchor(original))
  expect(seeded.ingestion.custody).toHaveLength(2); expect(seeded.ingestion.items).toHaveLength(1)
  expect(seeded.inbox[0]).toMatchObject({ source: 'darkfactory', reason: 'SOURCE_DENIED', acknowledgement: { actor: 'fixture-lead' } })
  const migrating = launch('migrate-blocked', original), validated = await migrating.message
  expect(seeded.policies[0]!.policies[0]).toMatchObject({ projectId: 'migration-project', policyRevision: 1 })
  expect(validated).toMatchObject({ barrier: 'target-validated', validations: 2, ingestion: seeded.ingestion, inbox: seeded.inbox, policies: seeded.policies })
  expect(validated.pid).not.toBe(seeded.pid)
  expect(await readFile(anchor(original))).toEqual(originalBytes)
  const backup = join(staging(original), 'legacy-backup.jsonl'), target = join(staging(original), 'journal.jsonl')
  expect(await readFile(backup)).toEqual(originalBytes); expect(await readFile(target)).toEqual(originalBytes)
  expect((await stat(backup)).mode & 0o777).toBe(0o400)
  const pending = join(partition(original), 'ingestion.jsonl.layout2.pending'), pendingBytes = await readFile(pending)
  expect(await migrating.kill()).toEqual({ code: null, signal: 'SIGKILL' })
  expect(await run('blocked', original)).toMatchObject({ barrier: 'native-refused', reason: expect.stringContaining('unsafe or incomplete') })
  expect(await readFile(anchor(original))).toEqual(originalBytes); expect(await readFile(backup)).toEqual(originalBytes)
  expect(await readFile(pending)).toEqual(pendingBytes)
  expect(await readdir(staging(original))).toEqual(expect.arrayContaining(['legacy-backup.jsonl', 'journal.jsonl']))
  await expect(readFile(join(partition(original), 'ingestion.jsonl.layout2.commit'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Explicit restore drill: original evidence and markers stay untouched.
  const restored = await directory(); await mkdir(partition(restored), { recursive: true })
  await cp(backup, anchor(restored)); await chmod(anchor(restored), 0o600)
  await cp(join(partition(original), 'artifacts'), join(partition(restored), 'artifacts'), { recursive: true })
  await cp(join(original, 'health.jsonl'), join(restored, 'health.jsonl'))
  await cp(join(original, 'darkfactory-policy.jsonl'), join(restored, 'darkfactory-policy.jsonl'))
  await cp(join(original, 'fixture-policy.json'), join(restored, 'fixture-policy.json'))
  const replay = await run('replay', restored)
  expect(replay.ingestion).toEqual(seeded.ingestion); expect(replay.inbox).toEqual(seeded.inbox); expect(replay.policies).toEqual(seeded.policies)
  expect(await readFile(anchor(original))).toEqual(originalBytes); expect(await readFile(pending)).toEqual(pendingBytes)
}, 30000)

it('migrates real custody into layout2, replays and appends in fresh processes, and refuses legacy downgrade without modification', async () => {
  const original = await directory(), seeded = await run('seed', original), originalBytes = await readFile(anchor(original)), originalStat = await stat(anchor(original))
  const migrated = await run('migrate', original)
  expect(migrated).toMatchObject({ barrier: 'migrated', validations: 2, ingestion: seeded.ingestion, inbox: seeded.inbox, policies: seeded.policies, migration: { storageLayout: 2, migrationId: 'fixture-migration', legacyBytes: originalBytes.length } })
  expect(migrated.pid).not.toBe(seeded.pid)
  const guardBytes = await readFile(anchor(original)), guard = JSON.parse(guardBytes.toString('utf8'))
  expect(guard).toMatchObject({ version: 2, layout: 'darkfactory-journal-layout/v2', migrationId: 'fixture-migration', legacyBytes: originalBytes.length })
  expect((await stat(anchor(original))).ino).toBe(originalStat.ino)
  const backup = join(staging(original), 'legacy-backup.jsonl'), target = join(staging(original), 'journal.jsonl')
  expect(migrated.migration!.backup).toBe(backup); expect(migrated.migration!.target).toBe(target)
  expect(await readFile(backup)).toEqual(originalBytes); expect(await readFile(target)).toEqual(originalBytes)
  expect(await readFile(join(partition(original), 'ingestion.jsonl.layout2.pending'))).toEqual(guardBytes)
  expect(await readFile(join(partition(original), 'ingestion.jsonl.layout2.commit'))).toEqual(guardBytes)
  const appended = await run('append', original)
  expect(appended.ingestion.custody).toHaveLength(3)
  expect(appended.ingestion.custody.slice(0, 2)).toEqual(seeded.ingestion.custody)
  expect(appended.ingestion.items).toEqual(seeded.ingestion.items); expect(appended.inbox).toEqual(seeded.inbox)
  const targetBytes = await readFile(target)
  expect(targetBytes.subarray(0, originalBytes.length)).toEqual(originalBytes); expect(targetBytes.length).toBeGreaterThan(originalBytes.length)
  expect(await readFile(anchor(original))).toEqual(guardBytes); expect(await readFile(backup)).toEqual(originalBytes)
  const legacy = await run('legacy', original)
  expect(legacy).toMatchObject({ barrier: 'legacy-refused', reduced: 0, reason: expect.stringContaining('Unsupported version') })
  expect(await readFile(anchor(original))).toEqual(guardBytes); expect(await readFile(target)).toEqual(targetBytes); expect(await readFile(backup)).toEqual(originalBytes)
  const replay = await run('replay', original)
  expect(replay.ingestion).toEqual(appended.ingestion); expect(replay.inbox).toEqual(appended.inbox); expect(replay.policies).toEqual(seeded.policies)
}, 30000)

it('rejects a missing persisted policy dependency during backup validation before migration can commit', async () => {
  const original = await directory(), seeded = await run('seed', original), originalBytes = await readFile(anchor(original))
  expect(seeded.policies).toHaveLength(1)
  await rm(join(original, 'darkfactory-policy.jsonl'))
  const rejected = await run('migrate-denied', original)
  expect(rejected).toMatchObject({ barrier: 'migration-refused', validations: 1, reason: 'Missing persisted policy reference', policies: [], ingestion: seeded.ingestion, inbox: seeded.inbox })
  expect(await readFile(anchor(original))).toEqual(originalBytes)
  expect(await readFile(join(staging(original), 'legacy-backup.jsonl'))).toEqual(originalBytes)
  await expect(readFile(join(staging(original), 'journal.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(partition(original), 'ingestion.jsonl.layout2.commit'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await run('blocked', original)).toMatchObject({ barrier: 'native-refused' })
  expect(await readFile(anchor(original))).toEqual(originalBytes)
}, 30000)
