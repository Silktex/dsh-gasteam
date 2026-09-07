import { appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import z from 'zod'
import { DurableJournal } from '../../src/durable-journal.ts'
import { acquireFileOwnership } from '../../src/file-ownership.ts'
import { ensureFactoryDirectory } from '../../src/darkfactory/paths.ts'
import { digestBytes, parseStrictJson } from '../../src/darkfactory/json.ts'
import { migrateFactoryJournal, openFactoryJournalLocation } from '../../src/darkfactory/journal-migration.ts'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const eventSchema = z.strictObject({ version: z.literal(1), sequence: z.number().int().positive(), kind: z.literal('value'), value: z.string().max(100) })
type Event = z.output<typeof eventSchema>
const reducer = (state: string[], raw: unknown) => [...state, eventSchema.parse(raw).value]
const maxBytes = 65536
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'factory-layout-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'journal.jsonl')
  const bytes = Buffer.from([1, 2].map(sequence => JSON.stringify({ version: 1, sequence, kind: 'value', value: `value-${sequence}` })).join('\n') + '\n')
  await writeFile(filename, bytes)
  return { directory, filename, bytes }
}
async function validate(filename: string): Promise<void> {
  const journal = await DurableJournal.open<string[], Event>(filename, [], reducer, parseStrictJson, { noFollow: true, maxRecordBytes: 1024 })
  try { expect(journal.snapshot()).toEqual(['value-1', 'value-2']) } finally { await journal.close() }
}
async function owner(filename: string, limit = maxBytes) {
  const location = await openFactoryJournalLocation(filename, limit)
  const journal = await DurableJournal.openOwned<string[], Event>(location.file, location.filename, [], reducer, parseStrictJson, { maxRecordBytes: 1024 }, location.close)
  cleanups.push(() => journal.close())
  return journal
}

describe('offline versioned journal layout migration', () => {
  it('preserves exact backup bytes and anchor inode, validates twice, and appends only to layout2', async () => {
    const { filename, bytes } = await fixture(), originalInode = (await stat(filename)).ino
    const validated: string[] = []
    const migrated = await migrateFactoryJournal(filename, { migrationId: 'fixture-1', maxBytes, validate: async filename => { validated.push(filename); await validate(filename) } })
    expect(validated.map(filename => filename.split('/').at(-1))).toEqual(['legacy-backup.jsonl', 'journal.jsonl'])
    expect(migrated).toMatchObject({ storageLayout: 2, migrationId: 'fixture-1', legacyBytes: bytes.length, legacyDigest: digestBytes(bytes) })
    expect((await stat(filename)).ino).toBe(originalInode)
    expect(await readFile(migrated.backup)).toEqual(bytes)
    expect(await readFile(migrated.target)).toEqual(bytes)
    const marker = await readFile(filename)
    expect(JSON.parse(marker.toString())).toMatchObject({ version: 2, layout: 'darkfactory-journal-layout/v2', legacyDigest: digestBytes(bytes) })
    expect(await readFile(`${filename}.layout2.pending`)).toEqual(marker)
    expect(await readFile(`${filename}.layout2.commit`)).toEqual(marker)
    const journal = await owner(filename)
    expect(journal.snapshot()).toEqual(['value-1', 'value-2'])
    await journal.append((_state, sequence) => ({ version: 1, sequence, kind: 'value', value: 'after-migration' }))
    await journal.close()
    expect(await readFile(filename)).toEqual(marker)
    expect(await readFile(migrated.backup)).toEqual(bytes)
    expect((await readFile(migrated.target, 'utf8')).startsWith(bytes.toString())).toBe(true)
    expect((await owner(filename)).snapshot()).toEqual(['value-1', 'value-2', 'after-migration'])
  })

  it('fences stale legacy descriptors and legacy binaries after the guard, without changing backup bytes', async () => {
    const { filename, bytes } = await fixture()
    const stale = await open(filename, 'a+')
    cleanups.push(() => stale.close())
    const migrated = await migrateFactoryJournal(filename, { migrationId: 'old-binary', maxBytes, validate })
    await acquireFileOwnership(stale)
    const current = await stale.readFile('utf8')
    expect(JSON.parse(current).version).toBe(2)
    await stale.close()
    await expect(DurableJournal.open<string[], Event>(filename, [], reducer, parseStrictJson)).rejects.toThrow(/Invalid catalog\/journal/)
    expect(await readFile(migrated.backup)).toEqual(bytes)
  })

  it('owns both legacy and migrated anchor/target locations and rejects migration while a writer is open', async () => {
    const { filename, directory, bytes } = await fixture()
    const legacy = await owner(filename)
    await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow()
    await expect(migrateFactoryJournal(filename, { migrationId: 'contender', maxBytes, validate })).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['journal.jsonl'])
    expect(await readFile(filename)).toEqual(bytes)
    await legacy.close()
    const migrated = await migrateFactoryJournal(filename, { migrationId: 'owner', maxBytes, validate })
    const journal = await owner(filename)
    await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow()
    await expect(DurableJournal.open(migrated.target, [], reducer, parseStrictJson)).rejects.toThrow(/owned/)
    await journal.close()
    expect((await owner(filename)).snapshot()).toEqual(['value-1', 'value-2'])
  })

  it.each([1, 2])('leaves an explicit fail-closed pending migration if validation %s fails', async failAt => {
    const { filename, directory, bytes } = await fixture()
    let calls = 0
    await expect(migrateFactoryJournal(filename, { migrationId: 'interrupted', maxBytes, validate: async path => {
      await validate(path)
      if (++calls === failAt) throw new Error('sensitive-validator-detail')
    } })).rejects.toThrow('Invalid factory journal layout is unsafe or incomplete; explicit validated recovery required')
    expect(await readFile(filename)).toEqual(bytes)
    expect(await readFile(join(directory, 'journal.jsonl.layout2-interrupted/legacy-backup.jsonl'))).toEqual(bytes)
    await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow(/incomplete/)
    await expect(migrateFactoryJournal(filename, { migrationId: 'retry-is-not-repair', maxBytes, validate })).rejects.toThrow(/incomplete/)
    expect((await readdir(directory)).some(name => name.endsWith('.commit'))).toBe(false)
  })

  it('rejects source mutation during validation before poisoning the anchor', async () => {
    const { filename, directory, bytes } = await fixture()
    let count = 0
    await expect(migrateFactoryJournal(filename, { migrationId: 'source-change', maxBytes, validate: async path => {
      await validate(path)
      if (++count === 2) await appendFile(filename, 'concurrent-uncooperative-write')
    } })).rejects.toThrow(/incomplete/)
    expect((await readFile(filename, 'utf8')).startsWith(bytes.toString())).toBe(true)
    expect(await readFile(join(directory, 'journal.jsonl.layout2-source-change/legacy-backup.jsonl'))).toEqual(bytes)
    await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow()
  })

  it('rejects a validator that changed the copied backup or target', async () => {
    for (const failAt of [1, 2]) {
      const { filename, bytes } = await fixture()
      let count = 0
      await expect(migrateFactoryJournal(filename, { migrationId: 'copy-change', maxBytes, validate: async path => {
        await validate(path)
        if (++count === failAt) await appendFile(path, 'modified-copy')
      } })).rejects.toThrow(/incomplete/)
      expect(await readFile(filename)).toEqual(bytes)
      await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow()
    }
  })

  it('rejects incomplete commit, corrupt backup, and rewritten target prefix while preserving every byte', async () => {
    for (const kind of ['commit', 'backup', 'target'] as const) {
      const { filename } = await fixture()
      const migrated = await migrateFactoryJournal(filename, { migrationId: kind, maxBytes, validate })
      if (kind === 'commit') await rm(`${filename}.layout2.commit`)
      else {
        const target = kind === 'backup' ? migrated.backup : migrated.target
        await chmod(target, 0o600); await writeFile(target, 'corrupt-preserve-this')
      }
      const anchor = await readFile(filename), backup = await readFile(migrated.backup), target = await readFile(migrated.target)
      await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow(/incomplete/)
      expect(await readFile(filename)).toEqual(anchor)
      expect(await readFile(migrated.backup)).toEqual(backup)
      expect(await readFile(migrated.target)).toEqual(target)
    }
  })

  it.each(['anchor', 'layout', 'backup', 'target', 'commit'])('rejects a %s symlink without touching the outside target', async kind => {
    const { filename, directory, bytes } = await fixture(), outside = join(directory, 'outside')
    await writeFile(outside, bytes)
    if (kind === 'anchor') {
      await rm(filename); await symlink(outside, filename)
      await expect(migrateFactoryJournal(filename, { migrationId: 'symlink', maxBytes, validate })).rejects.toThrow()
      await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow()
    } else {
      const migrated = await migrateFactoryJournal(filename, { migrationId: 'symlink', maxBytes, validate })
      const target = kind === 'layout' ? join(directory, migrated.directory) : kind === 'backup' ? migrated.backup : kind === 'target' ? migrated.target : `${filename}.layout2.commit`
      await rm(target, { recursive: true, force: true }); await symlink(kind === 'layout' ? directory : outside, target)
      await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow()
    }
    expect(await readFile(outside)).toEqual(bytes)
  })

  it('supports pinned descriptor paths and small native limits, and refuses oversized or invalid migration input', async () => {
    const { directory } = await fixture(), partition = await ensureFactoryDirectory(directory, 'project')
    try {
      const filename = join(partition.descriptorPath, 'empty.jsonl')
      const empty = await openFactoryJournalLocation(filename, 1)
      await empty.close()
      const migrated = await migrateFactoryJournal(filename, { migrationId: 'empty', maxBytes: 1, validate: async path => { expect(await readFile(path, 'utf8')).toBe('') } })
      expect(migrated.legacyBytes).toBe(0)
      const location = await openFactoryJournalLocation(filename, 1); await location.close()
      await expect(migrateFactoryJournal(filename, { migrationId: 'unsafe:id', maxBytes, validate })).rejects.toThrow()
      await expect(migrateFactoryJournal(filename, { migrationId: 'unsafe', maxBytes: Number.MAX_SAFE_INTEGER, validate })).rejects.toThrow()
      const tooLarge = join(partition.descriptorPath, 'oversized.jsonl')
      await writeFile(tooLarge, 'x'.repeat(2048))
      await expect(openFactoryJournalLocation(tooLarge, 1024)).rejects.toThrow()
      await expect(migrateFactoryJournal(tooLarge, { migrationId: 'limit', maxBytes: 1024, validate })).rejects.toThrow()
      const legacy = await openFactoryJournalLocation(join(partition.descriptorPath, 'new.jsonl'), Number.MAX_SAFE_INTEGER); await legacy.close()
    } finally { await partition.close() }
  })

  it('fails closed if the backup layout cannot be created and rejects unknown/partial markers', async () => {
    const { filename, directory, bytes } = await fixture()
    await mkdir(join(directory, 'journal.jsonl.layout2-blocked'))
    await expect(migrateFactoryJournal(filename, { migrationId: 'blocked', maxBytes, validate })).rejects.toThrow()
    expect(await readFile(filename)).toEqual(bytes)
    await expect(openFactoryJournalLocation(filename, maxBytes)).rejects.toThrow()
    for (const invalid of ['{"version":3}\n', '{"version":2', '{"version":2}\n']) {
      const fixtureFile = await fixture()
      await writeFile(fixtureFile.filename, invalid)
      await expect(openFactoryJournalLocation(fixtureFile.filename, maxBytes)).rejects.toThrow()
      expect(await readFile(fixtureFile.filename, 'utf8')).toBe(invalid)
    }
  })
})
