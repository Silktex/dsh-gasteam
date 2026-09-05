import { expect, it } from 'vitest'
import { legacyAssignmentRetryPolicy, nextAssignmentRetryAt } from '../src/assignment-retry-policy.ts'

it('keeps the published 1/2/4 second recovery-delivery schedule', () => {
  expect([0, 1, 2].map(used => nextAssignmentRetryAt(legacyAssignmentRetryPolicy, used, 10_000))).toEqual([11_000, 12_000, 14_000])
})

it('caps exponential delays and rejects a negative delivery count', () => {
  const policy = { maxAttempts: 7, initialDelayMs: 50, multiplier: 3, maxDelayMs: 200 }
  expect(nextAssignmentRetryAt(policy, 3, 9)).toBe(209)
  expect(() => nextAssignmentRetryAt(policy, -1, 9)).toThrow(/non-negative/)
})

it('keeps a valid zero initial delay at zero even when exponentiation overflows', () => {
  expect(nextAssignmentRetryAt({ maxAttempts: 100, initialDelayMs: 0, multiplier: 1_000_000, maxDelayMs: 10 }, 99, 42)).toBe(42)
})
