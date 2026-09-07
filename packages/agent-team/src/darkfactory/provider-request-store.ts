/** One coordinator-wide, host-owned budget. A synced charge must precede every actual provider GET. */
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from '../durable-journal.ts'
import { counterSchema, digestSchema, idSchema, revisionSchema, timestampSchema } from './contracts/common.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'
import { openFactoryOwnedJournal, migrateFactoryOwnedJournal, type FactoryJournalMigration } from './owned-journal.ts'
import { openFactoryRoot } from './paths.ts'

const hardRecordBytes = 16_777_216, windowMs = 60_000, hardLimit = 55
const registrationSchema = z.strictObject({ projectId: idSchema, routeId: idSchema })
const optionsSchema = z.strictObject({
  routes: z.array(registrationSchema).max(256), requestsPerMinute: revisionSchema.max(hardLimit).default(hardLimit),
  maxRecordBytes: revisionSchema.min(1024).max(hardRecordBytes).default(4096),
  maxJournalBytes: revisionSchema.default(1_073_741_824),
  maxCharges: revisionSchema.max(1_000_000).default(100_000), maxBlocks: revisionSchema.max(100_000).default(10_000),
}).refine(value => value.maxJournalBytes >= value.maxRecordBytes && new Set(value.routes.map(route => JSON.stringify([route.projectId, route.routeId]))).size === value.routes.length)
export type ProviderRequestStoreOptions = z.input<typeof optionsSchema>
export const reserveProviderRequestSchema = z.strictObject({ ...registrationSchema.shape, at: timestampSchema, expectedRevision: counterSchema })
export const providerBlockReasonSchema = z.enum(['PROVIDER_RATE_LIMITED', 'LEGACY_WITHHOLDING'])
export const blockProviderRequestsSchema = z.strictObject({ at: timestampSchema, until: timestampSchema, reason: providerBlockReasonSchema, expectedRevision: counterSchema })
export interface ProviderRequestReceipt { schemaVersion: 1; id: string; projectId: string; routeId: string; at: string }
export interface ProviderRequestBlock { schemaVersion: 1; id: string; at: string; until: string; reason: z.output<typeof providerBlockReasonSchema> }
export interface ProviderRequestState {
  revision: number; head: string | null; journalBytes: number; lastAt: string | null
  charges: ProviderRequestReceipt[]; blocks: ProviderRequestBlock[]; blockedUntil: string | null
}
const common = { version: z.literal(1), sequence: revisionSchema, previousHash: digestSchema.nullable(), hash: digestSchema, storageBytes: revisionSchema }
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('provider-request-reserved'), request: reserveProviderRequestSchema, receiptId: idSchema }),
  z.strictObject({ ...common, type: z.literal('provider-requests-blocked'), request: blockProviderRequestsSchema, receiptId: idSchema }),
])
type Event = z.output<typeof eventSchema>
type Payload = Event extends infer E ? E extends Event ? Omit<E, keyof typeof common> : never : never
export class ProviderRequestDeniedError extends Error {
  readonly code = 'PROVIDER_REQUEST_DENIED'
  constructor(readonly reason: 'RATE_LIMITED' | 'COOLDOWN' | 'CAPACITY', readonly nextAttemptAt?: string) { super(`Provider request denied: ${reason}`) }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(parseStrictJson(canonicalJson(raw, hardRecordBytes), hardRecordBytes)) } catch { throw new Error('Invalid provider request authority input: strict bounded JSON required') }
}
function assertTime(state: ProviderRequestState, at: string): void {
  if (!Number.isFinite(Date.parse(at)) || state.lastAt && Date.parse(at) < Date.parse(state.lastAt)) throw new Error('Provider request clock moved backwards')
}
function recentCharges(state: ProviderRequestState, at: string): ProviderRequestReceipt[] {
  const cutoff = Date.parse(at) - windowMs, recent: ProviderRequestReceipt[] = []
  for (let index = state.charges.length - 1; index >= 0; index--) {
    const receipt = state.charges[index]!
    if (Date.parse(receipt.at) <= cutoff) break
    recent.push(receipt)
  }
  return recent.reverse()
}
function assertAvailable(state: ProviderRequestState, at: string, limit: number): void {
  assertTime(state, at)
  if (state.blockedUntil && Date.parse(at) < Date.parse(state.blockedUntil)) throw new ProviderRequestDeniedError('COOLDOWN', state.blockedUntil)
  const recent = recentCharges(state, at)
  if (recent.length >= limit) throw new ProviderRequestDeniedError('RATE_LIMITED', new Date(Date.parse(recent[recent.length - limit]!.at) + windowMs).toISOString())
}
const receiptId = (state: ProviderRequestState, type: Payload['type'], request: Payload['request']) => `df-provider-${digestJson([state.revision + 1, state.head, type, request]).slice(7)}`
function apply(state: ProviderRequestState, event: Payload): ProviderRequestReceipt | ProviderRequestBlock {
  if (event.request.expectedRevision !== state.revision) throw new Error('Stale provider request store revision')
  if (event.receiptId !== receiptId(state, event.type, event.request)) throw new Error('Provider request receipt identity mismatch')
  assertTime(state, event.request.at)
  if (event.type === 'provider-request-reserved') {
    // Historical charges remain valid after a route is removed or the current host cap is reduced.
    assertAvailable(state, event.request.at, hardLimit)
    const receipt: ProviderRequestReceipt = { schemaVersion: 1, id: event.receiptId, projectId: event.request.projectId, routeId: event.request.routeId, at: event.request.at }
    state.charges.push(receipt); state.lastAt = receipt.at
    return receipt
  }
  if (Date.parse(event.request.until) <= Date.parse(event.request.at)) throw new Error('Invalid provider cooldown interval')
  const receipt: ProviderRequestBlock = { schemaVersion: 1, id: event.receiptId, at: event.request.at, until: event.request.until, reason: event.request.reason }
  state.blocks.push(receipt); state.lastAt = receipt.at
  if (!state.blockedUntil || Date.parse(receipt.until) > Date.parse(state.blockedUntil)) state.blockedUntil = receipt.until
  return receipt
}
function reduce(options: z.output<typeof optionsSchema>, state: ProviderRequestState, raw: unknown): ProviderRequestState {
  const event = parse(eventSchema, raw), { hash, ...unsigned } = event
  if (event.previousHash !== state.head || digestJson(unsigned) !== hash) throw new Error('Provider request journal hash chain mismatch')
  const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1
  if (bytes !== event.storageBytes || bytes > options.maxRecordBytes || state.journalBytes > options.maxJournalBytes - bytes) throw new ProviderRequestDeniedError('CAPACITY')
  if (event.type === 'provider-request-reserved' && state.charges.length >= options.maxCharges || event.type === 'provider-requests-blocked' && state.blocks.length >= options.maxBlocks) throw new ProviderRequestDeniedError('CAPACITY')
  const next = structuredClone(state)
  apply(next, event)
  return { ...next, revision: event.sequence, head: hash, journalBytes: state.journalBytes + bytes }
}
const initial = (): ProviderRequestState => ({ revision: 0, head: null, journalBytes: 0, lastAt: null, charges: [], blocks: [], blockedUntil: null })
function parseLine(line: string): unknown {
  const value = parseStrictJson(line, hardRecordBytes)
  if (JSON.stringify(value) !== line) throw new Error('Noncanonical provider request journal encoding')
  return value
}
export class DarkFactoryProviderRequestStore {
  private constructor(private readonly journal: DurableJournal<ProviderRequestState, Event>, private readonly options: z.output<typeof optionsSchema>) {}
  static async open(directory: string, raw: ProviderRequestStoreOptions): Promise<DarkFactoryProviderRequestStore> {
    const options = parse(optionsSchema, raw), root = await openFactoryRoot(directory)
    let journal: DurableJournal<ProviderRequestState, Event> | undefined
    try {
      journal = await openFactoryOwnedJournal<ProviderRequestState, Event>(join(root.descriptorPath, 'darkfactory-provider-requests.jsonl'), initial(), (state, event) => reduce(options, state, event), parseLine, options)
      await root.close()
      return new DarkFactoryProviderRequestStore(journal, options)
    } catch (error) { await journal?.close(); throw error } finally { await root.close() }
  }
  static async migrate(directory: string, raw: ProviderRequestStoreOptions, migration: FactoryJournalMigration<ProviderRequestState>) {
    const options = parse(optionsSchema, raw), root = await openFactoryRoot(directory)
    try { return await migrateFactoryOwnedJournal<ProviderRequestState, Event>(join(root.descriptorPath, 'darkfactory-provider-requests.jsonl'), initial(), (state, event) => reduce(options, state, event), parseLine, options, migration, root.path) }
    finally { await root.close() }
  }
  private async append(make: (state: ProviderRequestState) => Payload): Promise<ProviderRequestReceipt | ProviderRequestBlock> {
    let receipt!: ProviderRequestReceipt | ProviderRequestBlock
    await this.journal.append((state, sequence) => {
      const payload = make(state)
      receipt = apply(structuredClone(state), payload)
      const unsigned = { ...payload, version: 1 as const, sequence, previousHash: state.head, storageBytes: 1 }
      for (;;) {
        const event = { ...unsigned, hash: digestJson(unsigned) } as Event, bytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
        if (bytes === unsigned.storageBytes) return event
        unsigned.storageBytes = bytes
      }
    })
    return structuredClone(receipt)
  }
  async reserve(raw: z.input<typeof reserveProviderRequestSchema>): Promise<ProviderRequestReceipt> {
    const request = parse(reserveProviderRequestSchema, raw)
    if (!this.options.routes.some(route => route.projectId === request.projectId && route.routeId === request.routeId)) throw new Error('Unregistered provider request route or project')
    return this.append(state => {
      if (request.expectedRevision !== state.revision) throw new Error('Stale provider request store revision')
      assertAvailable(state, request.at, this.options.requestsPerMinute)
      return { type: 'provider-request-reserved', request, receiptId: receiptId(state, 'provider-request-reserved', request) }
    }) as Promise<ProviderRequestReceipt>
  }
  async block(raw: z.input<typeof blockProviderRequestsSchema>): Promise<ProviderRequestBlock> {
    const request = parse(blockProviderRequestsSchema, raw)
    return this.append(state => ({ type: 'provider-requests-blocked', request, receiptId: receiptId(state, 'provider-requests-blocked', request) })) as Promise<ProviderRequestBlock>
  }
  /** Advisory only: each actual GET still requires its own atomic reserve. */
  availability(raw: string): { available: number; nextAttemptAt?: string } {
    const at = parse(timestampSchema, raw), state = this.journal.snapshot()
    assertTime(state, at)
    if (state.charges.length >= this.options.maxCharges || state.journalBytes > this.options.maxJournalBytes - this.options.maxRecordBytes) return { available: 0 }
    const recent = recentCharges(state, at), limit = this.options.requestsPerMinute
    let next = state.blockedUntil && Date.parse(state.blockedUntil) > Date.parse(at) ? Date.parse(state.blockedUntil) : 0
    if (recent.length >= limit) next = Math.max(next, Date.parse(recent[recent.length - limit]!.at) + windowMs)
    return next ? { available: 0, nextAttemptAt: new Date(next).toISOString() } : { available: Math.min(limit - recent.length, this.options.maxCharges - state.charges.length) }
  }
  snapshot(): ProviderRequestState { return this.journal.snapshot() }
  close(): Promise<void> { return this.journal.close() }
}
