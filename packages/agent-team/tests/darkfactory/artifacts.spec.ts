import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DarkFactoryArtifactStore } from '../../src/darkfactory/artifacts.ts'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive:true,force:true}))) })
it('shares serialized capacity, verifies reads, and rejects tampered or redirected references', async () => {
  const directory = await mkdtemp(join(tmpdir(),'factory-artifacts-')); directories.push(directory)
  const store = await DarkFactoryArtifactStore.open(directory,['project'],100,100)
  const [first, duplicate] = await Promise.all([store.persist('project',{ value: 1 }),store.persist('project',{ value: 1 })])
  expect(first).toEqual(duplicate)
  expect(await store.read(first)).toEqual({value:1})
  await expect(store.read({...first,projectId:'other'})).rejects.toThrow('Invalid artifact reference')
  await expect(store.persist('other',{})).rejects.toThrow('not registered')
  const filename = join(directory,'darkfactory','project','artifacts',first.id)
  await writeFile(filename,'{"value":2}')
  await expect(store.read(first)).rejects.toThrow('digest mismatch')
  await unlink(filename)
  await symlink('/dev/zero',filename)
  await expect(store.read(first)).rejects.toThrow()
})
