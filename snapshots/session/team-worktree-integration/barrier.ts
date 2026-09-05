/** Deterministic Team snapshot scheduling through public Agent waterfalls. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

export const inject = ['agentTeams', 'agents']

/**
 * Hold the worker model request until spawn is logged, then await worker teardown in the Lead.
 * @param ctx - snapshot composition context.
 */
export function apply(ctx: Context): void {
  const wait = async (ready: () => boolean, signal: AbortSignal): Promise<void> => {
    if (ready()) return
    const completion = Promise.withResolvers<undefined>()
    const finish = (): void => { if (ready()) completion.resolve(undefined) }
    const disposeEvent = ctx.on('session/event', finish)
    const disposeAgent = ctx.on('agent/disposed', finish)
    const abort = (): void => { completion.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      else finish()
      await completion.promise
    } finally {
      disposeEvent()
      disposeAgent()
      signal.removeEventListener('abort', abort)
    }
  }
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const member = ctx.agentTeams.tryMembership(agent)
    if (member?.role === 'teammate') {
      await wait(() => member.root.session.events.some(event =>
        event.type === 'tool/result' && JSON.stringify(event.data).includes(agent.id)), signal)
    }
    return await next()
  })
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    if (step > 1 && ctx.agentTeams.tryMembership(agent)?.role === 'lead') {
      await wait(() => ctx.agentTeams.listMembers(agent).every(row => row.role === 'lead' || row.status === 'inactive'), signal)
    }
    return await next()
  })
}
