/** Shared bounded artifact custody checks for offline reference graphs. */
import z from 'zod'
import { artifactRefSchema, idSchema, type ArtifactRef } from './common.ts'
import { canonicalJson, digestBytes } from '../json.ts'
export const graphArtifactLimits = { count: 128, individualBytes: 1_048_576, totalBytes: 4_194_304 } as const
export const graphArtifactDescriptorSchema = z.strictObject({ reference: artifactRefSchema,
  bytesBase64: z.string().max(Math.ceil(graphArtifactLimits.individualBytes / 3) * 4),
})
export type GraphArtifactDescriptor = z.input<typeof graphArtifactDescriptorSchema>
function fail(): never { throw new Error('Reference graph rejected: invalid artifact custody') }
function decodedLength(encoded: string): number {
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail()
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (encoded.endsWith('==') && (alphabet.indexOf(encoded.at(-3)!) & 15) !== 0) fail()
  if (encoded.endsWith('=') && !encoded.endsWith('==') && (alphabet.indexOf(encoded.at(-2)!) & 3) !== 0) fail()
  return encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
}
export function validateGraphArtifacts(projectId: string, raw: readonly GraphArtifactDescriptor[]): {
  assertArtifact(reference: ArtifactRef): void
  readArtifact(reference: ArtifactRef): Uint8Array
} {
  try { idSchema.parse(projectId) } catch { fail() }
  if (!Array.isArray(raw) || raw.length > graphArtifactLimits.count) fail()
  let descriptors: z.output<typeof graphArtifactDescriptorSchema>[]
  try { descriptors = z.array(graphArtifactDescriptorSchema).max(graphArtifactLimits.count).parse(raw) } catch { fail() }
  let total = 0
  for (const item of descriptors) {
    const size = decodedLength(item.bytesBase64)
    total += size
    if (size !== item.reference.sizeBytes || size > graphArtifactLimits.individualBytes || total > graphArtifactLimits.totalBytes) fail()
  }
  const artifacts = new Map<string, { reference: ArtifactRef; bytes: Buffer }>(), digests = new Set<string>()
  for (const item of descriptors) {
    const ref = item.reference
    if (ref.projectId !== projectId || artifacts.has(ref.id) || digests.has(ref.digest)) fail()
    const bytes = Buffer.from(item.bytesBase64, 'base64')
    if (digestBytes(bytes) !== ref.digest) fail()
    artifacts.set(ref.id, { reference: ref, bytes }); digests.add(ref.digest)
  }
  const assertArtifact = (reference: ArtifactRef): void => {
    const original = artifacts.get(reference.id)?.reference
    if (!original || canonicalJson(reference) !== canonicalJson(original)) fail()
  }
  return { assertArtifact, readArtifact(reference) { assertArtifact(reference); return new Uint8Array(artifacts.get(reference.id)!.bytes) } }
}
