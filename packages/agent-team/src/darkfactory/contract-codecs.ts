/** Strict host SDK codecs; defining one does not register an RPC endpoint. */
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { contracts, validateContract, idSchema } from './contracts/index.ts'
import { canonicalJson, parseStrictJson } from './json.ts'
export function createFactoryContractCodec(name: keyof typeof contracts, projectId: string): Extract<TypertCodec, { mode: 'strict' }> {
  if (!Object.hasOwn(contracts, name)) throw new Error('Unknown factory contract codec')
  idSchema.parse(projectId)
  return { mode: 'strict', typeSymbol: `@deepseek-ai/dsh-experimental-agent-team/darkfactory#${name}`,
    schema: { parse(raw: unknown) {
      try {
        const record = validateContract(name, parseStrictJson(canonicalJson(raw, 1_048_576)))
        if (record.projectId !== projectId) throw new Error()
        return record
      } catch { throw new Error('Invalid factory contract or project binding') }
    } },
  }
}
