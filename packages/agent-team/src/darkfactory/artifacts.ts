/** Shared bounded sanitized artifact custody for ingress and provider reconciliation. */
import { constants } from 'node:fs'
import { link, lstat, open, readdir, statfs, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { artifactRefSchema, idSchema } from './contracts/index.ts'
import type { ArtifactRef } from './contracts/index.ts'
import { canonicalJson, digestBytes, parseStrictJson } from './json.ts'
import { ensureFactoryDirectory } from './paths.ts'
export class ArtifactError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
/** Publish content-addressed sanitized bytes before their reference enters the custody journal. */
interface ArtifactBudget { usedBytes: number; usedFiles: number; maxBytes: number }
async function persistArtifact(directory: string, projectId: string, value: unknown, maxBytes: number, budget: ArtifactBudget): Promise<ArtifactRef> {
  idSchema.parse(projectId)
  const bytes = Buffer.from(canonicalJson(value))
  if (bytes.length > maxBytes) throw new ArtifactError(503, 'ARTIFACT_LIMIT')
  const owned = await ensureFactoryDirectory(directory, projectId, 'artifacts')
  try {
    const artifactDirectory = owned.descriptorPath
    const space = await statfs(artifactDirectory, { bigint: true })
    if (space.bavail * space.bsize < BigInt(bytes.length + 1_048_576)) throw new ArtifactError(503, 'STORAGE_CAPACITY')
    const digest = digestBytes(bytes)
    const filename = join(artifactDirectory, digest.slice(7))
    const reference = artifactRefSchema.parse({ projectId, id: digest.slice(7), mediaType: 'application/json', sizeBytes: bytes.length, digest })
    try {
      const existing = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await existing.stat()
        if (!info.isFile() || info.size !== bytes.length || digestBytes(await existing.readFile()) !== digest) throw new ArtifactError(503, 'ARTIFACT_CONFLICT')
        return reference
      } finally { await existing.close() }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    if (budget.usedBytes + bytes.length > budget.maxBytes || budget.usedFiles >= 100_000) throw new ArtifactError(503, 'ARTIFACT_CAPACITY')
    // Failed or uncertain writes retain exposure until a fresh owned inventory.
    budget.usedBytes += bytes.length
    budget.usedFiles++
    const temporary = join(artifactDirectory, `.pending-${randomUUID()}`)
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await file.writeFile(bytes); await file.sync()
      try { await link(temporary, filename) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        const existing = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const info = await existing.stat()
          if (!info.isFile() || info.size !== bytes.length || digestBytes(await existing.readFile()) !== digest) throw new ArtifactError(503, 'ARTIFACT_CONFLICT')
        } finally { await existing.close() }
      }
    } finally { await file.close(); await unlink(temporary); await owned.sync() }
    return reference
  } finally { await owned.close() }
}


export class DarkFactoryArtifactStore {
  private readonly pending = new Map<string, Promise<unknown>>()
  private constructor(private readonly directory: string, private readonly budgets: Map<string, ArtifactBudget>, private readonly maxBytes: number) {}
  static async open(directory: string, projectIds: readonly string[], maxBytes: number, maxTotalBytes: number): Promise<DarkFactoryArtifactStore> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxBytes || projectIds.length > 256 || new Set(projectIds).size !== projectIds.length) throw new Error('Invalid artifact storage limits')
    const budgets = new Map<string, ArtifactBudget>()
    for (const projectId of projectIds) {
      const owned = await ensureFactoryDirectory(directory, projectId, 'artifacts')
      let usedBytes = 0
      try {
        const names = await readdir(owned.descriptorPath)
        if (names.length > 100_000) throw new Error('Artifact inventory limit exceeded')
        for (const name of names) {
          const stat = await lstat(join(owned.descriptorPath, name))
          if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || !Number.isSafeInteger(usedBytes + stat.size)) throw new Error('Unsafe artifact inventory')
          usedBytes += stat.size
        }
        budgets.set(projectId, { usedBytes, usedFiles: names.length, maxBytes: maxTotalBytes })
      } finally { await owned.close() }
    }
    return new DarkFactoryArtifactStore(directory, budgets, maxBytes)
  }
  persist(projectId: string, value: unknown): Promise<ArtifactRef> {
    const budget = this.budgets.get(projectId)
    if (!budget) return Promise.reject(new Error('Artifact project is not registered'))
    const operation = (this.pending.get(projectId) ?? Promise.resolve()).then(() => persistArtifact(this.directory, projectId, value, this.maxBytes, budget))
    this.pending.set(projectId, operation.catch(() => {}))
    return operation
  }
  async read(raw: ArtifactRef): Promise<unknown> {
    const reference = artifactRefSchema.parse(raw)
    if (!this.budgets.has(reference.projectId) || reference.mediaType !== 'application/json' || reference.id !== reference.digest.slice(7) || reference.sizeBytes > this.maxBytes) throw new Error('Invalid artifact reference')
    const owned = await ensureFactoryDirectory(this.directory, reference.projectId, 'artifacts')
    try {
      const file = await open(join(owned.descriptorPath, reference.id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== reference.sizeBytes) throw new Error('Artifact size mismatch')
        // A bounded positioned read cannot grow with a concurrently modified file.
        const bytes = Buffer.alloc(reference.sizeBytes)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) throw new Error('Incomplete artifact')
          offset += bytesRead
        }
        if (digestBytes(bytes) !== reference.digest || (await file.stat()).size !== reference.sizeBytes) throw new Error('Artifact digest mismatch')
        return parseStrictJson(bytes, this.maxBytes)
      } finally { await file.close() }
    } finally { await owned.close() }
  }
  async settled(): Promise<void> { await Promise.all(this.pending.values()) }
}
