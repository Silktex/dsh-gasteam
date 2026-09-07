/** Dispatches offline graph validation; no registry author or live effect is authorized here. */
import z from 'zod'
import { canonicalJson, parseStrictJson } from '../json.ts'
import { referenceGraphInputSchema, validateReferenceGraph } from './reference-graph.ts'
import { verificationReferenceGraphInputSchema as verificationReferenceGraphSchema, validateVerificationReferenceGraph } from './verification-reference-graph.ts'
import { economicsReferenceGraphSchema, validateEconomicsReferenceGraph } from './economics-reference-graph.ts'
import { quarantineReferenceGraphInputSchema as quarantineReferenceGraphSchema, validateQuarantineReferenceGraph } from './quarantine-reference-graph.ts'
export const factoryReferenceGraphSchemas = {
  'source-admission': referenceGraphInputSchema,
  'verification-release': verificationReferenceGraphSchema,
  'fleet-economics': economicsReferenceGraphSchema,
  'quarantine-health': quarantineReferenceGraphSchema,
} as const
export function factoryReferenceGraphJsonSchemas(): Record<keyof typeof factoryReferenceGraphSchemas, z.core.JSONSchema.JSONSchema> {
  const convert = (schema: z.ZodType): z.core.JSONSchema.JSONSchema => z.toJSONSchema(schema, { target: 'draft-2020-12' })
  return {
    'source-admission': convert(referenceGraphInputSchema),
    'verification-release': convert(verificationReferenceGraphSchema),
    'fleet-economics': convert(economicsReferenceGraphSchema),
    'quarantine-health': convert(quarantineReferenceGraphSchema),
  }
}
export function validateFactoryReferenceGraph(raw: unknown) {
  const input = parseStrictJson(typeof raw === 'string' || raw instanceof Uint8Array ? raw : canonicalJson(raw, 12_582_912), 12_582_912)
  if (!input || typeof input !== 'object' || !('lane' in input)) throw new Error('Factory graph rejected: missing lane')
  switch (input.lane) {
    case 'source-admission': return validateReferenceGraph(input)
    case 'verification-release': return validateVerificationReferenceGraph(input)
    case 'fleet-economics': return validateEconomicsReferenceGraph(input)
    case 'quarantine-health': return validateQuarantineReferenceGraph(input)
    default: throw new Error('Factory graph rejected: unknown lane')
  }
}
