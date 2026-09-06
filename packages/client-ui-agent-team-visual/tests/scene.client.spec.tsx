// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { makeTranslate } from '../../../tests/support/translate.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { zh as commonZh } from '../../../tests/support/common-zh.ts'
import {
  VisualAgentsAction, type TeamVisualActionInjected, type TeamVisualActionProps, type TeamVisualActionResult,
} from '../src/client/VisualAgentsAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { window.localStorage.clear() })

const SESSION = 'lead' as SessionId

const dashboard: WorkspaceDashboardView = {
  projects: [{ id: 'project-a', revision: 1, paused: false, capacity: 2, active: 1 }],
  projectsTruncated: false,
  attempts: [{
    attemptId: 'attempt-1', generation: 1, revision: 1,
    projectId: 'project-a', teamId: 'lead', taskId: 'task-1', phase: 'active',
  }],
  attemptsTruncated: false,
  workflows: [], workflowsTruncated: false,
  batches: [], batchesTruncated: false,
  mergeBatches: [], mergeBatchesTruncated: false,
  queue: [], queueTruncated: false,
  integrations: [], integrationsTruncated: false,
  escalations: [], escalationsTruncated: false,
}

function remoteFailure(message: string): TeamVisualActionResult {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

function props(actions: TeamVisualActionInjected, sessionId: SessionId = SESSION): TeamVisualActionProps {
  return {
    sessionId,
    ...actions,
    t: makeTranslate(zh, commonZh),
  } as unknown as TeamVisualActionProps
}

function actions(overrides: Partial<TeamVisualActionInjected> = {}): TeamVisualActionInjected {
  return {
    load: () => Promise.resolve({ ok: true, value: dashboard }),
    ...overrides,
  }
}

describe('VisualAgentsAction', () => {
  it('renders the trigger and opens/closes the modal overlay', async () => {
    render(<VisualAgentsAction {...props(actions())} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    const dialog = await screen.findByRole('dialog', { name: zh.title })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists dashboard projects in the selector after loading', async () => {
    const load = vi.fn(() => Promise.resolve({ ok: true as const, value: dashboard }))
    render(<VisualAgentsAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    const selector = await screen.findByRole('combobox')
    expect(selector).toHaveProperty('value', 'project-a')
    expect(load).toHaveBeenCalledWith(SESSION)
  })

  it('switches between the disabled notice and the canvas via the per-project toggle', async () => {
    const { container } = render(<VisualAgentsAction {...props(actions())} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    await screen.findByRole('dialog', { name: zh.title })
    expect(await screen.findByText(zh['toggle.disabledNotice'])).toBeTruthy()
    expect(container.querySelector('canvas')).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: zh['toggle.off'], checked: false }))
    expect(screen.queryByText(zh['toggle.disabledNotice'])).toBeNull()
    expect(container.querySelector('canvas')).not.toBeNull()
    expect(screen.getByRole('switch', { name: zh['toggle.on'], checked: true })).toBeTruthy()

    fireEvent.click(screen.getByRole('switch', { name: zh['toggle.on'], checked: true }))
    expect(await screen.findByText(zh['toggle.disabledNotice'])).toBeTruthy()
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('repaints the animated agent scene without crashing when no 2D context exists', async () => {
    const { container, unmount } = render(<VisualAgentsAction {...props(actions())} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    await screen.findByRole('dialog', { name: zh.title })
    fireEvent.click(screen.getByRole('switch', { name: zh['toggle.off'], checked: false }))
    expect(container.querySelector('canvas')).not.toBeNull()
    // jsdom canvases have no 2D context; the RAF/setTimeout-fallback repaint
    // loop must be a safe no-op.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(container.querySelector('canvas')).not.toBeNull()
    expect(screen.getByRole('dialog', { name: zh.title })).toBeTruthy()
    // Unmount stops the repaint loop and poller; no stray work afterwards.
    unmount()
    await new Promise(resolve => setTimeout(resolve, 350))
  })

  it('clears a stale project selection and shows the dashboard.stale notice', async () => {
    let current = dashboard
    const load = vi.fn(() => Promise.resolve({ ok: true as const, value: current }))
    render(<VisualAgentsAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    expect(await screen.findByRole('combobox')).toHaveProperty('value', 'project-a')
    // The next refresh no longer lists the selected project → cleared + notice.
    current = {
      ...dashboard,
      projects: [{ id: 'project-b', revision: 1, paused: false, capacity: 2, active: 0 }],
      attempts: [],
    }
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect(await screen.findByText(zh['dashboard.stale'])).toBeTruthy()
    expect(screen.getByRole('combobox')).toHaveProperty('value', '')
  })

  it('shows a Remote carrier failure unchanged', async () => {
    const load = vi.fn(() => Promise.resolve(remoteFailure('offline')))
    render(<VisualAgentsAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    expect(await screen.findByText('offline (gateway/internal)')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('shows the empty notice when the workspace has no projects', async () => {
    const load = () => Promise.resolve({
      ok: true as const,
      value: { ...dashboard, projects: [], attempts: [] },
    })
    render(<VisualAgentsAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: zh.trigger }))
    expect(await screen.findByText(zh.empty)).toBeTruthy()
  })
})
