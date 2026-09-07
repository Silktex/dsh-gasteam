/** Structured append-only error sink for autonomous diagnostics and autofixer triage. */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface StructuredErrorRecord {
  readonly timestamp: string
  readonly source: 'tool' | 'cordis' | 'session' | 'coordinator' | 'runtime' | 'system'
  readonly message: string
  readonly stack?: string | undefined
  readonly runtimeId?: string | undefined
  readonly attemptId?: string | undefined
  readonly operationId?: string | undefined
  readonly details?: Record<string, unknown> | undefined
}

export function getErrorSinkPath(): string {
  if (process.env.GASTEAM_ERROR_SINK) return process.env.GASTEAM_ERROR_SINK
  const base = process.env.TMPDIR || '/var/tmp'
  return join(base, 'gasteam-errors.jsonl')
}

export async function recordStructuredError(
  record: Omit<StructuredErrorRecord, 'timestamp'> & { timestamp?: string },
  sinkPath = getErrorSinkPath(),
): Promise<void> {
  try {
    const entry: StructuredErrorRecord = {
      timestamp: record.timestamp ?? new Date().toISOString(),
      source: record.source,
      message: record.message,
      ...(record.stack !== undefined ? { stack: record.stack } : {}),
      ...(record.runtimeId !== undefined ? { runtimeId: record.runtimeId } : {}),
      ...(record.attemptId !== undefined ? { attemptId: record.attemptId } : {}),
      ...(record.operationId !== undefined ? { operationId: record.operationId } : {}),
      ...(record.details !== undefined ? { details: record.details } : {}),
    }
    await mkdir(dirname(sinkPath), { recursive: true })
    await appendFile(sinkPath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Error sink must never throw or destabilize host/worker lifecycle
  }
}

export async function readStructuredErrors(options?: {
  since?: number
  limit?: number
  sinkPath?: string
}): Promise<StructuredErrorRecord[]> {
  const filePath = options?.sinkPath ?? getErrorSinkPath()
  try {
    const raw = await readFile(filePath, 'utf8')
    const lines = raw.split('\n').filter(line => line.trim().length > 0)
    const records: StructuredErrorRecord[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as StructuredErrorRecord
        if (options?.since !== undefined) {
          const entryTime = new Date(parsed.timestamp).getTime()
          if (Number.isFinite(entryTime) && entryTime < options.since) continue
        }
        records.push(parsed)
      } catch {
        // Ignore corrupted lines
      }
    }
    if (options?.limit !== undefined && options.limit > 0) {
      return records.slice(-options.limit)
    }
    return records
  } catch {
    return []
  }
}
