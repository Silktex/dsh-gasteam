/**
 * Disposable real-service fixture for the shipped workspace dashboard.
 *
 * This is a Cordis host plugin, loaded by scripts/dashboard-demo.mjs after the
 * normal Web and Agent Teams profile layers. It uses the production Team,
 * coordinator, persistence, Remote, and browser plugins. Only the model is a
 * deterministic local adapter, so opening the demo cannot spend provider
 * credits.
 */
import { mkdir } from 'node:fs/promises'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceCoordinator } from '../../packages/agent-team/lib/coordinator.js'

const DEFAULT_LEAD_ID = 'workspace-dashboard-demo-lead'
const DEFAULT_OBSERVER_ID = 'workspace-dashboard-demo-observer'
const DEFAULT_PROJECT_ID = 'workspace-dashboard-demo'
const DEFAULT_ATTEMPTS = 130

class DashboardDemoAdapter extends LlmAdapter {
  async * stream(options) {
    options.signal?.throwIfAborted()
    const text = 'Controlled dashboard demo model: no external provider call was made.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'workspace-dashboard-demo'
export const inject = [
  'agentLoop', 'agents', 'agentTeams', 'llm', 'sessions',
  'sessionPersistence', 'subagents', 'workspaceRegistry',
]

function token(attempt) {
  return {
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    expectedRevision: attempt.revision,
  }
}

async function restoreOrCreateAgent(ctx, sessionId, repository) {
  const id = SessionId(sessionId)
  const resident = ctx.agents.get(id)
  if (resident !== undefined) return resident
  const restored = await ctx.agents.resume({
    resumeSessionId: id,
    agentOptions: { provider: 'dashboard-demo', model: 'controlled' },
  }).then(result => result.agent, () => undefined)
  return restored ?? ctx.agentLoop.create(
    id,
    { provider: 'dashboard-demo', model: 'controlled' },
    { cwd: repository },
  )
}

async function ensureControlledTurn(ctx, agent) {
  if (agent.session.snapshotEvents().some(event => event.type === 'assistant/message')) return
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Reply once using only the local controlled demo model.' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await ctx.sessions.flush(agent.session)
}

async function seedAttempts(coordinator, task, config) {
  // CoordinatorExecution owns this production durable store. The fixture uses
  // its normal mutation API so replay validates every revision and lifecycle
  // edge; it never replaces coordinator.view() or a Remote response.
  const assignments = coordinator.execution.assignments
  assignments.configure({
    globalCapacity: 1,
    projectCapacities: { [config.projectId]: 1 },
  })
  const existing = assignments.list().filter(attempt =>
    attempt.projectId === config.projectId
      && attempt.teamId === config.leadSessionId
      && attempt.taskId === task.id)
  if (existing.some(attempt => attempt.phase !== 'terminal')) {
    throw new Error('Dashboard demo found an incomplete seeded attempt')
  }
  const externalPolicy = {
    projectId: config.projectId,
    directory: config.runtimeDirectory,
    admission: {
      executable: process.execPath,
      configuredExecutable: process.execPath,
      version: process.versions.node,
      executableVerification: 'verified',
      cwd: config.repository,
      model: 'controlled-dashboard-demo',
      sandbox: 'read-only',
      authStatus: 'authenticated',
    },
    maxSpoolBytes: 65_536,
    terminateGraceMs: 50,
  }
  for (let index = existing.length; index < config.attemptCount; index++) {
    let attempt = await assignments.reserve({
      projectId: config.projectId,
      teamId: config.leadSessionId,
      taskId: task.id,
      workerId: `dashboard-worker-${index + 1}`,
      runtimeId: `dashboard-runtime-${index + 1}`,
      provider: 'external',
      expectedGeneration: index,
      checkpoint: {
        task: {
          subject: task.subject,
          description: task.description,
          nonCodeCriteria: task.nonCodeCriteria,
        },
        step: 'controlled demo completion',
        artifacts: [],
        nextAction: 'Review the provider-reported usage in the dashboard.',
      },
      externalPolicy,
    })
    attempt = await assignments.activate(token(attempt))
    // One attempt stays unknown, one reports exact zero, and the remaining
    // attempts report positive immutable counts. The sequence repeats so both
    // overview and history pages contain all three states.
    if (index % 3 === 1) {
      attempt = await assignments.externalUsage(token(attempt), {
        provider: 'external', attemptId: attempt.attemptId,
        generation: attempt.generation, runtimeRevision: 1,
        inputTokens: 0, outputTokens: 0,
      })
    } else if (index % 3 === 2) {
      attempt = await assignments.externalUsage(token(attempt), {
        provider: 'external', attemptId: attempt.attemptId,
        generation: attempt.generation, runtimeRevision: 1,
        inputTokens: 101 + index, cachedInputTokens: 23,
        outputTokens: 37, reasoningOutputTokens: 11,
      })
    }
    attempt = await assignments.report(token(attempt), `Controlled provider report ${index + 1}`)
    await assignments.retire(token(attempt), {
      runtimeId: attempt.runtimeId,
      kind: 'stopped',
      receipt: `dashboard-demo-stop-${index + 1}`,
    })
  }
}

export async function* apply(ctx, rawConfig) {
  const config = {
    leadSessionId: rawConfig.leadSessionId ?? DEFAULT_LEAD_ID,
    observerSessionId: rawConfig.observerSessionId ?? DEFAULT_OBSERVER_ID,
    projectId: rawConfig.projectId ?? DEFAULT_PROJECT_ID,
    attemptCount: rawConfig.attemptCount ?? DEFAULT_ATTEMPTS,
    repository: rawConfig.repository,
    coordinatorDirectory: rawConfig.coordinatorDirectory,
    runtimeDirectory: rawConfig.runtimeDirectory,
  }
  if (!config.repository || !config.coordinatorDirectory || !config.runtimeDirectory) {
    throw new Error('Dashboard demo requires repository, coordinatorDirectory, and runtimeDirectory')
  }
  if (!Number.isSafeInteger(config.attemptCount) || config.attemptCount < 129 || config.attemptCount > 256) {
    throw new Error('Dashboard demo attemptCount must be an integer from 129 through 256')
  }
  await mkdir(config.coordinatorDirectory, { recursive: true })
  await mkdir(config.runtimeDirectory, { recursive: true })
  ctx.llm.registerAdapter(['dashboard-demo'], new DashboardDemoAdapter())
  const lead = await restoreOrCreateAgent(ctx, config.leadSessionId, config.repository)
  const observer = await restoreOrCreateAgent(ctx, config.observerSessionId, config.repository)
  if (!lead.session.snapshotEvents().some(event => event.type === 'user/message')) {
    lead.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Workspace dashboard controlled-provider demonstration.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await ctx.sessions.flush(lead.session)
  }
  if (!observer.session.snapshotEvents().some(event => event.type === 'user/message')) {
    observer.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Unauthorized dashboard observer demonstration.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await ctx.sessions.flush(observer.session)
  }
  await ensureControlledTurn(ctx, lead)
  await ensureControlledTurn(ctx, observer)
  const workspace = await ctx.workspaceRegistry.create(config.repository, 'GasTeam dashboard demo')
  await workspace.attachSession(observer.id)
  await workspace.attachSession(lead.id)
  const coordinator = await WorkspaceCoordinator.open(ctx, {
    directory: config.coordinatorDirectory,
    workspaceOperatorId: lead.id,
  })
  try {
    const registered = coordinator.view().projects.some(project => project.project.id === config.projectId)
    if (!registered) {
      await coordinator.register(lead, {
        id: config.projectId,
        repository: config.repository,
        teamIds: [lead.id],
        targetBranch: 'main',
        capacity: 1,
        verification: {
          revision: 1,
          commands: [{ command: process.execPath, args: ['--version'] }],
        },
      })
    }
    let task = ctx.agentTeams.listTasks(lead).find(candidate =>
      candidate.subject === 'Inspect authoritative provider usage')
    task ??= await coordinator.acceptTask(lead, config.projectId, {
      subject: 'Inspect authoritative provider usage',
      description: 'Show unknown, explicit zero, and nonzero provider usage across bounded history pages.',
      nonCodeCriteria: 'The dashboard preserves provider authority and never estimates cost.',
    })
    await seedAttempts(coordinator, task, config)
    ctx.provide('workspaceCoordinator', coordinator)
    ctx.logger.info(
      `Dashboard demo ready: session=${lead.id}, project=${config.projectId}, attempts=${config.attemptCount}`,
    )
  } catch (error) {
    await coordinator.close()
    throw error
  }
  yield async () => { await coordinator.close() }
}
