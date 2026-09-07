import {
  type ModelRoleAssignmentV1,
  type PricingSnapshotV1,
  modelRoleAssignmentSchema,
} from './contracts/economics.ts'
import {
  type ArtifactRef,
  artifactRefSchema,
} from './contracts/common.ts'
import { assertContractSemantics } from './contracts/semantics.ts'
import { digestJson } from './json.ts'
import type { EnabledDarkFactoryConfig, DarkFactoryConfig } from './config.ts'
import { DarkFactoryFleetStore } from './fleet-store.ts'

/** Compare RFC 3339 UTC timestamps without dropping sub-millisecond precision. */
export function compareTime(a: string, b: string): number {
  const [secondsA, fractionA = ''] = a.slice(0, -1).split('.')
  const [secondsB, fractionB = ''] = b.slice(0, -1).split('.')
  if (secondsA !== secondsB) return secondsA! < secondsB! ? -1 : 1
  const length = Math.max(fractionA.length, fractionB.length)
  const x = fractionA.padEnd(length, '0')
  const y = fractionB.padEnd(length, '0')
  return x === y ? 0 : x < y ? -1 : 1
}

/** Recursively deep freeze an object to guarantee immutable thread-safe snapshots. */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') return obj
  Object.freeze(obj)
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key]
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val)
    }
  }
  return obj
}

// --- Domain Types & Interfaces ---

export type ModelRole = 'fast-loops' | 'core-coding' | 'deep-reasoning' | 'long-context'

export interface ModelCapabilities {
  tools: boolean
  structuredOutput: boolean
  reasoning: boolean
  inputLimit: number
  outputLimit: number
}

export interface ModelBenchmarkScore {
  revision: number
  score: number
  evidence: ArtifactRef
  category?: 'coding' | 'spec' | 'retrieval' | 'general' | undefined
  evaluatedAt?: string | undefined
  deploymentId?: string | undefined
}

export type BenchmarkScoreRecord = ModelBenchmarkScore

export interface ModelHealthProbe {
  deploymentId?: string | undefined
  observedAt: string
  expiresAt: string
  p95LatencyMs: number
  toolsHealthy?: boolean | undefined
  toolsPassed?: boolean | undefined
  structuredOutputHealthy?: boolean | undefined
  structuredOutputPassed?: boolean | undefined
  status?: 'healthy' | 'unhealthy' | 'degraded' | undefined
  evidence: ArtifactRef
}

export interface ModelPricing {
  pricingSnapshotId: string
  pricingSnapshotDigest: string
  pricingRevision?: number | undefined
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cachedInputMicrosPerMillion?: number | undefined
  reasoningMicrosPerMillion?: number | undefined
}

export interface CatalogModelRecord {
  provider: string
  deploymentId: string
  modelVersion: string
  accountId: string
  capabilities: ModelCapabilities
  benchmark?: ModelBenchmarkScore | undefined
  health?: ModelHealthProbe | undefined
  pricingSnapshotId: string
  pricingSnapshotDigest: string
  pricingRevision?: number | undefined
  pricing?: ModelPricing | undefined
  worstCaseCostMicros?: number | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface ImmutableCatalogSnapshot {
  readonly revision: number
  readonly digest: string
  readonly observedAt: string
  readonly expiresAt: string
  readonly models: readonly CatalogModelRecord[]
  readonly roleAssignments: Readonly<Record<ModelRole, readonly CatalogModelRecord[]>>
  readonly criticPair?: { critic1: CatalogModelRecord; critic2: CatalogModelRecord } | undefined
}

export interface RawLiteLlmModelEntry {
  model_name: string
  litellm_params?: {
    model?: string | undefined
    custom_llm_provider?: string | undefined
    api_base?: string | undefined
    api_key?: string | undefined
    [key: string]: unknown
  } | undefined
  model_info?: {
    id?: string | undefined
    db_model?: boolean | undefined
    key?: string | undefined
    input_cost_per_token?: number | undefined
    output_cost_per_token?: number | undefined
    cache_read_input_token_cost?: number | undefined
    max_tokens?: number | undefined
    max_input_tokens?: number | undefined
    max_output_tokens?: number | undefined
    supports_function_calling?: boolean | undefined
    supports_tools?: boolean | undefined
    supports_response_schema?: boolean | undefined
    supports_structured_output?: boolean | undefined
    supports_json_mode?: boolean | undefined
    supports_reasoning?: boolean | undefined
    mode?: string | undefined
    litellm_provider?: string | undefined
    [key: string]: unknown
  } | undefined
}

export interface RawLiteLlmCatalogResponse {
  data: RawLiteLlmModelEntry[]
}

export interface LiteLlmClientAdapter {
  fetchModelInfo(endpoint: string, options?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<RawLiteLlmCatalogResponse>
  validateEndpoint(baseUrl: string): Promise<{ compatible: boolean; resolvedEndpoint: string }>
  executeProbe?(modelId: string): Promise<ModelHealthProbe>
}

export interface RoleAssignmentOptions {
  attemptId?: string | undefined
  generation?: number | undefined
  excludedProviders?: string[] | undefined
  requestedInputTokens?: number | undefined
  requestedOutputTokens?: number | undefined
  pricingSnapshot?: PricingSnapshotV1 | undefined
  pricingRevision?: number | undefined
  benchmarkRevision?: number | undefined
}

export interface DualCriticsAssignmentOptions {
  attemptId?: string | undefined
  generation?: number | undefined
  benchmarkRevision?: number | undefined
  pricingSnapshot?: PricingSnapshotV1 | undefined
  executionMode?: 'deploying' | 'non-deploying-qualification' | undefined
  requestedInputTokens?: number | undefined
  requestedOutputTokens?: number | undefined
}

export type DualCriticsOptions = DualCriticsAssignmentOptions

export interface DiversityDeficitRecord {
  reasonCode: 'NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL'
  catalogRevision: number
  catalogDigest: string
  eligibilityEvidence: ArtifactRef[]
}

export interface DarkFactoryModelCatalogOptions {
  config: EnabledDarkFactoryConfig['models']
  fleetConfig?: EnabledDarkFactoryConfig['fleet'] | undefined
  fleetStore?: DarkFactoryFleetStore | undefined
  adapter?: LiteLlmClientAdapter | undefined
  clock?: (() => string) | undefined
  projectId?: string | undefined
  policyRevision?: number | undefined
  pricingSnapshots?: Map<string, PricingSnapshotV1> | PricingSnapshotV1[] | undefined
}

// --- Domain Error Class Hierarchy ---

export class ModelCatalogError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = this.constructor.name
    this.code = code
  }
}

export class CatalogStaleError extends ModelCatalogError {
  readonly observedAt?: string | undefined
  readonly expiresAt?: string | undefined
  readonly now?: string | undefined
  constructor(messageOrObservedAt?: string, expiresAt?: string, now?: string) {
    if (expiresAt && now) {
      super(`Catalog snapshot expired at ${expiresAt} (observedAt: ${messageOrObservedAt}, now: ${now})`, 'ERR_CATALOG_EXPIRED')
      this.observedAt = messageOrObservedAt
      this.expiresAt = expiresAt
      this.now = now
    } else {
      super(messageOrObservedAt ?? 'Catalog snapshot is stale or expired (>30 minutes)', 'ERR_CATALOG_EXPIRED')
    }
  }
}
export const CatalogExpiredError = CatalogStaleError

export class NoEligibleModelError extends ModelCatalogError {
  readonly role: string
  readonly triedDeployments: string[]
  constructor(role: string, reasonOrTried: string | string[] = 'none') {
    const tried = Array.isArray(reasonOrTried) ? reasonOrTried : [reasonOrTried]
    super(`No eligible models available for role "${role}": ${Array.isArray(reasonOrTried) ? reasonOrTried.join(', ') : reasonOrTried}`, 'ERR_NO_ELIGIBLE_MODEL')
    this.role = role
    this.triedDeployments = tried
  }
}

export class CriticDiversityViolationError extends ModelCatalogError {
  readonly primaryProvider?: string | undefined
  constructor(reasonOrProvider: string) {
    super(`Critic diversity requirement unfulfilled: ${reasonOrProvider}`, 'ERR_CRITIC_DIVERSITY_VIOLATION')
    this.primaryProvider = reasonOrProvider
  }
}
export const CriticDiversityError = CriticDiversityViolationError
export const CriticDiversityDeficitError = CriticDiversityViolationError

export class ModelHealthProbeExpiredError extends ModelCatalogError {
  readonly deploymentId: string
  constructor(deploymentId: string, expiresAt?: string, now?: string) {
    super(`Health probe for deployment "${deploymentId}" is expired (>5 minutes)${expiresAt ? ` (expiredAt: ${expiresAt}, now: ${now})` : ''}`, 'ERR_PROBE_EXPIRED')
    this.deploymentId = deploymentId
  }
}
export const ModelHealthStaleError = ModelHealthProbeExpiredError

export class DeploymentDeniedError extends ModelCatalogError {
  readonly deploymentId: string
  constructor(deploymentId: string, reason: string) {
    super(`Deployment "${deploymentId}" rejected: ${reason}`, 'ERR_DEPLOYMENT_DENIED')
    this.deploymentId = deploymentId
  }
}

export class AllowlistViolationError extends ModelCatalogError {
  readonly deploymentId: string
  constructor(deploymentId: string) {
    super(`Deployment "${deploymentId}" is not in deploymentAllowlist`, 'ERR_DEPLOYMENT_NOT_ALLOWLISTED')
    this.deploymentId = deploymentId
  }
}

export class DenylistViolationError extends ModelCatalogError {
  readonly deploymentId: string
  constructor(deploymentId: string) {
    super(`Deployment "${deploymentId}" is present in deploymentDenylist`, 'ERR_DEPLOYMENT_DENYLISTED')
    this.deploymentId = deploymentId
  }
}

export class EndpointIncompatibleError extends ModelCatalogError {
  constructor(endpoint: string, details?: string) {
    super(`LiteLLM endpoint "${endpoint}" is incompatible${details ? `: ${details}` : ''}`, 'ERR_ENDPOINT_INCOMPATIBLE')
  }
}
export const CatalogEndpointIncompatibleError = EndpointIncompatibleError

export class CatalogEmptyError extends ModelCatalogError {
  constructor(message = 'Model catalog is empty or has not been ingested') {
    super(message, 'ERR_CATALOG_EMPTY')
  }
}

export class InvalidModelRecordError extends ModelCatalogError {
  constructor(message: string) {
    super(message, 'ERR_INVALID_MODEL_RECORD')
  }
}

export class WebhookAuthError extends ModelCatalogError {
  constructor(message = 'Invalid or missing webhook authentication') {
    super(message, 'ERR_WEBHOOK_AUTH_FAILED')
  }
}

export class ModelIneligibleError extends ModelCatalogError {
  readonly deploymentId: string
  readonly role: string
  readonly reason: string
  constructor(deploymentId: string, role: string, reason: string) {
    super(`Model "${deploymentId}" ineligible for role "${role}": ${reason}`, 'ERR_MODEL_INELIGIBLE')
    this.deploymentId = deploymentId
    this.role = role
    this.reason = reason
  }
}

// --- In-Memory LiteLLM Client Adapter for Offline Testing ---

export class InMemoryLiteLlmAdapter implements LiteLlmClientAdapter {
  private endpointCompatible = true
  private preferredEndpoint = '/v1/model/info'
  private catalogResponse: RawLiteLlmCatalogResponse = { data: [] }
  private simulatedError: Error | null = null

  constructor(initialCatalog?: RawLiteLlmCatalogResponse) {
    if (initialCatalog) this.catalogResponse = initialCatalog
  }

  setEndpointCompatibility(compatible: boolean, resolved = '/v1/model/info'): void {
    this.endpointCompatible = compatible
    this.preferredEndpoint = resolved
  }

  setCatalogResponse(response: RawLiteLlmCatalogResponse): void {
    this.catalogResponse = response
  }

  setSimulatedError(err: Error | null): void {
    this.simulatedError = err
  }

  async validateEndpoint(baseUrl: string): Promise<{ compatible: boolean; resolvedEndpoint: string }> {
    if (this.simulatedError) throw this.simulatedError
    return {
      compatible: this.endpointCompatible,
      resolvedEndpoint: `${baseUrl.replace(/\/+$/, '')}${this.preferredEndpoint}`,
    }
  }

  async fetchModelInfo(endpoint: string, _options?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<RawLiteLlmCatalogResponse> {
    if (this.simulatedError) throw this.simulatedError
    return JSON.parse(JSON.stringify(this.catalogResponse))
  }
}

// --- DarkFactoryModelCatalog Implementation ---

export class DarkFactoryModelCatalog {
  readonly config: EnabledDarkFactoryConfig['models']
  readonly fleetConfig?: EnabledDarkFactoryConfig['fleet'] | undefined
  readonly fleetStore?: DarkFactoryFleetStore | undefined
  readonly adapter?: LiteLlmClientAdapter | undefined
  readonly clock: () => string
  readonly projectId: string
  readonly policyRevision: number

  private currentSnapshot: ImmutableCatalogSnapshot | null = null
  private catalogRevisionCounter = 0
  private catalogPauseActive = false
  private hookPromise: Promise<unknown> = Promise.resolve()
  private benchmarks = new Map<string, ModelBenchmarkScore>()
  private probes = new Map<string, ModelHealthProbe>()
  private pricingMap = new Map<string, PricingSnapshotV1>()
  private rawModelStore = new Map<string, CatalogModelRecord>()
  private lastRefreshAt?: string | undefined

  constructor(options: DarkFactoryModelCatalogOptions) {
    this.config = options.config
    this.fleetConfig = options.fleetConfig
    this.fleetStore = options.fleetStore
    this.adapter = options.adapter
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.projectId = options.projectId ?? 'proj-fleet-1'
    this.policyRevision = options.policyRevision ?? 1

    if (options.pricingSnapshots) {
      if (Array.isArray(options.pricingSnapshots)) {
        for (const snap of options.pricingSnapshots) {
          this.registerPricingSnapshot(snap)
        }
      } else {
        for (const [key, snap] of options.pricingSnapshots.entries()) {
          this.pricingMap.set(key, snap)
          this.pricingMap.set(`${snap.provider}:${snap.modelVersion}`, snap)
          this.pricingMap.set(snap.id, snap)
        }
      }
    }

    if (this.fleetConfig?.pricingSnapshots) {
      // Pinned snapshots in fleet configuration
    }
  }

  // --- Snapshot Access & Freshness ---

  getSnapshot(): ImmutableCatalogSnapshot {
    if (!this.currentSnapshot) {
      throw new CatalogEmptyError()
    }
    const now = this.clock()
    if (compareTime(now, this.currentSnapshot.expiresAt) >= 0) {
      this.triggerCatalogPause()
      throw new CatalogStaleError(this.currentSnapshot.observedAt, this.currentSnapshot.expiresAt, now)
    }
    return this.currentSnapshot
  }

  isFresh(): boolean {
    if (!this.currentSnapshot) return false
    return compareTime(this.clock(), this.currentSnapshot.expiresAt) < 0
  }

  assertCatalogFresh(): void {
    this.getSnapshot()
  }

  get catalogRevision(): number {
    return this.currentSnapshot?.revision ?? 0
  }

  get catalogDigest(): string {
    return this.currentSnapshot?.digest ?? ''
  }

  getLastRefreshAt(): string | undefined {
    return this.lastRefreshAt
  }

  isRefreshDue(): boolean {
    if (!this.lastRefreshAt) return true
    const nowMs = Date.parse(this.clock())
    const lastMs = Date.parse(this.lastRefreshAt)
    return nowMs - lastMs >= this.config.refreshIntervalMs
  }

  async pollRefreshIfDue(): Promise<boolean> {
    if (this.isRefreshDue()) {
      await this.refreshCatalog()
      return true
    }
    return false
  }

  // --- Benchmark, Probe, and Pricing Registration ---

  registerPricingSnapshot(snapshot: PricingSnapshotV1): void {
    this.pricingMap.set(`${snapshot.provider}:${snapshot.modelVersion}`, snapshot)
    this.pricingMap.set(snapshot.id, snapshot)
  }

  recordCapabilityProbe(deploymentId: string, probe: ModelHealthProbe): void {
    if (Date.parse(probe.observedAt) >= Date.parse(probe.expiresAt)) {
      throw new InvalidModelRecordError(
        `Invalid probe timestamps for "${deploymentId}": observedAt ${probe.observedAt} must precede expiresAt ${probe.expiresAt}`,
      )
    }
    const normalizedProbe: ModelHealthProbe = {
      ...probe,
      deploymentId,
      toolsHealthy: probe.toolsHealthy ?? probe.toolsPassed ?? true,
      toolsPassed: probe.toolsPassed ?? probe.toolsHealthy ?? true,
      structuredOutputHealthy: probe.structuredOutputHealthy ?? probe.structuredOutputPassed ?? true,
      structuredOutputPassed: probe.structuredOutputPassed ?? probe.structuredOutputHealthy ?? true,
    }
    this.probes.set(deploymentId, normalizedProbe)

    // Rebuild active snapshot if initialized
    if (this.rawModelStore.size > 0) {
      this.rebuildSnapshotFromStore()
    }
  }

  registerProbeResult(deploymentId: string, probe: ModelHealthProbe): void {
    this.recordCapabilityProbe(deploymentId, probe)
  }

  recordBenchmarkScore(deploymentId: string, score: BenchmarkScoreRecord | ModelBenchmarkScore): void {
    if (score.score < 0 || score.score > 1) {
      throw new InvalidModelRecordError(`Benchmark score must be between 0.0 and 1.0, got ${score.score}`)
    }
    this.benchmarks.set(deploymentId, {
      ...score,
      deploymentId,
    })

    // Rebuild active snapshot if initialized
    if (this.rawModelStore.size > 0) {
      this.rebuildSnapshotFromStore()
    }
  }

  registerBenchmarkScore(deploymentId: string, score: BenchmarkScoreRecord | ModelBenchmarkScore): void {
    this.recordBenchmarkScore(deploymentId, score)
  }

  // --- Catalog Ingestion Lifecycle ---

  async refreshCatalog(): Promise<ImmutableCatalogSnapshot> {
    if (!this.adapter) {
      throw new ModelCatalogError('No LiteLLM client adapter configured', 'ERR_ADAPTER_MISSING')
    }
    const resolved = await this.adapter.validateEndpoint(this.config.endpoint)
    if (!resolved.compatible) {
      throw new CatalogEndpointIncompatibleError(this.config.endpoint)
    }
    const raw = await this.adapter.fetchModelInfo(resolved.resolvedEndpoint)
    return this.ingestRawCatalog(raw)
  }

  ingestCatalog(models: CatalogModelRecord[]): ImmutableCatalogSnapshot {
    const now = this.clock()
    const seenIds = new Set<string>()

    // Check duplicate deployment IDs
    for (const m of models) {
      if (seenIds.has(m.deploymentId)) {
        throw new InvalidModelRecordError(`Duplicate deployment ID: "${m.deploymentId}"`)
      }
      seenIds.add(m.deploymentId)
    }

    const allowlist = new Set(this.config.deploymentAllowlist)
    const denylist = new Set(this.config.deploymentDenylist)

    this.rawModelStore.clear()
    for (const m of models) {
      if (denylist.has(m.deploymentId)) continue
      if (allowlist.size > 0 && !allowlist.has(m.deploymentId)) continue

      // Attach any externally registered benchmark/probe
      const benchmark = this.benchmarks.get(m.deploymentId) ?? m.benchmark
      const health = this.probes.get(m.deploymentId) ?? m.health

      this.rawModelStore.set(m.deploymentId, {
        ...m,
        benchmark,
        health,
      })
    }

    this.lastRefreshAt = now
    return this.rebuildSnapshotFromStore()
  }

  ingestRawCatalog(raw: RawLiteLlmCatalogResponse): ImmutableCatalogSnapshot {
    const now = this.clock()
    const allowlist = new Set(this.config.deploymentAllowlist)
    const denylist = new Set(this.config.deploymentDenylist)
    const seenIds = new Set<string>()

    const normalizedRecords: CatalogModelRecord[] = []

    for (const entry of raw.data) {
      const deploymentId = entry.model_info?.id ?? entry.model_name
      if (seenIds.has(deploymentId)) {
        throw new InvalidModelRecordError(`Duplicate deployment ID in catalog payload: "${deploymentId}"`)
      }
      seenIds.add(deploymentId)

      // Strict allowlist / denylist filtering
      if (denylist.has(deploymentId)) continue
      if (allowlist.size > 0 && !allowlist.has(deploymentId)) continue

      const provider =
        entry.litellm_params?.custom_llm_provider ??
        entry.model_info?.litellm_provider ??
        (entry.litellm_params?.model?.includes('/') ? entry.litellm_params.model.split('/')[0] : undefined) ??
        'unknown'

      const modelVersion = entry.model_info?.key ?? entry.litellm_params?.model ?? entry.model_name

      // Missing metadata is unknown — never inferred from names!
      const inputLimit = Math.max(0, entry.model_info?.max_input_tokens ?? entry.model_info?.max_tokens ?? 0)
      const outputLimit = Math.max(0, entry.model_info?.max_output_tokens ?? entry.model_info?.max_tokens ?? 0)

      const capabilities: ModelCapabilities = {
        tools: Boolean(entry.model_info?.supports_tools ?? entry.model_info?.supports_function_calling),
        structuredOutput: Boolean(
          entry.model_info?.supports_structured_output ??
            entry.model_info?.supports_response_schema ??
            entry.model_info?.supports_json_mode,
        ),
        reasoning: Boolean(entry.model_info?.supports_reasoning ?? entry.model_info?.mode === 'reasoning'),
        inputLimit,
        outputLimit,
      }

      // Lookup pricing snapshot binding
      const pricingKey = `${provider}:${modelVersion}`
      const pricingSnapshot =
        this.pricingMap.get(pricingKey) ??
        this.pricingMap.get(deploymentId) ??
        Array.from(this.pricingMap.values()).find(
          snap => snap.provider === provider && snap.modelVersion === modelVersion,
        )

      const pricingSnapshotId = pricingSnapshot?.id ?? `pricing-snap-${deploymentId}`
      const pricingSnapshotDigest = pricingSnapshot
        ? digestJson(pricingSnapshot)
        : 'sha256:0000000000000000000000000000000000000000000000000000000000000000'

      const benchmark = this.benchmarks.get(deploymentId)
      const health = this.probes.get(deploymentId)

      // Calculate worst-case cost from ceiling
      const ceiling = this.fleetConfig?.requestCeiling ?? { inputTokens: 4000, outputTokens: 1000, reasoningTokens: 0 }
      const worstCaseCostMicros = pricingSnapshot
        ? DarkFactoryFleetStore.computeMaxCostMicros(ceiling, pricingSnapshot)
        : 0

      // Strip sensitive secrets/endpoints (secret redaction)
      const sanitizedRecord: CatalogModelRecord = {
        provider,
        deploymentId,
        modelVersion,
        accountId: pricingSnapshot?.accountId ?? 'acc-default',
        capabilities,
        benchmark,
        health,
        pricingSnapshotId,
        pricingSnapshotDigest,
        pricingRevision: pricingSnapshot?.revision ?? 1,
        worstCaseCostMicros,
      }

      normalizedRecords.push(sanitizedRecord)
    }

    this.rawModelStore.clear()
    for (const rec of normalizedRecords) {
      this.rawModelStore.set(rec.deploymentId, rec)
    }

    this.lastRefreshAt = now
    return this.rebuildSnapshotFromStore()
  }

  private rebuildSnapshotFromStore(): ImmutableCatalogSnapshot {
    const now = this.clock()
    const nowMs = Date.parse(now)
    const expiresAt = new Date(nowMs + this.config.expiryMs).toISOString()

    const models: CatalogModelRecord[] = []
    for (const model of this.rawModelStore.values()) {
      // Re-bind benchmark and health probes if newer exist
      const benchmark = this.benchmarks.get(model.deploymentId) ?? model.benchmark
      const health = this.probes.get(model.deploymentId) ?? model.health
      models.push({
        ...model,
        benchmark,
        health,
      })
    }

    // Role eligibility sorting & matrices
    const roleAssignments: Record<ModelRole, CatalogModelRecord[]> = {
      'fast-loops': this.filterAndSortRole(models, 'fast-loops', now),
      'core-coding': this.filterAndSortRole(models, 'core-coding', now),
      'deep-reasoning': this.filterAndSortRole(models, 'deep-reasoning', now),
      'long-context': this.filterAndSortRole(models, 'long-context', now),
    }

    // Critic diversity candidate pair check
    let criticPair: { critic1: CatalogModelRecord; critic2: CatalogModelRecord } | undefined
    const criticCandidates =
      roleAssignments['deep-reasoning'].length > 0
        ? roleAssignments['deep-reasoning']
        : roleAssignments['core-coding']
    if (criticCandidates.length > 0) {
      const c1 = criticCandidates[0]!
      const c2 = criticCandidates.find(m => m.provider !== c1.provider)
      if (c2) {
        criticPair = { critic1: c1, critic2: c2 }
      }
    }

    this.catalogRevisionCounter++
    const snapshotPayload = {
      revision: this.catalogRevisionCounter,
      observedAt: now,
      expiresAt,
      models,
      roleAssignments,
      ...(criticPair ? { criticPair } : {}),
    }

    const cleanPayload = JSON.parse(JSON.stringify(snapshotPayload))
    const digest = digestJson(cleanPayload)
    const newSnapshot: ImmutableCatalogSnapshot = deepFreeze({
      ...snapshotPayload,
      digest,
    })

    this.currentSnapshot = newSnapshot

    // Evaluate durable pause triggers
    if (models.length === 0) {
      this.triggerCatalogPause()
    } else {
      this.triggerCatalogResume()
    }

    return newSnapshot
  }

  // --- Webhook Handling ---

  async handleModelsUpdatedWebhook(
    headers: Record<string, string | string[] | undefined>,
    payload?: unknown,
  ): Promise<void> {
    const authHeader = headers['authorization'] ?? headers['Authorization']
    const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader
    if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      throw new WebhookAuthError('Missing or invalid Bearer authorization header')
    }

    if (this.config.credentialRef?.kind === 'env') {
      const expected = process.env[this.config.credentialRef.name]
      if (expected && auth !== `Bearer ${expected}`) {
        throw new WebhookAuthError('Webhook authorization token mismatch')
      }
    }

    if (this.adapter) {
      await this.refreshCatalog()
    } else if (payload && typeof payload === 'object' && 'data' in payload) {
      this.ingestRawCatalog(payload as RawLiteLlmCatalogResponse)
    } else if (this.currentSnapshot) {
      // Reset expiry timer
      const now = this.clock()
      this.lastRefreshAt = now
      this.rebuildSnapshotFromStore()
    }
  }

  // --- Role Evaluation & Waterfall Sorting ---

  getEligibleModels(role: ModelRole, options?: RoleAssignmentOptions): CatalogModelRecord[] {
    if (!this.currentSnapshot) throw new CatalogEmptyError()
    const now = this.clock()

    const thresholdConfig = this.config.roleThresholds.find((t: { roleId: string }) => t.roleId === role)
    const minScore = thresholdConfig?.minimumScore ?? (role === 'fast-loops' ? 0.8 : 0.9)
    const targetBenchRev = options?.benchmarkRevision ?? thresholdConfig?.benchmarkRevision

    return this.currentSnapshot.models.filter(m => {
      // Excluded providers
      if (options?.excludedProviders && options.excludedProviders.includes(m.provider)) {
        return false
      }

      // Role token floors
      let reqInput = 0
      let reqOutput = 0
      if (role === 'fast-loops') {
        reqInput = 32_000
        reqOutput = 4_000
      } else if (role === 'core-coding' || role === 'deep-reasoning') {
        reqInput = 64_000
        reqOutput = 8_000
      } else if (role === 'long-context') {
        reqInput = 256_000
        reqOutput = 8_000
      }

      if (options?.requestedInputTokens !== undefined) {
        reqInput = Math.max(reqInput, options.requestedInputTokens)
      }
      if (options?.requestedOutputTokens !== undefined) {
        reqOutput = Math.max(reqOutput, options.requestedOutputTokens)
      }

      if (m.capabilities.inputLimit < reqInput || m.capabilities.outputLimit < reqOutput) {
        return false
      }

      // Role capabilities
      if (role === 'fast-loops' || role === 'core-coding') {
        if (!m.capabilities.tools || !m.capabilities.structuredOutput) return false
      }
      if (role === 'deep-reasoning') {
        if (!m.capabilities.structuredOutput || !m.capabilities.reasoning) return false
      }

      // Benchmark verification
      if (!m.benchmark) return false
      if (m.benchmark.score < minScore) return false
      if (targetBenchRev !== undefined && m.benchmark.revision !== targetBenchRev) return false

      // Health probe verification
      if (!m.health) return false
      if (compareTime(now, m.health.expiresAt) >= 0) return false
      if (compareTime(now, m.health.observedAt) < 0) return false

      // Probe functional health checks
      const toolsOk = m.health.toolsHealthy ?? m.health.toolsPassed ?? true
      const structOk = m.health.structuredOutputHealthy ?? m.health.structuredOutputPassed ?? true
      if ((role === 'fast-loops' || role === 'core-coding') && !toolsOk) return false
      if ((role === 'fast-loops' || role === 'core-coding' || role === 'deep-reasoning') && !structOk) return false

      // Latency cap
      if (role === 'fast-loops' && m.health.p95LatencyMs > 5_000) return false

      return true
    })
  }

  computeWorstCaseCost(
    model: CatalogModelRecord,
    ceilingTokens: { inputTokens: number; outputTokens: number; reasoningTokens?: number | undefined },
    pricingSnapshot?: PricingSnapshotV1 | undefined,
  ): number {
    if (
      pricingSnapshot &&
      ((pricingSnapshot.provider === model.provider && pricingSnapshot.modelVersion === model.modelVersion) ||
        pricingSnapshot.id === model.pricingSnapshotId)
    ) {
      return DarkFactoryFleetStore.computeMaxCostMicros(ceilingTokens, pricingSnapshot)
    }
    const snap =
      this.pricingMap.get(`${model.provider}:${model.modelVersion}`) ??
      this.pricingMap.get(model.pricingSnapshotId) ??
      this.pricingMap.get(model.deploymentId)
    if (snap) {
      return DarkFactoryFleetStore.computeMaxCostMicros(ceilingTokens, snap)
    }
    if (model.pricing) {
      const inputCost = (ceilingTokens.inputTokens * model.pricing.inputMicrosPerMillion) / 1_000_000
      const outputCost = (ceilingTokens.outputTokens * model.pricing.outputMicrosPerMillion) / 1_000_000
      const reasoningCost =
        ((ceilingTokens.reasoningTokens ?? 0) * (model.pricing.reasoningMicrosPerMillion ?? 0)) / 1_000_000
      return Math.ceil(inputCost + outputCost + reasoningCost)
    }
    if (model.worstCaseCostMicros !== undefined) {
      return model.worstCaseCostMicros
    }
    return 0
  }

  sortWaterfall(models: CatalogModelRecord[], options?: RoleAssignmentOptions): CatalogModelRecord[] {
    const ceiling = {
      inputTokens: options?.requestedInputTokens ?? this.fleetConfig?.requestCeiling?.inputTokens ?? 4000,
      outputTokens: options?.requestedOutputTokens ?? this.fleetConfig?.requestCeiling?.outputTokens ?? 1000,
      reasoningTokens: this.fleetConfig?.requestCeiling?.reasoningTokens ?? 0,
    }

    const costMap = new Map<string, number>()
    for (const m of models) {
      costMap.set(m.deploymentId, this.computeWorstCaseCost(m, ceiling, options?.pricingSnapshot))
    }

    return [...models].sort((a, b) => {
      // 1. Benchmark score descending
      const scoreA = a.benchmark?.score ?? 0
      const scoreB = b.benchmark?.score ?? 0
      if (Math.abs(scoreB - scoreA) > 1e-6) {
        return scoreB - scoreA
      }

      // 2. Worst-case cost ascending
      const costA = costMap.get(a.deploymentId) ?? 0
      const costB = costMap.get(b.deploymentId) ?? 0
      if (costA !== costB) {
        return costA - costB
      }

      // 3. Measured latency ascending
      const latA = a.health?.p95LatencyMs ?? 0
      const latB = b.health?.p95LatencyMs ?? 0
      if (latA !== latB) {
        return latA - latB
      }

      // 4. Stable deployment ID ascending
      return a.deploymentId.localeCompare(b.deploymentId)
    })
  }

  private filterAndSortRole(models: CatalogModelRecord[], role: ModelRole, now: string): CatalogModelRecord[] {
    const thresholdConfig = this.config.roleThresholds.find((t: { roleId: string }) => t.roleId === role)
    const minScore = thresholdConfig?.minimumScore ?? (role === 'fast-loops' ? 0.8 : 0.9)
    const targetBenchRev = thresholdConfig?.benchmarkRevision

    const eligible = models.filter(m => {
      // Token limits
      if (role === 'fast-loops' && (m.capabilities.inputLimit < 32_000 || m.capabilities.outputLimit < 4_000)) return false
      if (role === 'core-coding' && (m.capabilities.inputLimit < 64_000 || m.capabilities.outputLimit < 8_000)) return false
      if (role === 'deep-reasoning' && (m.capabilities.inputLimit < 64_000 || m.capabilities.outputLimit < 8_000)) return false
      if (role === 'long-context' && (m.capabilities.inputLimit < 256_000 || m.capabilities.outputLimit < 8_000)) return false

      // Capabilities
      if (role === 'fast-loops' && (!m.capabilities.tools || !m.capabilities.structuredOutput)) return false
      if (role === 'core-coding' && (!m.capabilities.tools || !m.capabilities.structuredOutput)) return false
      if (role === 'deep-reasoning' && (!m.capabilities.structuredOutput || !m.capabilities.reasoning)) return false

      // Benchmark
      if (!m.benchmark) return false
      if (m.benchmark.score < minScore) return false
      if (targetBenchRev !== undefined && m.benchmark.revision !== targetBenchRev) return false

      // Health
      if (!m.health) return false
      if (compareTime(now, m.health.expiresAt) >= 0) return false
      if (compareTime(now, m.health.observedAt) < 0) return false

      const toolsOk = m.health.toolsHealthy ?? m.health.toolsPassed ?? true
      const structOk = m.health.structuredOutputHealthy ?? m.health.structuredOutputPassed ?? true
      if ((role === 'fast-loops' || role === 'core-coding') && !toolsOk) return false
      if ((role === 'fast-loops' || role === 'core-coding' || role === 'deep-reasoning') && !structOk) return false

      if (role === 'fast-loops' && m.health.p95LatencyMs > 5_000) return false

      return true
    })

    const ceiling = this.fleetConfig?.requestCeiling ?? { inputTokens: 4000, outputTokens: 1000, reasoningTokens: 0 }
    const costMap = new Map<string, number>()
    for (const m of eligible) {
      costMap.set(m.deploymentId, this.computeWorstCaseCost(m, ceiling))
    }

    return eligible.sort((a, b) => {
      if (Math.abs(b.benchmark!.score - a.benchmark!.score) > 1e-6) return b.benchmark!.score - a.benchmark!.score
      const costA = costMap.get(a.deploymentId) ?? 0
      const costB = costMap.get(b.deploymentId) ?? 0
      if (costA !== costB) return costA - costB
      if (a.health!.p95LatencyMs !== b.health!.p95LatencyMs) return a.health!.p95LatencyMs - b.health!.p95LatencyMs
      return a.deploymentId.localeCompare(b.deploymentId)
    })
  }

  // --- Role Assignment ---

  assignRole(role: ModelRole, options?: RoleAssignmentOptions): ModelRoleAssignmentV1 {
    if (!this.currentSnapshot) throw new CatalogEmptyError()
    const now = this.clock()
    if (compareTime(now, this.currentSnapshot.expiresAt) >= 0) {
      this.triggerCatalogPause()
      throw new CatalogStaleError(this.currentSnapshot.observedAt, this.currentSnapshot.expiresAt, now)
    }

    const eligible = this.getEligibleModels(role, options)
    if (eligible.length === 0) {
      this.triggerCatalogPause()
      throw new NoEligibleModelError(role, 'No eligible models satisfy role requirements')
    }

    const sorted = this.sortWaterfall(eligible, options)
    const winner = sorted[0]!
    const fallbacks = sorted.slice(1)

    return this.buildAssignment(winner, role, fallbacks, now, options)
  }

  async assignDualCritics(options?: DualCriticsAssignmentOptions): Promise<{
    critic1: ModelRoleAssignmentV1
    critic2: ModelRoleAssignmentV1
    diversityDeficit?: DiversityDeficitRecord | undefined
  }> {
    if (!this.currentSnapshot) throw new CatalogEmptyError()
    const now = this.clock()
    if (compareTime(now, this.currentSnapshot.expiresAt) >= 0) {
      this.triggerCatalogPause()
      throw new CatalogStaleError(this.currentSnapshot.observedAt, this.currentSnapshot.expiresAt, now)
    }

    const criticRole: ModelRole = 'deep-reasoning'
    const eligibleAll = this.getEligibleModels(criticRole, options)
    if (eligibleAll.length === 0) {
      this.triggerCatalogPause()
      throw new NoEligibleModelError(criticRole, 'No eligible models for critic evaluation')
    }

    const sortedAll = this.sortWaterfall(eligibleAll, options)
    const critic1Model = sortedAll[0]!
    const critic1Assignment = this.buildAssignment(
      critic1Model,
      criticRole,
      sortedAll.slice(1),
      now,
      options,
    )

    // Critic 2: strictly exclude Critic 1's provider
    const independentEligible = this.getEligibleModels(criticRole, {
      ...options,
      excludedProviders: [critic1Model.provider],
    })

    if (independentEligible.length > 0) {
      const sortedIndependent = this.sortWaterfall(independentEligible, options)
      const critic2Model = sortedIndependent[0]!
      const critic2Assignment = this.buildAssignment(
        critic2Model,
        criticRole,
        sortedIndependent.slice(1),
        now,
        {
          ...options,
          attemptId: options?.attemptId ? `${options.attemptId}-c2` : 'attempt-1-c2',
        },
      )
      return { critic1: critic1Assignment, critic2: critic2Assignment }
    }

    // No independent provider available
    if (options?.executionMode === 'non-deploying-qualification') {
      const sameProviderAlternatives = sortedAll.slice(1)
      const critic2Model = sameProviderAlternatives[0] ?? critic1Model
      const fallbacks = sameProviderAlternatives.length > 0 ? sameProviderAlternatives.slice(1) : []
      const critic2Assignment = this.buildAssignment(
        critic2Model,
        criticRole,
        fallbacks,
        now,
        {
          ...options,
          attemptId: options?.attemptId ? `${options.attemptId}-c2` : 'attempt-1-c2',
        },
      )

      const diversityDeficit: DiversityDeficitRecord = {
        reasonCode: 'NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL',
        catalogRevision: this.catalogRevision,
        catalogDigest: this.catalogDigest,
        eligibilityEvidence: [critic1Model.benchmark!.evidence],
      }
      return { critic1: critic1Assignment, critic2: critic2Assignment, diversityDeficit }
    }

    // Deploying mode -> fail closed and pause catalog
    this.triggerCatalogPause()
    throw new CriticDiversityViolationError(critic1Model.provider)
  }

  private buildAssignment(
    winner: CatalogModelRecord,
    role: ModelRole,
    fallbackCandidates: CatalogModelRecord[],
    now: string,
    options?: RoleAssignmentOptions | undefined,
  ): ModelRoleAssignmentV1 {
    // Unique fallback identity deduplication
    const seenIdentities = new Set<string>()
    seenIdentities.add(`${winner.provider}/${winner.deploymentId}/${winner.modelVersion}`)
    const uniqueFallbacks: CatalogModelRecord[] = []
    for (const candidate of fallbackCandidates) {
      const ident = `${candidate.provider}/${candidate.deploymentId}/${candidate.modelVersion}`
      if (!seenIdentities.has(ident)) {
        seenIdentities.add(ident)
        uniqueFallbacks.push(candidate)
        if (uniqueFallbacks.length >= 32) break
      }
    }

    const attemptId = options?.attemptId ?? 'attempt-1'
    const generation = options?.generation ?? 1

    const rawAssignment = {
      schemaVersion: 1 as const,
      id: `assign-${role}-${winner.deploymentId}-${Date.parse(now)}`.replace(/[^A-Za-z0-9_.:-]/g, '-'),
      projectId: winner.benchmark?.evidence?.projectId ?? this.projectId,
      policyRevision: this.policyRevision,
      attemptId,
      generation,
      role,
      provider: winner.provider,
      deploymentId: winner.deploymentId,
      modelVersion: winner.modelVersion,
      catalogRevision: this.currentSnapshot!.revision,
      catalogDigest: this.currentSnapshot!.digest,
      capabilities: {
        tools: winner.capabilities.tools,
        structuredOutput: winner.capabilities.structuredOutput,
        reasoning: winner.capabilities.reasoning,
        inputLimit: Math.max(1, winner.capabilities.inputLimit),
        outputLimit: Math.max(1, winner.capabilities.outputLimit),
      },
      benchmark: {
        revision: winner.benchmark!.revision,
        score: winner.benchmark!.score,
        evidence: winner.benchmark!.evidence,
      },
      health: {
        observedAt: winner.health!.observedAt,
        expiresAt: winner.health!.expiresAt,
        p95LatencyMs: winner.health!.p95LatencyMs,
        evidence: winner.health!.evidence,
      },
      pricingRevision: options?.pricingRevision ?? winner.pricingRevision ?? 1,
      fallbackChain: uniqueFallbacks.map(m => ({
        provider: m.provider,
        deploymentId: m.deploymentId,
        modelVersion: m.modelVersion,
      })),
      quotaDecisionId: `quota-dec-${winner.deploymentId}`.replace(/[^A-Za-z0-9_.:-]/g, '-'),
      reservationId: `res-${winner.deploymentId}`.replace(/[^A-Za-z0-9_.:-]/g, '-'),
      assignedAt: now,
    }

    const assignment = modelRoleAssignmentSchema.parse(rawAssignment)
    assertContractSemantics('ModelRoleAssignmentV1', assignment)
    return assignment
  }

  // --- Fleet Store Integration Hooks ---

  private triggerCatalogPause(): void {
    if (!this.catalogPauseActive) {
      this.catalogPauseActive = true
      if (this.fleetStore) {
        const p = this.fleetStore.pause('catalog').catch(() => {})
        this.hookPromise = this.hookPromise.then(() => p)
      }
    }
  }

  private triggerCatalogResume(): void {
    if (this.catalogPauseActive) {
      this.catalogPauseActive = false
      if (this.fleetStore) {
        const p = this.fleetStore.resume('catalog').catch(() => {})
        this.hookPromise = this.hookPromise.then(() => p)
      }
    }
  }

  async waitForHooks(): Promise<void> {
    await this.hookPromise
  }
}
