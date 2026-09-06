/** Build the one-package distribution and install it from Git into a clean DSH web profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildDshTeamDistribution } from './build-dsh-team-distribution.mjs'

const repository = resolve(import.meta.dirname, '..')
const testRoot = resolve(process.env.DSH_TEAM_TEST_ROOT ?? tmpdir())
await mkdir(testRoot, { recursive: true })
const runRoot = await mkdtemp(join(testRoot, 'dsh-team-git-install-'))
const distribution = join(runRoot, 'distribution')
const consumer = join(runRoot, 'consumer')
const dshHome = join(runRoot, 'dsh-home')
await Promise.all([mkdir(consumer), mkdir(dshHome)])

async function command(executable, args, options = {}) {
  console.log(`+ ${executable} ${args.join(' ')}`)
  return await new Promise((accept, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk); process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk); process.stderr.write(chunk) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept({ stdout, stderr })
      else reject(new Error(`${executable} exited ${code ?? signal}\n${stdout}\n${stderr}`))
    })
  })
}

async function bootWebProfile(environment) {
  console.log('+ pnpm exec dsh --profile web --no-open --port 0')
  await new Promise((accept, reject) => {
    const child = spawn('pnpm', ['exec', 'dsh', '--profile', 'web', '--no-open', '--port', '0'], {
      cwd: consumer,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let ready = false
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    const observe = chunk => {
      output += String(chunk)
      process.stdout.write(chunk)
      if (!ready && output.includes('dsh web: http://')) {
        ready = true
        child.kill('SIGTERM')
      }
    }
    child.stdout.on('data', observe)
    child.stderr.on('data', observe)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (ready) accept()
      else reject(new Error(`DSH web profile failed before readiness (${code ?? signal})\n${output}`))
    })
  })
}

await buildDshTeamDistribution(distribution)
await command('git', ['init', '--initial-branch=main'], { cwd: distribution })
await command('git', ['config', 'user.email', 'dsh-team-test@example.invalid'], { cwd: distribution })
await command('git', ['config', 'user.name', 'dsh-team distribution test'], { cwd: distribution })
await command('git', ['config', 'commit.gpgsign', 'false'], { cwd: distribution })
await command('git', ['add', '--all'], { cwd: distribution })
await command('git', ['commit', '-m', 'distribution fixture'], { cwd: distribution })

await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
  name: 'dsh-team-git-install-test',
  private: true,
  packageManager: 'pnpm@11.24.0',
  dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' },
}, null, 2)}\n`)
await writeFile(join(consumer, 'pnpm-workspace.yaml'), `packages: []
allowBuilds:
  '@google/genai': false
  '@deepseek-ai/dsh-subprocess-local': true
  better-sqlite3: true
  koffi: true
  node-pty: true
  protobufjs: true
`)
await command('pnpm', ['install', '--frozen-lockfile=false'], { cwd: consumer })

const environment = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }
const gitSpecifier = `git+${pathToFileURL(distribution).href}`
await command('pnpm', ['exec', 'dsh', 'plugin', '--profile', 'web', 'add', gitSpecifier], { cwd: consumer, env: environment })
const dumped = await command('pnpm', ['exec', 'dsh', '--profile', 'web', '--dump-config'], { cwd: consumer, env: environment })
assert(dumped.stdout.includes('name: dsh-team/core'), 'web profile did not compose the dsh-team core entry')
assert(dumped.stdout.includes('name: dsh-team/tools'), 'web profile did not compose the dsh-team tools entry')

const profile = join(dshHome, 'profiles', 'web')
const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
assert.equal(typeof manifest.dependencies?.['dsh-team'], 'string', 'web profile does not depend on dsh-team')
const installedManifest = JSON.parse(await readFile(join(profile, 'node_modules/dsh-team/package.json'), 'utf8'))
assert.equal(installedManifest.name, 'dsh-team')
assert.equal(installedManifest.scripts?.prepare, undefined, 'Git package unexpectedly needs a prepare build')

await writeFile(join(profile, 'verify-distribution.mjs'), `
import assert from 'node:assert/strict'
const root = await import('dsh-team')
assert.equal(typeof root.apply, 'function')
console.log('The package root exports apply(ctx).')
`)
await command(process.execPath, ['verify-distribution.mjs'], { cwd: profile, env: environment })
await bootWebProfile(environment)

const client = await readFile(join(profile, 'node_modules/dsh-team/lib/client.js'), 'utf8')
assert(client.startsWith('window.__ModuleLoader__.load({ id: "dsh-team"'), 'browser bundle has the wrong module-loader identity')
assert(!client.includes(repository), 'browser bundle embeds the development checkout path')
const compatibility = await readFile(join(profile, 'node_modules/dsh-team/lib/compat.js'), 'utf8')
for (const type of ['team/batch', 'team/integration', 'team/recovery', 'team/worktree']) {
  assert(compatibility.includes(`"${type}"`), `${type} compatibility registration is absent`)
}

console.log(`dsh-team Git installation passed in ${runRoot}`)
