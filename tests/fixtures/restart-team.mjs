/** Real JSONL/process boundary; IPC barriers acknowledge writes before crash injection. */
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execa } from 'execa'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '../../packages/agent-team/lib/index.js'
import { acquireIntegrationOwnership } from '../../packages/agent-team/lib/types/integration-ownership.js'
import { AssignmentStore } from '../../packages/agent-team/lib/types/assignments.js'
import { DshAssignmentRuntime } from '../../packages/agent-team/lib/types/dsh-assignment-runtime.js'
import { progressAdapter } from './progress-llm.mjs'
import * as CoordinatorPlugin from '../../packages/agent-team/lib/coordinator.js'
import * as GitIntegration from '../../packages/agent-team/lib/git-integration.js'
import * as GitWorktrees from '../../packages/agent-team/lib/git-worktrees.js'

class FixtureSessionQuery extends SessionQueryEngine {
  searchSessions() { throw new Error('Search is outside the restart fixture') }
  searchEvents() { throw new Error('Search is outside the restart fixture') }
}

const [mode, directory] = process.argv.slice(2)
if (!directory || !['seed', 'seed-repair', 'seed-report', 'seed-workflow-crash', 'seed-code-workflow', 'seed-code-workflow-repair', 'restore-code-review', 'restore-code-reject', 'restore-code-repair-review', 'restore-repair-crash', 'restore-repair', 'seed-dag', 'seed-paused', 'restore', 'restore-execution', 'restore-workflow', 'restore-worker-crash', 'restore-worker-recovery', 'restore-acceptance-crash', 'restore-promotion-crash', 'restore-ambiguous-promotion', 'restore-stale-target', 'restore-acceptance', 'restore-dag', 'restore-report-intent-crash', 'restore-report-receipt-crash', 'restore-report', 'worker', 'worker-restore', 'contender', 'integration-owner'].includes(mode)) throw new Error('Expected fixture mode and isolated directory')
const repairMode = mode.includes('repair')
const reportMode = mode.includes('report')
const workflowMode = mode.includes('workflow')
const codeWorkflowMode = mode === 'seed-code-workflow' || mode === 'seed-code-workflow-repair' || mode === 'restore-code-review' || mode === 'restore-code-reject' || mode === 'restore-code-repair-review'
const verification = [{ command: process.execPath, args: repairMode ? ['-e', "if(!require('node:fs').existsSync('repaired.txt'))process.exit(1)"] : ['--version'] }]
const acceptanceMode = mode === 'restore-repair-crash' || mode === 'restore-repair' || mode === 'restore-stale-target' || mode === 'restore-worker-recovery' || mode === 'restore-ambiguous-promotion' || mode === 'restore-promotion-crash' || mode === 'restore-acceptance-crash' || mode === 'restore-acceptance' || mode === 'restore-dag'
const ctx = new Context()
let assignments
let coordinator
let integrationRelease
const rootId = SessionId('restart-ready-team')
const send = (message) => new Promise((resolve, reject) => {
  process.send(message, error => error ? reject(error) : resolve())
})
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'jsonl'), compression: 'none' })
  await ctx.plugin(FixtureSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService, acceptanceMode || codeWorkflowMode ? { worktreeProvider: 'git', integrationProvider: 'git' } : (mode === 'restore-execution' || mode === 'restore-worker-crash' || reportMode || workflowMode) ? { worktreeProvider: 'git' } : {})
  if (mode === 'restore-execution' || mode === 'restore-worker-crash' || acceptanceMode || reportMode || workflowMode || codeWorkflowMode) await ctx.plugin(GitWorktrees, { directory: join(directory, 'workers') })
  if (mode === 'integration-owner') {
    let error
    try { integrationRelease = await acquireIntegrationOwnership(join(directory, 'repository'), 'main', new AbortController().signal) }
    catch (cause) { error = cause.message }
    await send({ barrier: 'integration-ownership', acquired: integrationRelease !== undefined, error })
  } else if (mode === 'contender') {
    let error
    try { assignments = await AssignmentStore.open(directory, { globalCapacity: 2, projectCapacities: { fixture: 2 } }) }
    catch (cause) { error = cause.message }
    await send({ barrier: 'ownership', error })
  } else if (mode === 'worker' || mode === 'worker-restore') {
    assignments = await AssignmentStore.open(directory, { globalCapacity: 2, projectCapacities: { fixture: 2 } })
    const token = record => ({ attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })
    if (mode === 'worker') {
      const lead = ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const task = await ctx.agentTeams.createTask(lead, { subject: 'Worker barrier', description: 'Crash while an admitted worker is progressing' })
      const record = await assignments.reserve({
        projectId: 'fixture', teamId: rootId, taskId: task.id, workerId: 'stable-worker', runtimeId: 'attempt-session', provider: 'spawn', expectedGeneration: 0,
        checkpoint: { task: { subject: task.subject, description: task.description }, step: 'implement', artifacts: [], nextAction: 'Continue the implementation' },
      })
      const progress = progressAdapter()
      ctx.llm.registerAdapter(['mock'], progress.adapter)
      const runtime = new DshAssignmentRuntime(ctx, assignments)
      const active = await runtime.start(lead, token(record))
      await progress.entered
      const child = ctx.agents.get(SessionId(record.runtimeId))
      if (!child) throw new Error('Worker disappeared before progress barrier')
      await ctx.sessions.flush(child.session)
      await send({ barrier: 'worker-progress', record: active, pid: process.pid })
    } else {
      const records = assignments.list()
      const child = await ctx.sessionPersistence.inspect(SessionId(records[0].runtimeId))
      await send({ barrier: 'worker-restored', records, liveAgents: ctx.agents.list().length,
        durablePrompts: child.events.filter(event => event.type === 'user/message'
          && event.data.content.some(block => block.type === 'text'
            && block.text.includes(JSON.stringify(records[0].checkpoint))
            && block.text.includes(`"assignmentId":"${records[0].assignmentId}"`))).length,
        pid: process.pid })
    }
  } else if (mode === 'seed-repair' || mode === 'seed-report' || mode === 'seed-workflow-crash' || mode === 'seed-code-workflow' || mode === 'seed-code-workflow-repair' || mode === 'seed' || mode === 'seed-paused' || mode === 'seed-dag') {
    const lead = ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' }, { cwd: join(directory, 'repository') })
    const repository = join(directory, 'repository')
    await mkdir(repository)
    const git = (...args) => execa('git', args, { cwd: repository })
    await git('init', '--initial-branch=main')
    await git('config', 'user.name', 'Coordinator fixture')
    await git('config', 'user.email', 'coordinator@example.invalid')
    await git('config', 'commit.gpgsign', 'false')
    await writeFile(join(repository, 'initial.txt'), 'fixture\n')
    await git('add', 'initial.txt')
    await git('commit', '-m', 'fixture')
    if (codeWorkflowMode) {
      await ctx.plugin(GitIntegration, { providerName: 'git', targetBranch: 'main', verification, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
      const { adapter } = progressAdapter()
      adapter.stream = async function* (options) {
        const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
        const member = ctx.agentTeams.listMembers(lead).find(value => value.role === 'teammate' && text.includes(`"attemptId":"${value.name}"`))
        if (member) { await writeFile(join(member.worktree.cwd, 'workflow-code.txt'), 'workflow code\n'); await execa('git', ['add', '--all'], { cwd: member.worktree.cwd }); await execa('git', ['commit', '-m', 'workflow code'], { cwd: member.worktree.cwd }) }
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Committed workflow code' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Committed workflow code' } }; yield { type: 'finish', reason: { kind: 'stop' } }
      }
      ctx.llm.registerAdapter(['mock'], adapter)
    }
    await ctx.plugin(CoordinatorPlugin, { directory: join(directory, 'workspace'), scanIntervalMs: 25,
      ...(workflowMode ? { execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 1 } } : {}) })
    coordinator = ctx.workspaceCoordinator
    await coordinator.register(lead, {
      id: 'fixture', repository, targetBranch: 'main', teamIds: [rootId], capacity: 2,
      verification: { revision: 1, commands: verification },
    })
    if (mode === 'seed-workflow-crash') {
      ctx.llm.registerAdapter(['mock'], progressAdapter().adapter)
      const createPinned = ctx.agentTeams.createPinnedTask.bind(ctx.agentTeams)
      ctx.agentTeams.createPinnedTask = async (...args) => {
        const task = await createPinned(...args)
        await send({ barrier: 'workflow-task-side-effect', task, workflows: coordinator.view().workflows, attempts: coordinator.view().attempts })
        await new Promise(() => {})
      }
      await coordinator.createWorkflow(lead, { projectId: 'fixture', teamId: rootId, templateId: 'investigation-report', templateVersion: 1,
        parameters: { question: 'Why did restart preserve this workflow?' }, executionId: 'workflow-process-crash' })
      throw new Error('Workflow crash fixture unexpectedly returned')
    }
    if (mode === 'seed-code-workflow' || mode === 'seed-code-workflow-repair') {
      if (mode === 'seed-code-workflow-repair') {
        const reserve = ctx.agentTeams.spawnReservedTeammate.bind(ctx.agentTeams)
        ctx.agentTeams.spawnReservedTeammate = async (...args) => {
          const prompt = args[1].prompt.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
          if (prompt.includes('"step":"repair"')) { await send({ barrier: 'code-verification-failed', workflows: coordinator.view().workflows, tasks: ctx.agentTeams.listTasks(lead), submissions: coordinator.view().submissions, integrations: ctx.agentTeams.listIntegrations(lead), head: (await execa('git', ['rev-parse', 'main'], { cwd: repository })).stdout }); await new Promise(() => {}) }
          return await reserve(...args)
        }
      }
      const run = ctx.agentTeams.runIntegration.bind(ctx.agentTeams)
      ctx.agentTeams.runIntegration = async (...args) => {
        const job = await run(...args)
        if (job?.phase === 'verified') { await send({ barrier: 'code-verified', job, workflows: coordinator.view().workflows, tasks: ctx.agentTeams.listTasks(lead), submissions: coordinator.view().submissions, head: (await execa('git', ['rev-parse', 'main'], { cwd: repository })).stdout }); await new Promise(() => {}) }
        return job
      }
      await coordinator.createWorkflow(lead, { projectId: 'fixture', teamId: rootId, templateId: 'implementation-test-review-integration', templateVersion: 1, parameters: { subject: 'restart code workflow' }, executionId: 'code-workflow-process' })
      await new Promise(() => {})
    }
    const task = await coordinator.acceptTask(lead, 'fixture', mode === 'seed-report'
      ? { subject: 'Durable report', description: 'Record an evidence-backed finding.', nonCodeCriteria: 'State the observed evidence.' }
      : { subject: 'Resume without a browser', description: 'Accepted ready work must be found on startup.' })
    if (mode === 'seed-dag') {
      const left = await coordinator.acceptTask(lead, 'fixture', { subject: 'Left', description: 'Left branch artifact', blockedBy: [task.id] })
      const right = await coordinator.acceptTask(lead, 'fixture', { subject: 'Right', description: 'Right branch artifact', blockedBy: [task.id] })
      await coordinator.acceptTask(lead, 'fixture', { subject: 'Join', description: 'Join artifact', blockedBy: [left.id, right.id] })
    }
    if (mode === 'seed-paused') await coordinator.pause(lead, 'fixture', 0, true)
    await ctx.sessions.flush(lead.session)
    await send({ barrier: 'persisted', rootId, taskId: task.id, pid: process.pid, coordinatorId: coordinator.view().id })
  } else if (mode === 'restore-workflow') {
    ctx.llm.registerAdapter(['mock'], progressAdapter().adapter)
    await ctx.plugin(CoordinatorPlugin, { directory: join(directory, 'workspace'), scanIntervalMs: 25,
      execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 1 } })
    coordinator = ctx.workspaceCoordinator
    await new Promise(resolve => {
      const timer = setInterval(() => {
        const workflow = coordinator.view().workflows.find(value => value.executionId === 'workflow-process-crash')
        if (!workflow?.steps[0]?.taskId || !coordinator.view().attempts.some(attempt => attempt.taskId === workflow.steps[0].taskId)) return
        clearInterval(timer); resolve()
      }, 20)
    })
    await send({ barrier: 'workflow-replayed', workflows: coordinator.view().workflows, tasks: ctx.agentTeams.listTasks(ctx.agents.get(rootId)), attempts: coordinator.view().attempts })
  } else if (reportMode) {
    const { adapter } = progressAdapter()
    adapter.stream = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Observed evidence from the isolated worker.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Observed evidence from the isolated worker.' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(CoordinatorPlugin, { directory: join(directory, 'workspace'), scanIntervalMs: 25,
      execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 1 } })
    coordinator = ctx.workspaceCoordinator
    const lead = ctx.agents.get(rootId)
    if (!lead) throw new Error('Coordinator did not restore the registered Lead')
    if (mode === 'restore-report') {
      await new Promise(resolve => {
        const timer = setInterval(() => {
          if (coordinator.view().reports[0]?.phase === 'accepted') { clearInterval(timer); resolve() }
        }, 20)
      })
      await send({ barrier: 'report-replayed', reports: coordinator.view().reports, tasks: ctx.agentTeams.listTasks(lead), attempts: coordinator.view().attempts })
    } else {
      await new Promise(resolve => {
        const timer = setInterval(() => {
          const attempt = coordinator.view().attempts[0]
          if (!attempt || attempt.phase !== 'terminal' || !attempt.result) return
          clearInterval(timer)
          const request = { attemptId: attempt.attemptId, generation: attempt.generation, expectedRevision: attempt.revision,
            expectedTaskRevision: ctx.agentTeams.getTask(lead, attempt.taskId).revision, rationale: 'The report states the observed evidence.' }
          const accept = ctx.agentTeams.acceptReportedTask.bind(ctx.agentTeams)
          ctx.agentTeams.acceptReportedTask = async (...args) => {
            if (mode === 'restore-report-intent-crash') {
              await send({ barrier: 'report-intent', reports: coordinator.view().reports, tasks: ctx.agentTeams.listTasks(lead), attempts: coordinator.view().attempts })
              await new Promise(() => {})
            }
            const task = await accept(...args)
            await send({ barrier: 'report-receipt', reports: coordinator.view().reports, tasks: [task], attempts: coordinator.view().attempts })
            await new Promise(() => {})
          }
          void coordinator.acceptReport(lead, 'fixture', request)
        }, 20)
      })
      await new Promise(() => {})
    }
  } else if (mode === 'restore-code-review' || mode === 'restore-code-reject' || mode === 'restore-code-repair-review') {
    const repository = join(directory, 'repository')
    await ctx.plugin(GitIntegration, { providerName: 'git', targetBranch: 'main', verification, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
    const { adapter } = progressAdapter()
    adapter.stream = async function* (options) { const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'); const lead = ctx.agents.get(rootId); const member = lead && ctx.agentTeams.listMembers(lead).find(value => value.role === 'teammate' && text.includes(`"attemptId":"${value.name}"`)); if (member && mode === 'restore-code-repair-review' && text.includes('"step":"repair"')) { const source = text.match(/"sourceCommit":"([a-f0-9]+)"/)?.[1]; if (!source) throw new Error('Repair prompt has no pinned source'); await execa('git', ['merge', '--no-edit', source], { cwd: member.worktree.cwd }); await writeFile(join(member.worktree.cwd, 'repaired.txt'), 'repaired\n'); await execa('git', ['add', '--all'], { cwd: member.worktree.cwd }); await execa('git', ['commit', '-m', 'workflow repair'], { cwd: member.worktree.cwd }) } yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Reviewed exact candidate.' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Reviewed exact candidate.' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(CoordinatorPlugin, { directory: join(directory, 'workspace'), scanIntervalMs: 25, execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 1 } })
    coordinator = ctx.workspaceCoordinator
    let accepting = false
    const timer = setInterval(async () => {
      const lead = ctx.agents.get(rootId)
      const workflow = coordinator.view().workflows.find(value => value.executionId === 'code-workflow-process')
      const reviewTaskId = workflow?.steps.find(step => step.stepId === 'review')?.taskId
      const attempt = coordinator.view().attempts.find(value => value.taskId === reviewTaskId && value.phase === 'terminal' && value.result)
      if (accepting || !lead || !attempt || coordinator.view().reports.some(report => report.attemptId === attempt.attemptId)) return
      const task = ctx.agentTeams.getTask(lead, attempt.taskId)
      if (task.nonCodeCriteria === undefined) return
      accepting = true
      try { await coordinator.acceptReport(lead, 'fixture', { attemptId: attempt.attemptId, generation: attempt.generation, expectedRevision: attempt.revision, expectedTaskRevision: task.revision, rationale: mode === 'restore-code-reject' ? 'Exact pinned candidate rejected.' : 'Exact pinned candidate reviewed.', decision: mode === 'restore-code-reject' ? 'rejected' : 'approved' }) }
      finally { accepting = false }
    }, 20)
    await new Promise(resolve => {
      const done = setInterval(async () => {
        const lead = ctx.agents.get(rootId)
        const workflow = coordinator.view().workflows.find(value => value.executionId === 'code-workflow-process')
        const review = workflow?.steps.find(step => step.stepId === 'review')
        if (!lead || !workflow || (mode === 'restore-code-reject' ? review?.phase !== 'failed' : !workflow.steps.every(step => step.phase === 'completed'))) return
        clearInterval(done); clearInterval(timer)
        send({ barrier: mode === 'restore-code-reject' ? 'code-rejected' : 'code-completed', workflows: coordinator.view().workflows, workflowJournal: await readFile(join(directory, 'workspace', 'workflows.jsonl'), 'utf8'), tasks: ctx.agentTeams.listTasks(lead), reports: coordinator.view().reports, submissions: coordinator.view().submissions, integrations: ctx.agentTeams.listIntegrations(lead), head: (await execa('git', ['rev-parse', 'main'], { cwd: repository })).stdout })
        resolve()
      }, 20)
    })
  } else if (acceptanceMode) {
    const repository = join(directory, 'repository')
    const git = (...args) => execa('git', args, { cwd: repository })
    if (mode === 'restore-repair-crash') {
      const spawn = ctx.agentTeams.spawnReservedTeammate.bind(ctx.agentTeams)
      ctx.agentTeams.spawnReservedTeammate = async (...args) => {
        if (args[1].prompt.some(block => block.type === 'text' && block.text.includes('"step":"repair"'))) {
          await send({ barrier: 'repair-reserved', attempts: ctx.workspaceCoordinator.view().attempts,
            submissions: ctx.workspaceCoordinator.view().submissions, integrations: ctx.agentTeams.listIntegrations(args[0]) })
          await new Promise(() => {})
        }
        return await spawn(...args)
      }
    }
    if (mode === 'restore-stale-target') {
      const register = ctx.agentTeams.registerIntegrationProvider.bind(ctx.agentTeams)
      ctx.agentTeams.registerIntegrationProvider = provider => {
        const verify = provider.verify.bind(provider)
        provider.verify = async (...args) => {
          const candidate = await verify(...args)
          await writeFile(join(repository, 'external.txt'), 'external target movement')
          await git('add', 'external.txt')
          await git('commit', '-m', 'external target movement')
          await writeFile(join(args[0].cwd, 'retained.txt'), 'retained candidate evidence')
          return candidate
        }
        return register(provider)
      }
      const run = ctx.agentTeams.runIntegration.bind(ctx.agentTeams)
      ctx.agentTeams.runIntegration = async (...args) => {
        const job = await run(...args)
        if (job?.phase !== 'queued' || job.previousCandidates?.length !== 1) throw new Error('Expected durable stale-target retry')
        await send({ barrier: 'stale-target', job, workerRequests })
        await new Promise(() => {})
      }
    }
    if (mode === 'restore-ambiguous-promotion') {
      const register = ctx.agentTeams.registerIntegrationProvider.bind(ctx.agentTeams)
      ctx.agentTeams.registerIntegrationProvider = provider => {
        const promote = provider.promote.bind(provider)
        provider.promote = async (...args) => {
          await promote(...args)
          const lead = ctx.agents.get(rootId)
          await send({ barrier: 'ambiguous-promotion', task: ctx.agentTeams.listTasks(lead)[0], submissions: ctx.workspaceCoordinator.view().submissions,
            integrations: ctx.agentTeams.listIntegrations(lead), head: (await git('rev-parse', 'main')).stdout, workerRequests })
          await new Promise(() => {})
        }
        return register(provider)
      }
    }
    await ctx.plugin(GitIntegration, { providerName: 'git', targetBranch: 'main', verification, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
    const { adapter } = progressAdapter()
    let workerRequests = 0
    adapter.stream = async function* (options) {
      const lead = ctx.agents.get(rootId)
      const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      const member = ctx.agentTeams.listMembers(lead).find(member => member.role === 'teammate' && text.includes(`"attemptId":"${member.name}"`))
      if (member) {
        workerRequests++
        const cwd = member.worktree.cwd
        if (repairMode && text.includes('"step":"repair"')) {
          const commit = text.match(/"sourceCommit":"([a-f0-9]+)"/)?.[1]
          if (!commit) throw new Error('Repair prompt has no pinned source')
          await execa('git', ['merge', '--no-edit', commit], { cwd })
          await writeFile(join(cwd, 'repaired.txt'), 'verified repair')
        }
        await writeFile(join(cwd, `${member.name}.txt`), 'durable artifact\n')
        await execa('git', ['add', '--all'], { cwd })
        await execa('git', ['commit', '-m', 'acceptance artifact'], { cwd })
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Committed artifact for verification' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Committed artifact for verification' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    ctx.llm.registerAdapter(['mock'], adapter)
    if (mode === 'restore-acceptance-crash') {
      const accept = ctx.agentTeams.acceptIntegratedTask.bind(ctx.agentTeams)
      ctx.agentTeams.acceptIntegratedTask = async (...args) => {
        const task = await accept(...args)
        await send({ barrier: 'task-receipt', task, submissions: ctx.workspaceCoordinator.view().submissions,
          integrations: ctx.agentTeams.listIntegrations(args[0]), head: (await git('rev-parse', 'main')).stdout, workerRequests })
        await new Promise(() => {})
      }
    }
    if (mode === 'restore-promotion-crash') {
      const run = ctx.agentTeams.runIntegration.bind(ctx.agentTeams)
      ctx.agentTeams.runIntegration = async (...args) => {
        const job = await run(...args)
        if (job?.phase !== 'merged') throw new Error('Expected a durable merged job at promotion barrier')
        await send({ barrier: 'promotion', task: ctx.agentTeams.listTasks(args[0])[0], submissions: ctx.workspaceCoordinator.view().submissions,
          integrations: ctx.agentTeams.listIntegrations(args[0]), head: (await git('rev-parse', 'main')).stdout, workerRequests })
        await new Promise(() => {})
      }
    }
    await ctx.plugin(CoordinatorPlugin, { directory: join(directory, 'workspace'), scanIntervalMs: 50,
      execution: { modelProvider: 'mock', model: 'mock', maxConcurrent: 2, ...(repairMode ? { maxRepairAttempts: mode === 'restore-repair-crash' ? 1 : 10 } : {}) } })
    coordinator = ctx.workspaceCoordinator
    if (mode === 'restore-repair-crash' || mode === 'restore-stale-target' || mode === 'restore-acceptance-crash' || mode === 'restore-promotion-crash' || mode === 'restore-ambiguous-promotion') await new Promise(() => {})
    if (mode === 'restore-repair') await new Promise(resolve => {
      const timer = setInterval(() => {
        const lead = ctx.agents.get(rootId)
        const submissions = coordinator.view().submissions
        if (lead && ctx.agentTeams.listTasks(lead).every(task => task.status === 'completed'
          && submissions.some(submission => submission.taskId === task.id && submission.phase === 'accepted'))) { clearInterval(timer); resolve() }
      }, 25)
    })
    if (mode === 'restore-dag' || mode === 'restore-worker-recovery') await new Promise(resolve => {
      const timer = setInterval(() => {
        const lead = ctx.agents.get(rootId)
        const submissions = coordinator.view().submissions
        if (lead && ctx.agentTeams.listTasks(lead).every(task => task.status === 'completed')
          && submissions.length === ctx.agentTeams.listTasks(lead).length && submissions.every(submission => submission.phase === 'accepted')) { clearInterval(timer); resolve() }
      }, 25)
    })
    await send({ barrier: 'accepted-replay', submissions: coordinator.view().submissions, attempts: coordinator.view().attempts,
      tasks: ctx.agentTeams.listTasks(ctx.agents.get(rootId)), integrations: ctx.agentTeams.listIntegrations(ctx.agents.get(rootId)),
      head: (await git('rev-parse', 'main')).stdout, workerRequests, initial: (await git('show', 'main:initial.txt')).stdout })
  } else {
    // Read-only inspection proves the input survived without materializing a Lead.
    const stored = await ctx.sessionPersistence.inspect(rootId)
    const persistedTasks = stored.events.filter(event => event.type === 'team/task').map(event => event.data.task)
    const execution = (mode === 'restore-execution' || mode === 'restore-worker-crash') ? { modelProvider: 'mock', model: 'mock', maxConcurrent: 2 } : undefined
    const progress = execution === undefined ? undefined : progressAdapter()
    if (progress) ctx.llm.registerAdapter(['mock'], progress.adapter)
    await ctx.plugin(CoordinatorPlugin, { directory: join(directory, 'workspace'), scanIntervalMs: 60_000,
      ...execution === undefined ? {} : { execution } })
    coordinator = ctx.workspaceCoordinator
    if (progress) await progress.entered
    const discoveredTasks = coordinator.view().readyTasks.map(({ teamId, taskId }) => ({ teamId, taskId }))
    await send({ barrier: 'startup', persistedTasks, discoveredTasks, pid: process.pid,
      liveAgents: ctx.agents.list().length, coordinatorId: coordinator.view().id,
      projectControls: coordinator.view().projects.map(project => ({ paused: project.paused, revision: project.controlRevision })) })
    if (mode === 'restore-worker-crash') {
      const child = ctx.agents.get(SessionId(coordinator.view().attempts[0].runtimeId))
      await writeFile(join(child.session.header.cwd, 'initial.txt'), 'preserved interrupted edit\n')
      await ctx.sessions.flush(child.session)
    }
    if (execution !== undefined) await send({ barrier: 'automatic-worker', attempts: coordinator.view().attempts,
      workerCwd: ctx.agents.get(SessionId(coordinator.view().attempts[0].runtimeId))?.session.header.cwd,
      repository: join(directory, 'repository') })
  }
  await new Promise(resolve => process.once('message', message => {
    if (message !== 'stop') throw new Error('Expected stop')
    resolve()
  }))
} finally {
  try { await coordinator?.close(); await ctx.fiber.dispose() }
  finally { await assignments?.close(); await integrationRelease?.(); process.disconnect?.() }
}
