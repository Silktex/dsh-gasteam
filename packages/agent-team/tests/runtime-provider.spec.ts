import { expect, it } from 'vitest'
import { RuntimeCapabilityError, requireRuntimeCapability, type RuntimeProviderCapabilities } from '../src/runtime-provider.ts'

it('advertises every provider operation and rejects an unsupported operation before launch', () => {
  const capabilities: RuntimeProviderCapabilities = {
    start: { supported: true }, resume: { supported: false, reason: 'exact durable identity is required' },
    status: { supported: true }, cancel: { supported: true }, message: { supported: false, reason: 'not supported by CLI protocol' },
    usage: { supported: false, reason: 'not reported by fixture' }, artifacts: { supported: false, reason: 'not reported by fixture' },
  }
  expect(requireRuntimeCapability(capabilities, 'start')).toEqual({ supported: true })
  expect(() => requireRuntimeCapability(capabilities, 'message')).toThrow(RuntimeCapabilityError)
  expect(() => requireRuntimeCapability(capabilities, 'message')).toThrow(/not supported by CLI protocol/)
})
