import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { examples } from '../packages/agent-team/tests/darkfactory/fixtures.ts'
import { pinExecutableSpec } from '../packages/agent-team/src/darkfactory/contracts/spec.ts'
import { inboundEnvelopeSchema, inboundWorkItemSchema } from '../packages/agent-team/src/darkfactory/contracts/ingestion.ts'
import { digestJson } from '../packages/agent-team/src/darkfactory/json.ts'
import { darkFactoryTemplate } from '../packages/agent-team/src/workflow-templates.ts'
import { pinWorkflowDefinition } from '../packages/agent-team/src/workflows.ts'
import type { DarkFactoryAdmissionStore } from '../packages/agent-team/src/darkfactory/admission-store.ts'
import type { DarkFactoryIngestionStore } from '../packages/agent-team/src/darkfactory/ingestion-store.ts'
const children: ChildProcess[] = [], directories: string[] = []
const exited = (child: ChildProcess): Promise<void> => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', () => resolve()))
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = exited(child); child.kill('SIGKILL'); await done }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
function inputs() {
  const workflow = { template: darkFactoryTemplate, parameters: { subject: 'held crash recovery' } }
  const { specDigest: _, ...payload } = examples.ExecutableSpecV1
  const spec = pinExecutableSpec({ ...payload, workflowDigest: digestJson(pinWorkflowDefinition(workflow.template, workflow.parameters)) })
  const initial = inboundWorkItemSchema.parse({ ...examples.InboundWorkItemV1, state: 'received', trust: { ...examples.InboundWorkItemV1.trust, decision: 'unresolved' } })
  return { initial, envelope: inboundEnvelopeSchema.parse({ ...examples.InboundEnvelopeV1, id: initial.envelopeId }), intent: {
    registeredLeadId: 'lead', spec, workflow,
    compilerOutcome: { schemaVersion: 1, id: 'outcome', projectId: spec.projectId, policyRevision: spec.policyRevision, source: spec.source, outcome: 'COMPILED', reasons: ['Compiled registered evidence'], spec },
    compilerCursor: { schemaVersion: 1, contextDigest: digestJson('context'), malformedAttempts: 0, phase: 'finished' },
    policyRefs: { policyRecordId: 'policy', decisionReceiptId: 'decision' },
  } }
}
interface Snapshot { barrier: string; pid: number; admissions: ReturnType<DarkFactoryAdmissionStore['snapshot']>; ingestion: ReturnType<DarkFactoryIngestionStore['snapshot']>; materializations: number }
function launch(directory: string, mode: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-admission.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  let diagnostics = ''
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000) })
  const message = new Promise<Snapshot>((resolve, reject) => {
    child.once('message', value => { const result = value as Snapshot; result.barrier === 'error' ? reject(new Error(JSON.stringify(value))) : resolve(result) })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Admission fixture exited early (${code}): ${diagnostics}`)))
  })
  child.send({ directory, mode, ...inputs() })
  return { child, message }
}
it.each(['after-intent', 'after-materialization', 'after-admission-ack'])('recovers built admission controller after SIGKILL %s with unchanged held identities', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-admission-restart-')); directories.push(directory)
  const writer = launch(directory, mode), before = await writer.message
  expect(before.barrier).toBe(mode)
  const pinned = before.admissions.admissions[0]!
  expect(pinned.barrier).toBe('closed')
  expect(pinned.intent.plannedSteps).toHaveLength(5)
  const filename = join(directory, 'darkfactory/project-1/admission.jsonl'), synced = await readFile(filename, 'utf8')
  expect(synced).toContain(pinned.intent.intentDigest)
  const killed = exited(writer.child); writer.child.kill('SIGKILL'); await killed
  expect(writer.child.signalCode).toBe('SIGKILL')
  const reader = launch(directory, 'resume'), after = await reader.message
  await exited(reader.child); expect(reader.child.exitCode).toBe(0)
  expect(after.pid).not.toBe(before.pid)
  expect(after.admissions.admissions).toHaveLength(1)
  expect(after.admissions.admissions[0]).toMatchObject({ id: pinned.id, intent: pinned.intent, status: 'acknowledged', barrier: 'closed', receipt: { taskIds: pinned.receipt.taskIds } })
  expect(after.ingestion.items[0]?.state).toBe('acknowledged')
  expect(after.materializations).toBe(mode === 'after-admission-ack' ? 0 : 1)
  expect((await readFile(filename, 'utf8')).startsWith(synced)).toBe(true)
  expect(JSON.parse(await readFile(join(directory, 'held-materialization.json'), 'utf8')).taskIds).toEqual(pinned.receipt.taskIds)
  const replay = launch(directory, 'resume'), unchanged = await replay.message
  await exited(replay.child); expect(replay.child.exitCode).toBe(0)
  expect(unchanged.admissions).toEqual(after.admissions)
  expect(unchanged.ingestion).toEqual(after.ingestion)
  expect(unchanged.materializations).toBe(0)
}, 15_000)
