/** Pure dashboard → visual scene reconciliation coverage. */

import { describe, expect, it } from 'vitest'
import type { WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { reconcileDashboard } from '../src/client/reconcile.ts'

type Attempt = WorkspaceDashboardView['attempts'][number]
type QueueEntry = WorkspaceDashboardView['queue'][number]
type Escalation = WorkspaceDashboardView['escalations'][number]

function attempt(
  attemptId: string,
  phase: Attempt['phase'],
  projectId = 'project-a',
  taskId = 'task-1',
): Attempt {
  return { attemptId, generation: 1, revision: 1, projectId, teamId: 'lead', taskId, phase }
}

function waiting(
  taskId = 'task-1',
  projectId = 'project-a',
  blockers: QueueEntry['blockers'] = [{ code: 'dependencies' }],
): QueueEntry {
  return { projectId, teamId: 'lead', taskId, revision: 1, state: 'waiting', blockers, blockersTruncated: false }
}

function escalation(attemptId: string, severity: Escalation['severity'] = 'critical'): Escalation {
  return {
    id: `escalation-${attemptId}`, revision: 1, projectId: 'project-a', teamId: 'lead',
    taskId: 'task-1', attemptId, generation: 1, severity, condition: 'failed',
    diagnostics: 'Runtime health escalation.',
  }
}

function view(overrides: Partial<WorkspaceDashboardView> = {}): WorkspaceDashboardView {
  return {
    projects: [], projectsTruncated: false,
    attempts: [], attemptsTruncated: false,
    workflows: [], workflowsTruncated: false,
    batches: [], batchesTruncated: false,
    mergeBatches: [], mergeBatchesTruncated: false,
    queue: [], queueTruncated: false,
    integrations: [], integrationsTruncated: false,
    escalations: [], escalationsTruncated: false,
    ...overrides,
  }
}

describe('reconcileDashboard', () => {
  it('maps every attempt phase to its visual state', () => {
    const model = reconcileDashboard(view({
      attempts: [
        attempt('a-terminal', 'terminal'),
        attempt('b-active', 'active'),
        attempt('c-reserved', 'reserved'),
        attempt('d-stopping', 'stopping'),
      ],
    }), null)
    expect(model.agents.map(agent => [agent.id, agent.state])).toEqual([
      ['a-terminal', 'done'],
      ['b-active', 'working'],
      ['c-reserved', 'idle'],
      ['d-stopping', 'idle'],
    ])
  })

  it('prioritizes a critical escalation over queue waits and phases', () => {
    const model = reconcileDashboard(view({
      attempts: [attempt('attempt-1', 'active')],
      queue: [waiting()],
      escalations: [escalation('attempt-1')],
    }), null)
    expect(model.agents[0]?.state).toBe('error')
  })

  it('marks a waiting queue entry with blockers as blocked ahead of the phase', () => {
    const model = reconcileDashboard(view({
      attempts: [attempt('attempt-1', 'active')],
      queue: [waiting()],
      escalations: [escalation('attempt-1', 'warning')],
    }), null)
    expect(model.agents[0]?.state).toBe('blocked')
  })

  it('ignores warning escalations, blocker-free waits, and unmatched queue entries', () => {
    const model = reconcileDashboard(view({
      attempts: [
        attempt('a-warning', 'active'),
        attempt('b-waiting-clear', 'active'),
        attempt('c-unmatched', 'active', 'project-a', 'task-9'),
      ],
      queue: [
        waiting('task-1', 'project-a', []),
        waiting('task-other', 'project-a'),
      ],
      escalations: [escalation('a-warning', 'warning')],
    }), null)
    expect(model.agents.map(agent => [agent.id, agent.state])).toEqual([
      ['a-warning', 'working'],
      ['b-waiting-clear', 'working'],
      ['c-unmatched', 'working'],
    ])
  })

  it('does not treat a critical escalation for another attempt as an error', () => {
    const model = reconcileDashboard(view({
      attempts: [attempt('attempt-1', 'active')],
      escalations: [escalation('attempt-2')],
    }), null)
    expect(model.agents[0]?.state).toBe('working')
  })

  it('filters agents to the selected project and echoes the selection', () => {
    const model = reconcileDashboard(view({
      attempts: [
        attempt('a', 'active', 'project-a'),
        attempt('b', 'active', 'project-b', 'task-2'),
      ],
    }), 'project-b')
    expect(model.projectId).toBe('project-b')
    expect(model.agents).toEqual([{
      id: 'b', projectId: 'project-b', taskId: 'task-2', state: 'working', label: 'project-b/task-2',
    }])
  })

  it('keeps every project when no project is selected', () => {
    const model = reconcileDashboard(view({
      attempts: [
        attempt('a', 'active', 'project-a'),
        attempt('b', 'terminal', 'project-b', 'task-2'),
      ],
    }), null)
    expect(model.projectId).toBeNull()
    expect(model.agents.map(agent => [agent.id, agent.state])).toEqual([
      ['a', 'working'],
      ['b', 'done'],
    ])
  })

  it('sorts agents by id for stable rendering', () => {
    const model = reconcileDashboard(view({
      attempts: [
        attempt('zeta', 'active'),
        attempt('alpha', 'active'),
        attempt('mid', 'terminal'),
      ],
    }), null)
    expect(model.agents.map(agent => agent.id)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('returns an empty scene for an empty view', () => {
    expect(reconcileDashboard(view(), null)).toEqual({ projectId: null, agents: [], projectCount: 0 })
  })

  it('reports the project count and agent labels from the view', () => {
    const model = reconcileDashboard(view({
      projects: [
        { id: 'project-a', revision: 1, paused: false, capacity: 2, active: 1 },
        { id: 'project-b', revision: 1, paused: false, capacity: 1, active: 0 },
      ],
      attempts: [attempt('attempt-1', 'reserved')],
    }), null)
    expect(model.projectCount).toBe(2)
    expect(model.agents[0]).toEqual({
      id: 'attempt-1', projectId: 'project-a', taskId: 'task-1', state: 'idle', label: 'project-a/task-1',
    })
  })
})
