import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSecret } from '../../src/darkfactory/secrets.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'df-secrets-'))
  directories.push(directory)
  const path = join(directory, 'key')
  await writeFile(path, 'file-secret\n', { mode: 0o600 })
  return { directory, path }
}
describe('host-only secret resolution', () => {
  it('resolves environment references preserving exact bytes', async () => {
    expect(await resolveSecret({ kind: 'env', name: 'DF_KEY' }, { env: { DF_KEY: ' secret\n' } })).toBe(' secret\n')
    for (const value of [undefined, '', ' ', 'a\0b', '\ud800']) await expect(resolveSecret({ kind: 'env', name: 'DF_KEY' }, { env: { DF_KEY: value } })).rejects.toThrow('unavailable or unsafe')
  })
  it('reads only bounded owner-readable private files and redacts failures', async () => {
    const { path } = await fixture()
    expect(await resolveSecret({ kind: 'file', path })).toBe('file-secret\n')
    await expect(resolveSecret({ kind: 'file', path }, { maxBytes: 3 })).rejects.toThrow('unavailable or unsafe')
    for (const mode of [0o640, 0o604, 0o200]) {
      await chmod(path, mode)
      await expect(resolveSecret({ kind: 'file', path })).rejects.toThrow('unavailable or unsafe')
    }
    await expect(resolveSecret({ kind: 'file', path: '/missing-sensitive-secret' })).rejects.toThrow(/^Dark Factory secret unavailable or unsafe$/)
  })
  it('rejects symlink files, symlink parents, directories and malformed UTF-8', async () => {
    const { directory, path } = await fixture()
    const link = join(directory, 'link')
    await symlink(path, link)
    await expect(resolveSecret({ kind: 'file', path: link })).rejects.toThrow('unavailable or unsafe')
    const nested = join(directory, 'nested')
    await mkdir(nested)
    await writeFile(join(nested, 'key'), 'secret', { mode: 0o600 })
    await symlink(nested, join(directory, 'parent-link'))
    await expect(resolveSecret({ kind: 'file', path: join(directory, 'parent-link', 'key') })).rejects.toThrow('unavailable or unsafe')
    await expect(resolveSecret({ kind: 'file', path: directory })).rejects.toThrow('unavailable or unsafe')
    await writeFile(path, Buffer.from([0xff]))
    await expect(resolveSecret({ kind: 'file', path })).rejects.toThrow('unavailable or unsafe')
  })
})
