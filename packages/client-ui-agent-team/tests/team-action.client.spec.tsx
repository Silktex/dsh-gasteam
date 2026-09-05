// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamTaskId, TeamTaskView as TeamTask, TeamView,
  OperatorEscalation,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import { makeTranslate } from '../../../tests/support/translate.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { zh as commonZh } from '../../../tests/support/common-zh.ts'
import {
  TeamAction, type TeamActionInjected, type TeamActionProps, type TeamActionResult,
  type TeamTaskActionResult,
} from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'lead' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
const TASK_2 = 'task-2' as TeamTaskId
const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
const view: TeamView = {
  batches: [], integrations: [],
  members: [
    { id: SESSION, name: 'lead', role: 'lead', status: 'idle', model: 'model-a', diagnostics: [] },
    {
      id: 'worker-id' as SessionId,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      model: 'model-a',
      diagnostics: [],
    },
  ],
  tasks: [task],
}

function taskSuccess(value: TeamTask): TeamTaskActionResult {
  return { ok: true, value: { ok: true, value } }
}

function taskConflict(message: string): TeamTaskActionResult {
  return {
    ok: true,
    value: { ok: false, error: { code: 'team-task-conflict', message } },
  }
}

function taskRejected(message: string): TeamTaskActionResult {
  return {
    ok: true,
    value: { ok: false, error: { code: 'team-rejected', message } },
  }
}

function remoteFailure(message: string): TeamActionResult<never> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

function props(actions: TeamActionInjected, sessionId: SessionId = SESSION): TeamActionProps {
  return {
    sessionId,
    ...actions,
    t: makeTranslate(zh, commonZh),
  } as unknown as TeamActionProps
}

function actions(overrides: Partial<TeamActionInjected> = {}): TeamActionInjected {
  return {
    load: () => Promise.resolve({ ok: true, value: view }),
    createTask: () => Promise.resolve(taskSuccess({ ...task, id: TASK_2, subject: 'New task' })),
    updateTask: () => Promise.resolve({
      ok: true,
      value: { ok: true, value: { ...task, revision: 2 } },
    }),
    openTeammate: () => Promise.resolve(),
    healthInbox: () => Promise.resolve({ ok: true, value: [] }),
    acknowledgeHealth: () => Promise.resolve({ ok: true, value: healthEscalation }),
    ...overrides,
  }
}

const healthEscalation: OperatorEscalation = {
  id: 'escalation-1', attemptId: 'attempt-health', generation: 1, condition: 'failed', severity: 'critical', source: 'health',
  diagnostics: 'Pinned integration receipt failed.', work: { projectId: 'project-health', teamId: 'lead', taskId: 'task-health', state: 'failed' },
  revision: 3, cooldownUntil: 123,
}

function completeTask(evidence = 'Changed runtime; focused tests passed.', index = 0): void {
  const buttons = screen.getAllByRole('button', { name: /完成/u })
  fireEvent.click(buttons[index]!)
  fireEvent.change(screen.getByRole('textbox', { name: /完成依据/u }), { target: { value: evidence } })
  const completionDialog = screen.getByRole('dialog', { name: /完成依据/u })
  fireEvent.click(within(completionDialog).getByRole('button', { name: zh.complete }))
}

describe('TeamAction', () => {
  it('fences a deferred health load or acknowledgement to its original project', async () => {
    const oldLoad = Promise.withResolvers<TeamActionResult<OperatorEscalation[]>>()
    const oldAck = Promise.withResolvers<TeamActionResult<OperatorEscalation>>()
    const healthInbox = vi.fn().mockImplementation(() => oldLoad.promise)
    const acknowledgeHealth = vi.fn().mockImplementation(() => oldAck.promise)
    render(<TeamAction {...props(actions({ healthInbox, acknowledgeHealth }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    const project = screen.getByRole('textbox', { name: zh['health.project'] })
    fireEvent.change(project, { target: { value: 'project-health' } })
    fireEvent.click(within(screen.getByLabelText(zh['health.title'])).getByRole('button', { name: zh['health.refresh'] }))
    fireEvent.change(project, { target: { value: 'project-other' } })
    oldLoad.resolve({ ok: true, value: [healthEscalation] })
    await Promise.resolve()
    expect(screen.queryByText('Pinned integration receipt failed.')).toBeNull()

    const currentLoad = Promise.withResolvers<TeamActionResult<OperatorEscalation[]>>()
    healthInbox.mockImplementationOnce(() => currentLoad.promise)
    fireEvent.change(project, { target: { value: 'project-health' } })
    fireEvent.click(within(screen.getByLabelText(zh['health.title'])).getByRole('button', { name: zh['health.refresh'] }))
    currentLoad.resolve({ ok: true, value: [healthEscalation] })
    expect(await screen.findByText('Pinned integration receipt failed.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['health.acknowledge'] }))
    fireEvent.change(project, { target: { value: 'project-other' } })
    fireEvent.change(project, { target: { value: 'project-health' } })
    oldAck.resolve({ ok: true, value: { ...healthEscalation, acknowledgement: { actor: 'lead', at: 1 }, revision: 4 } })
    await Promise.resolve()
    expect(screen.queryByText(`${zh['health.acknowledged']} · lead`)).toBeNull()
  })

  it('shows a rejected health RPC instead of leaving its loading state pending', async () => {
    const healthInbox = vi.fn().mockRejectedValue(new Error('gateway unavailable'))
    render(<TeamAction {...props(actions({ healthInbox }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.change(screen.getByRole('textbox', { name: zh['health.project'] }), { target: { value: 'project-health' } })
    fireEvent.click(within(screen.getByLabelText(zh['health.title'])).getByRole('button', { name: zh['health.refresh'] }))
    expect(await screen.findByText('Error: gateway unavailable')).toBeTruthy()
    expect(screen.queryByText(zh['health.loading'])).toBeNull()
  })

  it('loads a project-scoped health inbox and acknowledges its exact revision', async () => {
    const healthInbox = vi.fn().mockResolvedValue({ ok: true, value: [healthEscalation] })
    const acknowledgeHealth = vi.fn().mockResolvedValue({ ok: true, value: { ...healthEscalation, revision: 4, acknowledgement: { actor: 'lead', at: 1 } } })
    render(<TeamAction {...props(actions({ healthInbox, acknowledgeHealth }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.change(screen.getByRole('textbox', { name: zh['health.project'] }), { target: { value: 'project-health' } })
    fireEvent.click(within(screen.getByLabelText(zh['health.title'])).getByRole('button', { name: zh['health.refresh'], exact: true }))
    expect(await screen.findByText('Pinned integration receipt failed.')).toBeTruthy()
    expect(healthInbox).toHaveBeenCalledWith(SESSION, 'project-health')
    fireEvent.click(screen.getByRole('button', { name: zh['health.acknowledge'] }))
    await waitFor(() => { expect(acknowledgeHealth).toHaveBeenCalledWith(SESSION, 'project-health', 'escalation-1', 3) })
    expect(await screen.findByText(`${zh['health.acknowledged']} · lead`)).toBeTruthy()
  })

  it('keeps a stale health acknowledgement visible and reloads the scoped inbox', async () => {
    const healthInbox = vi.fn().mockResolvedValue({ ok: true, value: [healthEscalation] })
    const acknowledgeHealth = vi.fn().mockResolvedValue(remoteFailure('Stale escalation revision'))
    render(<TeamAction {...props(actions({ healthInbox, acknowledgeHealth }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.change(screen.getByRole('textbox', { name: zh['health.project'] }), { target: { value: 'project-health' } })
    fireEvent.click(within(screen.getByLabelText(zh['health.title'])).getByRole('button', { name: zh['health.refresh'], exact: true }))
    await screen.findByText('Pinned integration receipt failed.')
    fireEvent.click(screen.getByRole('button', { name: zh['health.acknowledge'] }))
    expect(await screen.findByText(zh['health.stale'])).toBeTruthy()
    await waitFor(() => { expect(healthInbox).toHaveBeenCalledTimes(2) })
  })

  it('ignores a stale Team load after the conversation switches sessions', async () => {
    const nextSession = 'next-lead' as SessionId
    const firstLoad = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const nextView: TeamView = {
      ...view,
      members: [{ id: nextSession, name: 'lead', role: 'lead', status: 'idle', diagnostics: [] }],
      tasks: [{ ...task, id: 'task-next' as TeamTaskId, subject: 'Next session task' }],
    }
    const load = vi.fn((sessionId: SessionId) => sessionId === SESSION
      ? firstLoad.promise
      : Promise.resolve({ ok: true as const, value: nextView }))
    const injected = actions({ load })
    const rendered = render(<TeamAction {...props(injected)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await waitFor(() => { expect(load).toHaveBeenCalledWith(SESSION) })

    rendered.rerender(<TeamAction {...props(injected, nextSession)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('Next session task')).toBeTruthy()
    firstLoad.resolve({ ok: true, value: view })
    await Promise.resolve()

    await waitFor(() => {
      expect(screen.getByText('Next session task')).toBeTruthy()
      expect(screen.queryByText('Implement runtime')).toBeNull()
    })
  })

  it('shows persisted batch progress and recovery attempts in the Team panel', async () => {
    const loaded: TeamView = {
      ...view,
      members: view.members.map(member => ({ ...member, recoveryAttempts: 2 })),
      batches: [{ id: 'batch-1' as TeamView['batches'][number]['id'], revision: 1, name: 'Delivery batch', description: 'Ship the change', taskIds: [task.id], archived: false, completedTasks: 0, status: 'active' }],
    }
    render(<TeamAction {...props(actions({ load: vi.fn().mockResolvedValue({ ok: true, value: loaded }) }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('Delivery batch')).toBeTruthy()
    expect(screen.getByText(`${zh['batch.active']} · 0/1`)).toBeTruthy()
    expect(screen.getAllByText(`${zh.recoveries}: 2`)).toHaveLength(view.members.length)
  })

  it('loads roster/task diagnostics on open and navigates a healthy teammate', async () => {
    const openTeammate = vi.fn(() => Promise.resolve())
    render(<TeamAction {...props(actions({ openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    const worker = await screen.findByRole('button', { name: /worker/u })
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    fireEvent.click(worker)
    await waitFor(() => { expect(openTeammate).toHaveBeenCalledWith(SESSION, view.members[1]) })
  })

  it('keeps only the newest overlapping refresh for one session', async () => {
    const older = Promise.withResolvers<TeamActionResult<TeamView>>()
    const newer = Promise.withResolvers<TeamActionResult<TeamView>>()
    const newestView = {
      ...view,
      tasks: [{ ...task, id: 'newest-task' as TeamTaskId, subject: 'Newest task' }],
    }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    render(<TeamAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    const refresh = screen.getByRole('button', { name: zh.refresh })
    fireEvent.click(refresh)
    fireEvent.click(refresh)
    newer.resolve({ ok: true, value: newestView })
    expect(await screen.findByText('Newest task')).toBeTruthy()
    older.resolve({ ok: true, value: view })
    await Promise.resolve()

    expect(screen.getByText('Newest task')).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

  it('keeps a successful task mutation newer than an in-flight refresh', async () => {
    const stale = Promise.withResolvers<TeamActionResult<TeamView>>()
    const completedView = { ...view, tasks: [{ ...task, revision: 2, status: 'completed' as const }] }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ ok: true, value: completedView })
    const updateTask = vi.fn(() => Promise.resolve(
      taskSuccess({ ...task, revision: 2, status: 'completed' }),
    ))
    render(<TeamAction {...props(actions({ load, updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    completeTask('Done')
    expect(await screen.findByRole('button', { name: /重开/u })).toBeTruthy()

    stale.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByRole('button', { name: /重开/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /完成/u })).toBeNull()
  })

  it('keeps a created task newer than an in-flight refresh', async () => {
    const stale = Promise.withResolvers<TeamActionResult<TeamView>>()
    const createdTask = { ...task, id: TASK_2, subject: 'New task' }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [...view.tasks, createdTask] } })
    render(<TeamAction {...props(actions({
      load,
      createTask: () => Promise.resolve(taskSuccess(createdTask)),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'New task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Details' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('New task')).toBeTruthy()

    stale.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByText('New task')).toBeTruthy()
  })

  it('keeps task and create failures newer than an in-flight refresh', async () => {
    const staleTask = Promise.withResolvers<TeamActionResult<TeamView>>()
    const taskLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => staleTask.promise)
    const first = render(<TeamAction {...props(actions({
      load: taskLoad,
      updateTask: () => Promise.resolve(taskRejected('task rejected')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    completeTask('Done')
    expect(await screen.findByText('task rejected (team-rejected)')).toBeTruthy()
    staleTask.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByText('task rejected (team-rejected)')).toBeTruthy()
    first.unmount()

    const staleCreate = Promise.withResolvers<TeamActionResult<TeamView>>()
    const createLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => staleCreate.promise)
    render(<TeamAction {...props(actions({
      load: createLoad,
      createTask: () => Promise.resolve(taskRejected('create rejected')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Rejected task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Rejected details' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('create rejected (team-rejected)')).toBeTruthy()
    staleCreate.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByText('create rejected (team-rejected)')).toBeTruthy()
  })

  it('tracks simultaneous create and task mutations independently', async () => {
    const create = Promise.withResolvers<TeamTaskActionResult>()
    const createdTask = { ...task, id: TASK_2, subject: 'Concurrent task' }
    const completedTask = { ...task, revision: 2, status: 'completed' as const }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [completedTask] } })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [completedTask, createdTask] } })
    const createTask = vi.fn(() => create.promise)
    render(<TeamAction {...props(actions({ load, createTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Concurrent task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Concurrent details' } })
    const save = screen.getByRole<HTMLButtonElement>('button', { name: '保存' })
    fireEvent.click(save)
    await waitFor(() => { expect(save.disabled).toBe(true) })

    const complete = screen.getByRole<HTMLButtonElement>('button', { name: /完成/u })
    expect(complete.disabled).toBe(false)
    completeTask('Done')
    expect(await screen.findByRole('button', { name: /重开/u })).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(createTask).toHaveBeenCalledTimes(1)

    create.resolve(taskSuccess(createdTask))
    expect(await screen.findByText('Concurrent task')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('reloads derived fields for every task after a mutation', async () => {
    const related = {
      ...task,
      id: TASK_2,
      subject: 'Related task',
      writeScopeWarnings: ['old warning'],
    }
    const completed = { ...task, revision: 2, status: 'completed' as const }
    const refreshed = {
      ...view,
      tasks: [completed, { ...related, writeScopeWarnings: ['derived warning refreshed'] }],
    }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [task, related] } })
      .mockResolvedValueOnce({ ok: true, value: refreshed })
    render(<TeamAction {...props(actions({
      load,
      updateTask: () => Promise.resolve(taskSuccess(completed)),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('old warning')
    completeTask('Done')

    expect(await screen.findByText('derived warning refreshed')).toBeTruthy()
    expect(screen.queryByText('old warning')).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('creates a task from normalized blocker and write-scope lists', async () => {
    const createTask = vi.fn(actions().createTask)
    render(<TeamAction {...props(actions({ createTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: ' New task ' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: ' Details ' } })
    fireEvent.change(screen.getByPlaceholderText(/依赖任务/u), { target: { value: 'task-1, task-1' } })
    fireEvent.change(screen.getByPlaceholderText(/写入范围/u), { target: { value: 'src/a, src/b' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(createTask).toHaveBeenCalledWith(SESSION, {
        subject: 'New task',
        description: 'Details',
        blockedBy: ['task-1'],
        writeScopes: ['src/a', 'src/b'],
      })
    })
  })

  it('assigns, edits, completes, reopens, and deletes with contiguous CAS revisions', async () => {
    let current = { ...task }
    const updateTask: TeamActionInjected['updateTask'] = vi.fn((
      _sessionId: SessionId,
      input: Parameters<TeamActionInjected['updateTask']>[1],
    ) => {
      const revision = current.revision + 1
      switch (input.action) {
        case 'reassign':
          current = {
            ...current,
            revision,
            status: 'in_progress',
            ownerName: input.owner ?? 'lead',
          }
          break
        case 'edit':
          current = {
            ...current,
            revision,
            subject: input.subject ?? current.subject,
            description: input.description ?? current.description,
            writeScopes: [...input.writeScopes ?? current.writeScopes],
          }
          break
        case 'set_dependencies':
          current = { ...current, revision, blockedBy: [...input.blockedBy ?? []] }
          break
        case 'complete':
          current = {
            ...current,
            revision,
            status: 'completed',
            ...input.result === undefined ? {} : { result: input.result },
          }
          break
        case 'reopen': {
          const { ownerName: _ownerName, result: _result, ...unowned } = current
          current = { ...unowned, revision, status: 'pending', ready: true }
          break
        }
        case 'delete':
          current = { ...current, revision, status: 'deleted' }
          break
        default:
          throw new Error(`unexpected action ${input.action}`)
      }
      return Promise.resolve(taskSuccess(current))
    })
    const load = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { ...view, tasks: current.status === 'deleted' ? [] : [current] },
    }))
    render(<TeamAction {...props(actions({ load, updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'worker' } })
    await waitFor(() => {
      expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('worker')
      expect(current).toMatchObject({ revision: 2, ownerName: 'worker' })
    })

    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Updated runtime' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Updated details' } })
    fireEvent.change(screen.getByPlaceholderText(/依赖任务/u), { target: { value: 'task-0' } })
    fireEvent.change(screen.getByPlaceholderText(/写入范围/u), { target: { value: 'src/runtime' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('Updated runtime')).toBeTruthy()
    expect(current).toMatchObject({
      revision: 4,
      description: 'Updated details',
      blockedBy: ['task-0'],
      writeScopes: ['src/runtime'],
    })

    completeTask('Changed runtime; focused tests passed.')
    expect(await screen.findByText(/Changed runtime; focused tests passed./u)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /重开/u }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /重开/u })).toBeNull()
      expect(current).toMatchObject({ revision: 6, status: 'pending' })
    })
    fireEvent.click(screen.getByRole('button', { name: /删除/u }))
    await waitFor(() => { expect(screen.queryByText('Updated runtime')).toBeNull() })

    expect(vi.mocked(updateTask).mock.calls.map(([, input]) => [input.action, input.expectedRevision]))
      .toEqual([
        ['reassign', 1],
        ['edit', 2],
        ['set_dependencies', 3],
        ['complete', 4],
        ['reopen', 5],
        ['delete', 6],
      ])
  })

  it('reloads and warns instead of retrying a stale task mutation', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValue({ ok: true, value: { ...view, tasks: [{ ...task, revision: 2 }] } })
    const updateTask = vi.fn(() => Promise.resolve(taskConflict('stale')))
    render(<TeamAction {...props(actions({ load, updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    completeTask('Done')
    expect(await screen.findByText(zh.conflict)).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
    expect(updateTask).toHaveBeenCalledTimes(1)
    const dialog = screen.getByRole('dialog', { name: zh.completionEvidence })
    expect(within(dialog).getByRole('textbox')).toHaveProperty('value', 'Done')
    fireEvent.click(within(dialog).getByRole('button', { name: zh.complete }))
    await waitFor(() => { expect(updateTask).toHaveBeenCalledTimes(2) })
    expect(updateTask).toHaveBeenLastCalledWith(SESSION, {
      taskId: TASK_1, expectedRevision: 2, action: 'complete', result: 'Done',
    })
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: zh.complete })).toHaveProperty('disabled', false)
    })
  })

  it('preserves a newer completion draft when an earlier completion settles', async () => {
    const pending = Promise.withResolvers<TeamTaskActionResult>()
    const tasks = [task, { ...task, id: TASK_2, subject: 'Second task' }]
    const load = () => Promise.resolve({ ok: true as const, value: { ...view, tasks } })
    render(<TeamAction {...props(actions({ load, updateTask: () => pending.promise }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    completeTask('First result')
    fireEvent.click(screen.getAllByRole('button', { name: /完成/u })[1]!)
    fireEvent.change(screen.getByRole('textbox', { name: zh.completionEvidence }), {
      target: { value: 'Second result' },
    })
    pending.resolve(taskSuccess({ ...task, revision: 2, status: 'completed', result: 'First result' }))
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /完成/u })[0]).toHaveProperty('disabled', false)
    })
    expect(screen.getByRole('textbox', { name: zh.completionEvidence })).toHaveProperty('value', 'Second result')
  })

  it('keeps reload failures visible after task and dependency conflicts', async () => {
    const taskLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce(remoteFailure('task reload failed'))
    const first = render(<TeamAction {...props(actions({
      load: taskLoad,
      updateTask: () => Promise.resolve(taskConflict('stale task')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    completeTask('Done')
    expect(await screen.findByText('task reload failed (gateway/internal)')).toBeTruthy()
    expect(screen.queryByText(zh.conflict)).toBeNull()
    first.unmount()

    const dependencyLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [{ ...task, revision: 2, subject: 'Edited' }] } })
      .mockResolvedValueOnce(remoteFailure('dependency reload failed'))
    const dependencyUpdate = vi.fn()
      .mockResolvedValueOnce(taskSuccess({ ...task, revision: 2, subject: 'Edited' }))
      .mockResolvedValueOnce(taskConflict('stale dependency'))
    render(<TeamAction {...props(actions({ load: dependencyLoad, updateTask: dependencyUpdate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Edited' } })
    fireEvent.change(screen.getByPlaceholderText(zh.blockers), { target: { value: 'task-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('dependency reload failed (gateway/internal)')).toBeTruthy()
    expect(screen.queryByText(zh.conflict)).toBeNull()
  })

  it('renders roster/task state variants and contains navigation, refresh, and close actions', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const richView: TeamView = {
      ...view,
      members: [
        view.members[0]!,
        { ...view.members[1]!, status: 'running' },
        {
          id: 'failed-id' as SessionId,
          name: 'failed-worker',
          role: 'teammate',
          status: 'failed',
          diagnostics: ['provider failed'],
        },
        {
          id: 'provisioning-id' as SessionId,
          name: 'provisioning-worker',
          role: 'teammate',
          status: 'provisioning',
          diagnostics: [],
        },
      ],
      tasks: [
        { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
        { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false },
        { ...task, id: 'completed-task' as TeamTaskId, status: 'completed' },
      ],
    }
    const load = vi.fn(() => Promise.resolve({ ok: true as const, value: richView }))
    const openTeammate = vi.fn(() => Promise.reject(new Error('navigation failed')))
    render(<TeamAction {...props(actions({ load, openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('provider failed')).toBeTruthy()
    expect(screen.getByText(zh.ready)).toBeTruthy()
    expect(screen.getByText(zh.blocked)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /failed-worker/u }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /provisioning-worker/u }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /^worker运行中/u }))
    expect(await screen.findByText('Error: navigation failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows load and create failures and ignores a create result after a session switch', async () => {
    const failedLoad = actions({
      load: () => Promise.resolve(remoteFailure('load failed')),
    })
    const first = render(<TeamAction {...props(failedLoad)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('load failed (gateway/internal)')).toBeTruthy()
    first.unmount()

    const createTask = vi.fn(() => Promise.resolve(remoteFailure('create failed')))
    const second = render(<TeamAction {...props(actions({ createTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Description' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('create failed (gateway/internal)')).toBeTruthy()
    second.unmount()

    const pending = Promise.withResolvers<TeamTaskActionResult>()
    const third = render(<TeamAction {...props(actions({ createTask: () => pending.promise }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Late task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Late description' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    third.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    pending.resolve(taskSuccess({ ...task, id: 'late-task' as TeamTaskId }))
    await Promise.resolve()
    expect(screen.queryByText('Late task')).toBeNull()
  })

  it('contains stale-session and ordinary task failures without retrying', async () => {
    const pending = Promise.withResolvers<TeamTaskActionResult>()
    const rendered = render(<TeamAction {...props(actions({ updateTask: () => pending.promise }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    completeTask('Done')
    rendered.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    pending.resolve(taskSuccess({ ...task, revision: 2, status: 'completed' }))
    await Promise.resolve()
    expect(screen.queryByText('Implement runtime')).toBeNull()
    rendered.unmount()

    render(<TeamAction {...props(actions({
      updateTask: () => Promise.resolve(taskRejected('update failed')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    completeTask('Done')
    expect(await screen.findByText('update failed (team-rejected)')).toBeTruthy()
  })

  it('does not publish a task conflict after its reload switches sessions', async () => {
    const reload = Promise.withResolvers<TeamActionResult<TeamView>>()
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => reload.promise)
    const rendered = render(<TeamAction {...props(actions({
      load,
      updateTask: () => Promise.resolve(taskConflict('stale task')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    completeTask('Done')
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })

    rendered.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    reload.resolve({ ok: true, value: view })
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText(zh.conflict)).toBeNull()
  })

  it('does not settle a successful task after its reload switches sessions', async () => {
    const reload = Promise.withResolvers<TeamActionResult<TeamView>>()
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => reload.promise)
    const rendered = render(<TeamAction {...props(actions({
      load,
      updateTask: () => Promise.resolve(taskSuccess({ ...task, revision: 2, status: 'completed' })),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    completeTask('Done')
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })

    rendered.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    reload.resolve({ ok: true, value: { ...view, tasks: [{ ...task, revision: 2, status: 'completed' }] } })
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

  it('contains edit and dependency failures and supports form cancellation and unassignment', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const updateTask = vi.fn()
      .mockResolvedValueOnce(remoteFailure('edit failed'))
      .mockResolvedValueOnce(taskSuccess({ ...task, revision: 2, subject: 'Saved edit' }))
      .mockResolvedValueOnce(taskRejected('dependency failed'))
      .mockResolvedValueOnce(taskSuccess({ ...unownedTask, revision: 2 }))
    render(<TeamAction {...props(actions({ updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByPlaceholderText('任务标题')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('edit failed (gateway/internal)')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Saved edit' } })
    fireEvent.change(screen.getByPlaceholderText(zh.blockers), { target: { value: 'task-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('dependency failed (team-rejected)')).toBeTruthy()
    expect(updateTask.mock.calls[2]?.[1]).toMatchObject({
      action: 'set_dependencies',
      expectedRevision: 2,
      blockedBy: ['task-2'],
    })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    await waitFor(() => {
      expect(updateTask).toHaveBeenLastCalledWith(SESSION, expect.objectContaining({
        action: 'reassign',
      }))
      expect(updateTask.mock.calls.at(-1)?.[1]).not.toHaveProperty('owner')
    })
  })

  it('shows a Remote carrier failure from the dependency mutation', async () => {
    const updateTask = vi.fn()
      .mockResolvedValueOnce(taskSuccess({ ...task, revision: 2, subject: 'Edited' }))
      .mockResolvedValueOnce(remoteFailure('dependency transport failed'))
    render(<TeamAction {...props(actions({ updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Edited' } })
    fireEvent.change(screen.getByPlaceholderText(zh.blockers), { target: { value: 'task-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('dependency transport failed (gateway/internal)')).toBeTruthy()
  })

  it('skips the dependency mutation when an edit keeps the same blockers', async () => {
    const blockedTask: TeamTask = { ...task, blockedBy: ['task-0' as TeamTaskId] }
    const updateTask = vi.fn().mockResolvedValue(
      taskSuccess({ ...blockedTask, revision: 2, subject: 'Same dependencies' }),
    )
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [blockedTask] } }),
      updateTask,
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Same dependencies' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => { expect(screen.queryByRole('button', { name: '保存' })).toBeNull() })
    expect(updateTask).toHaveBeenCalledTimes(1)
    expect(updateTask).toHaveBeenCalledWith(SESSION, expect.objectContaining({ action: 'edit' }))
  })

  it('reloads a dependency conflict and ignores dependency settlement after a session switch', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [{ ...task, revision: 2, subject: 'Conflict edit' }] } })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [{ ...task, revision: 3 }] } })
    const conflictUpdate = vi.fn()
      .mockResolvedValueOnce(taskSuccess({ ...task, revision: 2, subject: 'Conflict edit' }))
      .mockResolvedValueOnce(taskConflict('stale dependency'))
    const first = render(<TeamAction {...props(actions({ load, updateTask: conflictUpdate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Conflict edit' } })
    fireEvent.change(screen.getByPlaceholderText(zh.blockers), { target: { value: 'task-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(zh.conflict)).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(3)
    first.unmount()

    const dependencyReload = Promise.withResolvers<TeamActionResult<TeamView>>()
    const dependencyLoad = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [{ ...task, revision: 2, subject: 'Late edit' }] } })
      .mockImplementationOnce(() => dependencyReload.promise)
    const staleUpdate = vi.fn()
      .mockResolvedValueOnce(taskSuccess({ ...task, revision: 2, subject: 'Late edit' }))
      .mockResolvedValueOnce(taskConflict('stale dependency'))
    const second = render(<TeamAction {...props(actions({ load: dependencyLoad, updateTask: staleUpdate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Late edit' } })
    fireEvent.change(screen.getByPlaceholderText(zh.blockers), { target: { value: 'task-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(dependencyLoad).toHaveBeenCalledTimes(3) })
    second.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    dependencyReload.resolve({ ok: true, value: { ...view, tasks: [{ ...task, revision: 3 }] } })
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText(zh.conflict)).toBeNull()
    second.unmount()

    const dependency = Promise.withResolvers<TeamTaskActionResult>()
    const lateUpdate = vi.fn()
      .mockResolvedValueOnce(taskSuccess({ ...task, revision: 2, subject: 'Late edit' }))
      .mockImplementationOnce(() => dependency.promise)
    const third = render(<TeamAction {...props(actions({ updateTask: lateUpdate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: /编辑/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'Late edit' } })
    fireEvent.change(screen.getByPlaceholderText(zh.blockers), { target: { value: 'task-2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(lateUpdate).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
    third.rerender(<TeamAction {...props(actions(), 'next-session' as SessionId)} />)
    dependency.resolve(taskSuccess({ ...task, revision: 3, subject: 'Late dependency' }))
    await Promise.resolve()
    expect(screen.queryByText('Late dependency')).toBeNull()
  })
})
