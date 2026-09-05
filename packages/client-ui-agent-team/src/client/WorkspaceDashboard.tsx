/** Read-only workspace dashboard. Remote mounting and authority wiring are intentionally separate. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { TeamKey } from './locales.ts'
import css from './WorkspaceDashboard.module.css'

export interface WorkspaceDashboardProps {
  readonly sessionId: SessionId
  readonly load: (sessionId: SessionId) => Promise<RemoteResult<WorkspaceDashboardView>>
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
export function WorkspaceDashboard({ sessionId, load, t }: WorkspaceDashboardProps) {
  const [view, setView] = useState<WorkspaceDashboardView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const generation = useRef(0)
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
    void refresh()
    return () => { generation.current += 1 }
  }, [sessionId, refresh])

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

function DashboardSection({ title, truncated, t, children }: { readonly title: string; readonly truncated: boolean; readonly t: WorkspaceDashboardProps['t']; readonly children: ReactNode }) {
  return <section className={css.section}><h3>{title} <Truncation value={truncated} t={t} /></h3>{children}</section>
}
