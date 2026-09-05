import { afterEach, expect, it } from 'vitest'
import { rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { gitFixture } from './git-fixture.ts'
import { acquireIntegrationOwnership } from '../src/integration-ownership.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const signal = new AbortController().signal
it('shares exclusion across repository aliases and linked worktrees while separating targets', async () => {
  const fixture = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const alias = join(fixture.root, 'alias')
  const linked = join(fixture.root, 'linked')
  await symlink(fixture.repository, alias)
  await fixture.git('worktree', 'add', '-b', 'worker', linked)
  const release = await acquireIntegrationOwnership(fixture.repository, 'main', signal)
  cleanup.push(release)
  for (const path of [alias, linked]) await expect(acquireIntegrationOwnership(path, 'main', signal)).rejects.toMatchObject({ code: 'TEAM_INTEGRATION_BUSY' })
  const other = await acquireIntegrationOwnership(linked, 'other-target', signal)
  cleanup.push(other)
  await release()
  cleanup.push(await acquireIntegrationOwnership(alias, 'main', signal))
})
it('refuses aborted acquisition and does not leave ownership behind', async () => {
  const fixture = await gitFixture(root => cleanup.push(() => rm(root, { recursive: true, force: true })))
  const controller = new AbortController()
  controller.abort(new Error('cancelled acquisition'))
  await expect(acquireIntegrationOwnership(fixture.repository, 'main', controller.signal)).rejects.toThrow('cancelled acquisition')
  cleanup.push(await acquireIntegrationOwnership(fixture.repository, 'main', signal))
})
