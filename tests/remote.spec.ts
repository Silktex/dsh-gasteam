import { describe, expect, it } from 'vitest'
import { descriptors } from '../packages/agent-team/src/remote-descriptors.ts'
import { createTaskSchema, updateTaskSchema, teamViewSchema, taskResultSchema } from '../packages/agent-team/src/remote-schemas.ts'
import { schedulingQuerySchema, schedulingControlSchema, schedulingViewSchema } from '../packages/agent-team/src/scheduling-schemas.ts'
import { TYPERT } from '../packages/agent-team/src/typert.ts'
import { TYPERT_REMOTE } from '../packages/agent-team/src/remote.ts'

describe('Team RPC codecs', () => {
  it('shares the exact Host and browser invocation definitions', () => {
    expect(TYPERT.invocations).toBe(TYPERT_REMOTE.descriptors)
    expect(descriptors.map(value => [value.method, value.implementation, value.parameters.map(parameter => parameter.wire)]))
      .toEqual([
        ['scheduling', 'remoteScheduling', ['agentId', 'request']],
        ['controlScheduling', 'remoteControlScheduling', ['agentId', 'request']],
        ['createTask', 'remoteCreateTask', ['agentId', 'request']],
        ['updateTask', 'remoteUpdateTask', ['agentId', 'request']],
        ['view', 'remoteView', ['agentId']],
      ])
    expect(descriptors.every(value => value.parameters[0]?.source === 'lookup')).toBe(true)
  })

  it('validates scheduling controls and preserves typed blocker responses', () => {
    expect(schedulingQuerySchema.parse({ projectId: 'project' })).toEqual({ projectId: 'project' })
    expect(() => schedulingControlSchema.parse({ action: 'pause', projectId: 'project', expectedRevision: -1, paused: true })).toThrow()
    expect(() => schedulingControlSchema.parse({ action: 'priority', projectId: 'project', taskId: 'task', expectedRevision: 1, priority: 1.5 })).toThrow()
    const view = { projectId: 'project', paused: false, controlRevision: 0, requests: [{ projectId: 'project', teamId: 'team', taskId: 'task', order: 1, revision: 1, priority: 0, state: 'waiting', blockers: [{ code: 'dependencies', detail: 'prerequisite' }] }] }
    expect(schedulingViewSchema.parse(view)).toEqual(view)
    expect(() => schedulingViewSchema.parse({ ...view, requests: [{ ...view.requests[0], blockers: [{ code: 'invented', detail: '' }] }] })).toThrow()
  })

  it('rejects malformed task requests before service invocation', () => {
    expect(createTaskSchema.parse({ subject: 'Check', description: 'Review the diff' })).toEqual({ subject: 'Check', description: 'Review the diff' })
    expect(() => createTaskSchema.parse({ subject: 'Check' })).toThrow()
    expect(() => createTaskSchema.parse({ subject: 'Check', description: '', blockedBy: [2] })).toThrow()
    expect(updateTaskSchema.parse({ taskId: 'task-1', expectedRevision: 1, action: 'complete', result: 'Tests passed' }).action).toBe('complete')
    expect(() => updateTaskSchema.parse({ taskId: 'task-1', action: 'complete' })).toThrow()
    expect(() => updateTaskSchema.parse({ taskId: 'task-1', expectedRevision: 1, action: 'invented' })).toThrow()
  })

  it('preserves batch and integration fields and rejects incomplete views', () => {
    const empty = { members: [], tasks: [], batches: [], integrations: [] }
    expect(teamViewSchema.parse(empty)).toEqual(empty)
    expect(() => teamViewSchema.parse({ members: [], tasks: [] })).toThrow()
    expect(() => teamViewSchema.parse({ ...empty, integrations: [{ phase: 'merged' }] })).toThrow()
    expect(() => taskResultSchema.parse({ ok: true, value: { id: 'task-1' } })).toThrow()
  })
})
