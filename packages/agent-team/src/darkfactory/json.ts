import { createHash } from 'node:crypto'
import type z from 'zod'

/** Bounded JSON parser that rejects ambiguous duplicate keys before object construction. */
export function parseStrictJson(input: string | Uint8Array, maxBytes = 1_048_576): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid JSON byte limit')
  if (typeof input === 'string' && !input.isWellFormed()) throw new Error('Invalid Unicode in JSON input')
  if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') > maxBytes) throw new Error('JSON byte limit exceeded')
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  if (bytes.byteLength > maxBytes) throw new Error('JSON byte limit exceeded')
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  let cursor = 0
  const fail = (): never => { throw new Error(`Invalid or ambiguous JSON at offset ${cursor}`) }
  const whitespace = () => { while (/[ \t\r\n]/.test(source[cursor] ?? 'x')) cursor++ }
  function string(): string {
    const start = cursor++
    while (cursor < source.length) {
      const char = source[cursor++]
      if (char === '"') {
        const value = JSON.parse(source.slice(start, cursor)) as string
        if (!value.isWellFormed()) fail()
        return value
      }
      if (char === '\\') cursor++
    }
    return fail()
  }
  function value(depth: number): unknown {
    if (depth > 64) throw new Error('JSON nesting limit exceeded')
    whitespace()
    const char = source[cursor]
    if (char === '"') return string()
    if (char === '{') {
      cursor++; whitespace()
      const result: Record<string, unknown> = Object.create(null)
      if (source[cursor] === '}') { cursor++; return result }
      while (true) {
        whitespace()
        if (source[cursor] !== '"') fail()
        const key = string()
        if (Object.hasOwn(result, key)) fail()
        whitespace()
        if (source[cursor++] !== ':') fail()
        result[key] = value(depth + 1)
        whitespace()
        const next = source[cursor++]
        if (next === '}') return result
        if (next !== ',') fail()
      }
    }
    if (char === '[') {
      cursor++; whitespace()
      const result: unknown[] = []
      if (source[cursor] === ']') { cursor++; return result }
      while (true) {
        result.push(value(depth + 1)); whitespace()
        const next = source[cursor++]
        if (next === ']') return result
        if (next !== ',') fail()
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(cursor))?.[0]
    if (!token) return fail()
    cursor += token.length
    const result: unknown = JSON.parse(token)
    if (typeof result === 'number' && !Number.isFinite(result)) fail()
    return result
  }
  const result = value(0)
  whitespace()
  if (cursor !== source.length) fail()
  return result
}

/** RFC 8785: ECMAScript numbers/escaping, UTF-16 key order, no Unicode normalization. */
export function canonicalJson(input: unknown, maxBytes = Number.MAX_SAFE_INTEGER): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid JSON byte limit')
  let remaining = maxBytes
  const reserve = (bytes: number): void => {
    if (bytes > remaining) throw new Error('Canonical JSON byte limit exceeded')
    remaining -= bytes
  }
  const literal = (text: string): string => { reserve(Buffer.byteLength(text, 'utf8')); return text }
  const ancestors = new Set<object>()
  function encode(value: unknown, depth: number): string {
    if (depth > 64) throw new Error('Canonical JSON nesting limit exceeded')
    if (value === null) return literal('null')
    if (typeof value === 'boolean') return literal(String(value))
    if (typeof value === 'number' && Number.isFinite(value)) return literal(JSON.stringify(value))
    if (typeof value === 'string' && value.isWellFormed()) {
      // UTF-8 bytes plus quotes are a lower bound before JSON escaping allocates.
      if (Buffer.byteLength(value, 'utf8') + 2 > remaining) throw new Error('Canonical JSON byte limit exceeded')
      return literal(JSON.stringify(value))
    }
    if (typeof value !== 'object' || value === null) throw new Error('Value is not canonical JSON')
    if (ancestors.has(value)) throw new Error('Cyclic canonical JSON')
    const prototype: unknown = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('Expected plain JSON object')
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Symbol properties are not JSON')
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        // Every element occupies at least one byte in addition to its separator.
        if (2 + Math.max(0, value.length * 2 - 1) > remaining) throw new Error('Canonical JSON byte limit exceeded')
        reserve(2 + Math.max(0, value.length - 1))
        if (Object.getOwnPropertyNames(value).length !== value.length + 1) throw new Error('Sparse or extended arrays are not JSON')
        const items: string[] = []
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          if (!descriptor) throw new Error('Sparse arrays are not JSON')
          if (!('value' in descriptor)) throw new Error('Accessors are not JSON')
          items.push(encode(descriptor.value, depth + 1))
        }
        return `[${items.join(',')}]`
      }
      const keys = Object.keys(value)
      if (2 + Math.max(0, keys.length * 5 - 1) > remaining) throw new Error('Canonical JSON byte limit exceeded')
      reserve(2 + Math.max(0, keys.length - 1) + keys.length)
      const fields = keys.sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!('value' in descriptor)) throw new Error('Accessors are not JSON')
        return `${encode(key, depth + 1)}:${encode(descriptor.value, depth + 1)}`
      })
      return `{${fields.join(',')}}`
    } finally { ancestors.delete(value) }
  }
  return encode(input, 0)
}
export function digestBytes(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
export function digestJson(value: unknown): `sha256:${string}` { return digestBytes(canonicalJson(value)) }
export function parseContract<T>(schema: z.ZodType<T>, input: string | Uint8Array, maxBytes?: number): T {
  const value = parseStrictJson(input, maxBytes)
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) {
    throw new Error('Unsupported Dark Factory schemaVersion; migrate offline from a verified backup')
  }
  return schema.parse(value)
}
