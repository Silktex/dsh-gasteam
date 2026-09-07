import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { secretRefSchema, type SecretRef } from './contracts/common.ts'

export interface SecretResolutionOptions { env?: NodeJS.ProcessEnv; maxBytes?: number }
/** Resolve only at the host boundary; callers must never serialize returned secret values. */
export async function resolveSecret(input: SecretRef, options: SecretResolutionOptions = {}): Promise<string> {
  const result = secretRefSchema.safeParse(input)
  if (!result.success) throw new Error('Invalid Dark Factory secret reference')
  const ref = result.data
  const maxBytes = options.maxBytes ?? 65_536
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) throw new Error('Invalid Dark Factory secret size limit')
  const decode = (bytes: Uint8Array): string => {
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error('Invalid secret size')
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!value.trim() || value.includes('\0')) throw new Error('Invalid secret encoding')
    return value
  }
  try {
    if (ref.kind === 'env') {
      const value = (options.env ?? process.env)[ref.name]
      if (typeof value !== 'string' || !value.isWellFormed()) throw new Error('Missing secret')
      return decode(Buffer.from(value, 'utf8'))
    }
    // Linux descriptor-relative traversal pins each directory before opening its child.
    // O_NOFOLLOW on every component prevents parent/final symlink substitution races.
    if (process.platform !== 'linux') throw new Error('Secure file resolution requires Linux')
    const parts = resolve(ref.path).split('/').filter(Boolean)
    let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY)
    let file
    try {
      for (const part of parts.slice(0, -1)) {
        const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        await directory.close()
        directory = next
      }
      file = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1) ?? ''}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } finally { await directory.close() }
    try {
      const stat = await file.stat()
      if (!stat.isFile() ||
        stat.mode & 0o077 || !(stat.mode & 0o400) || process.getuid?.() !== stat.uid || stat.size === 0 || stat.size > maxBytes) {
        throw new Error('Unsafe secret file')
      }
      // Bounded fd read: growth after stat must not allocate unbounded memory.
      const bytes = Buffer.alloc(maxBytes + 1)
      let used = 0
      while (used < bytes.length) {
        const read = await file.read(bytes, used, bytes.length - used, used)
        if (!read.bytesRead) break
        used += read.bytesRead
      }
      const after = await file.stat()
      if (after.mode !== stat.mode || after.uid !== stat.uid || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || used !== stat.size) throw new Error('Secret changed during resolution')
      return decode(bytes.subarray(0, used))
    } finally { await file.close() }
  } catch { throw new Error('Dark Factory secret unavailable or unsafe') }
}
