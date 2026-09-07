/** Linux descriptor-relative storage traversal; callers retain the returned directory until child I/O ends. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { idSchema } from './contracts/common.ts'

export interface FactoryDirectory {
  readonly path: string
  /** Use this pinned path for child I/O, not the mutable display path above. */
  readonly descriptorPath: string
  sync(): Promise<void>
  close(): Promise<void>
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const descriptorPath = (directory: FileHandle) => `/proc/self/fd/${directory.fd}`
function lease(path: string, owned: FileHandle): FactoryDirectory {
  let closing: Promise<void> | undefined
  return { path, descriptorPath: descriptorPath(owned), sync: () => owned.sync(), close: () => closing ??= owned.close() }
}
async function canonicalRoot(root: string): Promise<FileHandle> {
  if (process.platform !== 'linux' || typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) throw new Error('Unsafe Dark Factory storage directory')
  let directory: FileHandle | undefined
  try {
    if (await realpath(root) !== root) throw new Error('Noncanonical root')
    directory = await open('/', directoryFlags)
    // Root already exists; never create anything while traversing its ancestors.
    for (const part of root.split('/').filter(Boolean)) {
      const next = await open(`${descriptorPath(directory)}/${part}`, directoryFlags)
      const previous = directory; directory = next; await previous.close()
    }
    return directory
  } catch { await directory?.close(); throw new Error('Unsafe Dark Factory storage directory') }
}
/** Pin an existing canonical coordinator root before opening its policy journal. */
export async function openFactoryRoot(root: string): Promise<FactoryDirectory> { return lease(root, await canonicalRoot(root)) }

/**
 * Reject pre-existing symlinks before creating descendants, and pin every parent
 * during lookup. This does not grant a sandbox against an owner who can rename
 * directories or modify the running host itself.
 */
export async function ensureFactoryDirectory(root: string, projectId: string, leaf?: 'artifacts'): Promise<FactoryDirectory> {
  if (!idSchema.safeParse(projectId).success || (leaf !== undefined && leaf !== 'artifacts')) throw new Error('Unsafe Dark Factory storage directory')
  let directory = await canonicalRoot(root)
  try {
    const parts = ['darkfactory', projectId, ...(leaf ? [leaf] : [])]
    for (const part of parts) {
      const childPath = `${descriptorPath(directory)}/${part}`
      let info
      try { info = await lstat(childPath) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Unsafe child')
      if (info === undefined) {
        try { await mkdir(childPath, { mode: 0o700 }) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        }
      }
      const next = await open(childPath, directoryFlags)
      try {
        const current = await lstat(childPath)
        const pinned = await next.stat()
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== pinned.dev || current.ino !== pinned.ino) throw new Error('Directory changed during traversal')
        // Persist the child inode before its entry in the pinned parent.
        await next.sync()
        await directory.sync()
      } catch (error) { await next.close(); throw error }
      const previous = directory; directory = next; await previous.close()
    }
    return lease(join(root, ...parts), directory)
  } catch { await directory.close(); throw new Error('Unsafe Dark Factory storage directory') }
}
