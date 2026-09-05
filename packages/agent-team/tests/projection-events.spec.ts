import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamProjectionState, TeamState } from '../src/projection.ts'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/types.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot, TeamWorktreeSnapshot, TeamIntegrationSnapshot, TeamIntegrationId, TeamBranchName, TeamCommitId } from '../src/types.ts'

const ROOT = SessionId('team-root')
const TEAM = TeamId(ROOT)
const CHILD = SessionId('child-a')

function event<T extends SessionEventType>(type: T, data: SessionEventMap[T], seq: number): SessionEvent<T> {
  return { type, data, seq, time: seq } as SessionEvent<T>
}

function project(rootId: SessionId, events: readonly SessionEvent[]): TeamProjectionState {
  let state = teamProjectionDefinition.init({ version: 0, id: rootId, createdAt: 0 })
  for (const event of events) state = teamProjectionDefinition.apply(state, event)
  return state
}

function teamState(projected: TeamProjectionState): TeamState {
  if (projected.failure !== undefined) throw new Error(projected.failure)
  return projected
}

function projectTeam(rootId: SessionId, events: readonly SessionEvent[]): TeamState {
  return teamState(project(rootId, events))
}

/** Queued-minus-delivered mail retained by the projection. */
function pending(state: TeamState): TeamMessageSnapshot[] {
  return state.messages.filter(message => !state.delivered.includes(message.id))
}

/** Whether one Team state contains no projected records. */
function isEmptyState(state: TeamState): boolean {
  return state.members.length === 0 && state.tasks.length === 0
    && state.messages.length === 0 && state.delivered.length === 0
}

function member(overrides: Partial<TeamMemberSnapshot> = {}): TeamMemberSnapshot {
  return {
    id: CHILD,
    name: 'worker-a',
    description: 'worker',
    provider: 'spawn',
    context: 'fresh',
    phase: 'provisioning',
    ...overrides,
  }
}

function task(overrides: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return {
    id: TeamTaskId('task-1'),
    revision: 1,
    subject: 'subject',
    description: 'description',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ...overrides,
  }
}

function message(overrides: Partial<TeamMessageSnapshot> = {}): TeamMessageSnapshot {
  return {
    id: TeamMessageId('message-1'),
    senderId: ROOT,
    senderName: 'lead',
    targetId: CHILD,
    delivery: 'quiet',
    content: [{ type: 'text', text: 'hello' }],
    ...overrides,
  }
}

describe('Agent Teams projection events', () => {
  it('rejects integration records without ownership, verification inputs, or contiguous phases', () => {
    const owner = event('team/member', { version: 1, teamId: TEAM, member: member() }, 0)
    const worktree: TeamWorktreeSnapshot = {
      memberId: CHILD, provider: 'git', repository: resolve('repository'), cwd: resolve('worker'),
      branch: 'team/worker' as TeamBranchName, baseCommit: 'a'.repeat(40) as TeamCommitId, phase: 'reserved',
    }
    const reserved = event('team/worktree', { version: 1, teamId: TEAM, worktree }, 1)
    const job: TeamIntegrationSnapshot = {
      id: 'integration-1' as TeamIntegrationId, memberId: CHILD, provider: 'git', phase: 'queued',
      repository: worktree.repository, cwd: resolve('candidate'), sourceBranch: worktree.branch,
      sourceCommit: worktree.baseCommit, targetBranch: 'main' as TeamBranchName,
      verification: [{ command: 'check', args: [] }],
    }
    const edge = (fields: Partial<TeamIntegrationSnapshot>) => event('team/integration', {
      version: 1, teamId: TEAM, integration: { ...job, ...fields },
    }, 2)
    const queued = edge({})
    const running = edge({ phase: 'running', targetCommit: worktree.baseCommit })
    const verified = edge({ phase: 'verified', targetCommit: worktree.baseCommit, candidateCommit: worktree.baseCommit })
    const merged = edge({ phase: 'merged', targetCommit: worktree.baseCommit, candidateCommit: worktree.baseCommit })
    expect(projectTeam(ROOT, [owner, reserved, queued, running, verified, merged]).integrations[0]?.phase).toBe('merged')
    expect(() => projectTeam(ROOT, [queued])).toThrow(/matching worker/u)
    expect(() => projectTeam(ROOT, [owner, reserved, running])).toThrow(/phase transition/u)
    expect(() => projectTeam(ROOT, [owner, reserved, queued, verified])).toThrow(/phase transition/u)
    expect(() => projectTeam(ROOT, [owner, reserved, queued, edge({ phase: 'running' })])).toThrow(/fields are inconsistent/u)
    expect(() => projectTeam(ROOT, [owner, reserved, queued, edge({ phase: 'failed' })])).toThrow(/fields are inconsistent/u)
    expect(() => projectTeam(ROOT, [owner, reserved, edge({ verification: [] })])).toThrow(/payload is invalid/u)
    expect(() => projectTeam(ROOT, [owner, reserved, queued, edge({ phase: 'running', targetCommit: worktree.baseCommit, sourceCommit: 'b'.repeat(40) as TeamCommitId })])).toThrow(/immutable inputs/u)
    expect(() => projectTeam(ROOT, [owner, reserved, queued, running, verified, merged, verified])).toThrow(/phase transition/u)
    const gatedQueued = edge({ reviewGate: 'implementation-review' })
    const gatedRunning = edge({ reviewGate: 'implementation-review', phase: 'running', targetCommit: worktree.baseCommit })
    const gatedVerified = edge({ reviewGate: 'implementation-review', phase: 'verified', targetCommit: worktree.baseCommit, candidateCommit: worktree.baseCommit })
    const gatedMerged = edge({ reviewGate: 'implementation-review', phase: 'merged', targetCommit: worktree.baseCommit, candidateCommit: worktree.baseCommit })
    expect(() => projectTeam(ROOT, [owner, reserved, gatedQueued, gatedRunning, gatedVerified, gatedMerged])).toThrow(/review receipt/u)
  })

  it('validates durable worktree ownership and terminal release', () => {
    const owner = event('team/member', { version: 1, teamId: TEAM, member: member() }, 0)
    const worktree: TeamWorktreeSnapshot = {
      memberId: CHILD, provider: 'git', repository: resolve('repository'), cwd: resolve('workers/one'),
      branch: 'team/one' as TeamBranchName, baseCommit: 'a'.repeat(40) as TeamCommitId, phase: 'reserved',
    }
    const edge = (overrides: Partial<TeamWorktreeSnapshot>, seq = 1) => event('team/worktree', {
      version: 1, teamId: TEAM, worktree: { ...worktree, ...overrides },
    }, seq)
    const reserved = edge({})
    const ready = edge({ phase: 'ready' }, 2)
    const released = edge({ phase: 'released' }, 3)
    expect(projectTeam(ROOT, [owner, reserved, ready, released]).worktrees).toEqual([{ ...worktree, phase: 'released' }])
    expect(() => projectTeam(ROOT, [reserved])).toThrow(/not a Team member/u)
    expect(() => projectTeam(ROOT, [owner, ready])).toThrow(/begin reserved/u)
    expect(() => projectTeam(ROOT, [owner, reserved, edge({ phase: 'ready', cwd: resolve('different') }, 2)]))
      .toThrow(/immutable creation inputs/u)
    expect(() => projectTeam(ROOT, [owner, reserved, ready, released, ready])).toThrow(/invalid Team worktree transition/u)
    expect(() => projectTeam(ROOT, [owner, edge({ cwd: '../relative' })])).toThrow(/payload is invalid/u)
    expect(() => projectTeam(ROOT, [owner, edge({ baseCommit: 'HEAD' as TeamCommitId })])).toThrow(/payload is invalid/u)
    const other = SessionId('child-b')
    expect(() => projectTeam(ROOT, [owner, reserved,
      event('team/member', { version: 1, teamId: TEAM, member: member({ id: other, name: 'worker-b' }) }, 2),
      edge({ memberId: other }, 3),
    ])).toThrow(/already owned/u)
  })

  it('projects current-team records independently from inherited records', () => {
    const records: SessionEvent[] = [
      event('team/member', { version: 1, teamId: TeamId('ancestor'), member: member() }, 0),
      event('team/member', { version: 1, teamId: TEAM, member: member() }, 1),
      event('team/member', {
        version: 1,
        teamId: TEAM,
        member: member({ phase: 'active' }),
      }, 2),
      event('team/task', { version: 1, teamId: TEAM, task: task({ id: TeamTaskId('task-7') }) }, 3),
      event('team/message/queued', { version: 1, teamId: TEAM, message: message() }, 4),
    ]
    const projected = project(ROOT, records)
    const state = teamState(projected)

    expect(state).toMatchObject({ id: TEAM })
    expect(state.members).toHaveLength(1)
    expect(state.tasks).toHaveLength(1)
    expect(pending(state)).toHaveLength(1)
    expect(state.nextTaskNumber).toBe(8)
    expect(state.members.find(member => member.id === CHILD)?.name).toBe('worker-a')
    expect(teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(projected))))
      .toEqual(projected)
  })

  it('enforces teammate identity and lifecycle', () => {
    const base = event('team/member', { version: 1, teamId: TEAM, member: member() }, 0)
    expect(() => projectTeam(ROOT, [event('team/member', {
      version: 1,
      teamId: TEAM,
      member: member({ phase: 'active' }),
    }, 0)])).toThrow(/must begin provisioning/)
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 1,
      teamId: TEAM,
      member: member({ name: 'renamed', phase: 'active' }),
    }, 1)])).toThrow(/immutable identity/)
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 1,
      teamId: TEAM,
      member: member({ phase: 'active' }),
    }, 1), event('team/member', {
      version: 1,
      teamId: TEAM,
      member: member({ phase: 'failed' }),
    }, 2)])).toThrow(/invalid active -> failed/)

    const duplicateName = member({ id: SessionId('child-b') })
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 1,
      teamId: TEAM,
      member: duplicateName,
    }, 1)])).toThrow(/name .* reused/)
  })

  it('enforces task revision continuity', () => {
    const first = event('team/task', { version: 1, teamId: TEAM, task: task() }, 0)
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 1,
      teamId: TEAM,
      task: task({ revision: 2 }),
    }, 0)])).toThrow(/begin at revision 1/)
    expect(() => projectTeam(ROOT, [first, event('team/task', {
      version: 1,
      teamId: TEAM,
      task: task({ revision: 3 }),
    }, 1)])).toThrow(/revision is not contiguous/)
    const completed = projectTeam(ROOT, [first, event('team/task', {
      version: 1,
      teamId: TEAM,
      task: task({ revision: 2, status: 'completed', result: 'Verified output.' }),
    }, 1)])
    expect(completed.tasks[0]?.result).toBe('Verified output.')
  })

  it('rejects every invalid persisted task dependency relation', () => {
    const first = event('team/task', { version: 1, teamId: TEAM, task: task() }, 0)
    const second = event('team/task', {
      version: 1,
      teamId: TEAM,
      task: task({
        id: TeamTaskId('task-2'),
        blockedBy: [TeamTaskId('task-1')],
      }),
    }, 1)
    const invalid: Array<{ records: SessionEvent[]; message: RegExp }> = [
      {
        records: [event('team/task', {
          version: 1,
          teamId: TEAM,
          task: task({ blockedBy: [TeamTaskId('missing')] }),
        }, 0)],
        message: /blocker task "missing" .* is missing or deleted/,
      },
      {
        records: [event('team/task', {
          version: 1,
          teamId: TEAM,
          task: task({ blockedBy: [TeamTaskId('task-1')] }),
        }, 0)],
        message: /cannot block itself/,
      },
      {
        records: [first, event('team/task', {
          ...second.data,
          task: { ...second.data.task, blockedBy: [TeamTaskId('task-1'), TeamTaskId('task-1')] },
        }, 1)],
        message: /repeats blocker/,
      },
      {
        records: [first, second, event('team/task', {
          version: 1,
          teamId: TEAM,
          task: task({ revision: 2, blockedBy: [TeamTaskId('task-2')] }),
        }, 2)],
        message: /dependency cycle/,
      },
      {
        records: [first, second, event('team/task', {
          version: 1,
          teamId: TEAM,
          task: task({ revision: 2, status: 'deleted' }),
        }, 2)],
        message: /blocker task "task-1" .* is missing or deleted/,
      },
    ]

    for (const { records, message: expected } of invalid) {
      expect(() => projectTeam(ROOT, records)).toThrow(expected)
    }
  })

  it('leaves numeric allocation unchanged for a branded nonstandard task id', () => {
    const state = projectTeam(ROOT, [event('team/task', {
      version: 1,
      teamId: TEAM,
      task: task({ id: TeamTaskId('external-task') }),
    }, 0)])
    expect(state.nextTaskNumber).toBe(1)
  })

  it('rejects a persisted numeric task id outside the safe integer range', () => {
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 1,
      teamId: TEAM,
      task: task({ id: TeamTaskId('task-9007199254740992') }),
    }, 0)])).toThrow(/persisted Agent Teams team\/task payload is invalid/)
  })

  it('enforces mailbox queue and acknowledgement relations', () => {
    const queued = event('team/message/queued', { version: 1, teamId: TEAM, message: message() }, 0)
    const delivered = event('team/message/delivered', {
      version: 1,
      teamId: TEAM,
      messageId: TeamMessageId('message-1'),
      targetId: CHILD,
    }, 1)
    expect(pending(projectTeam(ROOT, [queued, delivered]))).toEqual([])
    expect(() => projectTeam(ROOT, [queued, queued])).toThrow(/queued twice/)
    expect(() => projectTeam(ROOT, [delivered])).toThrow(/delivered before queueing/)
    expect(() => projectTeam(ROOT, [queued, event('team/message/delivered', {
      ...delivered.data,
      targetId: SessionId('other'),
    }, 1)])).toThrow(/target changed/)
    expect(() => projectTeam(ROOT, [queued, delivered, { ...delivered, seq: 2 }])).toThrow(/delivered twice/)
  })

  it('validates every current-version persisted payload before projecting it', () => {
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 1, teamId: TEAM, task: task({ status: 'completed' }),
    }, 0)])).toThrow(/has no result evidence/)
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 1, teamId: TEAM, task: task({ result: 'invalid' }),
    }, 0)])).toThrow(/retains result evidence/)

    for (const result of ['', '  ']) {
      expect(() => projectTeam(ROOT, [event('team/task', {
        version: 1, teamId: TEAM, task: task({ status: 'completed', result }),
      }, 0)])).toThrow()
    }

    const malformed = [
      {
        ...event('team/member', { version: 1, teamId: TEAM, member: member() }, 0),
        data: { version: 1, teamId: TEAM, member: { ...member(), name: 42 } },
      },
      {
        ...event('team/task', { version: 1, teamId: TEAM, task: task() }, 0),
        data: { version: 1, teamId: TEAM, task: { ...task(), blockedBy: [42] } },
      },
      {
        ...event('team/message/queued', { version: 1, teamId: TEAM, message: message() }, 0),
        data: {
          version: 1,
          teamId: TEAM,
          message: { ...message(), content: [{ type: 'text', text: 42 }] },
        },
      },
      {
        ...event('team/message/delivered', {
          version: 1,
          teamId: TEAM,
          messageId: TeamMessageId('message-1'),
          targetId: CHILD,
        }, 0),
        data: {
          version: 1,
          teamId: TEAM,
          messageId: TeamMessageId('message-1'),
          targetId: 42,
        },
      },
      {
        ...event('team/member', { version: 1, teamId: TEAM, member: member() }, 0),
        data: { version: 1, teamId: TEAM, member: member(), unexpected: true },
      },
      {
        ...event('team/task', { version: 1, teamId: TEAM, task: task() }, 0),
        data: { version: 1, teamId: 42, task: task() },
      },
    ] as unknown as SessionEvent[]

    for (const candidate of malformed) {
      expect(() => projectTeam(ROOT, [candidate]))
        .toThrow(/persisted Agent Teams .* payload is invalid/)
    }
  })

  it('retains merge-extensible content blocks while rejecting malformed core variants', () => {
    const extension = { type: 'plugin/custom', payload: { value: 1 } } as never
    const state = projectTeam(ROOT, [event('team/message/queued', {
      version: 1,
      teamId: TEAM,
      message: message({ content: [extension] }),
    }, 0)])
    expect(pending(state)[0]?.content).toEqual([extension])
  })

  it('records unsupported event versions without applying them', () => {
    const invalid = event('team/task', {
      version: 2 as 1,
      teamId: TEAM,
      task: task(),
    }, 0)
    const later = event('team/task', {
      version: 1,
      teamId: TEAM,
      task: task(),
    }, 1)
    const state = project(ROOT, [invalid, later])
    expect(state.failure).toMatch(/unsupported Agent Teams event version 2/)
    expect(isEmptyState(state)).toBe(true)
  })

  it('isolates unsupported inherited Team records from the current Team', () => {
    const inherited = event('team/task', {
      version: 2 as 1,
      teamId: TeamId('ancestor'),
      task: task(),
    }, 0)
    const projected = project(ROOT, [inherited])
    expect(projected.failure).toBeUndefined()
    expect(isEmptyState(teamState(projected))).toBe(true)
  })

  it('ignores malformed current-version records inherited from another Team', () => {
    const inherited = {
      ...event('team/task', {
        version: 1,
        teamId: TeamId('ancestor'),
        task: task(),
      }, 0),
      data: {
        version: 1,
        teamId: TeamId('ancestor'),
        task: { ...task(), subject: 42 },
      },
    } as unknown as SessionEvent
    expect(isEmptyState(projectTeam(ROOT, [inherited]))).toBe(true)
  })
})
