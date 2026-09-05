/** Conservative removal of one verified, merged detached Git candidate worktree. */

import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { acquireIntegrationOwnership } from './integration-ownership.ts'
import { runGit } from './git-command.ts'

/** Immutable identity and execution limits for one candidate cleanup attempt. */
export interface GitCandidateCleanupConfig {
  /** Repository whose configured target contains the candidate. */
  readonly repository: string
  /** Branch against which the candidate must be proven merged. */
  readonly targetBranch: string
  /** Exact, non-symlink candidate worktree path recorded by the caller. */
  readonly cwd: string
  /** Detached commit expected at the candidate worktree's HEAD. */
  readonly candidateCommit: string
  /** Maximum duration of each Git subprocess. */
  readonly commandTimeoutMs: number
}

/** A cleanup decision that always preserves uncertain output. */
export interface GitCandidateCleanupResult {
  readonly outcome: 'removed' | 'absent' | 'retained'
  /** Stable human-readable reason when output was retained. */
  readonly diagnostic?: string
}

interface WorktreeRow {
  readonly path: string
  readonly fields: readonly string[]
}

/**
 * Removes only a registered, clean detached candidate after proving it belongs
 * to the pinned repository and is reachable from the current configured target.
 */
export class GitCandidateCleanup {
  constructor(private readonly config: GitCandidateCleanupConfig) {
    if (!isAbsolute(config.repository) || !isAbsolute(config.cwd) || config.targetBranch.trim() === ''
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(config.candidateCommit)
      || !Number.isSafeInteger(config.commandTimeoutMs) || config.commandTimeoutMs < 1) {
      throw new Error('Git candidate cleanup requires absolute repository and cwd, pinned target and candidate, and a positive timeout')
    }
  }

  async cleanup(signal: AbortSignal): Promise<GitCandidateCleanupResult> {
    signal.throwIfAborted()
    let release: (() => Promise<void>) | undefined
    try {
      release = await acquireIntegrationOwnership(this.config.repository, this.config.targetBranch, signal)
      return await this.cleanupOwned(signal)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      return { outcome: 'retained', diagnostic: this.message(error) }
    } finally {
      await release?.()
    }
  }

  private async cleanupOwned(signal: AbortSignal): Promise<GitCandidateCleanupResult> {
    try {
      const expected = resolve(this.config.cwd)
      const listing = await this.git(this.config.repository, ['worktree', 'list', '--porcelain', '-z'], signal)
      const row = this.worktree(listing, expected)
      const path = await this.pathState(expected)
      if (row === undefined || !path.exists) {
        if (row === undefined && !path.exists) return { outcome: 'absent' }
        return { outcome: 'retained', diagnostic: row === undefined ? 'candidate path is not a registered worktree' : 'registered candidate path is missing' }
      }
      if (path.symlink || path.real !== expected) return { outcome: 'retained', diagnostic: 'candidate path is a symlink or aliases another location' }

      const repositoryCommon = await this.commonDir(this.config.repository, signal)
      const candidateCommon = await this.commonDir(expected, signal)
      if (repositoryCommon !== candidateCommon) return { outcome: 'retained', diagnostic: 'candidate worktree belongs to a different Git common directory' }
      if (row.path !== expected) return { outcome: 'retained', diagnostic: 'candidate worktree registration does not exactly match the pinned path' }
      if (!row.fields.includes('detached')) return { outcome: 'retained', diagnostic: 'candidate worktree is not detached' }

      const candidate = await this.git(expected, ['rev-parse', '--verify', `${this.config.candidateCommit}^{commit}`], signal)
      if (candidate !== this.config.candidateCommit) return { outcome: 'retained', diagnostic: 'pinned candidate commit is not canonical' }
      const head = await this.git(expected, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
      if (head !== candidate) return { outcome: 'retained', diagnostic: 'candidate HEAD no longer matches the pinned commit' }
      await this.git(this.config.repository, ['check-ref-format', '--branch', this.config.targetBranch], signal)
      const target = await this.git(this.config.repository, ['rev-parse', '--verify', `refs/heads/${this.config.targetBranch}^{commit}`], signal)
      const merged = await this.tryGit(this.config.repository, ['merge-base', '--is-ancestor', candidate, target], signal)
      if (!merged.ok) return { outcome: 'retained', diagnostic: 'candidate is not merged into the configured target' }

      const status = await this.git(expected, ['status', '--porcelain=v1', '--ignored=matching', '--untracked-files=all'], signal)
      if (status !== '') return { outcome: 'retained', diagnostic: 'candidate contains tracked, untracked, ignored, or unmerged content' }
      if (await this.hasOperation(expected, signal)) return { outcome: 'retained', diagnostic: 'candidate has a merge, rebase, or sequencer operation in progress' }

      const removal = await this.tryGit(this.config.repository, ['worktree', 'remove', '--', expected], signal)
      if (removal.ok) return { outcome: 'removed' }
      // A transport/process acknowledgement can fail after Git has completed the remove.
      // Recognition is safe only once both independent records say it is gone.
      const after = this.worktree(await this.git(this.config.repository, ['worktree', 'list', '--porcelain', '-z'], signal), expected)
      const afterPath = await this.pathState(expected)
      if (after === undefined && !afterPath.exists) return { outcome: 'removed' }
      return { outcome: 'retained', diagnostic: 'git refused candidate worktree removal' }
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      return { outcome: 'retained', diagnostic: this.message(error) }
    }
  }

  private async commonDir(cwd: string, signal: AbortSignal): Promise<string> {
    return await realpath(await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal))
  }

  private async hasOperation(cwd: string, signal: AbortSignal): Promise<boolean> {
    const names = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']
    for (const name of names) {
      const location = await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', name], signal)
      try {
        await stat(location)
        return true
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return false
  }

  private worktree(listing: string, expected: string): WorktreeRow | undefined {
    for (const record of listing.split('\0\0')) {
      const fields = record.split('\0').filter(Boolean)
      const worktree = fields.find(field => field.startsWith('worktree '))
      if (worktree === undefined) continue
      const path = resolve(worktree.slice('worktree '.length))
      if (path === expected) return { path, fields }
    }
  }

  private async pathState(path: string): Promise<{ exists: boolean, symlink: boolean, real?: string }> {
    let entry
    try {
      entry = await lstat(path)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, symlink: false }
      throw error
    }
    if (entry.isSymbolicLink()) return { exists: true, symlink: true }
    // Do not convert a race or inaccessible canonical location into absence.
    return { exists: true, symlink: false, real: await realpath(path) }
  }

  private async git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    return await runGit(cwd, args, signal, this.config.commandTimeoutMs)
  }

  private async tryGit(cwd: string, args: readonly string[], signal: AbortSignal): Promise<{ ok: boolean }> {
    try {
      await this.git(cwd, args, signal)
      return { ok: true }
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      return { ok: false }
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
