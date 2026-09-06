/** Slot action opening the full-screen GasView visual agents overlay. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import { reconcileDashboard, type VisualSceneModel } from './reconcile.ts'
import { createVisualToggleStore, type VisualToggleStore } from './toggle.ts'
import { SceneCanvas, type SceneAgent } from './SceneCanvas.tsx'
import { AGENT_TINTS } from '../engine/sprites.ts'
import { buildNavGrid } from '../engine/pathfinding.ts'
import {
  reconcileActors, sheetForActor, stepActors, type Actor, type ActorSheets,
} from '../engine/stateMachine.ts'
import { startPoller, type Poller } from '../engine/poll.ts'
import { DESK_SLOTS } from '../scenes/layout.ts'
import { leadIdle } from '../assets/sprites/lead.ts'
import { teammateIdle, teammateWalk, teammateWork } from '../assets/sprites/teammate.ts'
import { palette } from './assets/palette.ts'
import css from './VisualAgentsAction.module.css'

/** Fixed overseer slot beside the plaque for the lead fox (normalized coords). */
const OVERSEER_SLOT = { x: 0.5, y: 0.18 } as const

/** Desk obstacle rects for the nav grid (desk footprint + 2% approach line). */
const DESK_OBSTACLES = DESK_SLOTS.map(slot => ({ x: slot.x - 0.06, y: slot.y - 0.02, w: 0.12, h: 0.06 }))

/** Teammate sheets per actor phase/state (lead overseer stays static on leadIdle). */
const TEAMMATE_SHEETS: ActorSheets = { idle: teammateIdle, work: teammateWork, walk: teammateWalk }

/** Poll cadence: 2s while actors move or work, 10s otherwise. */
const ACTIVE_POLL_MS = 2000
const IDLE_POLL_MS = 10000

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
  const [staleNotice, setStaleNotice] = useState(false)
  const [store] = useState<VisualToggleStore>(() => createVisualToggleStore(window.localStorage, false))
  // Actors live outside React state intentionally — 60fps stepping must not
  // re-render; the canvas reads them through getAgents every frame.
  const actorsRef = useRef<readonly Actor[]>([])
  const pollerRef = useRef<Poller | null>(null)
  const sessionRef = useRef(sessionId)
  const projectIdRef = useRef<string | null>(projectId)
  const sceneRef = useRef<VisualSceneModel | null>(null)
  const refreshGeneration = useRef(0)
  sessionRef.current = sessionId
  projectIdRef.current = projectId

  const grid = useMemo(() => buildNavGrid(20, 12, DESK_OBSTACLES), [])

  useEffect(() => {
    refreshGeneration.current += 1
    actorsRef.current = []
    setOpen(false)
    setLoading(false)
    setView(null)
    setError(null)
    setProjectId(null)
    setStaleNotice(false)
  }, [sessionId])

  const refresh = useCallback(async (): Promise<void> => {
    const requestedSession = sessionId
    const generation = ++refreshGeneration.current
    setLoading(true)
    let result: TeamVisualActionResult
    try {
      result = await load(requestedSession)
    } catch (cause) {
      if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return
      setLoading(false)
      setError(String(cause))
      // Rethrow so the poller's error backoff engages (poll.ts catches task
      // rejections internally; the error UI state is already set above).
      throw cause
    }
    if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return
    setLoading(false)
    if (result.ok) {
      // Stale-selection fix: a selected project absent from the latest
      // dashboard (or a truncated project list) is cleared with a notice.
      const current = projectIdRef.current
      const stale = current !== null
        && (result.value.projectsTruncated || !result.value.projects.some(project => project.id === current))
      const nextProjectId = stale ? null : current ?? result.value.projects[0]?.id ?? null
      projectIdRef.current = nextProjectId
      setProjectId(nextProjectId)
      setStaleNotice(stale)
      setView(result.value)
      setError(null)
      const scene = reconcileDashboard(result.value, nextProjectId)
      actorsRef.current = reconcileActors(actorsRef.current, scene, grid, Date.now())
      return
    }
    setError(failureText(result.error))
    // Carrier failure: same rethrow (kept OUTSIDE the try so the catch above
    // does not re-handle it and overwrite the carrier error text).
    throw new Error(failureText(result.error))
  }, [load, sessionId, grid])

  // Adaptive polling while the overlay is open; manual refresh pokes it.
  useEffect(() => {
    if (!open) return undefined
    const poller = startPoller(refresh, {
      activeMs: ACTIVE_POLL_MS,
      idleMs: IDLE_POLL_MS,
      isActive: () => actorsRef.current.some(actor => actor.phase !== 'settled' || actor.state === 'working'),
    })
    pollerRef.current = poller
    return () => {
      poller.stop()
      pollerRef.current = null
    }
  }, [open, refresh])

  const enabled = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    () => projectId !== null && store.isEnabled(projectId),
  )
  const scene = useMemo(() => view === null ? null : reconcileDashboard(view, projectId), [view, projectId])
  sceneRef.current = scene

  const getAgents = useCallback((): readonly SceneAgent[] => {
    const agents: SceneAgent[] = actorsRef.current.map((actor, index) => ({
      sheet: sheetForActor(actor, TEAMMATE_SHEETS),
      x: actor.x,
      y: actor.y,
      desk: actor.desk,
      tint: AGENT_TINTS[index % AGENT_TINTS.length] ?? palette.copper,
    }))
    if ((sceneRef.current?.agents.length ?? 0) >= 1) {
      agents.unshift({
        sheet: leadIdle, x: OVERSEER_SLOT.x, y: OVERSEER_SLOT.y,
        desk: OVERSEER_SLOT, tint: palette.surfaceDark,
      })
    }
    return agents
  }, [])

  const handleFrame = useCallback((timeMs: number, dtMs: number): void => {
    actorsRef.current = stepActors(actorsRef.current, grid, dtMs, timeMs)
  }, [grid])

  const showCanvas = scene !== null && projectId !== null && enabled

  return (
    <div className={css.root} data-team-visual-action>
      <button
        type="button"
        className={css.trigger}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span>{t('trigger')}</span>
      </button>
      {open && (
        <div className={css.overlay} role="dialog" aria-modal="true" aria-label={t('title')}>
          <div className={css.toolbar}>
            <strong>{t('title')}</strong>
            <span className={css.spacer} />
            <button type="button" className={css.textButton} onClick={() => { pollerRef.current?.poke() }}>{t('refresh')}</button>
            <button type="button" className={css.textButton} aria-label={t('close')} onClick={() => { setOpen(false) }}>{t('close')}</button>
          </div>
          {error !== null && <div className={css.error} role="alert">{error}</div>}
          {staleNotice && <div className={css.notice} role="status">{t('dashboard.stale')}</div>}
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
                    setStaleNotice(false)
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
                ? <SceneCanvas plaqueText={t('scene.projectPlaque', { projectId })} getAgents={getAgents} onFrame={handleFrame} />
                : <div className={css.notice} role="status">{t('toggle.disabledNotice')}</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
