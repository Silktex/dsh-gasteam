/** Single-owner JSONL transactions shared by coordinator records. Ownership is acquired by the caller. */
import { mkdir, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { acquireFileOwnership } from './file-ownership.ts'

export class DurableJournal<State, Event extends object> {
  private sequence = 0
  private pending: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private uncertain = false

  private constructor(
    private readonly file: FileHandle,
    private state: State,
    private readonly reduce: (state: State, event: unknown) => State,
  ) {}

  static async open<State, Event extends object>(
    filename: string, initial: State, reduce: (state: State, event: unknown) => State,
  ): Promise<DurableJournal<State, Event>> {
    await mkdir(dirname(filename), { recursive: true })
    const file = await open(filename, 'a+', 0o600)
    try {
      await acquireFileOwnership(file)
      const parent = await open(dirname(filename), 'r')
      try { await parent.sync() } finally { await parent.close() }
      const journal = new DurableJournal<State, Event>(file, initial, reduce)
      const lines = (await file.readFile('utf8')).split('\n')
      if (lines.pop() !== '') throw new Error(`Incomplete journal ${filename}; restore a consistent backup before restarting`)
      for (const [index, line] of lines.entries()) {
        try {
          const event = JSON.parse(line) as { version?: unknown; sequence?: unknown }
          if (event?.version !== 1 || event.sequence !== index + 1) throw new Error('Unsupported version or non-contiguous sequence')
          journal.state = reduce(journal.state, event)
          journal.sequence++
        } catch (error) {
          throw new Error(`Invalid catalog/journal ${filename} at line ${index + 1}; restore a consistent backup before restarting`, { cause: error })
        }
      }
      return journal
    } catch (error) { await file.close(); throw error }
  }

  snapshot(): State { return structuredClone(this.state) }

  /** Validation precedes the write; a synced event precedes publication of the new state. */
  async append(make: (state: State, sequence: number) => Event | Promise<Event>): Promise<State> {
    if (this.closing !== undefined) throw new Error('Durable journal is closed')
    const operation = this.pending.then(async () => {
      if (this.uncertain) throw new Error('Journal write is uncertain; close and reconcile before accepting work')
      const sequence = this.sequence + 1
      const event = { ...await make(structuredClone(this.state), sequence), version: 1, sequence }
      const next = this.reduce(this.state, event)
      try {
        await this.file.writeFile(`${JSON.stringify(event)}\n`)
        await this.file.sync()
      } catch (error) { this.uncertain = true; throw error }
      this.state = next
      this.sequence = sequence
      return this.snapshot()
    })
    this.pending = operation.catch(() => {})
    return operation
  }

  close(): Promise<void> {
    return this.closing ??= this.pending.then(async () => { await this.file.close() })
  }
}
