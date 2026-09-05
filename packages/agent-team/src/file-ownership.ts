/** Linux advisory locks tied to the owning process's open file description, not expiring PID files. */
import type { FileHandle } from 'node:fs/promises'
import { spawn } from 'node:child_process'

/** The inherited fd shares its flock with the parent; closing the parent's handle releases ownership. */
export async function acquireFileOwnership(file: FileHandle): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Autonomous journal ownership requires Linux and util-linux flock')
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('flock', ['--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', file.fd], timeout: 5_000,
    })
    child.once('error', error => reject(new Error('Cannot acquire journal ownership; install util-linux flock', { cause: error })))
    child.once('close', code => resolve(code))
  })
  if (code === 1) throw new Error('Durable journal is already owned by another instance')
  if (code !== 0) throw new Error(`Cannot acquire journal ownership; util-linux flock exited with ${code}`)
}
