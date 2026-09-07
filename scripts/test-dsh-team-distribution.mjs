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
  devDependencies: { typescript: '6.0.3', '@types/node': '22.20.1' },
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

// DSH boot supplies its singleton peers through the profile module fallback.
// Exercise the optional coordinator through that real boot before plain imports.
const coordinatorDirectory = join(runRoot, 'coordinator')
await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
  id: 'distribution-coordinator', name: 'dsh-team/coordinator',
  config: { directory: coordinatorDirectory, darkFactory: { enabled: false } },
}] }], null, 2) + '\n')
await bootWebProfile(environment)
assert.equal(await readFile(join(coordinatorDirectory, 'projects.jsonl'), 'utf8'), '', 'optional coordinator did not initialize its empty project catalog')

await writeFile(join(profile, 'verify-distribution.mjs'), `
import assert from 'node:assert/strict'
const root = await import('dsh-team')
assert.equal(typeof root.apply, 'function')
const factory = await import('dsh-team/darkfactory')
const coordinator = await import('dsh-team/coordinator')
assert.deepEqual(coordinator.Config({ directory: '/unused-fixture-directory' }).darkFactory, { schemaVersion: 1, enabled: false })
assert.equal(factory.canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
assert.deepEqual(Object.keys(factory.contractJsonSchemas()), Object.keys(factory.contracts))
assert.ok(Object.keys(factory.authorityJsonSchemas()).length >= 3)
      assert.equal(typeof factory.DarkFactoryReconciler.open, 'function')
      assert.equal(typeof factory.validateReferenceGraph, 'function')
      assert.equal(typeof factory.validateReferenceSnapshot, 'function')
      for (const owner of [factory.DarkFactoryPolicyStore, factory.DarkFactoryIngestionStore, factory.DarkFactoryAdmissionStore, factory.DarkFactoryCompilationStore]) assert.equal(typeof owner.migrate, 'function')
      assert.equal(typeof factory.DarkFactoryAdmissionStore.open, 'function')
      assert.equal(typeof factory.DarkFactoryAdmissionController, 'function')
      assert.equal(typeof factory.DarkFactoryCompilationStore.open, 'function')
      assert.equal(typeof factory.DarkFactoryCompilationController, 'function')
      assert.equal(typeof factory.DarkFactoryProviderRequestStore.open, 'function')
      assert.equal(typeof factory.DarkFactoryGithubScanStore.open, 'function')
      assert.equal(typeof factory.DarkFactoryGithubScanner.open, 'function')
      assert.equal(typeof factory.readGithubScanPage, 'function')
      assert.equal(typeof factory.reconcileGithubDependabotAlert, 'function')
      assert.equal(typeof factory.reconcileGithubPullRequest, 'function')
      assert.equal(typeof factory.DarkFactoryMonitoringReconciler, 'function')
      assert.equal(typeof factory.DarkFactoryMonitoringReconciler.open, 'function')
      assert.equal(typeof factory.reconcileSentrySource, 'function')
      assert.equal(typeof factory.reconcileApmSource, 'function')
      assert.equal(typeof factory.readMonitoringResource, 'function')
      assert.equal(factory.darkFactoryTemplate.steps.length, 5)
      assert.equal(typeof factory.validateFactoryReferenceGraph, 'function')
      assert.equal(typeof factory.createFactoryContractCodec, 'function')
      assert.equal(Object.keys(factory.factoryReferenceGraphJsonSchemas()).length, 4)
assert.deepEqual(factory.parseDarkFactoryConfig(), { schemaVersion: 1, enabled: false })
assert.throws(() => factory.parseStrictJson('{"x":1,"x":2}'))
console.log('The package root exports apply(ctx).')
`)
await command(process.execPath, ['verify-distribution.mjs'], { cwd: profile, env: environment })

// Compile a real installed-package consumer, with no workspace paths or copied
// source fallback. NodeNext and Bundler must resolve the shipped declaration tree.
assert.equal(installedManifest.exports['./darkfactory'].types, './lib/types/darkfactory.d.ts')
assert.equal(installedManifest.exports['./darkfactory'].default, './lib/darkfactory.js')
await writeFile(join(profile, 'verify-distribution.ts'), await readFile(join(repository, 'scripts/fixtures/darkfactory-distribution-consumer.ts'), 'utf8'))
for (const [module, moduleResolution] of [['NodeNext', 'NodeNext'], ['ESNext', 'Bundler']]) {
  await writeFile(join(profile, 'tsconfig.distribution.json'), JSON.stringify({
    compilerOptions: { target: 'ES2024', module, moduleResolution, strict: true, noEmit: true,
      skipLibCheck: false, types: ['node'], typeRoots: [join(consumer, 'node_modules/@types')],
    }, files: ['verify-distribution.ts'],
  }, null, 2) + '\n')
  await command(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.distribution.json'], { cwd: profile, env: environment })
}
console.log('Installed Dark Factory declarations compile: 20 records, strict codec and four graph lanes.')

const client = await readFile(join(profile, 'node_modules/dsh-team/lib/client.js'), 'utf8')
assert(client.startsWith('window.__ModuleLoader__.load({ id: "dsh-team"'), 'browser bundle has the wrong module-loader identity')
assert(!client.includes(repository), 'browser bundle embeds the development checkout path')
const compatibility = await readFile(join(profile, 'node_modules/dsh-team/lib/compat.js'), 'utf8')
for (const type of ['team/batch', 'team/integration', 'team/recovery', 'team/worktree']) {
  assert(compatibility.includes(`"${type}"`), `${type} compatibility registration is absent`)
}

console.log(`dsh-team Git installation passed in ${runRoot}`)
