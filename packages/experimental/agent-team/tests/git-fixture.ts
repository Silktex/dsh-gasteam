/** Private Git repositories shared by worktree and Team lifecycle tests. */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { GitWorktreeProvider } from '../src/git-worktree-provider.ts'

/**
 * Create a committed repository and an external worker-directory configuration.
 * @param ownRoot - register cleanup immediately after temporary-root allocation.
 * @returns real Git provider, repository paths, and a repository-scoped Git runner.
 */
export async function gitFixture(ownRoot: (root: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-git-'))
  ownRoot(root)
  const repository = join(root, 'repository')
  await execa('git', ['init', '--initial-branch=main', repository])
  const git = async (...args: string[]) => await execa('git', ['-C', repository, ...args])
  await git('config', 'user.name', 'Team fixture')
  await git('config', 'user.email', 'team@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(repository, 'shared.txt'), 'base\n')
  await git('add', 'shared.txt')
  await git('commit', '-m', 'base')
  const config = {
    providerName: 'git', directory: join(root, 'workers'), branchPrefix: 'team', commandTimeoutMs: 30_000,
  }
  const provider = new GitWorktreeProvider(config)
  return { root, repository, config, provider, git }
}
