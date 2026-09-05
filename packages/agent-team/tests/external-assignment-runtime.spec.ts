import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ExternalAssignmentRuntime } from '../src/external-assignment-runtime.ts'
import { ExternalRuntimeStore } from '../src/external-runtime.ts'
import { ExternalRuntimeSupervisorClient, ExternalRuntimeSupervisorObserver } from '../src/external-runtime-supervisor.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const fixture = resolve('packages/agent-team/tests/fixtures/external-runtime-fixture.mjs')
const admission = { executable: fixture, configuredExecutable: '/configured/codex', version: '0.153.4', executableVerification: 'verified' as const, cwd: process.cwd(), model: 'gpt-5.6-codex', sandbox: 'workspace-write' as const, authStatus: 'authenticated' as const }

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gasteam-external-assignment-'))
  roots.push(root)
  const store = await ExternalRuntimeStore.open(root)
  const client = new ExternalRuntimeSupervisorClient({ executable: process.execPath, helperArgs: ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts')] })
  return { root, store, runtime: new ExternalAssignmentRuntime(store, client) }
}

it('durably launches, observes exact thread/report, and releases capacity only after terminal proof', async () => {
  const { root, store, runtime } = await setup()
  const launch = { attemptId: 'attempt-ext', generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'codex-report' }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }
  const started = await runtime.start(launch)
  expect(started).toMatchObject({ phase: 'running', admission: { executableVerification: 'verified', authStatus: 'authenticated' }, retainsCapacity: true })
  await waitFor(async () => (await runtime.observe('attempt-ext', 1, root)).phase === 'completed')
  expect(store.get('attempt-ext', 1)).toMatchObject({ threadId: 'fixture-thread', result: 'fixture external report', terminal: { outcome: 'completed' }, retainsCapacity: false })
  await store.close()
})

it('attributes documented completed-turn provider usage to its immutable external attempt', async () => {
  const { root, store, runtime } = await setup()
  const launch = { attemptId: 'attempt-usage-report', generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'codex-usage-report' }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }
  await runtime.start(launch)
  await waitFor(async () => (await runtime.observe('attempt-usage-report', 1, root)).phase === 'completed')
  const record = store.get('attempt-usage-report', 1)!
  expect(record.usage).toEqual({ inputTokens: 101, cachedInputTokens: 23, outputTokens: 37, reasoningOutputTokens: 11, runtimeRevision: record.usage!.runtimeRevision })
  expect(record).not.toHaveProperty('cost')
  await store.close()
})

it('leaves malformed provider usage unknown and rejects conflicting completed-turn usage', async () => {
  const { root, store, runtime } = await setup()
  const launch = { attemptId: 'attempt-malformed-usage', generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'codex-malformed-usage-report' }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }
  await runtime.start(launch)
  await waitFor(async () => (await runtime.observe('attempt-malformed-usage', 1, root)).phase === 'completed')
  expect(store.get('attempt-malformed-usage', 1)?.usage).toBeUndefined()
  await store.close()
})

it('pins its supplied code-worktree common directory as the only writable grant', async () => {
  const { root, store, runtime } = await setup()
  const worktree = { attemptId: 'attempt-code-grant', generation: 1, runtimeId: 'runtime-code-grant', directory: root, repository: resolve(process.cwd()), commonDirectory: resolve(process.cwd()), cwd: root, branch: 'dsh-external/runtime-code-grant', baseCommit: 'a'.repeat(40) }
  const launch = { attemptId: 'attempt-code-grant', generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'codex-report' }, maxSpoolBytes: 65_536, terminateGraceMs: 50, worktree }
  await runtime.start(launch)
  const manifest = JSON.parse(await readFile(join(root, 'supervisor-request.json'), 'utf8')) as { request: { writableDirectories?: string[], args?: string[] } }
  expect(manifest.request.writableDirectories).toEqual([worktree.commonDirectory])
  expect(manifest.request.args).toEqual(expect.arrayContaining(['--cd', worktree.cwd, '--add-dir', worktree.commonDirectory]))
  await writeFile(join(root, 'supervisor-request.json'), JSON.stringify({ request: { ...manifest.request, writableDirectories: [root] } }))
  await expect(runtime.start(launch)).resolves.toMatchObject({ phase: 'uncertain', retainsCapacity: true })
  await store.close()
})

it('restart observation never relaunches an existing helper and cancellation fences late output', async () => {
  const { root, store, runtime } = await setup()
  const counter = join(root, 'starts.log')
  const launch = { attemptId: 'attempt-cancel', generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'side-effect-silent', counter }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }
  await runtime.start(launch)
  await waitFor(async () => (await readFile(counter, 'utf8').catch(() => '')).includes('target-started'))
  const restarted = new ExternalAssignmentRuntime(store, new ExternalRuntimeSupervisorClient({ executable: process.execPath, helperArgs: ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts')] }))
  await expect(restarted.start({ ...launch, directory: join(root, 'swapped') })).rejects.toThrow(/directory/i)
  await expect(restarted.start({ ...launch, verifiedAdmission: { ...admission, model: 'different-model' } })).rejects.toThrow(/admission/i)
  await expect(restarted.start({ ...launch, terminateGraceMs: 51 })).rejects.toThrow(/termination policy/i)
  await expect(restarted.start({ ...launch, prompt: { mode: 'side-effect-silent', counter, changed: true } })).rejects.toThrow(/prompt/i)
  await store.markUncertain('attempt-cancel', 1, 'restart raced helper identity')
  await expect(restarted.start(launch)).resolves.toMatchObject({ phase: 'running' })
  expect((await readFile(counter, 'utf8')).split('\n').filter(Boolean)).toEqual(['target-started'])
  await restarted.cancel('attempt-cancel', 1, root, 'operator cancellation')
  await waitFor(async () => (await restarted.observe('attempt-cancel', 1, root)).phase === 'cancelled')
  expect(store.get('attempt-cancel', 1)).toMatchObject({ terminal: { outcome: 'cancelled' }, retainsCapacity: false })
  await store.close()
})

it('rejects swapped helper spool, containment, and termination policy manifests without a second target effect', async () => {
  for (const [field, value] of [['maxSpoolBytes', 65_537], ['containment', 'other'], ['terminateGraceMs', 51]] as const) {
    const { root, store, runtime } = await setup()
    const counter = join(root, 'starts.log')
    const launch = { attemptId: `attempt-policy-${field}`, generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'side-effect', counter }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }
    await runtime.start(launch)
    await waitFor(async () => (await new ExternalRuntimeSupervisorObserver().observe(root)).state === 'stopped')
    const manifest = JSON.parse(await readFile(join(root, 'supervisor-request.json'), 'utf8')) as { request: Record<string, unknown> }
    await writeFile(join(root, 'supervisor-request.json'), JSON.stringify({ request: { ...manifest.request, [field]: value } }))
    await expect(runtime.start(launch)).resolves.toMatchObject({ phase: 'uncertain', retainsCapacity: true })
    expect((await readFile(counter, 'utf8')).split('\n').filter(Boolean)).toEqual(['target-started'])
    await store.close()
  }
})

it('reconciles a cancellation journal-to-helper crash gap without accepting late report output', async () => {
  const { root, store, runtime } = await setup()
  const launch = { attemptId: 'attempt-cancel-gap', generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'side-effect-late-output', counter: join(root, 'starts.log') }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }
  await runtime.start(launch)
  // This is the durable half of cancel(); simulate a caller crash before it
  // writes cancellation-request.json for the live detached helper.
  await store.recordCancellation('attempt-cancel-gap', 1, 'durable operator cancellation')
  await expect(readFile(join(root, 'cancellation-request.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await waitFor(async () => (await runtime.observe('attempt-cancel-gap', 1, root)).phase === 'cancelled')
  expect(JSON.parse(await readFile(join(root, 'cancellation-request.json'), 'utf8'))).toEqual({ attemptId: 'attempt-cancel-gap', generation: 1, reason: 'durable operator cancellation' })
  const record = store.get('attempt-cancel-gap', 1)!
  expect(record).toMatchObject({ terminal: { outcome: 'cancelled' }, retainsCapacity: false })
  expect(record.fencedOutputCount).toBeLessThanOrEqual(1)
  expect(record.result).toBeUndefined()
  expect(record.threadId).toBeUndefined()
  const journal = await readFile(join(root, 'external-runtime.jsonl'), 'utf8')
  expect(journal.match(/"type":"external\/cancel"/g)).toHaveLength(1)
  await store.close()
})

it('selects the final Codex agent message and idempotently replays partially journaled turn receipts', async () => {
  const { root, store, runtime } = await setup()
  const launch = { attemptId: 'attempt-multi', generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'codex-multi-report' }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }
  await runtime.start(launch)
  await waitFor(async () => (await new ExternalRuntimeSupervisorObserver().observe(root)).state === 'stopped')
  // Simulate a crash after each durable parsing receipt, before terminal proof
  // is accepted. Re-observation must replay the same thread/result/turn facts.
  await store.recordThread('attempt-multi', 1, 'fixture-thread')
  await store.recordResult('attempt-multi', 1, 'fixture final report')
  await store.recordTurnCompleted('attempt-multi', 1)
  const helperExit = JSON.parse(await readFile(join(root, 'helper-exit.json'), 'utf8')) as { exit: { code: number | null; signal: string | null } }
  await store.recordExit('attempt-multi', 1, helperExit.exit)
  const beforeReplay = store.get('attempt-multi', 1)!
  await expect(Promise.all([runtime.observe('attempt-multi', 1, root), runtime.observe('attempt-multi', 1, root)])).resolves.toEqual([expect.objectContaining({ phase: 'completed', result: 'fixture final report', threadId: 'fixture-thread', revision: beforeReplay.revision + 1 }), expect.objectContaining({ phase: 'completed', result: 'fixture final report', threadId: 'fixture-thread', revision: beforeReplay.revision + 1 })])
  expect(store.get('attempt-multi', 1)).toMatchObject({ terminal: { outcome: 'completed' }, result: 'fixture final report', retainsCapacity: false })
  await store.close()
})

it('recovers a launch-gap identity once and rejects a swapped terminal receipt without releasing capacity', async () => {
  const { root, store, runtime } = await setup()
  const launch = { attemptId: 'attempt-gap', generation: 1, directory: root, verifiedAdmission: admission, prompt: { mode: 'side-effect-silent', counter: join(root, 'starts.log') }, maxSpoolBytes: 65_536, terminateGraceMs: 50 }
  const input = `${JSON.stringify(launch.prompt)}\n`
  await store.prepareLaunch({ attemptId: launch.attemptId, generation: launch.generation, provider: 'codex-cli', runtimeIdentity: { provider: 'codex-cli', kind: 'new', attemptId: launch.attemptId, generation: launch.generation, executable: admission.executable, version: admission.version, cwd: admission.cwd, model: admission.model, sandbox: admission.sandbox }, admission, inputSha256: createHash('sha256').update(input).digest('hex'), spool: { directory: root, stdout: join(root, 'stdout.log'), stderr: join(root, 'stderr.log'), maxBytes: launch.maxSpoolBytes }, supervision: { containment: 'pid-namespace', terminateGraceMs: launch.terminateGraceMs } })
  // Simulate a crash after detached helper launch but before process-started
  // journal append. An earlier conservative patrol may already have fenced it.
  await store.markUncertain('attempt-gap', 1, 'caller died after helper launch')
  const client = new ExternalRuntimeSupervisorClient({ executable: process.execPath, helperArgs: ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts')] })
  await client.launch({ attemptId: launch.attemptId, generation: launch.generation, directory: root, command: admission.executable, args: ['exec', '--json', '--config', 'approval_policy="never"', '--cd', admission.cwd, '--model', admission.model, '--sandbox', admission.sandbox, '-'], cwd: admission.cwd, stdin: input, maxSpoolBytes: launch.maxSpoolBytes, terminateGraceMs: launch.terminateGraceMs, containment: 'pid-namespace' })
  await waitFor(async () => (await runtime.observe('attempt-gap', 1, root)).phase === 'running')
  const repaired = store.get('attempt-gap', 1)!
  await expect(runtime.observe('attempt-gap', 1, root)).resolves.toMatchObject({ phase: 'running', revision: repaired.revision })
  await runtime.cancel('attempt-gap', 1, root, 'test cleanup')
  await waitFor(async () => (await runtime.observe('attempt-gap', 1, root)).phase === 'cancelled')
  await store.close()

  const receiptRoot = await mkdtemp(join(tmpdir(), 'gasteam-external-receipt-'))
  roots.push(receiptRoot)
  const receiptStore = await ExternalRuntimeStore.open(receiptRoot)
  const receiptRuntime = new ExternalAssignmentRuntime(receiptStore, new ExternalRuntimeSupervisorClient({ executable: process.execPath, helperArgs: ['--import', 'tsx', resolve('packages/agent-team/src/external-runtime-supervisor.ts')] }))
  const receiptLaunch = { ...launch, attemptId: 'attempt-receipt', directory: receiptRoot, prompt: { mode: 'codex-report' } }
  await receiptRuntime.start(receiptLaunch)
  const observer = new ExternalRuntimeSupervisorObserver()
  await waitFor(async () => (await observer.observe(receiptRoot)).state === 'stopped')
  const exit = JSON.parse(await readFile(join(receiptRoot, 'helper-exit.json'), 'utf8')) as Record<string, unknown>
  await writeFile(join(receiptRoot, 'helper-exit.json'), JSON.stringify({ ...exit, attemptId: 'other-attempt' }))
  await expect(receiptRuntime.observe('attempt-receipt', 1, receiptRoot)).resolves.toMatchObject({ phase: 'uncertain', retainsCapacity: true })
  await receiptStore.close()
})

async function waitFor(condition: () => Promise<boolean>, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for external assignment')
}
