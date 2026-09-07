import { describe, expect, it } from 'vitest'
import {
  startDigitalTwinServer,
  executeTwinsStage,
  type TwinContractFixture,
} from '../../src/darkfactory/digital-twins.ts'
import {
  executeDualCriticsStage,
  type CriticConfig,
  type DiversityDeficitRecord,
} from '../../src/darkfactory/critics.ts'
import { digestJson } from '../../src/darkfactory/json.ts'

describe('DF-09 Digital Twins and Dual Independent Critics', () => {
  describe('Part 1: Digital Twins Contract Fixtures and Local Stubs', () => {
    const paymentTwinFixture: TwinContractFixture = {
      id: 'twin-payments',
      serviceName: 'payment-gateway',
      version: '1.0.0',
      imageOrToolDigest: digestJson({ image: 'payment-mock:v1' }),
      routes: [
        {
          method: 'POST',
          path: '/v1/charges',
          headers: { 'x-idempotency-key': 'idem-1' },
          bodyPattern: { amount: 100 },
          response: {
            status: 200,
            body: { id: 'ch_123', status: 'succeeded', amount: 100 },
          },
        },
        {
          method: 'GET',
          path: '/v1/charges/ch_123',
          response: {
            status: 200,
            body: { id: 'ch_123', status: 'succeeded', amount: 100 },
          },
        },
      ],
      readinessCheck: {
        path: '/healthz',
        expectedStatus: 200,
        timeoutMs: 1000,
      },
      lifecycleDeadlineMs: 10_000,
    }

    it('binds atomically to loopback ephemeral port and serves configured routes', async () => {
      const server = await startDigitalTwinServer(paymentTwinFixture)
      try {
        expect(server.port).toBeGreaterThan(0)
        expect(server.baseUrl).toContain('127.0.0.1')

        // Check readiness endpoint
        const readyRes = await fetch(`${server.baseUrl}/healthz`)
        expect(readyRes.status).toBe(200)
        const readyData = await readyRes.json()
        expect(readyData).toMatchObject({ status: 'healthy', service: 'payment-gateway' })

        // Check POST /v1/charges with correct headers and body
        const chargeRes = await fetch(`${server.baseUrl}/v1/charges`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-idempotency-key': 'idem-1',
          },
          body: JSON.stringify({ amount: 100 }),
        })
        expect(chargeRes.status).toBe(200)
        const chargeData = await chargeRes.json()
        expect(chargeData).toMatchObject({ id: 'ch_123', status: 'succeeded' })

        // Check GET /v1/charges/ch_123
        const getRes = await fetch(`${server.baseUrl}/v1/charges/ch_123`)
        expect(getRes.status).toBe(200)
        const getData = await getRes.json()
        expect(getData.id).toBe('ch_123')

        // Check unmatched route -> 404
        const badRes = await fetch(`${server.baseUrl}/v1/unknown`)
        expect(badRes.status).toBe(404)
        const badData = await badRes.json()
        expect(badData.error).toBe('UNMATCHED_TWIN_INTERACTION')

        // Check interaction log recorded interactions
        expect(server.interactionLog.length).toBeGreaterThanOrEqual(3)
      } finally {
        await server.stop()
      }
    })

    it('records explicit NOT_APPLICABLE when a spec declares zero external dependencies', async () => {
      const res = await executeTwinsStage({
        projectId: 'project-1',
        attemptId: 'att-twin-na',
        generation: 1,
        spec: {
          id: 'spec-internal-only',
          specDigest: digestJson({ id: 'spec-internal-only' }),
          hasExternalDependencies: false,
        },
      })

      expect(res.decision).toBe('NOT_APPLICABLE')
      expect(res.stageResult.stage).toBe('twins')
      expect(res.stageResult.result).toBe('NOT_APPLICABLE')
      expect(res.stageResult.exitCondition).toBe('NO_EXTERNAL_DEPENDENCY')
    })

    it('fails closed with MISSING_OR_STALE_CONTRACT if spec requires dependencies but twin fixtures are missing', async () => {
      const res = await executeTwinsStage({
        projectId: 'project-1',
        attemptId: 'att-twin-missing',
        generation: 1,
        spec: {
          id: 'spec-ext',
          specDigest: digestJson({ id: 'spec-ext' }),
          hasExternalDependencies: true,
          requiredTwins: [],
        },
      })

      expect(res.decision).toBe('FAILED')
      expect(res.stageResult.exitCondition).toBe('MISSING_OR_STALE_CONTRACT')
    })

    it('executes test harness against running twin and records PASSED on success', async () => {
      const res = await executeTwinsStage({
        projectId: 'project-1',
        attemptId: 'att-twin-pass',
        generation: 1,
        spec: {
          id: 'spec-ext-ok',
          specDigest: digestJson({ id: 'spec-ext-ok' }),
          hasExternalDependencies: true,
          requiredTwins: [paymentTwinFixture],
        },
        harness: async (twinUrls) => {
          const url = twinUrls['payment-gateway']
          const response = await fetch(`${url}/v1/charges/ch_123`)
          if (response.status === 200) {
            return { exitCode: 0, stdout: 'tests passed', stderr: '' }
          }
          return { exitCode: 1, stdout: '', stderr: 'request failed' }
        },
      })

      expect(res.decision).toBe('PASSED')
      expect(res.stageResult.result).toBe('PASSED')
      expect(res.stageResult.exitCondition).toBe('passed')
      expect(res.stageResult.artifacts.length).toBeGreaterThan(0)
    })

    it('fails stage if readiness check fails or times out', async () => {
      const badReadinessFixture: TwinContractFixture = {
        ...paymentTwinFixture,
        readinessCheck: {
          path: '/never-ready',
          expectedStatus: 200,
          responseStatus: 503,
          timeoutMs: 150,
        },
      }

      const res = await executeTwinsStage({
        projectId: 'project-1',
        attemptId: 'att-twin-timeout',
        generation: 1,
        spec: {
          id: 'spec-timeout',
          specDigest: digestJson({ id: 'spec-timeout' }),
          hasExternalDependencies: true,
          requiredTwins: [badReadinessFixture],
        },
      })

      expect(res.decision).toBe('FAILED')
      expect(res.stageResult.exitCondition).toBe('READINESS_CHECK_TIMEOUT')
    })
  })

  describe('Part 2: Dual Independent Critics and Context Isolation', () => {
    const spec = {
      id: 'spec-core-auth',
      specDigest: digestJson({ spec: 'spec-core-auth' }),
      criteria: ['crit-1', 'crit-2', 'crit-3'],
      allowedPaths: ['packages/agent-team/src/**'],
    }

    const validCritic1: CriticConfig = {
      provider: 'anthropic',
      modelVersion: 'claude-3-7-sonnet',
      assignmentId: 'critic-assignment-1',
      evaluate: async (ctx) => ({
        verdict: 'ACCEPT',
        confidence: 0.95,
        coveredCriteria: ['crit-1', 'crit-2', 'crit-3'],
        defects: [],
      }),
    }

    const validCritic2: CriticConfig = {
      provider: 'google',
      modelVersion: 'gemini-2.5-pro',
      assignmentId: 'critic-assignment-2',
      evaluate: async (ctx) => ({
        verdict: 'ACCEPT',
        confidence: 0.92,
        coveredCriteria: ['crit-1', 'crit-2', 'crit-3'],
        defects: [],
      }),
    }

    it('accepts candidate when both diverse critics accept with confidence >= 0.8 and all criteria covered', async () => {
      const res = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-critics-pass',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'diff --git a/file.ts b/file.ts\n...',
        evidenceArtifacts: [],
        executionMode: 'deploying',
        critic1: validCritic1,
        critic2: validCritic2,
      })

      expect(res.decision).toBe('ACCEPT')
      expect(res.stageResult.result).toBe('PASSED')
      expect(res.stageResult.exitCondition).toBe('passed')
      expect(res.critics).toHaveLength(2)
      expect(res.critics[0].verdict).toBe('ACCEPT')
      expect(res.critics[1].verdict).toBe('ACCEPT')
    })

    it('enforces context isolation: neither critic sees the other’s prompt or reasoning', async () => {
      let seenContext1: unknown
      let seenContext2: unknown

      const c1: CriticConfig = {
        provider: 'anthropic',
        modelVersion: 'claude-3-7-sonnet',
        evaluate: async (ctx) => {
          seenContext1 = ctx
          return { verdict: 'ACCEPT', confidence: 0.9, coveredCriteria: spec.criteria, defects: [] }
        },
      }
      const c2: CriticConfig = {
        provider: 'google',
        modelVersion: 'gemini-2.5-pro',
        evaluate: async (ctx) => {
          seenContext2 = ctx
          return { verdict: 'ACCEPT', confidence: 0.9, coveredCriteria: spec.criteria, defects: [] }
        },
      }

      await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-isolation',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'sample-diff',
        evidenceArtifacts: [],
        executionMode: 'deploying',
        critic1: c1,
        critic2: c2,
      })

      // Neither context has any reference to the other critic's outcome or assignment
      expect(seenContext1).not.toHaveProperty('critic2')
      expect(seenContext2).not.toHaveProperty('critic1')
      expect(seenContext1).not.toHaveProperty('verdict')
      expect(seenContext2).not.toHaveProperty('verdict')
    })

    it('rejects candidate in deploying mode when both critics use the same model (diversity violation)', async () => {
      const sameModelCritic2: CriticConfig = {
        provider: 'anthropic',
        modelVersion: 'claude-3-7-sonnet',
        evaluate: async () => ({
          verdict: 'ACCEPT',
          confidence: 0.95,
          coveredCriteria: spec.criteria,
          defects: [],
        }),
      }

      const res = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-diversity-fail',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'sample-diff',
        evidenceArtifacts: [],
        executionMode: 'deploying',
        critic1: validCritic1,
        critic2: sameModelCritic2,
      })

      expect(res.decision).toBe('REJECT')
      expect(res.stageResult.exitCondition).toBe('DIVERSITY_VIOLATION')
      expect(res.stageResult.result).toBe('FAILED')
    })

    it('allows same model in non-deploying-qualification mode only with valid diversityDeficit', async () => {
      const sameModelCritic2: CriticConfig = {
        provider: 'anthropic',
        modelVersion: 'claude-3-7-sonnet',
        evaluate: async () => ({
          verdict: 'ACCEPT',
          confidence: 0.95,
          coveredCriteria: spec.criteria,
          defects: [],
        }),
      }

      // 1. Without diversityDeficit -> fails
      const failRes = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-deficit-missing',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'sample-diff',
        evidenceArtifacts: [],
        executionMode: 'non-deploying-qualification',
        critic1: validCritic1,
        critic2: sameModelCritic2,
      })
      expect(failRes.decision).toBe('REJECT')
      expect(failRes.stageResult.exitCondition).toBe('MISSING_DIVERSITY_DEFICIT')

      // 2. With valid diversityDeficit -> passes
      const deficit: DiversityDeficitRecord = {
        reasonCode: 'NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL',
        catalogRevision: 1,
        catalogDigest: digestJson({ catalog: 'v1' }),
        eligibilityEvidence: [
          {
            id: 'evidence-model-outage',
            projectId: 'project-1',
            mediaType: 'application/json',
            sizeBytes: 128,
            digest: digestJson({ outage: 'gemini-down' }),
          },
        ],
      }

      const passRes = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-deficit-ok',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'sample-diff',
        evidenceArtifacts: [],
        executionMode: 'non-deploying-qualification',
        critic1: validCritic1,
        critic2: sameModelCritic2,
        diversityDeficit: deficit,
      })
      expect(passRes.decision).toBe('ACCEPT')
      expect(passRes.stageResult.result).toBe('PASSED')
      expect(passRes.diversityDeficit).toBeDefined()
    })

    it('rejects candidate if confidence is below 0.8 policy threshold', async () => {
      const lowConfidenceCritic: CriticConfig = {
        ...validCritic2,
        evaluate: async () => ({
          verdict: 'ACCEPT',
          confidence: 0.79, // Below 0.8
          coveredCriteria: spec.criteria,
          defects: [],
        }),
      }

      const res = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-low-conf',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'diff',
        evidenceArtifacts: [],
        executionMode: 'deploying',
        critic1: validCritic1,
        critic2: lowConfidenceCritic,
      })

      expect(res.decision).toBe('REJECT')
      expect(res.stageResult.exitCondition).toBe('LOW_CONFIDENCE')
    })

    it('rejects candidate if not all acceptance criteria are covered', async () => {
      const partialCoverageCritic: CriticConfig = {
        ...validCritic2,
        evaluate: async () => ({
          verdict: 'ACCEPT',
          confidence: 0.95,
          coveredCriteria: ['crit-1', 'crit-2'], // Missing 'crit-3'
          defects: [],
        }),
      }

      const res = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-uncovered',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'diff',
        evidenceArtifacts: [],
        executionMode: 'deploying',
        critic1: validCritic1,
        critic2: partialCoverageCritic,
      })

      expect(res.decision).toBe('REJECT')
      expect(res.stageResult.exitCondition).toBe('UNCOVERED_CRITERIA')
    })

    it('blocks candidate on HIGH or CRITICAL defect even without executable exploit', async () => {
      const securityCritic: CriticConfig = {
        ...validCritic2,
        evaluate: async () => ({
          verdict: 'REJECT',
          confidence: 0.95,
          coveredCriteria: spec.criteria,
          defects: [
            {
              severity: 'CRITICAL',
              description: 'Potential AST path traversal in module resolution',
              evidence: {
                id: 'ev-1',
                projectId: 'project-1',
                mediaType: 'application/json',
                sizeBytes: 128,
                digest: digestJson({ issue: 'traversal' }),
              },
              reproductionSteps: ['Invoke inspectArchitectureAndPaths with relative dotdot'],
            },
          ],
        }),
      }

      const res = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-defect',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'diff',
        evidenceArtifacts: [],
        executionMode: 'deploying',
        critic1: validCritic1,
        critic2: securityCritic,
      })

      expect(res.decision).toBe('REJECT')
      expect(res.stageResult.exitCondition).toBe('HIGH_OR_CRITICAL_DEFECT')
      expect(res.stageResult.result).toBe('FAILED')
    })

    it('fails closed on malformed critic output yielding INSUFFICIENT_EVIDENCE', async () => {
      const malformedCritic: CriticConfig = {
        ...validCritic2,
        evaluate: async () => 'not a valid json object or schema',
      }

      const res = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-malformed',
        generation: 1,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'diff',
        evidenceArtifacts: [],
        executionMode: 'deploying',
        critic1: validCritic1,
        critic2: malformedCritic,
      })

      expect(res.decision).toBe('INCONCLUSIVE')
      expect(res.stageResult.exitCondition).toBe('INSUFFICIENT_EVIDENCE')
      expect(res.stageResult.result).toBe('INCONCLUSIVE')
    })

    it('enforces maximum 2 repair cycles limit', async () => {
      const res = await executeDualCriticsStage({
        projectId: 'project-1',
        taskId: 'task-1',
        attemptId: 'att-repair-budget',
        generation: 4,
        candidateCommit: '0123456789abcdef0123456789abcdef01234567',
        spec,
        diff: 'diff',
        evidenceArtifacts: [],
        executionMode: 'deploying',
        critic1: validCritic1,
        critic2: validCritic2,
        repairCycleCount: 3, // Exceeds limit of 2
      })

      expect(res.decision).toBe('REJECT')
      expect(res.stageResult.exitCondition).toBe('EXCEEDED_MAX_REPAIR_CYCLES')
    })
  })
})
