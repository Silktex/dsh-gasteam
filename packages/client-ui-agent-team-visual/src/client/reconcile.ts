/** Deterministic dashboard → visual scene reconciliation for the GasView overlay. */

import type { WorkspaceDashboardView } from '@deepseek-ai/dsh-experimental-agent-team/client'

/** Visual state of one painted agent. */
export type VisualAgentState = 'idle' | 'working' | 'blocked' | 'error' | 'done'

/** One agent marker in the painted scene. */
export interface VisualAgent {
  readonly id: string            // attemptId
  readonly projectId: string
  readonly taskId: string
  readonly state: VisualAgentState
  readonly label: string         // `${projectId}/${taskId}`
}

/** Scene model consumed by the M0 painter. */
export interface VisualSceneModel {
  readonly projectId: string | null
  readonly agents: readonly VisualAgent[]
  readonly projectCount: number
}

type Attempt = WorkspaceDashboardView['attempts'][number]

/**
 * Map one attempt to its visual state. Priority order; first match wins:
 * critical escalation → waiting queue entry with blockers → terminal → active → reserved/stopping.
 */
function stateOf(view: WorkspaceDashboardView, attempt: Attempt): VisualAgentState {
  if (view.escalations.some(entry => entry.attemptId === attempt.attemptId && entry.severity === 'critical')) return 'error'
  if (view.queue.some(entry =>
    entry.projectId === attempt.projectId
    && entry.taskId === attempt.taskId
    && entry.state === 'waiting'
    && entry.blockers.length > 0)) return 'blocked'
  if (attempt.phase === 'terminal') return 'done'
  if (attempt.phase === 'active') return 'working'
  return 'idle'
}

/**
 * Reconcile the workspace dashboard into a stable visual scene model.
 * @param view - workspace dashboard projection from the Team Remote.
 * @param projectId - selected project filter; `null` keeps every project.
 * @returns agents sorted by id for stable rendering, plus the total project count.
 */
export function reconcileDashboard(
  view: WorkspaceDashboardView,
  projectId: string | null,
): VisualSceneModel {
  const agents = view.attempts
    .filter(attempt => projectId === null || attempt.projectId === projectId)
    .map((attempt): VisualAgent => ({
      id: attempt.attemptId,
      projectId: attempt.projectId,
      taskId: attempt.taskId,
      state: stateOf(view, attempt),
      label: `${attempt.projectId}/${attempt.taskId}`,
    }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return { projectId, agents, projectCount: view.projects.length }
}
