import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OperatorEscalation, SchedulingView, WorkspaceActivityPage, WorkspaceDashboardPage, WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceDashboard } from '../src/client/WorkspaceDashboard.tsx'
import { en, zh } from '../src/client/locales.ts'

const view: WorkspaceDashboardView = {
  projects: [{ id: 'api', revision: 2, paused: false, capacity: 2, active: 1 }], projectsTruncated: false,
  attempts: [{ attemptId: 'attempt-api', generation: 1, revision: 3, projectId: 'api', teamId: 'lead-api', taskId: 'task-api', phase: 'active', provider: 'spawn', handoffEligible: true, progress: { classification: 'unavailable', certainty: 'uncertain', observedAt: 10 } }], attemptsTruncated: false,
  workflows: [{ executionId: 'workflow-api', projectId: 'api', teamId: 'lead-api', steps: [{ stepId: 'implement', revision: 1, phase: 'running', taskId: 'task-api' }], stepsTruncated: false }], workflowsTruncated: false,
  batches: [{ id: 'batch-api', phase: 'active', required: 2, completedRequired: 1, completionEpoch: 0 }], batchesTruncated: false,
  mergeBatches: [{ id: 'merge-api', phase: 'active', members: [{ integrationId: 'integration-api', projectId: 'api', teamId: 'lead-api', taskId: 'task-api' }] }], mergeBatchesTruncated: false,
  queue: [{ projectId: 'api', teamId: 'lead-api', taskId: 'task-api', revision: 2, state: 'waiting', blockers: [{ code: 'workspace-batch-dependency' }], blockersTruncated: false }], queueTruncated: false,
  integrations: [{ integrationId: 'integration-api', projectId: 'api', teamId: 'lead-api', phase: 'failed', sourceCommit: 'a'.repeat(40), failureKind: 'verification', diagnostic: 'Checks failed.' }], integrationsTruncated: false,
  escalations: [{ id: 'health-api', revision: 2, projectId: 'api', teamId: 'lead-api', taskId: 'task-api', attemptId: 'attempt-api', generation: 1, severity: 'warning', condition: 'stale', diagnostics: 'No progress.' }], escalationsTruncated: false,
}
const ok = (value: WorkspaceDashboardView) => Promise.resolve({ ok: true as const, value })
const english = (key: keyof typeof en) => en[key]
const chinese = (key: keyof typeof zh) => zh[key]
const SESSION_A = 'dashboard-a' as SessionId
const SESSION_B = 'dashboard-b' as SessionId
const schedule: SchedulingView = { projectId: 'api', paused: false, controlRevision: 2, requests: [{ projectId: 'api', teamId: 'lead-api', taskId: 'task-api', order: 1, priority: 0, revision: 3, state: 'assigned', blockers: [], attemptId: 'attempt-api' }] }
const escalation: OperatorEscalation = { id: 'health-api', revision: 2, attemptId: 'attempt-api', generation: 1, severity: 'warning', condition: 'stale', source: 'health', diagnostics: 'No progress.', cooldownUntil: 1, work: { projectId: 'api', teamId: 'lead-api', taskId: 'task-api', state: 'active' } }

afterEach(() => { cleanup() })

describe('WorkspaceDashboard', () => {
  it('renders every read-only section and preserves uncertain health instead of showing zero usage', async () => {
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} t={english} />)
    expect(await screen.findByRole('heading', { name: en['dashboard.title'] })).toBeTruthy()
    expect(screen.getByText('Unavailable · Uncertain')).toBeTruthy()
    expect(screen.getAllByText('1/2')).toHaveLength(2)
    expect(screen.getByText('Verification failed')).toBeTruthy()
    expect(screen.getByText('Checks failed.')).toBeTruthy()
    for (const title of ['Projects', 'Attempts', 'Workflows', 'Cross-project batches', 'Merge batches', 'Dispatch queue', 'Integration queue', 'Health incidents']) expect(screen.getByRole('heading', { name: title })).toBeTruthy()
  })

  it('shows durable queue age and last progress age while retaining unknown legacy values', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    try {
      const timed = { ...view, attempts: [{ ...view.attempts[0]!, progress: { classification: 'progressing' as const, certainty: 'known' as const, observedAt: 4_000, lastProgressAt: 3_000 } }], queue: [{ ...view.queue[0]!, enqueuedAt: 1_000 }] }
      render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(timed)} t={english} />)
      expect(await screen.findByText('Queue age: 4s')).toBeTruthy()
      expect(screen.getByText('Last progress: 2s')).toBeTruthy()
      cleanup()
      render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} t={english} />)
      expect(await screen.findByText('Queue age: Unknown')).toBeTruthy()
      expect(screen.getByText('Last progress: Unknown')).toBeTruthy()
    } finally { now.mockRestore() }
  })

  it('renders bounded journal references with truthful unknown time and removes duplicate refs', async () => {
    const activity: WorkspaceActivityPage = { items: [
      { ref: { workspaceId: 'workspace', source: 'coordinator', sequence: 1 }, type: 'coordinator/created' },
      { ref: { workspaceId: 'workspace', source: 'coordinator', sequence: 1 }, type: 'coordinator/created' },
    ], nextCursor: 'cursor', historyTruncated: false, ordering: 'per-source-sequence' }
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} loadActivity={() => Promise.resolve({ ok: true, value: activity })} t={english} />)
    expect(await screen.findByRole('heading', { name: en['dashboard.activity'] })).toBeTruthy()
    expect(screen.getAllByText('coordinator/created')).toHaveLength(1)
    expect(screen.getByText(en['dashboard.activityTimeUnknown'])).toBeTruthy()
  })

  it('offers a native restart after a stale activity cursor and resumes from a fresh page', async () => {
    const fresh: WorkspaceActivityPage = { items: [{ ref: { workspaceId: 'workspace', source: 'projects', sequence: 2 }, type: 'project/created', projectId: 'api', taskId: 'task-api' }], nextCursor: 'fresh', historyTruncated: false, ordering: 'per-source-sequence' }
    const loadActivity = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'WORKSPACE_ACTIVITY_STALE', message: 'restart' } }).mockResolvedValueOnce({ ok: true, value: fresh })
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} loadActivity={loadActivity} t={english} />)
    const restart = await screen.findByRole('button', { name: en['dashboard.activityRestart'] })
    restart.focus(); expect(document.activeElement).toBe(restart)
    fireEvent.click(restart)
    expect(await screen.findByText('project/created')).toBeTruthy()
    expect(screen.getAllByText('api/task-api').length).toBeGreaterThan(0)
    expect(loadActivity).toHaveBeenLastCalledWith(SESSION_A, { limit: 32 })
  })

  it('uses selected revisions for pause, safe cancellation, handoff reassignment, and acknowledgement', async () => {
    const control = vi.fn().mockResolvedValue({ ok: true, value: schedule })
    const acknowledge = vi.fn().mockResolvedValue({ ok: true, value: { ...escalation, revision: 3, acknowledgement: { actor: 'lead-api', at: 1 } } })
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} loadScheduling={() => Promise.resolve({ ok: true, value: schedule })} controlScheduling={control} loadHealth={() => Promise.resolve({ ok: true, value: [escalation] })} acknowledgeHealth={acknowledge} t={english} />)
    await screen.findByText('attempt-api')
    fireEvent.click(screen.getAllByRole('button', { name: /api/ })[0]!)
    expect(await screen.findByRole('button', { name: en['dashboard.pause'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['dashboard.pause'] }))
    await vi.waitFor(() => expect(control).toHaveBeenLastCalledWith(SESSION_A, { action: 'pause', projectId: 'api', expectedRevision: 2, paused: true }))
    await vi.waitFor(() => expect((screen.getByRole('button', { name: en['dashboard.pause'] }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /attempt-api/ }))
    const reason = await screen.findByLabelText(en['dashboard.cancelReason'])
    fireEvent.change(reason, { target: { value: 'operator request' } })
    fireEvent.click(screen.getByRole('button', { name: en['dashboard.cancel'] }))
    await vi.waitFor(() => expect(control).toHaveBeenLastCalledWith(SESSION_A, { action: 'cancel', projectId: 'api', taskId: 'task-api', expectedRevision: 3, reason: 'operator request', attemptId: 'attempt-api', generation: 1, expectedAttemptRevision: 3 }))
    await vi.waitFor(() => expect((screen.getByRole('button', { name: en['dashboard.reassignHandoff'] }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: en['dashboard.reassignHandoff'] }))
    await vi.waitFor(() => expect(control).toHaveBeenLastCalledWith(SESSION_A, { action: 'handoff', projectId: 'api', taskId: 'task-api', expectedRevision: 3, attemptId: 'attempt-api', generation: 1, expectedAttemptRevision: 3 }))
    await vi.waitFor(() => expect((screen.getByRole('button', { name: en['dashboard.acknowledge'] }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: en['dashboard.acknowledge'] }))
    await vi.waitFor(() => expect(acknowledge).toHaveBeenLastCalledWith(SESSION_A, 'api', 'health-api', 2))
  })

  it('sends the exact selected terminal provisioning token and explains a paced retry', async () => {
    const control = vi.fn().mockResolvedValue({ ok: true, value: schedule })
    const retryView = { ...view, attempts: [{ ...view.attempts[0]!, phase: 'terminal' as const, retryEligible: true, handoffEligible: false }] }
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(retryView)} loadScheduling={() => Promise.resolve({ ok: true, value: schedule })} controlScheduling={control} loadHealth={() => Promise.resolve({ ok: true, value: [] })} acknowledgeHealth={() => Promise.resolve({ ok: true, value: escalation })} t={english} />)
    await screen.findByText('attempt-api')
    fireEvent.click(screen.getAllByRole('button', { name: /api/ })[0]!)
    fireEvent.click(screen.getByRole('button', { name: /attempt-api/ }))
    fireEvent.click(await screen.findByRole('button', { name: en['dashboard.retry'] }))
    await vi.waitFor(() => expect(control).toHaveBeenLastCalledWith(SESSION_A, { action: 'retry', projectId: 'api', taskId: 'task-api', expectedRevision: 3, attemptId: 'attempt-api', generation: 1, expectedAttemptRevision: 3 }))
    const paced = { ...retryView, attempts: [{ ...retryView.attempts[0]!, retryEligible: false, retryReason: 'not-due' as const, retryAt: 99 }] }
    cleanup()
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(paced)} loadScheduling={() => Promise.resolve({ ok: true, value: schedule })} controlScheduling={control} loadHealth={() => Promise.resolve({ ok: true, value: [] })} acknowledgeHealth={() => Promise.resolve({ ok: true, value: escalation })} t={english} />)
    await screen.findByText('attempt-api')
    fireEvent.click(screen.getAllByRole('button', { name: /api/ })[0]!)
    fireEvent.click(screen.getByRole('button', { name: /attempt-api/ }))
    const retry = await screen.findByRole('button', { name: en['dashboard.retry'] }) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    expect(retry.title).toBe(en['dashboard.retry.not-due'])
  })

  it('treats a stale selected-project operation as recoverable and reloads its control state', async () => {
    const loadScheduling = vi.fn().mockResolvedValue({ ok: true, value: schedule })
    const control = vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/internal', message: 'stale revision' } })
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(view)} loadScheduling={loadScheduling} controlScheduling={control} loadHealth={() => Promise.resolve({ ok: true, value: [] })} acknowledgeHealth={() => Promise.resolve({ ok: true, value: escalation })} t={english} />)
    await screen.findByText('attempt-api')
    fireEvent.click(screen.getAllByRole('button', { name: /api/ })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en['dashboard.pause'] }))
    expect(await screen.findByText(en['dashboard.operationStale'])).toBeTruthy()
    await vi.waitFor(() => expect(loadScheduling.mock.calls.length).toBeGreaterThan(1))
  })

  it('never offers cancellation or handoff for a same-task attempt from another team or an older generation', async () => {
    const other = { ...view.attempts[0]!, attemptId: 'attempt-other', generation: 2, teamId: 'other-team', phase: 'active' as const }
    const old = { ...view.attempts[0]!, attemptId: 'attempt-old', generation: 1, phase: 'terminal' as const }
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok({ ...view, attempts: [view.attempts[0]!, other, old] })} loadScheduling={() => Promise.resolve({ ok: true, value: schedule })} controlScheduling={() => Promise.resolve({ ok: true, value: schedule })} loadHealth={() => Promise.resolve({ ok: true, value: [] })} acknowledgeHealth={() => Promise.resolve({ ok: true, value: escalation })} t={english} />)
    await screen.findByText('attempt-other')
    fireEvent.click(screen.getAllByRole('button', { name: /api/ })[0]!)
    fireEvent.click(screen.getByRole('button', { name: /attempt-other/ }))
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: en['dashboard.cancel'] })).toBeNull())
    expect(screen.queryByRole('button', { name: en['dashboard.reassignHandoff'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /attempt-old/ }))
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: en['dashboard.cancel'] })).toBeNull())
  })

  it('clears an old operation loading state when the selected attempt changes', async () => {
    const pending = Promise.withResolvers<{ ok: true; value: SchedulingView }>()
    const control = vi.fn().mockReturnValueOnce(pending.promise)
    const other = { ...view.attempts[0]!, attemptId: 'attempt-other', teamId: 'other-team' }
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok({ ...view, attempts: [view.attempts[0]!, other] })} loadScheduling={() => Promise.resolve({ ok: true, value: schedule })} controlScheduling={control} loadHealth={() => Promise.resolve({ ok: true, value: [] })} acknowledgeHealth={() => Promise.resolve({ ok: true, value: escalation })} t={english} />)
    await screen.findByText('attempt-other')
    fireEvent.click(screen.getAllByRole('button', { name: /api/ })[0]!)
    fireEvent.click(await screen.findByRole('button', { name: en['dashboard.pause'] }))
    fireEvent.click(screen.getByRole('button', { name: /attempt-other/ }))
    await vi.waitFor(() => expect((screen.getByRole('button', { name: en['dashboard.pause'] }) as HTMLButtonElement).disabled).toBe(false))
    pending.resolve({ ok: true, value: schedule })
    await Promise.resolve()
    expect(screen.queryByText(en['dashboard.operationApplied'])).toBeNull()
  })

  it('keeps unsupported or budget-blocked handoff visibly disabled with the host explanation', async () => {
    const blocked = { ...view, attempts: [{ ...view.attempts[0]!, provider: 'external' as const, handoffEligible: false, handoffReason: 'external-provider' as const }] }
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(blocked)} loadScheduling={() => Promise.resolve({ ok: true, value: schedule })} controlScheduling={() => Promise.resolve({ ok: true, value: schedule })} loadHealth={() => Promise.resolve({ ok: true, value: [] })} acknowledgeHealth={() => Promise.resolve({ ok: true, value: escalation })} t={english} />)
    await screen.findByText('attempt-api')
    fireEvent.click(screen.getAllByRole('button', { name: /api/ })[0]!)
    fireEvent.click(screen.getByRole('button', { name: /attempt-api/ }))
    const handoff = await screen.findByRole('button', { name: en['dashboard.reassignHandoff'] }) as HTMLButtonElement
    expect(handoff.disabled).toBe(true)
    expect(handoff.title).toBe(en['dashboard.handoff.external-provider'])
  })

  it('labels a missing health observation explicitly instead of inferring zero usage', async () => {
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok({ ...view, attempts: [{ ...view.attempts[0]!, progress: undefined }] })} t={english} />)
    expect(await screen.findByText(en['dashboard.progress.unobserved'])).toBeTruthy()
  })

  it('renders provider-reported usage without estimating cost, including exact zero counts', async () => {
    const reported: WorkspaceDashboardView = { ...view, attempts: [{ ...view.attempts[0]!, externalUsage: { provider: 'external', attemptId: 'attempt-api', generation: 1, runtimeRevision: 9, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } }] }
    const page: WorkspaceDashboardPage = { collection: 'attempts', snapshotRevision: 'a'.repeat(64), items: reported.attempts, truncated: false }
    const projects: WorkspaceDashboardPage = { collection: 'projects', snapshotRevision: 'a'.repeat(64), items: reported.projects, truncated: false }
    const loadPage = vi.fn().mockResolvedValueOnce({ ok: true, value: projects }).mockResolvedValueOnce({ ok: true, value: page })
    render(<WorkspaceDashboard sessionId={SESSION_A} load={() => ok(reported)} loadPage={loadPage} t={english} />)
    await screen.findByText('attempt-api')
    fireEvent.change(screen.getByLabelText(en['dashboard.pageCollection']), { target: { value: 'attempts' } })
    await vi.waitFor(() => expect(screen.getAllByText('Input: 0')).toHaveLength(2))
    expect(screen.getAllByText('Cached input: 0')).toHaveLength(2)
    expect(screen.getAllByText('Output: 0')).toHaveLength(2)
    expect(screen.getAllByText('Reasoning output: 0')).toHaveLength(2)
    expect(screen.getAllByText('Cost unknown')).toHaveLength(2)
    expect(screen.queryByText(/estimated/i)).toBeNull()
  })

  it('labels absent provider usage as unknown and never lets a late B usage receipt leak into A', async () => {
    const firstA = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const pendingB = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const freshA = Promise.withResolvers<{ ok: true; value: WorkspaceDashboardView }>()
    const load = vi.fn().mockImplementationOnce(() => firstA.promise).mockImplementationOnce(() => pendingB.promise).mockImplementationOnce(() => freshA.promise)
    const rendered = render(<WorkspaceDashboard sessionId={SESSION_A} load={load} t={english} />)
    firstA.resolve({ ok: true, value: view })
    expect(await screen.findByText(/Usage unknown/)).toBeTruthy()
    rendered.rerender(<WorkspaceDashboard sessionId={SESSION_B} load={load} t={english} />)
    rendered.rerender(<WorkspaceDashboard sessionId={SESSION_A} load={load} t={english} />)
    pendingB.resolve({ ok: true, value: { ...view, attempts: [{ ...view.attempts[0]!, externalUsage: { provider: 'external', attemptId: 'attempt-api', generation: 1, runtimeRevision: 11, inputTokens: 444 } }] } })
    await Promise.resolve()
    expect(screen.queryByText('Input: 444')).toBeNull()
    freshA.resolve({ ok: true, value: view })
    expect(await screen.findByText(/Usage unknown/)).toBeTruthy()
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

    const empty = { projects: [], attempts: [], workflows: [], batches: [], queue: [], integrations: [], escalations: [], projectsTruncated: false, attemptsTruncated: false, workflowsTruncated: false, batchesTruncated: false, mergeBatches: [], mergeBatchesTruncated: false, queueTruncated: false, integrationsTruncated: false, escalationsTruncated: false } satisfies WorkspaceDashboardView
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
