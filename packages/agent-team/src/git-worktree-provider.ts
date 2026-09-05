/** Git-backed creation and conservative release of durable Team worktrees. */

import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runGit } from './git-command.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamBranchName, TeamCommitId, TeamWorktreeProvider, TeamWorktreeSpec } from './types.ts'
import { TeamError } from './error.ts'

/** Deployment inputs for the Git worktree provider. */
export interface GitWorktreeConfig {
  /** Registry name selected by the Team service. */
  readonly providerName: string
  /** Absolute directory outside the Lead repository for worker checkouts. */
  readonly directory: string
  /** Git branch prefix, validated by Git during resolution. */
  readonly branchPrefix: string
  /** Maximum duration of each Git subprocess. */
  readonly commandTimeoutMs: number
}

/** Git provider whose release operation preserves dirty and unmerged work. */
export class GitWorktreeProvider implements TeamWorktreeProvider {
  readonly name: string

  /**
   * @param config - validated deployment choices.
   */
  constructor(private readonly config: GitWorktreeConfig) {
    this.name = config.providerName
    if (config.providerName.trim() === '' || config.branchPrefix.trim() === '' || !isAbsolute(config.directory)
      || !Number.isSafeInteger(config.commandTimeoutMs) || config.commandTimeoutMs < 1) {
      throw new TeamError('Git worktrees require a provider name, branch prefix, absolute directory, and positive timeout', 'TEAM_INVALID_CONFIG')
    }
  }

  async resolve(repository: string, memberId: SessionId, signal: AbortSignal): Promise<TeamWorktreeSpec> {
    const root = await realpath(await this.git(repository, ['rev-parse', '--show-toplevel'], signal))
    let directory: string
    try {
      directory = await realpath(this.config.directory)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      directory = join(await realpath(dirname(this.config.directory)), basename(this.config.directory))
    }
    const location = relative(root, directory)
    if (location === '' || !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`)) {
      throw new TeamError('Git worktree directory must be outside the Lead repository', 'TEAM_INVALID_CONFIG')
    }
    const identity = `worker-${encodeURIComponent(memberId)}`
    const branch = `${this.config.branchPrefix}/${identity}` as TeamBranchName
    await this.git(root, ['check-ref-format', '--branch', branch], signal)
    const baseCommit = await this.git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal) as TeamCommitId
    return { repository: root, cwd: join(directory, identity), branch, baseCommit }
  }

  async provision(spec: TeamWorktreeSpec, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await mkdir(dirname(spec.cwd), { recursive: true })
    await this.git(spec.repository, ['worktree', 'add', '-b', spec.branch, '--', spec.cwd, spec.baseCommit], signal)
  }

  async release(spec: TeamWorktreeSpec, signal: AbortSignal): Promise<void> {
    const listing = await this.git(spec.repository, ['worktree', 'list', '--porcelain', '-z'], signal)
    const records = listing.split('\0\0').map(record => record.split('\0'))
    const row = records.find(fields => fields.some(field => field.startsWith('worktree ')
      && resolve(field.slice('worktree '.length)) === resolve(spec.cwd)))
    if (row !== undefined && !row.includes(`branch refs/heads/${spec.branch}`)) {
      throw new TeamError('worktree branch does not match recorded ownership', 'TEAM_WORKTREE_CONFLICT')
    }
    if (row === undefined) {
      let exists = true
      try {
        await lstat(spec.cwd)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        exists = false
      }
      if (exists) throw new TeamError('unregistered worktree path is retained', 'TEAM_WORKTREE_CONFLICT')
    }
    const ref = `refs/heads/${spec.branch}`
    const refs = await this.git(spec.repository, ['for-each-ref', '--format=%(refname) %(objectname)', ref], signal)
    const branch = refs.split('\n').find(line => line.startsWith(`${ref} `))?.slice(ref.length + 1) ?? ''
    if (branch === '') {
      if (row !== undefined) throw new TeamError('registered worktree branch is missing', 'TEAM_WORKTREE_CONFLICT')
      return
    }
    // An unmerged tip must remain reachable even when the worktree itself is clean.
    await this.git(spec.repository, ['merge-base', '--is-ancestor', branch, 'HEAD'], signal)
    if (row !== undefined) {
      const status = await this.git(spec.cwd, ['status', '--porcelain', '--ignored=matching', '--untracked-files=all'], signal)
      if (status !== '') throw new TeamError('worktree contains modified, untracked, or ignored files', 'TEAM_WORKTREE_BUSY')
      await this.git(spec.repository, ['worktree', 'remove', '--', spec.cwd], signal)
    }
    await this.git(spec.repository, ['update-ref', '-d', `refs/heads/${spec.branch}`, branch], signal)
  }

  private async git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    return await runGit(cwd, args, signal, this.config.commandTimeoutMs)
  }
}
