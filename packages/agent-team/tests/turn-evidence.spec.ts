import { expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { latestTurnEnd } from '../src/turn-evidence.ts'

it('does not reuse a completed turn after a newer turn starts and crashes', () => {
  const session = Session.create(SessionId('turn-evidence'))
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(latestTurnEnd(session.snapshotEvents())?.data).toMatchObject({ turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  expect(latestTurnEnd(session.snapshotEvents())).toBeUndefined()
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect(latestTurnEnd(session.snapshotEvents())?.data.turn).toBe(2)
})

it('rejects missing, reversed, or mismatched turn boundaries', () => {
  const session = Session.create(SessionId('invalid-turn-evidence'))
  expect(latestTurnEnd(session.snapshotEvents())).toBeUndefined()
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(latestTurnEnd(session.snapshotEvents())).toBeUndefined()
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(latestTurnEnd(session.snapshotEvents())).toBeUndefined()
})
