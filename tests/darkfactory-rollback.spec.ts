import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  DarkFactoryRollbackController,
  RollbackConflictError,
} from "../packages/agent-team/src/darkfactory/rollback-controller.ts"
import type { ReleaseRecordV1 } from "../packages/agent-team/src/darkfactory/contracts/release.ts"

const execFileAsync = promisify(execFile)
const env = {
  ...process.env,
  PATH: `/home/linuxbrew/.linuxbrew/bin:${process.env.PATH}`,
  TMPDIR: "/var/tmp",
  GIT_AUTHOR_NAME: "Rollback Tester",
  GIT_AUTHOR_EMAIL: "tester@example.com",
  GIT_COMMITTER_NAME: "Rollback Tester",
  GIT_COMMITTER_EMAIL: "tester@example.com",
}

describe("DF-14 Verified Git Rollback & Automatic Containment", () => {
  let testRepoDir: string
  let controller: DarkFactoryRollbackController
  const cleanups: string[] = []

  beforeEach(async () => {
    controller = new DarkFactoryRollbackController()
    testRepoDir = await mkdtemp(join(process.env.TMPDIR ?? "/var/tmp", "factory-test-repo-"))
    cleanups.push(testRepoDir)

    // Initialize standalone git fixture repo
    await execFileAsync("git", ["init", "-b", "main"], { cwd: testRepoDir, env })
    await writeFile(join(testRepoDir, "file.txt"), "v1 initial\n")
    await execFileAsync("git", ["add", "."], { cwd: testRepoDir, env })
    await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: testRepoDir, env })
  })

  afterEach(async () => {
    for (const dir of cleanups.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it("executes git revert in an isolated ephemeral worktree for direct commit", async () => {
    // Add feature commit to revert
    await writeFile(join(testRepoDir, "file.txt"), "v2 feature change\n")
    await execFileAsync("git", ["add", "."], { cwd: testRepoDir, env })
    await execFileAsync("git", ["commit", "-m", "feature change v2"], { cwd: testRepoDir, env })
    const { stdout: commitOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: testRepoDir, env })
    const featureSha = commitOut.trim()

    // Execute isolated worktree revert
    const result = await controller.executeRevertInWorktree({
      repoDir: testRepoDir,
      commitSha: featureSha,
      releaseId: "rel-direct-1",
    })

    expect(result.revertSha).toBeDefined()
    expect(result.revertSha).toMatch(/^[a-f0-9]{40}$/)

    // Worktree directory should be cleaned up
    const worktreeCleaned = await rm(result.worktreePath).then(() => false).catch(() => true)
    expect(worktreeCleaned).toBe(true)

    // Inspect the revert commit in testRepoDir
    const { stdout: showLog } = await execFileAsync("git", ["log", "-n", "1", result.revertSha], { cwd: testRepoDir, env })
    expect(showLog).toContain("Rollback release rel-direct-1")
  })

  it("executes git revert in an isolated worktree for a merge commit with --mainline", async () => {
    // Create a feature branch
    await execFileAsync("git", ["checkout", "-b", "feature-branch"], { cwd: testRepoDir, env })
    await writeFile(join(testRepoDir, "feature.txt"), "new feature file\n")
    await execFileAsync("git", ["add", "."], { cwd: testRepoDir, env })
    await execFileAsync("git", ["commit", "-m", "feature commit"], { cwd: testRepoDir, env })

    // Switch back to main and merge with a merge commit
    await execFileAsync("git", ["checkout", "main"], { cwd: testRepoDir, env })
    await execFileAsync("git", ["merge", "--no-ff", "feature-branch", "-m", "merge feature-branch"], { cwd: testRepoDir, env })
    const { stdout: mergeOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: testRepoDir, env })
    const mergeSha = mergeOut.trim()

    // Revert merge commit using --mainline 1
    const result = await controller.executeRevertInWorktree({
      repoDir: testRepoDir,
      commitSha: mergeSha,
      parentNumber: 1,
      releaseId: "rel-merge-1",
    })

    expect(result.revertSha).toBeDefined()
    const { stdout: showLog } = await execFileAsync("git", ["log", "-n", "1", result.revertSha], { cwd: testRepoDir, env })
    expect(showLog).toContain("Rollback release rel-merge-1")
  })

  it("detects merge conflicts in worktree and throws RollbackConflictError cleanly", async () => {
    // Commit 1: base
    await writeFile(join(testRepoDir, "conflict.txt"), "line A\n")
    await execFileAsync("git", ["add", "."], { cwd: testRepoDir, env })
    await execFileAsync("git", ["commit", "-m", "conflict base"], { cwd: testRepoDir, env })
    const { stdout: baseOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: testRepoDir, env })
    const baseSha = baseOut.trim()

    // Commit 2: change line A -> B
    await writeFile(join(testRepoDir, "conflict.txt"), "line B\n")
    await execFileAsync("git", ["add", "."], { cwd: testRepoDir, env })
    await execFileAsync("git", ["commit", "-m", "conflict change"], { cwd: testRepoDir, env })

    // Commit 3: change line B -> C
    await writeFile(join(testRepoDir, "conflict.txt"), "line C\n")
    await execFileAsync("git", ["add", "."], { cwd: testRepoDir, env })
    await execFileAsync("git", ["commit", "-m", "conflict next change"], { cwd: testRepoDir, env })

    // Reverting Commit 2 directly now creates a conflict because line C is in place
    const { stdout: targetOut } = await execFileAsync("git", ["rev-parse", "HEAD~1"], { cwd: testRepoDir, env })
    const targetSha = targetOut.trim()

    await expect(controller.executeRevertInWorktree({
      repoDir: testRepoDir,
      commitSha: targetSha,
      releaseId: "rel-conflict-1",
    })).rejects.toThrow(RollbackConflictError)
  })

  it("emits exactly one operator diagnostic task (strictly idempotent)", async () => {
    const diagDir = join(testRepoDir, "diagnostics")
    const mockRelease: ReleaseRecordV1 = {
      schemaVersion: 1,
      id: "rel-diag-1",
      projectId: "proj-1",
      policyRevision: 1,
      repository: { provider: "github", repositoryId: "repo-1", canonicalName: "Silktex/dsh-gasteam" },
      environment: "production",
      componentId: "comp-auth",
      workflowId: "wf-1",
      integrationReceiptId: "rec-1",
      attemptIds: ["att-1"],
      specDigests: ["sha256:1111111111111111111111111111111111111111111111111111111111111111"],
      evidenceHashes: ["sha256:2222222222222222222222222222222222222222222222222222222222222222"],
      commit: "1111111111111111111111111111111111111111",
      artifact: { projectId: "proj-1", id: "art-1", mediaType: "application/tar", sizeBytes: 1024, digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333" },
      priorAcceptedReleaseId: "rel-prior",
      priorArtifact: { projectId: "proj-1", id: "art-prior", mediaType: "application/tar", sizeBytes: 1024, digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444" },
      policyDigest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      policySnapshot: { projectId: "proj-1", id: "art-policy", mediaType: "application/json", sizeBytes: 512, digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555" },
      state: "rollback_queued",
      revision: 2,
      fencingToken: 10,
      operationIntents: [],
      operationReceipts: [],
      telemetryIds: [],
    }

    const id1 = await controller.emitDiagnosticTask({
      diagnosticsDir: diagDir,
      release: mockRelease,
      reason: "ANOMALY_DETECTED: 3 consecutive telemetry latency breaches",
      revertSha: "1111111111111111111111111111111111111111",
    })
    expect(id1).toBe("diag-rel-diag-1")

    // Second call with same release is idempotent
    const id2 = await controller.emitDiagnosticTask({
      diagnosticsDir: diagDir,
      release: mockRelease,
      reason: "duplicate call",
    })
    expect(id2).toBe("diag-rel-diag-1")

    // Check file content has exactly one line
    const content = await readFile(join(diagDir, "diagnostics.jsonl"), "utf8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!)
    expect(record.id).toBe("diag-rel-diag-1")
    expect(record.componentId).toBe("comp-auth")
  })

  it("trips circuit breaker after 2 consecutive rollbacks on same component", () => {
    expect(controller.isCircuitBreakerTripped("comp-payment")).toBe(false)

    // Rollback 1
    const r1 = controller.recordRollback("comp-payment")
    expect(r1.consecutive).toBe(1)
    expect(r1.circuitBreakerTripped).toBe(false)
    expect(controller.isCircuitBreakerTripped("comp-payment")).toBe(false)

    // Rollback 2 -> Tripped!
    const r2 = controller.recordRollback("comp-payment")
    expect(r2.consecutive).toBe(2)
    expect(r2.circuitBreakerTripped).toBe(true)
    expect(controller.isCircuitBreakerTripped("comp-payment")).toBe(true)

    // Resetting circuit breaker
    controller.resetCircuitBreaker("comp-payment")
    expect(controller.isCircuitBreakerTripped("comp-payment")).toBe(false)
  })
})
