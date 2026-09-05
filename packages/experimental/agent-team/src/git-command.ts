/** Git subprocesses isolated from inherited repository-selection environment variables. */

import { execa } from 'execa'

/**
 * Run Git in the requested repository without inherited Git overrides.
 * @param cwd - repository or worktree directory.
 * @param args - literal Git arguments.
 * @param signal - operation cancellation.
 * @param timeout - maximum subprocess duration in milliseconds.
 * @returns stdout without trailing whitespace.
 */
export async function runGit(cwd: string, args: readonly string[], signal: AbortSignal, timeout: number): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const result = await execa('git', args, {
    cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    extendEnv: false,
    cancelSignal: signal,
    timeout,
  })
  return result.stdout.trimEnd()
}
