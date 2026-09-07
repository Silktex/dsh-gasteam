/** Single-owner JSONL transactions shared by coordinator records. Ownership is acquired by the caller. */
import { mkdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
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
    private readonly release: () => Promise<void>,
  ) {}

  static async open<State, Event extends object>(
    filename: string, initial: State, reduce: (state: State, event: unknown) => State,
    parse: (line: string) => unknown = JSON.parse,
    options: { noFollow?: boolean; maxRecordBytes?: number } = {},
  ): Promise<DurableJournal<State, Event>> {
    if (options.maxRecordBytes !== undefined && (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes < 1)) throw new Error('Invalid journal record byte limit')
    await mkdir(dirname(filename), { recursive: true })
    const file = await open(filename, options.noFollow
      ? constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK
      : 'a+', 0o600)
    let adopted = false
    try {
      if (options.noFollow && !(await file.stat()).isFile()) throw new Error('Journal must be a regular owned file')
      await acquireFileOwnership(file)
      const parent = await open(dirname(filename), 'r')
      try { await parent.sync() } finally { await parent.close() }
      adopted = true
      return await DurableJournal.openOwned(file, filename, initial, reduce, parse, options, () => file.close())
    } catch (error) { if (!adopted) await file.close(); throw error }
  }

  /** Adopt an exclusively owned descriptor. The caller's lease remains held through replay and writes. */
  static async openOwned<State, Event extends object>(
    file: FileHandle, filename: string, initial: State, reduce: (state: State, event: unknown) => State,
    parse: (line: string) => unknown, options: { maxRecordBytes?: number }, release: () => Promise<void>,
  ): Promise<DurableJournal<State, Event>> {
    try {
      if (options.maxRecordBytes !== undefined && (!Number.isSafeInteger(options.maxRecordBytes) || options.maxRecordBytes < 1)) throw new Error('Invalid journal record byte limit')
      if (!(await file.stat()).isFile()) throw new Error('Journal must be a regular owned file')
      const journal = new DurableJournal<State, Event>(file, initial, reduce, release)
      const replay = (line: string | Uint8Array) => {
        const sequence = journal.sequence + 1
        try {
          const text = typeof line === 'string' ? line : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)
          const event = parse(text) as { version?: unknown; sequence?: unknown }
          if (event?.version !== 1 || event.sequence !== sequence) throw new Error('Unsupported version or non-contiguous sequence')
          journal.state = reduce(journal.state, event)
          journal.sequence++
        } catch (error) {
          throw new Error(`Invalid catalog/journal ${filename} at line ${sequence}; restore a consistent backup before restarting`, { cause: error })
        }
      }
      if (options.maxRecordBytes === undefined) {
        // Preserve the legacy parser and replay behavior for existing callers.
        let contents = ''
        for await (const chunk of file.createReadStream({ start: 0, autoClose: false, encoding: 'utf8' })) contents += chunk
        const lines = contents.split('\n')
        if (lines.pop() !== '') throw new Error(`Incomplete journal ${filename}; restore a consistent backup before restarting`)
        for (const line of lines) replay(line)
      } else {
        // Read owned file bytes incrementally; never allocate the entire journal
        // or buffer an unterminated record beyond the configured ceiling.
        const limit = options.maxRecordBytes
        const buffer = Buffer.allocUnsafe(Math.min(65_536, limit))
        const parts: Buffer[] = []
        let bytes = 0, offset = 0
        const bounded = (additional: number) => {
          if (bytes + additional + 1 > limit) throw new Error(`Invalid catalog/journal ${filename}: record byte limit exceeded; restore a consistent backup before restarting`)
        }
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          if (bytesRead === 0) break
          offset += bytesRead
          let start = 0
          for (let index = 0; index < bytesRead; index++) {
            if (buffer[index] !== 0x0a) continue
            const segment = buffer.subarray(start, index)
            bounded(segment.length)
            replay(parts.length ? Buffer.concat([...parts, segment], bytes + segment.length) : segment)
            parts.length = 0; bytes = 0; start = index + 1
          }
          if (start < bytesRead) {
            bounded(bytesRead - start)
            parts.push(Buffer.from(buffer.subarray(start, bytesRead)))
            bytes += bytesRead - start
          }
        }
        if (bytes) throw new Error(`Incomplete journal ${filename}; restore a consistent backup before restarting`)
      }
      return journal
    } catch (error) { await release(); throw error }
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
    return this.closing ??= this.pending.then(this.release)
  }
}
