/** Native factory reducers shared by inline and versioned journal layouts. */
import { basename, join } from 'node:path'
import { DurableJournal } from '../durable-journal.ts'
import { migrateFactoryJournal, openFactoryJournalLocation } from './journal-migration.ts'
export interface FactoryJournalLimits { maxRecordBytes: number; maxJournalBytes: number }
export interface FactoryJournalMigration<State> {
  migrationId: string
  maxBytes?: number
  /** Validate all external references against stopped, trusted host stores and artifact bytes. */
  validateReferences(snapshot: State): Promise<void>
}
export async function openFactoryOwnedJournal<State, Event extends object>(
  filename: string, initial: State, reduce: (state: State, event: unknown) => State,
  parse: (line: string) => unknown, limits: FactoryJournalLimits,
): Promise<DurableJournal<State, Event>> {
  const location = await openFactoryJournalLocation(filename, limits.maxJournalBytes)
  return DurableJournal.openOwned<State, Event>(location.file, location.filename, initial, reduce, parse,
    { maxRecordBytes: limits.maxRecordBytes }, location.close)
}
export async function migrateFactoryOwnedJournal<State, Event extends object>(
  filename: string, initial: State, reduce: (state: State, event: unknown) => State,
  parse: (line: string) => unknown, limits: FactoryJournalLimits, migration: FactoryJournalMigration<State>, displayDirectory: string,
) {
  if (typeof migration?.validateReferences !== 'function') throw new Error('Offline migration requires external reference validation')
  const result = await migrateFactoryJournal(filename, { migrationId: migration.migrationId, maxBytes: Math.min(migration.maxBytes ?? 1_073_741_824, limits.maxJournalBytes),
    validate: async path => {
      const journal = await DurableJournal.open<State, Event>(path, initial, reduce, parse, { noFollow: true, maxRecordBytes: limits.maxRecordBytes })
      try { await migration.validateReferences(journal.snapshot()) } finally { await journal.close() }
    },
  })
  return { ...result, backup: join(displayDirectory, result.directory, basename(result.backup)), target: join(displayDirectory, result.directory, basename(result.target)) }
}
