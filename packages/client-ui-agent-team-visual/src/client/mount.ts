/** Source-safe GasView visual agents browser registration; consumes the mounted Team Remote. */

import type {} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  VisualAgentsAction, type TeamVisualActionInjected, type TeamVisualActionResult,
} from './VisualAgentsAction.tsx'
import { en, NS, zh, type TeamVisualKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GasView visual agents overlay copy. */
    'agent-team-visual': TeamVisualKey
  }
}

/** Required browser services for RPC, navigation, slots, and localized copy. */
export const inject = ['sessions', 'remote', 'slots', 'locale']

function registerUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-team-visual: dictionaries')
  const sessions = ctx.sessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  const injected: TeamVisualActionInjected = {
    async load(sessionId): Promise<TeamVisualActionResult> {
      return await ctx.remote.agentTeams.workspaceDashboard(leadSessionId(sessionId), {})
    },
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team-visual',
      order: 22,
      locale: NS,
      inject: () => injected,
    }, VisualAgentsAction),
  )
}

/**
 * Register the visual agents browser UI against the already-mounted Team Remote.
 * The `remote.agentTeams` inject constraint makes cordis enforce that the Team
 * Remote is present first (web-profile patch ordering guarantees this).
 * @param ctx - Client Context carrying navigation, locale, slot, and Remote services.
 * @returns disposer for the UI registrations.
 */
export async function mountAgentTeamVisualUi(ctx: ClientContext): Promise<() => Promise<void>> {
  const ui = ctx.inject(['sessions', 'remote.agentTeams', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    throw error
  }
  return async () => {
    await ui.dispose()
  }
}
