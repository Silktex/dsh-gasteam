import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

const root = resolve(import.meta.dirname, '..')
const packageSource = resolve(root, 'packages/dsh-team')
const internalPackage = '@deepseek-ai/dsh-experimental-agent-team'

const internalEntries = new Map([
  [internalPackage, resolve(root, 'packages/agent-team/src/index.ts')],
  [`${internalPackage}/client`, resolve(root, 'packages/agent-team/src/client.ts')],
  [`${internalPackage}/coordinator`, resolve(root, 'packages/agent-team/src/coordinator.ts')],
  [`${internalPackage}/remote`, resolve(root, 'packages/agent-team/src/remote.ts')],
  [`${internalPackage}/types`, resolve(root, 'packages/agent-team/src/types.ts')],
])

const aliasInternalPackage = {
  name: 'dsh-team-internal-package',
  setup(builder) {
    builder.onResolve({ filter: /^@deepseek-ai\/dsh-experimental-agent-team(?:\/.*)?$/ }, ({ path }) => {
      const resolved = internalEntries.get(path)
      if (!resolved) throw new Error(`No dsh-team distribution alias for ${path}`)
      return { path: resolved }
    })
  },
}

const browserExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

function sourceCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to determine source commit')
  return result.stdout.trim()
}

async function copyDistributionSources(output) {
  await cp(resolve(root, 'packages/agent-team/src'), resolve(output, 'src/agent-team'), { recursive: true })
  await cp(resolve(root, 'packages/tool-agent-team/src'), resolve(output, 'src/tool-agent-team'), { recursive: true })
  await cp(resolve(root, 'packages/client-ui-agent-team/src'), resolve(output, 'src/client-ui-agent-team'), { recursive: true })
  await cp(resolve(packageSource, 'src'), resolve(output, 'src/distribution'), { recursive: true })
}

/** Emit the actual SDK declaration closure, independently of a preceding build.
 * Only declaration files ship here; runtime imports still use DSH singleton peers.
 */
async function buildHostDeclarations(output) {
  const directory = resolve(output, 'lib/types')
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'),
    '-p', resolve(root, 'packages/agent-team/tsconfig.json'), '--emitDeclarationOnly',
    '--composite', 'false', '--incremental', 'false', '--outDir', directory,
  ], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('dsh-team SDK declaration emission failed')
  async function rewrite(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = resolve(directory, entry.name)
      if (entry.isDirectory()) await rewrite(filename)
      else if (entry.name.endsWith('.d.ts')) {
        const source = await readFile(filename, 'utf8')
        // TypeScript preserves source .ts specifiers in declarations even when
        // rewriteRelativeImportExtensions rewrites JS. Published declarations
        // resolve beside .d.ts siblings through ordinary .js substitution.
        const rewritten = source.replace(/((?:from\s+|import\s*\(\s*|import\s+|declare\s+module\s+)["'])(\.[^"']+)\.tsx?(["'])/g, '$1$2.js$3')
        if (rewritten !== source) await writeFile(filename, rewritten)
      }
    }
  }
  await rewrite(directory)
}

async function buildHost(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    plugins: [aliasInternalPackage],
  })
}

async function buildClient(outfile, remoteSource) {
  const id = 'dsh-team'
  await build({
    entryPoints: [resolve(root, 'packages/client-ui-agent-team/src/client/index.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    jsx: 'automatic',
    external: browserExternals,
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.MODE': '"production"',
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
    },
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
    plugins: [
      {
        name: 'dsh-team-browser-remote',
        setup(builder) {
          builder.onResolve({ filter: /^@deepseek-ai\/dsh-experimental-agent-team\/remote$/ }, () => ({
            path: 'remote',
            namespace: 'dsh-team-generated',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'dsh-team-generated' }, () => ({
            contents: remoteSource,
            loader: 'js',
            resolveDir: root,
          }))
        },
      },
      aliasInternalPackage,
      {
        name: 'dsh-team-css-modules',
        setup(builder) {
          builder.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
            const output = transform({ filename: path, code: await readFile(path), cssModules: true, minify: true })
            const classes = Object.fromEntries(Object.entries(output.exports).map(([key, value]) => [key, value.name]))
            const styleId = Object.values(classes)[0] ?? basename(path)
            const contents = `const id = ${JSON.stringify(id)}, styleId = ${JSON.stringify(styleId)}; if (!document.querySelector('style[data-plugin="' + id + '"][data-style="' + styleId + '"]')) { const style = document.createElement('style'); style.dataset.plugin = id; style.dataset.style = styleId; style.textContent = ${JSON.stringify(output.code.toString())}; document.head.append(style); } export default ${JSON.stringify(classes)};`
            return { loader: 'js', contents }
          })
        },
      },
    ],
  })
}

export async function buildDshTeamDistribution(requestedOutput) {
  const output = requestedOutput
    ? resolve(requestedOutput)
    : await mkdtemp(join(tmpdir(), 'dsh-team-distribution-'))

  if (requestedOutput) await mkdir(output, { recursive: false })
  await mkdir(resolve(output, 'lib'))

  for (const file of ['package.json', 'cordis.patch.yml', 'README.md']) {
    await cp(resolve(packageSource, file), resolve(output, file))
  }
  await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
  await mkdir(resolve(output, 'docs'))
  await Promise.all([
    cp(resolve(root, 'docs/evidence/dashboard/controls.png'), resolve(output, 'docs/dashboard-controls.png')),
    cp(resolve(root, 'docs/evidence/dashboard/activity.png'), resolve(output, 'docs/dashboard-activity.png')),
  ])
  await copyDistributionSources(output)
  await buildHostDeclarations(output)

  const commit = sourceCommit()
  await writeFile(resolve(output, 'SOURCE.md'), `# Distribution source\n\nThis install-ready package was generated from [Silktex/dsh-gasteam](https://github.com/Silktex/dsh-gasteam/tree/${commit}) at commit \`${commit}\`. The matching TypeScript source snapshot is included under \`src/\`.\n`)
  await writeFile(resolve(output, '.gitignore'), 'node_modules/\n.pnpm-store/\n')

  const hostEntries = {
    index: resolve(packageSource, 'src/index.ts'),
    compat: resolve(packageSource, 'src/compat.ts'),
    core: resolve(root, 'packages/agent-team/src/index.ts'),
    tools: resolve(root, 'packages/tool-agent-team/src/index.ts'),
    'coordinator-tools': resolve(root, 'packages/tool-agent-team/src/coordinator.ts'),
    'git-worktrees': resolve(root, 'packages/agent-team/src/git-worktrees.ts'),
    'git-integration': resolve(root, 'packages/agent-team/src/git-integration.ts'),
    'integration-worker': resolve(root, 'packages/agent-team/src/integration-worker.ts'),
    supervisor: resolve(root, 'packages/agent-team/src/supervisor.ts'),
    'external-runtime-supervisor': resolve(root, 'packages/agent-team/src/external-runtime-supervisor.ts'),
    coordinator: resolve(root, 'packages/agent-team/src/coordinator.ts'),
    darkfactory: resolve(root, 'packages/agent-team/src/darkfactory.ts'),
    remote: resolve(root, 'packages/agent-team/src/remote.ts'),
  }

  await Promise.all(Object.entries(hostEntries).map(([name, entry]) => buildHost(entry, resolve(output, `lib/${name}.js`))))
  // The first pass removes host-only implementation imports from the Remote
  // descriptor graph before the descriptor is embedded in the browser bundle.
  const remoteSource = await readFile(resolve(output, 'lib/remote.js'), 'utf8')
  await buildClient(resolve(output, 'lib/client.js'), remoteSource)

  return output
}

function requestedOutput() {
  const index = process.argv.indexOf('--output')
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value) throw new Error('--output requires a path')
  return value
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = await buildDshTeamDistribution(requestedOutput())
  console.log(output)
}
