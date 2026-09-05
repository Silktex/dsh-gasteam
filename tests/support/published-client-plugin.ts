/** Exercise published browser factories as ESM inside Vitest's jsdom program. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
const require = createRequire(import.meta.url)
const prefix = '\0published-client:'
export function publishedClientPlugin(): Plugin {
  return {
    name: 'published-client-factories', enforce: 'pre',
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/') || !source.endsWith('/client')) return
      const path = require.resolve(source)
      const code = readFileSync(path, 'utf8')
      return code.startsWith('window.__ModuleLoader__.load(') ? prefix + path : undefined
    },
    load(id) {
      if (!id.startsWith(prefix)) return
      const code = readFileSync(id.slice(prefix.length), 'utf8')
      const start = code.indexOf('factory: (require) => {') + 'factory: (require) => {'.length
      const end = code.lastIndexOf('return module.exports;')
      if (start < 22 || end < start) throw new Error(`Unsupported browser factory: ${id}`)
      const body = code.slice(start, end)
      const dependencies = [...new Set([...body.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map(match => match[1]!))]
      const exports = [...new Set([...body.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)].map(match => match[1]!))]
      const imports = dependencies.map((dependency, index) => `import * as dep${index} from ${JSON.stringify(dependency)};`).join('\n')
      const table = dependencies.map((dependency, index) => `${JSON.stringify(dependency)}: dep${index}`).join(',')
      return `${imports}\nconst require = id => ({${table}})[id];\n${body}\n${exports.map(name => `const export_${name} = module.exports.${name}; export { export_${name} as ${name} };`).join('\n')}`
    },
  }
}
