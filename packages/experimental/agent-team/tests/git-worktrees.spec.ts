import { afterEach, describe, expect, it } from 'vitest'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { SessionId } from '@deepseek-ai/dsh-session'
import { GitWorktreeProvider } from '../src/git-worktree-provider.ts'
import { gitFixture } from './git-fixture.ts'

const roots: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function setup() {
  return gitFixture((root) => { roots.push(root) })
}

describe('Git Team worktrees', () => {
  it('isolates concurrent workers from each other and the Lead checkout', async () => {
    const { repository, provider, git } = await setup()
    const [first, second] = await Promise.all([
      provider.resolve(repository, SessionId('first'), signal),
      provider.resolve(repository, SessionId('second'), signal),
    ])
    expect(first.baseCommit).toBe(second.baseCommit)
    expect(first.branch).not.toBe(second.branch)
    await Promise.all([provider.provision(first, signal), provider.provision(second, signal)])
    await writeFile(join(first.cwd, 'shared.txt'), 'first\n')
    await writeFile(join(second.cwd, 'shared.txt'), 'second\n')
    expect(await readFile(join(repository, 'shared.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(join(first.cwd, 'shared.txt'), 'utf8')).toBe('first\n')
    expect(await readFile(join(second.cwd, 'shared.txt'), 'utf8')).toBe('second\n')
    expect((await git('status', '--porcelain')).stdout).toBe('')
    await expect(provider.release(first, signal)).rejects.toThrow()
    expect(await readFile(join(first.cwd, 'shared.txt'), 'utf8')).toBe('first\n')
  })

  it('preserves unmerged commits and releases only after they reach the Lead branch', async () => {
    const { repository, provider, git } = await setup()
    const spec = await provider.resolve(repository, SessionId('worker'), signal)
    await provider.provision(spec, signal)
    await writeFile(join(spec.cwd, 'shared.txt'), 'worker\n')
    await execa('git', ['-C', spec.cwd, 'commit', '-am', 'worker'])
    await expect(provider.release(spec, signal)).rejects.toThrow()
    expect(await readFile(join(spec.cwd, 'shared.txt'), 'utf8')).toBe('worker\n')
    await git('merge', '--ff-only', spec.branch)
    await provider.release(spec, signal)
    await expect(readFile(join(spec.cwd, 'shared.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await git('branch', '--list', spec.branch)).stdout).toBe('')
    await provider.release(spec, signal)
  })

  it('rolls back a clean base checkout without disturbing a conflicting path', async () => {
    const { repository, provider } = await setup()
    const spec = await provider.resolve(repository, SessionId('worker'), signal)
    await provider.provision(spec, signal)
    await expect(provider.provision(spec, signal)).rejects.toThrow()
    await provider.release(spec, signal)
    await writeFile(spec.cwd, 'unrelated')
    await expect(provider.release(spec, signal)).rejects.toMatchObject({ code: 'TEAM_WORKTREE_CONFLICT' })
    expect(await readFile(spec.cwd, 'utf8')).toBe('unrelated')
  })

  it('preserves ignored files and rejects a directory symlink into the Lead checkout', async () => {
    const { root, repository, provider, git } = await setup()
    await writeFile(join(repository, '.gitignore'), 'private.txt\n')
    await git('add', '.gitignore')
    await git('commit', '-m', 'ignore private data')
    const spec = await provider.resolve(repository, SessionId('worker'), signal)
    await provider.provision(spec, signal)
    await writeFile(join(spec.cwd, 'private.txt'), 'retained')
    await expect(provider.release(spec, signal)).rejects.toMatchObject({ code: 'TEAM_WORKTREE_BUSY' })
    expect(await readFile(join(spec.cwd, 'private.txt'), 'utf8')).toBe('retained')
    const link = join(root, 'repository-link')
    await symlink(repository, link, 'junction')
    const nested = new GitWorktreeProvider({
      providerName: 'nested', directory: link, branchPrefix: 'team', commandTimeoutMs: 30_000,
    })
    await expect(nested.resolve(repository, SessionId('nested'), signal)).rejects.toMatchObject({ code: 'TEAM_INVALID_CONFIG' })
  })

  it('rejects an in-repository directory and cancellation before creating a worktree', async () => {
    const { repository, provider } = await setup()
    const nested = new GitWorktreeProvider({
      providerName: 'nested', directory: join(repository, 'workers'), branchPrefix: 'team', commandTimeoutMs: 30_000,
    })
    await expect(nested.resolve(repository, SessionId('worker'), signal)).rejects.toMatchObject({ code: 'TEAM_INVALID_CONFIG' })
    const spec = await provider.resolve(repository, SessionId('worker'), signal)
    const cancelled = AbortSignal.abort(new Error('cancelled'))
    await expect(provider.provision(spec, cancelled)).rejects.toThrow('cancelled')
    await expect(readFile(join(spec.cwd, 'shared.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
