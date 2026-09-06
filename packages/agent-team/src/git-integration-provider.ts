/** Isolated Git integration with explicit verification and recoverable target promotion. */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { runGit } from './git-command.ts'
import { TeamError } from './error.ts'
import type { TeamBranchName, TeamCommitId, TeamIntegrationId, TeamIntegrationProvider, TeamIntegrationSpec, TeamVerificationCommand, TeamWorktreeSnapshot } from './types.ts'

/** Deployment choices pinned into each integration request. */
export interface GitIntegrationConfig {
  /** Registry name selected by the Team service. */
  readonly providerName: string
  /** Existing branch checked out in the Lead repository for promotion. */
  readonly targetBranch: string
  /** Trusted literal executables run sequentially in the candidate checkout. */
  readonly verification: TeamVerificationCommand[]
  /** Maximum milliseconds for each Git command. */
  readonly commandTimeoutMs: number
  /** Maximum milliseconds for each verification command. */
  readonly verificationTimeoutMs: number
}

/** Verifies candidates outside the Lead checkout and advances only a clean expected target. */
export class GitIntegrationProvider implements TeamIntegrationProvider {
  readonly name: string

  /**
   * @param config - explicit target and executable verification steps.
   */
  constructor(private readonly config: GitIntegrationConfig) {
    this.name = config.providerName
    if (config.providerName.trim() === '' || config.targetBranch.trim() === '' || config.verification.length === 0
      || config.verification.some(step => step.command.trim() === '')
      || [config.commandTimeoutMs, config.verificationTimeoutMs].some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new TeamError('Git integration requires a provider, target branch, verification commands, and positive timeouts', 'TEAM_INVALID_CONFIG')
    }
  }

  async resolve(worktree: TeamWorktreeSnapshot, id: TeamIntegrationId, signal: AbortSignal): Promise<TeamIntegrationSpec> {
    const targetBranch = this.config.targetBranch as TeamBranchName
    await this.git(worktree.repository, ['check-ref-format', '--branch', targetBranch], signal)
    if (targetBranch === worktree.branch) throw new TeamError('integration target is the worker branch', 'TEAM_INTEGRATION_CONFLICT')
    if (await this.git(worktree.cwd, ['symbolic-ref', '--short', 'HEAD'], signal) !== worktree.branch) {
      throw new TeamError('worker checkout changed its recorded branch', 'TEAM_INTEGRATION_CONFLICT')
    }
    await this.clean(worktree.cwd, signal)
    const sourceCommit = await this.git(worktree.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], signal) as TeamCommitId
    return {
      repository: worktree.repository,
      cwd: join(dirname(worktree.cwd), `integration-${encodeURIComponent(id)}`),
      sourceBranch: worktree.branch, sourceCommit, targetBranch,
      verification: this.config.verification.map(step => ({ command: step.command, args: [...step.args] })),
    }
  }

  async target(spec: TeamIntegrationSpec, signal: AbortSignal): Promise<TeamCommitId> {
    return await this.git(spec.repository, ['rev-parse', '--verify', `refs/heads/${spec.targetBranch}^{commit}`], signal) as TeamCommitId
  }

  /** True only when an accepted prerequisite is contained by this exact target. */
  async contains(spec: TeamIntegrationSpec, target: TeamCommitId, commit: TeamCommitId, signal: AbortSignal): Promise<boolean> {
    try { await this.git(spec.repository, ['merge-base', '--is-ancestor', commit, target], signal); return true }
    catch { return false }
  }

  async verify(spec: TeamIntegrationSpec, target: TeamCommitId, signal: AbortSignal): Promise<TeamCommitId> {
    return await this.verifyStack([spec], target, spec.cwd, signal)
  }

  /**
   * Verify one ordered composition of immutable worker commits.  This is kept
   * beside the single-candidate operation so both paths use precisely the
   * same clean-tree, command, and target rules.
   */
  async verifyStack(specs: readonly TeamIntegrationSpec[], target: TeamCommitId, cwd: string, signal: AbortSignal): Promise<TeamCommitId> {
    if (specs.length === 0) throw new TeamError('integration batch requires at least one source commit', 'TEAM_INTEGRATION_CONFLICT')
    const first = specs[0]!
    if (specs.some(spec => spec.targetBranch !== first.targetBranch
      || JSON.stringify(spec.verification) !== JSON.stringify(first.verification))) {
      throw new TeamError('integration batch changed target or verification policy', 'TEAM_INTEGRATION_CONFLICT')
    }
    if (new Set(specs.map(spec => spec.sourceCommit)).size !== specs.length) {
      throw new TeamError('integration batch repeats an immutable source commit', 'TEAM_INTEGRATION_CONFLICT')
    }
    await mkdir(dirname(cwd), { recursive: true })
    await this.git(first.repository, ['worktree', 'add', '--detach', '--', cwd, target], signal)
    for (const spec of specs) await this.git(cwd, ['-c', 'commit.gpgSign=false', 'merge', '--no-edit', '--no-stat', spec.sourceCommit], signal)
    const candidate = await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], signal) as TeamCommitId
    for (const step of first.verification) {
      await execa(step.command, step.args, { cwd, cancelSignal: signal, timeout: this.config.verificationTimeoutMs })
    }
    if (await this.git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], signal) !== candidate) {
      throw new TeamError('verification changed the candidate commit', 'TEAM_INTEGRATION_CONFLICT')
    }
    await this.clean(cwd, signal)
    return candidate
  }

  async promote(spec: TeamIntegrationSpec, target: TeamCommitId, candidate: TeamCommitId, signal: AbortSignal): Promise<void> {
    const current = await this.target(spec, signal)
    if (current === candidate) return
    if (current !== target) throw new TeamError('integration target moved; candidate requires verification against the new target', 'TEAM_INTEGRATION_STALE')
    if (await this.git(spec.repository, ['symbolic-ref', '--short', 'HEAD'], signal) !== spec.targetBranch) {
      throw new TeamError('Lead checkout must be on the configured integration target', 'TEAM_INTEGRATION_CONFLICT')
    }
    await this.clean(spec.repository, signal)
    await this.git(spec.repository, ['merge', '--ff-only', '--no-edit', '--no-stat', candidate], signal)
  }

  private async clean(cwd: string, signal: AbortSignal): Promise<void> {
    if (await this.git(cwd, ['status', '--porcelain', '--untracked-files=all'], signal) !== '') {
      throw new TeamError('integration requires a clean tracked and untracked tree', 'TEAM_INTEGRATION_DIRTY')
    }
  }

  private async git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    return await runGit(cwd, args, signal, this.config.commandTimeoutMs)
  }
}
