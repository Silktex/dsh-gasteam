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

const root = await mkdtemp(join(tmpdir(), 'gasteam-real-codex-'))
const repo = join(root, 'repository')
const evidencePath = join(root, 'conformance-evidence.json')
const sentinel = 'real-codex-conformance-v1\n'
const context = new Context()
let coordinator: WorkspaceCoordinator | undefined
const deadline = Date.now() + 120_000
const waitFor = async (predicate: () => Promise<boolean>) => {
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  throw new Error('Timed out waiting for bounded real Codex coordinator route')
}
const usageFrom = async (stdout: string) => {
  for (const line of (await readFile(stdout, 'utf8')).split('\n').reverse()) {
    try {
      const event = JSON.parse(line) as { type?: unknown, usage?: { input_tokens?: unknown, output_tokens?: unknown } }
      if (event.type !== 'turn.completed') continue
      const inputTokens = event.usage?.input_tokens
      const outputTokens = event.usage?.output_tokens
      return {
        ...(typeof inputTokens === 'number' && Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
        ...(typeof outputTokens === 'number' && Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
      }
    } catch {}
  }
  return undefined
}
try {
  await mkdir(repo)
  await execa('git', ['init', '--initial-branch=main'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), '# disposable Codex conformance\n')
  await execa('git', ['add', 'README.md'], { cwd: repo })
  await execa('git', ['-c', 'user.name=DSH Conformance', '-c', 'user.email=conformance@example.invalid', 'commit', '-m', 'initial'], { cwd: repo })
  await mountAgentLoopTestDependencies(context)
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(JsonlSessionPersistence, { root: join(root, 'jsonl'), compression: 'none' })
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(SubagentService)
  await context.plugin(SubagentSpawn, { providerName: 'spawn' })
  await context.plugin(TeamService, { worktreeProvider: 'git', integrationProvider: 'git' })
  await context.plugin(GitWorktrees, { directory: join(root, 'workers') })
  context.agentTeams.registerIntegrationProvider(new GitIntegrationProvider({ providerName: 'git', targetBranch: 'main', verification: [{ command: 'node', args: ['--version'] }], commandTimeoutMs: 10_000, verificationTimeoutMs: 10_000 }))
  const lead = context.agentLoop.create(SessionId('real-codex-lead'), { provider: 'mock', model: 'mock' }, { cwd: repo })
  const config = { directory: join(root, 'coordinator'), execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 1, dispatchIntervalMs: 50, externalCodex: {
    projectId: 'real-codex-project', directory: join(root, 'external-runtime'), codeWorktreeDirectory: join(root, 'external-code-worktrees'), cwd: repo,
    executable, version, model, sandbox: 'workspace-write' as const,
    maxSpoolBytes: 1_048_576, terminateGraceMs: 10_000, admissionMaxOutputBytes: 16_384, admissionTimeoutMs: 5_000,
  } } }
  coordinator = await WorkspaceCoordinator.open(context, { directory: config.directory })
  await coordinator.register(lead, { id: 'real-codex-project', repository: repo, teamIds: [lead.id], targetBranch: 'main', capacity: 1, verification: { revision: 1, commands: [{ command: 'node', args: ['--version'] }] } })
  await coordinator.close()
  coordinator = await WorkspaceCoordinator.open(context, config)
  const task = await coordinator.acceptTask(lead, 'real-codex-project', {
    subject: 'actual Codex conformance file',
    description: `Create REAL_CODEX_CONFORMANCE.txt at the repository root containing exactly ${JSON.stringify(sentinel)}. Use the existing linked checkout only: run ordinary git add and git commit once with a concise message. Do not initialize another repository, set GIT_DIR or GIT_WORK_TREE, create a separate git directory, alter repository configuration, or make any workaround. If the ordinary commit fails, report that blocker and stop. Do not modify any other file.`,
  })
  await waitFor(async () => {
    await coordinator!.reconcile()
    const view = coordinator!.view()
    const blocked = view.executionBlocks.find(item => item.taskId === task.id)
    if (blocked) throw new Error(`Coordinator blocked actual Codex task: ${blocked.diagnostic}`)
    return view.submissions.some(item => item.taskId === task.id && item.phase === 'accepted')
  })
  const view = coordinator.view()
  const attempt = view.attempts.find(value => value.taskId === task.id)
  const submission = view.submissions.find(value => value.taskId === task.id)
  if (!attempt || !submission || attempt.provider !== 'external' || attempt.phase !== 'terminal' || !attempt.result || attempt.stopReason) throw new Error('Actual Codex route lacks a positive terminal external assignment')
  const integration = context.agentTeams.listIntegrations(lead).find(value => value.id === submission.integrationId)
  if (integration?.phase !== 'merged' || integration.externalOwner?.runtimeId !== attempt.runtimeId) throw new Error('Actual Codex route lacks a merged external integration receipt')
  const content = await readFile(join(repo, 'REAL_CODEX_CONFORMANCE.txt'), 'utf8')
  if (content !== sentinel) throw new Error('Actual Codex committed unexpected conformance file content')
  const externalDirectory = join(root, 'external-runtime', attempt.attemptId)
  const terminalProof = JSON.parse(await readFile(join(externalDirectory, 'terminal-proof.json'), 'utf8')) as { spool?: unknown }
  const supervisorIdentity = JSON.parse(await readFile(join(externalDirectory, 'supervisor.json'), 'utf8')) as { containment?: unknown }
  const [stdout, stderr] = await Promise.all([stat(join(externalDirectory, 'stdout.log')), stat(join(externalDirectory, 'stderr.log'))])
  const usage = await usageFrom(join(externalDirectory, 'stdout.log'))
  const evidence = {
    outcome: 'passed', root, taskId: task.id, attemptId: attempt.attemptId, generation: attempt.generation, runtimeId: attempt.runtimeId,
    assignmentPhase: attempt.phase, submissionPhase: submission.phase, integrationPhase: integration.phase,
    externalOwner: { runtimeId: integration.externalOwner.runtimeId, branch: integration.externalOwner.branch, baseCommit: integration.externalOwner.baseCommit },
    terminalProof: { containment: supervisorIdentity.containment, hasSpoolProof: terminalProof.spool !== undefined },
    spoolBytes: { stdout: stdout.size, stderr: stderr.size }, ...(usage === undefined ? {} : { providerUsage: usage }),
  }
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
} catch (error) {
  const evidence = { outcome: 'failed', root, error: error instanceof Error ? error.message.slice(0, 1024) : String(error).slice(0, 1024) }
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 }).catch(() => undefined)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  process.exitCode = 1
} finally {
  if (coordinator !== undefined) await coordinator.close().catch(() => undefined)
  await context.fiber.dispose().catch(() => undefined)
}
