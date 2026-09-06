import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDashboardPage, WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceDashboard } from '../src/client/WorkspaceDashboard.tsx'
import { en, zh } from '../src/client/locales.ts'

const view: WorkspaceDashboardView = {
  projects: [{ id: 'api', revision: 2, paused: false, capacity: 2, active: 1 }], projectsTruncated: false,
  attempts: [{ attemptId: 'attempt-api', generation: 1, revision: 3, projectId: 'api', teamId: 'lead-api', taskId: 'task-api', phase: 'active', progress: { classification: 'unavailable', certainty: 'uncertain', observedAt: 10 } }], attemptsTruncated: false,
  workflows: [{ executionId: 'workflow-api', projectId: 'api', teamId: 'lead-api', steps: [{ stepId: 'implement', revision: 1, phase: 'running', taskId: 'task-api' }], stepsTruncated: false }], workflowsTruncated: false,
  batches: [{ id: 'batch-api', phase: 'active', required: 2, completedRequired: 1, completionEpoch: 0 }], batchesTruncated: false,
  queue: [{ projectId: 'api', teamId: 'lead-api', taskId: 'task-api', revision: 2, state: 'waiting', blockers: [{ code: 'workspace-batch-dependency' }], blockersTruncated: false }], queueTruncated: false,
  integrations: [{ integrationId: 'integration-api', projectId: 'api', teamId: 'lead-api', phase: 'failed', sourceCommit: 'a'.repeat(40), failureKind: 'verification', diagnostic: 'Checks failed.' }], integrationsTruncated: false,
  escalations: [{ id: 'health-api', revision: 2, projectId: 'api', teamId: 'lead-api', taskId: 'task-api', attemptId: 'attempt-api', generation: 1, severity: 'warning', condition: 'stale', diagnostics: 'No progress.' }], escalationsTruncated: false,
}
const ok = (value: WorkspaceDashboardView) => Promise.resolve({ ok: true as const, value })
const english = (key: keyof typeof en) => en[key]
const chinese = (key: keyof typeof zh) => zh[key]
const SESSION_A = 'dashboard-a' as SessionId
const SESSION_B = 'dashboard-b' as SessionId

afterEach(() => { cleanup() })

describe('WorkspaceDashboard', () => {
  it('renders every read-only section and preserves uncertain health instead of showing zero usage', async () => {
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} t={english} />)
    expect(await screen.findByRole('heading', { name: en['dashboard.title'] })).toBeTruthy()
    expect(screen.getByText('Unavailable · Uncertain')).toBeTruthy()
    expect(screen.getAllByText('1/2')).toHaveLength(2)
    expect(screen.getByText('Verification failed')).toBeTruthy()
    expect(screen.getByText('Checks failed.')).toBeTruthy()
    for (const title of ['Projects', 'Attempts', 'Workflows', 'Cross-project batches', 'Dispatch queue', 'Integration queue', 'Health incidents']) expect(screen.getByRole('heading', { name: title })).toBeTruthy()
  })

  it('labels a missing health observation explicitly instead of inferring zero usage', async () => {
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok({ ...view, attempts: [{ ...view.attempts[0]!, progress: undefined }] })} t={english} />)
    expect(await screen.findByText(en['dashboard.progress.unobserved'])).toBeTruthy()
  })

  it('clears a stale selected project and attempt after a newer dashboard result', async () => {
    const first = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const load = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce({ ok: true, value: { ...view, projects: [], attempts: [] } })
    render(<WorkspaceDashboard sessionId={SESSION_A} load={load} t={chinese} />)
    first.resolve({ ok: true, value: view })
    await screen.findByText('attempt-api')
    fireEvent.click(screen.getAllByRole('button', { name: /^api/ })[0]!)
    fireEvent.click(screen.getByRole('button', { name: /attempt-api/ }))
    expect(screen.getByRole('button', { name: new RegExp(zh['dashboard.clearProject']) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['dashboard.refresh'] }))
    expect(await screen.findByText(zh['dashboard.stale'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(zh['dashboard.clearProject']) })).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(zh['dashboard.clearAttempt']) })).toBeNull()
  })

  it('exposes loading, Remote failure, and empty states without retaining a spinner', async () => {
    const pending = Promise.withResolvers<{ ok: false; error: { code: string; message: string } }>()
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => pending.promise} t={english} />)
    expect(screen.getByText(en['dashboard.loading'])).toBeTruthy()
    pending.resolve({ ok: false, error: { code: 'gateway/offline', message: 'offline' } })
    expect((await screen.findByRole('alert')).textContent).toBe('offline (gateway/offline)')
    expect(screen.queryByText(en['dashboard.loading'])).toBeNull()

    const empty = { projects: [], attempts: [], workflows: [], batches: [], queue: [], integrations: [], escalations: [], projectsTruncated: false, attemptsTruncated: false, workflowsTruncated: false, batchesTruncated: false, queueTruncated: false, integrationsTruncated: false, escalationsTruncated: false } satisfies WorkspaceDashboardView
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(empty)} t={english} />)
    expect(await screen.findByText(en['dashboard.empty'])).toBeTruthy()
  })

  it('clears prior workspace data for an unauthorized new operator and ignores A-to-B-to-A late responses', async () => {
    const firstA = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const deniedB = Promise.withResolvers<{ ok: false; error: { code: string; message: string } }>()
    const freshA = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const load = vi.fn()
      .mockImplementationOnce(() => firstA.promise)
      .mockImplementationOnce(() => deniedB.promise)
      .mockImplementationOnce(() => freshA.promise)
    const rendered = render(<WorkspaceDashboard sessionId={SESSION_A} load={load} t={english} />)
    firstA.resolve({ ok: true, value: view })
    await screen.findByText('attempt-api')

    rendered.rerender(<WorkspaceDashboard sessionId={SESSION_B} load={load} t={english} />)
    expect(screen.queryByText('attempt-api')).toBeNull()
    deniedB.resolve({ ok: false, error: { code: 'forbidden', message: 'operator only' } })
    expect((await screen.findByRole('alert')).textContent).toContain('operator only')

    rendered.rerender(<WorkspaceDashboard sessionId={SESSION_A} load={load} t={english} />)
    expect(screen.queryByText('attempt-api')).toBeNull()
    freshA.resolve({ ok: true, value: view })
    expect(await screen.findByText('attempt-api')).toBeTruthy()
  })

  it('ignores a late B response after the operator returns to A', async () => {
    const firstA = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const pendingB = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const freshA = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const load = vi.fn().mockImplementationOnce(() => firstA.promise).mockImplementationOnce(() => pendingB.promise).mockImplementationOnce(() => freshA.promise)
    const rendered = render(<WorkspaceDashboard sessionId={SESSION_A} load={load} t={english} />)
    firstA.resolve({ ok: true, value: view })
    await screen.findByText('attempt-api')
    rendered.rerender(<WorkspaceDashboard sessionId={SESSION_B} load={load} t={english} />)
    rendered.rerender(<WorkspaceDashboard sessionId={SESSION_A} load={load} t={english} />)
    pendingB.resolve({ ok: true, value: { ...view, projects: [{ ...view.projects[0]!, id: 'wrong-b' }], attempts: [] } })
    await Promise.resolve()
    expect(screen.queryByText('wrong-b')).toBeNull()
    freshA.resolve({ ok: true, value: view })
    expect(await screen.findByText('attempt-api')).toBeTruthy()
  })

  it('navigates retained pages and offers an explicit stale restart', async () => {
    const first: WorkspaceDashboardPage = { collection: 'projects', snapshotRevision: 'a'.repeat(64), items: [{ id: 'one', revision: 1, paused: false, capacity: 1, active: 0 }], nextCursor: 'next', truncated: true }
    const second: WorkspaceDashboardPage = { ...first, items: [{ id: 'two', revision: 2, paused: false, capacity: 1, active: 0 }], nextCursor: undefined }
    const loadPage = vi.fn().mockResolvedValueOnce({ ok: true, value: first }).mockResolvedValueOnce({ ok: true, value: second }).mockResolvedValueOnce({ ok: true, value: first }).mockResolvedValueOnce({ ok: false, error: { code: 'WORKSPACE_PAGE_STALE', message: 'restart' } }).mockResolvedValueOnce({ ok: true, value: first })
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} loadPage={loadPage} t={english} />)
    expect(await screen.findByText('one')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['dashboard.pageNext'] }))
    expect(await screen.findByText('two')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['dashboard.pagePrevious'] }))
    expect(await screen.findByText('one')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['dashboard.pageNext'] }))
    expect(await screen.findByText(/restart \(WORKSPACE_PAGE_STALE\)/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['dashboard.pageRestart'] }))
    expect(await screen.findByText('one')).toBeTruthy()
  })

  it('ignores a late paged B result after A-to-B-to-A and keeps native pager controls focusable', async () => {
    const pendingA = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardPage }>()
    const pendingB = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardPage }>()
    const freshA = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardPage }>()
    const page = (id: string): WorkspaceDashboardPage => ({ collection: 'projects', snapshotRevision: 'a'.repeat(64), items: [{ id, revision: 1, paused: false, capacity: 1, active: 0 }], nextCursor: 'next', truncated: false })
    const loadPage = vi.fn().mockImplementationOnce(() => pendingA.promise).mockImplementationOnce(() => pendingB.promise).mockImplementationOnce(() => freshA.promise)
    const rendered = render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} loadPage={loadPage} t={english} />)
    pendingA.resolve({ ok: true, value: page('first-a') }); expect(await screen.findByText('first-a')).toBeTruthy()
    const next = screen.getByRole('button', { name: en['dashboard.pageNext'] }); next.focus(); expect(document.activeElement).toBe(next)
    rendered.rerender(<WorkspaceDashboard sessionId={SESSION_B} load={() => ok(view)} loadPage={loadPage} t={english} />)
    rendered.rerender(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} loadPage={loadPage} t={english} />)
    pendingB.resolve({ ok: true, value: page('wrong-b') }); await Promise.resolve()
    expect(screen.queryByText('wrong-b')).toBeNull()
    freshA.resolve({ ok: true, value: page('fresh-a') }); expect(await screen.findByText('fresh-a')).toBeTruthy()
  })
})
