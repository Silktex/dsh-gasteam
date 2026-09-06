/** Browser entry binding the GasView visual agents UI to the already-mounted Team Remote. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { mountAgentTeamVisualUi } from './mount.ts'

export { inject } from './mount.ts'
export type { TeamVisualActionInjected, TeamVisualActionProps, TeamVisualActionResult } from './VisualAgentsAction.tsx'
export type { TeamVisualKey } from './locales.ts'

/** Mount the visual agents browser UI consuming the already-mounted Team Remote. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountAgentTeamVisualUi(ctx)
}
