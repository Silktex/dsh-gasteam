import { afterEach, describe, expect, it } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamIntegrationId, TeamVerificationCommand } from '../src/types.ts'
import { GitIntegrationProvider } from '../src/git-integration-provider.ts'
import { gitFixture } from './git-fixture.ts'

const roots: string[] = []
const signal = new AbortController().signal
const verifiesOutput = { command: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('shared.txt','utf8')!=='worker\\n')process.exit(1)"] }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(verification: TeamVerificationCommand[] = [verifiesOutput]) {
  const fixture = await gitFixture((root) => { roots.push(root) })
  const memberId = SessionId('worker')
  const worktree = await fixture.provider.resolve(fixture.repository, memberId, signal)
  await fixture.provider.provision(worktree, signal)
  await writeFile(join(worktree.cwd, 'shared.txt'), 'worker\n')
  await execa('git', ['-C', worktree.cwd, 'commit', '-am', 'worker'])
  const provider = new GitIntegrationProvider({
    providerName: 'git', targetBranch: 'main', verification, commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000,
  })
  const spec = await provider.resolve({ ...worktree, memberId, provider: 'git', phase: 'ready' }, 'job-1' as TeamIntegrationId, signal)
  return { ...fixture, worktree, provider, spec }
}

describe('verified Git Team integration', () => {
  it('verifies an ordered stack of immutable source commits in one isolated candidate', async () => {
    const fixture = await gitFixture((root) => { roots.push(root) })
    const provider = new GitIntegrationProvider({
      providerName: 'git', targetBranch: 'main', verification: [{ command: process.execPath, args: ['-e', "const fs=require('node:fs');if(!fs.existsSync('first.txt')||!fs.existsSync('second.txt'))process.exit(1)"] }],
      commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000,
    })
    const source = async (name: string, file: string) => {
      const memberId = SessionId(name)
      const worktree = await fixture.provider.resolve(fixture.repository, memberId, signal)
      await fixture.provider.provision(worktree, signal)
      await writeFile(join(worktree.cwd, file), `${name}\n`)
      await execa('git', ['-C', worktree.cwd, 'add', file])
      await execa('git', ['-C', worktree.cwd, 'commit', '-m', name])
      return await provider.resolve({ ...worktree, memberId, provider: 'git', phase: 'ready' }, `${name}-job` as TeamIntegrationId, signal)
    }
    const first = await source('first', 'first.txt')
    const second = await source('second', 'second.txt')
    const target = await provider.target(first, signal)
    const candidate = await provider.verifyStack([first, second], target, join(fixture.repository, '..', 'integration-stack'), signal)
    await provider.promote(first, target, candidate, signal)
    expect(await readFile(join(fixture.repository, 'first.txt'), 'utf8')).toBe('first\n')
    expect(await readFile(join(fixture.repository, 'second.txt'), 'utf8')).toBe('second\n')
  })

  it('verifies the pinned worker commit separately and recognizes a previously promoted candidate', async () => {
    const { repository, worktree, provider, spec, git } = await setup()
    const target = await provider.target(spec, signal)
    await writeFile(join(worktree.cwd, 'shared.txt'), 'later\n')
    await execa('git', ['-C', worktree.cwd, 'commit', '-am', 'later'])
    const candidate = await provider.verify(spec, target, signal)
    expect(await readFile(join(repository, 'shared.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(join(spec.cwd, 'shared.txt'), 'utf8')).toBe('worker\n')
    await provider.promote(spec, target, candidate, signal)
    await provider.promote(spec, target, candidate, signal)
    expect((await git('rev-parse', 'HEAD')).stdout).toBe(candidate)
    expect(await readFile(join(worktree.cwd, 'shared.txt'), 'utf8')).toBe('later\n')
  })

  it('retains a failed verification checkout and leaves the target untouched', async () => {
    const { repository, provider, spec, git } = await setup([{ command: process.execPath, args: ['-e', 'process.exit(7)'] }])
    const target = await provider.target(spec, signal)
    await expect(provider.verify(spec, target, signal)).rejects.toThrow()
    expect((await git('rev-parse', 'HEAD')).stdout).toBe(target)
    expect(await readFile(join(repository, 'shared.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(join(spec.cwd, 'shared.txt'), 'utf8')).toBe('worker\n')
  })

  it('rejects verification that modifies tracked output', async () => {
    const { provider, spec } = await setup([{ command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('shared.txt','modified')"] }])
    await expect(provider.verify(spec, await provider.target(spec, signal), signal)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_DIRTY' })
  })

  it('preserves dirty Lead edits and refuses a target that advanced after verification', async () => {
    const { repository, provider, spec, git } = await setup()
    const target = await provider.target(spec, signal)
    const candidate = await provider.verify(spec, target, signal)
    await writeFile(join(repository, 'shared.txt'), 'lead\n')
    await expect(provider.promote(spec, target, candidate, signal)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_DIRTY' })
    await git('commit', '-am', 'lead')
    await expect(provider.promote(spec, target, candidate, signal)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_STALE' })
    expect(await readFile(join(repository, 'shared.txt'), 'utf8')).toBe('lead\n')
  })

  it('retains merge conflicts in the candidate without changing the Lead checkout', async () => {
    const { repository, provider, spec, git } = await setup()
    await writeFile(join(repository, 'shared.txt'), 'lead\n')
    await git('commit', '-am', 'lead')
    const target = await provider.target(spec, signal)
    await expect(provider.verify(spec, target, signal)).rejects.toThrow()
    expect(await readFile(join(repository, 'shared.txt'), 'utf8')).toBe('lead\n')
    expect(await readFile(join(spec.cwd, 'shared.txt'), 'utf8')).toContain('<<<<<<<')
  })
})
