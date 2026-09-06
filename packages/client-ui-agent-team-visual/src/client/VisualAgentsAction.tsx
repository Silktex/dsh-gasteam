/** Slot action opening the full-screen GasView visual agents overlay. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import { reconcileDashboard } from './reconcile.ts'
import { createVisualToggleStore, type VisualToggleStore } from './toggle.ts'
import { SceneCanvas } from './SceneCanvas.tsx'
import css from './VisualAgentsAction.module.css'

/** Generated Remote result consumed directly by the visual agents UI. */
export type TeamVisualActionResult = RemoteResult<WorkspaceDashboardView>

/** Business actions injected by the browser plugin. */
export interface TeamVisualActionInjected {
  load: (sessionId: SessionId) => Promise<TeamVisualActionResult>
}

/** Full props of the visual agents conversation-header action. */
export type TeamVisualActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamVisualActionInjected & PropsLocale<typeof NS>

/** One failure line from a Remote failure carrier. */
function failureText(error: { readonly code: string; readonly message: string }): string {
  return `${error.message} (${error.code})`
}

/** Render the per-project opt-in visual agents overlay over the shared Team dashboard. */
export function VisualAgentsAction({ sessionId, load, t }: TeamVisualActionProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<WorkspaceDashboardView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [store] = useState<VisualToggleStore>(() => createVisualToggleStore(window.localStorage, false))
  const sessionRef = useRef(sessionId)
  const refreshGeneration = useRef(0)
  sessionRef.current = sessionId

  useEffect(() => {
    refreshGeneration.current += 1
    setOpen(false)
    setLoading(false)
    setView(null)
    setError(null)
    setProjectId(null)
  }, [sessionId])

  const refresh = useCallback(async (): Promise<void> => {
    const requestedSession = sessionId
    const generation = ++refreshGeneration.current
    setLoading(true)
    try {
      const result = await load(requestedSession)
      if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return
      setLoading(false)
      if (result.ok) {
        setView(result.value)
        setError(null)
        setProjectId(current => current ?? result.value.projects[0]?.id ?? null)
      } else {
        setError(failureText(result.error))
      }
    } catch (cause) {
      if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return
      setLoading(false)
      setError(String(cause))
    }
  }, [load, sessionId])

  const enabled = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    () => projectId !== null && store.isEnabled(projectId),
  )
  const scene = useMemo(() => view === null ? null : reconcileDashboard(view, projectId), [view, projectId])
  const showCanvas = scene !== null && projectId !== null && enabled

  return (
    <div className={css.root} data-team-visual-action>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) void refresh()
        }}
      >
        <span>{t('trigger')}</span>
      </button>
      {open && (
        <div className={css.overlay} role="dialog" aria-modal="true" aria-label={t('title')}>
          <div className={css.toolbar}>
            <strong>{t('title')}</strong>
            <span className={css.spacer} />
            <button type="button" className={css.textButton} onClick={() => { void refresh() }}>{t('refresh')}</button>
            <button type="button" className={css.textButton} aria-label={t('close')} onClick={() => { setOpen(false) }}>{t('close')}</button>
          </div>
          {error !== null && <div className={css.error} role="alert">{error}</div>}
          {loading && view === null && <div className={css.notice}>{t('loading')}</div>}
          {view !== null && scene !== null && (
            <>
              {scene.projectCount === 0 && <div className={css.notice}>{t('empty')}</div>}
              <div className={css.controls}>
                <select
                  className={css.projectSelect}
                  aria-label={t('title')}
                  value={projectId ?? ''}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                    setProjectId(event.target.value === '' ? null : event.target.value)
                  }}
                >
                  <option value="">{t('scene.noProject')}</option>
                  {view.projects.map(project => <option key={project.id} value={project.id}>{project.id}</option>)}
                </select>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  className={enabled ? css.switchOn : css.switchOff}
                  disabled={projectId === null}
                  onClick={() => {
                    if (projectId === null) return
                    store.setEnabled(projectId, !store.isEnabled(projectId))
                  }}
                >
                  {enabled ? t('toggle.on') : t('toggle.off')}
                </button>
              </div>
              {showCanvas
                ? <SceneCanvas scene={scene} plaqueText={t('scene.projectPlaque', { projectId })} />
                : <div className={css.notice} role="status">{t('toggle.disabledNotice')}</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
