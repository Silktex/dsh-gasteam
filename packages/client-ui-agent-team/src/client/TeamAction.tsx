import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberView as TeamRosterMember,
  CreateTeamTaskRequest,
  UpdateTeamTaskRequest,
  TeamTaskId,
  TeamTaskMutationResult,
  TeamTaskView as TeamTask,
  TeamView,
  OperatorEscalation,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline14, IconCloseOutline16, IconEditOutline16, IconPlusOutline16,
  IconRefreshOutline14, IconTrashOutline16, IconUserOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamAction.module.css'

/** Generated Remote result consumed directly by the Team UI. */
export type TeamActionResult<T> = RemoteResult<T>

/** Generated Remote result whose business value preserves Team task rejections. */
export type TeamTaskActionResult = RemoteResult<TeamTaskMutationResult>

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  load: (sessionId: SessionId) => Promise<TeamActionResult<TeamView>>
  createTask: (sessionId: SessionId, input: CreateTeamTaskRequest) => Promise<TeamTaskActionResult>
  updateTask: (sessionId: SessionId, input: UpdateTeamTaskRequest) => Promise<TeamTaskActionResult>
  openTeammate: (sessionId: SessionId, member: TeamRosterMember) => Promise<void>
  healthInbox: (sessionId: SessionId, projectId: string) => Promise<TeamActionResult<OperatorEscalation[]>>
  acknowledgeHealth: (sessionId: SessionId, projectId: string, escalationId: string, expectedRevision: number) => Promise<TeamActionResult<OperatorEscalation>>
}

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

interface Draft {
  subject: string
  description: string
  blockers: string
  scopes: string
}

const EMPTY_DRAFT: Draft = { subject: '', description: '', blockers: '', scopes: '' }

function items(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function taskIds(value: string): TeamTaskId[] {
  return items(value) as TeamTaskId[]
}

/**
 * One failure line for either carrier: a Remote failure, or a Team business
 * rejection whose codes stay local to this seam and never ride the wire.
 */
function failureText(error: { readonly code: string; readonly message: string }): string {
  return `${error.message} (${error.code})`
}

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

function memberStatusKey(status: TeamRosterMember['status']): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'idle': return 'memberStatus.idle'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

/** Render the live Team roster and compare-and-set task board. */
export function TeamAction({
  sessionId, load, createTask, updateTask, openTeammate, healthInbox, acknowledgeHealth, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<TeamView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT)
  const [pendingTasks, setPendingTasks] = useState<ReadonlySet<string>>(() => new Set())
  const [completion, setCompletion] = useState<{ taskId: TeamTaskId; result: string } | null>(null)
  const [healthProjectId, setHealthProjectId] = useState('')
  const [health, setHealth] = useState<OperatorEscalation[] | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [healthNotice, setHealthNotice] = useState<string | null>(null)
  const [acknowledging, setAcknowledging] = useState<ReadonlySet<string>>(() => new Set())
  const completionTask = view?.tasks.find(task => task.id === completion?.taskId && task.status === 'in_progress')
  const sessionRef = useRef(sessionId)
  const refreshGeneration = useRef(0)
  const healthGeneration = useRef(0)
  const healthProjectEpoch = useRef(0)
  const healthProjectRef = useRef(healthProjectId.trim())
  sessionRef.current = sessionId
  healthProjectRef.current = healthProjectId.trim()

  useEffect(() => {
    refreshGeneration.current += 1
    healthProjectEpoch.current += 1
    setOpen(false)
    setLoading(false)
    setView(null)
    setError(null)
    setCreating(false)
    setCreateDraft(EMPTY_DRAFT)
    setEditing(null)
    setEditDraft(EMPTY_DRAFT)
    setPendingTasks(new Set())
    setCompletion(null)
    setHealthProjectId('')
    setHealth(null)
    setHealthLoading(false)
    setHealthError(null)
    setHealthNotice(null)
    setAcknowledging(new Set())
  }, [sessionId])

  const refresh = useCallback(async (): Promise<boolean> => {
    const requestedSession = sessionId
    const generation = ++refreshGeneration.current
    setLoading(true)
    const result = await load(requestedSession)
    if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return false
    setLoading(false)
    if (result.ok) {
      setView(result.value)
      setError(null)
      return true
    } else {
      setError(failureText(result.error))
      return false
    }
  }, [load, sessionId])

  const refreshHealth = useCallback(async (projectId = healthProjectId): Promise<void> => {
    const normalizedProjectId = projectId.trim()
    const requestedSession = sessionId
    const generation = ++healthGeneration.current
    if (normalizedProjectId === '') {
      setHealth(null)
      setHealthError(null)
      setHealthLoading(false)
      return
    }
    setHealthLoading(true)
    try {
      const result = await healthInbox(requestedSession, normalizedProjectId)
      if (sessionRef.current !== requestedSession || healthGeneration.current !== generation || healthProjectRef.current !== normalizedProjectId) return
      if (result.ok) {
        setHealth(result.value)
        setHealthError(null)
      } else {
        setHealthError(failureText(result.error))
      }
    } catch (error) {
      if (sessionRef.current === requestedSession && healthGeneration.current === generation && healthProjectRef.current === normalizedProjectId) setHealthError(String(error))
    } finally {
      if (sessionRef.current === requestedSession && healthGeneration.current === generation && healthProjectRef.current === normalizedProjectId) setHealthLoading(false)
    }
  }, [healthInbox, healthProjectId, sessionId])

  const acknowledge = useCallback(async (escalation: OperatorEscalation): Promise<void> => {
    const projectId = healthProjectId.trim()
    if (projectId === '') return
    const requestedSession = sessionId
    const projectEpoch = healthProjectEpoch.current
    setAcknowledging(current => new Set(current).add(escalation.id))
    try {
      const result = await acknowledgeHealth(requestedSession, projectId, escalation.id, escalation.revision)
      if (sessionRef.current !== requestedSession || healthProjectRef.current !== projectId || healthProjectEpoch.current !== projectEpoch) return
      if (!result.ok) {
        if (/stale|revision/i.test(result.error.message)) {
          await refreshHealth(projectId)
          if (sessionRef.current === requestedSession && healthProjectRef.current === projectId && healthProjectEpoch.current === projectEpoch) setHealthNotice(t('health.stale'))
        } else setHealthError(failureText(result.error))
        return
      }
      setHealth(current => current?.map(item => item.id === result.value.id && item.revision <= result.value.revision ? result.value : item) ?? current)
      setHealthError(null)
    } catch (error) {
      if (sessionRef.current === requestedSession && healthProjectRef.current === projectId && healthProjectEpoch.current === projectEpoch) setHealthError(String(error))
    } finally {
      if (sessionRef.current === requestedSession && healthProjectRef.current === projectId && healthProjectEpoch.current === projectEpoch) setAcknowledging(current => {
        const next = new Set(current)
        next.delete(escalation.id)
        return next
      })
    }
  }, [acknowledgeHealth, healthProjectId, refreshHealth, sessionId, t])

  const invalidateRefresh = useCallback((): void => {
    refreshGeneration.current += 1
    setLoading(false)
  }, [])

  const settleTask = useCallback(async (
    taskId: string,
    operation: () => Promise<TeamTaskActionResult>,
  ): Promise<TeamTask | undefined> => {
    const requestedSession = sessionId
    invalidateRefresh()
    setPendingTasks(current => new Set(current).add(taskId))
    try {
      const result = await operation()
      if (sessionRef.current !== requestedSession) return undefined
      if (!result.ok) {
        setError(failureText(result.error))
        return undefined
      }
      if (!result.value.ok) {
        if (result.value.error.code === 'team-task-conflict') {
          const reloaded = await refresh()
          if (sessionRef.current !== requestedSession) return undefined
          if (reloaded) setError(t('conflict'))
        } else {
          setError(failureText(result.value.error))
        }
        return undefined
      }
      const task = result.value.value
      setError(null)
      await refresh()
      if (sessionRef.current !== requestedSession) return undefined
      return task
    } finally {
      if (sessionRef.current === requestedSession) {
        setPendingTasks((current) => {
          const next = new Set(current)
          next.delete(taskId)
          return next
        })
      }
    }
  }, [invalidateRefresh, refresh, sessionId, t])

  const submitCreate = async (): Promise<void> => {
    const subject = createDraft.subject.trim()
    const description = createDraft.description.trim()
    /* v8 ignore next -- TaskForm disables Save while either normalized field is empty. */
    if (subject === '' || description === '') return
    const created = await settleTask('create', () => createTask(sessionId, {
      subject,
      description,
      blockedBy: taskIds(createDraft.blockers),
      writeScopes: items(createDraft.scopes),
    }))
    if (created === undefined) return
    setCreateDraft(EMPTY_DRAFT)
    setCreating(false)
  }

  const startEdit = (task: TeamTask): void => {
    setEditing(task.id)
    setEditDraft({
      subject: task.subject,
      description: task.description,
      blockers: task.blockedBy.join(', '),
      scopes: task.writeScopes.join(', '),
    })
  }

  const submitEdit = async (task: TeamTask): Promise<void> => {
    const requestedSession = sessionId
    const edited = await settleTask(task.id, () => updateTask(requestedSession, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'edit',
      subject: editDraft.subject.trim(),
      description: editDraft.description.trim(),
      writeScopes: items(editDraft.scopes),
    }))
    if (edited === undefined) return
    const blockedBy = taskIds(editDraft.blockers)
    if (blockedBy.length === edited.blockedBy.length
      && blockedBy.every((blocker, index) => blocker === edited.blockedBy[index])) {
      setEditing(null)
      return
    }
    const dependencyTask = await settleTask(task.id, () => updateTask(requestedSession, {
      taskId: task.id,
      expectedRevision: edited.revision,
      action: 'set_dependencies',
      blockedBy,
    }))
    if (dependencyTask === undefined) return
    setEditing(null)
  }

  const teammates = view?.members.filter(member => member.role === 'teammate') ?? []
  const assignable = view?.members.filter(member => member.status !== 'failed' && member.status !== 'provisioning') ?? []

  return (
    <div className={css.root} data-team-action>
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
        <IconUserOutline16 size={14} />
        <span>{t('trigger')}</span>
        {teammates.length > 0 && <span className={css.count}>{teammates.length}</span>}
      </button>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('trigger')}>
          <div className={css.toolbar}>
            <strong>{t('trigger')}</strong>
            <span className={css.spacer} />
            <button type="button" className={css.iconButton} aria-label={t('refresh')} onClick={() => { void refresh() }}>
              <IconRefreshOutline14 />
            </button>
            <button type="button" className={css.iconButton} aria-label={t('close')} onClick={() => { setOpen(false) }}>
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          {error !== null && <div className={css.error} role="alert">{error}</div>}
          {loading && view === null && <div className={css.notice}>{t('loading')}</div>}
          {view !== null && (
            <>
              <section>
                <h3>{t('roster')}</h3>
                <div className={css.roster}>
                  {view.members.map(member => (
                    <button
                      key={member.id}
                      type="button"
                      className={css.member}
                      disabled={member.role === 'lead' || member.status === 'failed' || member.status === 'provisioning'}
                      title={member.role === 'teammate' ? t('open') : undefined}
                      onClick={() => {
                        void openTeammate(sessionId, member).catch((reason: unknown) => { setError(String(reason)) })
                      }}
                    >
                      <StateDot state={member.status === 'running' ? 'ongoing' : member.status === 'failed' ? 'error' : 'done'} />
                      <span className={css.memberText}>
                        <span>{member.name}</span>
                        <small>{t(memberStatusKey(member.status))}{member.model === undefined ? '' : ` · ${t('model')}: ${member.model}`}</small>
                        {member.worktree !== undefined && <small>{t('worktree')}: {member.worktree.branch} · {t(`worktree.${member.worktree.phase}`)}</small>}
                        {member.recoveryAttempts !== undefined && <small>{t('recoveries')}: {member.recoveryAttempts}</small>}
                        {member.diagnostics.map(diagnostic => <small key={diagnostic} className={css.diagnostic}>{diagnostic}</small>)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <div className={css.sectionTitle}>
                  <h3>{t('tasks')}</h3>
                  <button type="button" className={css.smallButton} onClick={() => { setCreating(true) }}>
                    <IconPlusOutline16 size={13} /> {t('create')}
                  </button>
                </div>
                {creating && (
                  <TaskForm
                    draft={createDraft}
                    setDraft={setCreateDraft}
                    pending={pendingTasks.has('create')}
                    onSave={() => { void submitCreate() }}
                    onCancel={() => { setCreating(false) }}
                    t={t}
                  />
                )}
                {view.tasks.length === 0 && !creating && <div className={css.notice}>{t('empty')}</div>}
                <div className={css.tasks}>
                  {view.tasks.map(task => editing === task.id
                    ? (
                      <TaskForm
                        key={task.id}
                        draft={editDraft}
                        setDraft={setEditDraft}
                        pending={pendingTasks.has(task.id)}
                        onSave={() => { void submitEdit(task) }}
                        onCancel={() => { setEditing(null) }}
                        t={t}
                      />
                    )
                    : (
                      <article key={task.id} className={css.task}>
                        <div className={css.taskTitle}>
                          <strong>{task.subject}</strong>
                          <span>{t(statusKey(task.status))}</span>
                        </div>
                        <p>{task.description}</p>
                        {task.result !== undefined && <p><strong>{t('result')}:</strong> {task.result}</p>}
                        <div className={css.meta}>
                          <span>{task.id}</span>
                          {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
                          {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.join(', ')}</span>}
                          {task.writeScopes.length > 0 && <span>{t('writeScopes')}: {task.writeScopes.join(', ')}</span>}
                          {task.writeScopeWarnings.map(warning => <span key={warning} className={css.warning}>{warning}</span>)}
                        </div>
                        <div className={css.taskActions}>
                          <label>
                            {t('owner')}
                            <select
                              value={task.ownerName ?? ''}
                              disabled={pendingTasks.has(task.id) || task.status === 'completed'}
                              onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                                const owner = event.target.value
                                void settleTask(task.id, () => updateTask(sessionId, {
                                  taskId: task.id,
                                  expectedRevision: task.revision,
                                  action: 'reassign',
                                  ...owner === '' ? {} : { owner },
                                }))
                              }}
                            >
                              <option value="">{t('unowned')}</option>
                              {assignable.map(member => <option key={member.id} value={member.name}>{member.name}</option>)}
                            </select>
                          </label>
                          <button type="button" onClick={() => { startEdit(task) }} disabled={pendingTasks.has(task.id)}>
                            <IconEditOutline16 size={13} /> {t('edit')}
                          </button>
                          {task.status === 'in_progress' && (
                            <button type="button" disabled={pendingTasks.has(task.id)} onClick={() => {
                              setCompletion({ taskId: task.id, result: '' })
                            }}><IconCheckOutline14 /> {t('complete')}</button>
                          )}
                          {task.status === 'completed' && (
                            <button type="button" disabled={pendingTasks.has(task.id)} onClick={() => {
                              void settleTask(task.id, () => updateTask(sessionId, {
                                taskId: task.id, expectedRevision: task.revision, action: 'reopen',
                              }))
                            }}>{t('reopen')}</button>
                          )}
                          <button type="button" disabled={pendingTasks.has(task.id)} onClick={() => {
                            void settleTask(task.id, () => updateTask(sessionId, {
                              taskId: task.id, expectedRevision: task.revision, action: 'delete',
                            }))
                          }}><IconTrashOutline16 size={13} /> {t('delete')}</button>
                        </div>
                      </article>
                    ))}
                </div>
              </section>
              {view.batches.length > 0 && <section>
                <h3>{t('batches')}</h3>
                {view.batches.map(batch => <article key={batch.id} className={css.task}>
                  <strong>{batch.name}</strong>
                  <p>{batch.description}</p>
                  <div className={css.meta}>{t(`batch.${batch.status}`)} · {batch.completedTasks}/{batch.taskIds.length}</div>
                  <div className={css.meta}>{batch.taskIds.join(', ')}</div>
                </article>)}
              </section>}
              {view.integrations.length > 0 && <section>
                <h3>{t('integrations')}</h3>
                {view.integrations.map(job => <article key={job.id} className={css.task}>
                  <strong>{job.sourceBranch} → {job.targetBranch}</strong>
                  <p>{t(`integration.${job.phase}`)}</p>
                  <div className={css.meta}>{job.sourceCommit}</div>
                  {job.error !== undefined && <p className={css.warning}>{job.error}</p>}
                </article>)}
              </section>}
              <section aria-label={t('health.title')}>
                <div className={css.sectionTitle}>
                  <h3>{t('health.title')}</h3>
                  <button type="button" className={css.smallButton} disabled={healthLoading || healthProjectId.trim() === ''} onClick={() => { void refreshHealth() }}>{t('health.refresh')}</button>
                </div>
                <label className={css.healthProject}>
                  <span>{t('health.project')}</span>
                  <input aria-label={t('health.project')} value={healthProjectId} placeholder={t('health.projectPlaceholder')} onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    healthGeneration.current += 1
                    healthProjectEpoch.current += 1
                    setHealthProjectId(event.target.value)
                    setHealth(null)
                    setHealthLoading(false)
                    setHealthError(null)
                    setHealthNotice(null)
                    setAcknowledging(new Set())
                  }} />
                </label>
                {healthError !== null && <div className={css.error} role="alert">{healthError}</div>}
                {healthNotice !== null && <div className={css.notice} role="status">{healthNotice}</div>}
                {healthLoading && <div className={css.notice}>{t('health.loading')}</div>}
                {!healthLoading && healthProjectId.trim() !== '' && health?.length === 0 && <div className={css.notice}>{t('health.empty')}</div>}
                {health !== null && health.map(escalation => <article key={escalation.id} className={css.healthIncident}>
                  <div className={css.taskTitle}><strong>{t(`health.severity.${escalation.severity}`)}</strong><span>{escalation.source === 'darkfactory' ? `Dark Factory · ${escalation.stage} · ${escalation.reason}` : t(`health.condition.${escalation.condition}`)}</span></div>
                  <p>{escalation.diagnostics}</p>
                  <div className={css.meta}>{escalation.source === 'darkfactory' ? <><span>{escalation.projectId}</span><span>{escalation.effectId}</span></> : <><span>{escalation.work.taskId}</span><span>{escalation.attemptId}</span></>}</div>
                  {escalation.acknowledgement === undefined
                    ? <button type="button" className={css.smallButton} disabled={acknowledging.has(escalation.id)} onClick={() => { void acknowledge(escalation) }}>{t('health.acknowledge')}</button>
                    : <div className={css.meta}>{t('health.acknowledged')} · {escalation.acknowledgement.actor}</div>}
                </article>)}
              </section>
              {completion !== null && completionTask !== undefined && (
                <div className={css.taskForm} role="dialog" aria-label={t('completionEvidence')}>
                  <label>
                    <span>{t('completionEvidence')}</span>
                    <textarea
                      value={completion.result}
                      onChange={(event) => { setCompletion({ ...completion, result: event.target.value }) }}
                    />
                  </label>
                  <div className={css.taskActions}>
                    <button type="button" disabled={completion.result.trim() === '' || pendingTasks.has(completionTask.id)} onClick={() => {
                      const task = completionTask
                      void settleTask(task.id, () => updateTask(sessionId, {
                        taskId: task.id, expectedRevision: task.revision, action: 'complete', result: completion.result.trim(),
                      })).then((completed) => {
                        if (completed !== undefined) {
                          setCompletion(current => current === completion ? null : current)
                        }
                      })
                    }}>{t('complete')}</button>
                    <button type="button" onClick={() => { setCompletion(null) }}>{t('cancel')}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface TaskFormProps {
  draft: Draft
  setDraft: (draft: Draft) => void
  pending: boolean
  onSave: () => void
  onCancel: () => void
  t: TeamActionProps['t']
}

function TaskForm({ draft, setDraft, pending, onSave, onCancel, t }: TaskFormProps) {
  const field = (key: keyof Draft, value: string): void => { setDraft({ ...draft, [key]: value }) }
  return (
    <div className={css.form}>
      <input value={draft.subject} placeholder={t('subject')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('subject', event.target.value) }} />
      <textarea value={draft.description} placeholder={t('description')} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { field('description', event.target.value) }} />
      <input value={draft.blockers} placeholder={t('blockers')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('blockers', event.target.value) }} />
      <input value={draft.scopes} placeholder={t('scopes')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('scopes', event.target.value) }} />
      <div className={css.formActions}>
        <button type="button" disabled={pending || draft.subject.trim() === '' || draft.description.trim() === ''} onClick={onSave}>{t('save')}</button>
        <button type="button" disabled={pending} onClick={onCancel}>{t('cancel')}</button>
      </div>
    </div>
  )
}
