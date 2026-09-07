/** Offline storage-layout migration; event schemas remain v1. No automatic repair or rollback. */
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import z from 'zod'
import { acquireFileOwnership } from '../file-ownership.ts'
import { openFactoryRoot } from './paths.ts'
import { canonicalJson, digestJson, parseStrictJson } from './json.ts'
import { digestSchema, idSchema } from './contracts/common.ts'

const maximumJournalBytes = 1_073_741_824, markerBytes = 4096, chunkBytes = 65_536
const limitsSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const migrationIdSchema = idSchema.max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
const guardSchema = z.strictObject({
  version: z.literal(2), layout: z.literal('darkfactory-journal-layout/v2'), migrationId: migrationIdSchema,
  anchor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.jsonl$/),
  directory: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,220}$/),
  legacyDigest: digestSchema, legacyBytes: z.number().int().min(0).max(maximumJournalBytes),
})
type Guard = z.output<typeof guardSchema>
export interface FactoryJournalLocation { filename: string; file: FileHandle; close(): Promise<void> }
export interface FactoryJournalMigrationOptions { migrationId: string; maxBytes: number; validate(filename: string): Promise<void> }
export interface FactoryJournalMigrationResult { storageLayout: 2; migrationId: string; legacyDigest: string; legacyBytes: number; directory: string; backup: string; target: string }
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const fileFlags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
function fail(): never { throw new Error('Invalid factory journal layout is unsafe or incomplete; explicit validated recovery required') }
function limit(raw: unknown): number { const parsed = limitsSchema.safeParse(raw); if (!parsed.success) fail(); return parsed.data }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error } }
async function parentFor(filename: string): Promise<{ directory: FileHandle; name: string; close(): Promise<void> }> {
  if (typeof filename !== 'string' || !isAbsolute(filename) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.jsonl$/.test(basename(filename))) fail()
  const name = basename(filename), parent = dirname(filename)
  if (/^\/proc\/self\/fd\/[0-9]+$/.test(parent)) {
    // The caller supplies a pinned FactoryDirectory. Duplicate it for this lease.
    const directory = await open(`${parent}/.`, directoryFlags)
    return { directory, name, close: () => directory.close() }
  }
  const root = await openFactoryRoot(parent)
  try {
    const directory = await open(`${root.descriptorPath}/.`, directoryFlags)
    return { directory, name, close: () => directory.close() }
  } finally { await root.close() }
}
function path(directory: FileHandle, name: string): string { return `/proc/self/fd/${directory.fd}/${name}` }
async function regular(file: FileHandle, filename: string): Promise<void> {
  const info = await file.stat(), entry = await lstat(filename)
  if (!info.isFile() || !entry.isFile() || entry.isSymbolicLink() || info.dev !== entry.dev || info.ino !== entry.ino) fail()
}
async function own(filename: string, flags: number): Promise<FileHandle> {
  const file = await open(filename, flags, 0o600)
  try { await regular(file, filename); await acquireFileOwnership(file); return file } catch (error) { await file.close(); throw error }
}
async function readExactly(file: FileHandle, bytes: number, offset = 0): Promise<Buffer> {
  const result = Buffer.alloc(bytes)
  let used = 0
  while (used < bytes) {
    const { bytesRead } = await file.read(result, used, bytes - used, offset + used)
    if (!bytesRead) fail()
    used += bytesRead
  }
  return result
}
async function hash(file: FileHandle, maxBytes: number, prefix?: number): Promise<{ bytes: number; digest: string }> {
  const before = await file.stat()
  if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size > maxBytes || prefix !== undefined && before.size < prefix) fail()
  const bytes = prefix ?? before.size, buffer = Buffer.alloc(Math.min(chunkBytes, bytes)), digest = createHash('sha256')
  for (let offset = 0; offset < bytes;) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset)
    if (!bytesRead) fail()
    digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead
  }
  const after = await file.stat()
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail()
  return { bytes, digest: `sha256:${digest.digest('hex')}` }
}
async function copy(source: FileHandle, destination: FileHandle, bytes: number): Promise<void> {
  const buffer = Buffer.alloc(Math.min(chunkBytes, bytes))
  for (let offset = 0; offset < bytes;) {
    const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset)
    if (!bytesRead) fail()
    for (let written = 0; written < bytesRead;) {
      const result = await destination.write(buffer, written, bytesRead - written, offset + written)
      if (!result.bytesWritten) fail()
      written += result.bytesWritten
    }
    offset += bytesRead
  }
  await destination.sync()
}
function encodeGuard(guard: Guard): Buffer { return Buffer.from(`${canonicalJson(guard, markerBytes - 1)}\n`) }
async function readGuard(filename: string): Promise<Guard> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    await regular(file, filename)
    const size = (await file.stat()).size
    if (size < 1 || size > markerBytes) fail()
    const bytes = await readExactly(file, size)
    const result = guardSchema.parse(parseStrictJson(bytes, markerBytes))
    if (!bytes.equals(encodeGuard(result))) fail()
    return result
  } finally { await file.close() }
}
async function publish(directory: FileHandle, name: string, guard: Guard): Promise<void> {
  const temporaryName = `.factory-layout-${randomUUID()}`, temporaryPath = path(directory, temporaryName)
  const file = await open(temporaryPath, fileFlags | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await file.writeFile(encodeGuard(guard)); await file.sync()
    // Link publication is atomic and refuses to replace any existing path.
    await link(temporaryPath, path(directory, name))
    await unlink(temporaryPath)
    await directory.sync()
  } finally { await file.close() }
}
async function layoutDirectory(parent: FileHandle, guard: Guard): Promise<FileHandle> {
  const filename = path(parent, guard.directory), info = await lstat(filename)
  if (!info.isDirectory() || info.isSymbolicLink()) fail()
  const directory = await open(filename, directoryFlags)
  try {
    const pinned = await directory.stat(), current = await lstat(filename)
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== pinned.ino || current.dev !== pinned.dev) fail()
    return directory
  } catch (error) { await directory.close(); throw error }
}
function expectedDirectory(name: string, migrationId: string): string { return `${name}.layout2-${migrationId}` }
async function release(handles: FileHandle[], parent: { close(): Promise<void> }): Promise<void> {
  let failed = false
  for (const handle of [...handles].reverse()) { try { await handle.close() } catch { failed = true } }
  try { await parent.close() } catch { failed = true }
  if (failed) fail()
}
/** Own the legacy anchor inode throughout the new journal owner's lifetime. */
export async function openFactoryJournalLocation(filename: string, rawMaxBytes: number): Promise<FactoryJournalLocation> {
  const maxBytes = limit(rawMaxBytes), parent = await parentFor(filename)
  const handles: FileHandle[] = []
  let closing: Promise<void> | undefined
  const close = () => closing ??= release(handles, parent)
  try {
    const anchorPath = path(parent.directory, parent.name)
    if (!await exists(anchorPath) && (await exists(path(parent.directory, `${parent.name}.layout2.pending`)) || await exists(path(parent.directory, `${parent.name}.layout2.commit`)))) fail()
    const anchor = await own(anchorPath, fileFlags | constants.O_CREAT | constants.O_APPEND); handles.push(anchor)
    await parent.directory.sync()
    const size = (await anchor.stat()).size
    if (size > Math.max(maxBytes, markerBytes)) fail()
    const prefix = await readExactly(anchor, Math.min(size, markerBytes))
    const newline = prefix.indexOf(10)
    let first: unknown
    if (newline >= 0) first = parseStrictJson(prefix.subarray(0, newline), markerBytes)
    else if (size && size <= markerBytes) fail()
    const pendingPath = path(parent.directory, `${parent.name}.layout2.pending`), commitPath = path(parent.directory, `${parent.name}.layout2.commit`)
    if (!first || typeof first !== 'object' || !('version' in first) || first.version !== 2) {
      if (size > maxBytes || size && newline >= 0 && (!first || typeof first !== 'object' || !('version' in first) || first.version !== 1) || await exists(pendingPath) || await exists(commitPath)) fail()
      return { filename: anchorPath, file: anchor, close }
    }
    const guard = guardSchema.parse(first)
    if (size !== encodeGuard(guard).length || !prefix.equals(encodeGuard(guard)) || guard.anchor !== parent.name || guard.directory !== expectedDirectory(parent.name, guard.migrationId) || guard.legacyBytes > maxBytes) fail()
    if (digestJson(await readGuard(pendingPath)) !== digestJson(guard) || digestJson(await readGuard(commitPath)) !== digestJson(guard)) fail()
    const directory = await layoutDirectory(parent.directory, guard); handles.push(directory)
    const backupPath = path(directory, 'legacy-backup.jsonl'), backup = await own(backupPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(backup)
    const backupHash = await hash(backup, maxBytes)
    if (backupHash.bytes !== guard.legacyBytes || backupHash.digest !== guard.legacyDigest) fail()
    const targetPath = path(directory, 'journal.jsonl'), target = await own(targetPath, fileFlags | constants.O_APPEND); handles.push(target)
    const targetHash = await hash(target, maxBytes, guard.legacyBytes)
    if (targetHash.digest !== guard.legacyDigest) fail()
    return { filename: targetPath, file: target, close }
  } catch { await close(); return fail() }
}

/** Copies exact v1 event bytes into layout2; callers validate real replay/reference semantics on both copies.
 * The guard poisons the SAME anchor inode before commit, so old binaries cannot append to a detached inode.
 * A crash at any incomplete phase requires explicit recovery; pending files are never guessed or repaired.
 */
export async function migrateFactoryJournal(filename: string, raw: FactoryJournalMigrationOptions): Promise<FactoryJournalMigrationResult> {
  let maxBytes: number, migrationId: string
  try {
    if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.values(Object.getOwnPropertyDescriptors(raw)).some(descriptor => !('value' in descriptor)) || Object.getOwnPropertySymbols(raw).length || Object.keys(raw).sort().join(',') !== 'maxBytes,migrationId,validate' || typeof raw.validate !== 'function') fail()
    maxBytes = limit(raw.maxBytes); if (maxBytes > maximumJournalBytes) fail(); migrationId = migrationIdSchema.parse(raw.migrationId)
  } catch { fail() }
  const parent = await parentFor(filename), handles: FileHandle[] = []
  try {
    const anchorPath = path(parent.directory, parent.name), anchor = await own(anchorPath, fileFlags); handles.push(anchor)
    if (await exists(path(parent.directory, `${parent.name}.layout2.pending`)) || await exists(path(parent.directory, `${parent.name}.layout2.commit`))) fail()
    const original = await hash(anchor, maxBytes)
    const guard: Guard = { version: 2, layout: 'darkfactory-journal-layout/v2', migrationId, anchor: parent.name, directory: expectedDirectory(parent.name, migrationId), legacyDigest: original.digest, legacyBytes: original.bytes }
    // Durable preparation blocks new owners before creating any backup or target.
    await publish(parent.directory, `${parent.name}.layout2.pending`, guard)
    await mkdir(path(parent.directory, guard.directory), { mode: 0o700 })
    const directory = await layoutDirectory(parent.directory, guard); handles.push(directory)
    await directory.sync(); await parent.directory.sync()
    const backupPath = path(directory, 'legacy-backup.jsonl'), targetPath = path(directory, 'journal.jsonl')
    const backup = await open(backupPath, fileFlags | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await acquireFileOwnership(backup); await copy(anchor, backup, original.bytes) } finally { await backup.close() }
    await directory.sync()
    await raw.validate(backupPath)
    const ownedBackup = await own(backupPath, fileFlags); handles.push(ownedBackup)
    if (!sameHash(await hash(ownedBackup, maxBytes), original)) fail()
    await ownedBackup.chmod(0o400); await ownedBackup.sync()
    const target = await open(targetPath, fileFlags | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await acquireFileOwnership(target); await copy(ownedBackup, target, original.bytes) } finally { await target.close() }
    await directory.sync()
    await raw.validate(targetPath)
    const ownedTarget = await own(targetPath, fileFlags); handles.push(ownedTarget)
    if (!sameHash(await hash(ownedTarget, maxBytes), original) || !sameHash(await hash(ownedBackup, maxBytes), original) || !sameHash(await hash(anchor, maxBytes), original)) fail()
    await regular(anchor, anchorPath)
    const marker = encodeGuard(guard)
    // In-place guard may tear on crash; absent commit then forces explicit recovery.
    let written = 0
    while (written < marker.length) { const result = await anchor.write(marker, written, marker.length - written, written); if (!result.bytesWritten) fail(); written += result.bytesWritten }
    await anchor.truncate(marker.length); await anchor.sync()
    await publish(parent.directory, `${parent.name}.layout2.commit`, guard)
    return { storageLayout: 2, migrationId, legacyDigest: original.digest, legacyBytes: original.bytes, directory: guard.directory,
      backup: join(dirname(filename), guard.directory, 'legacy-backup.jsonl'), target: join(dirname(filename), guard.directory, 'journal.jsonl') }
  } catch { return fail() } finally { await release(handles, parent) }
}
function sameHash(a: { bytes: number; digest: string }, b: { bytes: number; digest: string }): boolean { return a.bytes === b.bytes && a.digest === b.digest }
