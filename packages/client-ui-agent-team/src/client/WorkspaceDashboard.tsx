/** Read-only workspace dashboard. Remote mounting and authority wiring are intentionally separate. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OperatorEscalation, SchedulingControl, SchedulingView, WorkspaceActivityPage, WorkspaceActivityRequest, WorkspaceDashboardCollection, WorkspaceDashboardPage, WorkspaceDashboardPageRequest, WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TeamKey } from './locales.ts'
import { AutofixerSettings } from './AutofixerSettings.tsx'
import type { AutofixerConfig } from './autofixer-settings.ts'
import css from './WorkspaceDashboard.module.css'

export interface WorkspaceDashboardProps {
  readonly sessionId: SessionId
  readonly load: (sessionId: SessionId) => Promise<RemoteResult<WorkspaceDashboardView>>
  readonly loadPage?: (sessionId: SessionId, request: WorkspaceDashboardPageRequest) => Promise<RemoteResult<WorkspaceDashboardPage>>
  readonly loadActivity?: (sessionId: SessionId, request: WorkspaceActivityRequest) => Promise<RemoteResult<WorkspaceActivityPage>>
  readonly loadScheduling?: (sessionId: SessionId, projectId: string) => Promise<RemoteResult<SchedulingView>>
  readonly controlScheduling?: (sessionId: SessionId, request: SchedulingControl) => Promise<RemoteResult<SchedulingView>>
  readonly loadHealth?: (sessionId: SessionId, projectId: string) => Promise<RemoteResult<OperatorEscalation[]>>
  readonly acknowledgeHealth?: (sessionId: SessionId, projectId: string, escalationId: string, expectedRevision: number) => Promise<RemoteResult<OperatorEscalation>>
  readonly initialAutofixerConfig?: Partial<AutofixerConfig>
  readonly onSaveAutofixerConfig?: (config: AutofixerConfig) => void | Promise<void>
  readonly t: (key: TeamKey) => string
}

function errorText(error: { readonly code: string; readonly message: string }): string {
  return `${error.message} (${error.code})`
}

function Truncation({ value, t }: { readonly value: boolean; readonly t: WorkspaceDashboardProps['t'] }) {
  return value ? <span className={css.truncated}>{t('dashboard.truncated')}</span> : null
}
function stateLabel(t: WorkspaceDashboardProps['t'], prefix: 'attempt' | 'workflow' | 'batch' | 'queue' | 'integration', value: string): string {
  return t(`dashboard.${prefix}.${value}` as TeamKey)
}
function Age({ at, label, unknown, t }: { readonly at: number | undefined; readonly label: TeamKey; readonly unknown: TeamKey; readonly t: WorkspaceDashboardProps['t'] }) {
  if (at === undefined) return <span>{t(label)}: {t(unknown)}</span>
  return <span>{t(label)}: {Math.floor(Math.max(0, Date.now() - at) / 1_000)}s</span>
}

function Usage({ usage, t }: { readonly usage: WorkspaceDashboardView['attempts'][number]['externalUsage']; readonly t: WorkspaceDashboardProps['t'] }) {
  if (usage === undefined) return <span>{t('dashboard.usage.unknown')} · {t('dashboard.usage.costUnknown')}</span>
  const counts: [TeamKey, number | undefined][] = [
    ['dashboard.usage.input', usage.inputTokens], ['dashboard.usage.cachedInput', usage.cachedInputTokens],
    ['dashboard.usage.output', usage.outputTokens], ['dashboard.usage.reasoningOutput', usage.reasoningOutputTokens],
  ]
  return <>{counts.filter(([, value]) => value !== undefined).map(([label, value]) => <span key={label}>{t(label)}: {value}</span>)}<span>{t('dashboard.usage.costUnknown')}</span></>
}

/**
 * Presents only the browser-safe workspace projection. Its `load` capability is
 * supplied later by an operator-authorized Remote binding.
 */
export function WorkspaceDashboard({ sessionId, load, loadPage, loadActivity, loadScheduling, controlScheduling, loadHealth, acknowledgeHealth, initialAutofixerConfig, onSaveAutofixerConfig, t }: WorkspaceDashboardProps) {
  const [view, setView] = useState<WorkspaceDashboardView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const generation = useRef(0)
  const pageGeneration = useRef(0)
  const [collection, setCollection] = useState<WorkspaceDashboardCollection>('projects')
  const [page, setPage] = useState<WorkspaceDashboardPage | null>(null)
  const [pageCursor, setPageCursor] = useState<string | undefined>(undefined)
  const [pageHistory, setPageHistory] = useState<(string | undefined)[]>([])
  const [pageLoading, setPageLoading] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [activity, setActivity] = useState<WorkspaceActivityPage['items']>([])
  const [activityError, setActivityError] = useState<string | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityGap, setActivityGap] = useState(false)
  const [activityStale, setActivityStale] = useState(false)
  const [activityEpoch, setActivityEpoch] = useState(0)
  const [scheduling, setScheduling] = useState<SchedulingView | null>(null)
  const [healthInbox, setHealthInbox] = useState<OperatorEscalation[]>([])
  const [operationLoading, setOperationLoading] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [operationNotice, setOperationNotice] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const activityCursor = useRef<string | undefined>(undefined)
  const activityGeneration = useRef(0)
  const operationGeneration = useRef(0)
  const selectionEpoch = useRef(0)
  const sessionRef = useRef(sessionId)
  const projectRef = useRef(projectId)
  const attemptRef = useRef(attemptId)
  projectRef.current = projectId
  attemptRef.current = attemptId
  sessionRef.current = sessionId

  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    const requestedSession = sessionId
    setLoading(true)
    try {
      const result = await load(requestedSession)
      if (generation.current !== current || sessionRef.current !== requestedSession) return
      if (!result.ok) {
        setError(errorText(result.error))
        return
      }
      const next = result.value
      const projectPresent = projectRef.current === null || next.projectsTruncated || next.projects.some(project => project.id === projectRef.current)
      const attemptPresent = attemptRef.current === null || next.attemptsTruncated || next.attempts.some(attempt => attempt.attemptId === attemptRef.current)
      if (!projectPresent || !attemptPresent) {
        setProjectId(projectPresent ? projectRef.current : null)
        setAttemptId(attemptPresent ? attemptRef.current : null)
        setNotice(t('dashboard.stale'))
      } else setNotice(null)
      setView(next)
      setError(null)
    } catch (reason) {
      if (generation.current === current && sessionRef.current === requestedSession) setError(String(reason))
    } finally {
      if (generation.current === current && sessionRef.current === requestedSession) setLoading(false)
    }
  }, [load, sessionId, t])

  useEffect(() => {
    generation.current += 1
    setView(null)
    setError(null)
    setNotice(null)
    setProjectId(null)
    setAttemptId(null)
    setLoading(true)
    pageGeneration.current += 1; setPage(null); setPageCursor(undefined); setPageHistory([]); setPageError(null); setPageLoading(false)
    activityGeneration.current += 1; activityCursor.current = undefined; setActivity([]); setActivityError(null); setActivityLoading(false); setActivityGap(false); setActivityStale(false); setActivityEpoch(0)
    operationGeneration.current += 1; setScheduling(null); setHealthInbox([]); setOperationLoading(false); setOperationError(null); setOperationNotice(null); setCancelReason('')
    void refresh()
    return () => { generation.current += 1 }
  }, [sessionId, refresh])

  const fetchPage = useCallback(async (cursor: string | undefined, history: (string | undefined)[]): Promise<void> => {
    if (loadPage === undefined) return
    const current = ++pageGeneration.current; const requestedSession = sessionId
    setPageLoading(true)
    try {
      const result = await loadPage(requestedSession, { collection, pageSize: 64, ...(cursor === undefined ? {} : { cursor }) })
      if (pageGeneration.current !== current || sessionRef.current !== requestedSession) return
      if (!result.ok) { setPageError(errorText(result.error)); return }
      setPage(result.value); setPageCursor(cursor); setPageHistory(history); setPageError(null)
    } catch (reason) { if (pageGeneration.current === current && sessionRef.current === requestedSession) setPageError(String(reason)) }
    finally { if (pageGeneration.current === current && sessionRef.current === requestedSession) setPageLoading(false) }
  }, [collection, loadPage, sessionId])

  useEffect(() => { if (loadPage !== undefined) void fetchPage(undefined, []) }, [collection, loadPage, fetchPage])

  useEffect(() => {
    if (loadActivity === undefined) return
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const current = ++activityGeneration.current; const requestedSession = sessionId; const cursor = activityCursor.current
      let retry = true
      setActivityLoading(true)
      try {
        const result = await loadActivity(requestedSession, { limit: 32, ...(cursor === undefined ? {} : { cursor }) })
        if (disposed || activityGeneration.current !== current || sessionRef.current !== requestedSession) return
        if (!result.ok) {
          const stale = /WORKSPACE_ACTIVITY_STALE/.test(`${result.error.code} ${result.error.message}`)
          setActivityError(errorText(result.error)); setActivityStale(stale); if (stale) retry = false
          return
        }
        activityCursor.current = result.value.nextCursor
        setActivityGap(previous => previous || result.value.historyTruncated)
        setActivity(previous => {
          const seen = new Set(previous.map(item => `${item.ref.workspaceId}/${item.ref.source}/${item.ref.sequence}`))
          const appended = result.value.items.filter(item => { const ref = `${item.ref.workspaceId}/${item.ref.source}/${item.ref.sequence}`; if (seen.has(ref)) return false; seen.add(ref); return true })
          return [...previous, ...appended].slice(-128)
        })
        setActivityError(null); setActivityStale(false)
      } catch (reason) { if (!disposed && activityGeneration.current === current && sessionRef.current === requestedSession) setActivityError(String(reason)) }
      finally {
        if (disposed || activityGeneration.current !== current || sessionRef.current !== requestedSession) return
        setActivityLoading(false)
        if (retry) timer = setTimeout(() => { void poll() }, 10_000)
      }
    }
    void poll()
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); activityGeneration.current += 1 }
  }, [loadActivity, sessionId, activityEpoch])

  const restartActivity = useCallback((): void => {
    activityGeneration.current += 1; activityCursor.current = undefined; setActivity([]); setActivityError(null); setActivityGap(false); setActivityStale(false); setActivityEpoch(value => value + 1)
  }, [])

  useEffect(() => {
    selectionEpoch.current += 1; operationGeneration.current += 1; setOperationLoading(false); setOperationError(null); setOperationNotice(null)
  }, [projectId, attemptId])

  const refreshOperations = useCallback(async (requestedProject: string): Promise<void> => {
    if (loadScheduling === undefined || loadHealth === undefined) return
    const current = ++operationGeneration.current; const requestedSession = sessionId
    setOperationLoading(true)
    try {
      const [scheduleResult, healthResult] = await Promise.all([loadScheduling(requestedSession, requestedProject), loadHealth(requestedSession, requestedProject)])
      if (operationGeneration.current !== current || sessionRef.current !== requestedSession || projectRef.current !== requestedProject) return
      if (!scheduleResult.ok) { setOperationError(errorText(scheduleResult.error)); return }
      if (!healthResult.ok) { setOperationError(errorText(healthResult.error)); return }
      setScheduling(scheduleResult.value); setHealthInbox(healthResult.value); setOperationError(null)
    } catch (reason) { if (operationGeneration.current === current && sessionRef.current === requestedSession && projectRef.current === requestedProject) setOperationError(String(reason)) }
    finally { if (operationGeneration.current === current && sessionRef.current === requestedSession && projectRef.current === requestedProject) setOperationLoading(false) }
  }, [loadHealth, loadScheduling, sessionId])

  useEffect(() => {
    operationGeneration.current += 1; setScheduling(null); setHealthInbox([]); setOperationError(null); setOperationNotice(null); setCancelReason('')
    if (projectId !== null) void refreshOperations(projectId)
  }, [projectId, attemptId, refreshOperations])

  const applyControl = useCallback(async (request: SchedulingControl): Promise<void> => {
    if (controlScheduling === undefined) return
    const requestedSession = sessionId, requestedProject = request.projectId, requestedAttempt = attemptRef.current, selected = selectionEpoch.current, current = ++operationGeneration.current
    setOperationLoading(true)
    try {
      const result = await controlScheduling(requestedSession, request)
      if (operationGeneration.current !== current || selectionEpoch.current !== selected || sessionRef.current !== requestedSession || projectRef.current !== requestedProject || attemptRef.current !== requestedAttempt) return
      if (!result.ok) {
        setOperationError(errorText(result.error))
        if (/stale|revision/i.test(`${result.error.code} ${result.error.message}`)) { setOperationNotice(t('dashboard.operationStale')); void refreshOperations(requestedProject); void refresh() }
        return
      }
      setScheduling(result.value); setOperationError(null); setOperationNotice(t('dashboard.operationApplied')); setCancelReason('')
      await refresh()
      if (selectionEpoch.current === selected && sessionRef.current === requestedSession && projectRef.current === requestedProject && attemptRef.current === requestedAttempt) await refreshOperations(requestedProject)
    } catch (reason) { if (operationGeneration.current === current && selectionEpoch.current === selected && sessionRef.current === requestedSession && projectRef.current === requestedProject && attemptRef.current === requestedAttempt) setOperationError(String(reason)) }
    finally { if (operationGeneration.current === current && selectionEpoch.current === selected && sessionRef.current === requestedSession && projectRef.current === requestedProject && attemptRef.current === requestedAttempt) setOperationLoading(false) }
  }, [controlScheduling, refresh, refreshOperations, sessionId, t])

  const acknowledge = useCallback(async (escalation: OperatorEscalation): Promise<void> => {
    if (acknowledgeHealth === undefined || projectId === null) return
    const requestedSession = sessionId, requestedProject = projectId, requestedAttempt = attemptRef.current, selected = selectionEpoch.current, current = ++operationGeneration.current
    setOperationLoading(true)
    try {
      const result = await acknowledgeHealth(requestedSession, requestedProject, escalation.id, escalation.revision)
      if (operationGeneration.current !== current || selectionEpoch.current !== selected || sessionRef.current !== requestedSession || projectRef.current !== requestedProject || attemptRef.current !== requestedAttempt) return
      if (!result.ok) {
        setOperationError(errorText(result.error))
        if (/stale|revision/i.test(`${result.error.code} ${result.error.message}`)) { setOperationNotice(t('dashboard.operationStale')); void refreshOperations(requestedProject); void refresh() }
        return
      }
      setHealthInbox(items => items.map(item => item.id === result.value.id ? result.value : item)); setOperationError(null); setOperationNotice(t('dashboard.operationApplied'))
      await refresh()
    } catch (reason) { if (operationGeneration.current === current && selectionEpoch.current === selected && sessionRef.current === requestedSession && projectRef.current === requestedProject && attemptRef.current === requestedAttempt) setOperationError(String(reason)) }
    finally { if (operationGeneration.current === current && selectionEpoch.current === selected && sessionRef.current === requestedSession && projectRef.current === requestedProject && attemptRef.current === requestedAttempt) setOperationLoading(false) }
  }, [acknowledgeHealth, projectId, refresh, refreshOperations, sessionId, t])

  const visibleAttempts = view?.attempts.filter(attempt => projectId === null || attempt.projectId === projectId) ?? []
  const visibleWorkflows = view?.workflows.filter(workflow => projectId === null || workflow.projectId === projectId) ?? []
  const visibleQueue = view?.queue.filter(request => projectId === null || request.projectId === projectId) ?? []
  const visibleIntegrations = view?.integrations.filter(integration => projectId === null || integration.projectId === projectId) ?? []
  const visibleMergeBatches = view?.mergeBatches.filter(batch => projectId === null || batch.members.some(member => member.projectId === projectId)) ?? []
  const visibleEscalations = view?.escalations.filter(escalation => projectId === null || escalation.projectId === projectId) ?? []
  const selectedAttempt = view?.attempts.find(attempt => attempt.attemptId === attemptId && attempt.projectId === projectId)
  const selectedRequest = selectedAttempt === undefined ? undefined : scheduling?.requests.find(request => request.projectId === selectedAttempt.projectId && request.teamId === selectedAttempt.teamId && request.taskId === selectedAttempt.taskId && request.attemptId === selectedAttempt.attemptId)
  const empty = view !== null && view.projects.length === 0 && view.attempts.length === 0 && view.workflows.length === 0 && view.batches.length === 0 && view.mergeBatches.length === 0 && view.queue.length === 0 && view.integrations.length === 0 && view.escalations.length === 0

  return <section className={css.root} aria-label={t('dashboard.title')}>
    <header className={css.header}>
      <h2>{t('dashboard.title')}</h2>
      <button type="button" onClick={() => { void refresh() }} disabled={loading}>{t('dashboard.refresh')}</button>
    </header>
    {error !== null && <div role="alert" className={css.error}>{error}</div>}
    {notice !== null && <div role="status" className={css.notice}>{notice}</div>}
    {loading && view === null && <div role="status" className={css.notice}>{t('dashboard.loading')}</div>}
    {empty && !loading && <div role="status" className={css.notice}>{t('dashboard.empty')}</div>}
    {view !== null && <>
      <div className={css.selection} aria-live="polite">
        {projectId !== null && <button type="button" onClick={() => { setProjectId(null); setAttemptId(null) }}>{t('dashboard.clearProject')}: {projectId}</button>}
        {attemptId !== null && <button type="button" onClick={() => { setAttemptId(null) }}>{t('dashboard.clearAttempt')}: {attemptId}</button>}
      </div>
      {projectId !== null && loadScheduling !== undefined && controlScheduling !== undefined && loadHealth !== undefined && acknowledgeHealth !== undefined && <section className={css.section} aria-label={t('dashboard.operations')}>
        <h3>{t('dashboard.operations')}</h3>
        {operationLoading && <span role="status">{t('dashboard.operationLoading')}</span>}
        {operationError !== null && <div role="alert" className={css.error}>{operationError}</div>}
        {operationNotice !== null && <div role="status" className={css.notice}>{operationNotice}</div>}
        {scheduling !== null && <div className={css.selection}><button type="button" disabled={operationLoading} onClick={() => { void applyControl({ action: 'pause', projectId, expectedRevision: scheduling.controlRevision, paused: !scheduling.paused }) }}>{scheduling.paused ? t('dashboard.resume') : t('dashboard.pause')}</button>
          {selectedRequest !== undefined && selectedAttempt !== undefined && <><label>{t('dashboard.cancelReason')} <input value={cancelReason} onChange={event => { setCancelReason(event.currentTarget.value) }} /></label><button type="button" disabled={operationLoading || cancelReason.trim() === ''} onClick={() => { void applyControl({ action: 'cancel', projectId, taskId: selectedRequest.taskId, expectedRevision: selectedRequest.revision, reason: cancelReason.trim(), attemptId: selectedAttempt.attemptId, generation: selectedAttempt.generation, expectedAttemptRevision: selectedAttempt.revision }) }}>{t('dashboard.cancel')}</button></>}
          {selectedAttempt !== undefined && selectedRequest !== undefined && selectedAttempt.phase === 'terminal' && selectedAttempt.retryEligible !== undefined && <button type="button" disabled={operationLoading || selectedAttempt.retryEligible !== true} title={selectedAttempt.retryEligible === true ? undefined : t(`dashboard.retry.${selectedAttempt.retryReason ?? 'not-provisioning'}` as TeamKey)} onClick={() => { void applyControl({ action: 'retry', projectId, taskId: selectedRequest.taskId, expectedRevision: selectedRequest.revision, attemptId: selectedAttempt.attemptId, generation: selectedAttempt.generation, expectedAttemptRevision: selectedAttempt.revision }) }}>{t('dashboard.retry')}</button>}
          {selectedAttempt !== undefined && selectedRequest !== undefined && selectedAttempt.phase === 'active' && <button type="button" disabled={operationLoading || selectedAttempt.handoffEligible !== true} title={selectedAttempt.handoffEligible === true ? undefined : t(`dashboard.handoff.${selectedAttempt.handoffReason ?? 'not-active'}` as TeamKey)} onClick={() => { void applyControl({ action: 'handoff', projectId, taskId: selectedRequest.taskId, expectedRevision: selectedRequest.revision, attemptId: selectedAttempt.attemptId, generation: selectedAttempt.generation, expectedAttemptRevision: selectedAttempt.revision }) }}>{t('dashboard.reassignHandoff')}</button>}
        </div>}
        {healthInbox.map(escalation => <div key={escalation.id} className={css.row}><span>{escalation.work.taskId} · {t(`health.condition.${escalation.condition}` as TeamKey)}</span><button type="button" disabled={operationLoading || escalation.acknowledgement !== undefined} onClick={() => { void acknowledge(escalation) }}>{t('dashboard.acknowledge')}</button></div>)}
      </section>}
      {loadPage !== undefined && <section className={css.section} aria-label={t('dashboard.pages')}>
        <h3>{t('dashboard.pages')} · {t(`dashboard.${collection === 'batches' ? 'workspaceBatches' : collection}` as TeamKey)}</h3>
        <div className={css.pager}><label>{t('dashboard.pageCollection')} <select value={collection} onChange={event => { setCollection(event.currentTarget.value as WorkspaceDashboardCollection); setPage(null); setPageHistory([]); setPageError(null) }}>{(['projects', 'attempts', 'workflows', 'batches', 'mergeBatches', 'queue', 'integrations', 'escalations'] as const).map(value => <option key={value} value={value}>{t(`dashboard.${value === 'batches' ? 'workspaceBatches' : value}` as TeamKey)}</option>)}</select></label>
          <button type="button" disabled={pageLoading || pageHistory.length === 0} onClick={() => { const next = pageHistory.slice(0, -1); void fetchPage(pageHistory.at(-1), next) }}>{t('dashboard.pagePrevious')}</button>
          <button type="button" disabled={pageLoading || page?.nextCursor === undefined} onClick={() => { void fetchPage(page!.nextCursor, [...pageHistory, pageCursor]) }}>{t('dashboard.pageNext')}</button>
          {pageLoading && <span role="status">{t('dashboard.pageLoading')}</span>}</div>
        {pageError !== null && <div role="alert" className={css.error}>{pageError} <button type="button" onClick={() => { void fetchPage(undefined, []) }}>{t('dashboard.pageRestart')}</button></div>}
        {page !== null && <PageRows page={page} t={t} />}
      </section>}
      {loadActivity !== undefined && <section className={css.section} aria-label={t('dashboard.activity')}>
        <h3>{t('dashboard.activity')}</h3>
        <p>{t('dashboard.activityOrdering')}</p>
        {activityLoading && <span role="status">{t('dashboard.activityLoading')}</span>}
        {activityGap && <div role="status" className={css.notice}>{t('dashboard.activityGap')}</div>}
        {activityError !== null && <div role="alert" className={css.error}>{activityError}{activityStale && <button type="button" onClick={restartActivity}>{t('dashboard.activityRestart')}</button>}</div>}
        {activity.map(item => <article key={`${item.ref.workspaceId}/${item.ref.source}/${item.ref.sequence}`} className={css.card}><strong>{item.type}</strong><span>{item.ref.source} #{item.ref.sequence}</span>{item.projectId === undefined ? null : <span>{item.projectId}/{item.taskId ?? t('dashboard.activityNoTask')}</span>}{item.attemptId === undefined ? null : <span>{item.attemptId}{item.generation === undefined ? '' : ` · ${item.generation}`}</span>}{item.timestampMs === undefined ? <span>{t('dashboard.activityTimeUnknown')}</span> : <time dateTime={new Date(item.timestampMs).toISOString()}>{new Date(item.timestampMs).toLocaleString()}</time>}</article>)}
      </section>}
      <DashboardSection title={t('dashboard.projects')} truncated={view.projectsTruncated} t={t}>
        {view.projects.map(project => <button key={project.id} type="button" className={css.row} aria-pressed={project.id === projectId} onClick={() => { setProjectId(project.id); setAttemptId(null); setNotice(null) }}>
          <strong>{project.id}</strong><span>{t('dashboard.revision')} {project.revision}</span><span>{project.paused ? t('dashboard.paused') : t('dashboard.running')}</span><span>{project.active}/{project.capacity}</span>
        </button>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.attempts')} truncated={view.attemptsTruncated} t={t}>
        {visibleAttempts.map(attempt => <button key={attempt.attemptId} type="button" className={css.row} aria-pressed={attempt.attemptId === attemptId} onClick={() => { setProjectId(attempt.projectId); setAttemptId(attempt.attemptId); setNotice(null) }}>
          <strong>{attempt.attemptId}</strong><span>{attempt.projectId}/{attempt.taskId}</span><span>{stateLabel(t, 'attempt', attempt.phase)}</span><span>{attempt.progress === undefined ? t('dashboard.progress.unobserved') : `${t(`dashboard.progress.${attempt.progress.classification}` as TeamKey)} · ${t(`dashboard.progress.${attempt.progress.certainty}`)}`}</span><Age at={attempt.progress?.lastProgressAt} label="dashboard.lastProgress" unknown="dashboard.lastProgressUnknown" t={t} />{attempt.provisioning === undefined ? null : <span>{t('dashboard.retryLineage')} {attempt.provisioning.count}/{attempt.provisioning.maxAttempts} · {attempt.provisioning.retryable ? t('dashboard.retryable') : t('dashboard.notRetryable')}</span>}<Usage usage={attempt.externalUsage} t={t} />
        </button>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.workflows')} truncated={view.workflowsTruncated} t={t}>
        {visibleWorkflows.map(workflow => <article key={workflow.executionId} className={css.card}><strong>{workflow.executionId}</strong><Truncation value={workflow.stepsTruncated} t={t} />
          {workflow.steps.map(step => <div key={step.stepId}>{step.stepId} · {stateLabel(t, 'workflow', step.phase)} · {t('dashboard.revision')} {step.revision}{step.taskId === undefined ? '' : ` · ${step.taskId}`}</div>)}</article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.workspaceBatches')} truncated={view.batchesTruncated} t={t}>
        {view.batches.map(batch => <article key={batch.id} className={css.card}><strong>{batch.id}</strong><span>{stateLabel(t, 'batch', batch.phase)}</span><span>{batch.completedRequired}/{batch.required}</span><span>{t('dashboard.epoch')} {batch.completionEpoch}</span></article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.mergeBatches')} truncated={view.mergeBatchesTruncated} t={t}>
        {visibleMergeBatches.map(batch => <article key={batch.id} className={css.card}><strong>{batch.id}</strong><span>{t(`dashboard.mergeBatch.${batch.phase}` as TeamKey)}</span>{batch.members.map(member => <span key={member.integrationId}>{member.integrationId}{member.projectId === undefined ? '' : ` · ${member.projectId}/${member.taskId ?? t('dashboard.activityNoTask')}`}</span>)}</article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.queue')} truncated={view.queueTruncated} t={t}>
        {visibleQueue.map(request => <article key={`${request.projectId}/${request.taskId}`} className={css.card}><strong>{request.projectId}/{request.taskId}</strong><span>{stateLabel(t, 'queue', request.state)} · {t('dashboard.revision')} {request.revision}</span><Age at={request.enqueuedAt} label="dashboard.queueAge" unknown="dashboard.queueAgeUnknown" t={t} /><span>{request.blockers.map(blocker => blocker.code).join(', ')}</span><Truncation value={request.blockersTruncated} t={t} /></article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.integrations')} truncated={view.integrationsTruncated} t={t}>
        {visibleIntegrations.map(integration => <article key={integration.integrationId} className={css.card}><strong>{integration.integrationId}</strong><span>{stateLabel(t, 'integration', integration.phase)} · {integration.projectId}/{integration.teamId}</span><span>{integration.sourceCommit}</span>{integration.failureKind === undefined ? null : <span>{t('dashboard.integration.verificationFailed')}</span>}{integration.diagnostic === undefined ? null : <p>{integration.diagnostic}</p>}</article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.escalations')} truncated={view.escalationsTruncated} t={t}>
        {visibleEscalations.map(escalation => <article key={escalation.id} className={css.card}><strong>{t(`health.severity.${escalation.severity}`)} · {t(`health.condition.${escalation.condition}`)}</strong><span>{escalation.projectId}/{escalation.taskId} · {escalation.attemptId} · {t('dashboard.revision')} {escalation.revision}</span><p>{escalation.diagnostics}</p></article>)}
      </DashboardSection>
      <AutofixerSettings
        projects={view.projects}
        selectedProjectId={projectId}
        onSelectProject={setProjectId}
        initialConfig={initialAutofixerConfig}
        onSave={onSaveAutofixerConfig}
        t={t}
      />
    </>}
  </section>
}

/** The retained page uses the same safe fields and human labels as the summary sections. */
function PageRows({ page, t }: { readonly page: WorkspaceDashboardPage; readonly t: WorkspaceDashboardProps['t'] }) {
  const items = page.items
  let rows: ReactNode
  if (page.collection === 'attempts') rows = (items as WorkspaceDashboardView['attempts']).map(item => <article key={item.attemptId} className={css.card}><strong>{item.attemptId}</strong><span>{item.projectId}/{item.taskId}</span><span>{stateLabel(t, 'attempt', item.phase)}</span><span>{item.progress === undefined ? t('dashboard.progress.unobserved') : `${t(`dashboard.progress.${item.progress.classification}` as TeamKey)} · ${t(`dashboard.progress.${item.progress.certainty}` as TeamKey)}`}</span><Usage usage={item.externalUsage} t={t} /></article>)
  else if (page.collection === 'workflows') rows = (items as WorkspaceDashboardView['workflows']).map(item => <article key={item.executionId} className={css.card}><strong>{item.executionId}</strong>{item.steps.map(step => <span key={step.stepId}>{step.stepId} · {stateLabel(t, 'workflow', step.phase)}</span>)}<Truncation value={item.stepsTruncated} t={t} /></article>)
  else if (page.collection === 'integrations') rows = (items as WorkspaceDashboardView['integrations']).map(item => <article key={item.integrationId} className={css.card}><strong>{item.integrationId}</strong><span>{stateLabel(t, 'integration', item.phase)} · {item.projectId}/{item.teamId}</span><span>{item.sourceCommit}</span>{item.diagnostic === undefined ? null : <p>{item.diagnostic}</p>}</article>)
  else if (page.collection === 'escalations') rows = (items as WorkspaceDashboardView['escalations']).map(item => <article key={item.id} className={css.card}><strong>{t(`health.severity.${item.severity}` as TeamKey)} · {t(`health.condition.${item.condition}` as TeamKey)}</strong><span>{item.projectId}/{item.taskId} · {item.attemptId}</span><p>{item.diagnostics}</p></article>)
  else if (page.collection === 'queue') rows = (items as WorkspaceDashboardView['queue']).map(item => <article key={`${item.projectId}/${item.taskId}`} className={css.card}><strong>{item.projectId}/{item.taskId}</strong><span>{stateLabel(t, 'queue', item.state)} · {t('dashboard.revision')} {item.revision}</span><span>{item.blockers.map(blocker => blocker.code).join(', ')}</span><Truncation value={item.blockersTruncated} t={t} /></article>)
  else if (page.collection === 'batches') rows = (items as WorkspaceDashboardView['batches']).map(item => <article key={item.id} className={css.card}><strong>{item.id}</strong><span>{stateLabel(t, 'batch', item.phase)}</span><span>{item.completedRequired}/{item.required}</span></article>)
  else if (page.collection === 'mergeBatches') rows = (items as WorkspaceDashboardView['mergeBatches']).map(item => <article key={item.id} className={css.card}><strong>{item.id}</strong><span>{t(`dashboard.mergeBatch.${item.phase}` as TeamKey)}</span>{item.members.map(member => <span key={member.integrationId}>{member.integrationId}{member.projectId === undefined ? '' : ` · ${member.projectId}/${member.taskId ?? t('dashboard.activityNoTask')}`}</span>)}</article>)
  else rows = (items as WorkspaceDashboardView['projects']).map(item => <article key={item.id} className={css.card}><strong>{item.id}</strong><span>{t('dashboard.revision')} {item.revision}</span><span>{item.paused ? t('dashboard.paused') : t('dashboard.running')}</span><span>{item.active}/{item.capacity}</span></article>)
  return <div className={css.pageRows}>{rows}<Truncation value={page.truncated} t={t} /></div>
}

function DashboardSection({ title, truncated, t, children }: { readonly title: string; readonly truncated: boolean; readonly t: WorkspaceDashboardProps['t']; readonly children: ReactNode }) {
  return <section className={css.section}><h3>{title} <Truncation value={truncated} t={t} /></h3>{children}</section>
}
