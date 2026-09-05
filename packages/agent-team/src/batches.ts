/** Durable named task batches whose progress derives from the task board. */

import type { TeamMembership } from './roster.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { TeamError } from './error.ts'
import { TeamBatchId, TeamId } from './types.ts'
import type { CreateTeamBatchRequest, TeamBatchSnapshot, TeamBatchView, TeamTaskId, UpdateTeamBatchRequest } from './types.ts'
import { requiredText } from './validation.ts'

/** Owns batch admission, compare-and-set edits, and derived progress. */
export class TeamBatches {
  /**
   * @param journal - authoritative Team transactions.
   * @param maxBatches - maximum non-archived batch count.
   * @param maxTextLength - normalized name and description limit.
   */
  constructor(
    private readonly journal: TeamJournal,
    private readonly maxBatches: number,
    private readonly maxTextLength: number,
  ) {}

  /**
   * Create a durable task batch under Lead authority.
   * @param membership - exact caller membership.
   * @param request - name, description, and current task ids.
   * @returns committed batch and current task progress.
   */
  async create(membership: TeamMembership, request: CreateTeamBatchRequest): Promise<TeamBatchView> {
    this.assertLead(membership)
    const { root } = membership
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      if (state.batches.filter(batch => !batch.archived).length >= this.maxBatches) {
        throw new TeamError('Team batch limit reached', 'TEAM_BATCH_LIMIT')
      }
      const id = TeamBatchId(`batch-${state.nextBatchNumber}`)
      if (state.batches.some(batch => batch.id === id)) throw new TeamError('Team batch id space exhausted', 'TEAM_BATCH_LIMIT')
      const batch: TeamBatchSnapshot = {
        id, revision: 1,
        name: requiredText(request.name, 'name', this.maxTextLength),
        description: requiredText(request.description, 'description', this.maxTextLength),
        taskIds: this.taskIds(state, request.taskIds),
        archived: false,
      }
      await this.journal.appendAndFlush(root, 'team/batch', { version: 1, teamId: TeamId(root.id), batch })
      return this.view(state, batch)
    })
  }

  /**
   * Edit or archive a batch with its current revision.
   * @param membership - exact Lead authority.
   * @param request - batch identity, revision, and replacement fields.
   * @returns committed batch and derived progress.
   */
  async update(membership: TeamMembership, request: UpdateTeamBatchRequest): Promise<TeamBatchView> {
    this.assertLead(membership)
    const { root } = membership
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = state.batches.find(batch => batch.id === request.batchId)
      if (current === undefined) throw new TeamError('Team batch not found', 'TEAM_BATCH_NOT_FOUND')
      if (current.revision !== request.expectedRevision) throw new TeamError('stale Team batch revision', 'TEAM_BATCH_STALE_REVISION')
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new TeamError('Team batch revision space exhausted', 'TEAM_BATCH_LIMIT')
      if (current.archived) throw new TeamError('archived Team batches cannot change', 'TEAM_BATCH_ARCHIVED')
      if (request.name === undefined && request.description === undefined && request.taskIds === undefined && request.archive !== true) {
        throw new TeamError('batch update requires replacement fields or archive', 'TEAM_INVALID_ARGUMENT')
      }
      const batch: TeamBatchSnapshot = {
        ...current,
        revision: current.revision + 1,
        ...request.name === undefined ? {} : { name: requiredText(request.name, 'name', this.maxTextLength) },
        ...request.description === undefined ? {} : { description: requiredText(request.description, 'description', this.maxTextLength) },
        ...request.taskIds === undefined ? {} : { taskIds: this.taskIds(state, request.taskIds) },
        archived: request.archive === true,
      }
      await this.journal.appendAndFlush(root, 'team/batch', { version: 1, teamId: TeamId(root.id), batch })
      return this.view(state, batch)
    })
  }

  /**
   * Read all batches, retaining archived ledger entries.
   * @param membership - exact Team member.
   * @returns detached batch views in creation order.
   */
  list(membership: TeamMembership): TeamBatchView[] {
    const state = this.journal.state(membership.root)
    return state.batches.map(batch => this.view(state, batch))
  }

  private assertLead(membership: TeamMembership): void {
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can change batches', 'TEAM_LEAD_REQUIRED')
  }

  private taskIds(state: TeamState, ids: readonly TeamTaskId[]): TeamTaskId[] {
    if (new Set(ids).size !== ids.length) throw new TeamError('batch task ids must be unique', 'TEAM_INVALID_ARGUMENT')
    for (const id of ids) {
      if (!state.tasks.some(task => task.id === id && task.status !== 'deleted')) {
        throw new TeamError(`batch task "${id}" is missing or deleted`, 'TEAM_TASK_NOT_FOUND')
      }
    }
    return [...ids]
  }

  private view(state: TeamState, batch: TeamBatchSnapshot): TeamBatchView {
    const completedTasks = batch.taskIds.filter(id => state.tasks.some(task => task.id === id && task.status === 'completed')).length
    return {
      ...batch,
      taskIds: [...batch.taskIds],
      completedTasks,
      status: batch.archived ? 'archived' : batch.taskIds.length > 0 && completedTasks === batch.taskIds.length ? 'completed' : 'active',
    }
  }
}
