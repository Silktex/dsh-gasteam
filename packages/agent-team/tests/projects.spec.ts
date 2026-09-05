import { afterEach, expect, it } from 'vitest'
import { appendFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectCatalog } from '../src/projects.ts'
import { gitFixture } from './git-fixture.ts'

const roots: string[] = []
const catalogs: ProjectCatalog[] = []
afterEach(async () => {
  for (const catalog of catalogs.splice(0)) await catalog.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const git = await gitFixture(root => roots.push(root))
  const directory = join(git.root, 'catalog')
  const catalog = await ProjectCatalog.open(directory)
  catalogs.push(catalog)
  const request = {
    id: 'compiler', repository: git.repository, targetBranch: 'main', teamIds: ['compiler-team'], capacity: 2,
    verification: { revision: 1, commands: [{ command: 'node', args: ['--version'] }] },
  }
  return { ...git, directory, catalog, request }
}

it('durably registers policy and team lookup independent of any live Agent', async () => {
  const { catalog, request, directory } = await fixture()
  const registered = await catalog.register(request)
  expect(registered).toMatchObject({ ...request, revision: 1 })
  await catalog.close()
  const restored = await ProjectCatalog.open(directory)
  catalogs.push(restored)
  expect(restored.list()).toEqual([registered])
  expect(JSON.parse((await readFile(join(directory, 'projects.jsonl'), 'utf8')).trim()))
    .toMatchObject({ version: 1, sequence: 1, type: 'project/registered', project: registered })
})

it('canonicalizes symlinks and linked worktrees to one repository/target owner', async () => {
  const { catalog, request, root, git } = await fixture()
  const alias = join(root, 'alias')
  await symlink(request.repository, alias)
  await catalog.register({ ...request, repository: alias })
  const worktree = join(root, 'linked')
  await git('worktree', 'add', '-b', 'worker', worktree)
  await expect(catalog.register({ ...request, id: 'other', teamIds: ['other-team'], repository: worktree }))
    .rejects.toThrow(/repository.*target.*registered/i)
  expect(catalog.list()).toHaveLength(1)
})

it('rejects reused project or team identities and serializes racing registrations', async () => {
  const { catalog, request } = await fixture()
  const results = await Promise.allSettled([catalog.register(request), catalog.register(request)])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  await expect(catalog.register({ ...request, id: 'other', targetBranch: 'other' })).rejects.toThrow(/team.*registered/i)
  expect(catalog.list()).toHaveLength(1)
})

it('rejects malformed policy and nonexistent branches without accepting a project', async () => {
  const { catalog, request } = await fixture()
  for (const patch of [
    { id: '../escape' }, { capacity: 0 }, { capacity: 1.5 }, { teamIds: [] }, { teamIds: ['a', 'a'] },
    { verification: { revision: 1, commands: [] } }, { targetBranch: '--help' }, { targetBranch: 'absent' },
  ]) await expect(catalog.register({ ...request, ...patch })).rejects.toThrow()
  expect(catalog.list()).toEqual([])
})

it('returns detached records so callers cannot change durable policy in memory', async () => {
  const { catalog, request } = await fixture()
  const registered = await catalog.register(request) as typeof request
  registered.teamIds.push('injected')
  const list = catalog.list() as (typeof request)[]
  list[0]!.verification.commands[0]!.args.push('injected')
  expect(catalog.list()).toEqual([expect.objectContaining({ teamIds: ['compiler-team'], verification: request.verification })])
})

it('rejects corrupt or unsupported durable data with an actionable error', async () => {
  const { catalog, request, directory } = await fixture()
  await catalog.register(request)
  await catalog.close()
  await appendFile(join(directory, 'projects.jsonl'), '{"version":99}\n')
  await expect(ProjectCatalog.open(directory)).rejects.toThrow(/catalog.*line 2.*restore.*backup/i)
})
