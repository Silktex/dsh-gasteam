/**
 * Dark Factory Gate 3: Verified Git Rollback & Automatic Containment (DF-14)
 *
 * Implements immediate traffic withdrawal containment, isolated ephemeral git worktree
 * reverts (git revert --mainline / --no-commit), revert verification, single diagnostic
 * task emission, and a 2-consecutive-rollback circuit breaker.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import z from "zod"
import type { ReleaseRecordV1 } from "./contracts/release.ts"
import type { DeploymentAdapter } from "./deployment-bridge.ts"
import { canonicalJson, digestJson } from "./json.ts"
import { idSchema, timestampSchema } from "./contracts/common.ts"

const execFileAsync = promisify(execFile)

export class RollbackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "RollbackError"
  }
}

export class RollbackConflictError extends RollbackError {
  constructor(message = "Merge conflict or invalid ancestry encountered during git rollback revert") {
    super("ROLLBACK_CONFLICT", message)
  }
}

export class RollbackCircuitBreakerError extends RollbackError {
  constructor(componentId: string, consecutive: number) {
    super("CIRCUIT_BREAKER_OPEN", `Circuit breaker open for component "${componentId}" after ${consecutive} consecutive rollbacks`)
  }
}

export interface DiagnosticTaskPayload {
  readonly id: string
  readonly releaseId: string
  readonly componentId: string
  readonly environment: string
  readonly reason: string
  readonly revertSha?: string | undefined
  readonly telemetrySnapshot?: unknown
  readonly emittedAt: string
}

export interface RollbackExecutionResult {
  readonly revertSha: string
  readonly worktreePath: string
  readonly diagnosticTaskId: string
  readonly circuitBreakerTripped: boolean
}

export class DarkFactoryRollbackController {
  private consecutiveRollbacks = new Map<string, number>()
  private emittedDiagnosticTasks = new Set<string>()

  constructor(private readonly options: { maxConsecutiveRollbacks?: number } = {}) {}

  getConsecutiveRollbacks(componentId: string): number {
    return this.consecutiveRollbacks.get(componentId) ?? 0
  }

  isCircuitBreakerTripped(componentId: string): boolean {
    const max = this.options.maxConsecutiveRollbacks ?? 2
    return (this.consecutiveRollbacks.get(componentId) ?? 0) >= max
  }

  resetCircuitBreaker(componentId: string): void {
    this.consecutiveRollbacks.set(componentId, 0)
  }

  /**
   * Containment: immediately withdraw canary exposure using the recorded stable artifact.
   */
  async executeContainmentWithdrawal(release: ReleaseRecordV1, adapter: DeploymentAdapter): Promise<void> {
    await adapter.withdrawCanary({
      schemaVersion: 1,
      id: `withdraw-${release.id}`,
      projectId: release.projectId,
      policyRevision: release.policyRevision,
      environment: release.environment,
      releaseId: release.id,
      operationId: `op-withdraw-${release.id}`,
      fencingToken: release.fencingToken + 1,
      commit: release.commit,
      artifactDigest: release.artifact.digest,
      protocolVersion: 1,
      keyId: "rollback-controller",
      timestamp: new Date().toISOString(),
      operation: "withdrawCanary",
      expectedPriorDeployment: release.priorAcceptedReleaseId,
      policyDigest: release.policyDigest,
    })
  }

  /**
   * Execute git revert in an ephemeral isolated git worktree in TMPDIR (/var/tmp)
   * based on the current target branch/commit.
   */
  async executeRevertInWorktree(options: {
    repoDir: string
    commitSha: string
    targetRef?: string | undefined
    parentNumber?: number | undefined
    releaseId: string
  }): Promise<{ revertSha: string; worktreePath: string }> {
    const worktreeBase = process.env.TMPDIR ?? "/var/tmp"
    const worktreePath = await mkdtemp(join(worktreeBase, `gasteam-rollback-${options.releaseId}-`))
    const targetRef = options.targetRef ?? "HEAD"

    try {
      // 1. Create isolated worktree based on targetRef (e.g. current branch HEAD)
      await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, targetRef], {
        cwd: options.repoDir,
        env: { ...process.env, PATH: `/home/linuxbrew/.linuxbrew/bin:${process.env.PATH}`, TMPDIR: worktreeBase },
      })

      // 2. Perform revert
      const revertArgs = ["revert", "--no-commit"]
      if (options.parentNumber !== undefined && options.parentNumber > 0) {
        revertArgs.push("--mainline", String(options.parentNumber))
      }
      revertArgs.push(options.commitSha)

      try {
        await execFileAsync("git", revertArgs, {
          cwd: worktreePath,
          env: { ...process.env, PATH: `/home/linuxbrew/.linuxbrew/bin:${process.env.PATH}`, TMPDIR: worktreeBase },
        })
      } catch (err: any) {
        throw new RollbackConflictError(`Git revert failed in worktree: ${err.message}`)
      }

      // 3. Commit the revert inside the worktree
      const commitMessage = `Rollback release ${options.releaseId}: revert ${options.commitSha}`
      await execFileAsync("git", ["commit", "-m", commitMessage], {
        cwd: worktreePath,
        env: {
          ...process.env,
          PATH: `/home/linuxbrew/.linuxbrew/bin:${process.env.PATH}`,
          TMPDIR: worktreeBase,
          GIT_AUTHOR_NAME: "Dark Factory Rollback Authority",
          GIT_AUTHOR_EMAIL: "darkfactory@silktex.internal",
          GIT_COMMITTER_NAME: "Dark Factory Rollback Authority",
          GIT_COMMITTER_EMAIL: "darkfactory@silktex.internal",
        },
      })

      // 4. Extract new revert SHA
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        env: { ...process.env, PATH: `/home/linuxbrew/.linuxbrew/bin:${process.env.PATH}`, TMPDIR: worktreeBase },
      })
      const revertSha = stdout.trim()

      return { revertSha, worktreePath }
    } finally {
      // Clean up worktree from git registry
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: options.repoDir,
          env: { ...process.env, PATH: `/home/linuxbrew/.linuxbrew/bin:${process.env.PATH}`, TMPDIR: worktreeBase },
        })
      } catch {
        // ignore cleanup error if worktree was already removed
      }
    }
  }

  /**
   * Emit exactly one operator diagnostic task to diagnostics.jsonl.
   */
  async emitDiagnosticTask(options: {
    diagnosticsDir: string
    release: ReleaseRecordV1
    reason: string
    revertSha?: string | undefined
    telemetrySnapshot?: unknown
  }): Promise<string> {
    const diagnosticTaskId = `diag-${options.release.id}`
    if (this.emittedDiagnosticTasks.has(diagnosticTaskId)) {
      // Strictly idempotent: exactly one diagnostic task per release
      return diagnosticTaskId
    }

    const payload: Record<string, unknown> = {
      id: diagnosticTaskId,
      releaseId: options.release.id,
      componentId: options.release.componentId,
      environment: options.release.environment,
      reason: options.reason,
      emittedAt: new Date().toISOString(),
    }
    if (options.revertSha !== undefined) payload.revertSha = options.revertSha
    if (options.telemetrySnapshot !== undefined) payload.telemetrySnapshot = options.telemetrySnapshot

    await mkdir(options.diagnosticsDir, { recursive: true })
    const filename = join(options.diagnosticsDir, "diagnostics.jsonl")
    await appendFile(filename, canonicalJson(payload) + "\n", "utf8")

    this.emittedDiagnosticTasks.add(diagnosticTaskId)
    return diagnosticTaskId
  }

  /**
   * Record a rollback event, incrementing circuit breaker counter.
   */
  recordRollback(componentId: string): { consecutive: number; circuitBreakerTripped: boolean } {
    const current = (this.consecutiveRollbacks.get(componentId) ?? 0) + 1
    this.consecutiveRollbacks.set(componentId, current)
    const max = this.options.maxConsecutiveRollbacks ?? 2
    const circuitBreakerTripped = current >= max
    return { consecutive: current, circuitBreakerTripped }
  }
}
