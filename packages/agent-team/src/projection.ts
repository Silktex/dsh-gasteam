/** Host-only Team state projected incrementally from committed Session events. */

import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  TeamId,
  TeamMemberSnapshot,
  TeamMessageId,
  TeamMessageSnapshot,
  TeamTaskSnapshot,
  TeamWorktreeSnapshot,
  TeamBatchSnapshot,
  TeamRecoverySnapshot,
  TeamIntegrationSnapshot,
  TeamBatchId,
  TeamBranchName,
  TeamCommitId,
} from './types.ts'
import {
  TeamId as toTeamId,
  TeamMessageId as toTeamMessageId,
  TeamTaskId as toTeamTaskId,
} from './types.ts'
import { integrationSchema, assertIntegrationTransition } from './integration-projection.ts'
import { assertTaskGraphCandidate } from './task-graph.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = nonNegativeSafeInteger.min(1)
const sessionIdSchema = z.string().min(1).transform(value => brandString<SessionId>(value))
const teamIdSchema = z.string().min(1).transform(value => toTeamId(value))
const numericTaskIdPattern = /^task-(\d+)$/u
const teamTaskIdSchema = z.string().min(1).refine((value) => {
  const match = numericTaskIdPattern.exec(value)
  return match === null || Number.isSafeInteger(Number(match[1]))
}, { message: 'numeric task id suffix must be a safe integer' }).transform(value => toTeamTaskId(value))
const teamMessageIdSchema = z.string().min(1).transform(value => toTeamMessageId(value))

const coreContentBlockTypes = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])
const imageAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: nonNegativeSafeInteger,
  width: positiveSafeInteger,
  height: positiveSafeInteger,
  name: z.string().optional(),
}).strict()

// ContentBlockMap is merge-extensible. Validate every core variant exactly,
// while retaining JSON-decoded plugin variants under an unknown type tag.
const contentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() => z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), attachment: imageAttachmentSchema }).strict(),
  z.object({
    type: z.literal('tool-call'),
    id: z.string().min(1),
    name: z.string(),
    arguments: z.string(),
  }).strict(),
  z.object({
    type: z.literal('tool-result'),
    toolCallId: z.string().min(1),
    content: z.array(contentBlockSchema),
    isError: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.string().min(1) }).loose().refine(
    block => !coreContentBlockTypes.has(block.type),
    { message: 'known content block types must match their declared fields' },
  ),
])) as z.ZodType<ContentBlock>

const teamMemberSnapshotSchema = z.object({
  id: sessionIdSchema,
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  context: z.enum(['fresh', 'fork']),
  phase: z.enum(['provisioning', 'active', 'failed']),
  error: z.string().optional(),
}).strict() as z.ZodType<TeamMemberSnapshot>

const teamTaskSnapshotSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  nonCodeCriteria: z.string().min(1).refine(value => value.trim().length > 0).optional(),
  reviewGate: z.string().min(1).max(128).refine(value => value.trim().length > 0).optional(),
  reviewBinding: z.object({ projectId: z.string().min(1), teamId: z.string().min(1), executionId: z.string().min(1), candidateRound: z.number().int().nonnegative(),
    integrationId: z.string().min(1), sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), targetCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    candidateCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), reviewGate: z.string().min(1).max(128) }).strict().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerId: sessionIdSchema.optional(),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
  result: z.string().min(1).refine(value => value.trim().length > 0).optional(),
}).strict() as z.ZodType<TeamTaskSnapshot>

const teamRecoverySnapshotSchema = z.object({
  memberId: sessionIdSchema,
  attempt: positiveSafeInteger,
  observedEventCount: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().min(1),
}).strict() as z.ZodType<TeamRecoverySnapshot>

const teamIntegrationEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema, integration: integrationSchema,
}).strict() as z.ZodType<SessionEventMap['team/integration']>

const teamRecoveryEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema, recovery: teamRecoverySnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/recovery']>

const teamBatchSnapshotSchema = z.object({
  id: z.string().min(1).transform(value => brandString<TeamBatchId>(value)),
  revision: positiveSafeInteger,
  name: z.string().min(1),
  description: z.string().min(1),
  taskIds: z.array(teamTaskIdSchema),
  archived: z.boolean(),
}).strict() as z.ZodType<TeamBatchSnapshot>

const teamBatchEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema, batch: teamBatchSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/batch']>

const teamWorktreeSnapshotSchema = z.object({
  memberId: sessionIdSchema,
  provider: z.string().min(1),
  repository: z.string().refine(isAbsolute),
  cwd: z.string().refine(isAbsolute),
  branch: z.string().min(1).transform(value => brandString<TeamBranchName>(value)),
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).transform(value => brandString<TeamCommitId>(value)),
  phase: z.enum(['reserved', 'ready', 'released']),
}).strict() as z.ZodType<TeamWorktreeSnapshot>

const teamWorktreeEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  worktree: teamWorktreeSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/worktree']>

const teamMessageSnapshotSchema = z.object({
  id: teamMessageIdSchema,
  senderId: sessionIdSchema,
  senderName: z.string(),
  targetId: sessionIdSchema,
  delivery: z.enum(['quiet', 'wakeup']),
  content: z.array(contentBlockSchema),
}).strict() as z.ZodType<TeamMessageSnapshot>

const teamEventSelectorSchema = z.object({
  version: nonNegativeSafeInteger,
  teamId: teamIdSchema,
}).loose()

const teamMemberEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  member: teamMemberSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/member']>

const teamTaskEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  task: teamTaskSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/task']>

const teamMessageQueuedEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  message: teamMessageSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/queued']>

const teamMessageDeliveredEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  messageId: teamMessageIdSchema,
  targetId: sessionIdSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/delivered']>

/** Current Team state selected by durable Team identity. */
export interface TeamState {
  readonly id: TeamId
  readonly members: TeamMemberSnapshot[]
  readonly tasks: TeamTaskSnapshot[]
  readonly worktrees: TeamWorktreeSnapshot[]
  readonly batches: TeamBatchSnapshot[]
  readonly integrations: TeamIntegrationSnapshot[]
  readonly recoveries: TeamRecoverySnapshot[]
  nextBatchNumber: number
  readonly messages: TeamMessageSnapshot[]
  readonly delivered: TeamMessageId[]
  nextTaskNumber: number
}

/**
 * Construct empty state for one Team identity.
 * @param rootId - root Session identity.
 * @returns mutable empty Team state.
 */
export function emptyTeamState(rootId: SessionId): TeamProjectionState {
  return {
    id: toTeamId(rootId),
    members: [],
    tasks: [],
    worktrees: [],
    batches: [],
    recoveries: [],
    integrations: [],
    nextBatchNumber: 1,
    messages: [],
    delivered: [],
    nextTaskNumber: 1,
  }
}

/** Checkpoint-safe state for the Team owned by the projected Session. */
export interface TeamProjectionState extends TeamState {
  failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentTeam: TeamProjectionState
  }
}

const teamProjectionEntrySchema = z.object({
  id: teamIdSchema,
  members: z.array(teamMemberSnapshotSchema),
  tasks: z.array(teamTaskSnapshotSchema),
  worktrees: z.array(teamWorktreeSnapshotSchema),
  batches: z.array(teamBatchSnapshotSchema),
  integrations: z.array(integrationSchema),
  recoveries: z.array(teamRecoverySnapshotSchema),
  nextBatchNumber: positiveSafeInteger,
  messages: z.array(teamMessageSnapshotSchema),
  delivered: z.array(teamMessageIdSchema),
  nextTaskNumber: positiveSafeInteger,
  failure: z.string().optional(),
}).strict() as z.ZodType<TeamProjectionState>

/** Whether one event belongs to the Team domain. */
export type TeamEventType =
  | 'team/member'
  | 'team/task'
  | 'team/worktree'
  | 'team/batch'
  | 'team/recovery'
  | 'team/integration'
  | 'team/message/queued'
  | 'team/message/delivered'

/** One event owned by the Team domain. */
type TeamSessionEvent = SessionEvent<TeamEventType>

/**
 * Test whether a Session event belongs to the Team domain.
 * @param event - candidate Session event.
 * @returns whether the event has a Team-owned type.
 */
export function isTeamEvent(event: SessionEvent): event is TeamSessionEvent {
  return event.type === 'team/member'
    || event.type === 'team/task'
    || event.type === 'team/worktree'
    || event.type === 'team/batch'
    || event.type === 'team/recovery'
    || event.type === 'team/integration'
    || event.type === 'team/message/queued'
    || event.type === 'team/message/delivered'
}

/** Decode one persisted Team value and retain the schema failure as its cause. */
function parsePersisted<T>(type: TeamEventType, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (error: unknown) {
    throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error })
  }
}

/** Decode the complete current-version payload selected by one Team event type. */
function parseCurrentTeamEvent(event: TeamSessionEvent): TeamSessionEvent {
  switch (event.type) {
    case 'team/member':
      return { ...event, data: parsePersisted(event.type, teamMemberEventSchema, event.data) }
    case 'team/integration':
      return { ...event, data: parsePersisted(event.type, teamIntegrationEventSchema, event.data) }
    case 'team/recovery':
      return { ...event, data: parsePersisted(event.type, teamRecoveryEventSchema, event.data) }
    case 'team/batch':
      return { ...event, data: parsePersisted(event.type, teamBatchEventSchema, event.data) }
    case 'team/worktree':
      return { ...event, data: parsePersisted(event.type, teamWorktreeEventSchema, event.data) }
    case 'team/task':
      return { ...event, data: parsePersisted(event.type, teamTaskEventSchema, event.data) }
    case 'team/message/queued':
      return { ...event, data: parsePersisted(event.type, teamMessageQueuedEventSchema, event.data) }
    case 'team/message/delivered':
      return { ...event, data: parsePersisted(event.type, teamMessageDeliveredEventSchema, event.data) }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return assertNever(event)
  }
}

function applyProjectionEvent(state: TeamProjectionState, event: SessionEvent): void {
  if (state.failure !== undefined) return
  if (!isTeamEvent(event)) return
  try {
    const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data)
    if (selector.teamId !== state.id) return
    if (selector.version !== 1) {
      throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`)
    }
    applyCurrentTeamEvent(state, parseCurrentTeamEvent(event))
  } catch (error: unknown) {
    /* v8 ignore next -- the owned Team transition throws Error instances. */
    state.failure = error instanceof Error ? error.message : String(error)
  }
}

function applyCurrentTeamEvent(state: TeamState, event: TeamSessionEvent): void {
  switch (event.type) {
    case 'team/member': {
      const member = event.data.member
      const index = state.members.findIndex(candidate => candidate.id === member.id)
      const prior = state.members[index]
      const named = state.members.find(candidate => candidate.name === member.name)
      if (named !== undefined && named.id !== member.id) {
        throw new Error(`teammate name "${member.name}" is reused by another member`)
      }
      if (prior === undefined) {
        if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
      } else {
        if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) {
          throw new Error(`teammate "${member.id}" changed immutable identity fields`)
        }
        if (prior.phase !== 'provisioning' || member.phase === 'provisioning') {
          throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
        }
      }
      if (index < 0) state.members.push(member)
      else state.members[index] = member
      break
    }
    case 'team/integration': {
      const integration = event.data.integration
      const index = state.integrations.findIndex(candidate => candidate.id === integration.id)
      if (!state.worktrees.some(worktree => worktree.memberId === integration.memberId
        && worktree.repository === integration.repository && worktree.branch === integration.sourceBranch)) {
        throw new Error('Team integration has no matching worker workspace')
      }
      if (state.integrations.some(candidate => candidate.id !== integration.id
        && [candidate.cwd, ...(candidate.previousCandidates ?? []).map(round => round.cwd)].includes(integration.cwd))) {
        throw new Error('Team integration candidate directory is already owned')
      }
      assertIntegrationTransition(state.integrations[index], integration)
      if (index < 0) state.integrations.push(integration)
      else state.integrations[index] = integration
      break
    }
    case 'team/recovery': {
      const recovery = event.data.recovery
      const index = state.recoveries.findIndex(candidate => candidate.memberId === recovery.memberId)
      if (!state.members.some(member => member.id === recovery.memberId && member.phase === 'active')
        || recovery.attempt !== (state.recoveries[index]?.attempt ?? 0) + 1) {
        throw new Error('invalid Team recovery owner or attempt sequence')
      }
      if (index < 0) state.recoveries.push(recovery)
      else state.recoveries[index] = recovery
      break
    }
    case 'team/batch': {
      const batch = event.data.batch
      const index = state.batches.findIndex(candidate => candidate.id === batch.id)
      const prior = state.batches[index]
      if (prior === undefined ? batch.revision !== 1 || batch.archived : prior.archived || batch.revision !== prior.revision + 1) {
        throw new Error('invalid Team batch revision or archive transition')
      }
      if (new Set(batch.taskIds).size !== batch.taskIds.length
        || batch.taskIds.some(id => !state.tasks.some(task => task.id === id && task.status !== 'deleted'))) {
        throw new Error('Team batch contains duplicate, missing, or deleted tasks')
      }
      const match = /^batch-(\d+)$/u.exec(batch.id)
      if (match !== null) {
        const number = Number(match[1])
        if (!Number.isSafeInteger(number)) throw new Error('Team batch id exceeds safe integer range')
        state.nextBatchNumber = Math.max(state.nextBatchNumber, Math.min(number + 1, Number.MAX_SAFE_INTEGER))
      }
      if (index < 0) state.batches.push(batch)
      else state.batches[index] = batch
      break
    }
    case 'team/worktree': {
      const worktree = event.data.worktree
      const index = state.worktrees.findIndex(candidate => candidate.memberId === worktree.memberId)
      const prior = state.worktrees[index]
      if (!state.members.some(member => member.id === worktree.memberId)) {
        throw new Error(`worktree owner "${worktree.memberId}" is not a Team member`)
      }
      if (prior === undefined) {
        if (worktree.phase !== 'reserved') throw new Error('Team worktree must begin reserved')
        if (state.worktrees.some(candidate => candidate.cwd === worktree.cwd
          || candidate.repository === worktree.repository && candidate.branch === worktree.branch)) {
          throw new Error('Team worktree path or branch is already owned')
        }
      } else {
        if (prior.provider !== worktree.provider || prior.repository !== worktree.repository
          || prior.cwd !== worktree.cwd || prior.branch !== worktree.branch || prior.baseCommit !== worktree.baseCommit) {
          throw new Error('Team worktree changed immutable creation inputs')
        }
        if (prior.phase === 'released' || worktree.phase === 'reserved'
          || prior.phase === worktree.phase) throw new Error('invalid Team worktree transition')
      }
      if (index < 0) state.worktrees.push(worktree)
      else state.worktrees[index] = worktree
      break
    }
    case 'team/task': {
      const task = event.data.task
      const index = state.tasks.findIndex(candidate => candidate.id === task.id)
      const prior = state.tasks[index]
      if (prior === undefined && task.revision !== 1) {
        throw new Error(`team task "${task.id}" must begin at revision 1`)
      }
      if (prior !== undefined && task.revision !== prior.revision + 1) {
        throw new Error(`team task "${task.id}" revision is not contiguous`)
      }
      if (prior !== undefined && prior.nonCodeCriteria !== task.nonCodeCriteria) {
        throw new Error(`team task "${task.id}" changed immutable non-code criteria`)
      }
      if (prior !== undefined && prior.reviewGate !== task.reviewGate) {
        throw new Error(`team task "${task.id}" changed immutable integration review gate`)
      }
      if (prior !== undefined && JSON.stringify(prior.reviewBinding) !== JSON.stringify(task.reviewBinding)) {
        throw new Error(`team task "${task.id}" changed immutable workflow review binding`)
      }
      if (task.nonCodeCriteria !== undefined && task.reviewGate !== undefined) {
        throw new Error(`team task "${task.id}" combines report criteria and integration review gate`)
      }
      if (task.status === 'completed' && task.result === undefined) {
        throw new Error(`completed team task "${task.id}" has no result evidence`)
      }
      if (task.status !== 'completed' && task.result !== undefined) {
        throw new Error(`non-completed team task "${task.id}" retains result evidence`)
      }
      if (task.status === 'deleted' && state.batches.some(batch => !batch.archived && batch.taskIds.includes(task.id))) {
        throw new Error('deleted task belongs to an active Team batch')
      }
      assertTaskGraphCandidate(state.tasks, task)
      const match = numericTaskIdPattern.exec(task.id)
      if (match !== null) {
        const number = Number(match[1])
        state.nextTaskNumber = Math.max(
          state.nextTaskNumber,
          number === Number.MAX_SAFE_INTEGER ? number : number + 1,
        )
      }
      if (index < 0) state.tasks.push(task)
      else state.tasks[index] = task
      break
    }
    case 'team/message/queued': {
      const message = event.data.message
      if (state.messages.some(candidate => candidate.id === message.id)) {
        throw new Error(`team message "${message.id}" was queued twice`)
      }
      state.messages.push(message)
      break
    }
    case 'team/message/delivered': {
      const queued = state.messages.find(message => message.id === event.data.messageId)
      if (queued === undefined) throw new Error(`team message "${event.data.messageId}" was delivered before queueing`)
      if (queued.targetId !== event.data.targetId) throw new Error(`team message "${event.data.messageId}" target changed`)
      if (state.delivered.includes(event.data.messageId)) throw new Error(`team message "${event.data.messageId}" was delivered twice`)
      state.delivered.push(event.data.messageId)
      break
    }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      assertNever(event)
  }
}

/** Host-only Team projection selected by the projected Session identity. */
export const teamProjectionDefinition = {
  key: 'agentTeam',
  stateVersion: 3,
  stateSchema: teamProjectionEntrySchema,
  init: header => emptyTeamState(header.id),
  apply: (state, event) => {
    applyProjectionEvent(state, event)
    return state
  },
} satisfies ProjectionDefinition<'agentTeam', TeamProjectionState>
