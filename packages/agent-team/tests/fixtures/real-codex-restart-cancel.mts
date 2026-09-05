/**
 * Explicit, opt-in authenticated Codex restart/cancel conformance harness.
 *
 * It deliberately has no test registration: invoking it spends provider quota.
 * The historical vJKz4L evidence predates this reconstructed file; do not use
 * that evidence as proof that this source has run.
 */
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '../../src/index.ts'
import * as GitWorktrees from '../../src/git-worktrees.ts'
import { GitIntegrationProvider } from '../../src/git-integration-provider.ts'
import { WorkspaceCoordinator } from '../../src/coordinator.ts'

const executable = process.env.GASTEAM_REAL_CODEX_EXECUTABLE
const version = process.env.GASTEAM_REAL_CODEX_VERSION
const model = process.env.GASTEAM_REAL_CODEX_MODEL
if (!executable || !version || !model) throw new Error('Set GASTEAM_REAL_CODEX_EXECUTABLE, GASTEAM_REAL_CODEX_VERSION, and GASTEAM_REAL_CODEX_MODEL for this explicit conformance run')
const role = process.argv[2] ?? 'parent'
const root = process.argv[3] ?? await mkdtemp(join(tmpdir(), 'gasteam-real-codex-restart-cancel-'))
const repo = join(root, 'repository'), coordinatorDirectory = join(root, 'coordinator')
const leadId = SessionId('real-codex-restart-cancel-lead')
const config = { directory: coordinatorDirectory, execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 1, dispatchIntervalMs: 50, externalCodex: {
  projectId: 'real-codex-restart-cancel', directory: join(root, 'external-runtime'), codeWorktreeDirectory: join(root, 'external-code-worktrees'), cwd: repo,
  executable, version, model, sandbox: 'workspace-write' as const, maxSpoolBytes: 65_536, terminateGraceMs: 10_000, admissionMaxOutputBytes: 16_384, admissionTimeoutMs: 5_000,
} } }

async function open(executionEnabled = true): Promise<{ context: Context; coordinator: WorkspaceCoordinator; lead: any }> {
  const context = new Context()
  await mountAgentLoopTestDependencies(context); await context.plugin(SessionProjectionRegistry)
  await context.plugin(JsonlSessionPersistence, { root: join(root, 'jsonl'), compression: 'none' })
  await context.plugin(AgentLoop, { agents: [] }); await context.plugin(SubagentService); await context.plugin(SubagentSpawn, { providerName: 'spawn' })
  await context.plugin(TeamService, { worktreeProvider: 'git', integrationProvider: 'git' }); await context.plugin(GitWorktrees, { directory: join(root, 'workers') })
  context.agentTeams.registerIntegrationProvider(new GitIntegrationProvider({ providerName: 'git', targetBranch: 'main', verification: [{ command: 'node', args: ['--version'] }], commandTimeoutMs: 10_000, verificationTimeoutMs: 10_000 }))
  const lead = context.agents.get(leadId) ?? (await context.agents.resume({ resumeSessionId: leadId, agentOptions: { provider: 'mock', model: 'mock' } }).catch(() => undefined))?.agent ?? context.agentLoop.create(leadId, { provider: 'mock', model: 'mock' }, { cwd: repo })
  return { context, coordinator: await WorkspaceCoordinator.open(context, executionEnabled ? config : { directory: coordinatorDirectory }), lead }
}
const waitFor = async (predicate: () => Promise<boolean>, timeout = 120_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 250)) }
  throw new Error('Timed out waiting for real Codex restart/cancel barrier')
}
const waitForMessage = async (child: ReturnType<typeof fork>, timeout = 120_000) => await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => done(new Error('Timed out waiting for launch child barrier')), timeout)
  const done = (error?: Error) => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); error ? reject(error) : resolve() }
  const message = (value: unknown) => (value as { ready?: boolean }).ready ? done() : done(new Error('launch child sent invalid barrier'))
  const exited = (code: number | null, signal: NodeJS.Signals | null) => done(new Error(`launch child exited before barrier: ${code ?? signal}`))
  child.once('message', message); child.once('exit', exited)
})
const worktreeMarker = async (attemptId: string) => {
  const directory = join(root, 'external-code-worktrees', attemptId)
  const marker = await readFile(join(directory, 'REAL_CODEX_RESTART_MARKER.txt'), 'utf8').catch(() => undefined)
  if (marker !== undefined) return directory
  throw new Error(`external runtime did not create the required committed marker in its linked worktree: ${directory}`)
}

if (role === 'launch') {
  let opened: Awaited<ReturnType<typeof open>> | undefined
  try {
    opened = await open(false)
    await opened.coordinator.register(opened.lead, { id: 'real-codex-restart-cancel', repository: repo, teamIds: [opened.lead.id], targetBranch: 'main', capacity: 1, verification: { revision: 1, commands: [{ command: 'node', args: ['--version'] }] } })
    await opened.coordinator.close()
    await opened.context.fiber.dispose()
    opened = await open()
    const task = await opened.coordinator.acceptTask(opened.lead, 'real-codex-restart-cancel', { subject: 'real Codex restart cancellation marker', description: 'Create and ordinary-commit REAL_CODEX_RESTART_MARKER.txt containing exactly "real-codex-restart-cancel\\n" in the linked checkout. Then wait 180 seconds without a final response.' })
    await waitFor(async () => { await opened!.coordinator.reconcile(); return opened!.coordinator.view().attempts.some(value => value.taskId === task.id && value.provider === 'external' && value.phase === 'active') })
    const attempt = opened.coordinator.view().attempts.find(value => value.taskId === task.id)!
    await waitFor(async () => worktreeMarker(attempt.attemptId).then(() => true).catch(() => false))
    const supervisor = JSON.parse(await readFile(join(root, 'external-runtime', attempt.attemptId, 'supervisor.json'), 'utf8')) as { process?: unknown; supervisor?: unknown }
    await writeFile(join(root, 'restart-cancel-state.json'), `${JSON.stringify({ taskId: task.id, attemptId: attempt.attemptId, generation: attempt.generation, runtimeId: attempt.runtimeId, process: supervisor.process, supervisor: supervisor.supervisor })}\n`, { mode: 0o600 })
    process.send?.({ ready: true })
    await new Promise(() => {})
  } finally { await opened?.coordinator.close().catch(() => undefined); await opened?.context.fiber.dispose().catch(() => undefined) }
} else {
  let opened: Awaited<ReturnType<typeof open>> | undefined
  let child: ReturnType<typeof fork> | undefined
  try {
    await mkdir(repo, { recursive: true }); await execa('git', ['init', '--initial-branch=main'], { cwd: repo }); await writeFile(join(repo, 'README.md'), '# disposable restart cancellation\n')
    await execa('git', ['add', 'README.md'], { cwd: repo }); await execa('git', ['-c', 'user.name=GasTeam', '-c', 'user.email=gasteam@example.invalid', 'commit', '-m', 'initial'], { cwd: repo })
    child = fork(new URL(import.meta.url).pathname, ['launch', root], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    await waitForMessage(child)
    const before = JSON.parse(await readFile(join(root, 'restart-cancel-state.json'), 'utf8')) as { taskId: string; attemptId: string; generation: number; runtimeId: string; process: unknown; supervisor: unknown }
    const markerDirectory = await worktreeMarker(before.attemptId)
    const markerCommit = (await execa('git', ['log', '--format=%H', '--max-count=2', '--', 'REAL_CODEX_RESTART_MARKER.txt'], { cwd: markerDirectory })).stdout.split('\n').filter(Boolean)
    if (markerCommit.length !== 1) throw new Error('external marker lacks exactly one ordinary tracked commit')
    const childExit = new Promise<void>(resolve => child!.once('exit', () => resolve()))
    child.kill('SIGKILL'); await childExit; child = undefined
    opened = await open(); await opened.coordinator.reconcile()
    const restored = opened.coordinator.view().attempts.find(value => value.attemptId === before.attemptId && value.generation === before.generation)
    if (!restored || restored.runtimeId !== before.runtimeId) throw new Error('fresh coordinator did not recover the same external attempt identity')
    const runtimeDirectory = join(root, 'external-runtime', before.attemptId)
    const identity = JSON.parse(await readFile(join(runtimeDirectory, 'supervisor.json'), 'utf8')) as { process?: unknown; supervisor?: unknown }
    if (JSON.stringify(identity.process) !== JSON.stringify(before.process) || JSON.stringify(identity.supervisor) !== JSON.stringify(before.supervisor)) throw new Error('fresh coordinator observed swapped supervisor identity')
    const task = opened.context.agentTeams.getTask(opened.lead, before.taskId)
    await opened.coordinator.controlScheduling(opened.lead, { action: 'cancel', projectId: 'real-codex-restart-cancel', taskId: before.taskId, expectedRevision: task.revision, reason: 'restart cancellation conformance' })
    await waitFor(async () => { await opened!.coordinator.reconcile(); return opened!.coordinator.view().attempts.some(value => value.attemptId === before.attemptId && value.phase === 'terminal') })
    const terminalAttempt = opened.coordinator.view().attempts.find(value => value.attemptId === before.attemptId)
    if (!terminalAttempt || terminalAttempt.phase !== 'terminal' || terminalAttempt.result !== undefined) throw new Error('cancelled external assignment did not stop without a result')
    const [journal, proofRaw, supervisorRaw, stdout, stderr] = await Promise.all([readFile(join(coordinatorDirectory, 'external-runtime.jsonl'), 'utf8'), readFile(join(runtimeDirectory, 'terminal-proof.json'), 'utf8'), readFile(join(runtimeDirectory, 'supervisor.json'), 'utf8'), stat(join(runtimeDirectory, 'stdout.log')), stat(join(runtimeDirectory, 'stderr.log'))])
    const proof = JSON.parse(proofRaw) as { attemptId?: string; generation?: number; process?: unknown; supervisor?: unknown; containment?: { kind?: string }; spool?: unknown }
    const supervisorProof = JSON.parse(supervisorRaw) as { containment?: { kind?: string } }
    const intentCount = (journal.match(/"type":"external\/intent"/g) ?? []).length
    const cancellationCount = (journal.match(/"type":"external\/cancel"/g) ?? []).length
    if (intentCount !== 1 || cancellationCount !== 1 || proof.attemptId !== before.attemptId || proof.generation !== before.generation || JSON.stringify(proof.process) !== JSON.stringify(before.process) || JSON.stringify(proof.supervisor) !== JSON.stringify(before.supervisor) || supervisorProof.containment?.kind !== 'pid-namespace' || proof.spool === undefined || stdout.size + stderr.size > 65_536 + 1_024) throw new Error('terminal proof, containment, journal count, or spool bound does not prove the recovered cancellation')
    const evidence = { outcome: 'passed', root, ...before, markerCommit: markerCommit[0], clientKilled: true, sameHelperIdentityAfterRestart: true, externalLaunchIntentCount: intentCount, externalCancellationCount: cancellationCount, terminalProof: proof, spoolBytes: { stdout: stdout.size, stderr: stderr.size }, providerUsage: 'unknown-after-cancel', cost: 'unknown', fixtureSource: 'reconstructed-unvalidated-against-paid-provider' }
    await writeFile(join(root, 'restart-cancel-evidence.json'), `${JSON.stringify(evidence)}\n`, { mode: 0o600 }); process.stdout.write(`${JSON.stringify(evidence)}\n`)
  } finally { if (child?.exitCode === null) { const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await exited } await opened?.coordinator.close().catch(() => undefined); await opened?.context.fiber.dispose().catch(() => undefined) }
}
