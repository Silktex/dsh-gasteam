import z from 'zod'

/** Immutable delivery budget for an interrupted runtime. It excludes initial generation. */
export const assignmentRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(100),
  initialDelayMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  multiplier: z.number().min(1).max(1_000_000),
  maxDelayMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()
export type AssignmentRetryPolicy = z.output<typeof assignmentRetryPolicySchema>

/** Published behavior: recovery deliveries occur after 1, 2, 4 seconds. */
export const legacyAssignmentRetryPolicy: AssignmentRetryPolicy = {
  maxAttempts: 3, initialDelayMs: 1_000, multiplier: 2, maxDelayMs: Number.MAX_SAFE_INTEGER,
}

export function nextAssignmentRetryAt(policy: AssignmentRetryPolicy, attemptsUsed: number, clock: number): number {
  const checked = assignmentRetryPolicySchema.parse(policy)
  if (!Number.isInteger(attemptsUsed) || attemptsUsed < 0) throw new Error('Retry attempts used must be a non-negative integer')
  // Avoid zero times an overflowing exponent becoming NaN for a valid policy.
  const delay = checked.initialDelayMs === 0 ? 0 : Math.min(checked.maxDelayMs, checked.initialDelayMs * checked.multiplier ** attemptsUsed)
  return Math.min(Number.MAX_SAFE_INTEGER, clock + delay)
}
