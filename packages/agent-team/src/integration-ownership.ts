/** Repository/target exclusion shared across Teams, worktrees, and server processes. */
import { createHash } from 'node:crypto'
import { mkdir, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireFileOwnership } from './file-ownership.ts'
import { runGit } from './git-command.ts'
import { TeamError } from './error.ts'

export async function acquireIntegrationOwnership(repository: string, targetBranch: string, signal: AbortSignal): Promise<() => Promise<void>> {
  signal.throwIfAborted()
  const common = await realpath(await runGit(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal, 30_000))
  const directory = join(common, 'gasteam-integration-locks')
  await mkdir(directory, { recursive: true })
  const key = createHash('sha256').update(targetBranch).digest('hex')
  const file = await open(join(directory, `${key}.lock`), 'a+', 0o600)
  try {
    try { await acquireFileOwnership(file) }
    catch (error) {
      if (error instanceof Error && error.message.includes('already owned')) throw new TeamError('Repository/target integration is busy', 'TEAM_INTEGRATION_BUSY')
      throw error
    }
    signal.throwIfAborted()
    let closing: Promise<void> | undefined
    return () => closing ??= file.close()
  } catch (error) { await file.close(); throw error }
}
