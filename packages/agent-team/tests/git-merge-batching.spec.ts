import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execa } from 'execa'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamIntegrationId } from '../src/types.ts'
import { GitIntegrationProvider } from '../src/git-integration-provider.ts'
import { GitMergeBatch } from '../src/git-merge-batching.ts'
import { gitFixture } from './git-fixture.ts'

const roots: string[] = []
const signal = new AbortController().signal
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup(check: string) {
  const fixture = await gitFixture(root => { roots.push(root) })
  const directory = await mkdtemp(join(tmpdir(), 'gasteam-merge-batch-')); roots.push(directory)
  const provider = new GitIntegrationProvider({ providerName: 'git', targetBranch: 'main', verification: [{ command: process.execPath, args: ['-e', check] }], commandTimeoutMs: 30_000, verificationTimeoutMs: 30_000 })
  const submission = async (id: string, file: string, dependsOn: string[] = []) => {
    const memberId = SessionId(id)
    const worktree = await fixture.provider.resolve(fixture.repository, memberId, signal)
    await fixture.provider.provision(worktree, signal)
    await writeFile(join(worktree.cwd, file), `${id}\n`)
    await execa('git', ['-C', worktree.cwd, 'add', file])
    await execa('git', ['-C', worktree.cwd, 'commit', '-m', id])
    return { id, dependsOn, spec: await provider.resolve({ ...worktree, memberId, provider: 'git', phase: 'ready' }, id as TeamIntegrationId, signal) }
  }
  return { fixture, directory, provider, submission }
}

it('isolates one independent bad source and promotes the verified good source', async () => {
  const { fixture, directory, provider, submission } = await setup("if(require('node:fs').existsSync('bad.txt'))process.exit(7)")
  const good = await submission('good', 'good.txt')
  const bad = await submission('bad', 'bad.txt')
  const batch = await GitMergeBatch.create(directory, 'independent', [good, bad], { maxCandidates: 8, maxSplitAttempts: 8 })
  expect((await batch.run(provider, signal)).outcomes).toMatchObject({ good: { state: 'accepted' }, bad: { state: 'rejected' } })
  expect(await readFile(join(fixture.repository, 'good.txt'), 'utf8')).toBe('good\n')
  await expect(readFile(join(fixture.repository, 'bad.txt'), 'utf8')).rejects.toThrow()
  await batch.close()
})

it('holds a dependent source when its failed prerequisite is excluded', async () => {
  const { fixture, directory, provider, submission } = await setup("if(require('node:fs').existsSync('bad.txt'))process.exit(7)")
  const bad = await submission('bad', 'bad.txt')
  const dependent = await submission('dependent', 'dependent.txt', ['bad'])
  const batch = await GitMergeBatch.create(directory, 'dependency', [bad, dependent], { maxCandidates: 8, maxSplitAttempts: 8 })
  expect((await batch.run(provider, signal)).outcomes).toMatchObject({ bad: { state: 'rejected' }, dependent: { state: 'blocked' } })
  await expect(readFile(join(fixture.repository, 'dependent.txt'), 'utf8')).rejects.toThrow()
  await batch.close()
})

it('lands an ordered dependent pair when its prerequisite is in the selected stack', async () => {
  const { fixture, directory, provider, submission } = await setup("const fs=require('node:fs');if(!fs.existsSync('base.txt')||!fs.existsSync('dependent.txt'))process.exit(7)")
  const base = await submission('base', 'base.txt')
  const dependent = await submission('dependent', 'dependent.txt', ['base'])
  const batch = await GitMergeBatch.create(directory, 'dependency-passes', [base, dependent], { maxCandidates: 8, maxSplitAttempts: 8 })
  expect((await batch.run(provider, signal)).outcomes).toMatchObject({ base: { state: 'accepted' }, dependent: { state: 'accepted' } })
  expect(await readFile(join(fixture.repository, 'base.txt'), 'utf8')).toBe('base\n')
  expect(await readFile(join(fixture.repository, 'dependent.txt'), 'utf8')).toBe('dependent\n')
  await batch.close()
})

it('blocks an asserted accepted prerequisite when the current target cannot prove it', async () => {
  const { directory, provider, submission } = await setup('process.exit(0)')
  const prerequisite = await submission('prerequisite', 'prerequisite.txt')
  const dependent = await submission('dependent', 'dependent.txt')
  const batch = await GitMergeBatch.create(directory, 'missing-accepted-prerequisite', [{ ...dependent,
    acceptedPrerequisites: [{ id: prerequisite.id, sourceCommit: prerequisite.spec.sourceCommit }],
  }], { maxCandidates: 8, maxSplitAttempts: 8 })
  expect((await batch.run(provider, signal)).outcomes).toMatchObject({ dependent: { state: 'blocked' } })
  await batch.close()
})

it('does not assume individually passing sources pass together', async () => {
  const { fixture, directory, provider, submission } = await setup("const fs=require('node:fs');if(fs.existsSync('one.txt')&&fs.existsSync('two.txt'))process.exit(7)")
  const one = await submission('one', 'one.txt')
  const two = await submission('two', 'two.txt')
  const batch = await GitMergeBatch.create(directory, 'combination', [one, two], { maxCandidates: 8, maxSplitAttempts: 8 })
  expect((await batch.run(provider, signal)).outcomes).toMatchObject({ one: { state: 'accepted' }, two: { state: 'rejected' } })
  expect(await readFile(join(fixture.repository, 'one.txt'), 'utf8')).toBe('one\n')
  await expect(readFile(join(fixture.repository, 'two.txt'), 'utf8')).rejects.toThrow()
  await batch.close()
})

it('invalidates an old candidate when the target moves before promotion', async () => {
  const { fixture, directory, provider, submission } = await setup('process.exit(0)')
  const good = await submission('good', 'good.txt')
  const batch = await GitMergeBatch.create(directory, 'moving-target', [good], { maxCandidates: 8, maxSplitAttempts: 8 })
  let moved = false
  const result = await batch.run(provider, signal, { beforePromotion: async () => {
    if (moved) return
    moved = true
    await writeFile(join(fixture.repository, 'target.txt'), 'advanced\n')
    await fixture.git('add', 'target.txt')
    await fixture.git('commit', '-m', 'advance target')
  } })
  expect(result.outcomes).toMatchObject({ good: { state: 'accepted' } })
  expect(result.attempts).toBe(2)
  expect(await readFile(join(fixture.repository, 'target.txt'), 'utf8')).toBe('advanced\n')
  expect(await readFile(join(fixture.repository, 'good.txt'), 'utf8')).toBe('good\n')
  await batch.close()
})

it('replays a prepared promotion after a crash without merging twice', async () => {
  const { fixture, directory, provider, submission } = await setup('process.exit(0)')
  const good = await submission('good', 'good.txt')
  const batch = await GitMergeBatch.create(directory, 'restart', [good], { maxCandidates: 8, maxSplitAttempts: 8 })
  await expect(batch.run(provider, signal, { afterPromotion: () => { throw new Error('crash after promotion') } })).rejects.toThrow('crash after promotion')
  await batch.close()
  const restored = await GitMergeBatch.open(directory, 'restart')
  expect((await restored.run(provider, signal)).outcomes).toMatchObject({ good: { state: 'accepted' } })
  expect(await readFile(join(fixture.repository, 'good.txt'), 'utf8')).toBe('good\n')
  expect(restored.inspect().promotedCandidates).toHaveLength(1)
  await restored.close()
})

it('lands a dependent after its good prerequisite was accepted in an earlier split', async () => {
  const { fixture, directory, provider, submission } = await setup("if(require('node:fs').existsSync('bad.txt'))process.exit(7)")
  const base = await submission('base', 'base.txt')
  const bad = await submission('bad', 'bad.txt')
  const dependent = await submission('dependent', 'dependent.txt', ['base'])
  const batch = await GitMergeBatch.create(directory, 'accepted-split-prerequisite', [base, bad, dependent], { maxCandidates: 8, maxSplitAttempts: 8 })
  expect((await batch.run(provider, signal)).outcomes).toMatchObject({ base: { state: 'accepted' }, bad: { state: 'rejected' }, dependent: { state: 'accepted' } })
  expect(await readFile(join(fixture.repository, 'base.txt'), 'utf8')).toBe('base\n')
  expect(await readFile(join(fixture.repository, 'dependent.txt'), 'utf8')).toBe('dependent\n')
  await expect(readFile(join(fixture.repository, 'bad.txt'), 'utf8')).rejects.toThrow()
  await batch.close()
})

it('releases journal ownership when reopening an empty journal or rejecting initial state', async () => {
  const { directory, submission } = await setup('process.exit(0)')
  await expect(GitMergeBatch.open(directory, 'empty')).rejects.toThrow(/no creation snapshot/)
  const good = await submission('good', 'good.txt')
  await expect(GitMergeBatch.create(directory, 'empty', [good], { maxCandidates: 65, maxSplitAttempts: 8 })).rejects.toThrow()
  const batch = await GitMergeBatch.create(directory, 'empty', [good], { maxCandidates: 8, maxSplitAttempts: 8 })
  await batch.close()
})
