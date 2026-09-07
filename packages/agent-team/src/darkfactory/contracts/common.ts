import z from 'zod'

/** IDs are also safe directory components. Display text belongs in separate fields. */
export const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
export const counterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const revisionSchema = counterSchema.min(1)
export const timestampSchema = z.iso.datetime().max(64).regex(/T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const commitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const textSchema = z.string().min(1).max(16_384)
export const signatureSchema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
export const recordFields = { schemaVersion: z.literal(1), id: idSchema, projectId: idSchema, policyRevision: revisionSchema }
export const safePathSchema = z.string().min(1).max(1024).regex(
  /^(?!.*(?:^|\/)(?:\.{1,2}|\.[gG][iI][tT])(?:\/|$))[^/\\\x00-\x1f\x7f:*?]+(?:\/[^/\\\x00-\x1f\x7f:*?]+)*$/,
  { message: 'Expected a relative repository path without traversal, glob, or Git metadata' },
)
export const httpsUrlSchema = z.url().max(2048).refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash
}, { message: 'Expected HTTPS without credentials or fragment' })
export function uniqueIds(max = 256) {
  return z.array(idSchema).max(max).refine(values => new Set(values).size === values.length, { message: 'Duplicate identity' }).meta({ uniqueItems: true })
}
export const artifactRefSchema = z.strictObject({
  projectId: idSchema, id: idSchema, mediaType: z.string().min(1).max(128).regex(/^[\w.+-]+\/[\w.+-]+$/),
  sizeBytes: counterSchema, digest: digestSchema,
})
export const repositorySchema = z.strictObject({ provider: idSchema, repositoryId: idSchema, canonicalName: z.string().min(1).max(256) })
export const sourceRefSchema = z.strictObject({
  envelopeId: idSchema, source: z.enum(['github', 'sentry', 'apm', 'maintenance']),
  sourceEntityId: idSchema, sourceRevision: digestSchema,
})
export const secretRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256) }),
  z.strictObject({ kind: z.literal('file'), path: z.string().min(2).max(4096).refine(value => value.startsWith('/') && !value.includes('\0')) }),
])
export type ArtifactRef = z.output<typeof artifactRefSchema>
export type SecretRef = z.output<typeof secretRefSchema>

/** Shape validation alone cannot enforce project-scoped artifact authority. */
export function assertProjectArtifacts(projectId: string, artifacts: readonly ArtifactRef[]): void {
  if (artifacts.some(artifact => artifact.projectId !== projectId)) throw new Error('Cross-project artifact reference')
}
