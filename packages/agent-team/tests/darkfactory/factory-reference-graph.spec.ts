import { expect, it } from 'vitest'
import { factoryReferenceGraphJsonSchemas, factoryReferenceGraphSchemas, validateFactoryReferenceGraph } from '../../src/darkfactory/contracts/factory-reference-graph.ts'
import { sourceReferenceGraphFixture } from './source-reference-graph-fixture.ts'
import { economicsGraphFixture } from './economics-graph-fixture.ts'
import { verificationReferenceGraphFixture } from './verification-reference-graph-fixture.ts'
import { quarantineGraphFixture } from './quarantine-graph-fixture.ts'
it('dispatches complete graphs from all four lanes and rejects records placed in the wrong lane', () => {
  for (const input of [sourceReferenceGraphFixture(), economicsGraphFixture(), verificationReferenceGraphFixture(), quarantineGraphFixture()]) {
    expect(validateFactoryReferenceGraph(new TextEncoder().encode(JSON.stringify(input)))).toMatchObject({ authorityVerified: false })
    expect(() => validateFactoryReferenceGraph({ ...input, lane: input.lane === 'source-admission' ? 'fleet-economics' : 'source-admission' })).toThrow()
  }
  expect(() => validateFactoryReferenceGraph({ lane: 'invented' })).toThrow(/unknown lane/)
  expect(() => validateFactoryReferenceGraph('{"lane":"source-admission","lane":"fleet-economics"}')).toThrow(/ambiguous/)
})
it('exports JSON Schema for every supported lane with strict top-level properties', () => {
  const schemas = factoryReferenceGraphJsonSchemas()
  expect(Object.keys(schemas).sort()).toEqual(Object.keys(factoryReferenceGraphSchemas).sort())
  for (const [lane, schema] of Object.entries(schemas)) {
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, properties: { lane: { const: lane } } })
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
  }
})
