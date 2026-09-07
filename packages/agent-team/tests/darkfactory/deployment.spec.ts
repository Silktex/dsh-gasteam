import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  DeploymentWebhookBridge,
  DeploymentAdapter,
} from "../../src/darkfactory/deployment-bridge.ts"
import type { DeploymentRequestV1 } from "../../src/darkfactory/contracts/release.ts"

describe("DF-12 Signed Deployment Bridge & Adapter", () => {
  let bridge: DeploymentWebhookBridge
  let adapter: DeploymentAdapter
  const testKeyId = "test-deploy-key"
  const testSecret = "deploy-secret-1234567890abcdef12345678"

  beforeAll(async () => {
    bridge = await DeploymentWebhookBridge.start({
      keyRegistry: { [testKeyId]: testSecret },
    })
    adapter = new DeploymentAdapter({
      bridgeUrl: bridge.getUrl(),
      keyId: testKeyId,
      secretOrPrivateKey: testSecret,
      requestTimeoutMs: 2000,
    })
  })

  afterAll(async () => {
    await bridge.stop()
  })

  it("registers baseline deployment and verifies preflight", async () => {
    bridge.registerBaseline("production", {
      deploymentId: "dep-baseline-0",
      commit: "0000000000000000000000000000000000000000",
      artifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      observedAt: new Date().toISOString(),
    })

    const preflight = await adapter.preflight({
      environment: "production",
      expectedPriorDeployment: "dep-baseline-0",
    })

    expect(preflight.status).toBe("ready")
    expect(preflight.baseline?.deploymentId).toBe("dep-baseline-0")
    expect(preflight.capabilities).toContain("deployCanary")
  })

  const baseCanaryReq: DeploymentRequestV1 = {
    schemaVersion: 1,
    id: "req-1",
    projectId: "proj-1",
    policyRevision: 1,
    environment: "production",
    releaseId: "rel-1",
    operationId: "op-1",
    fencingToken: 2,
    commit: "1111111111111111111111111111111111111111",
    artifactDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    protocolVersion: 1,
    keyId: testKeyId,
    timestamp: new Date().toISOString(),
    operation: "deployCanary",
    expectedPriorDeployment: "dep-baseline-0",
    policyDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  }

  it("executes deployCanary and returns valid status", async () => {
    const status = await adapter.deployCanary(baseCanaryReq)
    expect(status.status).toBe("succeeded")
    expect(status.operationId).toBe("op-1")
    expect(status.fencingToken).toBe(2)
    expect(status.deploymentId).toBe("dep-op-1")
  })

  it("provides idempotent lookup for duplicate operation key with identical payload", async () => {
    const duplicate = await adapter.deployCanary(baseCanaryReq)
    expect(duplicate.status).toBe("succeeded")
    expect(duplicate.operationId).toBe("op-1")

    const query = await adapter.getStatus("op-1")
    expect(query.deploymentId).toBe("dep-op-1")
  })

  it("rejects duplicate operationId with different payload (409 conflict)", async () => {
    const conflicting: DeploymentRequestV1 = {
      ...baseCanaryReq,
      commit: "3333333333333333333333333333333333333333", // different commit!
      artifactDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    }

    await expect(adapter.deployCanary(conflicting)).rejects.toThrow(/OPERATION_CONFLICT|409/)
  })

  it("enforces monotonic fencing tokens (rejects stale tokens)", async () => {
    // Current fencing token in production is 2 (from baseCanaryReq)
    const staleReq: DeploymentRequestV1 = {
      schemaVersion: 1,
      id: "req-stale",
      projectId: "proj-1",
      policyRevision: 1,
      environment: "production",
      releaseId: "rel-stale",
      operationId: "op-stale",
      fencingToken: 1, // Valid revision >= 1, but stale because current is 2!
      commit: "4444444444444444444444444444444444444444",
      artifactDigest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      protocolVersion: 1,
      keyId: testKeyId,
      timestamp: new Date().toISOString(),
      operation: "promote",
      expectedPriorDeployment: "dep-op-1",
      policyDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    }

    await expect(adapter.promote(staleReq)).rejects.toThrow(/STALE_FENCING_TOKEN|409/)
  })

  it("rejects requests with invalid cryptographic signatures (401)", async () => {
    const badAdapter = new DeploymentAdapter({
      bridgeUrl: bridge.getUrl(),
      keyId: testKeyId,
      secretOrPrivateKey: "wrong-secret-key-0000000000000000000000000",
    })

    const req: DeploymentRequestV1 = {
      schemaVersion: 1,
      id: "req-bad-sig",
      projectId: "proj-1",
      policyRevision: 1,
      environment: "production",
      releaseId: "rel-bad",
      operationId: "op-bad-sig",
      fencingToken: 3,
      commit: "5555555555555555555555555555555555555555",
      artifactDigest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      protocolVersion: 1,
      keyId: testKeyId,
      timestamp: new Date().toISOString(),
      operation: "promote",
      expectedPriorDeployment: "dep-op-1",
      policyDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    }

    await expect(badAdapter.promote(req)).rejects.toThrow(/SIGNATURE_INVALID|401/)
  })

  it("handles withdrawCanary and deployRollback operations", async () => {
    const withdrawReq: DeploymentRequestV1 = {
      schemaVersion: 1,
      id: "req-withdraw",
      projectId: "proj-1",
      policyRevision: 1,
      environment: "production",
      releaseId: "rel-1",
      operationId: "op-withdraw",
      fencingToken: 4,
      commit: "1111111111111111111111111111111111111111",
      artifactDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      protocolVersion: 1,
      keyId: testKeyId,
      timestamp: new Date().toISOString(),
      operation: "withdrawCanary",
      expectedPriorDeployment: "dep-baseline-0",
      policyDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    }

    const withdrawStatus = await adapter.withdrawCanary(withdrawReq)
    expect(withdrawStatus.status).toBe("succeeded")

    const rollbackReq: DeploymentRequestV1 = {
      ...withdrawReq,
      id: "req-rollback",
      operationId: "op-rollback",
      fencingToken: 5,
      operation: "deployRollback",
    }

    const rollbackStatus = await adapter.deployRollback(rollbackReq)
    expect(rollbackStatus.status).toBe("succeeded")
  })
})
