import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recordStructuredError, readStructuredErrors } from '../src/error-sink.ts'

describe('StructuredErrorSink', () => {
  it('appends and reads structured error entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'error-sink-test-'))
    const sinkPath = join(dir, 'test-errors.jsonl')
    try {
      await recordStructuredError({
        source: 'tool',
        message: 'Tool execution timed out',
        stack: 'Error: Tool execution timed out\n  at run (tool.ts:42:10)',
        runtimeId: 'agent-worker-1',
        operationId: 'op-100',
      }, sinkPath)

      await recordStructuredError({
        source: 'coordinator',
        message: 'flock contention timeout',
        details: { targetBranch: 'master', lockKey: 'abc123' },
      }, sinkPath)

      const records = await readStructuredErrors({ sinkPath })
      expect(records).toHaveLength(2)
      expect(records[0]?.source).toBe('tool')
      expect(records[0]?.message).toBe('Tool execution timed out')
      expect(records[0]?.runtimeId).toBe('agent-worker-1')
      expect(records[0]?.operationId).toBe('op-100')
      expect(records[1]?.source).toBe('coordinator')
      expect(records[1]?.message).toBe('flock contention timeout')
      expect(records[1]?.details).toEqual({ targetBranch: 'master', lockKey: 'abc123' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('filters by since timestamp and limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'error-sink-test-'))
    const sinkPath = join(dir, 'test-errors.jsonl')
    try {
      const t1 = new Date(Date.now() - 60_000).toISOString()
      const t2 = new Date(Date.now() - 30_000).toISOString()
      const t3 = new Date().toISOString()

      await recordStructuredError({ timestamp: t1, source: 'system', message: 'Old error' }, sinkPath)
      await recordStructuredError({ timestamp: t2, source: 'system', message: 'Mid error' }, sinkPath)
      await recordStructuredError({ timestamp: t3, source: 'system', message: 'New error' }, sinkPath)

      const recent = await readStructuredErrors({
        sinkPath,
        since: Date.now() - 45_000,
      })
      expect(recent).toHaveLength(2)
      expect(recent.map(r => r.message)).toEqual(['Mid error', 'New error'])

      const limited = await readStructuredErrors({ sinkPath, limit: 1 })
      expect(limited).toHaveLength(1)
      expect(limited[0]?.message).toBe('New error')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
