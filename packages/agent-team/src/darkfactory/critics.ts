/**
 * Dual Independent Critics (DF-09)
 *
 * Independent context isolation, model diversity enforcement, rubric evaluation,
 * strict acceptance threshold (both ACCEPT, confidence >= 0.8, full criteria coverage,
 * zero HIGH/CRITICAL defects), bounded repair budget, and fail-closed validation.
 */

import { digestJson } from './json.ts'
import {
  criticOutcomeSchema,
  stageResultSchema,
  type CriticOutcomeV1,
  type StageResultV1,
} from './contracts/verification.ts'
import type { ArtifactRef } from './contracts/common.ts'

export interface CriticInputContext {
  attemptId: string
  spec: {
    id: string
    specDigest: `sha256:${string}`
    criteria: string[]
    allowedPaths?: string[]
  }
  diff: string
  evidenceArtifacts: ArtifactRef[]
  rubric: string
}

export type CriticEvaluator = (
  context: CriticInputContext,
  signal?: AbortSignal,
) => Promise<unknown>

export interface CriticConfig {
  provider: string
  modelVersion: string
  assignmentId?: string
  evaluate: CriticEvaluator
}

export interface DiversityDeficitRecord {
  reasonCode: 'NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL'
  catalogRevision: number
  catalogDigest: `sha256:${string}`
  eligibilityEvidence: ArtifactRef[]
}

export interface DualCriticsExecutionOptions {
  projectId: string
  policyRevision?: number
  taskId: string
  attemptId: string
  generation: number
  candidateCommit: string
  spec: {
    id: string
    specDigest: `sha256:${string}`
    criteria: string[]
    allowedPaths?: string[]
  }
  diff: string
  evidenceArtifacts: ArtifactRef[]
  executionMode: 'deploying' | 'non-deploying-qualification'
  critic1: CriticConfig
  critic2: CriticConfig
  diversityDeficit?: DiversityDeficitRecord
  repairCycleCount?: number
  rubric?: string
  signal?: AbortSignal
}

export interface DualCriticsExecutionResult {
  stageResult: StageResultV1
  critics: [CriticOutcomeV1, CriticOutcomeV1]
  decision: 'ACCEPT' | 'REJECT' | 'INCONCLUSIVE'
  diversityDeficit?: DiversityDeficitRecord | undefined
  reason?: string | undefined
}

const DEFAULT_RUBRIC = `
You are an independent, adversarial code review critic for Dark Factory Gate 2.
Evaluate candidate changes strictly against the provided immutable spec, acceptance criteria, diff, and verification evidence.
Rules:
1. Verify each acceptance criterion explicitly. Do not claim coverage for unaddressed criteria.
2. Report defects with severity (LOW, MEDIUM, HIGH, CRITICAL), file path, line number, and reproduction steps.
3. Any security objection, architectural bypass, data loss vulnerability, or invariant violation MUST be classified as HIGH or CRITICAL. A sound security objection need not execute an exploit to block.
4. If candidate evidence is unavailable or malformed, return INSUFFICIENT_EVIDENCE. Never coerce incomplete evidence into acceptance.
5. Self-report calibrated confidence in [0, 1]. Confidence below 0.8 will block acceptance.
`

/**
 * Execute the Dark Factory Dual Independent Critics Verification Stage (DF-09).
 */
export async function executeDualCriticsStage(
  options: DualCriticsExecutionOptions,
): Promise<DualCriticsExecutionResult> {
  const startedAt = new Date().toISOString()
  const {
    projectId,
    policyRevision = 1,
    attemptId,
    candidateCommit,
    spec,
    diff,
    evidenceArtifacts,
    executionMode,
    critic1,
    critic2,
    diversityDeficit,
    repairCycleCount = 0,
    rubric = DEFAULT_RUBRIC,
    signal,
  } = options

  const stageId = `critics-${attemptId}`

  // 1. Repair budget check: maximum 2 repair cycles per spec
  if (repairCycleCount > 2) {
    const endedAt = new Date().toISOString()
    const syntheticOutcome = createSyntheticOutcome(
      options,
      critic1,
      'REJECT',
      0,
      'Exceeded maximum repair cycles (limit 2)',
    )
    return {
      stageResult: {
        id: stageId,
        stage: 'critics',
        result: 'FAILED',
        definitionRevision: policyRevision,
        startedAt,
        endedAt,
        exitCondition: 'EXCEEDED_MAX_REPAIR_CYCLES',
        artifacts: [],
      },
      critics: [syntheticOutcome, syntheticOutcome],
      decision: 'REJECT',
      reason: `Repair budget exceeded: candidate reached ${repairCycleCount} repair cycles (maximum allowed is 2)`,
    }
  }

  // 2. Model diversity enforcement
  const sameModel =
    critic1.provider === critic2.provider && critic1.modelVersion === critic2.modelVersion

  if (sameModel) {
    if (executionMode === 'deploying') {
      const endedAt = new Date().toISOString()
      const syntheticOutcome = createSyntheticOutcome(
        options,
        critic1,
        'REJECT',
        0,
        'Production deploying mode requires model/provider diversity',
      )
      return {
        stageResult: {
          id: stageId,
          stage: 'critics',
          result: 'FAILED',
          definitionRevision: policyRevision,
          startedAt,
          endedAt,
          exitCondition: 'DIVERSITY_VIOLATION',
          artifacts: [],
        },
        critics: [syntheticOutcome, syntheticOutcome],
        decision: 'REJECT',
        reason:
          'Deploying mode requires distinct model/provider diversity between critics; same-model dual evaluation is forbidden in production',
      }
    } else {
      // non-deploying-qualification: permitted ONLY with valid diversityDeficit record
      if (!diversityDeficit || diversityDeficit.reasonCode !== 'NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL') {
        const endedAt = new Date().toISOString()
        const syntheticOutcome = createSyntheticOutcome(
          options,
          critic1,
          'REJECT',
          0,
          'Non-deploying mode with same model requires valid diversityDeficit',
        )
        return {
          stageResult: {
            id: stageId,
            stage: 'critics',
            result: 'FAILED',
            definitionRevision: policyRevision,
            startedAt,
            endedAt,
            exitCondition: 'MISSING_DIVERSITY_DEFICIT',
            artifacts: [],
          },
          critics: [syntheticOutcome, syntheticOutcome],
          decision: 'REJECT',
          reason:
            'Qualification mode with identical models requires recorded diversityDeficit with reason NO_ELIGIBLE_HEALTHY_DIVERSE_MODEL',
        }
      }
    }
  }

  // 3. Independent Context Isolation: neither context receives the other's prompt or reasoning
  const context1: CriticInputContext = {
    attemptId: `${attemptId}-critic-1`,
    spec: { ...spec },
    diff,
    evidenceArtifacts: [...evidenceArtifacts],
    rubric,
  }

  const context2: CriticInputContext = {
    attemptId: `${attemptId}-critic-2`,
    spec: { ...spec },
    diff,
    evidenceArtifacts: [...evidenceArtifacts],
    rubric,
  }

  // 4. Run evaluations independently
  let raw1: unknown
  let raw2: unknown

  try {
    const [res1, res2] = await Promise.all([
      critic1.evaluate(context1, signal),
      critic2.evaluate(context2, signal),
    ])
    raw1 = res1
    raw2 = res2
  } catch (err) {
    const endedAt = new Date().toISOString()
    const syntheticOutcome = createSyntheticOutcome(
      options,
      critic1,
      'INSUFFICIENT_EVIDENCE',
      0,
      `Critic evaluation crashed: ${String(err)}`,
    )
    return {
      stageResult: {
        id: stageId,
        stage: 'critics',
        result: 'INCONCLUSIVE',
        definitionRevision: policyRevision,
        startedAt,
        endedAt,
        exitCondition: 'CRITIC_EXECUTION_ERROR',
        artifacts: [],
      },
      critics: [syntheticOutcome, syntheticOutcome],
      decision: 'INCONCLUSIVE',
      reason: `Critic execution threw an unhandled exception: ${String(err)}`,
    }
  }

  // 5. Schema validation for each critic outcome (fail closed on malformed output)
  const parseOutcome = (raw: unknown, critic: CriticConfig, idNum: number): CriticOutcomeV1 => {
    // If raw is already compliant with record fields, validate with zod
    const normalized = (typeof raw === 'object' && raw !== null)
      ? {
          schemaVersion: 1,
          id: `critic-${idNum}-${attemptId}`,
          projectId,
          policyRevision,
          attemptId: `${attemptId}-c${idNum}`,
          modelAssignmentId: critic.assignmentId ?? `model-${critic.provider}-${idNum}`,
          provider: critic.provider,
          modelVersion: critic.modelVersion,
          contextDigest: digestJson(idNum === 1 ? context1 : context2),
          specDigest: spec.specDigest,
          candidateCommit,
          committedAt: new Date().toISOString(),
          ...(raw as Record<string, unknown>),
        }
      : null

    const parsed = criticOutcomeSchema.safeParse(normalized)
    if (!parsed.success) {
      // Malformed output must yield INSUFFICIENT_EVIDENCE, never coerced to acceptance
      return {
        schemaVersion: 1,
        id: `critic-${idNum}-${attemptId}`,
        projectId,
        policyRevision,
        attemptId: `${attemptId}-c${idNum}`,
        modelAssignmentId: critic.assignmentId ?? `model-${critic.provider}-${idNum}`,
        provider: critic.provider,
        modelVersion: critic.modelVersion,
        contextDigest: digestJson(idNum === 1 ? context1 : context2),
        specDigest: spec.specDigest,
        candidateCommit,
        verdict: 'INSUFFICIENT_EVIDENCE',
        confidence: 0,
        coveredCriteria: [],
        defects: [
          {
            severity: 'HIGH',
            description: `Malformed critic output failed schema validation: ${parsed.error.message}`,
            evidence: {
              projectId,
              id: `malformed-critic-${idNum}`,
              mediaType: 'application/json',
              sizeBytes: 128,
              digest: digestJson({ raw }),
            },
            reproductionSteps: ['Verify critic output against criticOutcomeSchema'],
          },
        ],
        committedAt: new Date().toISOString(),
      }
    }
    return parsed.data
  }

  const outcome1 = parseOutcome(raw1, critic1, 1)
  const outcome2 = parseOutcome(raw2, critic2, 2)

  // 6. Enforce Acceptance Criteria Invariants:
  // - Both must be ACCEPT
  // - Both confidence >= 0.8
  // - Every spec criterion covered by both critics
  // - Zero HIGH or CRITICAL defects
  const requiredCriteria = new Set(spec.criteria)
  const c1Covered = new Set(outcome1.coveredCriteria)
  const c2Covered = new Set(outcome2.coveredCriteria)

  const c1CoversAll = [...requiredCriteria].every((c) => c1Covered.has(c))
  const c2CoversAll = [...requiredCriteria].every((c) => c2Covered.has(c))

  const hasHighOrCritical1 = outcome1.defects.some(
    (d) => d.severity === 'HIGH' || d.severity === 'CRITICAL',
  )
  const hasHighOrCritical2 = outcome2.defects.some(
    (d) => d.severity === 'HIGH' || d.severity === 'CRITICAL',
  )

  let decision: 'ACCEPT' | 'REJECT' | 'INCONCLUSIVE'
  let result: 'PASSED' | 'FAILED' | 'INCONCLUSIVE'
  let exitCondition: string
  let reason: string | undefined

  if (outcome1.verdict === 'INSUFFICIENT_EVIDENCE' || outcome2.verdict === 'INSUFFICIENT_EVIDENCE') {
    decision = 'INCONCLUSIVE'
    result = 'INCONCLUSIVE'
    exitCondition = 'INSUFFICIENT_EVIDENCE'
    reason = 'One or more critics returned INSUFFICIENT_EVIDENCE or malformed output'
  } else if (hasHighOrCritical1 || hasHighOrCritical2) {
    decision = 'REJECT'
    result = 'FAILED'
    exitCondition = 'HIGH_OR_CRITICAL_DEFECT'
    reason = 'Candidate contains HIGH or CRITICAL defects identified by critics'
  } else if (outcome1.verdict !== 'ACCEPT' || outcome2.verdict !== 'ACCEPT') {
    decision = 'REJECT'
    result = 'FAILED'
    exitCondition = 'CRITIC_REJECT'
    reason = `Critic verdicts divergent or rejecting (Critic 1: ${outcome1.verdict}, Critic 2: ${outcome2.verdict})`
  } else if (outcome1.confidence < 0.8 || outcome2.confidence < 0.8) {
    decision = 'REJECT'
    result = 'FAILED'
    exitCondition = 'LOW_CONFIDENCE'
    reason = `Critic confidence below 0.8 policy threshold (Critic 1: ${outcome1.confidence}, Critic 2: ${outcome2.confidence})`
  } else if (!c1CoversAll || !c2CoversAll) {
    decision = 'REJECT'
    result = 'FAILED'
    exitCondition = 'UNCOVERED_CRITERIA'
    reason = 'Not all acceptance criteria were covered across both critics'
  } else {
    decision = 'ACCEPT'
    result = 'PASSED'
    exitCondition = 'passed'
    reason = undefined
  }

  const endedAt = new Date().toISOString()
  const artifacts: ArtifactRef[] = [
    {
      id: `critic-outcome-1`,
      projectId,
      mediaType: 'application/json',
      sizeBytes: 256,
      digest: digestJson(outcome1),
    },
    {
      id: `critic-outcome-2`,
      projectId,
      mediaType: 'application/json',
      sizeBytes: 256,
      digest: digestJson(outcome2),
    },
  ]

  const stageResult = stageResultSchema.parse({
    id: stageId,
    stage: 'critics',
    result,
    definitionRevision: policyRevision,
    startedAt,
    endedAt,
    exitCondition,
    artifacts,
  })

  return {
    stageResult,
    critics: [outcome1, outcome2],
    decision,
    diversityDeficit: sameModel ? diversityDeficit : undefined,
    reason,
  }
}

function createSyntheticOutcome(
  options: DualCriticsExecutionOptions,
  critic: CriticConfig,
  verdict: 'REJECT' | 'INSUFFICIENT_EVIDENCE',
  confidence: number,
  message: string,
): CriticOutcomeV1 {
  const { projectId, policyRevision = 1, attemptId, candidateCommit, spec } = options
  return {
    schemaVersion: 1,
    id: `critic-synthetic-${attemptId}`,
    projectId,
    policyRevision,
    attemptId,
    modelAssignmentId: critic.assignmentId ?? `model-${critic.provider}`,
    provider: critic.provider,
    modelVersion: critic.modelVersion,
    contextDigest: digestJson({ attemptId, candidateCommit, specDigest: spec.specDigest }),
    specDigest: spec.specDigest,
    candidateCommit,
    verdict,
    confidence,
    coveredCriteria: [],
    defects: [
      {
        severity: 'HIGH',
        description: message,
        evidence: {
          projectId,
          id: `defect-${attemptId}`,
          mediaType: 'application/json',
          sizeBytes: 64,
          digest: digestJson({ message }),
        },
        reproductionSteps: [message],
      },
    ],
    committedAt: new Date().toISOString(),
  }
}
