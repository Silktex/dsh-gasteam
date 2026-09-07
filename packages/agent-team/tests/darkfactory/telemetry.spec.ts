import { describe, it, expect, beforeEach } from "vitest"
import {
  DarkFactoryTelemetryEngine,
  aggregateHistogramBins,
  deriveQuantileFromHistogram,
  evaluateBucket,
  type BucketSample,
  type HistogramBin,
} from "../../src/darkfactory/telemetry-engine.ts"

describe("DF-13 Quantitative Canary Telemetry Engine", () => {
  let engine: DarkFactoryTelemetryEngine

  beforeEach(() => {
    engine = new DarkFactoryTelemetryEngine({
      projectId: "proj-telemetry-test",
      policyDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      queryRevision: 1,
      signerKeyId: "key-telemetry-1",
    })
  })

  it("aggregates compatible histogram bins and derives p99 quantile", () => {
    const pod1: HistogramBin[] = [
      { le: 50, count: 500 },
      { le: 100, count: 800 },
      { le: 500, count: 980 },
      { le: 1000, count: 990 },
      { le: Number.POSITIVE_INFINITY, count: 1000 },
    ]
    const pod2: HistogramBin[] = [
      { le: 50, count: 400 },
      { le: 100, count: 750 },
      { le: 500, count: 970 },
      { le: 1000, count: 990 },
      { le: Number.POSITIVE_INFINITY, count: 1000 },
    ]

    const aggregated = aggregateHistogramBins([pod1, pod2])
    expect(aggregated).toHaveLength(5)
    expect(aggregated[0]).toEqual({ le: 50, count: 900 })
    expect(aggregated[1]).toEqual({ le: 100, count: 1550 })
    expect(aggregated[2]).toEqual({ le: 500, count: 1950 })
    expect(aggregated[3]).toEqual({ le: 1000, count: 1980 })
    expect(aggregated[4]).toEqual({ le: Number.POSITIVE_INFINITY, count: 2000 })

    const p99 = deriveQuantileFromHistogram(aggregated, 0.99)
    expect(p99).toBe(1000)
  })

  it("evaluates dual-branch error thresholds correctly", () => {
    const baseline: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 2, // eB = 0.002
    }

    // Healthy sample: eC = 0.002 (no breach)
    const healthySample: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 2,
    }
    const evalHealthy = evaluateBucket(healthySample, baseline)
    expect(evalHealthy.result).toBe("HEALTHY")

    // Absolute breach: eC = 15/1000 = 0.015 > 0.01
    const absBreachSample: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 15,
    }
    const evalAbs = evaluateBucket(absBreachSample, baseline)
    expect(evalAbs.result).toBe("BREACH")
    expect(evalAbs.reasons).toContain("ABSOLUTE_ERROR_RATE_BREACH")

    // Relative breach: eC = 5/1000 = 0.005 > 1.25 * 0.002 (0.0025) and delta (0.003) >= 0.002
    const relBreachSample: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 5,
    }
    const evalRel = evaluateBucket(relBreachSample, baseline)
    expect(evalRel.result).toBe("BREACH")
    expect(evalRel.reasons).toContain("RELATIVE_ERROR_RATE_BREACH")

    // Baseline 0 errors: relative branch disabled, eC=0.005 does NOT breach since < 0.01
    const zeroErrorBaseline: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 0,
    }
    const evalDisabledRel = evaluateBucket(relBreachSample, zeroErrorBaseline)
    expect(evalDisabledRel.result).toBe("HEALTHY")
  })

  it("evaluates latency quantile breaches", () => {
    const baseline: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 0,
      histogramBins: [
        { le: 100, count: 900 },
        { le: 200, count: 990 },
        { le: Number.POSITIVE_INFINITY, count: 1000 },
      ],
    }

    const canaryRelBreach: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 0,
      histogramBins: [
        { le: 100, count: 800 },
        { le: 400, count: 990 },
        { le: Number.POSITIVE_INFINITY, count: 1000 },
      ],
    }

    const evalLatency = evaluateBucket(canaryRelBreach, baseline)
    expect(evalLatency.result).toBe("BREACH")
    expect(evalLatency.reasons).toContain("RELATIVE_LATENCY_P99_BREACH")
  })

  it("handles insufficient request data without false healthy certification", () => {
    const lowTraffic: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 50, // < 100 min reqs!
      errors: 0,
    }
    const baseline: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 0,
    }

    const evalResult = evaluateBucket(lowTraffic, baseline)
    expect(evalResult.result).toBe("INSUFFICIENT_DATA")
    expect(evalResult.reasons).toContain("INSUFFICIENT_REQUEST_VOLUME")
  })

  it("tracks consecutive breaches: 3 consecutive trigger ANOMALY_DETECTED, reset on healthy", () => {
    const baseline: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 0,
    }
    const breachSample: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 20, // eC = 0.02 > 0.01
    }
    const healthySample: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 0,
    }

    // Window 1: breach 1 (still reported as HEALTHY release state, breachCount=1)
    const v1 = engine.evaluateWindow({
      releaseId: "rel-1",
      deploymentId: "dep-1",
      artifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      canaryBucket: breachSample,
      baselineBucket: baseline,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    })
    expect(v1.result).toBe("HEALTHY")
    expect(v1.breachCount).toBe(1)
    expect(engine.getConsecutiveBreaches()).toBe(1)

    // Window 2: breach 2 (still reported as HEALTHY release state, breachCount=2)
    const v2 = engine.evaluateWindow({
      releaseId: "rel-1",
      deploymentId: "dep-1",
      artifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      canaryBucket: breachSample,
      baselineBucket: baseline,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    })
    expect(v2.result).toBe("HEALTHY")
    expect(v2.breachCount).toBe(2)
    expect(engine.getConsecutiveBreaches()).toBe(2)

    // Window 3: breach 3 -> ANOMALY_DETECTED triggers rollback!
    const v3 = engine.evaluateWindow({
      releaseId: "rel-1",
      deploymentId: "dep-1",
      artifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      canaryBucket: breachSample,
      baselineBucket: baseline,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    })
    expect(v3.result).toBe("ANOMALY_DETECTED")
    expect(v3.breachCount).toBe(3)

    // Verify Ed25519 signature
    expect(engine.verifyVerdict(v3)).toBe(true)

    // Next window healthy: resets consecutive breaches to 0
    const v4 = engine.evaluateWindow({
      releaseId: "rel-1",
      deploymentId: "dep-1",
      artifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      canaryBucket: healthySample,
      baselineBucket: baseline,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    })
    expect(v4.result).toBe("HEALTHY")
    expect(v4.breachCount).toBe(0)
    expect(engine.getConsecutiveBreaches()).toBe(0)
  })

  it("insufficient data windows do NOT reset breach counter", () => {
    const baseline: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 0,
    }
    const breachSample: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 1000,
      errors: 20,
    }
    const lowTraffic: BucketSample = {
      timestamp: new Date().toISOString(),
      requests: 10,
      errors: 0,
    }

    // Breach 1
    engine.evaluateWindow({
      releaseId: "rel-2",
      deploymentId: "dep-2",
      artifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      canaryBucket: breachSample,
      baselineBucket: baseline,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    })
    expect(engine.getConsecutiveBreaches()).toBe(1)

    // Insufficient data window
    const vInsufficient = engine.evaluateWindow({
      releaseId: "rel-2",
      deploymentId: "dep-2",
      artifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      canaryBucket: lowTraffic,
      baselineBucket: baseline,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    })
    expect(vInsufficient.result).toBe("INSUFFICIENT_DATA")
    // Breach count retained! Not reset to 0!
    expect(engine.getConsecutiveBreaches()).toBe(1)
  })
})
