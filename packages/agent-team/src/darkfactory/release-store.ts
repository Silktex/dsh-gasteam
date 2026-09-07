/**
 * Dark Factory Gate 3: Release Lifecycle and Authority Store (DF-11)
 *
 * Implements authoritative, restart-safe release journal, single-environment
 * FIFO queue, strict state transition validation via assertReleaseTransition,
 * crash/SIGKILL recovery, token fencing monotonicity, and Ed25519-signed
 * canary-accepted completion receipt emission.
 */

import { join } from 'node:path'
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import z from 'zod'
import { DurableJournal } from '../durable-journal.ts'
import { openFactoryOwnedJournal, type FactoryJournalLimits } from './owned-journal.ts'
import { ensureFactoryDirectory } from './paths.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'
import {
  idSchema,
  revisionSchema,
  timestampSchema,
  digestSchema,
  signatureSchema,
  commitSchema,
  uniqueIds,
} from './contracts/common.ts'
import {
  releaseRecordSchema,
  assertReleaseTransition,
  type ReleaseRecordV1,
  type DeploymentRequestV1,
  type DeploymentStatusV1,
} from './contracts/release.ts'

export type ReleaseStateV1 = ReleaseRecordV1['state']

import { assertContractSemantics } from './contracts/semantics.ts'
import type { HostKeyRegistry } from './verification-signer.ts'

export const CANARY_ACCEPTED_DOMAIN = 'gasteam/canary-accepted-receipt/v1'

const hardRecordBytes = 16_777_216
const hardJournalBytes = 1_073_741_824

export class ReleaseConflictError extends Error {
  readonly code = 'RELEASE_CONFLICT'
  constructor(message = 'Immutable release identity or input conflicts with existing release') {
    super(message)
    this.name = 'ReleaseConflictError'
  }
}

export class ReleaseQueueError extends Error {
  readonly code = 'RELEASE_QUEUE_VIOLATION'
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseQueueError'
  }
}

export class ReleaseTransitionError extends Error {
  readonly code = 'RELEASE_TRANSITION_ILLEGAL'
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseTransitionError'
  }
}

export const releaseStoreOptionsSchema = z.strictObject({
  directory: z.string().min(1),
  projectId: idSchema,
  keyRegistry: z.custom<HostKeyRegistry>().optional(),
  maxRecordBytes: revisionSchema.min(1024).max(hardRecordBytes).default(hardRecordBytes),
  maxJournalBytes: revisionSchema.default(hardJournalBytes),
  maxReleases: revisionSchema.max(100_000).default(10_000),
  clock: z.custom<() => string>().optional(),
})
export type ReleaseStoreOptions = z.input<typeof releaseStoreOptionsSchema>

export const canaryAcceptedReceiptPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  kind: z.literal('canary-accepted'),
  projectId: idSchema,
  policyRevision: revisionSchema,
  releaseId: idSchema,
  workflowId: idSchema,
  integrationReceiptId: idSchema,
  attemptIds: uniqueIds(64).min(1),
  commit: commitSchema,
  artifactDigest: digestSchema,
  telemetryIds: uniqueIds(256).min(1),
  completedAt: timestampSchema,
  signerKeyId: idSchema,
})

export const canaryAcceptedReceiptSchema = canaryAcceptedReceiptPayloadSchema.extend({
  attestationHash: digestSchema,
  signature: signatureSchema,
})

export type CanaryAcceptedReceiptPayloadV1 = z.output<typeof canaryAcceptedReceiptPayloadSchema>
export type CanaryAcceptedReceiptV1 = z.output<typeof canaryAcceptedReceiptSchema>

export interface ReleaseStoreState {
  revision: number
  head: string | null
  journalBytes: number
  releases: ReleaseRecordV1[]
  completionReceipts: Record<string, CanaryAcceptedReceiptV1>
}

export interface ReleaseStoreSnapshot {
  revision: number
  head: string | null
  releases: ReleaseRecordV1[]
  queue: ReleaseRecordV1[]
  activeByEnvironment: Record<string, string>
  completionReceipts: Record<string, CanaryAcceptedReceiptV1>
}

// Journal event envelope schemas
const commonEventFields = {
  version: z.literal(1),
  sequence: revisionSchema,
  previousHash: digestSchema.nullable(),
  hash: digestSchema,
  storageBytes: revisionSchema,
  createdAt: timestampSchema,
}

export const releaseQueuedEventPayloadSchema = z.strictObject({
  type: z.literal('release-queued'),
  release: releaseRecordSchema,
})

export const releaseTransitionedEventPayloadSchema = z.strictObject({
  type: z.literal('release-transitioned'),
  releaseId: idSchema,
  fromState: z.string(),
  toState: z.string(),
  release: releaseRecordSchema,
})

export const completionReceiptEmittedEventPayloadSchema = z.strictObject({
  type: z.literal('completion-receipt-emitted'),
  releaseId: idSchema,
  receipt: canaryAcceptedReceiptSchema,
})

export const releaseStoreEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...commonEventFields, ...releaseQueuedEventPayloadSchema.shape }),
  z.strictObject({ ...commonEventFields, ...releaseTransitionedEventPayloadSchema.shape }),
  z.strictObject({ ...commonEventFields, ...completionReceiptEmittedEventPayloadSchema.shape }),
])
export type ReleaseStoreEvent = z.output<typeof releaseStoreEventSchema>
export type ReleaseStoreEventPayload =
  | z.output<typeof releaseQueuedEventPayloadSchema>
  | z.output<typeof releaseTransitionedEventPayloadSchema>
  | z.output<typeof completionReceiptEmittedEventPayloadSchema>

function applyEvent(
  options: z.output<typeof releaseStoreOptionsSchema>,
  state: ReleaseStoreState,
  payload: ReleaseStoreEventPayload,
): void {
  if (payload.type === 'release-queued') {
    const existing = state.releases.find(r => r.id === payload.release.id)
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(payload.release)) {
        throw new ReleaseConflictError()
      }
      return
    }
    if (state.releases.length >= options.maxReleases) {
      throw new Error('Release store capacity exceeded')
    }
    state.releases.push(payload.release)
  } else if (payload.type === 'release-transitioned') {
    const index = state.releases.findIndex(r => r.id === payload.releaseId)
    if (index === -1) {
      throw new Error(`Cannot transition unknown release: ${payload.releaseId}`)
    }
    state.releases[index] = payload.release
  } else if (payload.type === 'completion-receipt-emitted') {
    state.completionReceipts[payload.releaseId] = payload.receipt
  }
}

function reduceReleaseStore(
  options: z.output<typeof releaseStoreOptionsSchema>,
  state: ReleaseStoreState,
  raw: unknown,
): ReleaseStoreState {
  const event = releaseStoreEventSchema.parse(raw)
  const { hash, ...unsigned } = event

  if (event.previousHash !== state.head || digestJson(unsigned) !== hash) {
    throw new Error('Release journal hash chain mismatch')
  }

  const measuredBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1
  if (
    event.storageBytes !== measuredBytes ||
    measuredBytes > options.maxRecordBytes ||
    state.journalBytes > options.maxJournalBytes - measuredBytes
  ) {
    throw new Error('Release journal capacity exceeded or record byte mismatch')
  }

  const next = structuredClone(state)
  applyEvent(options, next, event)

  return {
    ...next,
    revision: event.sequence,
    head: hash,
    journalBytes: state.journalBytes + measuredBytes,
  }
}

function parseReleaseLine(line: string): unknown {
  const event = parseStrictJson(line, hardRecordBytes)
  if (JSON.stringify(event) !== line) {
    throw new Error('Noncanonical release journal encoding')
  }
  return event
}

const initialReleaseState = (): ReleaseStoreState => ({
  revision: 0,
  head: null,
  journalBytes: 0,
  releases: [],
  completionReceipts: {},
})

export class DarkFactoryReleaseStore {
  private constructor(
    private readonly journal: DurableJournal<ReleaseStoreState, ReleaseStoreEvent>,
    readonly projectId: string,
    private readonly options: z.output<typeof releaseStoreOptionsSchema>,
    private readonly clock: () => string,
    private readonly keyRegistry?: HostKeyRegistry,
  ) {}

  /**
   * Open or recover an authoritative release store for the specified project.
   */
  static async open(rawOptions: ReleaseStoreOptions): Promise<DarkFactoryReleaseStore> {
    const options = releaseStoreOptionsSchema.parse(rawOptions)
    const clock = options.clock ?? (() => new Date().toISOString())
    const partition = await ensureFactoryDirectory(options.directory, options.projectId)
    const limits: FactoryJournalLimits = {
      maxRecordBytes: options.maxRecordBytes,
      maxJournalBytes: options.maxJournalBytes,
    }

    let journal: DurableJournal<ReleaseStoreState, ReleaseStoreEvent> | undefined
    try {
      journal = await openFactoryOwnedJournal<ReleaseStoreState, ReleaseStoreEvent>(
        join(partition.descriptorPath, 'release.jsonl'),
        initialReleaseState(),
        (state, event) => reduceReleaseStore(options, state, event),
        parseReleaseLine,
        limits,
      )
      await partition.close()
      return new DarkFactoryReleaseStore(journal, options.projectId, options, clock, options.keyRegistry)
    } catch (error) {
      await journal?.close()
      throw error
    } finally {
      await partition.close()
    }
  }

  /**
   * Appends an event atomically to the journal with hash-chaining and byte convergence.
   */
  private async append(payload: ReleaseStoreEventPayload): Promise<ReleaseStoreState> {
    return this.journal.append((state, sequence) => {
      const createdAt = timestampSchema.parse(this.clock())
      const unsigned = {
        ...payload,
        version: 1 as const,
        sequence,
        previousHash: state.head,
        createdAt,
        storageBytes: 1,
      }

      for (;;) {
        const event = { ...unsigned, hash: digestJson(unsigned) } as ReleaseStoreEvent
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
        if (bytes === unsigned.storageBytes) return event
        unsigned.storageBytes = bytes
      }
    })
  }

  /**
   * Idempotently queue a new release for deployment.
   * If an identical release already exists for this (project, environment, integrationReceiptId),
   * returns the existing record. If conflicting inputs are supplied, throws ReleaseConflictError.
   */
  async queueRelease(
    input: Omit<
      ReleaseRecordV1,
      | 'state'
      | 'revision'
      | 'fencingToken'
      | 'operationIntents'
      | 'operationReceipts'
      | 'telemetryIds'
    >,
  ): Promise<ReleaseRecordV1> {
    if (input.projectId !== this.projectId) {
      throw new ReleaseConflictError('Cross-project release authority denied')
    }

    const state = this.journal.snapshot()

    // 1. Idempotency check by ID
    const existingById = state.releases.find(r => r.id === input.id)
    if (existingById) {
      const {
        state: _s,
        revision: _r,
        fencingToken: _f,
        operationIntents: _i,
        operationReceipts: _rc,
        telemetryIds: _t,
        canaryStartedAt: _csa,
        canaryDeadline: _cd,
        promotionDeadline: _pd,
        rollbackIntegrationId: _ri,
        diagnosticTaskId: _dt,
        healthEscalationId: _he,
        ...existingInput
      } = existingById
      if (canonicalJson(existingInput) === canonicalJson(input)) {
        return structuredClone(existingById)
      }
      throw new ReleaseConflictError('Immutable release identity has different intent')
    }

    // 2. Duplicate check by (environment, integrationReceiptId)
    const existingByIntegration = state.releases.find(
      r =>
        r.environment === input.environment &&
        r.integrationReceiptId === input.integrationReceiptId,
    )
    if (existingByIntegration) {
      throw new ReleaseConflictError('Duplicate release integration/environment')
    }

    // 3. Monotonic fencing token derivation for environment
    const environmentReleases = state.releases.filter(r => r.environment === input.environment)
    const maxFencingToken = environmentReleases.reduce((max, r) => Math.max(max, r.fencingToken), 0)
    const fencingToken = maxFencingToken + 1

    const newRecord: ReleaseRecordV1 = {
      ...input,
      state: 'queued',
      revision: 1,
      fencingToken,
      operationIntents: [],
      operationReceipts: [],
      telemetryIds: [],
    }

    // Validate structure and semantics
    releaseRecordSchema.parse(newRecord)
    assertContractSemantics('ReleaseRecordV1', newRecord)

    await this.append({
      type: 'release-queued',
      release: newRecord,
    })

    return structuredClone(newRecord)
  }

  /**
   * Returns the release actively holding deployment custody of the specified environment,
   * or null if no release is currently active.
   *
   * Active states: 'deploying' | 'observing' | 'rollback_queued'.
   */
  getActiveRelease(environment: string): ReleaseRecordV1 | null {
    const state = this.journal.snapshot()
    const activeStates: ReleaseStateV1[] = ['deploying', 'observing', 'rollback_queued']
    const active = state.releases.find(
      r => r.environment === environment && activeStates.includes(r.state),
    )
    return active ? structuredClone(active) : null
  }

  /**
   * Retrieves a release by ID.
   */
  getRelease(releaseId: string): ReleaseRecordV1 | null {
    const state = this.journal.snapshot()
    const found = state.releases.find(r => r.id === releaseId)
    return found ? structuredClone(found) : null
  }

  /**
   * Lists releases, optionally filtered by environment.
   */
  listReleases(environment?: string): ReleaseRecordV1[] {
    const state = this.journal.snapshot()
    const list = environment
      ? state.releases.filter(r => r.environment === environment)
      : state.releases
    return structuredClone(list)
  }

  /**
   * Transitions a release to a new state and/or appends operation intents, receipts, or telemetry IDs.
   * Enforces single-environment ownership, FIFO order, and assertReleaseTransition.
   */
  async transitionRelease(
    releaseId: string,
    toState: ReleaseStateV1,
    updates: Partial<Omit<ReleaseRecordV1, 'id' | 'projectId' | 'revision' | 'state'>> = {},
  ): Promise<ReleaseRecordV1> {
    const state = this.journal.snapshot()
    const from = state.releases.find(r => r.id === releaseId)
    if (!from) {
      throw new ReleaseTransitionError(`Unknown release ID: ${releaseId}`)
    }

    // Single-environment ownership and FIFO Queue Enforcement when entering 'deploying'
    if (toState === 'deploying' && from.state !== 'deploying') {
      const active = this.getActiveRelease(from.environment)
      if (active && active.id !== from.id) {
        throw new ReleaseQueueError(
          `Environment ${from.environment} already has active release: ${active.id}`,
        )
      }

      // FIFO Queue Ordering: verify this release is at the head of the environment queue
      const queuedInEnv = state.releases.filter(
        r => r.environment === from.environment && r.state === 'queued',
      )
      if (queuedInEnv.length > 0 && queuedInEnv[0]!.id !== from.id) {
        throw new ReleaseQueueError(
          `Release ${from.id} is not at head of environment queue; head is ${queuedInEnv[0]!.id}`,
        )
      }
    }

    // Monotonic fencing token handling
    let fencingToken = from.fencingToken
    if (updates.fencingToken !== undefined) {
      fencingToken = updates.fencingToken
    } else if (
      updates.operationIntents &&
      updates.operationIntents.length > from.operationIntents.length
    ) {
      const maxIntentToken = updates.operationIntents.reduce(
        (max, i) => Math.max(max, i.fencingToken),
        from.fencingToken,
      )
      fencingToken = maxIntentToken
    }

    const to: ReleaseRecordV1 = {
      ...from,
      ...updates,
      state: toState,
      revision: from.revision + 1,
      fencingToken,
      operationIntents: updates.operationIntents ?? from.operationIntents,
      operationReceipts: updates.operationReceipts ?? from.operationReceipts,
      telemetryIds: updates.telemetryIds ?? from.telemetryIds,
    }

    // Strict contract and transition validation
    assertReleaseTransition(from, to)

    await this.append({
      type: 'release-transitioned',
      releaseId,
      fromState: from.state,
      toState,
      release: to,
    })

    return structuredClone(to)
  }

  /**
   * Helper: record a durable deployment operation intent before calling remote transport.
   */
  async recordOperationIntent(
    releaseId: string,
    intent: DeploymentRequestV1,
  ): Promise<ReleaseRecordV1> {
    const current = this.getRelease(releaseId)
    if (!current) throw new ReleaseTransitionError(`Unknown release ID: ${releaseId}`)
    return this.transitionRelease(releaseId, current.state, {
      operationIntents: [...current.operationIntents, intent],
      fencingToken: Math.max(current.fencingToken, intent.fencingToken),
    })
  }

  /**
   * Helper: record an authenticated deployment status receipt from provider or callback.
   */
  async recordOperationReceipt(
    releaseId: string,
    receipt: DeploymentStatusV1,
  ): Promise<ReleaseRecordV1> {
    const current = this.getRelease(releaseId)
    if (!current) throw new ReleaseTransitionError(`Unknown release ID: ${releaseId}`)
    return this.transitionRelease(releaseId, current.state, {
      operationReceipts: [...current.operationReceipts, receipt],
    })
  }

  /**
   * Reconciles in-flight release operations after process restart or SIGKILL crash.
   *
   * Scans active releases across all environments:
   * - If an operation intent was logged without a terminal receipt, queries bridge.status(operationId).
   * - If bridge status is resolved, records receipt on release.
   * - If bridge status is unknown or bridge unreachable, quarantines release with health escalation.
   */
  async reconcileAfterRestart(bridge: {
    status(operationId: string): Promise<DeploymentStatusV1>
  }): Promise<{ reconciled: number; activeReleaseId?: string }> {
    let reconciled = 0
    let activeReleaseId: string | undefined

    const state = this.journal.snapshot()
    const activeStates: ReleaseStateV1[] = ['deploying', 'observing', 'rollback_queued']
    const activeReleases = state.releases.filter(r => activeStates.includes(r.state))

    for (const release of activeReleases) {
      activeReleaseId = release.id
      const latestIntent = release.operationIntents.at(-1)
      if (!latestIntent) continue

      const terminalReceipt = release.operationReceipts.find(
        r =>
          r.operationId === latestIntent.operationId &&
          (r.status === 'succeeded' || r.status === 'failed'),
      )

      if (!terminalReceipt) {
        try {
          const currentStatus = await bridge.status(latestIntent.operationId)
          if (currentStatus.status === 'succeeded' || currentStatus.status === 'failed') {
            const receipt: DeploymentStatusV1 = {
              schemaVersion: 1,
              id:
                currentStatus.id ??
                `status:${latestIntent.operationId}:${currentStatus.providerRevision ?? 1}`,
              projectId: release.projectId,
              policyRevision: release.policyRevision,
              environment: release.environment,
              releaseId: release.id,
              operationId: latestIntent.operationId,
              fencingToken: latestIntent.fencingToken,
              commit: latestIntent.commit,
              artifactDigest: latestIntent.artifactDigest,
              protocolVersion: 1,
              providerRevision: currentStatus.providerRevision ?? 1,
              status: currentStatus.status,
              deploymentId:
                currentStatus.deploymentId ??
                (currentStatus.status === 'succeeded' ? 'dep-reconciled' : undefined),
              requestDigest: digestJson(latestIntent),
              observedAt: currentStatus.observedAt ?? this.clock(),
            }

            await this.transitionRelease(release.id, release.state, {
              operationReceipts: [...release.operationReceipts, receipt],
            })
            reconciled++
          } else if (currentStatus.status === 'unknown') {
            const escalationId = `escalation:restart-indeterminate:${release.id}`
            await this.transitionRelease(release.id, 'quarantined', {
              healthEscalationId: escalationId,
            })
            reconciled++
          }
        } catch {
          const escalationId = `escalation:restart-unreachable:${release.id}`
          await this.transitionRelease(release.id, 'quarantined', {
            healthEscalationId: escalationId,
          })
          reconciled++
        }
      }
    }

    return activeReleaseId !== undefined ? { reconciled, activeReleaseId } : { reconciled }
  }

  /**
   * Emits a signed canary-accepted completion receipt for an accepted release.
   * Only accepted releases with valid telemetry and verification evidence can emit this receipt.
   */
  async emitCompletionReceipt(releaseId: string): Promise<{
    receiptId: string
    signature: string
    receipt: CanaryAcceptedReceiptV1
  }> {
    const release = this.getRelease(releaseId)
    if (!release) {
      throw new Error(`Release not found: ${releaseId}`)
    }

    if (release.state !== 'accepted') {
      throw new Error(
        `Release ${releaseId} is in state '${release.state}'; canary-accepted completion receipt requires state: 'accepted'`,
      )
    }

    if (!release.telemetryIds || release.telemetryIds.length === 0) {
      throw new Error('Accepted release lacks telemetry evidence')
    }

    if (!release.evidenceHashes || release.evidenceHashes.length === 0) {
      throw new Error('Accepted release requires verification evidence references')
    }

    const state = this.journal.snapshot()
    const existing = state.completionReceipts[releaseId]
    if (existing) {
      return {
        receiptId: existing.id,
        signature: existing.signature,
        receipt: existing,
      }
    }

    const completedAt = this.clock()
    const signerKeyId = `release-signer-${release.projectId}`
    const payload: CanaryAcceptedReceiptPayloadV1 = {
      schemaVersion: 1,
      id: `df-receipt-canary-${digestJson([release.id, release.artifact.digest]).slice(7, 39)}`,
      kind: 'canary-accepted',
      projectId: release.projectId,
      policyRevision: release.policyRevision,
      releaseId: release.id,
      workflowId: release.workflowId,
      integrationReceiptId: release.integrationReceiptId,
      attemptIds: release.attemptIds,
      commit: release.commit,
      artifactDigest: release.artifact.digest,
      telemetryIds: release.telemetryIds,
      completedAt,
      signerKeyId,
    }

    const attestationHash = digestJson(payload)
    const messageBytes = Buffer.from(`${CANARY_ACCEPTED_DOMAIN}\n${attestationHash}`, 'utf8')

    let privateKeyPem: string | undefined
    if (this.keyRegistry) {
      privateKeyPem = this.keyRegistry.getPrivateKey(signerKeyId)
      if (!privateKeyPem) {
        const gen = this.keyRegistry.generateKey(signerKeyId)
        privateKeyPem = gen.privateKeyPem
      }
    }

    let privateKeyObj: KeyObject
    if (privateKeyPem) {
      privateKeyObj = createPrivateKey(privateKeyPem)
    } else {
      const { privateKey } = generateKeyPairSync('ed25519')
      privateKeyObj = privateKey
    }

    const signature = sign(null, messageBytes, privateKeyObj).toString('base64')

    const receipt: CanaryAcceptedReceiptV1 = {
      ...payload,
      attestationHash,
      signature,
    }

    canaryAcceptedReceiptSchema.parse(receipt)

    await this.append({
      type: 'completion-receipt-emitted',
      releaseId,
      receipt,
    })

    return {
      receiptId: payload.id,
      signature,
      receipt,
    }
  }

  /**
   * Return an in-memory snapshot of the store state.
   */
  snapshot(): ReleaseStoreSnapshot {
    const state = this.journal.snapshot()
    const activeByEnvironment: Record<string, string> = {}
    for (const r of state.releases) {
      if (r.state === 'deploying' || r.state === 'observing' || r.state === 'rollback_queued') {
        activeByEnvironment[r.environment] = r.id
      }
    }
    return {
      revision: state.revision,
      head: state.head,
      releases: structuredClone(state.releases),
      queue: structuredClone(state.releases.filter(r => r.state === 'queued')),
      activeByEnvironment,
      completionReceipts: structuredClone(state.completionReceipts),
    }
  }

  /**
   * Close the underlying durable journal and release descriptor ownership.
   */
  async close(): Promise<void> {
    await this.journal.close()
  }
}
