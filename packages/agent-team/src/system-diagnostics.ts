/** Client-safe system diagnostics schema and types. */
import type { OperatorEscalation } from './health.ts'
import type { StructuredErrorRecord } from './error-sink.ts'

export interface SystemDiagnosticsView {
  readonly projectId: string
  readonly healthy: boolean
  readonly paused: boolean
  readonly activeAttempts: number
  readonly activeEscalations: readonly OperatorEscalation[]
  readonly recentErrors: readonly StructuredErrorRecord[]
  readonly blockedDispatches: number
}
