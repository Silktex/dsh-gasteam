/** Completion evidence must belong to the latest opened turn, not an older report. */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

export function latestTurnEnd(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'turn/end' }> | undefined {
  const startIndex = events.findLastIndex(event => event.type === 'turn/start')
  const endIndex = events.findLastIndex(event => event.type === 'turn/end')
  const start = events[startIndex]
  const end = events[endIndex]
  if (start?.type !== 'turn/start' || end?.type !== 'turn/end' || endIndex <= startIndex || end.data.turn !== start.data.turn) return undefined
  return end
}
