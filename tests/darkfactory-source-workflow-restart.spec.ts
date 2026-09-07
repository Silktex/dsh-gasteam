import { fork, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { enabledPolicy } from '../packages/agent-team/tests/darkfactory/config-fixture.ts'
import { digestBytes } from '../packages/agent-team/src/darkfactory/json.ts'
import type { DarkFactoryCompilationStore } from '../packages/agent-team/src/darkfactory/compilation-store.ts'
import type { DarkFactoryAdmissionStore } from '../packages/agent-team/src/darkfactory/admission-store.ts'
import type { DarkFactoryIngestionStore } from '../packages/agent-team/src/darkfactory/ingestion-store.ts'
import type { PolicyRecord, EffectDecisionReceipt } from '../packages/agent-team/src/darkfactory/policy-store.ts'
import type { ProviderRequestState } from '../packages/agent-team/src/darkfactory/provider-request-store.ts'
import type { TeamTaskView } from '../packages/agent-team/src/types.ts'
const secret = 'source-workflow-fixture-hmac', token = 'source-workflow-installation-token'
const fixtureEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/var/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DF_TEST_SECRET: secret }
const directories: string[] = [], processes: ReturnType<typeof launch>[] = [], servers: ReturnType<typeof createServer>[] = []
interface Snapshot {
  barrier: string; pid: number; compilerCalls: number; recoveryCalls: number; reproductionCalls: number; materializations: number; modelCalls: number; requestError?: string
  compilations: ReturnType<DarkFactoryCompilationStore['snapshot']>; admissions: ReturnType<DarkFactoryAdmissionStore['snapshot']>; ingestion: ReturnType<DarkFactoryIngestionStore['snapshot']>
  policy: PolicyRecord; decisions: EffectDecisionReceipt[]; inbox: { id: string }[]; http: { status: number; body: { receipt?: { id: string } } }[]
  requestBudget: ProviderRequestState
  tasks: TeamTaskView[]; taskEvents: unknown[]; attempts: unknown[]; readyTasks: unknown[]; workflow: { executionId: string; steps: { phase: string }[] } | null
  dispatchStatus: { state: string; blockers: { code: string }[] }[]
}
function launch(directory: string, baseCommit: string, mode: string, scenario = 'valid') {
  const child = fork(fileURLToPath(new URL('./fixtures/darkfactory-source-workflow.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: fixtureEnv })
  let diagnostics = '', ended = false
  child.stderr!.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000) })
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => { ended = true; resolve({ code, signal }) }))
  const message = new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Source workflow IPC deadline: ${diagnostics}`)) }, 20000)
    child.once('message', value => { clearTimeout(timer); const result = value as Snapshot & { message?: string; stack?: string }; result.barrier === 'error' ? reject(new Error(result.stack ?? result.message)) : resolve(result) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Source workflow process exited ${code}: ${diagnostics}`)) })
  })
  child.send({ directory, baseCommit, mode, scenario })
  const handle = { message, closed, async kill() { if (!ended) child.kill('SIGKILL'); return closed } }; processes.push(handle); return handle
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'factory-source-workflow-')); directories.push(directory)
  const repository = join(directory, 'repository'); await mkdir(repository)
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args], { env: fixtureEnv })
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid')
  await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git')
  await writeFile(join(repository, 'reproduce.cjs'), 'process.stdout.write(JSON.stringify({expected:"400",actual:"500"}))\n')
  await git('add', 'reproduce.cjs'); await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
  const baseCommit = (await git('rev-parse', 'HEAD')).stdout.trim(), requests: { method: string; url: string; authorized: boolean }[] = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', authorized: request.headers.authorization === `Bearer ${token}` })
    response.setHeader('content-type', 'application/json')
    if (request.method !== 'GET' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end('{}'); return }
    if (request.url === '/installation/repositories?per_page=100&page=1') response.end(JSON.stringify({ total_count: 1, repositories: [{ id: 42, full_name: 'Owner/Repo' }] }))
    else if (request.url === '/repos/owner/repo/issues/7') response.end(JSON.stringify({ id: 100, number: 7, title: 'Current provider issue', body: `Current redacted provider context ${token}`, user: { id: 12 },
      labels: [{ id: 3, name: 'automate' }], state: 'open', updated_at: '2026-09-06T12:00:00Z' }))
    else { response.writeHead(404); response.end('{}') }
  })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
  const policy = enabledPolicy(), route = policy.ingestion.routes[0]!
  if (route.source !== 'github') throw new Error('Expected GitHub fixture policy')
  policy.limits.maxArtifactBytes = 65536; policy.ingestion.maxBodyBytes = 4096
  policy.ingestion.transport = { kind: 'listener', host: '127.0.0.1', port: 0 }
  policy.verification.commands[0] = { id: 'test', executable: process.execPath, args: [join(repository, 'reproduce.cjs')], deadlineMs: 1000 }
  route.repositoryIds = ['42']; route.senderIds = ['12']; route.bindings.authorIds = ['12']
  route.reconciliation = { apiBaseUrl: `http://127.0.0.1:${address.port}`, installationId: '10', repositoryId: '42', repositoryName: 'owner/repo', credentialKind: 'installation-token',
    credentialRef: { kind: 'file', path: join(directory, 'installation-token') }, fixtureLoopback: true }
  await writeFile(join(directory, 'installation-token'), token, { mode: 0o600 })
  await writeFile(join(directory, 'policy.json'), JSON.stringify(policy), { mode: 0o600 })
  await writeFile(join(directory, 'host-registry.json'), JSON.stringify({ modelAssignmentId: 'deterministic-host-fixture', assertionId: 'status-400', capabilities: ['typescript'], paths: [{ id: 'source', path: 'src/handler.ts' }] }), { mode: 0o600 })
  return { directory, baseCommit, requests }
}
async function run(f: Awaited<ReturnType<typeof fixture>>, mode = 'resume', scenario = 'valid') {
  const child = launch(f.directory, f.baseCommit, mode, scenario), snapshot = await child.message
  expect(await child.closed).toEqual({ code: 0, signal: null }); return snapshot
}
const journals = (directory: string) => Promise.all(['darkfactory/project/ingestion.jsonl', 'darkfactory/project/compilation.jsonl', 'darkfactory/project/admission.jsonl', 'workflow-runtime.jsonl', 'workflows.jsonl', 'darkfactory-provider-requests.jsonl'].map(path => readFile(join(directory, 'workspace', path))))
function noDispatch(snapshot: Snapshot) { expect(snapshot.modelCalls).toBe(0); expect(snapshot.attempts).toEqual([]); expect(snapshot.readyTasks).toEqual([]) }
afterEach(async () => {
  await Promise.all(processes.splice(0).map(child => child.kill()))
  await Promise.all(servers.splice(0).map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) }))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it.each(['after-compiled', 'after-two-tasks'])('recovers signed current GitHub issue through durable compilation and actual held Team tasks after SIGKILL %s', async mode => {
  const f = await fixture(), writer = launch(f.directory, f.baseCommit, mode), before = await writer.message
  expect(before.barrier).toBe(mode); expect(before.http[0]!.status).toBe(202)
  expect(f.requests).toEqual([{ method: 'GET', url: '/installation/repositories?per_page=100&page=1', authorized: true }, { method: 'GET', url: '/repos/owner/repo/issues/7', authorized: true }])
  expect(before.requestBudget.charges).toHaveLength(f.requests.length)
  expect(new Set(before.requestBudget.charges.map(charge => charge.id)).size).toBe(2)
  for (const charge of before.requestBudget.charges) expect(charge).toMatchObject({ projectId: 'project', routeId: 'route' })
  const source = before.ingestion.items[0]!, compilation = before.compilations.compilations[0]!
  expect(source.trust.decision).toBe('trusted'); expect(source.title).toBe('Current provider issue'); expect(source.context).toContain('[redacted]')
  expect(source.repository.repositoryId).toBe('42'); expect(source.author).toBe('12'); expect(source.actor).toBe('12')
  expect(compilation.intent.context.ingress.sourceRevision).toBe(source.sourceRevision)
  expect(compilation.intent.context.policyDigest).toBe(before.policy.digest); expect(compilation.intent.policyRefs.policyRecordId).toBe(before.policy.id)
  expect(before.decisions.some(receipt => receipt.id === compilation.intent.policyRefs.decisionReceiptId && receipt.decision === 'allow')).toBe(true)
  expect(compilation.admissionIntent!.spec.source.sourceRevision).toBe(source.sourceRevision)
  expect(compilation.intent.context.registries.checks[0]!.id).toBe(before.policy.policy.verification.checkIds[0])
  expect(compilation.intent.context.registries.commands).toEqual(before.policy.policy.verification.commands)
  const evidence = [...compilation.admissionIntent!.spec.provenance, ...compilation.admissionIntent!.spec.acceptanceScenarios.map(value => value.reproduction)]
  for (const reference of evidence) {
    const bytes = await readFile(join(f.directory, 'workspace/darkfactory/project/artifacts', reference.id))
    expect(reference.projectId).toBe(source.projectId); expect(bytes.length).toBe(reference.sizeBytes); expect(digestBytes(bytes)).toBe(reference.digest)
    expect(bytes.toString('utf8')).not.toContain(token); expect(bytes.toString('utf8')).not.toContain('RAW_WEBHOOK_NARRATIVE_SENTINEL')
  }
  expect(before.compilerCalls).toBe(1); expect(before.reproductionCalls).toBe(1); expect(before.tasks).toHaveLength(mode === 'after-two-tasks' ? 2 : 0)
  noDispatch(before)
  const prefix = await journals(f.directory)
  expect(await writer.kill()).toEqual({ code: null, signal: 'SIGKILL' })
  const after = await run(f), admission = after.admissions.admissions[0]!
  expect(after.pid).not.toBe(before.pid); expect(after.compilations.compilations).toHaveLength(1); expect(after.admissions.admissions).toHaveLength(1)
  expect(after.compilations.compilations[0]).toMatchObject({ id: compilation.id, status: 'admitted', admissionReceipt: admission.receipt })
  expect(admission).toMatchObject({ status: 'acknowledged', barrier: 'closed' }); expect(after.ingestion.items[0]!.state).toBe('acknowledged')
  expect(after.tasks.map(task => task.id)).toEqual(admission.receipt.taskIds); expect(new Set(admission.receipt.taskIds).size).toBe(5); expect(after.taskEvents).toHaveLength(5)
  for (const task of after.tasks) expect(task).toMatchObject({ status: 'pending', ready: false, factoryBinding: { admissionId: admission.id, specDigest: admission.intent.spec.specDigest } })
  expect(after.workflow!.executionId).toBe(admission.intent.workflowId); expect(after.workflow!.steps.every(step => step.phase === 'pending')).toBe(true)
  for (const status of after.dispatchStatus) expect(status.blockers.some(blocker => blocker.code === 'factory-admission-held')).toBe(true)
  expect(after.compilerCalls).toBe(0); expect(after.recoveryCalls).toBe(0); expect(after.reproductionCalls).toBe(0); expect(f.requests).toHaveLength(2); noDispatch(after)
  expect(after.requestBudget.charges).toEqual(before.requestBudget.charges)
  const bytes = await journals(f.directory); bytes.forEach((value, index) => expect(value.subarray(0, prefix[index]!.length)).toEqual(prefix[index]))
  const runtimeEvents = bytes[3]!.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  expect(runtimeEvents.filter(event => event.type === 'workflow-runtime/created')).toHaveLength(1)
  const replay = await run(f)
  expect(replay.compilations).toEqual(after.compilations); expect(replay.admissions).toEqual(after.admissions); expect(replay.ingestion).toEqual(after.ingestion)
  expect(replay.tasks).toEqual(after.tasks); expect(replay.taskEvents).toEqual(after.taskEvents); expect(replay.policy).toEqual(before.policy)
  expect(replay.requestBudget).toEqual(after.requestBudget)
  expect(replay.compilerCalls).toBe(0); expect(replay.recoveryCalls).toBe(0); expect(replay.materializations).toBe(0); expect(f.requests).toHaveLength(2); noDispatch(replay)
  expect(await journals(f.directory)).toEqual(bytes)
  const persisted = Buffer.concat(bytes).toString('utf8'); expect(persisted).not.toContain(secret); expect(persisted).not.toContain(token); expect(persisted).not.toContain('RAW_WEBHOOK_NARRATIVE_SENTINEL')
}, 45000)

it.each(['forged', 'replayed', 'ambiguous', 'conflicting', 'malformed', 'cross-project'])('keeps %s source/compiler input out of Team workflows and dispatch', async scenario => {
  const f = await fixture(), result = await run(f, 'negative', scenario)
  expect(result.requestBudget.charges).toHaveLength(f.requests.length)
  expect(result.tasks).toEqual([]); expect(result.taskEvents).toEqual([]); expect(result.admissions.admissions).toEqual([]); expect(result.materializations).toBe(0); noDispatch(result)
  if (scenario === 'forged') { expect(result.http[0]!.status).toBe(401); expect(result.ingestion.custody).toEqual([]); expect(f.requests).toEqual([]); expect(result.compilerCalls).toBe(0) }
  else if (scenario === 'replayed') { expect(result.http.map(value => value.status)).toEqual([202, 200]); expect(result.http[1]!.body.receipt!.id).toBe(result.http[0]!.body.receipt!.id); expect(result.ingestion.custody).toHaveLength(1); expect(result.compilerCalls).toBe(0) }
  else if (scenario === 'cross-project') { expect(result.requestError).toContain('Cross-project'); expect(result.compilations.compilations).toEqual([]); expect(result.compilerCalls).toBe(0) }
  else { expect(result.compilations.compilations[0]!.status).toBe('quarantined'); expect(result.ingestion.items[0]!.state).toBe('quarantined'); expect(result.inbox).toHaveLength(1); expect(result.compilerCalls).toBe(scenario === 'malformed' ? 2 : 1) }
  if (scenario === 'malformed') expect((await journals(f.directory))[1]!.toString('utf8')).not.toContain('MALFORMED_PRIVATE_SENTINEL')
}, 30000)
