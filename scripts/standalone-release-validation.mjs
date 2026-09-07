/** Pack and install GasTeam as an unrelated consumer, then validate a legacy journal upgrade. */
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const requestedRoot = resolve(process.env.GASTEAM_RELEASE_ROOT ?? tmpdir())
const expectedRoot = resolve(process.env.GASTEAM_RELEASE_ALLOWED_ROOT ?? '/var/tmp')
const packageDirectories = [
  'agent-team',
  'agent-team-profile',
  'agent-team-web-profile',
  'client-ui-agent-team',
  'tool-agent-team',
]
const packageNames = [
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-agent-team-web-profile',
  '@deepseek-ai/dsh-experimental-client-ui-agent-team',
  '@deepseek-ai/dsh-experimental-tool-agent-team',
]

function inside(path, parent) {
  const child = relative(parent, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith(sep)
}

async function command(executable, args, options = {}) {
  console.log(`+ ${executable} ${args.join(' ')}`)
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`${executable} exited ${code ?? signal}`)))
  })
}

async function commandOutput(executable, args, options = {}) {
  console.log(`+ ${executable} ${args.join(' ')}`)
  return await new Promise((accept, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept({ stdout, stderr })
      else reject(new Error(`${executable} exited ${code ?? signal}\n${stdout}\n${stderr}`))
    })
  })
}

const rootStat = await lstat(requestedRoot).catch(() => undefined)
assert(rootStat?.isDirectory(), `GASTEAM_RELEASE_ROOT must name an existing directory: ${requestedRoot}`)
assert(inside(requestedRoot, expectedRoot) || requestedRoot === expectedRoot,
  `GASTEAM_RELEASE_ROOT must remain under ${expectedRoot}: ${requestedRoot}`)
const runRoot = await mkdtemp(join(requestedRoot, 'gasteam-standalone-release-'))
const packs = join(runRoot, 'packs')
const consumer = join(runRoot, 'consumer')
const patches = join(consumer, 'patches')
const dshHome = join(runRoot, 'dsh-home')
await Promise.all([mkdir(packs), mkdir(consumer), mkdir(patches, { recursive: true }), mkdir(dshHome)])
assert(inside(dshHome, expectedRoot), `refusing unsafe DSH_HOME ${dshHome}`)

await command('pnpm', ['build'], { cwd: repository })
for (const directory of packageDirectories) {
  await command('pnpm', ['--dir', join(repository, 'packages', directory), 'pack', '--pack-destination', packs], { cwd: repository })
}

const tarballs = packageDirectories.map(directory => {
  const manifest = JSON.parse(requireText(join(repository, 'packages', directory, 'package.json')))
  return join(packs, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)
})

function requireText(filename) {
  // Packing needs these small manifests synchronously before external install starts.
  return globalThis.process.getBuiltinModule('node:fs').readFileSync(filename, 'utf8')
}

await Promise.all([
  copyFile(join(repository, 'patches', '@deepseek-ai__dsh-session@0.1.2-rc.1.patch'), join(patches, 'dsh-session.patch')),
  copyFile(join(repository, 'patches', '@deepseek-ai__dsh-subagent@0.1.2-rc.1.patch'), join(patches, 'dsh-subagent.patch')),
])
const dependencies = Object.fromEntries(packageNames.map((name, index) => [name, `file:${tarballs[index]}`]))
dependencies['@deepseek-ai/dsh'] = '0.1.2-rc.1'
Object.assign(dependencies, {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/dsh-agent-loop': '0.1.2-rc.1',
  '@deepseek-ai/dsh-agent-loop-testkit': '0.1.2-rc.1',
  '@deepseek-ai/dsh-llm': '0.1.2-rc.1',
  '@deepseek-ai/dsh-session': '0.1.2-rc.1',
  '@deepseek-ai/dsh-session-persistence-jsonl': '0.1.2-rc.1',
  '@deepseek-ai/dsh-session-projection': '0.1.2-rc.1',
  '@deepseek-ai/dsh-session-query': '0.1.2-rc.1',
  '@deepseek-ai/dsh-subagent': '0.1.2-rc.1',
  '@deepseek-ai/dsh-subagent-spawn-in-process': '0.1.2-rc.1',
  execa: '^10.0.1',
})
await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
  name: 'gasteam-independent-consumer', private: true, type: 'module', packageManager: 'pnpm@11.24.0', dependencies,
}, null, 2)}\n`)
await writeFile(join(consumer, 'pnpm-workspace.yaml'), `packages: []
overrides:
${packageNames.map((name, index) => `  '${name}': file:${tarballs[index]}`).join('\n')}
autoInstallPeers: true
allowBuilds:
  '@google/genai': false
  better-sqlite3: true
  node-pty: true
  '@deepseek-ai/dsh-subprocess-local': true
  koffi: true
  protobufjs: true
patchedDependencies:
  '@deepseek-ai/dsh-session@0.1.2-rc.1': patches/dsh-session.patch
  '@deepseek-ai/dsh-subagent@0.1.2-rc.1': patches/dsh-subagent.patch
`)

await command('pnpm', ['install', '--lockfile-only'], { cwd: consumer })
await command('pnpm', ['install', '--frozen-lockfile'], { cwd: consumer })

const lock = await readFile(join(consumer, 'pnpm-lock.yaml'), 'utf8')
assert(!lock.includes('link:../'), 'independent lockfile contains a workspace link')
assert(!lock.includes(repository), 'independent lockfile contains the development checkout path')
assert(!/deepseek[-_/ ]harness/i.test(lock), 'independent lockfile references the former Harness checkout')
await writeFile(join(consumer, 'verify.mjs'), `import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const names = ${JSON.stringify(packageNames)}
const consumer = await realpath('.')
const inside = path => { const child = relative(consumer, path); return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !child.startsWith(sep) }
for (const name of names) {
  const manifestUrl = import.meta.resolve(name + '/package.json')
  const installed = await realpath(dirname(fileURLToPath(manifestUrl)))
  assert(inside(installed), name + ' resolved outside the independent consumer: ' + installed)
  const manifest = JSON.parse(await readFile(fileURLToPath(manifestUrl), 'utf8'))
  assert(!JSON.stringify(manifest).includes('workspace:'), name + ' retained workspace protocol')
  await import(name)
}
await Promise.all([
  import('@deepseek-ai/dsh-experimental-agent-team/coordinator'),
  import('@deepseek-ai/dsh-experimental-agent-team/darkfactory'),
  import('@deepseek-ai/dsh-experimental-agent-team/git-integration'),
  import('@deepseek-ai/dsh-experimental-agent-team/git-worktrees'),
  import('@deepseek-ai/dsh-experimental-agent-team/integration-worker'),
  import('@deepseek-ai/dsh-experimental-agent-team/supervisor'),
  import('@deepseek-ai/dsh-experimental-agent-team/remote'),
  import('@deepseek-ai/dsh-experimental-tool-agent-team/coordinator'),
])
const browserEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-experimental-client-ui-agent-team/client'))
assert(inside(await realpath(browserEntry)), 'browser entry resolved outside the independent consumer')
assert((await readFile(browserEntry, 'utf8')).includes('__ModuleLoader__'), 'browser entry is not the built client bundle')
const sessionRoot = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session/package.json')))
const subagentRoot = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subagent/package.json')))
assert((await readFile(join(sessionRoot, 'lib/index.js'), 'utf8')).includes('"team/integration"'), 'consumer DSH session dependency is not patched')
assert((await readFile(join(subagentRoot, 'lib/index.js'), 'utf8')).includes('spec.cwd === void 0'), 'consumer DSH subagent dependency is not patched')
console.log('All packed package entry points resolve inside the independent consumer.')
`)
await command(process.execPath, ['verify.mjs'], { cwd: consumer })
await command('pnpm', ['exec', 'dsh', '--help'], { cwd: consumer, env: { ...process.env, DSH_HOME: dshHome } })
const profileName = 'web'
const profile = join(dshHome, 'profiles', profileName)
const profileEnvironment = { ...process.env, DSH_HOME: dshHome }
await command('pnpm', ['exec', 'dsh', 'plugin', '--profile', profileName, 'install', '--lockfile-only'], { cwd: consumer, env: profileEnvironment })
await writeFile(join(profile, 'pnpm-workspace.yaml'), `packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
overrides:
${packageNames.map((name, index) => `  '${name}': file:${tarballs[index]}`).join('\n')}
`)
await command('pnpm', ['exec', 'dsh', 'plugin', '--profile', profileName, 'add', ...tarballs], { cwd: consumer, env: profileEnvironment })
await command('pnpm', ['exec', 'dsh', '--profile', profileName, '--dump-config'], { cwd: consumer, env: profileEnvironment })
const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
assert.deepEqual(packageNames.every(name => profileManifest.dependencies[name] !== undefined), true,
  'isolated profile does not contain every packed Team package')
for (const name of packageNames) {
  const installed = await globalThis.process.getBuiltinModule('node:fs/promises').realpath(join(profile, 'node_modules', name))
  assert(inside(installed, profile), `${name} profile install resolved outside the disposable profile: ${installed}`)
}
const autonomousRoot = join(runRoot, 'autonomous')
const autonomousPatch = join(autonomousRoot, 'cordis.patch.yml')
const workerDirectory = join(autonomousRoot, 'workers')
const coordinatorDirectory = join(autonomousRoot, 'coordinator')
await mkdir(autonomousRoot)
await Promise.all([mkdir(workerDirectory), mkdir(coordinatorDirectory)])
const autonomousTemplate = await readFile(join(repository, 'examples', 'autonomous.cordis.patch.yml'), 'utf8')
await writeFile(autonomousPatch, autonomousTemplate
  .replaceAll('__WORKTREE_DIRECTORY__', workerDirectory)
  .replaceAll('__COORDINATOR_DIRECTORY__', coordinatorDirectory)
  .replaceAll('__TARGET_BRANCH__', 'main')
  .replaceAll('__MODEL_PROVIDER__', 'configured-provider')
  .replaceAll('__MODEL_ID__', 'configured-model'))
await command('pnpm', ['exec', 'dsh', '--profile', profileName, '--patch', autonomousPatch, '--dump-config'], { cwd: consumer, env: profileEnvironment })

const fixtureRoot = join(consumer, 'fixtures')
await mkdir(fixtureRoot)
await Promise.all([
  copyFile(join(repository, 'tests', 'fixtures', 'team-llm.mjs'), join(fixtureRoot, 'team-llm.mjs')),
  copyFile(join(repository, 'tests', 'fixtures', 'progress-llm.mjs'), join(fixtureRoot, 'progress-llm.mjs')),
])
const headlessName = 'headless'
const headlessProfile = join(dshHome, 'profiles', headlessName)
await command('pnpm', ['exec', 'dsh', 'plugin', '--profile', headlessName, 'install', '--lockfile-only'], { cwd: consumer, env: profileEnvironment })
await writeFile(join(headlessProfile, 'pnpm-workspace.yaml'), `packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
overrides:
${packageNames.map((name, index) => `  '${name}': file:${tarballs[index]}`).join('\n')}
`)
const headlessTarballs = [tarballs[0], tarballs[1], tarballs[4]]
await command('pnpm', ['exec', 'dsh', 'plugin', '--profile', headlessName, 'add', ...headlessTarballs], { cwd: consumer, env: profileEnvironment })
const smokeRoot = join(runRoot, 'profile-smoke')
const smokeRepository = join(smokeRoot, 'repository')
const smokeWorkers = join(smokeRoot, 'workers')
await mkdir(smokeRoot)
await Promise.all([mkdir(smokeRepository), mkdir(smokeWorkers)])
const smokeEnvironment = {
  ...profileEnvironment,
  PATH: `${join(consumer, 'node_modules', '.bin')}:${process.env.PATH}`,
  DSH_TELEMETRY_DISABLED: '1', DSH_TEAM_WORKTREES: '1', DSH_PERMISSION_MODE: 'danger-full-access', DEEPSEEK_API_KEY: '',
  GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
}
await command('git', ['init', '--initial-branch=main'], { cwd: smokeRepository, env: smokeEnvironment })
await command('git', ['config', 'user.email', 'gasteam-fixture@example.invalid'], { cwd: smokeRepository, env: smokeEnvironment })
await command('git', ['config', 'user.name', 'GasTeam fixture'], { cwd: smokeRepository, env: smokeEnvironment })
await command('git', ['config', 'commit.gpgsign', 'false'], { cwd: smokeRepository, env: smokeEnvironment })
await writeFile(join(smokeRepository, '.gitignore'), '.dsh/\n.sessions/\n.agents/\nnode_modules/\n')
await writeFile(join(smokeRepository, 'shared.txt'), 'base\n')
await mkdir(join(smokeRepository, 'patches'))
await Promise.all([
  copyFile(join(consumer, 'patches', 'dsh-session.patch'), join(smokeRepository, 'patches', 'dsh-session.patch')),
  copyFile(join(consumer, 'patches', 'dsh-subagent.patch'), join(smokeRepository, 'patches', 'dsh-subagent.patch')),
])
await writeFile(join(smokeRepository, 'package.json'), `${JSON.stringify({ name: 'gasteam-packed-profile-smoke', private: true, packageManager: 'pnpm@11.24.0', dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }, null, 2)}\n`)
await writeFile(join(smokeRepository, 'pnpm-workspace.yaml'), `packages: []
allowBuilds:
  '@google/genai': false
  better-sqlite3: true
  node-pty: true
  '@deepseek-ai/dsh-subprocess-local': true
  koffi: true
  protobufjs: true
patchedDependencies:
  '@deepseek-ai/dsh-session@0.1.2-rc.1': patches/dsh-session.patch
  '@deepseek-ai/dsh-subagent@0.1.2-rc.1': patches/dsh-subagent.patch
`)
await command('pnpm', ['install', '--lockfile-only'], { cwd: smokeRepository, env: smokeEnvironment })
await command('pnpm', ['install', '--frozen-lockfile'], { cwd: smokeRepository, env: smokeEnvironment })
const smokeLock = await readFile(join(smokeRepository, 'pnpm-lock.yaml'), 'utf8')
assert(!smokeLock.includes(repository), 'profile smoke runtime lockfile contains the development checkout')
assert(smokeLock.includes('patch_hash='), 'profile smoke runtime did not apply pinned patches')
await command('git', ['add', '--all'], { cwd: smokeRepository, env: smokeEnvironment })
await command('git', ['commit', '-m', 'base'], { cwd: smokeRepository, env: smokeEnvironment })
await writeFile(join(headlessProfile, 'cordis.patch.yml'), `
- id: llm-deepseek
  disabled: true
- id: agent-team
  config:
    worktreeProvider: git
    integrationProvider: git
- insert:
    - id: team-smoke-model
      name: ${join(fixtureRoot, 'team-llm.mjs')}
    - id: team-smoke-worktrees
      name: '@deepseek-ai/dsh-experimental-agent-team/git-worktrees'
      config:
        directory: ${smokeWorkers}
    - id: team-smoke-integration
      name: '@deepseek-ai/dsh-experimental-agent-team/git-integration'
      config:
        targetBranch: main
        verification:
          - command: ${process.execPath}
            args: [-e, "if(require('node:fs').readFileSync('shared.txt','utf8').trim()!=='worker')process.exit(1)"]
`)
const profileSmoke = await commandOutput('pnpm', ['exec', 'dsh', '--profile', headlessName, 'Run the isolated packed-profile Team worktree integration fixture.'], { cwd: smokeRepository, env: smokeEnvironment })
assert(profileSmoke.stdout.includes('TEAM_WORKTREE_OK: verified worker commit integrated.'), `packed profile missed completion marker\n${profileSmoke.stdout}\n${profileSmoke.stderr}`)
assert.equal(await readFile(join(smokeRepository, 'shared.txt'), 'utf8'), 'worker\n')
console.log('Packed headless profile smoke passed: worker commit, verification, promotion, and release.')

const acceptanceRoot = join(runRoot, 'coordinator-acceptance')
await mkdir(acceptanceRoot)
let restartFixture = await readFile(join(repository, 'tests', 'fixtures', 'restart-team.mjs'), 'utf8')
restartFixture = restartFixture
  .replaceAll("'../../packages/agent-team/lib/index.js'", "'@deepseek-ai/dsh-experimental-agent-team'")
  .replaceAll("'../../packages/agent-team/lib/coordinator.js'", "'@deepseek-ai/dsh-experimental-agent-team/coordinator'")
  .replaceAll("'../../packages/agent-team/lib/git-integration.js'", "'@deepseek-ai/dsh-experimental-agent-team/git-integration'")
  .replaceAll("'../../packages/agent-team/lib/git-worktrees.js'", "'@deepseek-ai/dsh-experimental-agent-team/git-worktrees'")
  .replaceAll("'../../packages/agent-team/lib/types/", "'../node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/")
assert(!restartFixture.includes(repository), 'copied coordinator fixture contains the development checkout path')
assert(!restartFixture.includes('../../packages/'), 'copied coordinator fixture retains a source-workspace import')
await Promise.all([
  writeFile(join(fixtureRoot, 'restart-team.mjs'), restartFixture),
])

function coordinatorProcess(mode) {
  const child = fork(join(fixtureRoot, 'restart-team.mjs'), [mode, acceptanceRoot], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, DSH_HOME: acceptanceRoot, DSH_TELEMETRY_DISABLED: '1' },
  })
  let diagnostics = ''
  let ended = false
  let failure
  const messages = []
  let wake
  child.stdout.on('data', chunk => { diagnostics += String(chunk) })
  child.stderr.on('data', chunk => { diagnostics += String(chunk) })
  child.on('message', message => { messages.push(message); wake?.() })
  child.on('error', error => { failure = error; wake?.() })
  const closed = new Promise(resolve => child.on('close', (code, signal) => { ended = true; wake?.(); resolve({ code, signal }) }))
  return {
    async barrier() {
      const deadline = setTimeout(() => { failure = new Error('coordinator acceptance barrier timed out'); wake?.() }, 30_000)
      try {
        while (messages.length === 0) {
          if (failure || ended) throw new Error(`${failure?.message ?? 'coordinator fixture exited'}\n${diagnostics}`)
          await new Promise(resolve => { wake = resolve })
        }
        return messages.shift()
      } finally { clearTimeout(deadline); wake = undefined }
    },
    async stop(crash = false) {
      if (!ended) crash ? child.kill('SIGKILL') : child.send('stop')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
      try {
        const result = await closed
        assert(crash ? result.signal === 'SIGKILL' : result.code === 0, `coordinator fixture failed ${JSON.stringify(result)}\n${diagnostics}`)
      } finally { clearTimeout(timeout) }
    },
  }
}

const seeded = coordinatorProcess('seed-dag')
const persisted = await seeded.barrier()
assert.equal(persisted.barrier, 'persisted')
await seeded.stop(true)
const resumed = coordinatorProcess('restore-dag')
const completed = await resumed.barrier()
assert.equal(completed.barrier, 'accepted-replay')
assert.equal(completed.tasks.length, 4)
assert(completed.tasks.every(task => task.status === 'completed'), 'coordinator left a DAG task incomplete')
assert.equal(completed.submissions.length, 4)
assert(completed.submissions.every(submission => submission.phase === 'accepted'), 'coordinator left a submission unaccepted')
assert.equal(completed.integrations.length, 4)
assert(completed.integrations.every(integration => integration.phase === 'merged'), 'coordinator left an integration unmerged')
assert.equal(completed.workerRequests, 4)
await resumed.stop()

const legacySource = join(repository, 'packages', 'agent-team', 'tests', 'fixtures', 'legacy-coordinator-batches.jsonl')
const upgrade = join(runRoot, 'upgrade')
const restored = join(runRoot, 'restored')
const backup = join(runRoot, 'backup')
await Promise.all([mkdir(upgrade), mkdir(restored), mkdir(backup)])
await copyFile(legacySource, join(upgrade, 'coordinator-batches.jsonl'))
await copyFile(join(repository, 'packages', 'agent-team', 'tests', 'fixtures', 'legacy-assignments.jsonl'), join(upgrade, 'assignments.jsonl'))
await cp(upgrade, join(backup, 'coordinator-workspace'), { recursive: true, errorOnExist: true })
const before = await readFile(join(upgrade, 'coordinator-batches.jsonl'), 'utf8')
await writeFile(join(consumer, 'upgrade-check.mjs'), `import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const packageRoot = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-experimental-agent-team/package.json')))
const { CoordinatorBatchStore } = await import(pathToFileURL(join(packageRoot, 'lib/types/coordinator-batches.js')).href)
const { AssignmentStore } = await import(pathToFileURL(join(packageRoot, 'lib/types/assignments.js')).href)
const assignments = await AssignmentStore.open(process.argv[2], { globalCapacity: 2, projectCapacities: { alpha: 2 } })
const assignment = assignments.list()[0]
assert.equal(assignment.attemptId, 'attempt-1')
assert.equal(assignment.assignmentId, 'assignment-1')
assert.equal(assignment.runtimeId, 'session-a')
assert.equal(assignment.phase, 'active')
assert.equal(assignment.generation, 1)
assert.equal(assignment.revision, 4)
assert.deepEqual(assignment.checkpoint, { task: { subject: 'Implement', description: 'Preserve this context' }, step: 'verify', artifacts: [{ kind: 'file', ref: 'worker.txt' }], nextAction: 'Run verification' })
assert.deepEqual(assignment.retryPolicy, { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: Number.MAX_SAFE_INTEGER })
assert.equal(assignment.handoffLimit, 1)
assert.deepEqual(assignment.recovery, { count: 1, observedSequence: 17, notBefore: 25, messageId: 'runtime-retry-a' })
const store = await CoordinatorBatchStore.open(process.argv[2], () => 20)
const expected = {
  id: 'legacy', name: 'legacy revision', phase: 'completed', completionEpoch: 1, completedRequired: 1, required: 1,
  readyWithoutActiveAssignment: [], items: [{ ref: { projectId: 'project-a', teamId: 'lead-a', taskId: 'legacy' }, observationRevision: { task: 0, generation: 0, attempt: 7001001, acceptance: 0 }, state: 'accepted', activeAssignment: false, dependsOn: [], history: [{ state: 'accepted', activeAssignment: false, at: 10 }] }], history: [{ phase: 'completed', at: 10 }],
}
assert.deepEqual(store.inspect('legacy'), expected)
if (process.argv[3] === 'upgrade') {
  await assignments.recoverHealth({ attemptId: 'attempt-1', generation: 1, expectedRevision: 4 }, 18, 30, 'health-nudge-release-validation')
  assert.deepEqual(assignments.list()[0].healthRecovery, { count: 1, observedSequence: 18, notBefore: 30, messageId: 'health-nudge-release-validation' })
  await store.observe('legacy', [{ ref: { projectId: 'project-a', teamId: 'lead-a', taskId: 'legacy' }, revision: { task: 1, generation: 0, attempt: 0, acceptance: 0 }, state: 'waiting', activeAssignment: false }])
  assert.equal(store.inspect('legacy').phase, 'active')
}
await assignments.close()
await store.close()
`)
await command(process.execPath, ['upgrade-check.mjs', upgrade, 'upgrade'], { cwd: consumer })
assert.equal(await readFile(join(backup, 'coordinator-workspace', 'coordinator-batches.jsonl'), 'utf8'), before)
await cp(join(backup, 'coordinator-workspace'), restored, { recursive: true })
await command(process.execPath, ['upgrade-check.mjs', restored, 'restore'], { cwd: consumer })

console.log(`Standalone release validation passed. Artifacts: ${runRoot}`)
console.log(`Independent consumer: ${consumer}`)
console.log(`Disposable DSH_HOME: ${dshHome}`)
console.log(`Legacy backup and restored copy: ${backup}, ${restored}`)
