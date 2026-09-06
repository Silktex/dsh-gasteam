import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MergeBatchRegistry } from '../src/merge-batch-registry.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'gasteam-merge-registry-')); roots.push(root); return root }

it('retains original active membership across restart and releases later bounded work only after closure', async () => {
  const root = await fixture()
  const first = await MergeBatchRegistry.open(root)
  await first.admit('batch-first', ['integration-1', 'integration-2'])
  await expect(first.admit('batch-later', ['integration-2', 'integration-3'])).rejects.toThrow(/already belongs/)
  await first.closeStore()
  const restored = await MergeBatchRegistry.open(root)
  expect(restored.list()).toEqual([{ id: 'batch-first', members: ['integration-1', 'integration-2'], phase: 'active' }])
  await restored.close('batch-first')
  await expect(restored.admit('batch-later', ['integration-3', 'integration-4'])).resolves.toMatchObject({ phase: 'active' })
  await restored.closeStore()
})

it('rejects changed membership for the same durable batch identity', async () => {
  const root = await fixture()
  const registry = await MergeBatchRegistry.open(root)
  await registry.admit('batch', ['integration-1'])
  await expect(registry.admit('batch', ['integration-2'])).rejects.toThrow(/immutable membership/)
  await registry.closeStore()
})
