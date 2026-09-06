/** Durable, ordered Git candidate batching with bounded failure isolation. */

import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'
import { acquireIntegrationOwnership } from './integration-ownership.ts'
import { GitIntegrationProvider } from './git-integration-provider.ts'
import type { TeamCommitId, TeamIntegrationSpec } from './types.ts'

export interface MergeBatchSubmission {
  readonly id: string
  readonly spec: TeamIntegrationSpec
  /** Immutable submission IDs that must be accepted before this source can land. */
  readonly dependsOn: readonly string[]
  /** Accepted prerequisites are not merged again; the target must prove them. */
  readonly acceptedPrerequisites?: readonly { readonly id: string; readonly sourceCommit: TeamCommitId }[]
}

export interface MergeBatchPolicy {
  readonly maxCandidates: number
  readonly maxSplitAttempts: number
}

export interface MergeBatchOutcome {
  readonly state: 'pending' | 'accepted' | 'rejected' | 'blocked'
  readonly diagnostic?: string
}

interface BatchState {
  readonly id: string
  readonly submissions: MergeBatchSubmission[]
  readonly policy: MergeBatchPolicy
  readonly candidateDirectory: string
  readonly attempts: number
  readonly outcomes: Record<string, MergeBatchOutcome>
  readonly promotedCandidates: string[]
  /** Persisted after checks and before the non-transactional target update. */
  readonly prepared?: { readonly ids: string[]; readonly target: TeamCommitId; readonly candidate: TeamCommitId; readonly cwd: string }
}

type Event = { type: 'merge-batch/state'; state: BatchState }

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
const specSchema = z.object({ repository: z.string().min(1), cwd: z.string().min(1), sourceBranch: z.string().min(1), sourceCommit: commit,
  targetBranch: z.string().min(1), verification: z.array(z.object({ command: z.string().min(1), args: z.array(z.string()) }).strict()).min(1) }).strict()
const submissionSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), spec: specSchema,
  dependsOn: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u)).max(64),
  acceptedPrerequisites: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), sourceCommit: commit }).strict()).max(64).optional() }).strict()
const stateSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), submissions: z.array(submissionSchema).min(1).max(64),
  policy: z.object({ maxCandidates: z.number().int().positive().max(64), maxSplitAttempts: z.number().int().positive().max(256) }).strict(),
  candidateDirectory: z.string().min(1), attempts: z.number().int().nonnegative(), outcomes: z.record(z.string(), z.object({ state: z.enum(['pending', 'accepted', 'rejected', 'blocked']), diagnostic: z.string().min(1).optional() }).strict()),
  promotedCandidates: z.array(commit), prepared: z.object({ ids: z.array(z.string()).min(1), target: commit, candidate: commit, cwd: z.string().min(1) }).strict().optional() }).strict()

function copy<T>(value: T): T { return structuredClone(value) }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function withoutPrepared(state: BatchState): BatchState { const { prepared: _prepared, ...rest } = state; return rest }
function sameTarget(left: TeamIntegrationSpec, right: TeamIntegrationSpec): boolean {
  return left.repository === right.repository && left.targetBranch === right.targetBranch
    && JSON.stringify(left.verification) === JSON.stringify(right.verification)
}

/**
 * This journal owns one ordered group for a canonical repository/target.  A
 * composition receipt is written before promotion; replay can therefore call
 * the idempotent Git promotion again after a crash without making a second
 * merge.
 */
export class GitMergeBatch {
  private constructor(private readonly journal: DurableJournal<BatchState, Event>) {}

  static async create(directory: string, id: string, submissions: readonly MergeBatchSubmission[], policy: MergeBatchPolicy): Promise<GitMergeBatch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(id) || submissions.length === 0
      || !Number.isSafeInteger(policy.maxCandidates) || policy.maxCandidates < 1
      || !Number.isSafeInteger(policy.maxSplitAttempts) || policy.maxSplitAttempts < 1) throw new Error('Invalid merge batch configuration')
    if (submissions.length > policy.maxCandidates) throw new Error('Merge batch exceeds configured candidate limit')
    const first = submissions[0]!.spec
    const ids = new Set(submissions.map(submission => submission.id))
    if (ids.size !== submissions.length || submissions.some(submission => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(submission.id)
      || !sameTarget(first, submission.spec) || submission.dependsOn.some(dependency => !ids.has(dependency) || dependency === submission.id))) {
      throw new Error('Merge batch submissions must have unique IDs, one target, and in-batch dependencies')
    }
    for (const submission of submissions) for (const dependency of submission.dependsOn) {
      if (submissions.findIndex(value => value.id === dependency) >= submissions.indexOf(submission)) {
        throw new Error('Merge batch dependencies must precede their dependent submission')
      }
    }
    const filename = join(directory, 'merge-batches', `${id}.jsonl`)
    const initial: BatchState = { id, submissions: submissions.map(copy), policy: copy(policy), candidateDirectory: join(directory, 'merge-candidates', id), attempts: 0,
      outcomes: Object.fromEntries(submissions.map(submission => [submission.id, { state: 'pending' as const }])), promotedCandidates: [] }
    const empty: BatchState = { id, submissions: [], policy: copy(policy), candidateDirectory: initial.candidateDirectory, attempts: 0, outcomes: {}, promotedCandidates: [] }
    const journal = await DurableJournal.open<BatchState, Event>(filename, empty, (_prior, raw) => {
      const event = raw as Partial<Event>
      if (event.type !== 'merge-batch/state' || event.state === undefined) throw new Error('Invalid merge batch event')
      return copy(stateSchema.parse(event.state)) as unknown as BatchState
    })
    try {
      if (journal.snapshot().submissions.length === 0) await journal.append(() => ({ type: 'merge-batch/state', state: initial }))
      else if (JSON.stringify(journal.snapshot().submissions) !== JSON.stringify(initial.submissions) || JSON.stringify(journal.snapshot().policy) !== JSON.stringify(initial.policy)) {
        throw new Error('Merge batch replay has different immutable inputs')
      }
      return new GitMergeBatch(journal)
    } catch (error) { await journal.close(); throw error }
  }

  static async open(directory: string, id: string): Promise<GitMergeBatch> {
    const filename = join(directory, 'merge-batches', `${id}.jsonl`)
    // The first event is a full durable snapshot, so a dummy state is safe only
    // until replay validates and replaces it.
    const dummy = { id, submissions: [], policy: { maxCandidates: 1, maxSplitAttempts: 1 }, candidateDirectory: '', attempts: 0, outcomes: {}, promotedCandidates: [] }
    const journal = await DurableJournal.open<BatchState, Event>(filename, dummy, (_prior, raw) => {
      const event = raw as Partial<Event>
      if (event.type !== 'merge-batch/state' || event.state === undefined || event.state.id !== id) throw new Error('Invalid merge batch event')
      return copy(stateSchema.parse(event.state)) as unknown as BatchState
    })
    if (journal.snapshot().submissions.length === 0) {
      await journal.close()
      throw new Error('Merge batch journal has no creation snapshot')
    }
    return new GitMergeBatch(journal)
  }

  inspect(): Readonly<BatchState> { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }

  async run(provider: GitIntegrationProvider, signal: AbortSignal, hooks: { beforePromotion?: () => Promise<void> | void; afterPromotion?: () => Promise<void> | void } = {}): Promise<Readonly<BatchState>> {
    const state = this.journal.snapshot()
    const first = state.submissions[0]!.spec
    const release = await acquireIntegrationOwnership(first.repository, first.targetBranch, signal)
    try {
      const prepared = this.journal.snapshot().prepared
      if (prepared !== undefined) {
        const selected = this.journal.snapshot().submissions.filter(submission => prepared.ids.includes(submission.id))
        try {
          await provider.promote(selected[0]!.spec, prepared.target, prepared.candidate, signal)
          await this.update(current => ({ ...withoutPrepared(current), promotedCandidates: [...current.promotedCandidates, prepared.candidate], outcomes: Object.fromEntries(Object.entries(current.outcomes).map(([id, outcome]) =>
            prepared.ids.includes(id) ? [id, { state: 'accepted' as const }] : [id, outcome])) }))
        } catch (error) {
          if (!message(error).includes('target moved')) throw error
          await this.update(current => withoutPrepared(current))
        }
      }
      const pending = state.submissions.filter(submission => this.journal.snapshot().outcomes[submission.id]!.state === 'pending').map(submission => submission.id)
      if (pending.length) await this.isolate(provider, pending, signal, hooks)
      return this.journal.snapshot()
    } finally { await release() }
  }

  private async isolate(provider: GitIntegrationProvider, ids: readonly string[], signal: AbortSignal, hooks: { beforePromotion?: () => Promise<void> | void; afterPromotion?: () => Promise<void> | void }): Promise<void> {
    const state = this.journal.snapshot()
    const selected = state.submissions.filter(submission => ids.includes(submission.id))
    if (selected.length === 0) return
    // A prerequisite selected earlier in this same ordered composition is
    // valid even while it is still pending. Only omitted or terminally
    // excluded prerequisites hold a dependent back.
    const excluded = selected.find(submission => submission.dependsOn.some(dependency =>
      state.outcomes[dependency]?.state !== 'accepted' && (!ids.includes(dependency) || ['rejected', 'blocked'].includes(state.outcomes[dependency]?.state ?? 'blocked'))))
    if (excluded) {
      await this.setOutcome(excluded.id, 'blocked', `Prerequisite ${excluded.dependsOn.find(dependency => state.outcomes[dependency]?.state !== 'accepted')} was excluded from this merge batch`)
      await this.isolate(provider, ids.filter(id => id !== excluded.id), signal, hooks)
      return
    }
    if (state.attempts >= state.policy.maxSplitAttempts) {
      for (const id of ids) await this.setOutcome(id, 'blocked', `Merge batch split budget exhausted (${state.policy.maxSplitAttempts})`)
      return
    }
    const next = await this.update(current => ({ ...current, attempts: current.attempts + 1 }))
    const cwd = join(next.candidateDirectory, `composition-${next.attempts}`)
    const target = await provider.target(selected[0]!.spec, signal)
    // `Array.find` cannot await its predicate. Keep the proof explicit and
    // serial: a stale accepted receipt must never be treated as target state.
    for (const submission of selected) for (const prerequisite of [...submission.acceptedPrerequisites ?? [],
      ...submission.dependsOn.filter(id => state.outcomes[id]?.state === 'accepted').map(id => ({ id, sourceCommit: state.submissions.find(item => item.id === id)!.spec.sourceCommit }))]) {
      if (!await provider.contains(submission.spec, target, prerequisite.sourceCommit, signal)) {
        await this.setOutcome(submission.id, 'blocked', `Accepted prerequisite ${prerequisite.id} is absent from the current target`)
        await this.isolate(provider, ids.filter(id => id !== submission.id), signal, hooks)
        return
      }
    }
    let candidate: TeamCommitId
    try { candidate = await provider.verifyStack(selected.map(item => item.spec), target, cwd, signal) }
    catch (error) {
      if (selected.length === 1) await this.setOutcome(selected[0]!.id, 'rejected', message(error))
      else {
        const middle = Math.ceil(selected.length / 2)
        await this.isolate(provider, selected.slice(0, middle).map(item => item.id), signal, hooks)
        await this.isolate(provider, selected.slice(middle).map(item => item.id), signal, hooks)
      }
      return
    }
    await this.update(current => ({ ...current, prepared: { ids: [...ids], target, candidate, cwd } }))
    try {
      await hooks.beforePromotion?.()
      await provider.promote(selected[0]!.spec, target, candidate, signal)
      await hooks.afterPromotion?.()
      await this.update(current => ({ ...withoutPrepared(current), promotedCandidates: [...current.promotedCandidates, candidate], outcomes: Object.fromEntries(Object.entries(current.outcomes).map(([id, outcome]) =>
        ids.includes(id) ? [id, { state: 'accepted' as const }] : [id, outcome])) }))
    } catch (error) {
      // A new target invalidates this exact composition. Re-enter through a
      // fresh target read; never promote checks made against an older target.
      if (message(error).includes('target moved')) {
        await this.update(current => withoutPrepared(current))
        return await this.isolate(provider, ids, signal, hooks)
      }
      throw error
    }
  }

  private async setOutcome(id: string, state: MergeBatchOutcome['state'], diagnostic?: string): Promise<void> {
    await this.update(current => ({ ...current, outcomes: { ...current.outcomes, [id]: { state, ...(diagnostic === undefined ? {} : { diagnostic }) } } }))
  }

  private async update(update: (state: BatchState) => BatchState): Promise<BatchState> {
    return await this.journal.append(state => ({ type: 'merge-batch/state', state: update(state) }))
  }
}
