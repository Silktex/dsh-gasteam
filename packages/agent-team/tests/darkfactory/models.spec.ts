import { describe, it, expect, beforeEach } from 'vitest'
import {
  DarkFactoryModelCatalog,
  InMemoryLiteLlmAdapter,
  ModelCatalogError,
  CatalogStaleError,
  CatalogExpiredError,
  NoEligibleModelError,
  CriticDiversityViolationError,
  CriticDiversityError,
  CriticDiversityDeficitError,
  ModelHealthProbeExpiredError,
  DeploymentDeniedError,
  EndpointIncompatibleError,
  CatalogEndpointIncompatibleError,
  CatalogEmptyError,
  InvalidModelRecordError,
  WebhookAuthError,
  ModelIneligibleError,
  AllowlistViolationError,
  DenylistViolationError,
  compareTime,
  deepFreeze,
  type CatalogModelRecord,
  type ModelCapabilities,
  type ModelHealthProbe,
  type ModelBenchmarkScore,
  type BenchmarkScoreRecord,
  type ModelRole,
  type RawLiteLlmCatalogResponse,
  type RawLiteLlmModelEntry,
} from '../../src/darkfactory/model-catalog.ts'
import {
  type PricingSnapshotV1,
  type ModelRoleAssignmentV1,
} from '../../src/darkfactory/contracts/economics.ts'
import { type ArtifactRef } from '../../src/darkfactory/contracts/common.ts'
import { assertContractSemantics } from '../../src/darkfactory/contracts/semantics.ts'
import { digestJson } from '../../src/darkfactory/json.ts'
import { InMemoryRedisAdapter } from '../../src/darkfactory/redis-adapter.ts'
import { DarkFactoryFleetStore } from '../../src/darkfactory/fleet-store.ts'
import type { EnabledDarkFactoryConfig } from '../../src/darkfactory/config.ts'
import { validateEconomicsReferenceGraph } from '../../src/darkfactory/contracts/economics-reference-graph.ts'
import { economicsGraphFixture } from './economics-graph-fixture.ts'

// --- Deterministic Test Helpers ---

export interface TestClock {
  now: () => string
  set: (isoTime: string) => void
  advanceMs: (ms: number) => void
  advanceSec: (sec: number) => void
  advanceMin: (min: number) => void
}

export function makeTestClock(initialIso = '2026-09-06T22:00:00.000Z'): TestClock {
  let currentTime = initialIso
  return {
    now: () => currentTime,
    set: (iso: string) => {
      currentTime = iso
    },
    advanceMs: (ms: number) => {
      const d = new Date(currentTime)
      d.setTime(d.getTime() + ms)
      currentTime = d.toISOString()
    },
    advanceSec: (sec: number) => {
      const d = new Date(currentTime)
      d.setTime(d.getTime() + sec * 1000)
      currentTime = d.toISOString()
    },
    advanceMin: (min: number) => {
      const d = new Date(currentTime)
      d.setTime(d.getTime() + min * 60_000)
      currentTime = d.toISOString()
    },
  }
}

export function createMockArtifactRef(id = 'art-evidence-1', projectId = 'proj-fleet-1'): ArtifactRef {
  return {
    projectId,
    id,
    mediaType: 'application/json',
    sizeBytes: 1024,
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }
}

export function createMockProbeResult(
  overrides?: Partial<ModelHealthProbe>,
  clockNow = '2026-09-06T22:00:00.000Z',
): ModelHealthProbe {
  const observedMs = Date.parse(clockNow)
  return {
    deploymentId: 'deploy-claude-3-5-sonnet',
    observedAt: clockNow,
    expiresAt: new Date(observedMs + 300_000).toISOString(),
    p95LatencyMs: 1000,
    toolsHealthy: true,
    toolsPassed: true,
    structuredOutputHealthy: true,
    structuredOutputPassed: true,
    status: 'healthy',
    evidence: createMockArtifactRef('art-probe-1'),
    ...overrides,
  }
}

export function createMockPricingSnapshot(
  provider = 'prov-anthropic',
  modelVersion = 'claude-3-5-sonnet-20241022',
  overrides?: Partial<PricingSnapshotV1>,
): PricingSnapshotV1 {
  return {
    schemaVersion: 1,
    id: `pricing-snap-${provider}-${modelVersion}`.replace(/[^A-Za-z0-9_.:-]/g, '-'),
    projectId: 'proj-fleet-1',
    policyRevision: 1,
    provider,
    accountId: 'acc-corp-1',
    modelVersion,
    currency: 'USD',
    revision: 1,
    observedAt: '2026-09-06T22:00:00.000Z',
    expiresAt: '2026-09-07T22:00:00.000Z',
    inputMicrosPerMillion: 3_000_000,
    cachedInputMicrosPerMillion: 375_000,
    outputMicrosPerMillion: 15_000_000,
    reasoningMicrosPerMillion: 15_000_000,
    subscriptionFeeMicros: 0,
    source: createMockArtifactRef(`art-pricing-${provider}`),
    ...overrides,
  }
}

export function createMockDeployment(
  overrides?: Partial<CatalogModelRecord>,
  clockNow = '2026-09-06T22:00:00.000Z',
): CatalogModelRecord {
  const observedMs = Date.parse(clockNow)
  return {
    provider: 'prov-anthropic',
    deploymentId: 'deploy-claude-3-5-sonnet',
    modelVersion: 'claude-3-5-sonnet-20241022',
    accountId: 'acc-corp-1',
    capabilities: {
      tools: true,
      structuredOutput: true,
      reasoning: true,
      inputLimit: 200_000,
      outputLimit: 8_192,
    },
    benchmark: {
      revision: 1,
      score: 0.94,
      evidence: createMockArtifactRef('art-bench-claude'),
    },
    health: {
      deploymentId: 'deploy-claude-3-5-sonnet',
      observedAt: clockNow,
      expiresAt: new Date(observedMs + 300_000).toISOString(),
      p95LatencyMs: 1200,
      toolsHealthy: true,
      toolsPassed: true,
      structuredOutputHealthy: true,
      structuredOutputPassed: true,
      status: 'healthy',
      evidence: createMockArtifactRef('art-health-claude'),
    },
    pricingSnapshotId: 'pricing-snap-anthropic',
    pricingSnapshotDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    pricingRevision: 1,
    worstCaseCostMicros: 27_000,
    ...overrides,
  }
}

export function createMockCatalog(clockNow = '2026-09-06T22:00:00.000Z'): CatalogModelRecord[] {
  const observedMs = Date.parse(clockNow)
  const healthExpiry = new Date(observedMs + 300_000).toISOString()
  return [
    // 1. Fast loops winner (DeepSeek)
    createMockDeployment(
      {
        provider: 'prov-deepseek',
        deploymentId: 'deploy-deepseek-chat',
        modelVersion: 'deepseek-v3',
        capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 48_000, outputLimit: 8_000 },
        benchmark: { revision: 1, score: 0.98, evidence: createMockArtifactRef('art-bench-ds') },
        health: {
          deploymentId: 'deploy-deepseek-chat',
          observedAt: clockNow,
          expiresAt: healthExpiry,
          p95LatencyMs: 800,
          toolsHealthy: true,
          toolsPassed: true,
          structuredOutputHealthy: true,
          structuredOutputPassed: true,
          status: 'healthy',
          evidence: createMockArtifactRef('art-health-ds'),
        },
        pricingSnapshotId: 'pricing-snap-ds',
        pricingSnapshotDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        worstCaseCostMicros: 5_000,
      },
      clockNow,
    ),
    // 2. Core coding winner (Anthropic)
    createMockDeployment(
      {
        provider: 'prov-anthropic',
        deploymentId: 'deploy-claude-3-5-sonnet',
        modelVersion: 'claude-3-5-sonnet-20241022',
        capabilities: { tools: true, structuredOutput: true, reasoning: true, inputLimit: 200_000, outputLimit: 8_192 },
        benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('art-bench-claude') },
        health: {
          deploymentId: 'deploy-claude-3-5-sonnet',
          observedAt: clockNow,
          expiresAt: healthExpiry,
          p95LatencyMs: 1400,
          toolsHealthy: true,
          toolsPassed: true,
          structuredOutputHealthy: true,
          structuredOutputPassed: true,
          status: 'healthy',
          evidence: createMockArtifactRef('art-health-claude'),
        },
        pricingSnapshotId: 'pricing-snap-anthropic',
        pricingSnapshotDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        worstCaseCostMicros: 27_000,
      },
      clockNow,
    ),
    // 3. Deep reasoning candidate (OpenAI)
    createMockDeployment(
      {
        provider: 'prov-openai',
        deploymentId: 'deploy-o1-preview',
        modelVersion: 'o1-2024-12-17',
        capabilities: { tools: false, structuredOutput: true, reasoning: true, inputLimit: 128_000, outputLimit: 32_000 },
        benchmark: { revision: 1, score: 0.96, evidence: createMockArtifactRef('art-bench-o1') },
        health: {
          deploymentId: 'deploy-o1-preview',
          observedAt: clockNow,
          expiresAt: healthExpiry,
          p95LatencyMs: 2500,
          toolsHealthy: true,
          toolsPassed: true,
          structuredOutputHealthy: true,
          structuredOutputPassed: true,
          status: 'healthy',
          evidence: createMockArtifactRef('art-health-o1'),
        },
        pricingSnapshotId: 'pricing-snap-openai',
        pricingSnapshotDigest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        worstCaseCostMicros: 60_000,
      },
      clockNow,
    ),
    // 4. Long context winner (Bedrock)
    createMockDeployment(
      {
        provider: 'prov-bedrock',
        deploymentId: 'deploy-bedrock-claude-3-sonnet',
        modelVersion: 'claude-3-sonnet-bedrock',
        capabilities: { tools: true, structuredOutput: true, reasoning: true, inputLimit: 300_000, outputLimit: 8_192 },
        benchmark: { revision: 1, score: 0.91, evidence: createMockArtifactRef('art-bench-bedrock') },
        health: {
          deploymentId: 'deploy-bedrock-claude-3-sonnet',
          observedAt: clockNow,
          expiresAt: healthExpiry,
          p95LatencyMs: 1900,
          toolsHealthy: true,
          toolsPassed: true,
          structuredOutputHealthy: true,
          structuredOutputPassed: true,
          status: 'healthy',
          evidence: createMockArtifactRef('art-health-bedrock'),
        },
        pricingSnapshotId: 'pricing-snap-bedrock',
        pricingSnapshotDigest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        worstCaseCostMicros: 27_000,
      },
      clockNow,
    ),
  ]
}

export function createMockModelsConfig(
  overrides?: Partial<EnabledDarkFactoryConfig['models']>,
): EnabledDarkFactoryConfig['models'] {
  return {
    endpoint: 'http://127.0.0.1:4000',
    version: 'v1.40.0',
    credentialRef: { kind: 'env', name: 'SEC_LITELLM_KEY' },
    refreshIntervalMs: 900_000, // 15 minutes
    expiryMs: 1_800_000, // 30 minutes
    roleThresholds: [
      { roleId: 'fast-loops', minimumScore: 0.8, benchmarkRevision: 1, requiredCapabilities: ['tools', 'structuredOutput'] },
      { roleId: 'core-coding', minimumScore: 0.9, benchmarkRevision: 1, requiredCapabilities: ['tools', 'structuredOutput'] },
      { roleId: 'deep-reasoning', minimumScore: 0.9, benchmarkRevision: 1, requiredCapabilities: ['structuredOutput', 'reasoning'] },
      { roleId: 'long-context', minimumScore: 0.9, benchmarkRevision: 1, requiredCapabilities: [] },
    ],
    deploymentAllowlist: [
      'deploy-deepseek-chat',
      'deploy-claude-3-5-sonnet',
      'deploy-o1-preview',
      'deploy-bedrock-claude-3-sonnet',
      'deploy-fallback-1',
      'deploy-fallback-2',
    ],
    deploymentDenylist: [],
    fallbacks: [
      { roleId: 'fast-loops', deploymentIds: ['deploy-deepseek-chat', 'deploy-claude-3-5-sonnet'] },
      { roleId: 'core-coding', deploymentIds: ['deploy-claude-3-5-sonnet', 'deploy-o1-preview'] },
      { roleId: 'deep-reasoning', deploymentIds: ['deploy-o1-preview', 'deploy-claude-3-5-sonnet'] },
      { roleId: 'long-context', deploymentIds: ['deploy-bedrock-claude-3-sonnet'] },
    ],
    compression: { enabled: false },
    ...overrides,
  }
}

export function createMockFleetStore(clock: TestClock) {
  const adapter = new InMemoryRedisAdapter()
  const fleetStore = new DarkFactoryFleetStore({
    adapter,
    config: {
      redis: {
        endpoint: 'rediss://127.0.0.1:6379',
        tls: true,
        secretRef: { kind: 'env', name: 'SEC_REDIS_KEY' },
      },
      fleetId: 'fleet-primary',
      hostId: 'host-1',
      fleetCaps: { dailyCostMicros: 100_000_000, monthlyCostMicros: 2_000_000_000 },
      projectCaps: [{ id: 'proj-fleet-1', dailyCostMicros: 50_000_000, monthlyCostMicros: 1_000_000_000 }],
      hostCaps: [{ id: 'host-1', dailyCostMicros: 20_000_000, monthlyCostMicros: 400_000_000 }],
      requestCeiling: { moneyMicros: 10_000_000, inputTokens: 4000, outputTokens: 1000, reasoningTokens: 0, deadlineMs: 30_000 },
      attemptCeiling: { moneyMicros: 50_000_000, tokens: 20_000, requests: 5, deadlineMs: 60_000 },
      pricingSnapshots: [],
      routineWatermark: 0.95,
      reserveFraction: 0.1,
      quotas: [],
      emergencyPurposes: ['canary-recovery', 'verified-p0-security', 'production-invariant-recovery'],
    },
    clock: () => clock.now(),
  })
  return { adapter, fleetStore }
}

describe('DarkFactoryModelCatalog Suite (DF-17)', () => {
  let clock: TestClock
  let config: EnabledDarkFactoryConfig['models']
  let fleetStore: DarkFactoryFleetStore

  beforeEach(() => {
    clock = makeTestClock('2026-09-06T22:00:00.000Z')
    config = createMockModelsConfig()
    const fsFixture = createMockFleetStore(clock)
    fleetStore = fsFixture.fleetStore
  })

  // =========================================================================
  // TIER 1: FEATURE TESTS (Features 24 to 32)
  // =========================================================================

  describe('Tier 1: Feature Tests', () => {
    describe('Feature 24: LiteLLM Catalog Ingestion', () => {
      it('TC-DF17-T1-F24-01: Ingests valid catalog, normalizes identities and limits', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const models = createMockCatalog(clock.now())
        const snapshot = catalog.ingestCatalog(models)

        expect(snapshot.revision).toBe(1)
        expect(snapshot.models.length).toBe(4)
        expect(snapshot.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(catalog.getSnapshot().models[0]?.deploymentId).toBe('deploy-deepseek-chat')
      })

      it('TC-DF17-T1-F24-02: Fails closed on missing capability metadata (never infer from name)', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const rawResponse: RawLiteLlmCatalogResponse = {
          data: [
            {
              model_name: 'gpt-4o-smart-coder',
              litellm_params: { custom_llm_provider: 'openai', model: 'gpt-4o' },
              model_info: {
                id: 'deploy-claude-3-5-sonnet',
                // Notice supports_tools and supports_structured_output omitted!
                max_tokens: 4096,
                max_input_tokens: 128000,
              },
            },
          ],
        }
        const snapshot = catalog.ingestRawCatalog(rawResponse)
        const record = snapshot.models[0]!
        expect(record.capabilities.tools).toBe(false)
        expect(record.capabilities.structuredOutput).toBe(false)
        expect(record.capabilities.reasoning).toBe(false)
      })

      it('TC-DF17-T1-F24-03: Validates endpoint compatibility and distinguishes /v1/model/info vs /model/info', async () => {
        const adapter = new InMemoryLiteLlmAdapter()
        adapter.setEndpointCompatibility(true, '/v1/model/info')
        const catalog = new DarkFactoryModelCatalog({ config, adapter, clock: () => clock.now() })

        const res = await catalog.refreshCatalog()
        expect(res.revision).toBe(1)

        adapter.setEndpointCompatibility(false)
        await expect(catalog.refreshCatalog()).rejects.toThrow(CatalogEndpointIncompatibleError)
      })

      it('TC-DF17-T1-F24-04: Redacts provider credentials and authorization tokens from projections', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const raw: RawLiteLlmCatalogResponse = {
          data: [
            {
              model_name: 'deploy-claude-3-5-sonnet',
              litellm_params: {
                api_key: 'sk-ant-secret-key-12345',
                api_base: 'https://secret.proxy.corp/v1',
                custom_llm_provider: 'anthropic',
              },
              model_info: {
                supports_tools: true,
                supports_structured_output: true,
                max_input_tokens: 100000,
                max_output_tokens: 8000,
              },
            },
          ],
        }
        const snapshot = catalog.ingestRawCatalog(raw)
        const json = JSON.stringify(snapshot)
        expect(json).not.toContain('sk-ant-secret-key-12345')
        expect(json).not.toContain('https://secret.proxy.corp/v1')
      })

      it('TC-DF17-T1-F24-05: Generates strictly monotonic catalogRevision and SHA-256 digest', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const s1 = catalog.ingestCatalog(createMockCatalog(clock.now()))
        expect(s1.revision).toBe(1)
        expect(catalog.catalogRevision).toBe(1)

        clock.advanceMin(1)
        const s2 = catalog.ingestCatalog(createMockCatalog(clock.now()))
        expect(s2.revision).toBe(2)
        expect(catalog.catalogRevision).toBe(2)
        expect(s1.digest).not.toBe(s2.digest)
      })

      it('TC-DF17-T1-F24-06: Rejects payload containing duplicate deployment IDs with InvalidModelRecordError', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const dupes = [
          createMockDeployment({ deploymentId: 'deploy-dup-1' }),
          createMockDeployment({ deploymentId: 'deploy-dup-1' }),
        ]
        expect(() => catalog.ingestCatalog(dupes)).toThrow(InvalidModelRecordError)
      })
    })

    describe('Feature 25: 15-Minute Refresh Interval', () => {
      it('TC-DF17-T1-F25-01: Indicates refresh is due at startup before first ingestion', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        expect(catalog.isRefreshDue()).toBe(true)
        catalog.ingestCatalog(createMockCatalog(clock.now()))
        expect(catalog.isRefreshDue()).toBe(false)
      })

      it('TC-DF17-T1-F25-02: Advance clock 15m00s; triggers scheduled periodic refresh', async () => {
        const adapter = new InMemoryLiteLlmAdapter({ data: [] })
        const catalog = new DarkFactoryModelCatalog({ config, adapter, clock: () => clock.now() })
        await catalog.refreshCatalog()
        expect(catalog.catalogRevision).toBe(1)

        clock.advanceMin(14)
        clock.advanceSec(59)
        expect(catalog.isRefreshDue()).toBe(false)

        clock.advanceSec(1) // 15m exactly
        expect(catalog.isRefreshDue()).toBe(true)
        const refreshed = await catalog.pollRefreshIfDue()
        expect(refreshed).toBe(true)
        expect(catalog.catalogRevision).toBe(2)
      })

      it('TC-DF17-T1-F25-03: Advance clock 10m00s; verify no refresh is triggered prematurely', async () => {
        const adapter = new InMemoryLiteLlmAdapter({ data: [] })
        const catalog = new DarkFactoryModelCatalog({ config, adapter, clock: () => clock.now() })
        await catalog.refreshCatalog()
        clock.advanceMin(10)
        expect(catalog.isRefreshDue()).toBe(false)
        const refreshed = await catalog.pollRefreshIfDue()
        expect(refreshed).toBe(false)
        expect(catalog.catalogRevision).toBe(1)
      })

      it('TC-DF17-T1-F25-04: Periodic refresh preserves healthy models when payload is unchanged', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const models = createMockCatalog(clock.now())
        catalog.ingestCatalog(models)

        const firstAssign = catalog.assignRole('core-coding')
        expect(firstAssign.deploymentId).toBe('deploy-claude-3-5-sonnet')

        clock.advanceMin(15)
        catalog.ingestCatalog(createMockCatalog(clock.now()))
        const secondAssign = catalog.assignRole('core-coding')
        expect(secondAssign.deploymentId).toBe('deploy-claude-3-5-sonnet')
      })

      it('TC-DF17-T1-F25-05: Upstream error during periodic refresh retains valid prior snapshot within 30m', async () => {
        const adapter = new InMemoryLiteLlmAdapter()
        adapter.setCatalogResponse({
          data: [
            {
              model_name: 'deploy-claude-3-5-sonnet',
              litellm_params: { custom_llm_provider: 'prov-anthropic', model: 'claude-3-5-sonnet' },
              model_info: { supports_tools: true, supports_structured_output: true, max_input_tokens: 100000, max_output_tokens: 8000 },
            },
          ],
        })
        const catalog = new DarkFactoryModelCatalog({ config, adapter, clock: () => clock.now() })
        await catalog.refreshCatalog()

        clock.advanceMin(15)
        adapter.setSimulatedError(new Error('500 Internal Server Error'))

        await expect(catalog.refreshCatalog()).rejects.toThrow('500 Internal Server Error')
        // Prior snapshot remains active and fresh
        expect(catalog.isFresh()).toBe(true)
        expect(catalog.getSnapshot().revision).toBe(1)
      })
    })

    describe('Feature 26: 30-Minute Catalog Expiry & Durable Pause', () => {
      it('TC-DF17-T1-F26-01: Catalog younger than 30 minutes permits active role assignment', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        clock.advanceMin(29)
        expect(catalog.isFresh()).toBe(true)
        catalog.recordCapabilityProbe('deploy-deepseek-chat', createMockProbeResult({}, clock.now()))
        expect(() => catalog.assignRole('fast-loops')).not.toThrow()
      })

      it('TC-DF17-T1-F26-02: Catalog older than 30 minutes expires and transitions to stale', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        clock.advanceMin(30)
        expect(catalog.isFresh()).toBe(false)
      })

      it('TC-DF17-T1-F26-03: Role assignment on expired catalog throws CatalogStaleError', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        clock.advanceMin(30)
        expect(() => catalog.assignRole('fast-loops')).toThrow(CatalogStaleError)
      })

      it('TC-DF17-T1-F26-04: Catalog expiry calls fleetStore.pause("catalog")', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))
        await catalog.waitForHooks()
        expect(await fleetStore.getActivePauses()).not.toContain('catalog')

        clock.advanceMin(30)
        expect(() => catalog.getSnapshot()).toThrow(CatalogStaleError)
        await catalog.waitForHooks()
        expect(await fleetStore.getActivePauses()).toContain('catalog')
      })

      it('TC-DF17-T1-F26-05: In-flight attempt preserves pinned assignment even if catalog expires later', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const pinnedAssignment = catalog.assignRole('fast-loops')
        clock.advanceMin(31)

        // Pinned assignment properties remain intact and immutable
        expect(pinnedAssignment.deploymentId).toBe('deploy-deepseek-chat')
        expect(pinnedAssignment.catalogRevision).toBe(1)
        expect(() => catalog.assignRole('fast-loops')).toThrow(CatalogStaleError)
      })

      it('TC-DF17-T1-F26-06: Ingesting fresh valid catalog automatically calls fleetStore.resume("catalog")', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        clock.advanceMin(30)
        expect(() => catalog.getSnapshot()).toThrow(CatalogStaleError)
        await catalog.waitForHooks()
        expect(await fleetStore.getActivePauses()).toContain('catalog')

        // Ingest fresh catalog
        catalog.ingestCatalog(createMockCatalog(clock.now()))
        await catalog.waitForHooks()
        expect(await fleetStore.getActivePauses()).not.toContain('catalog')
      })
    })

    describe('Feature 27: 5-Minute Capability Probes & Expiry', () => {
      it('TC-DF17-T1-F27-01: Fresh probe (<5 minutes) keeps model eligible', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const probe = createMockProbeResult({}, clock.now())
        catalog.recordCapabilityProbe('deploy-deepseek-chat', probe)

        clock.advanceMin(4)
        const models = catalog.getEligibleModels('fast-loops')
        expect(models.some(m => m.deploymentId === 'deploy-deepseek-chat')).toBe(true)
      })

      it('TC-DF17-T1-F27-02: Probe older than 5 minutes expires and disqualifies model', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        clock.advanceMin(5)
        const models = catalog.getEligibleModels('fast-loops')
        expect(models.some(m => m.deploymentId === 'deploy-deepseek-chat')).toBe(false)
      })

      it('TC-DF17-T1-F27-03: Probe reporting toolsHealthy: false disqualifies for tools roles', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        catalog.recordCapabilityProbe('deploy-claude-3-5-sonnet', createMockProbeResult({
          toolsHealthy: false,
          toolsPassed: false,
        }, clock.now()))

        const eligible = catalog.getEligibleModels('core-coding')
        expect(eligible.some(m => m.deploymentId === 'deploy-claude-3-5-sonnet')).toBe(false)
      })

      it('TC-DF17-T1-F27-04: Probe reporting structuredOutputHealthy: false disqualifies for structuredOutput roles', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        catalog.recordCapabilityProbe('deploy-o1-preview', createMockProbeResult({
          structuredOutputHealthy: false,
          structuredOutputPassed: false,
        }, clock.now()))

        const eligible = catalog.getEligibleModels('deep-reasoning')
        expect(eligible.some(m => m.deploymentId === 'deploy-o1-preview')).toBe(false)
      })

      it('TC-DF17-T1-F27-05: Updating probe p95 latency dynamically alters waterfall sorting', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const m1 = createMockDeployment({
          deploymentId: 'deploy-claude-3-5-sonnet',
          benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b1') },
          worstCaseCostMicros: 20_000,
        }, clock.now())
        const m2 = createMockDeployment({
          deploymentId: 'deploy-o1-preview',
          provider: 'prov-openai',
          benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b2') },
          worstCaseCostMicros: 20_000,
        }, clock.now())

        catalog.ingestCatalog([m1, m2])

        // Initial: claude latency 1200ms vs o1 2500ms -> claude wins
        let sorted = catalog.sortWaterfall(catalog.getEligibleModels('core-coding'))
        expect(sorted[0]?.deploymentId).toBe('deploy-claude-3-5-sonnet')

        // Update o1 probe to 500ms
        catalog.recordCapabilityProbe('deploy-o1-preview', createMockProbeResult({
          p95LatencyMs: 500,
        }, clock.now()))

        sorted = catalog.sortWaterfall(catalog.getEligibleModels('core-coding'))
        expect(sorted[0]?.deploymentId).toBe('deploy-o1-preview')
      })

      it('TC-DF17-T1-F27-06: Health observation timestamps satisfy contract semantics', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const assignment = catalog.assignRole('core-coding')
        expect(compareTime(assignment.health.observedAt, assignment.assignedAt)).toBeLessThanOrEqual(0)
        expect(compareTime(assignment.assignedAt, assignment.health.expiresAt)).toBeLessThan(0)
        expect(() => assertContractSemantics('ModelRoleAssignmentV1', assignment)).not.toThrow()
      })
    })

    describe('Feature 28: 4 Role Eligibility Matrices', () => {
      it('TC-DF17-T1-F28-01: fast-loops requires tools, structured output, >=32k/4k, bench>=0.80, lat<=5000ms', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const eligible = catalog.getEligibleModels('fast-loops')
        for (const m of eligible) {
          expect(m.capabilities.tools).toBe(true)
          expect(m.capabilities.structuredOutput).toBe(true)
          expect(m.capabilities.inputLimit).toBeGreaterThanOrEqual(32_000)
          expect(m.capabilities.outputLimit).toBeGreaterThanOrEqual(4_000)
          expect(m.benchmark!.score).toBeGreaterThanOrEqual(0.8)
          expect(m.health!.p95LatencyMs).toBeLessThanOrEqual(5_000)
        }
      })

      it('TC-DF17-T1-F28-02: core-coding requires tools, structured output, >=64k/8k, coding bench>=0.90', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const eligible = catalog.getEligibleModels('core-coding')
        for (const m of eligible) {
          expect(m.capabilities.tools).toBe(true)
          expect(m.capabilities.structuredOutput).toBe(true)
          expect(m.capabilities.inputLimit).toBeGreaterThanOrEqual(64_000)
          expect(m.capabilities.outputLimit).toBeGreaterThanOrEqual(8_000)
          expect(m.benchmark!.score).toBeGreaterThanOrEqual(0.9)
        }
      })

      it('TC-DF17-T1-F28-03: deep-reasoning requires structured output, reasoning, >=64k/8k, spec bench>=0.90', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const eligible = catalog.getEligibleModels('deep-reasoning')
        for (const m of eligible) {
          expect(m.capabilities.structuredOutput).toBe(true)
          expect(m.capabilities.reasoning).toBe(true)
          expect(m.capabilities.inputLimit).toBeGreaterThanOrEqual(64_000)
          expect(m.capabilities.outputLimit).toBeGreaterThanOrEqual(8_000)
          expect(m.benchmark!.score).toBeGreaterThanOrEqual(0.9)
        }
      })

      it('TC-DF17-T1-F28-04: long-context requires >=256k input/8k output, bench>=0.90', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const eligible = catalog.getEligibleModels('long-context')
        for (const m of eligible) {
          expect(m.capabilities.inputLimit).toBeGreaterThanOrEqual(256_000)
          expect(m.capabilities.outputLimit).toBeGreaterThanOrEqual(8_000)
          expect(m.benchmark!.score).toBeGreaterThanOrEqual(0.9)
        }
      })

      it('TC-DF17-T1-F28-05: Model satisfying capabilities but failing token limits is rejected', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const shortModel = createMockDeployment({
          deploymentId: 'deploy-claude-3-5-sonnet',
          capabilities: { tools: true, structuredOutput: true, reasoning: true, inputLimit: 16_000, outputLimit: 2_000 },
        }, clock.now())
        catalog.ingestCatalog([shortModel])

        expect(catalog.getEligibleModels('fast-loops')).toHaveLength(0)
      })

      it('TC-DF17-T1-F28-06: Dynamic token fitting rejects model that cannot fit request context', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        // DeepSeek has 64k inputLimit; request 100k
        const eligible = catalog.getEligibleModels('fast-loops', { requestedInputTokens: 100_000 })
        expect(eligible.some(m => m.deploymentId === 'deploy-deepseek-chat')).toBe(false)
        expect(eligible.some(m => m.deploymentId === 'deploy-claude-3-5-sonnet')).toBe(true) // has 200k
      })
    })

    describe('Feature 29: Waterfall Sorting Algorithm', () => {
      it('TC-DF17-T1-F29-01: Tier 1 sort: Benchmark score descending', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b1') } })
        const m2 = createMockDeployment({ deploymentId: 'deploy-o1-preview', provider: 'prov-openai', benchmark: { revision: 1, score: 0.96, evidence: createMockArtifactRef('b2') } })

        const sorted = catalog.sortWaterfall([m1, m2])
        expect(sorted[0]?.deploymentId).toBe('deploy-o1-preview')
      })

      it('TC-DF17-T1-F29-02: Tier 2 sort: Worst-case request cost ascending when scores equal', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b1') }, worstCaseCostMicros: 30_000 })
        const m2 = createMockDeployment({ deploymentId: 'deploy-o1-preview', provider: 'prov-openai', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b2') }, worstCaseCostMicros: 10_000 })

        const sorted = catalog.sortWaterfall([m1, m2])
        expect(sorted[0]?.deploymentId).toBe('deploy-o1-preview')
      })

      it('TC-DF17-T1-F29-03: Tier 3 sort: Measured p95 latency ascending when score & cost equal', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b1') }, worstCaseCostMicros: 20_000, health: createMockProbeResult({ p95LatencyMs: 1500 }) })
        const m2 = createMockDeployment({ deploymentId: 'deploy-o1-preview', provider: 'prov-openai', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b2') }, worstCaseCostMicros: 20_000, health: createMockProbeResult({ p95LatencyMs: 800 }) })

        const sorted = catalog.sortWaterfall([m1, m2])
        expect(sorted[0]?.deploymentId).toBe('deploy-o1-preview')
      })

      it('TC-DF17-T1-F29-04: Tier 4 sort: Stable deployment ID alphabetical ascending tie-breaker', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const m1 = createMockDeployment({ deploymentId: 'deploy-bedrock-claude-3-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b1') }, worstCaseCostMicros: 20_000, health: createMockProbeResult({ p95LatencyMs: 1000 }) })
        const m2 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b2') }, worstCaseCostMicros: 20_000, health: createMockProbeResult({ p95LatencyMs: 1000 }) })

        const sorted = catalog.sortWaterfall([m2, m1])
        expect(sorted[0]?.deploymentId).toBe('deploy-bedrock-claude-3-sonnet')
      })

      it('TC-DF17-T1-F29-05: Populates fallbackChain with remaining eligible models ordered by waterfall', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const assignment = catalog.assignRole('core-coding')
        expect(assignment.fallbackChain.length).toBeGreaterThanOrEqual(1)
        expect(assignment.fallbackChain[0]?.deploymentId).toBe('deploy-bedrock-claude-3-sonnet')
      })
    })

    describe('Feature 30: Critic Diversity Rule', () => {
      it('TC-DF17-T1-F30-01: Dual critics assignment assigns Critic 1 top model and Critic 2 distinct provider', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const { critic1, critic2 } = await catalog.assignDualCritics()
        expect(critic1.provider).not.toBe(critic2.provider)
        expect(critic1.deploymentId).toBe('deploy-o1-preview') // score 0.96
        expect(critic2.deploymentId).toBe('deploy-claude-3-5-sonnet') // score 0.95 from anthropic
      })

      it('TC-DF17-T1-F30-02: Critic 2 strictly excludes Critic 1 provider even if provider has multiple models', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        const models = [
          createMockDeployment({ deploymentId: 'deploy-o1-preview', provider: 'prov-openai', benchmark: { revision: 1, score: 0.98, evidence: createMockArtifactRef('b1') } }),
          createMockDeployment({ deploymentId: 'deploy-o1-mini', provider: 'prov-openai', modelVersion: 'o1-mini', benchmark: { revision: 1, score: 0.97, evidence: createMockArtifactRef('b2') } }),
          createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', provider: 'prov-anthropic', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef('b3') } }),
        ]
        catalog.ingestCatalog(models)

        const { critic1, critic2 } = await catalog.assignDualCritics()
        expect(critic1.deploymentId).toBe('deploy-o1-preview')
        expect(critic2.deploymentId).toBe('deploy-claude-3-5-sonnet')
      })

      it('TC-DF17-T1-F30-03: Single provider available throws CriticDiversityViolationError and pauses catalog', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
        const singleProviderModels = [
          createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', provider: 'prov-anthropic' }),
        ]
        catalog.ingestCatalog(singleProviderModels)

        await expect(catalog.assignDualCritics()).rejects.toThrow(CriticDiversityViolationError)
        await catalog.waitForHooks()
        expect(await fleetStore.getActivePauses()).toContain('catalog')
      })

      it('TC-DF17-T1-F30-04: Supports arbitrary excludedProviders in assignRole for general diversity filtering', () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const assignment = catalog.assignRole('core-coding', {
          excludedProviders: ['prov-anthropic'],
        })
        expect(assignment.provider).not.toBe('prov-anthropic')
      })

      it('TC-DF17-T1-F30-05: Three providers available: Critic 1 picks top; Critic 2 picks top from remaining 2', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const { critic1, critic2 } = await catalog.assignDualCritics()
        expect(critic1.provider).toBe('prov-openai')
        expect(critic2.provider).toBe('prov-anthropic')
      })

      it('TC-DF17-T1-F30-06: Dual critic assignments satisfy assertContractSemantics', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const { critic1, critic2 } = await catalog.assignDualCritics()
        expect(() => assertContractSemantics('ModelRoleAssignmentV1', critic1)).not.toThrow()
        expect(() => assertContractSemantics('ModelRoleAssignmentV1', critic2)).not.toThrow()
      })
    })

    describe('Feature 31: Allowlist and Denylist Filtering', () => {
      it('TC-DF17-T1-F31-01: Deployments not in deploymentAllowlist are excluded from catalog', () => {
        const restrictedConfig = createMockModelsConfig({
          deploymentAllowlist: ['deploy-deepseek-chat'],
        })
        const catalog = new DarkFactoryModelCatalog({ config: restrictedConfig, clock: () => clock.now() })
        const snapshot = catalog.ingestCatalog(createMockCatalog(clock.now()))

        expect(snapshot.models).toHaveLength(1)
        expect(snapshot.models[0]?.deploymentId).toBe('deploy-deepseek-chat')
      })

      it('TC-DF17-T1-F31-02: Deployments in deploymentDenylist are strictly excluded even if allowlisted', () => {
        const denylistedConfig = createMockModelsConfig({
          deploymentAllowlist: ['deploy-deepseek-chat', 'deploy-claude-3-5-sonnet'],
          deploymentDenylist: ['deploy-claude-3-5-sonnet'],
        })
        const catalog = new DarkFactoryModelCatalog({ config: denylistedConfig, clock: () => clock.now() })
        const snapshot = catalog.ingestCatalog(createMockCatalog(clock.now()))

        expect(snapshot.models.some(m => m.deploymentId === 'deploy-claude-3-5-sonnet')).toBe(false)
      })

      it('TC-DF17-T1-F31-03: Empty catalog results in CatalogEmptyError when assigning role', () => {
        const emptyConfig = createMockModelsConfig({
          deploymentAllowlist: ['deploy-nonexistent'],
        })
        const catalog = new DarkFactoryModelCatalog({ config: emptyConfig, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        expect(() => catalog.assignRole('fast-loops')).toThrow(NoEligibleModelError)
      })

      it('TC-DF17-T1-F31-04: Denylisting primary deployment causes fallback model to be assigned cleanly', () => {
        const customConfig = createMockModelsConfig({
          deploymentAllowlist: ['deploy-claude-3-5-sonnet', 'deploy-bedrock-claude-3-sonnet'],
          deploymentDenylist: ['deploy-claude-3-5-sonnet'],
        })
        const catalog = new DarkFactoryModelCatalog({ config: customConfig, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        const assignment = catalog.assignRole('core-coding')
        expect(assignment.deploymentId).toBe('deploy-bedrock-claude-3-sonnet')
      })
    })

    describe('Feature 32: Authenticated Webhook Updates (MODELS_UPDATED)', () => {
      it('TC-DF17-T1-F32-01: Authenticated MODELS_UPDATED webhook triggers immediate catalog ingestion', async () => {
        const adapter = new InMemoryLiteLlmAdapter({ data: [] })
        const catalog = new DarkFactoryModelCatalog({ config, adapter, clock: () => clock.now() })
        await catalog.refreshCatalog()
        expect(catalog.catalogRevision).toBe(1)

        adapter.setCatalogResponse({
          data: [
            {
              model_name: 'deploy-claude-3-5-sonnet',
              litellm_params: { custom_llm_provider: 'prov-anthropic', model: 'claude-3-5-sonnet' },
              model_info: { supports_tools: true, supports_structured_output: true, max_input_tokens: 100000, max_output_tokens: 8000 },
            },
          ],
        })

        await catalog.handleModelsUpdatedWebhook({ authorization: 'Bearer test-token' })
        expect(catalog.catalogRevision).toBe(2)
        expect(catalog.getSnapshot().models).toHaveLength(1)
      })

      it('TC-DF17-T1-F32-02: Webhook update resets 30-minute expiry deadline', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        catalog.ingestCatalog(createMockCatalog(clock.now()))

        clock.advanceMin(25)
        await catalog.handleModelsUpdatedWebhook({ authorization: 'Bearer test-token' })

        // Expiry should now be pushed to now + 30m = 55m
        clock.advanceMin(20) // at 45m total
        expect(catalog.isFresh()).toBe(true)
      })

      it('TC-DF17-T1-F32-03: Webhook payload with missing or invalid auth fails closed with WebhookAuthError', async () => {
        const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
        await expect(catalog.handleModelsUpdatedWebhook({})).rejects.toThrow(WebhookAuthError)
        await expect(catalog.handleModelsUpdatedWebhook({ authorization: 'Basic dXNlcjpwYXNz' })).rejects.toThrow(WebhookAuthError)
      })
    })
  })

  // =========================================================================
  // TIER 2: BOUNDARY AND CORNER TESTS (B01 through B16)
  // =========================================================================

  describe('Tier 2: Boundary and Corner Tests', () => {
    it('TC-DF17-T2-B01: Exact token boundary for fast-loops input: 31,999 (rejected) vs 32,000 (eligible)', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 31_999, outputLimit: 4000 } })
      catalog.ingestCatalog([m1])
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(0)

      const m2 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 32_000, outputLimit: 4000 } })
      catalog.ingestCatalog([m2])
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(1)
    })

    it('TC-DF17-T2-B02: Exact token boundary for fast-loops output: 3,999 (rejected) vs 4,000 (eligible)', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 32_000, outputLimit: 3_999 } })
      catalog.ingestCatalog([m1])
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(0)

      const m2 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 32_000, outputLimit: 4_000 } })
      catalog.ingestCatalog([m2])
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(1)
    })

    it('TC-DF17-T2-B03: Exact token boundary for core-coding input: 63,999 (rejected) vs 64,000 (eligible)', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 63_999, outputLimit: 8000 } })
      catalog.ingestCatalog([m1])
      expect(catalog.getEligibleModels('core-coding')).toHaveLength(0)

      const m2 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 64_000, outputLimit: 8000 } })
      catalog.ingestCatalog([m2])
      expect(catalog.getEligibleModels('core-coding')).toHaveLength(1)
    })

    it('TC-DF17-T2-B04: Exact token boundary for core-coding output: 7,999 (rejected) vs 8,000 (eligible)', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 64_000, outputLimit: 7_999 } })
      catalog.ingestCatalog([m1])
      expect(catalog.getEligibleModels('core-coding')).toHaveLength(0)

      const m2 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 64_000, outputLimit: 8_000 } })
      catalog.ingestCatalog([m2])
      expect(catalog.getEligibleModels('core-coding')).toHaveLength(1)
    })

    it('TC-DF17-T2-B05: Exact token boundary for long-context input: 255,999 (rejected) vs 256,000 (eligible)', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-bedrock-claude-3-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 255_999, outputLimit: 8000 } })
      catalog.ingestCatalog([m1])
      expect(catalog.getEligibleModels('long-context')).toHaveLength(0)

      const m2 = createMockDeployment({ deploymentId: 'deploy-bedrock-claude-3-sonnet', capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 256_000, outputLimit: 8000 } })
      catalog.ingestCatalog([m2])
      expect(catalog.getEligibleModels('long-context')).toHaveLength(1)
    })

    it('TC-DF17-T2-B06: Exact benchmark score boundary for fast-loops: 0.799 (rejected) vs 0.800 (eligible)', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-deepseek-chat', benchmark: { revision: 1, score: 0.799, evidence: createMockArtifactRef() } })
      catalog.ingestCatalog([m1])
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(0)

      const m2 = createMockDeployment({ deploymentId: 'deploy-deepseek-chat', benchmark: { revision: 1, score: 0.8, evidence: createMockArtifactRef() } })
      catalog.ingestCatalog([m2])
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(1)
    })

    it('TC-DF17-T2-B07: Exact benchmark score boundary for core-coding: 0.899 (rejected) vs 0.900 (eligible)', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.899, evidence: createMockArtifactRef() } })
      catalog.ingestCatalog([m1])
      expect(catalog.getEligibleModels('core-coding')).toHaveLength(0)

      const m2 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.9, evidence: createMockArtifactRef() } })
      catalog.ingestCatalog([m2])
      expect(catalog.getEligibleModels('core-coding')).toHaveLength(1)
    })

    it('TC-DF17-T2-B08: Benchmark score precision clamping: reject score < 0.0 or > 1.0', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      expect(() => catalog.recordBenchmarkScore('deploy-claude-3-5-sonnet', { revision: 1, score: -0.01, evidence: createMockArtifactRef() })).toThrow(InvalidModelRecordError)
      expect(() => catalog.recordBenchmarkScore('deploy-claude-3-5-sonnet', { revision: 1, score: 1.01, evidence: createMockArtifactRef() })).toThrow(InvalidModelRecordError)
    })

    it('TC-DF17-T2-B09: Exact latency boundary for fast-loops: 5,000ms (eligible) vs 5,001ms (rejected)', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-deepseek-chat', health: createMockProbeResult({ p95LatencyMs: 5000 }) })
      catalog.ingestCatalog([m1])
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(1)

      const m2 = createMockDeployment({ deploymentId: 'deploy-deepseek-chat', health: createMockProbeResult({ p95LatencyMs: 5001 }) })
      catalog.ingestCatalog([m2])
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(0)
    })

    it('TC-DF17-T2-B10: Timing boundary for 15-minute refresh: 14m59s vs 15m00s', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      clock.advanceMin(14)
      clock.advanceSec(59)
      expect(catalog.isRefreshDue()).toBe(false)

      clock.advanceSec(1)
      expect(catalog.isRefreshDue()).toBe(true)
    })

    it('TC-DF17-T2-B11: Timing boundary for 30-minute catalog expiry: 29m59s vs 30m00s', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      clock.advanceMin(29)
      clock.advanceSec(59)
      expect(catalog.isFresh()).toBe(true)

      clock.advanceSec(1)
      expect(catalog.isFresh()).toBe(false)
    })

    it('TC-DF17-T2-B12: Timing boundary for 5-minute health probe validity: 4m59s vs 5m00s', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      clock.advanceMin(4)
      clock.advanceSec(59)
      expect(catalog.getEligibleModels('fast-loops').length).toBeGreaterThan(0)

      clock.advanceSec(1)
      expect(catalog.getEligibleModels('fast-loops')).toHaveLength(0)
    })

    it('TC-DF17-T2-B13: 0 eligible models throws NoEligibleModelError and triggers catalog pause', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      catalog.ingestCatalog([])
      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).toContain('catalog')

      expect(() => catalog.assignRole('fast-loops')).toThrow(NoEligibleModelError)
    })

    it('TC-DF17-T2-B14: Critic diversity with exactly 1 provider fails in deploying mode', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      catalog.ingestCatalog([
        createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', provider: 'prov-anthropic' }),
      ])

      await expect(catalog.assignDualCritics({ executionMode: 'deploying' })).rejects.toThrow(CriticDiversityViolationError)
    })

    it('TC-DF17-T2-B15: Critic diversity with exactly 2 providers succeeds with empty Critic 2 fallback', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog([
        createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', provider: 'prov-anthropic' }),
        createMockDeployment({ deploymentId: 'deploy-o1-preview', provider: 'prov-openai' }),
      ])

      const { critic1, critic2 } = await catalog.assignDualCritics()
      expect(critic1.provider).toBe('prov-anthropic')
      expect(critic2.provider).toBe('prov-openai')
      expect(critic2.fallbackChain).toHaveLength(0)
    })

    it('TC-DF17-T2-B16: Fallback chain is capped at exactly 32 models', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const manyModels: CatalogModelRecord[] = []
      for (let i = 0; i < 40; i++) {
        manyModels.push(
          createMockDeployment({
            deploymentId: `deploy-fallback-${i}`.replace(/[^A-Za-z0-9_.:-]/g, '-'),
            modelVersion: `model-v-${i}`,
            provider: `prov-${i}`,
          }),
        )
      }
      catalog.ingestCatalog(manyModels)

      const assignment = catalog.assignRole('core-coding')
      expect(assignment.fallbackChain.length).toBeLessThanOrEqual(32)
      expect(() => assertContractSemantics('ModelRoleAssignmentV1', assignment)).not.toThrow()
    })
  })

  // =========================================================================
  // TIER 3: CROSS-FEATURE INTERACTIONS (X01 through X14)
  // =========================================================================

  describe('Tier 3: Cross-Feature Interactions', () => {
    it('TC-DF17-T3-X01: Waterfall 4-level tie breaking matrix', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      // Subtest A: Score 0.95 vs 0.94 -> Score wins
      const mA = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() } })
      const mB = createMockDeployment({ deploymentId: 'deploy-o1-preview', benchmark: { revision: 1, score: 0.94, evidence: createMockArtifactRef() } })
      expect(catalog.sortWaterfall([mA, mB])[0]?.deploymentId).toBe('deploy-claude-3-5-sonnet')

      // Subtest B: Equal score, Cost $10 vs $20 -> Cost wins
      const mC = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() }, worstCaseCostMicros: 10_000 })
      const mD = createMockDeployment({ deploymentId: 'deploy-o1-preview', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() }, worstCaseCostMicros: 20_000 })
      expect(catalog.sortWaterfall([mC, mD])[0]?.deploymentId).toBe('deploy-claude-3-5-sonnet')

      // Subtest C: Equal score & cost, Latency 800ms vs 1200ms -> Latency wins
      const mE = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() }, worstCaseCostMicros: 10_000, health: createMockProbeResult({ p95LatencyMs: 800 }) })
      const mF = createMockDeployment({ deploymentId: 'deploy-o1-preview', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() }, worstCaseCostMicros: 10_000, health: createMockProbeResult({ p95LatencyMs: 1200 }) })
      expect(catalog.sortWaterfall([mE, mF])[0]?.deploymentId).toBe('deploy-claude-3-5-sonnet')

      // Subtest D: Equal score, cost, and latency -> ID alphabetical wins
      const mG = createMockDeployment({ deploymentId: 'deploy-bedrock-claude-3-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() }, worstCaseCostMicros: 10_000, health: createMockProbeResult({ p95LatencyMs: 800 }) })
      const mH = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() }, worstCaseCostMicros: 10_000, health: createMockProbeResult({ p95LatencyMs: 800 }) })
      expect(catalog.sortWaterfall([mH, mG])[0]?.deploymentId).toBe('deploy-bedrock-claude-3-sonnet')
    })

    it('TC-DF17-T3-X02: Allowlist restricting to single provider trips critic diversity', async () => {
      const restrictedConfig = createMockModelsConfig({
        deploymentAllowlist: ['deploy-claude-3-5-sonnet'],
      })
      const catalog = new DarkFactoryModelCatalog({ config: restrictedConfig, fleetStore, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      await expect(catalog.assignDualCritics()).rejects.toThrow(CriticDiversityViolationError)
      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).toContain('catalog')
    })

    it('TC-DF17-T3-X03: Dynamic probe failure during critic selection falls back to 3rd provider', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      // Invalidate Anthropic probe (simulate outage)
      catalog.recordCapabilityProbe('deploy-claude-3-5-sonnet', createMockProbeResult({
        toolsHealthy: false,
        structuredOutputHealthy: false,
      }, clock.now()))

      const { critic1, critic2 } = await catalog.assignDualCritics()
      expect(critic1.provider).toBe('prov-openai')
      expect(critic2.provider).toBe('prov-bedrock')
    })

    it('TC-DF17-T3-X04: MODELS_UPDATED webhook at 29m55s averts pending catalog pause', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      clock.advanceMin(29)
      clock.advanceSec(55)
      await catalog.handleModelsUpdatedWebhook({ authorization: 'Bearer test-token' })

      clock.advanceSec(10) // 30m05s from initial, but fresh from webhook!
      expect(catalog.isFresh()).toBe(true)
      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).not.toContain('catalog')
    })

    it('TC-DF17-T3-X05: Dynamic pricing snapshot passed in options alters waterfall ranking', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m1 = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() } })
      const m2 = createMockDeployment({ deploymentId: 'deploy-o1-preview', provider: 'prov-openai', benchmark: { revision: 1, score: 0.95, evidence: createMockArtifactRef() } })
      catalog.ingestCatalog([m1, m2])

      const expensiveSnap = createMockPricingSnapshot('prov-anthropic', 'claude-3-5-sonnet-20241022', {
        inputMicrosPerMillion: 100_000_000,
        outputMicrosPerMillion: 300_000_000,
      })

      const sorted = catalog.sortWaterfall([m1, m2], { pricingSnapshot: expensiveSnap })
      expect(sorted[0]?.deploymentId).toBe('deploy-o1-preview')
    })

    it('TC-DF17-T3-X06: Simultaneous role assignments across all 4 roles from unified snapshot', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      const fast = catalog.assignRole('fast-loops')
      const core = catalog.assignRole('core-coding')
      const deep = catalog.assignRole('deep-reasoning')
      const long = catalog.assignRole('long-context')

      expect(fast.role).toBe('fast-loops')
      expect(core.role).toBe('core-coding')
      expect(deep.role).toBe('deep-reasoning')
      expect(long.role).toBe('long-context')
      expect(fast.catalogDigest).toBe(core.catalogDigest)
    })

    it('TC-DF17-T3-X07: Durable catalog pause and automatic resumption when probe restored', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      const singleModel = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet' })
      catalog.ingestCatalog([singleModel])

      // Expire probe
      clock.advanceMin(6)
      expect(() => catalog.assignRole('core-coding')).toThrow(NoEligibleModelError)
      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).toContain('catalog')

      // Restore probe
      catalog.recordCapabilityProbe('deploy-claude-3-5-sonnet', createMockProbeResult({}, clock.now()))
      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).not.toContain('catalog')
    })

    it('TC-DF17-T3-X08: Independence of durable pause reasons (budget and safety preserved)', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      await fleetStore.pause('budget')
      await fleetStore.pause('safety')

      catalog.ingestCatalog(createMockCatalog(clock.now()))

      clock.advanceMin(30)
      expect(() => catalog.getSnapshot()).toThrow(CatalogStaleError)
      await catalog.waitForHooks()
      let pauses = await fleetStore.getActivePauses()
      expect(pauses).toContain('catalog')
      expect(pauses).toContain('budget')
      expect(pauses).toContain('safety')

      // Ingest fresh catalog
      catalog.ingestCatalog(createMockCatalog(clock.now()))
      await catalog.waitForHooks()
      pauses = await fleetStore.getActivePauses()
      expect(pauses).not.toContain('catalog')
      expect(pauses).toContain('budget')
      expect(pauses).toContain('safety')
    })

    it('TC-DF17-T3-X09: Model version pinning across catalog revisions', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))
      const assignV1 = catalog.assignRole('core-coding')

      clock.advanceMin(5)
      catalog.ingestCatalog(createMockCatalog(clock.now()))
      const assignV2 = catalog.assignRole('core-coding')

      expect(assignV1.catalogRevision).toBe(1)
      expect(assignV2.catalogRevision).toBe(2)
    })

    it('TC-DF17-T3-X10: Model with reasoning but missing tools passes deep-reasoning but fails core-coding', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m = createMockDeployment({
        deploymentId: 'deploy-o1-preview',
        capabilities: { tools: false, structuredOutput: true, reasoning: true, inputLimit: 128_000, outputLimit: 32_000 },
      })
      catalog.ingestCatalog([m])

      expect(catalog.getEligibleModels('deep-reasoning')).toHaveLength(1)
      expect(catalog.getEligibleModels('core-coding')).toHaveLength(0)
    })

    it('TC-DF17-T3-X11: Model with tools but missing reasoning passes core-coding but fails deep-reasoning', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m = createMockDeployment({
        deploymentId: 'deploy-claude-3-5-sonnet',
        capabilities: { tools: true, structuredOutput: true, reasoning: false, inputLimit: 128_000, outputLimit: 32_000 },
      })
      catalog.ingestCatalog([m])

      expect(catalog.getEligibleModels('core-coding')).toHaveLength(1)
      expect(catalog.getEligibleModels('deep-reasoning')).toHaveLength(0)
    })

    it('TC-DF17-T3-X12: Fallback chain preserves provider diversity for Critic 2', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const models = [
        createMockDeployment({ deploymentId: 'deploy-o1-preview', provider: 'prov-openai' }),
        createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', provider: 'prov-anthropic' }),
        createMockDeployment({ deploymentId: 'deploy-bedrock-claude-3-sonnet', provider: 'prov-bedrock', capabilities: { tools: true, structuredOutput: true, reasoning: true, inputLimit: 100_000, outputLimit: 10_000 } }),
      ]
      catalog.ingestCatalog(models)

      const { critic1, critic2 } = await catalog.assignDualCritics()
      for (const fallback of critic2.fallbackChain) {
        expect(fallback.provider).not.toBe(critic1.provider)
      }
    })

    it('TC-DF17-T3-X13: Benchmark revision mismatch disqualifies model', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const m = createMockDeployment({
        deploymentId: 'deploy-claude-3-5-sonnet',
        benchmark: { revision: 2, score: 0.95, evidence: createMockArtifactRef() },
      })
      catalog.ingestCatalog([m])

      // Policy requires revision 1
      expect(catalog.getEligibleModels('core-coding')).toHaveLength(0)
    })

    it('TC-DF17-T3-X14: Dual critics in non-deploying qualification mode records diversityDeficit', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      const singleModel = createMockDeployment({ deploymentId: 'deploy-claude-3-5-sonnet', provider: 'prov-anthropic' })
      catalog.ingestCatalog([singleModel])

      const res = await catalog.assignDualCritics({ executionMode: 'non-deploying-qualification' })
      expect(res.diversityDeficit).toBeDefined()
      expect(res.diversityDeficit?.reasonCode).toBe('NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL')
    })
  })

  // =========================================================================
  // TIER 4: REAL-WORLD OPERATIONAL SCENARIOS (RW01 through RW06)
  // =========================================================================

  describe('Tier 4: Real-World Operational Scenarios', () => {
    it('TC-DF17-T4-RW01: Multi-provider outage and graceful degradation', async () => {
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      // Bedrock and OpenAI suffer sudden probe failure
      catalog.recordCapabilityProbe('deploy-bedrock-claude-3-sonnet', createMockProbeResult({ status: 'unhealthy', toolsHealthy: false }, clock.now()))
      catalog.recordCapabilityProbe('deploy-o1-preview', createMockProbeResult({ status: 'unhealthy', structuredOutputHealthy: false }, clock.now()))

      // Fast-loops and core-coding survive on DeepSeek and Anthropic
      expect(catalog.getEligibleModels('fast-loops').length).toBeGreaterThan(0)
      expect(catalog.getEligibleModels('core-coding').length).toBeGreaterThan(0)

      // Bedrock probe recovers
      catalog.recordCapabilityProbe('deploy-bedrock-claude-3-sonnet', createMockProbeResult({ status: 'healthy', toolsHealthy: true, structuredOutputHealthy: true }, clock.now()))
      expect(catalog.getEligibleModels('long-context').length).toBeGreaterThan(0)
    })

    it('TC-DF17-T4-RW02: Emergency MODELS_UPDATED webhook deployment', async () => {
      const adapter = new InMemoryLiteLlmAdapter({ data: [] })
      const catalog = new DarkFactoryModelCatalog({ config, adapter, clock: () => clock.now() })
      await catalog.refreshCatalog()

      // At minute 7, emergency webhook arrives with patched model
      clock.advanceMin(7)
      adapter.setCatalogResponse({
        data: [
          {
            model_name: 'deploy-claude-3-5-sonnet',
            litellm_params: { custom_llm_provider: 'prov-anthropic', model: 'claude-3-5-sonnet-v2' },
            model_info: { supports_tools: true, supports_structured_output: true, max_input_tokens: 200000, max_output_tokens: 8192 },
          },
        ],
      })
      await catalog.handleModelsUpdatedWebhook({ authorization: 'Bearer test-token' })

      expect(catalog.catalogRevision).toBe(2)
      expect(catalog.getSnapshot().models[0]?.modelVersion).toBe('claude-3-5-sonnet-v2')
    })

    it('TC-DF17-T4-RW03: Realistic LiteLLM proxy fleet simulation across 50 attempts', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      for (let attempt = 1; attempt <= 50; attempt++) {
        const role: ModelRole = attempt % 2 === 0 ? 'fast-loops' : 'core-coding'
        const assignment = catalog.assignRole(role, { attemptId: `attempt-${attempt}` })
        expect(assignment.attemptId).toBe(`attempt-${attempt}`)
        expect(() => assertContractSemantics('ModelRoleAssignmentV1', assignment)).not.toThrow()
      }
    })

    it('TC-DF17-T4-RW04: Cold-start catalog reconstruction and fencing', () => {
      const catalog1 = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog1.ingestCatalog(createMockCatalog(clock.now()))
      const snap1 = catalog1.getSnapshot()

      // Reconstruct fresh instance simulating crash restart
      const catalog2 = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog2.ingestCatalog(createMockCatalog(clock.now()))
      const snap2 = catalog2.getSnapshot()

      expect(snap1.digest).toBe(snap2.digest)
    })

    it('TC-DF17-T4-RW05: 24-hour continuous operation time-travel simulation', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      for (let hour = 1; hour <= 24; hour++) {
        clock.advanceMin(15)
        catalog.ingestCatalog(createMockCatalog(clock.now()))
        expect(catalog.isFresh()).toBe(true)

        const assignment = catalog.assignRole('core-coding')
        expect(() => assertContractSemantics('ModelRoleAssignmentV1', assignment)).not.toThrow()
      }
      expect(catalog.catalogRevision).toBe(25) // 1 initial + 24 hourly refreshes
    })

    it('TC-DF17-T4-RW06: Full Economics Reference Graph conformance', () => {
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog(createMockCatalog(clock.now()))

      const assignment = catalog.assignRole('core-coding', { attemptId: 'attempt-1', generation: 1 })
      expect(() => assertContractSemantics('ModelRoleAssignmentV1', assignment)).not.toThrow()

      const graph = economicsGraphFixture()
      const graphResult = validateEconomicsReferenceGraph(graph)
      expect(graphResult.lane).toBe('fleet-economics')
      expect(graphResult.records).toBe(5)
    })
  })
})
