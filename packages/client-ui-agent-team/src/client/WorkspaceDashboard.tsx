/** Read-only workspace dashboard. Remote mounting and authority wiring are intentionally separate. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDashboardCollection, WorkspaceDashboardPage, WorkspaceDashboardPageRequest, WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TeamKey } from './locales.ts'
import css from './WorkspaceDashboard.module.css'

export interface WorkspaceDashboardProps {
  readonly sessionId: SessionId
  readonly load: (sessionId: SessionId) => Promise<RemoteResult<WorkspaceDashboardView>>
  readonly loadPage?: (sessionId: SessionId, request: WorkspaceDashboardPageRequest) => Promise<RemoteResult<WorkspaceDashboardPage>>
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

/**
 * Presents only the browser-safe workspace projection. Its `load` capability is
 * supplied later by an operator-authorized Remote binding.
 */
export function WorkspaceDashboard({ sessionId, load, loadPage, t }: WorkspaceDashboardProps) {
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

  const visibleAttempts = view?.attempts.filter(attempt => projectId === null || attempt.projectId === projectId) ?? []
  const visibleWorkflows = view?.workflows.filter(workflow => projectId === null || workflow.projectId === projectId) ?? []
  const visibleQueue = view?.queue.filter(request => projectId === null || request.projectId === projectId) ?? []
  const visibleIntegrations = view?.integrations.filter(integration => projectId === null || integration.projectId === projectId) ?? []
  const visibleEscalations = view?.escalations.filter(escalation => projectId === null || escalation.projectId === projectId) ?? []
  const empty = view !== null && view.projects.length === 0 && view.attempts.length === 0 && view.workflows.length === 0 && view.batches.length === 0 && view.queue.length === 0 && view.integrations.length === 0 && view.escalations.length === 0

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
      {loadPage !== undefined && <section className={css.section} aria-label={t('dashboard.pages')}>
        <h3>{t('dashboard.pages')} · {t(`dashboard.${collection === 'batches' ? 'workspaceBatches' : collection}` as TeamKey)}</h3>
        <div className={css.pager}><label>{t('dashboard.pageCollection')} <select value={collection} onChange={event => { setCollection(event.currentTarget.value as WorkspaceDashboardCollection); setPage(null); setPageHistory([]); setPageError(null) }}>{(['projects', 'attempts', 'workflows', 'batches', 'queue', 'integrations', 'escalations'] as const).map(value => <option key={value} value={value}>{t(`dashboard.${value === 'batches' ? 'workspaceBatches' : value}` as TeamKey)}</option>)}</select></label>
          <button type="button" disabled={pageLoading || pageHistory.length === 0} onClick={() => { const next = pageHistory.slice(0, -1); void fetchPage(pageHistory.at(-1), next) }}>{t('dashboard.pagePrevious')}</button>
          <button type="button" disabled={pageLoading || page?.nextCursor === undefined} onClick={() => { void fetchPage(page!.nextCursor, [...pageHistory, pageCursor]) }}>{t('dashboard.pageNext')}</button>
          {pageLoading && <span role="status">{t('dashboard.pageLoading')}</span>}</div>
        {pageError !== null && <div role="alert" className={css.error}>{pageError} <button type="button" onClick={() => { void fetchPage(undefined, []) }}>{t('dashboard.pageRestart')}</button></div>}
        {page !== null && <PageRows page={page} t={t} />}
      </section>}
      <DashboardSection title={t('dashboard.projects')} truncated={view.projectsTruncated} t={t}>
        {view.projects.map(project => <button key={project.id} type="button" className={css.row} aria-pressed={project.id === projectId} onClick={() => { setProjectId(project.id); setAttemptId(null); setNotice(null) }}>
          <strong>{project.id}</strong><span>{t('dashboard.revision')} {project.revision}</span><span>{project.paused ? t('dashboard.paused') : t('dashboard.running')}</span><span>{project.active}/{project.capacity}</span>
        </button>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.attempts')} truncated={view.attemptsTruncated} t={t}>
        {visibleAttempts.map(attempt => <button key={attempt.attemptId} type="button" className={css.row} aria-pressed={attempt.attemptId === attemptId} onClick={() => { setAttemptId(attempt.attemptId); setNotice(null) }}>
          <strong>{attempt.attemptId}</strong><span>{attempt.projectId}/{attempt.taskId}</span><span>{stateLabel(t, 'attempt', attempt.phase)}</span><span>{attempt.progress === undefined ? t('dashboard.progress.unobserved') : `${t(`dashboard.progress.${attempt.progress.classification}` as TeamKey)} · ${t(`dashboard.progress.${attempt.progress.certainty}`)}`}</span>
        </button>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.workflows')} truncated={view.workflowsTruncated} t={t}>
        {visibleWorkflows.map(workflow => <article key={workflow.executionId} className={css.card}><strong>{workflow.executionId}</strong><Truncation value={workflow.stepsTruncated} t={t} />
          {workflow.steps.map(step => <div key={step.stepId}>{step.stepId} · {stateLabel(t, 'workflow', step.phase)} · {t('dashboard.revision')} {step.revision}{step.taskId === undefined ? '' : ` · ${step.taskId}`}</div>)}</article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.workspaceBatches')} truncated={view.batchesTruncated} t={t}>
        {view.batches.map(batch => <article key={batch.id} className={css.card}><strong>{batch.id}</strong><span>{stateLabel(t, 'batch', batch.phase)}</span><span>{batch.completedRequired}/{batch.required}</span><span>{t('dashboard.epoch')} {batch.completionEpoch}</span></article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.queue')} truncated={view.queueTruncated} t={t}>
        {visibleQueue.map(request => <article key={`${request.projectId}/${request.taskId}`} className={css.card}><strong>{request.projectId}/{request.taskId}</strong><span>{stateLabel(t, 'queue', request.state)} · {t('dashboard.revision')} {request.revision}</span><span>{request.blockers.map(blocker => blocker.code).join(', ')}</span><Truncation value={request.blockersTruncated} t={t} /></article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.integrations')} truncated={view.integrationsTruncated} t={t}>
        {visibleIntegrations.map(integration => <article key={integration.integrationId} className={css.card}><strong>{integration.integrationId}</strong><span>{stateLabel(t, 'integration', integration.phase)} · {integration.projectId}/{integration.teamId}</span><span>{integration.sourceCommit}</span>{integration.failureKind === undefined ? null : <span>{t('dashboard.integration.verificationFailed')}</span>}{integration.diagnostic === undefined ? null : <p>{integration.diagnostic}</p>}</article>)}
      </DashboardSection>
      <DashboardSection title={t('dashboard.escalations')} truncated={view.escalationsTruncated} t={t}>
        {visibleEscalations.map(escalation => <article key={escalation.id} className={css.card}><strong>{t(`health.severity.${escalation.severity}`)} · {t(`health.condition.${escalation.condition}`)}</strong><span>{escalation.projectId}/{escalation.taskId} · {escalation.attemptId} · {t('dashboard.revision')} {escalation.revision}</span><p>{escalation.diagnostics}</p></article>)}
      </DashboardSection>
    </>}
  </section>
}

/** The retained page uses the same safe fields and human labels as the summary sections. */
function PageRows({ page, t }: { readonly page: WorkspaceDashboardPage; readonly t: WorkspaceDashboardProps['t'] }) {
  const items = page.items
  let rows: ReactNode
  if (page.collection === 'attempts') rows = (items as WorkspaceDashboardView['attempts']).map(item => <article key={item.attemptId} className={css.card}><strong>{item.attemptId}</strong><span>{item.projectId}/{item.taskId}</span><span>{stateLabel(t, 'attempt', item.phase)}</span><span>{item.progress === undefined ? t('dashboard.progress.unobserved') : `${t(`dashboard.progress.${item.progress.classification}` as TeamKey)} · ${t(`dashboard.progress.${item.progress.certainty}` as TeamKey)}`}</span></article>)
  else if (page.collection === 'workflows') rows = (items as WorkspaceDashboardView['workflows']).map(item => <article key={item.executionId} className={css.card}><strong>{item.executionId}</strong>{item.steps.map(step => <span key={step.stepId}>{step.stepId} · {stateLabel(t, 'workflow', step.phase)}</span>)}<Truncation value={item.stepsTruncated} t={t} /></article>)
  else if (page.collection === 'integrations') rows = (items as WorkspaceDashboardView['integrations']).map(item => <article key={item.integrationId} className={css.card}><strong>{item.integrationId}</strong><span>{stateLabel(t, 'integration', item.phase)} · {item.projectId}/{item.teamId}</span><span>{item.sourceCommit}</span>{item.diagnostic === undefined ? null : <p>{item.diagnostic}</p>}</article>)
  else if (page.collection === 'escalations') rows = (items as WorkspaceDashboardView['escalations']).map(item => <article key={item.id} className={css.card}><strong>{t(`health.severity.${item.severity}` as TeamKey)} · {t(`health.condition.${item.condition}` as TeamKey)}</strong><span>{item.projectId}/{item.taskId} · {item.attemptId}</span><p>{item.diagnostics}</p></article>)
  else if (page.collection === 'queue') rows = (items as WorkspaceDashboardView['queue']).map(item => <article key={`${item.projectId}/${item.taskId}`} className={css.card}><strong>{item.projectId}/{item.taskId}</strong><span>{stateLabel(t, 'queue', item.state)} · {t('dashboard.revision')} {item.revision}</span><span>{item.blockers.map(blocker => blocker.code).join(', ')}</span><Truncation value={item.blockersTruncated} t={t} /></article>)
  else if (page.collection === 'batches') rows = (items as WorkspaceDashboardView['batches']).map(item => <article key={item.id} className={css.card}><strong>{item.id}</strong><span>{stateLabel(t, 'batch', item.phase)}</span><span>{item.completedRequired}/{item.required}</span></article>)
  else rows = (items as WorkspaceDashboardView['projects']).map(item => <article key={item.id} className={css.card}><strong>{item.id}</strong><span>{t('dashboard.revision')} {item.revision}</span><span>{item.paused ? t('dashboard.paused') : t('dashboard.running')}</span><span>{item.active}/{item.capacity}</span></article>)
  return <div className={css.pageRows}>{rows}<Truncation value={page.truncated} t={t} /></div>
}

function DashboardSection({ title, truncated, t, children }: { readonly title: string; readonly truncated: boolean; readonly t: WorkspaceDashboardProps['t']; readonly children: ReactNode }) {
  return <section className={css.section}><h3>{title} <Truncation value={truncated} t={t} /></h3>{children}</section>
}
