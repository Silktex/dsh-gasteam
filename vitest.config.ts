import { publishedClientPlugin } from './tests/support/published-client-plugin.ts'
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
const paths = JSON.parse(readFileSync('tsconfig.base.json', 'utf8')).compilerOptions.paths as Record<string, string[]>
const alias = Object.entries(paths).map(([find, paths]) => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement: resolve(paths[0]!) }))
export default defineConfig({
  resolve: { alias },
  plugins: [publishedClientPlugin(), {
    name: 'standard-decorators', enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?tsx?$/.test(id) || !/^\s*@[A-Za-z_$]/m.test(code)) return
      const result = ts.transpileModule(code, { fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } })
      return { code: result.outputText, map: null }
    },
  }],
  test: {
    testTimeout: 15000, hookTimeout: 15000,
    server: { deps: { inline: [/@deepseek-ai\//, /published-client:/] } },
    projects: [
      { extends: true, test: { name: 'host', include: ['packages/*/tests/**/*.spec.ts', 'tests/**/*.spec.ts'], exclude: ['**/*.client.spec.ts'] } },
      { extends: true, test: { name: 'client', environment: 'jsdom', include: ['packages/*/tests/**/*.client.spec.ts', 'packages/*/tests/**/*.client.spec.tsx'] } },
    ],
  },
})
