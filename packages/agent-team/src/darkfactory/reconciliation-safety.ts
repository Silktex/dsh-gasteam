/** Host repository binding and bounded credential redaction for provider enrichment. */
import { runGit } from '../git-command.ts'

export async function assertGithubRepository(repository: string, expectedName: string): Promise<void> {
  let origin: string
  try { origin = await runGit(repository, ['remote', 'get-url', 'origin'], new AbortController().signal, 5000) } catch { throw new Error('Reconciliation requires a registered GitHub origin') }
  let name: string | undefined
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin)
  if (ssh) name = ssh[1]
  else {
    try {
      const url = new URL(origin)
      if ((url.protocol === 'https:' || url.protocol === 'ssh:') && url.hostname === 'github.com' && !url.password && !url.search && !url.hash && !url.port && (url.username === '' || (url.protocol === 'ssh:' && url.username === 'git'))) {
        name = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url.pathname)?.[1]
      }
    } catch { /* Unrecognized remotes cannot establish this provider binding. */ }
  }
  if (!name || name.toLowerCase() !== expectedName.toLowerCase()) throw new Error('Reconciliation repository does not match the registered GitHub origin')
}

/** This does not classify arbitrary confidential prose; known host credentials and common credential formats are removed. */
export function redactProviderText(text: string, secrets: readonly string[]): string {
  let value = text
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]')
  return value
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, '[redacted private key]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted token]')
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*[=:]\s*)[^\s,;"'<>]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}
