import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { GitCandidateCleanup } from '../src/git-candidate-cleanup.ts'
import { gitFixture } from './git-fixture.ts'

const roots: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const fixture = await gitFixture(root => { roots.push(root) })
  const cwd = join(fixture.root, 'candidate')
  const candidateCommit = (await fixture.git('rev-parse', 'HEAD')).stdout
  await fixture.git('worktree', 'add', '--detach', '--', cwd, candidateCommit)
  const cleanup = new GitCandidateCleanup({
    repository: fixture.repository, targetBranch: 'main', cwd, candidateCommit, commandTimeoutMs: 30_000,
  })
  return { ...fixture, cwd, candidateCommit, cleanup }
}

describe('Git candidate cleanup', () => {
  it('removes a clean merged detached candidate and recognizes the absent retry', async () => {
    const { cwd, cleanup } = await setup()
    expect(await cleanup.cleanup(signal)).toEqual({ outcome: 'removed' })
    await expect(readFile(join(cwd, 'shared.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await cleanup.cleanup(signal)).toEqual({ outcome: 'absent' })
  })

  it.each([
    ['tracked', async (cwd: string) => await writeFile(join(cwd, 'shared.txt'), 'changed\n')],
    ['untracked', async (cwd: string) => await writeFile(join(cwd, 'untracked.txt'), 'retain\n')],
  ])('retains %s content', async (_kind, change) => {
    const { cwd, cleanup } = await setup()
    await change(cwd)
    await expect(cleanup.cleanup(signal)).resolves.toMatchObject({ outcome: 'retained' })
    expect(await readFile(join(cwd, _kind === 'tracked' ? 'shared.txt' : 'untracked.txt'), 'utf8')).toBe(_kind === 'tracked' ? 'changed\n' : 'retain\n')
  })

  it('retains ignored content', async () => {
    const { cwd, cleanup } = await setup()
    const exclude = (await execa('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'])).stdout
    await writeFile(exclude, 'private.txt\n')
    await writeFile(join(cwd, 'private.txt'), 'retain\n')
    await expect(cleanup.cleanup(signal)).resolves.toMatchObject({ outcome: 'retained' })
    expect(await readFile(join(cwd, 'private.txt'), 'utf8')).toBe('retain\n')
  })

  it('retains a conflicted candidate with an operation in progress', async () => {
    const { repository, cwd, cleanup, git, candidateCommit } = await setup()
    await git('checkout', '-b', 'target-next')
    await writeFile(join(repository, 'shared.txt'), 'target\n')
    await git('commit', '-am', 'target')
    await git('checkout', 'main')
    await git('merge', '--ff-only', 'target-next')
    await git('checkout', '-b', 'conflict', candidateCommit)
    await writeFile(join(repository, 'shared.txt'), 'conflict\n')
    await git('commit', '-am', 'conflict')
    await git('checkout', 'main')
    const target = (await git('rev-parse', 'main')).stdout
    const [baseBlob, targetBlob, conflictBlob] = await Promise.all([
      execa('git', ['-C', cwd, 'rev-parse', `${candidateCommit}:shared.txt`]),
      execa('git', ['-C', cwd, 'rev-parse', `${target}:shared.txt`]),
      execa('git', ['-C', cwd, 'rev-parse', 'conflict:shared.txt']),
    ])
    await execa('git', ['-C', cwd, 'update-index', '--force-remove', 'shared.txt'])
    await execa('git', ['-C', cwd, 'update-index', '--index-info'], {
      input: `100644 ${baseBlob.stdout} 1\tshared.txt\n100644 ${targetBlob.stdout} 2\tshared.txt\n100644 ${conflictBlob.stdout} 3\tshared.txt\n`,
    })
    await expect(cleanup.cleanup(signal)).resolves.toMatchObject({ outcome: 'retained' })
    expect((await execa('git', ['-C', cwd, 'status', '--porcelain'])).stdout).not.toBe('')
  })

  it('retains a status-clean candidate with a sequencer operation directory', async () => {
    const { cwd, cleanup } = await setup()
    const sequencer = (await execa('git', ['-C', cwd, 'rev-parse', '--git-path', 'sequencer'])).stdout
    await mkdir(sequencer)
    expect((await execa('git', ['-C', cwd, 'status', '--porcelain', '--ignored=matching', '--untracked-files=all'])).stdout).toBe('')
    await expect(cleanup.cleanup(signal)).resolves.toMatchObject({ outcome: 'retained' })
  })

  it('retains a candidate whose detached HEAD changed', async () => {
    const { cwd, cleanup } = await setup()
    await execa('git', ['-C', cwd, 'checkout', '--detach', 'HEAD~0'])
    await execa('git', ['-C', cwd, 'commit', '--allow-empty', '-m', 'changed head'])
    await expect(cleanup.cleanup(signal)).resolves.toMatchObject({ outcome: 'retained' })
    expect((await execa('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout).not.toBe('')
  })

  it('retains a checkout not registered by the pinned repository', async () => {
    const { root, cwd, candidateCommit } = await setup()
    const other = join(root, 'other')
    await execa('git', ['init', '--initial-branch=main', other])
    await execa('git', ['-C', other, 'config', 'user.name', 'Other fixture'])
    await execa('git', ['-C', other, 'config', 'user.email', 'other@example.invalid'])
    const cleanup = new GitCandidateCleanup({ repository: other, targetBranch: 'main', cwd, candidateCommit, commandTimeoutMs: 30_000 })
    await expect(cleanup.cleanup(signal)).resolves.toMatchObject({ outcome: 'retained' })
    expect(await readFile(join(cwd, 'shared.txt'), 'utf8')).toBe('base\n')
  })

  it('retains a symlink alias rather than trusting it as the candidate path', async () => {
    const { root, repository, cwd, candidateCommit } = await setup()
    const alias = join(root, 'candidate-alias')
    await symlink(cwd, alias, 'junction')
    const cleanup = new GitCandidateCleanup({ repository, targetBranch: 'main', cwd: alias, candidateCommit, commandTimeoutMs: 30_000 })
    await expect(cleanup.cleanup(signal)).resolves.toMatchObject({ outcome: 'retained' })
    expect(await readFile(join(cwd, 'shared.txt'), 'utf8')).toBe('base\n')
  })

  it('honors cancellation before inspecting or removing a candidate', async () => {
    const { cwd, cleanup } = await setup()
    const cancelled = AbortSignal.abort(new Error('cancelled'))
    await expect(cleanup.cleanup(cancelled)).rejects.toThrow('cancelled')
    expect(await readFile(join(cwd, 'shared.txt'), 'utf8')).toBe('base\n')
  })
})
