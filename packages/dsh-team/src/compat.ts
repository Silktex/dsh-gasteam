import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

const teamSessionEventTypes = [
  'team/batch',
  'team/integration',
  'team/recovery',
  'team/worktree',
] as const

// DSH 0.1.2-rc.1 validates durable event names against this exported registry.
// Register the Team event family as soon as the bundle module is imported.
const registry = KNOWN_SESSION_EVENT_TYPES as Set<string>
for (const eventType of teamSessionEventTypes) registry.add(eventType)

export const name = 'dsh-team-compat'

export function apply(): void {}
