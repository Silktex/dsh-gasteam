import { expect, it } from 'vitest'
import { validateGraphArtifacts } from '../../src/darkfactory/contracts/graph-core.ts'
import { digestBytes } from '../../src/darkfactory/json.ts'
const descriptor = (text: string, id = 'artifact') => {
  const bytes = Buffer.from(text)
  return { reference: { projectId: 'project', id, mediaType: 'text/plain', sizeBytes: bytes.length, digest: digestBytes(bytes) }, bytesBase64: bytes.toString('base64') }
}
it('binds full artifact descriptors and gives callers copied bytes', () => {
  const input = descriptor('registered evidence'), graph = validateGraphArtifacts('project', [input])
  graph.assertArtifact(input.reference)
  graph.readArtifact(input.reference)[0] = 0
  expect(Buffer.from(graph.readArtifact(input.reference)).toString()).toBe('registered evidence')
  expect(() => graph.assertArtifact({ ...input.reference, mediaType: 'application/json' })).toThrow()
  expect(() => graph.assertArtifact({ ...input.reference, projectId: 'another' })).toThrow()
})
it('rejects ambiguous bytes, identity/digest aliases, tampering and resource excesses', () => {
  const input = descriptor('a')
  for (const items of [
    [input, input], [input, { ...input, reference: { ...input.reference, id: 'alias' } }],
    [{ ...input, bytesBase64: 'YR==' }], [{ ...input, bytesBase64: 'Yg==' }],
    [{ ...input, reference: { ...input.reference, sizeBytes: 9 } }],
    [{ ...input, reference: { ...input.reference, projectId: 'other' } }],
    Array.from({ length: 129 }, () => input),
    [descriptor('x'.repeat(1_048_577))],
    Array.from({ length: 5 }, (_, i) => descriptor(String(i).repeat(1_048_576), `artifact-${i}`)),
  ]) expect(() => validateGraphArtifacts('project', items)).toThrow(/^Reference graph rejected:/)
})

it('enforces exact canonical byte budgets while traversing without evaluating oversized payloads', async () => {
  const { canonicalJson, parseStrictJson } = await import('../../src/darkfactory/json.ts')
  for (const value of [null, true, -1.5, '', '\n\u0000😀', [], {}, [1, [false, '€']], { z: 'é', '😀': { '': 0 } }]) {
    const encoded = canonicalJson(value), bytes = Buffer.byteLength(encoded)
    expect(canonicalJson(value, bytes)).toBe(encoded)
    expect(() => canonicalJson(value, bytes - 1)).toThrow(/byte limit/)
    expect(parseStrictJson(encoded, bytes)).toEqual(value)
  }
  let invoked = false
  const huge = new Array(1_000_000)
  Object.defineProperty(huge, '0', { get() { invoked = true; return 1 } })
  expect(() => canonicalJson(huge, 10)).toThrow(/byte limit/)
  expect(invoked).toBe(false)
  expect(() => canonicalJson('x'.repeat(1_048_577), 1_048_576)).toThrow(/byte limit/)
  expect(() => parseStrictJson('x'.repeat(1_048_577), 1_048_576)).toThrow(/byte limit/)
})
