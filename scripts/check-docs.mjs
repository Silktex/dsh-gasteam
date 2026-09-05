/** Check local Markdown links and syntax-check explicitly fenced shell examples. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))
const docsRoot = join(root, 'docs')
const failures = []

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

const files = [join(root, 'readme.md'), ...(await markdownFiles(docsRoot))]
for (const file of files) {
  const source = await readFile(file, 'utf8')
  const links = [...source.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/g)].map(match => match[1].trim())
  for (const rawTarget of links) {
    const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue
    const pathTarget = target.split('#', 1)[0].split('?', 1)[0]
    if (pathTarget === '') continue
    let decodedPath
    try { decodedPath = decodeURIComponent(pathTarget) } catch {
      failures.push(`${relative(root, file)}: malformed encoded link target ${target}`)
      continue
    }
    const resolved = resolve(dirname(file), decodedPath)
    try {
      await stat(resolved)
    } catch {
      failures.push(`${relative(root, file)}: missing link target ${target}`)
    }
  }

  const fences = [...source.matchAll(/```(sh|bash)\n([\s\S]*?)\n```/g)]
  for (const [, language, body] of fences) {
    const result = spawnSync('bash', ['-n'], { input: `${body}\n`, encoding: 'utf8' })
    if (result.error) failures.push(`${relative(root, file)}: cannot syntax-check ${language} fence: ${result.error.message}`)
    else if (result.status !== 0) failures.push(`${relative(root, file)}: invalid ${language} fence: ${result.stderr.trim()}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Documentation checks passed: ${files.length} Markdown files, local links, and shell syntax fences.`)
}
