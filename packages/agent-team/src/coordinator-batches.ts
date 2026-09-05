/** Durable workspace-wide batch state. Coordinator wiring supplies authoritative task observations. */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
const text = z.string().trim().min(1).max(16_384)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const taskRefSchema = z.object({ projectId: id, teamId: id, taskId: id }).strict()
const stateSchema = z.enum(['waiting', 'active', 'blocked', 'failed', 'accepted'])
const itemSchema = z.object({ ref: taskRefSchema, dependsOn: z.array(taskRefSchema).max(256).default([]) }).strict()
const subscriptionSchema = z.object({ id, destination: text }).strict()
const observationSchema = z.object({ ref: taskRefSchema, revision: positive, state: stateSchema, activeAssignment: z.boolean() }).strict()

export type WorkspaceTaskRef = z.output<typeof taskRefSchema>
export type WorkspaceTaskAcceptanceState = z.output<typeof stateSchema>
export interface WorkspaceBatchItem { readonly ref: WorkspaceTaskRef; readonly dependsOn?: readonly WorkspaceTaskRef[] | undefined }
export interface CreateWorkspaceBatchRequest { readonly id?: string | undefined; readonly name: string; readonly items: readonly WorkspaceBatchItem[]; readonly subscriptions?: readonly { readonly id: string; readonly destination: string }[] | undefined }
export interface WorkspaceTaskObservation { readonly ref: WorkspaceTaskRef; readonly revision: number; readonly state: WorkspaceTaskAcceptanceState; readonly activeAssignment: boolean }
export interface WorkspaceBatchNotification { readonly intentId: string; readonly batchId: string; readonly subscriptionId: string; readonly destination: string; readonly completionEpoch: number }

const historySchema = z.object({ state: stateSchema, activeAssignment: z.boolean(), at: positive }).strict()
const storedItemSchema = itemSchema.extend({ observationRevision: z.number().int().nonnegative(), state: stateSchema, activeAssignment: z.boolean(), history: z.array(historySchema).max(1024) }).strict()
const notificationSchema = z.object({ intentId: id, batchId: id, subscriptionId: id, destination: text, completionEpoch: z.number().int().positive(), receipt: text.optional(), suppressed: z.literal(true).optional() }).strict()
const batchSchema = z.object({ id, name: text, items: z.array(storedItemSchema).min(1).max(1024), subscriptions: z.array(subscriptionSchema).max(256),
  phase: z.enum(['active', 'blocked', 'failed', 'completed']), completionEpoch: z.number().int().nonnegative(), history: z.array(z.object({ phase: z.enum(['completed', 'reopened', 'failed']), at: positive }).strict()).max(1024),
}).strict()
type Batch = z.output<typeof batchSchema>
interface State { readonly batches: Batch[]; readonly notifications: z.output<typeof notificationSchema>[] }
const envelope = { version: z.literal(1), sequence: positive }
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('batch/created'), batch: batchSchema }).strict(),
  z.object({ ...envelope, type: z.literal('batch/subscribed'), batchId: id, subscription: subscriptionSchema }).strict(),
  z.object({ ...envelope, type: z.literal('batch/observed'), batchId: id, observations: z.array(observationSchema).min(1).max(1024), at: positive }).strict(),
  z.object({ ...envelope, type: z.literal('batch/notification-intended'), notification: notificationSchema.omit({ receipt: true }) }).strict(),
  z.object({ ...envelope, type: z.literal('batch/notification-receipted'), intentId: id, receipt: text }).strict(),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, 'version' | 'sequence'> : never : never

function key(ref: WorkspaceTaskRef): string { return `${ref.projectId}\u0000${ref.teamId}\u0000${ref.taskId}` }
function sameRef(left: WorkspaceTaskRef, right: WorkspaceTaskRef): boolean { return key(left) === key(right) }
function get(state: State, batchId: string): Batch {
  const batch = state.batches.find(value => value.id === batchId)
  if (!batch) throw new Error('Workspace batch is missing')
  return batch
}
function replace(state: State, batch: Batch): State { return { ...state, batches: state.batches.map(value => value.id === batch.id ? batch : value) } }
function derive(items: readonly z.output<typeof storedItemSchema>[]): Batch['phase'] {
  if (items.every(item => item.state === 'accepted')) return 'completed'
  if (items.some(item => item.state === 'failed')) return 'failed'
  if (items.some(item => item.state === 'blocked')) return 'blocked'
  return 'active'
}
function validateGraph(items: readonly z.output<typeof itemSchema>[]): void {
  const byKey = new Map(items.map(item => [key(item.ref), item]))
  if (byKey.size !== items.length) throw new Error('Workspace batch repeats a global task reference')
  for (const item of items) {
    if (new Set(item.dependsOn.map(key)).size !== item.dependsOn.length) throw new Error('Workspace batch repeats a dependency')
    for (const dependency of item.dependsOn) if (!byKey.has(key(dependency))) throw new Error('Workspace batch dependency is not a required task')
  }
  const visiting = new Set<string>(), done = new Set<string>()
  const visit = (value: string): void => {
    if (visiting.has(value)) throw new Error('Workspace batch dependencies contain a cycle')
    if (done.has(value)) return
    visiting.add(value)
    for (const dependency of byKey.get(value)!.dependsOn) visit(key(dependency))
    visiting.delete(value); done.add(value)
  }
  for (const value of byKey.keys()) visit(value)
}
/** Every batch contributes edges to one workspace graph, so separate batches cannot hide a cycle. */
function validateWorkspaceGraph(batches: readonly { readonly items: readonly z.output<typeof itemSchema>[] }[]): void {
  const edges = new Map<string, Set<string>>()
  for (const batch of batches) for (const item of batch.items) {
    const itemEdges = edges.get(key(item.ref)) ?? new Set<string>()
    edges.set(key(item.ref), itemEdges)
    for (const dependency of item.dependsOn) itemEdges.add(key(dependency))
  }
  const visiting = new Set<string>(), done = new Set<string>()
  const visit = (value: string): void => {
    if (visiting.has(value)) throw new Error('Workspace batch dependencies contain a cross-batch cycle')
    if (done.has(value)) return
    visiting.add(value)
    for (const dependency of edges.get(value) ?? []) visit(dependency)
    visiting.delete(value); done.add(value)
  }
  for (const value of edges.keys()) visit(value)
}
function reduce(state: State, raw: unknown): State {
  const event = eventSchema.parse(raw)
  if (event.type === 'batch/created') {
    if (state.batches.some(batch => batch.id === event.batch.id)) throw new Error('Workspace batch id is already used')
    validateGraph(event.batch.items)
    validateWorkspaceGraph([...state.batches, event.batch])
    if (event.batch.phase !== 'active' || event.batch.completionEpoch !== 0 || event.batch.history.length !== 0 || event.batch.items.some(item => item.observationRevision !== 0 || item.state !== 'waiting' || item.activeAssignment || item.history.length !== 0)) throw new Error('Workspace batch must start with empty waiting state')
    return { ...state, batches: [...state.batches, event.batch] }
  }
  if (event.type === 'batch/subscribed') {
    const prior = get(state, event.batchId)
    const existing = prior.subscriptions.find(value => value.id === event.subscription.id)
    if (existing) {
      if (existing.destination !== event.subscription.destination) throw new Error('Workspace completion subscription replay differs')
      return state
    }
    if (prior.subscriptions.length >= 256) throw new Error('Workspace batch completion subscription limit is reached')
    return replace(state, { ...prior, subscriptions: [...prior.subscriptions, event.subscription] })
  }
  if (event.type === 'batch/observed') {
    const prior = get(state, event.batchId)
    const observations = new Map(event.observations.map(value => [key(value.ref), value]))
    if (observations.size !== event.observations.length) throw new Error('Workspace batch observation repeats a task')
    if ([...observations.keys()].some(value => !prior.items.some(item => key(item.ref) === value))) throw new Error('Workspace batch observation is not required')
    const items = prior.items.map(item => {
      const observation = observations.get(key(item.ref))
      if (!observation) return item
      if (observation.revision < item.observationRevision) throw new Error('Workspace batch observation is stale')
      if (observation.revision === item.observationRevision) {
        if (observation.state !== item.state || observation.activeAssignment !== item.activeAssignment) throw new Error('Workspace batch observation revision conflicts')
        return item
      }
      if (item.history.length >= 1024) throw new Error('Workspace batch task history limit is reached')
      return { ...item, observationRevision: observation.revision, state: observation.state, activeAssignment: observation.activeAssignment, history: [...item.history, { state: observation.state, activeAssignment: observation.activeAssignment, at: event.at }] }
    })
    const phase = derive(items)
    let completionEpoch = prior.completionEpoch
    let history = prior.history
    if (phase === 'completed' && prior.phase !== 'completed') { completionEpoch++; history = [...history, { phase: 'completed', at: event.at }] }
    else if (prior.phase === 'completed' && phase !== 'completed') history = [...history, { phase: 'reopened', at: event.at }]
    else if (phase === 'failed' && prior.phase !== 'failed') history = [...history, { phase: 'failed', at: event.at }]
    if (history.length > 1024) throw new Error('Workspace batch history limit is reached')
    const notifications = prior.phase === 'completed' && phase !== 'completed'
      ? state.notifications.map(value => value.batchId === prior.id && value.completionEpoch === prior.completionEpoch && value.receipt === undefined ? { ...value, suppressed: true as const } : value)
      : state.notifications
    return { ...replace(state, { ...prior, items, phase, completionEpoch, history }), notifications }
  }
  if (event.type === 'batch/notification-intended') {
    const notification = event.notification
    const batch = get(state, notification.batchId)
    if (batch.phase !== 'completed' || batch.completionEpoch !== notification.completionEpoch || !batch.subscriptions.some(value => value.id === notification.subscriptionId && value.destination === notification.destination)) throw new Error('Workspace notification does not bind a current completed subscription')
    const prior = state.notifications.find(value => value.batchId === notification.batchId && value.subscriptionId === notification.subscriptionId && value.completionEpoch === notification.completionEpoch)
    if (prior) {
      if (prior.intentId !== notification.intentId || prior.destination !== notification.destination) throw new Error('Workspace completion notification replay differs')
      return state
    }
    return { ...state, notifications: [...state.notifications, notification] }
  }
  const notification = state.notifications.find(value => value.intentId === event.intentId)
  if (!notification) throw new Error('Workspace notification receipt lacks intent')
  if (notification.receipt !== undefined) {
    if (notification.receipt !== event.receipt) throw new Error('Workspace notification receipt replay differs')
    return state
  }
  if (notification.suppressed) throw new Error('Workspace notification was suppressed when its batch reopened')
  return { ...state, notifications: state.notifications.map(value => value.intentId === event.intentId ? { ...value, receipt: event.receipt } : value) }
}

/** Durable state foundation for cross-project batches. Caller supplies only authoritative task acceptance observations. */
export class CoordinatorBatchStore {
  private constructor(private readonly journal: DurableJournal<State, Payload>, private readonly now: () => number) {}
  static async open(directory: string, now: () => number = Date.now): Promise<CoordinatorBatchStore> {
    return new CoordinatorBatchStore(await DurableJournal.open(join(directory, 'coordinator-batches.jsonl'), { batches: [], notifications: [] }, reduce), now)
  }
  async create(request: CreateWorkspaceBatchRequest): Promise<WorkspaceBatchView> {
    const parsed = z.object({ id: id.optional(), name: text, items: z.array(itemSchema).min(1).max(1024), subscriptions: z.array(subscriptionSchema).max(256).default([]) }).strict().parse(request)
    validateGraph(parsed.items)
    if (new Set(parsed.subscriptions.map(value => value.id)).size !== parsed.subscriptions.length) throw new Error('Workspace batch repeats a completion subscription')
    const batch: Batch = { id: parsed.id ?? `workspace-batch-${randomUUID()}`, name: parsed.name, subscriptions: parsed.subscriptions, phase: 'active', completionEpoch: 0, history: [],
      items: parsed.items.map(item => ({ ...item, observationRevision: 0, state: 'waiting', activeAssignment: false, history: [] })) }
    const state = await this.journal.append(() => ({ type: 'batch/created', batch }))
    return view(get(state, batch.id))
  }
  /** Reconcile a subset of required tasks from coordinator-owned acceptance records. */
  async observe(batchId: string, observations: readonly WorkspaceTaskObservation[]): Promise<WorkspaceBatchView> {
    const parsed = z.array(observationSchema).min(1).max(1024).parse(observations)
    const state = await this.journal.append(() => ({ type: 'batch/observed', batchId: id.parse(batchId), observations: parsed, at: this.now() }))
    return view(get(state, batchId))
  }
  /** Add one durable destination. A completed batch receives exactly its current completion epoch. */
  async subscribe(batchId: string, subscription: { readonly id: string; readonly destination: string }): Promise<WorkspaceBatchView> {
    const parsed = subscriptionSchema.parse(subscription)
    const state = await this.journal.append(() => ({ type: 'batch/subscribed', batchId: id.parse(batchId), subscription: parsed }))
    return view(get(state, batchId))
  }
  inspect(batchId: string): WorkspaceBatchView | undefined { const batch = this.journal.snapshot().batches.find(value => value.id === batchId); return batch === undefined ? undefined : view(batch) }
  list(): WorkspaceBatchView[] { return this.journal.snapshot().batches.map(view) }
  /** Persist outbound work before a later host notifier receives it. No external effect occurs here.
   * Reopening suppresses an undelivered prior completion epoch; recompletion creates a new intent.
   */
  async notificationIntents(): Promise<WorkspaceBatchNotification[]> {
    for (const batch of this.journal.snapshot().batches.filter(value => value.phase === 'completed')) for (const subscription of batch.subscriptions) {
      const current = this.journal.snapshot()
      if (current.notifications.some(value => value.batchId === batch.id && value.subscriptionId === subscription.id && value.completionEpoch === batch.completionEpoch)) continue
      const intentId = `batch-notification-${createHash('sha256').update(JSON.stringify([batch.id, subscription.id, batch.completionEpoch])).digest('hex')}`
      try {
        await this.journal.append(() => ({ type: 'batch/notification-intended', notification: { intentId, batchId: batch.id, subscriptionId: subscription.id, destination: subscription.destination, completionEpoch: batch.completionEpoch } }))
      } catch (error) {
        const current = this.journal.snapshot().batches.find(value => value.id === batch.id)
        if (current?.phase !== 'completed' || current.completionEpoch !== batch.completionEpoch) continue
        throw error
      }
    }
    return this.journal.snapshot().notifications.filter(value => value.receipt === undefined && value.suppressed === undefined).map(value => ({ intentId: value.intentId, batchId: value.batchId, subscriptionId: value.subscriptionId, destination: value.destination, completionEpoch: value.completionEpoch }))
  }
  async recordNotificationReceipt(intentId: string, receipt: string): Promise<void> { await this.journal.append(() => ({ type: 'batch/notification-receipted', intentId: id.parse(intentId), receipt: text.parse(receipt) })) }
  close(): Promise<void> { return this.journal.close() }
}
export interface WorkspaceBatchView { readonly id: string; readonly name: string; readonly phase: 'active' | 'blocked' | 'failed' | 'completed'; readonly completionEpoch: number; readonly completedRequired: number; readonly required: number; readonly readyWithoutActiveAssignment: readonly WorkspaceTaskRef[]; readonly items: readonly { readonly ref: WorkspaceTaskRef; readonly state: WorkspaceTaskAcceptanceState; readonly activeAssignment: boolean; readonly dependsOn: readonly WorkspaceTaskRef[]; readonly history: readonly { readonly state: WorkspaceTaskAcceptanceState; readonly activeAssignment: boolean; readonly at: number }[] }[]; readonly history: readonly { readonly phase: 'completed' | 'reopened' | 'failed'; readonly at: number }[] }
function view(batch: Batch): WorkspaceBatchView {
  const readyWithoutActiveAssignment = batch.items.filter(item => item.state === 'waiting' && !item.activeAssignment && item.dependsOn.every(dependency => batch.items.find(candidate => sameRef(candidate.ref, dependency))!.state === 'accepted')).map(item => item.ref)
  return { id: batch.id, name: batch.name, phase: batch.phase, completionEpoch: batch.completionEpoch, completedRequired: batch.items.filter(item => item.state === 'accepted').length, required: batch.items.length, readyWithoutActiveAssignment, items: batch.items, history: batch.history }
}
