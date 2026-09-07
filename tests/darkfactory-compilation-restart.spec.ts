import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { compilationFixture } from '../packages/agent-team/tests/darkfactory/compilation-fixture.ts'
import type { DarkFactoryCompilationStore } from '../packages/agent-team/src/darkfactory/compilation-store.ts'
import type { DarkFactoryAdmissionStore } from '../packages/agent-team/src/darkfactory/admission-store.ts'
import type { DarkFactoryIngestionStore } from '../packages/agent-team/src/darkfactory/ingestion-store.ts'
import type { OperatorEscalation } from '../packages/agent-team/src/health.ts'
interface Snapshot {
  barrier: string; pid: number; calls: string[]; lookups: string[]; materializations: number
  compilations: ReturnType<DarkFactoryCompilationStore['snapshot']>
  admissions: ReturnType<DarkFactoryAdmissionStore['snapshot']>
  ingestion: ReturnType<DarkFactoryIngestionStore['snapshot']>; inbox: OperatorEscalation[]
}
const directories: string[] = [], processes: ReturnType<typeof launch>[] = []
function launch(directory: string, mode: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-compilation.mjs', import.meta.url)), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/var/tmp' },
  })
  let diagnostics = '', ended = false
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000) })
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => { ended = true; resolve({ code, signal }) }))
  const message = new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Compiler IPC deadline: ${diagnostics}`)) }, 10_000)
    child.once('message', value => { clearTimeout(timer); const snapshot = value as Snapshot & { message?: string }; snapshot.barrier === 'error' ? reject(new Error(snapshot.message)) : resolve(snapshot) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Compiler fixture exited ${code}: ${diagnostics}`)) })
  })
  child.send({ directory, mode, fixture: compilationFixture() })
  const handle = { message, closed, async kill() { if (!ended) child.kill('SIGKILL'); return closed } }
  processes.push(handle)
  return handle
}
async function directory() { const path = await mkdtemp(join(tmpdir(), 'factory-compilation-restart-')); directories.push(path); return path }
async function run(path: string, mode = 'resume') {
  const child = launch(path, mode), snapshot = await child.message
  expect(await child.closed).toEqual({ code: 0, signal: null })
  return snapshot
}
const journal = (path: string) => join(path, 'darkfactory/project-1/compilation.jsonl')
afterEach(async () => { await Promise.all(processes.splice(0).map(child => child.kill())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it.each(['after-attempt', 'after-callback', 'after-malformed', 'after-compiled', 'after-handoff'])('recovers compiler SIGKILL %s into one exact held admission', async mode => {
  const path = await directory(), writer = launch(path, mode), before = await writer.message
  expect(before.barrier).toBe(mode)
  expect(before.compilations.compilations).toHaveLength(1)
  const record = before.compilations.compilations[0]!, prefix = await readFile(journal(path), 'utf8')
  if (mode === 'after-malformed') expect(record.status).toBe('repair')
  if (mode === 'after-handoff') expect(before.ingestion.items[0]!.state).toBe('acknowledged')
  expect(prefix).not.toContain('MALFORMED_PRIVATE_SENTINEL')
  expect(await writer.kill()).toEqual({ code: null, signal: 'SIGKILL' })
  const after = await run(path)
  expect(after.pid).not.toBe(before.pid)
  expect(after.compilations.compilations).toHaveLength(1)
  expect(after.compilations.compilations[0]).toMatchObject({ id: record.id, status: 'admitted' })
  expect(after.admissions.admissions).toHaveLength(1)
  expect(after.admissions.admissions[0]).toMatchObject({ status: 'acknowledged', barrier: 'closed' })
  expect(after.admissions.admissions[0]!.receipt.taskIds).toHaveLength(5)
  expect(after.ingestion.items[0]!.state).toBe('acknowledged')
  expect(after.inbox).toEqual([])
  if (mode === 'after-callback') { expect(after.calls).toEqual([]); expect(after.lookups).toEqual(before.calls) }
  if (mode === 'after-attempt') { expect(before.calls).toEqual([]); expect(after.calls).toEqual(after.lookups); expect(after.calls).toHaveLength(1) }
  if (mode === 'after-malformed') { expect(after.calls).toHaveLength(1); expect(after.calls[0]).not.toBe(before.calls[0]) }
  if (mode === 'after-compiled' || mode === 'after-handoff') { expect(after.calls).toEqual([]); expect(after.lookups).toEqual([]) }
  const bytes = await readFile(journal(path), 'utf8')
  expect(bytes.startsWith(prefix)).toBe(true)
  expect(bytes).not.toContain('MALFORMED_PRIVATE_SENTINEL')
  const replay = await run(path)
  expect(replay.compilations).toEqual(after.compilations)
  expect(replay.admissions).toEqual(after.admissions)
  expect(replay.ingestion).toEqual(after.ingestion)
  expect(replay.calls).toEqual([]); expect(replay.lookups).toEqual([]); expect(replay.materializations).toBe(0)
  expect(await readFile(journal(path), 'utf8')).toBe(bytes)
}, 25_000)

it.each(['resume-unknown', 'resume-denied', 'resume-malformed'])('durably quarantines %s without new admission or lost repair accounting', async mode => {
  const path = await directory(), writer = launch(path, mode === 'resume-malformed' ? 'after-malformed' : 'after-callback')
  await writer.message; await writer.kill()
  const after = await run(path, mode)
  expect(after.compilations.compilations[0]!.status).toBe('quarantined')
  expect(after.ingestion.items[0]!.state).toBe('quarantined')
  expect(after.admissions.admissions).toEqual([]); expect(after.materializations).toBe(0)
  expect(after.inbox).toHaveLength(1)
  expect(after.ingestion.items[0]!.healthEscalationId).toBe(after.inbox[0]!.id)
  expect(after.calls).toHaveLength(mode === 'resume-malformed' ? 1 : 0)
  const replay = await run(path, mode)
  expect(replay.compilations).toEqual(after.compilations)
  expect(replay.ingestion).toEqual(after.ingestion)
  expect(replay.inbox).toEqual(after.inbox); expect(replay.calls).toEqual([])
  expect(await readFile(journal(path), 'utf8')).not.toContain('MALFORMED_PRIVATE_SENTINEL')
}, 25_000)

it('reuses the actual inbox incident after SIGKILL between escalation and compilation quarantine', async () => {
  const path = await directory(), writer = launch(path, 'after-callback')
  await writer.message; await writer.kill()
  const quarantining = launch(path, 'resume-health-barrier'), before = await quarantining.message
  expect(before.barrier).toBe('after-health'); expect(before.inbox).toHaveLength(1)
  expect(before.compilations.compilations[0]!.status).toBe('attempting')
  await quarantining.kill()
  const after = await run(path, 'resume-unknown')
  expect(after.inbox).toEqual(before.inbox)
  expect(after.compilations.compilations[0]).toMatchObject({ status: 'quarantined', healthEscalationId: before.inbox[0]!.id })
  expect(after.ingestion.items[0]!.healthEscalationId).toBe(before.inbox[0]!.id)
  expect(after.calls).toEqual([]); expect(after.materializations).toBe(0)
}, 25_000)
