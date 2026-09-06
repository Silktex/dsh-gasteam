/** Durable coordinator index for unfinished merge-batch membership. */
import { join } from 'node:path'
import z from 'zod'
import { DurableJournal } from './durable-journal.ts'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u)
const member = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u)
const recordSchema = z.object({ id, members: z.array(member).min(1).max(64), phase: z.enum(['active', 'closed']) }).strict()
const eventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('merge-batch/admitted'), record: recordSchema }).strict(),
  z.object({ version: z.literal(1), sequence: z.number().int().positive(), type: z.literal('merge-batch/closed'), id }).strict(),
])
export type MergeBatchRegistration = z.output<typeof recordSchema>
type Event = { type: 'merge-batch/admitted'; record: MergeBatchRegistration } | { type: 'merge-batch/closed'; id: string }

/** Keeps original membership stable until each member has a terminal receipt. */
export class MergeBatchRegistry {
  private constructor(private readonly journal: DurableJournal<MergeBatchRegistration[], Event>) {}
  static async open(directory: string): Promise<MergeBatchRegistry> {
    return new MergeBatchRegistry(await DurableJournal.open<MergeBatchRegistration[], Event>(join(directory, 'merge-batches.jsonl'), [], (state, raw) => {
      const event = eventSchema.parse(raw)
      if (event.type === 'merge-batch/admitted') {
        const existing = state.find(value => value.id === event.record.id)
        if (existing) {
          if (JSON.stringify(existing.members) !== JSON.stringify(event.record.members)) throw new Error('Merge batch registry replay has different immutable membership')
          return state
        }
        if (state.some(value => value.members.some(member => event.record.members.includes(member)) && value.phase === 'active')) throw new Error('Integration already belongs to an active merge batch')
        return [...state, event.record]
      }
      const current = state.find(value => value.id === event.id)
      if (!current) throw new Error('Merge batch registry closure is absent')
      if (current.phase === 'closed') return state
      return state.map(value => value.id === event.id ? { ...value, phase: 'closed' as const } : value)
    }))
  }
  list(): MergeBatchRegistration[] { return this.journal.snapshot() }
  async admit(id: string, members: readonly string[]): Promise<MergeBatchRegistration> {
    const record = recordSchema.parse({ id, members: [...members], phase: 'active' })
    const existing = this.list().find(value => value.id === id)
    if (existing) {
      if (JSON.stringify(existing.members) !== JSON.stringify(record.members)) throw new Error('Merge batch registry admission changed immutable membership')
      return existing
    }
    return (await this.journal.append(() => ({ type: 'merge-batch/admitted', record }))).find(value => value.id === id)!
  }
  async close(id: string): Promise<void> {
    if (this.list().find(value => value.id === id)?.phase === 'closed') return
    await this.journal.append(() => ({ type: 'merge-batch/closed', id }))
  }
  closeStore(): Promise<void> { return this.journal.close() }
}
