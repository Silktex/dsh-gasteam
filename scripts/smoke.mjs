/** Run the installed CLI, Team bundles, and real Git integration without model credentials. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execa } from 'execa'
import yaml from 'js-yaml'
const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(join(tmpdir(), 'gasteam-profile-'))
const home = join(temp, 'home')
const cwd = join(temp, 'repository')
const profile = join(home, 'profiles', 'headless')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_TEAM_WORKTREES: '1', DSH_PERMISSION_MODE: 'danger-full-access', DEEPSEEK_API_KEY: '', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' }
const runtime = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
try {
  await mkdir(cwd, { recursive: true })
  await mkdir(profile, { recursive: true })
  const git = (...args) => execa('git', args, { cwd, env })
  await git('init', '--initial-branch=main')
  await git('config', 'user.email', 'gasteam-fixture@example.invalid')
  await git('config', 'user.name', 'GasTeam fixture')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(cwd, '.gitignore'), '.dsh/\n.sessions/\n.agents/\n')
  await writeFile(join(cwd, 'shared.txt'), 'base\n')
  await git('add', '.gitignore', 'shared.txt')
  await git('commit', '-m', 'base')
  await execa('pnpm', ['install:profile', '--', '--profile', 'headless'], { cwd: root, env })
  await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump([
    { id: 'llm-deepseek', disabled: true },
    { id: 'agent-team', config: { worktreeProvider: 'git', integrationProvider: 'git' } },
    { insert: [
      { id: 'team-smoke-model', name: resolve(root, 'tests/fixtures/team-llm.mjs') },
      { id: 'team-smoke-worktrees', name: '@deepseek-ai/dsh-experimental-agent-team/git-worktrees', config: { directory: join(temp, 'workers') } },
      { id: 'team-smoke-integration', name: '@deepseek-ai/dsh-experimental-agent-team/git-integration', config: { targetBranch: 'main', verification: [{ command: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('shared.txt','utf8')!=='worker\\n')process.exit(1)"] }] } },
    ] },
  ]))
  const result = await execa(process.execPath, [runtime, '--profile', 'headless', 'Run the isolated Team worktree integration fixture.'], { cwd, env, timeout: 60000 })
  if (!result.stdout.includes('TEAM_WORKTREE_OK: verified worker commit integrated.')) throw new Error(`Missing Team completion: ${result.stdout}\n${result.stderr}`)
  if (await readFile(join(cwd, 'shared.txt'), 'utf8') !== 'worker\n') throw new Error('Worker commit was not promoted into the Lead checkout')
  console.log('Standalone profile smoke passed: worker cwd, commit, verification, promotion, and release.')
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
