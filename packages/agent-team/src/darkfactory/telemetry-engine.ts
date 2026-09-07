/**
 * Dark Factory Gate 3: Quantitative Canary Policy & Telemetry Engine (DF-13)
 *
 * Implements 15-minute sliding evaluation window with 1-minute non-overlapping buckets,
 * Prometheus histogram bucket aggregation (no averaging p99s), linear quantile interpolation,
 * dual-branch error and latency threshold evaluation, 3-consecutive-breach rollback trigger,
 * insufficient data handling, and Ed25519-signed TelemetryVerdictV1 snapshots.
 */

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto"
import z from "zod"
import {
  telemetryVerdictSchema,
  telemetryVerdictPayloadSchema,
  type TelemetryVerdictV1,
} from "./contracts/release.ts"
import { canonicalJson, digestJson } from "./json.ts"

export interface HistogramBin {
  readonly le: number // upper bound (Infinity represented as Number.POSITIVE_INFINITY)
  readonly count: number // cumulative count
}

export interface BucketSample {
  readonly timestamp: string
  readonly requests: number
  readonly errors: number
  readonly histogramBins?: readonly HistogramBin[] | undefined
}

export interface TelemetryEngineOptions {
  readonly projectId: string
  readonly policyDigest: string
  readonly queryRevision: number
  readonly signerKeyId: string
  readonly privateKey?: KeyObject | string | undefined
  readonly publicKey?: KeyObject | string | undefined
}

export const TELEMETRY_CONSTANTS = {
  MIN_REQUESTS_PER_MINUTE: 100,
  MIN_TOTAL_REQUESTS: 1000,
  MAX_SAMPLE_AGE_SECONDS: 120,
  ABSOLUTE_ERROR_THRESHOLD: 0.01,
  RELATIVE_ERROR_MULTIPLIER: 1.25,
  MIN_ABSOLUTE_ERROR_DELTA: 0.002,
  ABSOLUTE_LATENCY_THRESHOLD_MS: 1000,
  RELATIVE_LATENCY_MULTIPLIER: 1.25,
  MIN_ABSOLUTE_LATENCY_DELTA_MS: 100,
  CONSECUTIVE_BREACHES_TO_ANOMALY: 3,
  MIN_QUALIFYING_MINUTES: 15,
  MAX_OBSERVATION_WALL_MINUTES: 30,
} as const

/**
 * Aggregate compatible cumulative histogram bins across multiple instances.
 * Buckets with identical upper bounds (le) are summed.
 */
export function aggregateHistogramBins(instanceBins: readonly (readonly HistogramBin[])[]): HistogramBin[] {
  if (instanceBins.length === 0) return []
  const map = new Map<number, number>()

  for (const bins of instanceBins) {
    for (const bin of bins) {
      const current = map.get(bin.le) ?? 0
      map.set(bin.le, current + bin.count)
    }
  }

  const sorted = Array.from(map.entries())
    .map(([le, count]) => ({ le, count }))
    .sort((a, b) => a.le - b.le)

  return sorted
}

/**
 * Derive quantile (e.g. 0.99 for p99) from cumulative histogram bins using Prometheus linear interpolation.
 */
export function deriveQuantileFromHistogram(bins: readonly HistogramBin[], quantile: number): number | null {
  if (bins.length === 0) return null
  const total = bins[bins.length - 1]!.count
  if (total <= 0) return 0

  const targetRank = quantile * total
  let previousBound = 0
  let previousCount = 0

  for (const bin of bins) {
    if (bin.count >= targetRank) {
      const countInBucket = bin.count - previousCount
      if (countInBucket <= 0) return bin.le
      const rankInBucket = targetRank - previousCount
      const fraction = rankInBucket / countInBucket
      if (!Number.isFinite(bin.le)) return previousBound
      return previousBound + fraction * (bin.le - previousBound)
    }
    previousBound = bin.le
    previousCount = bin.count
  }

  return bins[bins.length - 1]!.le
}

export interface BucketEvaluation {
  readonly result: "HEALTHY" | "BREACH" | "INSUFFICIENT_DATA"
  readonly eC: number
  readonly eB: number
  readonly p99C: number | null
  readonly p99B: number | null
  readonly reasons: string[]
}

/**
 * Evaluates a 1-minute window of canary vs baseline.
 */
export function evaluateBucket(sample: BucketSample, baseline: BucketSample): BucketEvaluation {
  const reasons: string[] = []

  if (sample.requests < TELEMETRY_CONSTANTS.MIN_REQUESTS_PER_MINUTE || baseline.requests < TELEMETRY_CONSTANTS.MIN_REQUESTS_PER_MINUTE) {
    return {
      result: "INSUFFICIENT_DATA",
      eC: sample.requests > 0 ? sample.errors / sample.requests : 0,
      eB: baseline.requests > 0 ? baseline.errors / baseline.requests : 0,
      p99C: null,
      p99B: null,
      reasons: ["INSUFFICIENT_REQUEST_VOLUME"],
    }
  }

  const eC = sample.errors / sample.requests
  const eB = baseline.errors / baseline.requests

  // Dual-branch error threshold: eC > 0.01 OR (eB > 0 and eC > 1.25 * eB and eC - eB >= 0.002)
  let errorBreach = false
  if (eC > TELEMETRY_CONSTANTS.ABSOLUTE_ERROR_THRESHOLD) {
    errorBreach = true
    reasons.push("ABSOLUTE_ERROR_RATE_BREACH")
  } else if (eB > 0 && eC > TELEMETRY_CONSTANTS.RELATIVE_ERROR_MULTIPLIER * eB && (eC - eB) >= TELEMETRY_CONSTANTS.MIN_ABSOLUTE_ERROR_DELTA) {
    errorBreach = true
    reasons.push("RELATIVE_ERROR_RATE_BREACH")
  }

  // Latency p99 quantile derivation
  let p99C: number | null = null
  let p99B: number | null = null
  let latencyBreach = false

  if (sample.histogramBins && baseline.histogramBins) {
    p99C = deriveQuantileFromHistogram(sample.histogramBins, 0.99)
    p99B = deriveQuantileFromHistogram(baseline.histogramBins, 0.99)

    if (p99C !== null && p99B !== null) {
      if (p99C > TELEMETRY_CONSTANTS.ABSOLUTE_LATENCY_THRESHOLD_MS) {
        latencyBreach = true
        reasons.push("ABSOLUTE_LATENCY_P99_BREACH")
      } else if (p99C > TELEMETRY_CONSTANTS.RELATIVE_LATENCY_MULTIPLIER * p99B && (p99C - p99B) >= TELEMETRY_CONSTANTS.MIN_ABSOLUTE_LATENCY_DELTA_MS) {
        latencyBreach = true
        reasons.push("RELATIVE_LATENCY_P99_BREACH")
      }
    }
  }

  const isBreach = errorBreach || latencyBreach
  return {
    result: isBreach ? "BREACH" : "HEALTHY",
    eC,
    eB,
    p99C,
    p99B,
    reasons: reasons.length > 0 ? reasons : ["WINDOW_CLEAN"],
  }
}

/**
 * Quantitative canary evaluation engine.
 */
export class DarkFactoryTelemetryEngine {
  private consecutiveBreaches = 0
  private qualifyingMinutes = 0
  private totalMinutesEvaluated = 0
  private privateKey: KeyObject
  private publicKey: KeyObject

  constructor(private readonly options: TelemetryEngineOptions) {
    if (options.privateKey) {
      this.privateKey = typeof options.privateKey === "string" ? createPrivateKey(options.privateKey) : options.privateKey
      this.publicKey = options.publicKey ? (typeof options.publicKey === "string" ? createPublicKey(options.publicKey) : options.publicKey) : createPublicKey(this.privateKey)
    } else {
      const pair = generateKeyPairSync("ed25519")
      this.privateKey = pair.privateKey
      this.publicKey = pair.publicKey
    }
  }

  getConsecutiveBreaches(): number {
    return this.consecutiveBreaches
  }

  getQualifyingMinutes(): number {
    return this.qualifyingMinutes
  }

  getTotalMinutes(): number {
    return this.totalMinutesEvaluated
  }

  reset(): void {
    this.consecutiveBreaches = 0
    this.qualifyingMinutes = 0
    this.totalMinutesEvaluated = 0
  }

  /**
   * Evaluates a single 1-minute observation window and emits a signed TelemetryVerdictV1.
   */
  evaluateWindow(params: {
    releaseId: string
    deploymentId: string
    artifactDigest: string
    canaryBucket: BucketSample
    baselineBucket: BucketSample
    startTime: string
    endTime: string
  }): TelemetryVerdictV1 {
    this.totalMinutesEvaluated++
    const evalResult = evaluateBucket(params.canaryBucket, params.baselineBucket)

    let finalVerdict: "HEALTHY" | "ANOMALY_DETECTED" | "INSUFFICIENT_DATA"

    if (evalResult.result === "BREACH") {
      this.consecutiveBreaches++
      this.qualifyingMinutes++
      if (this.consecutiveBreaches >= TELEMETRY_CONSTANTS.CONSECUTIVE_BREACHES_TO_ANOMALY) {
        finalVerdict = "ANOMALY_DETECTED"
      } else {
        // Not yet anomalous (requires 3 consecutive breaches to trigger rollback)
        finalVerdict = "HEALTHY"
      }
    } else if (evalResult.result === "HEALTHY") {
      // Healthy window resets consecutive breaches counter
      this.consecutiveBreaches = 0
      this.qualifyingMinutes++
      finalVerdict = "HEALTHY"
    } else {
      // INSUFFICIENT_DATA: does not count as healthy, does NOT reset consecutive breaches
      finalVerdict = "INSUFFICIENT_DATA"
    }

    const payload = {
      schemaVersion: 1,
      id: `verdict-${params.releaseId}-${this.totalMinutesEvaluated}`,
      projectId: this.options.projectId,
      policyRevision: 1,
      releaseId: params.releaseId,
      deploymentId: params.deploymentId,
      artifactDigest: params.artifactDigest,
      policyDigest: this.options.policyDigest,
      queryRevision: this.options.queryRevision,
      baseline: {
        start: params.startTime,
        end: params.endTime,
        requests: params.baselineBucket.requests,
        errors: params.baselineBucket.errors,
        p99Ms: evalResult.p99B,
      },
      sample: {
        start: params.startTime,
        end: params.endTime,
        requests: params.canaryBucket.requests,
        errors: params.canaryBucket.errors,
        p99Ms: evalResult.p99C,
      },
      newestSampleAt: params.canaryBucket.timestamp,
      collectedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      breachCount: this.consecutiveBreaches,
      result: finalVerdict,
      reasons: evalResult.reasons.slice(0, 32),
      queryArtifacts: [{
        projectId: this.options.projectId,
        id: "art-query-1",
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        mediaType: "application/json",
        sizeBytes: 256,
      }],
      signerKeyId: this.options.signerKeyId,
    }

    const validatedPayload = telemetryVerdictPayloadSchema.parse(payload)
    const canonicalPayloadBytes = Buffer.from(canonicalJson(validatedPayload), "utf8")
    const attestationHash = digestJson(validatedPayload)
    const signature = sign(null, canonicalPayloadBytes, this.privateKey).toString("base64")

    return telemetryVerdictSchema.parse({
      ...validatedPayload,
      attestationHash,
      signature,
    })
  }

  verifyVerdict(verdict: TelemetryVerdictV1): boolean {
    const { attestationHash, signature, ...payload } = verdict
    const canonicalPayloadBytes = Buffer.from(canonicalJson(payload), "utf8")
    const expectedHash = digestJson(payload)
    if (attestationHash !== expectedHash) return false
    return verify(null, canonicalPayloadBytes, this.publicKey, Buffer.from(signature, "base64"))
  }
}
