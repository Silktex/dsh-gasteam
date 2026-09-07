import { z } from 'zod'
import { counterSchema } from './contracts/common.ts'
import type { UsageEventV1 } from './contracts/economics.ts'
import { digestBytes, digestJson } from './json.ts'

export const headroomCompressionSchema = z.strictObject({
  compressed: z.boolean(),
  estimatedInputTokens: counterSchema.nullable(),
  estimatedSavedTokens: counterSchema.nullable(),
  retrievalCostMicros: counterSchema.nullable(),
})

export type HeadroomCompressionMetadata = z.output<typeof headroomCompressionSchema>

export class HeadroomRetrievalUnavailableError extends Error {
  constructor(message: string = 'Headroom retrieval storage is unavailable or unreachable') {
    super(message)
    this.name = 'HeadroomRetrievalUnavailableError'
  }
}

export class CompressedEvidenceViolationError extends Error {
  constructor(message: string = 'Verification evidence, signatures, or assertions cannot be computed from compressed data') {
    super(message)
    this.name = 'CompressedEvidenceViolationError'
  }
}

export class HeadroomHeaderParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeadroomHeaderParseError'
  }
}

/** Standard OpenAI / Anthropic / LiteLLM compatible tool definition for headroom_retrieve. */
export const headroomRetrieveToolDefinition = Object.freeze({
  type: 'function',
  function: {
    name: 'headroom_retrieve',
    description: 'Retrieve the original uncompressed context segment for a given chunk digest or identifier from transparent Headroom guardrail storage.',
    parameters: {
      type: 'object',
      properties: {
        chunkId: {
          type: 'string',
          description: 'The immutable digest or unique identifier of the compressed chunk to retrieve.',
        },
        attemptId: {
          type: 'string',
          description: 'The attempt envelope scope identifier requesting the retrieval.',
        },
      },
      required: ['chunkId'],
    },
  },
})

export interface HeadroomRetrievalStorage {
  get(chunkId: string): Promise<string | Buffer | null> | (string | Buffer | null)
  put?(chunkId: string, content: string | Buffer): Promise<void> | void
  isReachable(): Promise<boolean> | boolean
}

export interface NormalizeHeaderOptions {
  /** If true, returns default uncompressed metadata when headroom headers are absent. Defaults to true. */
  defaultWhenAbsent?: boolean
  /** Known retrieval cost in micro-USD to attach if retrieval occurred. */
  retrievalCostMicros?: number | null
}

/**
 * Normalizes HTTP response headers (from Headers object or record) into schema-compliant compression metadata.
 * Case-insensitive lookup handles 'x-headroom-compressed' and 'x-headroom-tokens-saved'.
 */
export function normalizeHeadroomHeaders(
  headers: Headers | Record<string, string | string[] | number | undefined | null> | undefined | null,
  options: NormalizeHeaderOptions = {},
): HeadroomCompressionMetadata | undefined {
  if (!headers) {
    if (options.defaultWhenAbsent === false) return undefined
    return {
      compressed: false,
      estimatedInputTokens: null,
      estimatedSavedTokens: null,
      retrievalCostMicros: options.retrievalCostMicros ?? null,
    }
  }

  const getHeader = (name: string): string | undefined => {
    const target = name.toLowerCase()
    if (typeof (headers as Headers).get === 'function') {
      const val = (headers as Headers).get(target)
      return val ?? undefined
    }
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === target) {
        if (Array.isArray(val)) return val[0]
        if (val !== undefined && val !== null) return String(val)
      }
    }
    return undefined
  }

  const rawCompressed = getHeader('x-headroom-compressed')
  const rawTokensSaved = getHeader('x-headroom-tokens-saved')

  // If neither header is present
  if (rawCompressed === undefined && rawTokensSaved === undefined) {
    if (options.defaultWhenAbsent === false) return undefined
    return {
      compressed: false,
      estimatedInputTokens: null,
      estimatedSavedTokens: null,
      retrievalCostMicros: options.retrievalCostMicros ?? null,
    }
  }

  let compressed = false
  if (rawCompressed !== undefined) {
    const trimmed = rawCompressed.trim().toLowerCase()
    if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes') {
      compressed = true
    } else if (trimmed === 'false' || trimmed === '0' || trimmed === 'no' || trimmed === '') {
      compressed = false
    } else {
      throw new HeadroomHeaderParseError(`Invalid value for x-headroom-compressed: "${rawCompressed}"`)
    }
  }

  let estimatedSavedTokens: number | null = null
  if (rawTokensSaved !== undefined) {
    const trimmed = rawTokensSaved.trim()
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new HeadroomHeaderParseError(`Invalid integer for x-headroom-tokens-saved: "${rawTokensSaved}"`)
    }
    estimatedSavedTokens = parsed
    // If tokens saved > 0 and compressed header was not explicitly set to false, mark compressed true
    if (parsed > 0 && rawCompressed === undefined) {
      compressed = true
    }
  }

  return {
    compressed,
    estimatedInputTokens: null,
    estimatedSavedTokens,
    retrievalCostMicros: options.retrievalCostMicros ?? null,
  }
}

/**
 * In-memory attempt-scoped retrieval cache and storage for testing and offline environments.
 */
export class InMemoryHeadroomStorage implements HeadroomRetrievalStorage {
  private readonly store = new Map<string, string | Buffer>()
  private reachable = true

  setReachable(reachable: boolean): void {
    this.reachable = reachable
  }

  isReachable(): boolean {
    return this.reachable
  }

  get(chunkId: string): string | Buffer | null {
    if (!this.reachable) {
      throw new HeadroomRetrievalUnavailableError()
    }
    return this.store.get(chunkId) ?? null
  }

  put(chunkId: string, content: string | Buffer): void {
    if (!this.reachable) {
      throw new HeadroomRetrievalUnavailableError()
    }
    this.store.set(chunkId, content)
  }

  has(chunkId: string): boolean {
    return this.store.has(chunkId)
  }

  clear(): void {
    this.store.clear()
  }
}

/**
 * Attempt-scoped retriever that exposes tool execution and enforces reachability invariants.
 */
export class HeadroomRetriever {
  constructor(
    private readonly storage: HeadroomRetrievalStorage,
    private readonly options: { attemptId?: string } = {},
  ) {}

  async executeRetrieve(chunkId: string, callingAttemptId?: string): Promise<{ content: string; digest: string }> {
    const reachable = await Promise.resolve(this.storage.isReachable())
    if (!reachable) {
      throw new HeadroomRetrievalUnavailableError(`Cannot execute headroom_retrieve: storage unreachable`)
    }

    if (this.options.attemptId && callingAttemptId && this.options.attemptId !== callingAttemptId) {
      throw new Error(`Attempt scope mismatch: retriever scoped to ${this.options.attemptId}, got ${callingAttemptId}`)
    }

    const chunk = await Promise.resolve(this.storage.get(chunkId))
    if (chunk === null || chunk === undefined) {
      throw new Error(`Headroom chunk not found: ${chunkId}`)
    }

    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const digest = digestBytes(buf)
    return {
      content: typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      digest,
    }
  }
}

/**
 * Invariant enforcement: Hashes, signatures, assertions, and verification evidence
 * must NEVER be computed from compressed payloads.
 */
export function assertUncompressedEvidence(
  payload: string | Buffer | Uint8Array | object,
  metadata?: { isCompressed?: boolean; headers?: Headers | Record<string, string | string[] | undefined | null> },
): void {
  if (metadata?.isCompressed === true) {
    throw new CompressedEvidenceViolationError('Payload is flagged as compressed; cannot compute verification evidence')
  }

  if (metadata?.headers) {
    const normalized = normalizeHeadroomHeaders(metadata.headers, { defaultWhenAbsent: false })
    if (normalized?.compressed === true) {
      throw new CompressedEvidenceViolationError('Headers indicate compressed payload; cannot compute verification evidence')
    }
  }
}
