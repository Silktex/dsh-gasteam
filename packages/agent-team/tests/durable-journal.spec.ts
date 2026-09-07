import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DurableJournal } from '../src/durable-journal.ts'
import { acquireFileOwnership } from '../src/file-ownership.ts'

it.each([undefined, 1024])('replays an adopted descriptor from byte zero with record limit %s and retains append ownership', async maxRecordBytes => {
  const root = await mkdtemp(join(tmpdir(), 'adopted-journal-')), filename = join(root, 'journal.jsonl')
  const file = await open(filename, 'a+', 0o600)
  let journal: DurableJournal<string[], { value: string }> | undefined, releases = 0
  try {
    await acquireFileOwnership(file)
    const original = JSON.stringify({ version: 1, sequence: 1, value: 'retained Ω' }) + '\n'
    await file.writeFile(original)
    journal = await DurableJournal.openOwned(file, filename, [] as string[], (state, raw) => [...state, (raw as { value: string }).value], JSON.parse,
      { maxRecordBytes }, async () => { releases++; await file.close() })
    expect(journal.snapshot()).toEqual(['retained Ω'])
    await journal.append(() => ({ value: 'appended' }))
    expect(journal.snapshot()).toEqual(['retained Ω', 'appended'])
    await journal.close()
    expect(releases).toBe(1)
    expect(await readFile(filename, 'utf8')).toBe(original + JSON.stringify({ value: 'appended', version: 1, sequence: 2 }) + '\n')
  } finally {
    if (journal) await journal.close()
    else if (!releases) await file.close()
    await rm(root, { recursive: true, force: true })
  }
})
