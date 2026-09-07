import { describe, it, expect, beforeEach } from 'vitest'
import {
  normalizeHeadroomHeaders,
  headroomRetrieveToolDefinition,
  InMemoryHeadroomStorage,
  HeadroomRetriever,
  assertUncompressedEvidence,
  HeadroomRetrievalUnavailableError,
  CompressedEvidenceViolationError,
  HeadroomHeaderParseError,
  headroomCompressionSchema,
} from '../../src/darkfactory/compression-normalizer.ts'
import {
  usageEventPayloadSchema,
  usageEventSchema,
} from '../../src/darkfactory/contracts/economics.ts'
import { digestBytes, digestJson } from '../../src/darkfactory/json.ts'

describe('DF-18 Transparent Headroom Guardrail Normalization & Invariants', () => {
  let storage: InMemoryHeadroomStorage

  beforeEach(() => {
    storage = new InMemoryHeadroomStorage()
  })

  describe('Feature 34 & 35: x-headroom-compressed Header Parsing', () => {
    it('normalizes missing headers into default uncompressed metadata', () => {
      const result = normalizeHeadroomHeaders(undefined)
      expect(result).toEqual({
        compressed: false,
        estimatedInputTokens: null,
        estimatedSavedTokens: null,
        retrievalCostMicros: null,
      })
      expect(() => headroomCompressionSchema.parse(result)).not.toThrow()
    })

    it('returns undefined when defaultWhenAbsent is false and headers are empty', () => {
      const result = normalizeHeadroomHeaders({}, { defaultWhenAbsent: false })
      expect(result).toBeUndefined()
    })

    it('parses truthy values ("true", "1", "yes") as compressed: true', () => {
      for (const val of ['true', 'TRUE', 'True', '1', 'yes', 'YES']) {
        const result = normalizeHeadroomHeaders({ 'x-headroom-compressed': val })
        expect(result?.compressed).toBe(true)
      }
    })

    it('parses falsy values ("false", "0", "no", "") as compressed: false', () => {
      for (const val of ['false', 'FALSE', '0', 'no', '']) {
        const result = normalizeHeadroomHeaders({ 'x-headroom-compressed': val })
        expect(result?.compressed).toBe(false)
      }
    })

    it('throws HeadroomHeaderParseError on invalid boolean values', () => {
      expect(() => normalizeHeadroomHeaders({ 'x-headroom-compressed': 'maybe' }))
        .toThrow(HeadroomHeaderParseError)
    })

    it('handles case-insensitive header names (e.g. X-Headroom-Compressed)', () => {
      const result = normalizeHeadroomHeaders({ 'X-Headroom-Compressed': 'true' })
      expect(result?.compressed).toBe(true)
    })

    it('supports native Fetch API Headers instance', () => {
      const headers = new Headers()
      headers.set('X-Headroom-Compressed', 'true')
      headers.set('X-Headroom-Tokens-Saved', '150')
      const result = normalizeHeadroomHeaders(headers)
      expect(result?.compressed).toBe(true)
      expect(result?.estimatedSavedTokens).toBe(150)
    })
  })

  describe('Feature 36: x-headroom-tokens-saved Header Parsing', () => {
    it('parses valid positive integer saved token counts', () => {
      const result = normalizeHeadroomHeaders({ 'x-headroom-tokens-saved': '420' })
      expect(result?.estimatedSavedTokens).toBe(420)
      expect(result?.compressed).toBe(true)
    })

    it('parses zero tokens saved without forcing compression', () => {
      const result = normalizeHeadroomHeaders({
        'x-headroom-compressed': 'false',
        'x-headroom-tokens-saved': '0',
      })
      expect(result?.estimatedSavedTokens).toBe(0)
      expect(result?.compressed).toBe(false)
    })

    it('throws HeadroomHeaderParseError on negative integer', () => {
      expect(() => normalizeHeadroomHeaders({ 'x-headroom-tokens-saved': '-50' }))
        .toThrow(HeadroomHeaderParseError)
    })

    it('throws HeadroomHeaderParseError on non-integer floating point numbers', () => {
      expect(() => normalizeHeadroomHeaders({ 'x-headroom-tokens-saved': '12.34' }))
        .toThrow(HeadroomHeaderParseError)
    })

    it('throws HeadroomHeaderParseError on non-numeric strings', () => {
      expect(() => normalizeHeadroomHeaders({ 'x-headroom-tokens-saved': 'many' }))
        .toThrow(HeadroomHeaderParseError)
    })

    it('attaches optional retrievalCostMicros when provided', () => {
      const result = normalizeHeadroomHeaders(
        { 'x-headroom-compressed': 'true', 'x-headroom-tokens-saved': '500' },
        { retrievalCostMicros: 2500 },
      )
      expect(result?.retrievalCostMicros).toBe(2500)
    })
  })

  describe('UsageEvent Integration & Serialization', () => {
    it('produces valid UsageEventPayload complying with usageEventPayloadSchema', () => {
      const compression = normalizeHeadroomHeaders({
        'x-headroom-compressed': 'true',
        'x-headroom-tokens-saved': '850',
      })

      const payload = {
        schemaVersion: 1,
        projectId: 'proj-1',
        policyRevision: 1,
        id: 'usage-event-1',
        fleetId: 'fleet-1',
        hostId: 'host-1',
        attemptId: 'attempt-1',
        generation: 1,
        provider: 'litellm-upstream',
        accountId: 'acct-1',
        modelVersion: 'model-v1',
        requestId: 'req-1',
        streamSequence: 1,
        pricingRevision: 1,
        usageAt: '2026-09-06T12:00:00Z',
        inputTokens: 1000,
        cacheTokens: 0,
        outputTokens: 200,
        reasoningTokens: 0,
        countingSemantics: 'exclusive-categories' as const,
        billedCostMicros: 5000,
        currency: 'USD' as const,
        reservationId: 'res-1',
        compression,
      }

      expect(() => usageEventPayloadSchema.parse(payload)).not.toThrow()
      const eventDigest = digestJson(payload)
      const completeEvent = { ...payload, eventDigest }
      expect(() => usageEventSchema.parse(completeEvent)).not.toThrow()
    })
  })

  describe('Feature 37: Evidence Signature Preservation Invariant', () => {
    it('allows uncompressed payload verification without throwing', () => {
      const evidence = { testResults: 'pass', score: 1.0 }
      expect(() => assertUncompressedEvidence(evidence)).not.toThrow()
      expect(() => assertUncompressedEvidence(evidence, { isCompressed: false })).not.toThrow()
    })

    it('throws CompressedEvidenceViolationError if flagged as compressed', () => {
      const evidence = { testResults: 'pass', score: 1.0 }
      expect(() => assertUncompressedEvidence(evidence, { isCompressed: true }))
        .toThrow(CompressedEvidenceViolationError)
    })

    it('throws CompressedEvidenceViolationError if headers indicate compression', () => {
      const evidence = 'raw evidence text'
      expect(() =>
        assertUncompressedEvidence(evidence, {
          headers: { 'x-headroom-compressed': 'true' },
        }),
      ).toThrow(CompressedEvidenceViolationError)
    })

    it('allows evidence when headers indicate compression: false', () => {
      const evidence = 'raw evidence text'
      expect(() =>
        assertUncompressedEvidence(evidence, {
          headers: { 'x-headroom-compressed': 'false' },
        }),
      ).not.toThrow()
    })
  })

  describe('Feature 38: Retrieval Tool Contract (headroom_retrieve)', () => {
    it('exposes valid immutable tool definition complying with tool call specifications', () => {
      expect(headroomRetrieveToolDefinition.type).toBe('function')
      expect(headroomRetrieveToolDefinition.function.name).toBe('headroom_retrieve')
      expect(headroomRetrieveToolDefinition.function.parameters.required).toContain('chunkId')
      expect(Object.isFrozen(headroomRetrieveToolDefinition)).toBe(true)
    })

    it('stores and retrieves uncompressed chunks with valid SHA-256 digest', async () => {
      const chunkText = 'Original uncompressed architecture specification text segment'
      const chunkDigest = digestBytes(Buffer.from(chunkText, 'utf8'))
      storage.put(chunkDigest, chunkText)

      const retriever = new HeadroomRetriever(storage, { attemptId: 'attempt-42' })
      const retrieved = await retriever.executeRetrieve(chunkDigest, 'attempt-42')

      expect(retrieved.content).toBe(chunkText)
      expect(retrieved.digest).toBe(chunkDigest)
    })

    it('enforces attempt scope matching when attemptId is provided', async () => {
      const chunkText = 'Attempt scoped chunk'
      const chunkDigest = digestBytes(Buffer.from(chunkText, 'utf8'))
      storage.put(chunkDigest, chunkText)

      const retriever = new HeadroomRetriever(storage, { attemptId: 'attempt-100' })
      await expect(retriever.executeRetrieve(chunkDigest, 'attempt-999'))
        .rejects.toThrow(/Attempt scope mismatch/)
    })

    it('throws error when chunk is not found in storage', async () => {
      const retriever = new HeadroomRetriever(storage)
      await expect(retriever.executeRetrieve('non-existent-chunk-digest'))
        .rejects.toThrow(/Headroom chunk not found/)
    })

    it('fails closed with HeadroomRetrievalUnavailableError when storage is unreachable', async () => {
      storage.put('chunk-1', 'content')
      storage.setReachable(false)

      const retriever = new HeadroomRetriever(storage)
      await expect(retriever.executeRetrieve('chunk-1'))
        .rejects.toThrow(HeadroomRetrievalUnavailableError)
    })
  })
})
