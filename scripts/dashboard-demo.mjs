/** Launch a disposable real Web dashboard populated by a controlled provider. */
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { execa } from 'execa'
import yaml from 'js-yaml'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const { values } = parseArgs({
  args,
  options: {
    port: { type: 'string', default: '49180' },
    directory: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
  },
})
const port = Number(values.port)
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error('--port must be an integer from 0 through 65535')
}
process.env.TMPDIR = '/var/tmp'
const demoRoot = values.directory === undefined
  ? await mkdtemp('/var/tmp/gasteam-dashboard-demo-')
  : resolve(values.directory)
if (!demoRoot.startsWith('/var/tmp/')) throw new Error('Dashboard demo directory must be under /var/tmp')
const home = join(demoRoot, 'home')
const repository = join(demoRoot, 'repository')
const coordinatorDirectory = join(demoRoot, 'coordinator')
const runtimeDirectory = join(demoRoot, 'external-runtime')
const profile = join(home, 'profiles', 'web')
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(repository, { recursive: true }),
  mkdir(runtimeDirectory, { recursive: true }),
])
if (!(await realpath(home)).startsWith(`${await realpath('/var/tmp')}/`)) {
  throw new Error('Dashboard demo home must resolve inside /var/tmp')
}

const env = {
  ...process.env,
  TMPDIR: '/var/tmp',
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: '',
}
function assertIsolatedHome() {
  if (typeof env.DSH_HOME !== 'string' || env.DSH_HOME.length === 0 || !env.DSH_HOME.startsWith('/var/tmp/')) {
    throw new Error('Dashboard demo DSH_HOME must be a nonempty path under /var/tmp')
  }
}
async function run(command, args, options = {}) {
  assertIsolatedHome()
  return await execa(command, args, { cwd: root, env, ...options })
}

if (!values['skip-build']) await run('pnpm', ['build'], { stdio: 'inherit' })
if (!(await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repository, reject: false })).stdout.includes('true')) {
  await run('git', ['init', '--initial-branch=main'], { cwd: repository })
  await run('git', ['config', 'user.email', 'gasteam-dashboard@example.invalid'], { cwd: repository })
  await run('git', ['config', 'user.name', 'GasTeam dashboard fixture'], { cwd: repository })
  await writeFile(join(repository, 'README.md'), '# GasTeam dashboard fixture\n')
  await run('git', ['add', 'README.md'], { cwd: repository })
  await run('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'dashboard fixture'], { cwd: repository })
}
await run('pnpm', ['install:profile', '--', '--profile', 'web'], { stdio: 'inherit' })
await writeFile(join(profile, 'dashboard-demo.patch.yml'), yaml.dump([
  { id: 'llm-deepseek', disabled: true },
  { insert: [{
    id: 'workspace-dashboard-demo',
    name: resolve(root, 'tests/fixtures/workspace-dashboard-demo.mjs'),
    config: {
      leadSessionId: 'workspace-dashboard-demo-lead',
      projectId: 'workspace-dashboard-demo',
      attemptCount: 130,
      repository,
      coordinatorDirectory,
      runtimeDirectory,
    },
  }] },
]))

console.log(`Dashboard demo data: ${demoRoot}`)
console.log('Open the private URL printed by the Web server, then select the workspace-dashboard-demo-lead session.')
const runtime = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
assertIsolatedHome()
await execa(process.execPath, [
  runtime, '--profile', 'web', '--patch', join(profile, 'dashboard-demo.patch.yml'),
  '--host', '127.0.0.1', '--port', String(port), '--no-open',
], { cwd: repository, env, stdio: 'inherit' })
