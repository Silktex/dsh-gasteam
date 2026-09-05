/** Link the built Team packages into a profile managed by the pinned dsh runtime. */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const { values } = parseArgs({ args, options: { profile: { type: 'string', default: 'web' } } })
const root = resolve(import.meta.dirname, '..')
const packages = ['agent-team', 'tool-agent-team', 'agent-team-profile']
if (values.profile === 'web') packages.push('client-ui-agent-team', 'agent-team-web-profile')
for (const name of packages) await access(resolve(root, `packages/${name}/lib/index.js`))
const runtime = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const result = spawnSync(process.execPath, [runtime, 'plugin', '--profile', values.profile, 'add', ...packages.map(name => `link:${resolve(root, 'packages', name)}`)], { cwd: root, env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Installed Agent Teams in profile ${values.profile}. Launch with this project's pnpm dsh so the pinned runtime patches apply.`)
