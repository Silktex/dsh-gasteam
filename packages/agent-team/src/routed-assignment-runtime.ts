/** Shared coordinator-facing contract; provider internals retain their own durable semantics. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttemptRecord } from './assignments.ts'
import type { DshAssignmentRuntime } from './dsh-assignment-runtime.ts'
import type { ExternalNonCodeAssignmentAdapter } from './external-assignment-adapter.ts'
import { requireRuntimeCapability } from './runtime-provider.ts'
import type { RuntimeProviderCapabilities } from './runtime-provider.ts'

export interface RoutedAssignmentRuntime {
  readonly capabilities: RuntimeProviderCapabilities
  start(lead: Agent, record: AttemptRecord): Promise<AttemptRecord>
  observe(lead: Agent, record: AttemptRecord): Promise<AttemptRecord>
  cancel(lead: Agent, record: AttemptRecord, reason: string): Promise<AttemptRecord>
}
const token = (record: AttemptRecord) => ({ attemptId: record.attemptId, generation: record.generation, expectedRevision: record.revision })
export class RoutedDshAssignmentRuntime implements RoutedAssignmentRuntime {
  readonly capabilities: RuntimeProviderCapabilities = {
    start: { supported: true }, resume: { supported: false, reason: 'coordinator recovery observes an existing DSH identity; it does not resume a new turn' }, status: { supported: true }, cancel: { supported: true },
    message: { supported: false, reason: 'the routed lifecycle has no direct message operation' }, usage: { supported: false, reason: 'DSH assignment runtime has no provider usage receipt' }, artifacts: { supported: true, conditions: ['host-managed Team/Git artifacts'] },
  }
  constructor(private readonly runtime: DshAssignmentRuntime) {}
  start(lead: Agent, record: AttemptRecord) { requireRuntimeCapability(this.capabilities, 'start'); return this.runtime.start(lead, token(record)) }
  observe(lead: Agent, record: AttemptRecord) { requireRuntimeCapability(this.capabilities, 'status'); return this.runtime.observe(lead, token(record)) }
  cancel(lead: Agent, record: AttemptRecord, reason: string) { requireRuntimeCapability(this.capabilities, 'cancel'); return this.runtime.cancel(lead, token(record), reason) }
}
export class RoutedExternalAssignmentRuntime implements RoutedAssignmentRuntime {
  readonly capabilities: RuntimeProviderCapabilities = {
    start: { supported: true }, resume: { supported: false, reason: 'routed external assignments do not resume a live Codex turn' }, status: { supported: true }, cancel: { supported: true },
    message: { supported: false, reason: 'Codex exec JSONL has no documented active-turn message protocol' }, usage: { supported: true, conditions: ['provider-reported completed-turn receipt only'] }, artifacts: { supported: true, conditions: ['host-mediated immutable code worktree submission'] },
  }
  constructor(private readonly runtime: ExternalNonCodeAssignmentAdapter) {}
  start(_lead: Agent, record: AttemptRecord) { requireRuntimeCapability(this.capabilities, 'start'); return this.runtime.start(record) }
  observe(_lead: Agent, record: AttemptRecord) { requireRuntimeCapability(this.capabilities, 'status'); return this.runtime.observe(record) }
  cancel(_lead: Agent, record: AttemptRecord, reason: string) { requireRuntimeCapability(this.capabilities, 'cancel'); return this.runtime.cancel(record, reason) }
}
