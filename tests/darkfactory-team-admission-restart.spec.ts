import { fork, execFile, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { examples } from '../packages/agent-team/tests/darkfactory/fixtures.ts'
import { pinExecutableSpec } from '../packages/agent-team/src/darkfactory/contracts/spec.ts'
import { inboundEnvelopeSchema, inboundWorkItemSchema } from '../packages/agent-team/src/darkfactory/contracts/ingestion.ts'
import { digestJson } from '../packages/agent-team/src/darkfactory/json.ts'
import { darkFactoryTemplate } from '../packages/agent-team/src/workflow-templates.ts'
import { pinWorkflowDefinition } from '../packages/agent-team/src/workflows.ts'
import type { DarkFactoryAdmissionStore } from '../packages/agent-team/src/darkfactory/admission-store.ts'
import type { DarkFactoryIngestionStore } from '../packages/agent-team/src/darkfactory/ingestion-store.ts'
import type { TeamTaskView } from '../packages/agent-team/src/types.ts'

const children: ChildProcess[] = [], directories: string[] = []
const exited = (child: ChildProcess): Promise<void> => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', () => resolve()))
const fixtureEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/var/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = exited(child); child.kill('SIGKILL'); await done }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
function inputs(baseCommit: string) {
  const workflow = { template: darkFactoryTemplate, parameters: { subject: 'held real Team crash recovery' } }
  const { specDigest: _, ...payload } = examples.ExecutableSpecV1
  const spec = pinExecutableSpec({ ...payload, baseCommit, workflowDigest: digestJson(pinWorkflowDefinition(workflow.template, workflow.parameters)) })
  const initial = inboundWorkItemSchema.parse({ ...examples.InboundWorkItemV1, state: 'received', trust: { ...examples.InboundWorkItemV1.trust, decision: 'unresolved' } })
  return { initial, envelope: inboundEnvelopeSchema.parse({ ...examples.InboundEnvelopeV1, id: initial.envelopeId }), intent: {
    registeredLeadId: 'team-admission-restart-lead', spec, workflow,
    compilerOutcome: { schemaVersion: 1, id: 'outcome', projectId: spec.projectId, policyRevision: spec.policyRevision, source: spec.source, outcome: 'COMPILED', reasons: ['Compiled registered evidence'], spec },
    compilerCursor: { schemaVersion: 1, contextDigest: digestJson('context'), malformedAttempts: 0, phase: 'finished' },
    policyRefs: { policyRecordId: 'policy', decisionReceiptId: 'decision' },
  } }
}
interface Snapshot {
  barrier: string; pid: number; admissions: ReturnType<DarkFactoryAdmissionStore['snapshot']>; ingestion: ReturnType<DarkFactoryIngestionStore['snapshot']>
  materializations: number; modelCalls: number; tasks: TeamTaskView[]; taskEvents: unknown[]; attempts: unknown[]; readyTasks: unknown[]
  workflow: { executionId: string; steps: { phase: string }[] }; dispatchStatus: { state: string; blockers: { code: string }[] }[]
}
function launch(directory: string, mode: string, input: ReturnType<typeof inputs>) {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-team-admission.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: fixtureEnv })
  children.push(child)
  let diagnostics = ''
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000) })
  const message = new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Team migration IPC deadline: ${diagnostics}`)) }, 15000)
    child.once('message', value => { clearTimeout(timer); const result = value as Snapshot; result.barrier === 'error' ? reject(new Error(JSON.stringify(value))) : resolve(result) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Team admission fixture exited early (${code}): ${diagnostics}`)) })
  })
  child.send({ directory, mode, ...input })
  return { child, message }
}
const journalPaths = ['darkfactory/project-1/admission.jsonl', 'darkfactory/project-1/ingestion.jsonl', 'workflow-runtime.jsonl', 'workflows.jsonl']
const journals = (directory: string) => Promise.all(journalPaths.map(path => readFile(join(directory, 'workspace', path))))

it('recovers actual Team tasks after SIGKILL mid-materialization and keeps five stable tasks held through a third process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-team-admission-restart-')); directories.push(directory)
  const repository = join(directory, 'repository'); await mkdir(repository)
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args], { env: fixtureEnv })
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repository, 'fixture.txt'), 'committed fixture\n'); await git('add', 'fixture.txt'); await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
  const input = inputs((await git('rev-parse', 'HEAD')).stdout.trim())
  const writer = launch(directory, 'partial', input), before = await writer.message
  expect(before.barrier).toBe('two-team-tasks-durable')
  const pinned = before.admissions.admissions[0]!
  expect(pinned).toMatchObject({ status: 'intended', barrier: 'closed' })
  expect(before.ingestion.items[0]?.state).toBe('compiled')
  expect(before.tasks.map(task => task.id)).toEqual(pinned.receipt.taskIds.slice(0, 2))
  expect(before.taskEvents).toHaveLength(2)
  expect(before.workflow.executionId).toBe(pinned.intent.workflowId)
  expect(before.modelCalls).toBe(0); expect(before.attempts).toEqual([])
  const prefix = await journals(directory)
  // Team append #2 is durable, while its runtime task-created acknowledgement is absent.
  const runtimeEvents = prefix[2]!.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  expect(runtimeEvents.filter(event => event.type === 'workflow-runtime/task-intended')).toHaveLength(2)
  expect(runtimeEvents.filter(event => event.type === 'workflow-runtime/task-created')).toHaveLength(1)
  const killed = exited(writer.child); writer.child.kill('SIGKILL'); await killed
  expect(writer.child.signalCode).toBe('SIGKILL')
  const reader = launch(directory, 'resume', input), after = await reader.message
  await exited(reader.child); expect(reader.child.exitCode).toBe(0)
  expect(after.pid).not.toBe(before.pid)
  expect(after.admissions.admissions).toHaveLength(1)
  expect(after.admissions.admissions[0]).toMatchObject({ id: pinned.id, intent: pinned.intent, status: 'acknowledged', barrier: 'closed', receipt: { taskIds: pinned.receipt.taskIds } })
  expect(after.ingestion.items[0]?.state).toBe('acknowledged')
  expect(after.materializations).toBe(1)
  expect(after.tasks.map(task => task.id)).toEqual(pinned.receipt.taskIds)
  expect(new Set(after.tasks.map(task => task.id)).size).toBe(5)
  expect(after.taskEvents).toHaveLength(5)
  for (const task of after.tasks) {
    expect(task).toMatchObject({ status: 'pending', ready: false, factoryBinding: { admissionId: pinned.id, specDigest: pinned.intent.spec.specDigest } })
    expect(task.ownerName).toBeUndefined(); expect(task.workflowBinding?.inputs).toEqual([])
  }
  expect(after.workflow.executionId).toBe(pinned.intent.workflowId)
  expect(after.workflow.steps).toHaveLength(5)
  expect(after.workflow.steps.every(step => step.phase === 'pending')).toBe(true)
  expect(after.dispatchStatus).toHaveLength(5)
  for (const status of after.dispatchStatus) expect(status).toMatchObject({ state: 'waiting', blockers: expect.arrayContaining([expect.objectContaining({ code: 'factory-admission-held' })]) })
  expect(after.modelCalls).toBe(0); expect(after.attempts).toEqual([]); expect(after.readyTasks).toEqual([])
  const acknowledged = await journals(directory)
  acknowledged.forEach((bytes, index) => expect(bytes.subarray(0, prefix[index]!.length)).toEqual(prefix[index]))
  const replay = launch(directory, 'resume', input), unchanged = await replay.message
  await exited(replay.child); expect(replay.child.exitCode).toBe(0)
  expect(unchanged.pid).not.toBe(after.pid)
  expect(unchanged.admissions).toEqual(after.admissions); expect(unchanged.ingestion).toEqual(after.ingestion)
  expect(unchanged.tasks).toEqual(after.tasks); expect(unchanged.taskEvents).toEqual(after.taskEvents); expect(unchanged.workflow).toEqual(after.workflow)
  expect(unchanged.materializations).toBe(0); expect(unchanged.modelCalls).toBe(0); expect(unchanged.attempts).toEqual([]); expect(unchanged.readyTasks).toEqual([])
  expect(await journals(directory)).toEqual(acknowledged)
}, 45000)
