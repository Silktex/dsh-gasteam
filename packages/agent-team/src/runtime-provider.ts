/** Explicit external-runtime contract. Callers must reject unsupported work before admitting an attempt. */
export const runtimeOperations = ['start', 'resume', 'status', 'cancel', 'message', 'usage', 'artifacts'] as const
export type RuntimeOperation = typeof runtimeOperations[number]

export type RuntimeCapability =
  | { supported: true; conditions?: readonly string[] }
  | { supported: false; reason: string }

export type RuntimeProviderCapabilities = Record<RuntimeOperation, RuntimeCapability>

export interface RuntimeAttemptRef {
  attemptId: string
  generation: number
}

export interface RuntimeStartRequest extends RuntimeAttemptRef {
  cwd: string
  prompt: object
}

export interface RuntimeResumeRequest extends RuntimeStartRequest {
  /** Runtime-specific durable identity. Never substitute a most-recent session. */
  threadId: string
  /** A receipt proves the previous process ended before another turn is sent. */
  quiescentReceipt: string | undefined
}

export interface RuntimeLaunch {
  readonly argv: readonly string[]
  readonly stdin: string
  readonly runtimeIdentity: Readonly<Record<string, string | number>>
}

export interface RuntimeProvider {
  readonly id: string
  readonly capabilities: RuntimeProviderCapabilities
  start(request: RuntimeStartRequest): Promise<RuntimeLaunch>
  resume(request: RuntimeResumeRequest): Promise<RuntimeLaunch>
}

export class RuntimeCapabilityError extends Error {
  constructor(operation: RuntimeOperation, reason: string) {
    super(`Runtime operation ${operation} is unsupported: ${reason}`)
    this.name = 'RuntimeCapabilityError'
  }
}

export function requireRuntimeCapability(capabilities: RuntimeProviderCapabilities, operation: RuntimeOperation): RuntimeCapability {
  const capability = capabilities[operation]
  if (!capability.supported) throw new RuntimeCapabilityError(operation, capability.reason)
  return capability
}
