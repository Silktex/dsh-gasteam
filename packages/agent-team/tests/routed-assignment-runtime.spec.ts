import { expect, it } from 'vitest'
import { RoutedExternalAssignmentRuntime } from '../src/routed-assignment-runtime.ts'

it('advertises only operations supported by the routed external provider and names host-mediated artifacts', () => {
  const runtime = new RoutedExternalAssignmentRuntime({} as never)
  expect(runtime.capabilities).toMatchObject({
    start: { supported: true }, status: { supported: true }, cancel: { supported: true }, usage: { supported: true }, artifacts: { supported: true },
    resume: { supported: false }, message: { supported: false },
  })
  expect(runtime.capabilities.artifacts).toMatchObject({ conditions: ['host-mediated immutable code worktree submission'] })
})
