/** Build only the standalone Team packages against the pinned published runtime. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

const root = resolve(import.meta.dirname, '..')
function tsc(config) {
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-b', config], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`TypeScript failed for ${config}`)
}
tsc('tsconfig.host.json')
tsc('tsconfig.client.json')
const entries = {
  'agent-team': ['index', 'invariant', 'git-worktrees', 'git-integration', 'integration-worker', 'supervisor'],
  'tool-agent-team': ['index', 'invariant'],
  'client-ui-agent-team': ['index', 'invariant'],
  'agent-team-profile': ['index', 'invariant'],
  'agent-team-web-profile': ['index', 'invariant'],
}
for (const [pkg, files] of Object.entries(entries)) {
  for (const file of files) {
    await build({ entryPoints: [resolve(root, `packages/${pkg}/lib/types/${file}.js`)], outfile: resolve(root, `packages/${pkg}/lib/${file}.js`), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' })
  }
}
for (const [source, output] of [['typert', 'typert.host'], ['remote', 'typert.remote-client']]) {
  await build({ entryPoints: [resolve(root, `packages/agent-team/lib/types/${source}.js`)], outfile: resolve(root, `packages/agent-team/lib/${output}.js`), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' })
}
const id = '@deepseek-ai/dsh-experimental-client-ui-agent-team'
await build({
  entryPoints: [resolve(root, 'packages/client-ui-agent-team/src/client/index.ts')],
  outfile: resolve(root, 'packages/client-ui-agent-team/lib/client.js'),
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', minify: true,
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  plugins: [{
    name: 'team-css-modules',
    setup(builder) {
      builder.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
        const output = transform({ filename: path, code: await readFile(path), cssModules: true, minify: true })
        const classes = Object.fromEntries(Object.entries(output.exports).map(([key, value]) => [key, value.name]))
        return { loader: 'js', contents: `const id = ${JSON.stringify(id)}; if (!document.querySelector('style[data-plugin="' + id + '"]')) { const style = document.createElement('style'); style.dataset.plugin = id; style.textContent = ${JSON.stringify(output.code.toString())}; document.head.append(style); } export default ${JSON.stringify(classes)};` }
      })
    },
  }],
})
console.log('Built 5 Team packages with shared Remote descriptors.')
