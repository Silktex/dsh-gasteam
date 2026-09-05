import { afterEach, expect, it } from 'vitest'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { execa } from 'execa'
import { ExternalCodeWorktreeProvider } from '../src/external-code-worktree.ts'
import { gitFixture } from './git-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('persists an exact external worktree intent before provisioning and restores only its bound checkout', async () => {
  const fixture = await gitFixture(root => roots.push(root))
  const provider = new ExternalCodeWorktreeProvider()
  const intent = { attemptId: 'attempt-1', generation: 1, runtimeId: 'runtime-1', repository: fixture.repository, directory: join(fixture.root, 'external') }
  const first = await provider.ensure(intent)
  expect(first).toMatchObject({ repository: fixture.repository, cwd: join(fixture.root, 'external', 'attempt-1'), branch: 'dsh-external/runtime-1' })
  expect((await execa('git', ['-C', fixture.repository, 'worktree', 'list', '--porcelain'])).stdout).toContain(`worktree ${first.cwd}`)
  const receipt = join(intent.directory, `${intent.attemptId}.code-worktree.json`)
  expect(JSON.parse(await readFile(receipt, 'utf8'))).toMatchObject(first)
  expect(JSON.parse(await readFile(join(intent.directory, `${intent.attemptId}.code-worktree.complete.json`), 'utf8'))).toMatchObject({ proof: 'git-worktree-add-closed-v1', receipt: first })
  await expect(provider.restore(intent)).resolves.toEqual(first)
  await writeFile(receipt, JSON.stringify({ ...first, directory: intent.directory, runtimeId: 'other-runtime' }))
  await expect(provider.restore(intent)).rejects.toThrow(/does not bind/i)
})

it('keeps an intent-only pre-provision receipt fenced across a fresh provider', async () => {
  const fixture = await gitFixture(root => roots.push(root))
  const provider = new ExternalCodeWorktreeProvider()
  const intent = { attemptId: 'attempt-2', generation: 1, runtimeId: 'runtime-2', repository: fixture.repository, directory: join(fixture.root, 'external') }
  const baseCommit = (await execa('git', ['-C', fixture.repository, 'rev-parse', '--verify', 'HEAD^{commit}'])).stdout
  const commonDirectory = (await execa('git', ['-C', fixture.repository, 'rev-parse', '--git-common-dir'])).stdout
  const receipt = { ...intent, commonDirectory: join(fixture.repository, commonDirectory), cwd: join(intent.directory, intent.attemptId), branch: `dsh-external/${intent.runtimeId}`, baseCommit }
  await mkdir(intent.directory, { recursive: true })
  await writeFile(join(intent.directory, `${intent.attemptId}.code-worktree.json`), JSON.stringify(receipt))
  await expect(provider.ensure(intent)).rejects.toThrow(/no completed Git close proof/i)
  await expect(new ExternalCodeWorktreeProvider().restore(intent)).rejects.toThrow(/no completed Git close proof/i)
  await writeFile(join(intent.directory, `${intent.attemptId}.code-worktree.json`), JSON.stringify({ ...receipt, cwd: join(fixture.root, 'foreign-checkout') }))
  await expect(provider.restore(intent)).rejects.toThrow(/no completed Git close proof/i)
  await writeFile(join(intent.directory, `${intent.attemptId}.code-worktree.json`), '{}')
  await expect(provider.restore(intent)).rejects.toThrow(/invalid/i)
})

it('rejects a lexical worktree parent that resolves through a symlink into the repository', async () => {
  const fixture = await gitFixture(root => roots.push(root))
  const linked = join(fixture.root, 'linked-repository')
  await symlink(fixture.repository, linked)
  await expect(new ExternalCodeWorktreeProvider().ensure({ attemptId: 'attempt-3', generation: 1, runtimeId: 'runtime-3', repository: fixture.repository, directory: join(linked, 'external') })).rejects.toThrow(/outside its canonical repository/i)
})

it('never adopts a matching checkout that predates its completed provision receipt', async () => {
  const fixture = await gitFixture(root => roots.push(root))
  const intent = { attemptId: 'attempt-existing', generation: 1, runtimeId: 'runtime-existing', repository: fixture.repository, directory: join(fixture.root, 'external') }
  const cwd = join(intent.directory, intent.attemptId)
  await mkdir(intent.directory, { recursive: true })
  await execa('git', ['-C', fixture.repository, 'worktree', 'add', '-b', `dsh-external/${intent.runtimeId}`, '--', cwd, 'HEAD'])
  await expect(new ExternalCodeWorktreeProvider().ensure(intent)).rejects.toThrow(/exists before this provision has completed/i)
  await expect(readFile(join(intent.directory, `${intent.attemptId}.code-worktree.complete.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('fences repeat provisioning until inherited Git pipes close after bounded-output cancellation', async () => {
  const fixture = await gitFixture(root => roots.push(root))
  const executable = join(fixture.root, 'git')
  const closed = join(fixture.root, 'git-descendant-closed')
  const release = join(fixture.root, 'git-descendant-release')
  const adds = join(fixture.root, 'git-worktree-add-count')
  const body = [
    '#!/usr/bin/env node',
    "import { spawn } from 'node:child_process'",
    "import { appendFileSync } from 'node:fs'",
    "const args = process.argv.slice(2)",
    "if (!(args[0] === 'worktree' && args[1] === 'add')) { const child = spawn(process.env.REAL_GIT, args, { stdio: 'inherit' }); child.on('close', code => process.exit(code ?? 1)); } else {",
    "  appendFileSync(process.env.GIT_ADD_COUNT, 'add\\n')",
    "  spawn(process.execPath, ['-e', \"const fs=require('node:fs'); const t=setInterval(()=>{if(process.ppid===1&&fs.existsSync(process.env.GIT_RELEASE_FILE)){fs.writeFileSync(process.env.GIT_CLOSE_FILE,'closed');clearInterval(t)}},5)\"], { stdio: 'inherit' })",
    "  process.stdout.write('x'.repeat(1_100_000))",
    "  setInterval(() => {}, 1_000)",
    '}',
  ].join('\n')
  await writeFile(executable, body)
  await chmod(executable, 0o755)
  const originalPath = process.env.PATH
  const realGit = (await execa('which', ['git'])).stdout
  process.env.PATH = `${fixture.root}:${originalPath ?? ''}`
  process.env.GIT_CLOSE_FILE = closed
  process.env.GIT_RELEASE_FILE = release
  process.env.GIT_ADD_COUNT = adds
  process.env.REAL_GIT = realGit
  try {
    const provider = new ExternalCodeWorktreeProvider()
    const intent = { attemptId: 'attempt-4', generation: 1, runtimeId: 'runtime-4', repository: fixture.repository, directory: join(fixture.root, 'external') }
    await expect(provider.ensure(intent)).rejects.toThrow(/bounded output/i)
    await expect(provider.ensure(intent)).rejects.toThrow(/still active with unproven close/i)
    await expect(readFile(adds, 'utf8')).resolves.toBe('add\n')
    await writeFile(release, 'release')
    await expect.poll(async () => await readFile(closed, 'utf8').catch(() => undefined), { timeout: 2_000 }).toBe('closed')
  } finally {
    process.env.PATH = originalPath
    delete process.env.GIT_CLOSE_FILE
    delete process.env.GIT_RELEASE_FILE
    delete process.env.GIT_ADD_COUNT
    delete process.env.REAL_GIT
  }
})

it('a fresh host blocks an intent whose crashed provisioner may still own Git', async () => {
  const fixture = await gitFixture(root => roots.push(root))
  const executable = join(fixture.root, 'git')
  const started = join(fixture.root, 'git-add-started')
  const stopped = join(fixture.root, 'git-add-stopped')
  const release = join(fixture.root, 'git-add-release')
  const adds = join(fixture.root, 'git-add-count')
  const body = [
    '#!/usr/bin/env node',
    "import { spawn } from 'node:child_process'",
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "if (!(args[0] === 'worktree' && args[1] === 'add')) { const child = spawn(process.env.REAL_GIT, args, { stdio: 'inherit' }); child.on('close', code => process.exit(code ?? 1)); } else {",
    "  appendFileSync(process.env.GIT_ADD_COUNT, 'add\\n'); writeFileSync(process.env.GIT_STARTED_FILE, 'started')",
    "  const timer = setInterval(() => { if (existsSync(process.env.GIT_RELEASE_FILE)) { writeFileSync(process.env.GIT_STOPPED_FILE, 'stopped'); clearInterval(timer); process.exit(0) } }, 5)",
    '}',
  ].join('\n')
  await writeFile(executable, body)
  await chmod(executable, 0o755)
  const intent = { attemptId: 'attempt-5', generation: 1, runtimeId: 'runtime-5', repository: fixture.repository, directory: join(fixture.root, 'external') }
  const module = new URL('../src/external-code-worktree.ts', import.meta.url).href
  const provisioner = join(fixture.root, 'provisioner.mjs')
  const recovery = join(fixture.root, 'recovery.mjs')
  await writeFile(provisioner, `import { ExternalCodeWorktreeProvider } from ${JSON.stringify(module)}; await new ExternalCodeWorktreeProvider().ensure(JSON.parse(process.env.WORKTREE_INTENT));`)
  await writeFile(recovery, `import { ExternalCodeWorktreeProvider } from ${JSON.stringify(module)}; try { await new ExternalCodeWorktreeProvider().ensure(JSON.parse(process.env.WORKTREE_INTENT)); process.exit(2) } catch (error) { if (!/no completed Git close proof/.test(String(error))) throw error }`)
  const originalPath = process.env.PATH
  const environment = { ...process.env, PATH: `${fixture.root}:${originalPath ?? ''}`, REAL_GIT: (await execa('which', ['git'])).stdout, WORKTREE_INTENT: JSON.stringify(intent), GIT_STARTED_FILE: started, GIT_STOPPED_FILE: stopped, GIT_RELEASE_FILE: release, GIT_ADD_COUNT: adds }
  const client = spawn(process.execPath, ['--import', 'tsx', provisioner], { cwd: process.cwd(), env: environment, stdio: 'ignore' })
  try {
    await expect.poll(async () => await readFile(started, 'utf8').catch(() => undefined), { timeout: 2_000 }).toBe('started')
    client.kill('SIGKILL')
    await new Promise<void>(resolveClient => client.once('close', () => resolveClient()))
    const recovered = await execa(process.execPath, ['--import', 'tsx', recovery], { cwd: process.cwd(), env: environment, reject: false })
    expect(recovered.exitCode).toBe(0)
    await expect(readFile(adds, 'utf8')).resolves.toBe('add\n')
    await writeFile(release, 'release')
    await expect.poll(async () => await readFile(stopped, 'utf8').catch(() => undefined), { timeout: 2_000 }).toBe('stopped')
  } finally {
    await writeFile(release, 'release').catch(() => undefined)
  }
})
