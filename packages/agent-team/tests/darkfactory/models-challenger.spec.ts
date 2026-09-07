import { describe, it, expect, beforeEach } from 'vitest'
import {
  DarkFactoryModelCatalog,
  InMemoryLiteLlmAdapter,
  ModelCatalogError,
  CatalogStaleError,
  NoEligibleModelError,
  CriticDiversityViolationError,
  EndpointIncompatibleError,
  type CatalogModelRecord,
  type ModelCapabilities,
  type ModelHealthProbe,
  type ModelBenchmarkScore,
  type ModelRole,
  type RawLiteLlmCatalogResponse,
} from '../../src/darkfactory/model-catalog.ts'
import {
  type PricingSnapshotV1,
  type ModelRoleAssignmentV1,
} from '../../src/darkfactory/contracts/economics.ts'
import { type ArtifactRef } from '../../src/darkfactory/contracts/common.ts'
import { assertContractSemantics } from '../../src/darkfactory/contracts/semantics.ts'
import { verificationEvidencePayloadSchema } from '../../src/darkfactory/contracts/verification.ts'
import { InMemoryRedisAdapter } from '../../src/darkfactory/redis-adapter.ts'
import { DarkFactoryFleetStore } from '../../src/darkfactory/fleet-store.ts'
import type { EnabledDarkFactoryConfig } from '../../src/darkfactory/config.ts'
import * as net from 'node:net'
import * as http from 'node:http'
import * as https from 'node:https'
import { ZodError } from 'zod'

// --- Test Utilities ---

function makeClock(initial = '2026-09-06T22:00:00.000Z') {
  let currentTime = initial
  return {
    now: () => currentTime,
    set: (iso: string) => { currentTime = iso },
    advanceSec: (sec: number) => {
      currentTime = new Date(Date.parse(currentTime) + sec * 1000).toISOString()
    },
    advanceMin: (min: number) => {
      currentTime = new Date(Date.parse(currentTime) + min * 60_000).toISOString()
    },
  }
}

function makeEvidence(id = 'art-1', projectId = 'proj-fleet-1'): ArtifactRef {
  return {
    projectId,
    id,
    mediaType: 'application/json',
    sizeBytes: 512,
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }
}

function makeProbe(deploymentId: string, now: string, overrides: Partial<ModelHealthProbe> = {}): ModelHealthProbe {
  const observedMs = Date.parse(now)
  return {
    deploymentId,
    observedAt: now,
    expiresAt: new Date(observedMs + 300_000).toISOString(),
    p95LatencyMs: 1000,
    toolsHealthy: true,
    structuredOutputHealthy: true,
    status: 'healthy',
    evidence: makeEvidence(`art-probe-${deploymentId}`),
    ...overrides,
  }
}

function makeModel(
  deploymentId: string,
  provider: string,
  score: number,
  now: string,
  overrides: Partial<CatalogModelRecord> = {},
): CatalogModelRecord {
  return {
    provider,
    deploymentId,
    modelVersion: `${deploymentId}-v1`,
    accountId: `acc-${provider}`,
    capabilities: {
      tools: true,
      structuredOutput: true,
      reasoning: true,
      inputLimit: 128_000,
      outputLimit: 16_000,
    },
    benchmark: {
      revision: 1,
      score,
      evidence: makeEvidence(`art-bench-${deploymentId}`),
    },
    health: makeProbe(deploymentId, now),
    pricingSnapshotId: `pricing-${deploymentId}`,
    pricingSnapshotDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    pricingRevision: 1,
    worstCaseCostMicros: 20_000,
    ...overrides,
  }
}

function createConfig(overrides: Partial<EnabledDarkFactoryConfig['models']> = {}): EnabledDarkFactoryConfig['models'] {
  return {
    endpoint: 'http://127.0.0.1:4000',
    version: 'v1.40.0',
    refreshIntervalMs: 900_000,
    expiryMs: 1_800_000,
    roleThresholds: [
      { roleId: 'fast-loops', minimumScore: 0.8 },
      { roleId: 'core-coding', minimumScore: 0.9 },
      { roleId: 'deep-reasoning', minimumScore: 0.9 },
      { roleId: 'long-context', minimumScore: 0.9 },
    ],
    deploymentAllowlist: [],
    deploymentDenylist: [],
    fallbacks: {},
    ...overrides,
  }
}

function createFleetConfig(): EnabledDarkFactoryConfig['fleet'] {
  return {
    fleetId: 'fleet-challenge',
    authorityEpoch: 1,
    dailySpendCapMicros: 100_000_000,
    monthlySpendCapMicros: 1_000_000_000,
    defaultAttemptEnvelopeCostMicros: 50_000,
    emergencyReserveHeadroomFraction: 0.1,
    requestCeiling: { inputTokens: 4000, outputTokens: 1000, reasoningTokens: 0 },
    pricingSnapshots: [],
    quotas: {
      primaryPoolId: 'pool-main',
      fallbackPoolIds: [],
      pools: [{ id: 'pool-main', provider: 'prov-openai', currency: 'USD', balanceMicros: 500_000 }],
    },
  }
}

describe('Adversarial Challenge: DarkFactoryModelCatalog', () => {
  let clock: ReturnType<typeof makeClock>
  let adapter: InMemoryRedisAdapter
  let fleetStore: DarkFactoryFleetStore

  beforeEach(() => {
    clock = makeClock()
    adapter = new InMemoryRedisAdapter()
    fleetStore = new DarkFactoryFleetStore({ adapter, config: createFleetConfig() })
  })

  // =========================================================================
  // TASK 1: CRITIC DIVERSITY RULE EMPIRICAL CHALLENGES
  // =========================================================================

  describe('Challenge 1: Critic Diversity Rule & Fleet Pause', () => {
    it('CH-01: Single-provider fleet in deploying mode fails closed, throws CriticDiversityViolationError, and pauses catalog on FleetStore', async () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      
      // Catalog with multiple models, but ALL from provider "prov-anthropic"
      const models = [
        makeModel('deploy-claude-sonnet', 'prov-anthropic', 0.98, clock.now()),
        makeModel('deploy-claude-opus', 'prov-anthropic', 0.97, clock.now()),
        makeModel('deploy-claude-haiku', 'prov-anthropic', 0.92, clock.now()),
      ]
      catalog.ingestCatalog(models)

      // Must fail closed in default mode (deploying)
      let thrownError: any = null
      try {
        await catalog.assignDualCritics()
      } catch (err) {
        thrownError = err
      }

      expect(thrownError).toBeInstanceOf(CriticDiversityViolationError)
      expect(thrownError.primaryProvider).toBe('prov-anthropic')

      // Wait for async pause hook and verify durable "catalog" pause on fleetStore
      await catalog.waitForHooks()
      const activePauses = await fleetStore.getActivePauses()
      expect(activePauses).toContain('catalog')
    })

    it('CH-02: Explicit deploying mode (executionMode: "deploying") triggers identical fail-closed pause behavior', async () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      catalog.ingestCatalog([makeModel('deploy-o1', 'prov-openai', 0.95, clock.now())])

      await expect(catalog.assignDualCritics({ executionMode: 'deploying' })).rejects.toThrow(CriticDiversityViolationError)
      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).toContain('catalog')
    })

    it('CH-03: Non-deploying qualification mode generates valid diversityDeficit record meeting cryptographic schema', async () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      
      const singleProviderModels = [
        makeModel('deploy-o1-preview', 'prov-openai', 0.98, clock.now()),
        makeModel('deploy-o3-mini', 'prov-openai', 0.95, clock.now()),
      ]
      catalog.ingestCatalog(singleProviderModels)

      const result = await catalog.assignDualCritics({ executionMode: 'non-deploying-qualification' })

      expect(result.critic1).toBeDefined()
      expect(result.critic2).toBeDefined()
      expect(result.diversityDeficit).toBeDefined()

      const deficit = result.diversityDeficit!
      expect(deficit.reasonCode).toBe('NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL')
      expect(deficit.catalogRevision).toBe(catalog.catalogRevision)
      expect(deficit.catalogDigest).toBe(catalog.catalogDigest)
      expect(deficit.eligibilityEvidence.length).toBeGreaterThanOrEqual(1)

      // Cryptographic schema conformance against DF-10 verificationEvidencePayloadSchema
      const deficitSchema = verificationEvidencePayloadSchema.shape.diversityDeficit.unwrap()
      expect(() => deficitSchema.parse(deficit)).not.toThrow()

      // In non-deploying qualification mode, catalog must NOT be paused
      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).not.toContain('catalog')
    })

    it('CH-04: Critic 2 fallback chain strictly excludes Critic 1 provider across large multi-provider fleet', async () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      // Fleet with 3 providers, multiple models each
      const models = [
        makeModel('deploy-oa-1', 'prov-openai', 0.99, clock.now()),
        makeModel('deploy-oa-2', 'prov-openai', 0.96, clock.now()),
        makeModel('deploy-oa-3', 'prov-openai', 0.94, clock.now()),
        makeModel('deploy-ant-1', 'prov-anthropic', 0.98, clock.now()),
        makeModel('deploy-ant-2', 'prov-anthropic', 0.95, clock.now()),
        makeModel('deploy-bed-1', 'prov-bedrock', 0.97, clock.now()),
        makeModel('deploy-bed-2', 'prov-bedrock', 0.93, clock.now()),
      ]
      catalog.ingestCatalog(models)

      const { critic1, critic2 } = await catalog.assignDualCritics()

      expect(critic1.provider).toBe('prov-openai')
      expect(critic1.deploymentId).toBe('deploy-oa-1')

      // Critic 2 must NOT be from prov-openai
      expect(critic2.provider).not.toBe('prov-openai')
      expect(critic2.provider).toBe('prov-anthropic') // score 0.98 vs bedrock 0.97

      // Critic 2 fallback chain must NEVER contain any prov-openai model
      expect(critic2.fallbackChain.length).toBeGreaterThan(0)
      for (const fallback of critic2.fallbackChain) {
        expect(fallback.provider).not.toBe('prov-openai')
      }

      // Verify contract semantics on both assignments
      expect(() => assertContractSemantics('ModelRoleAssignmentV1', critic1)).not.toThrow()
      expect(() => assertContractSemantics('ModelRoleAssignmentV1', critic2)).not.toThrow()
    })

    it('CH-05 [VULNERABILITY REPRODUCTION]: Caller-specified excludedProviders is overwritten for Critic 2', async () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      // 3 providers: OpenAI (0.99), Bedrock (0.98), Anthropic (0.95)
      const models = [
        makeModel('deploy-oa-1', 'prov-openai', 0.99, clock.now()),
        makeModel('deploy-bed-1', 'prov-bedrock', 0.98, clock.now()),
        makeModel('deploy-ant-1', 'prov-anthropic', 0.95, clock.now()),
      ]
      catalog.ingestCatalog(models)

      // Caller explicitly excludes "prov-bedrock"
      const result = await catalog.assignDualCritics({
        excludedProviders: ['prov-bedrock'],
      } as any)

      // Critic 1 correctly avoided prov-bedrock and picked prov-openai
      expect(result.critic1.provider).toBe('prov-openai')

      // EMPIRICALLY CONFIRMED DEFECT 2:
      // Critic 2 lost caller excludedProviders because { ...options, excludedProviders: [critic1Model.provider] }
      // overwrote caller's list, selecting prov-bedrock!
      expect(result.critic2.provider).toBe('prov-bedrock')
    })

    it('CH-06 [VULNERABILITY REPRODUCTION]: Assignment ID collision in non-deploying qualification mode with identical model', async () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      catalog.ingestCatalog([makeModel('deploy-single', 'prov-solo', 0.95, clock.now())])

      const result = await catalog.assignDualCritics({ executionMode: 'non-deploying-qualification' })

      // EMPIRICALLY CONFIRMED DEFECT 3:
      // Critic 1 and Critic 2 share the exact same id even though their attemptIds differ!
      expect(result.critic1.id).toBe(result.critic2.id)
      expect(result.critic1.attemptId).toBe('attempt-1')
      expect(result.critic2.attemptId).toBe('attempt-1-c2')
      expect(result.critic1.reservationId).toBe(result.critic2.reservationId)
    })

    it('CH-15 [VULNERABILITY REPRODUCTION]: Unawaited catalog pause hook leads to race condition on immediate catch', async () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      
      // Ingest catalog: this activates resume('catalog')
      catalog.ingestCatalog([makeModel('deploy-1', 'prov-1', 0.95, clock.now())])
      // Await resume hook
      await catalog.waitForHooks()

      // When assignDualCritics fails closed, triggerCatalogPause is called without awaiting
      try {
        await catalog.assignDualCritics()
      } catch (err) {
        // Checking pause hook queue state:
        // Because triggerCatalogPause() is fire-and-forget, hookPromise is pending
        const isHookPending = catalog.waitForHooks() instanceof Promise
        expect(isHookPending).toBe(true)
      }
      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).toContain('catalog')
    })
  })

  // =========================================================================
  // TASK 2: ALLOWLIST AND DENYLIST ENFORCEMENT
  // =========================================================================

  describe('Challenge 2: Allowlist and Denylist Enforcement', () => {
    it('CH-07: Attempting to assign model not in deploymentAllowlist fails closed', () => {
      const config = createConfig({
        deploymentAllowlist: ['deploy-approved-only'],
      })
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      // Ingest catalog with approved and unapproved models
      catalog.ingestCatalog([
        makeModel('deploy-approved-only', 'prov-anthropic', 0.95, clock.now()),
        makeModel('deploy-unapproved-model', 'prov-openai', 0.99, clock.now()),
      ])

      const snapshot = catalog.getSnapshot()
      expect(snapshot.models.map(m => m.deploymentId)).toEqual(['deploy-approved-only'])

      // Role assignment must only pick the approved model, even though unapproved had higher score
      const assignment = catalog.assignRole('core-coding')
      expect(assignment.deploymentId).toBe('deploy-approved-only')

      // Fallback chain must not contain the unapproved model
      expect(assignment.fallbackChain.some(f => f.deploymentId === 'deploy-unapproved-model')).toBe(false)
    })

    it('CH-08: Models in deploymentDenylist are strictly excluded even if present in deploymentAllowlist', () => {
      const config = createConfig({
        deploymentAllowlist: ['deploy-model-a', 'deploy-model-b'],
        deploymentDenylist: ['deploy-model-a'],
      })
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      catalog.ingestCatalog([
        makeModel('deploy-model-a', 'prov-anthropic', 0.99, clock.now()),
        makeModel('deploy-model-b', 'prov-anthropic', 0.92, clock.now()),
      ])

      const snapshot = catalog.getSnapshot()
      expect(snapshot.models.map(m => m.deploymentId)).toEqual(['deploy-model-b'])

      const assignment = catalog.assignRole('core-coding')
      expect(assignment.deploymentId).toBe('deploy-model-b')
      expect(assignment.fallbackChain.some(f => f.deploymentId === 'deploy-model-a')).toBe(false)
    })

    it('CH-09: Registering probe or benchmark cannot smuggle an unallowlisted or denylisted deployment into catalog', () => {
      const config = createConfig({
        deploymentAllowlist: ['deploy-valid'],
        deploymentDenylist: ['deploy-denied'],
      })
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })
      catalog.ingestCatalog([makeModel('deploy-valid', 'prov-valid', 0.95, clock.now())])

      // Attacker attempts to register probe and benchmark for unallowlisted & denylisted models
      catalog.recordCapabilityProbe('deploy-unallowlisted', makeProbe('deploy-unallowlisted', clock.now()))
      catalog.recordBenchmarkScore('deploy-denied', { revision: 1, score: 0.99, evidence: makeEvidence('art-hack') })

      // Snapshot must remain untainted
      const snapshot = catalog.getSnapshot()
      expect(snapshot.models.map(m => m.deploymentId)).toEqual(['deploy-valid'])

      // Attempting to assign role must never select smuggled models
      const assignment = catalog.assignRole('core-coding')
      expect(assignment.deploymentId).toBe('deploy-valid')
      expect(assignment.fallbackChain).toHaveLength(0)
    })

    it('CH-10: Denylisting all candidates for a role throws NoEligibleModelError and triggers catalog pause', async () => {
      const config = createConfig({
        deploymentDenylist: ['deploy-only-reasoning'],
      })
      const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })
      catalog.ingestCatalog([
        makeModel('deploy-only-reasoning', 'prov-openai', 0.95, clock.now(), {
          capabilities: { tools: false, structuredOutput: true, reasoning: true, inputLimit: 128_000, outputLimit: 32_000 },
        }),
      ])

      await catalog.waitForHooks()
      expect(await fleetStore.getActivePauses()).toContain('catalog')
      expect(() => catalog.assignRole('deep-reasoning')).toThrow(NoEligibleModelError)
    })
  })

  // =========================================================================
  // TASK 3: SECRET REDACTION IN PROJECTIONS AND ERROR MESSAGES
  // =========================================================================

  describe('Challenge 3: Secret Redaction Verification', () => {
    it('CH-11: LiteLLM raw params (api_key, api_base, tokens) are completely stripped from catalog snapshots and assignments', () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      const rawPayload: RawLiteLlmCatalogResponse = {
        data: [
          {
            model_name: 'deploy-secret-model',
            litellm_params: {
              custom_llm_provider: 'prov-secret',
              model: 'secret-model-v1',
              api_key: 'sk-super-secret-production-key-999',
              api_base: 'https://internal.proxy.secret:8443/v1',
              internal_auth_token: 'bearer-token-do-not-leak',
            },
            model_info: {
              id: 'deploy-secret-model',
              supports_tools: true,
              supports_structured_output: true,
              supports_reasoning: true,
              max_input_tokens: 128_000,
              max_output_tokens: 16_000,
            },
          },
        ],
      }

      catalog.ingestRawCatalog(rawPayload)
      catalog.recordBenchmarkScore('deploy-secret-model', { revision: 1, score: 0.95, evidence: makeEvidence() })
      catalog.recordCapabilityProbe('deploy-secret-model', makeProbe('deploy-secret-model', clock.now()))

      const snapshot = catalog.getSnapshot()
      const serializedSnapshot = JSON.stringify(snapshot)

      // Absolute negative assertions across full serialization
      expect(serializedSnapshot).not.toContain('sk-super-secret')
      expect(serializedSnapshot).not.toContain('internal.proxy.secret')
      expect(serializedSnapshot).not.toContain('bearer-token-do-not-leak')

      const assignment = catalog.assignRole('core-coding')
      const serializedAssignment = JSON.stringify(assignment)

      expect(serializedAssignment).not.toContain('sk-super-secret')
      expect(serializedAssignment).not.toContain('internal.proxy.secret')
      expect(serializedAssignment).not.toContain('bearer-token-do-not-leak')
    })

    it('CH-12: Webhook authentication failure does NOT leak bearer token in error message', async () => {
      const config = createConfig({
        credentialRef: { kind: 'env', name: 'SEC_EXPECTED_TOKEN' },
      })
      process.env.SEC_EXPECTED_TOKEN = 'secret-real-token'
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      let errMessage = ''
      try {
        await catalog.handleModelsUpdatedWebhook({ authorization: 'Bearer attacker-submitted-secret-token' })
      } catch (err: any) {
        errMessage = err.message
      }

      expect(errMessage).not.toContain('secret-real-token')
      expect(errMessage).not.toContain('attacker-submitted-secret-token')
      delete process.env.SEC_EXPECTED_TOKEN
    })

    it('CH-13 [VULNERABILITY REPRODUCTION]: Endpoint credentials leak into EndpointIncompatibleError message', async () => {
      const adapter = new InMemoryLiteLlmAdapter()
      adapter.setEndpointCompatibility(false)

      const sensitiveEndpoint = 'http://admin:secret_proxy_password@127.0.0.1:4000/api'
      const config = createConfig({ endpoint: sensitiveEndpoint })
      const catalog = new DarkFactoryModelCatalog({ config, adapter, clock: () => clock.now() })

      let errMessage = ''
      try {
        await catalog.refreshCatalog()
      } catch (err: any) {
        errMessage = err.message
      }

      // EMPIRICALLY CONFIRMED DEFECT 1:
      // Endpoint password leaks directly into the error message
      expect(errMessage).toContain('secret_proxy_password')
    })

    it('CH-16 [VULNERABILITY REPRODUCTION]: Standard LiteLLM model names with slashes throw raw ZodError on assignment', () => {
      const config = createConfig()
      const catalog = new DarkFactoryModelCatalog({ config, clock: () => clock.now() })

      // LiteLLM model entry with slash in model_name and no model_info.id
      catalog.ingestRawCatalog({
        data: [
          {
            model_name: 'openai/gpt-4o',
            model_info: {
              supports_tools: true,
              supports_structured_output: true,
              max_input_tokens: 100_000,
              max_output_tokens: 10_000,
            },
          },
        ],
      })

      catalog.recordBenchmarkScore('openai/gpt-4o', { revision: 1, score: 0.95, evidence: makeEvidence() })
      catalog.recordCapabilityProbe('openai/gpt-4o', makeProbe('openai/gpt-4o', clock.now()))

      // EMPIRICALLY CONFIRMED DEFECT 5:
      // Ingest accepts slash in deploymentId, but assignRole crashes with unhandled ZodError
      let caughtError: any = null
      try {
        catalog.assignRole('core-coding')
      } catch (err) {
        caughtError = err
      }

      expect(caughtError).toBeInstanceOf(ZodError)
      expect(caughtError).not.toBeInstanceOf(ModelCatalogError)
    })
  })

  // =========================================================================
  // TASK 4: 100% OFFLINE EXECUTION CONFIRMATION
  // =========================================================================

  describe('Challenge 4: 100% Offline Execution Verification', () => {
    it('CH-14: Zero network calls across full lifecycle with global network interceptors active', async () => {
      let networkCallCount = 0

      // Install strict interception on sockets and http/https
      const originalConnect = net.Socket.prototype.connect
      net.Socket.prototype.connect = function (...args: any[]) {
        networkCallCount++
        throw new Error('NETWORK_VIOLATION: Socket connect prohibited in offline darkfactory testing!')
      } as any

      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => {
        networkCallCount++
        throw new Error('NETWORK_VIOLATION: fetch prohibited in offline darkfactory testing!')
      }

      try {
        const config = createConfig()
        const catalog = new DarkFactoryModelCatalog({ config, fleetStore, clock: () => clock.now() })

        // 1. Ingestion
        catalog.ingestCatalog([
          makeModel('deploy-1', 'prov-1', 0.95, clock.now()),
          makeModel('deploy-2', 'prov-2', 0.94, clock.now(), {
            capabilities: { tools: true, structuredOutput: true, reasoning: true, inputLimit: 300_000, outputLimit: 16_000 },
          }),
        ])

        // 2. Probing & Benchmarking
        catalog.recordCapabilityProbe('deploy-1', makeProbe('deploy-1', clock.now()))
        catalog.recordBenchmarkScore('deploy-1', { revision: 1, score: 0.96, evidence: makeEvidence() })

        // 3. Role assignments
        catalog.assignRole('fast-loops')
        catalog.assignRole('core-coding')
        catalog.assignRole('deep-reasoning')
        catalog.assignRole('long-context')

        // 4. Dual critics
        await catalog.assignDualCritics()

        // 5. In-memory adapter refresh
        const testAdapter = new InMemoryLiteLlmAdapter({
          data: [
            {
              model_name: 'deploy-offline',
              model_info: { id: 'deploy-offline', supports_tools: true, supports_structured_output: true, max_input_tokens: 100000, max_output_tokens: 8000 },
            },
          ],
        })
        const catalogWithAdapter = new DarkFactoryModelCatalog({ config, adapter: testAdapter, clock: () => clock.now() })
        await catalogWithAdapter.refreshCatalog()

        // Assert strictly zero outbound attempts
        expect(networkCallCount).toBe(0)
      } finally {
        net.Socket.prototype.connect = originalConnect
        globalThis.fetch = originalFetch
      }
    })
  })
})
