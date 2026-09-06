/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamBatchId, TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamIntegrationId, TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/** Tool routing configuration. */
export interface Config {
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
}

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
})

/** Model-facing collaboration guidance shared by Lead and teammates. */
function policy(worktree: boolean): string {
  return `Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.

${worktree
  ? 'Teammates run in isolated Git worktrees based on the Lead’s committed HEAD. Uncommitted Lead edits are not copied. Commit completed work on the recorded worker branch; the Lead integrates and verifies it before releasing the worktree. Worktree isolation separates checkouts, not filesystem permissions.'
  : 'The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member.'} Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use send_message for quiet information that must not start an idle teammate. Use followup_task when the target should run another turn. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete with concise result evidence describing the outcome, changed artifacts, and verification. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use followup_task first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`
}

const ACTIVE_WAIT_STATUSES: ReadonlySet<TeamMemberView['status']> = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use followup_task to wake each required inactive teammate before waiting again.'

/**
 * One roster row, matching `TeamMemberView`. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'idle', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
    recoveryAttempts: { type: 'integer' },
    worktree: {
      type: 'object',
      additionalProperties: false,
      properties: {
        memberId: { type: 'string', required: true },
        provider: { type: 'string', required: true },
        repository: { type: 'string', required: true },
        cwd: { type: 'string', required: true },
        branch: { type: 'string', required: true },
        baseCommit: { type: 'string', required: true },
        phase: { type: 'string', required: true, enum: ['reserved', 'ready', 'released'] },
      },
    },
  },
} as const

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    nonCodeCriteria: { type: 'string' },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    result: { type: 'string' },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
} as const

/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

const INTEGRATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, memberId: { type: 'string', required: true },
    provider: { type: 'string', required: true }, phase: { type: 'string', required: true, enum: ['queued', 'running', 'verified', 'merged', 'failed'] },
    repository: { type: 'string', required: true }, cwd: { type: 'string', required: true },
    sourceBranch: { type: 'string', required: true }, sourceCommit: { type: 'string', required: true },
    targetBranch: { type: 'string', required: true }, targetCommit: { type: 'string' }, candidateCommit: { type: 'string' },
    error: { type: 'string' }, failureKind: { type: 'string', enum: ['verification'] },
    verification: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        command: { type: 'string', required: true }, args: { type: 'array', required: true, items: { type: 'string' } },
      },
    } },
  },
} as const satisfies ValueSchemaSpec

const BATCH_VIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    name: { type: 'string', required: true },
    description: { type: 'string', required: true },
    taskIds: { type: 'array', required: true, items: { type: 'string' } },
    archived: { type: 'boolean', required: true },
    completedTasks: { type: 'integer', required: true },
    status: { type: 'string', required: true, enum: ['active', 'completed', 'archived'] },
  },
} as const

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'idle', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Resolve the shared Team-list pagination protocol. */
function pagination(request: { cursor?: number; limit?: number }): { cursor: number; limit: number } {
  const cursor = request.cursor ?? 0
  const limit = request.limit ?? 50
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
  return { cursor, limit }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Required<Config>): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: () => {
        const membership = ctx.agentTeams.membership(agent)
        return `${policy(ctx.agentTeams.workspaceMode === 'worktree')}\n\nYour Team role is ${membership.role}; your Team name is ${membership.name}; Team id is ${membership.id}.`
      },
    }))

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', required: true, description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'spawn_teammate')
        const context = args.context ?? 'fresh'
        return await ctx.agentTeams.spawnTeammate(agent, {
          name: args.name,
          description: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          context,
          provider: context === 'fork' ? config.forkProvider : config.freshProvider,
          signal: exec.signal,
        })
      },
    })))

    const messageTool = (toolName: 'send_message' | 'followup_task', delivery: 'quiet' | 'wakeup'): void => {
      register(scoped.tools.register(defineTool({
        name: toolName,
        description: delivery === 'quiet'
          ? 'Send durable information to another Team member without starting an idle member.'
          : 'Send a durable follow-up task to another Team member and start a turn when needed.',
        parameters: {
          target: { type: 'string', required: true, description: 'Team member name, or lead.' },
          message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
        },
        output: jsonOutput(SEND_VALUE_SCHEMA),
        execute(args, exec) {
          return ctx.agentTeams.sendMessage(callingAgent(exec.agent, toolName), {
            target: args.target,
            content: [{ type: 'text', text: args.message }],
            delivery,
            signal: exec.signal,
          })
        },
      })))
    }
    messageTool('send_message', 'quiet')
    messageTool('followup_task', 'wakeup')

    register(scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with current runtime status.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      async execute(_args, exec) {
        return Promise.resolve(ctx.agentTeams.listMembers(callingAgent(exec.agent, 'list_agents')))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
      parameters: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
        },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const timeoutMs = args.timeout_ms ?? 30_000
        // Preserve TeamService's authoritative timeout validation before the
        // model-only no-progress shortcut.
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
          return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        }
        // The active-peer read and waiter registration must remain one synchronous
        // span; awaiting between them can lose the only peer-status edge.
        const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
          member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
        if (!hasActivePeer) {
          return {
            timedOut: false,
            noProgress: {
              reason: 'no-active-peer' as const,
              message: NO_ACTIVE_PEER_MESSAGE,
            },
          }
        }
        return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'interrupt_agent',
      description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate name.' },
      },
      output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.interrupt(
          callingAgent(exec.agent, 'interrupt_agent'),
          args.target,
        ))
      },
    })))

    if (ctx.agentTeams.integrationEnabled) {
      register(scoped.tools.register(defineTool({
        name: 'team_integration_enqueue',
        description: 'Queue a quiescent worker’s committed output for isolated verification and integration into the configured target branch. Team Lead only.',
        parameters: { target: { type: 'string', required: true, description: 'Teammate name.' } },
        output: jsonOutput(INTEGRATION_SCHEMA),
        async execute(args, exec) {
          return await ctx.agentTeams.enqueueIntegration(callingAgent(exec.agent, 'team_integration_enqueue'), args.target, exec.signal)
        },
      })))
      register(scoped.tools.register(defineTool({
        name: 'team_integration_run',
        description: 'Verify and promote the oldest queued integration, or recover its verified promotion. Failed verification retains the candidate checkout. Team Lead only.',
        parameters: {},
        output: jsonOutput({ type: 'object', additionalProperties: false, properties: { integration: INTEGRATION_SCHEMA } }),
        async execute(_args, exec) {
          const integration = await ctx.agentTeams.runIntegration(callingAgent(exec.agent, 'team_integration_run'), exec.signal)
          return integration === undefined ? {} : { integration }
        },
      })))
      register(scoped.tools.register(defineTool({
        name: 'team_integration_abandon',
        description: 'Stop retrying a blocked integration and retain its candidate checkout for inspection. A new request pins new inputs. Team Lead only.',
        parameters: {
          id: { type: 'string', required: true, description: 'Integration id.' },
          reason: { type: 'string', required: true, description: 'Why this request is being abandoned.' },
        },
        output: jsonOutput(INTEGRATION_SCHEMA),
        async execute(args, exec) {
          return await ctx.agentTeams.abandonIntegration(callingAgent(exec.agent, 'team_integration_abandon'), args.id as TeamIntegrationId, args.reason, exec.signal)
        },
      })))
      register(scoped.tools.register(defineTool({
        name: 'team_integration_list',
        description: 'Read pinned integration requests and durable verification or promotion outcomes.',
        parameters: {
          cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
          limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
        },
        output: jsonOutput({ type: 'object', additionalProperties: false, properties: {
          integrations: { type: 'array', required: true, items: INTEGRATION_SCHEMA }, nextCursor: { type: 'integer' },
        } }),
        execute(args, exec) {
          const rows = ctx.agentTeams.listIntegrations(callingAgent(exec.agent, 'team_integration_list'))
          const { cursor, limit } = pagination(args)
          return Promise.resolve({
            integrations: rows.slice(cursor, cursor + limit),
            ...cursor + limit < rows.length ? { nextCursor: cursor + limit } : {},
          })
        },
      })))
    }

    if (ctx.agentTeams.workspaceMode === 'worktree') {
      register(scoped.tools.register(defineTool({
        name: 'team_worktree_release',
        description: 'Release a quiescent teammate worktree after its commits are merged. Dirty or unmerged work is preserved. Team Lead only.',
        parameters: { target: { type: 'string', required: true, description: 'Teammate name.' } },
        output: jsonOutput({ type: 'object', additionalProperties: false, properties: { released: { type: 'boolean', required: true } } }),
        async execute(args, exec) {
          await ctx.agentTeams.releaseWorktree(callingAgent(exec.agent, 'team_worktree_release'), args.target, exec.signal)
          return { released: true }
        },
      })))
    }

    register(scoped.tools.register(defineTool({
      name: 'team_batch_create',
      description: 'Create a durable named batch of shared tasks whose progress survives Lead restarts. Team Lead only.',
      parameters: {
        name: { type: 'string', required: true, description: 'Batch name.' },
        description: { type: 'string', required: true, description: 'Batch outcome and scope.' },
        task_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Current task ids, without duplicates.' },
      },
      output: jsonOutput(BATCH_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.createBatch(callingAgent(exec.agent, 'team_batch_create'), {
          name: args.name, description: args.description, taskIds: args.task_ids.map(TeamTaskId),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_batch_list',
      description: 'Read durable task batches, including archived entries and current completion counts.',
      parameters: {
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput({
        type: 'object', additionalProperties: false,
        properties: { batches: { type: 'array', required: true, items: BATCH_VIEW_SCHEMA }, nextCursor: { type: 'integer' } },
      }),
      execute(args, exec) {
        const rows = ctx.agentTeams.listBatches(callingAgent(exec.agent, 'team_batch_list'))
        const { cursor, limit } = pagination(args)
        return Promise.resolve({
          batches: rows.slice(cursor, cursor + limit),
          ...cursor + limit < rows.length ? { nextCursor: cursor + limit } : {},
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_batch_update',
      description: 'Edit or permanently archive a durable task batch using its current revision. Team Lead only.',
      parameters: {
        batch_id: { type: 'string', required: true, description: 'Batch id from team_batch_list.' },
        expected_revision: { type: 'integer', required: true, description: 'Current batch revision.' },
        name: { type: 'string', description: 'Replacement name.' },
        description: { type: 'string', description: 'Replacement outcome and scope.' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Complete replacement task list.' },
        archive: { type: 'boolean', description: 'True permanently archives the batch and releases its task references.' },
      },
      output: jsonOutput(BATCH_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.updateBatch(callingAgent(exec.agent, 'team_batch_update'), {
          batchId: TeamBatchId(args.batch_id), expectedRevision: args.expected_revision,
          ...args.name === undefined ? {} : { name: args.name },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.task_ids === undefined ? {} : { taskIds: args.task_ids.map(TeamTaskId) },
          ...args.archive === undefined ? {} : { archive: args.archive },
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task. A Lead may set non-code criteria to require an audited report instead of Git integration.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        non_code_criteria: { type: 'string', description: 'Immutable explicit acceptance criteria for report-only non-code work. Lead only.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
          subject: args.subject,
          description: args.description,
          ...args.non_code_criteria === undefined ? {} : { nonCodeCriteria: args.non_code_criteria },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member-name filter; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const { cursor, limit } = pagination(args)
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        owner: { type: 'string', description: 'Member name for Lead-only reassign; omit to unassign.' },
        result: { type: 'string', description: 'Required completion evidence: outcome, changed artifacts, and verification.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.updateTask(callingAgent(exec.agent, 'team_task_update'), {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
          ...args.result === undefined ? {} : { result: args.result },
        })
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
