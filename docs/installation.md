# Installation and profile setup

GasTeam is a private plugin checkout built against published DSH packages. Use Node.js `^22.19` or `>=24`, pnpm 11, Git, and Linux with util-linux `flock` for coordinator journals and Git integration ownership. Keep model credentials outside the repository.

## Build the checkout

```sh
gh repo clone Silktex/dsh-gasteam ~/projects/gasteam -- --depth 1
cd ~/projects/gasteam
pnpm install --frozen-lockfile
pnpm build
```

The package manager is pinned to pnpm 11.24.0. The build uses the published DSH runtime and the repository's two version-pinned dependency patches; no Harness source checkout is needed.

## Link a profile

For the Web profile:

```sh
pnpm install:profile
pnpm start
```

`install:profile` links the five built Team packages into `$DSH_HOME/profiles/web` (`~/.dsh/profiles/web` when `DSH_HOME` is unset). It preserves other installed plugins. Stop an existing server using that profile and port before starting another one. Launch through this checkout's `pnpm start` or `pnpm dsh`; a separate global DSH binary does not receive the repository's patches.

For a headless profile:

```sh
pnpm install:profile -- --profile headless
pnpm dsh --profile headless "Create a reviewer teammate and summarize the repository."
```

The install script requires the built package files. Re-run `pnpm build` after source changes, then re-run `pnpm install:profile` if the linked checkout moved. A linked checkout should not be moved while its server is running.

## Enable optional worktrees and integration

Add the following entries to the selected profile's `cordis.patch.yml`. Use an absolute worker directory outside the target repository, and replace `master` and verification commands with the project's values.

```yaml
- id: agent-team
  config:
    worktreeProvider: git
    integrationProvider: git

- insert:
    - id: team-worktrees
      name: '@deepseek-ai/dsh-experimental-agent-team/git-worktrees'
      config:
        directory: /absolute/path/outside/repository/team-workers
    - id: team-integration
      name: '@deepseek-ai/dsh-experimental-agent-team/git-integration'
      config:
        targetBranch: master
        verification:
          - command: pnpm
            args: [install, --frozen-lockfile]
          - command: pnpm
            args: [build]
          - command: pnpm
            args: [test]
    - id: team-integration-worker
      name: '@deepseek-ai/dsh-experimental-agent-team/integration-worker'
```

Restart the profile after changing its composition. Omit the integration worker to leave jobs for the explicit `team_integration_run` tool. The supervisor is a separate opt-in component; omitting it leaves worker recovery manual.

## Enable coordinator execution

After enabling Git worktrees, insert the coordinator plugin. Its durable directory must be absolute and separate from the DSH session JSONL directory.

```yaml
- insert:
    - id: workspace-coordinator
      name: '@deepseek-ai/dsh-experimental-agent-team/coordinator'
      config:
        directory: /absolute/path/outside/session-storage/gasteam-workspace
        scanIntervalMs: 1000
        execution:
          modelProvider: your-registered-provider
          model: your-model-id
          maxConcurrent: 8
          dispatchIntervalMs: 1000
```

The coordinator is not enabled by package installation. It requires a registered project and exact Lead authorization. Candidate retention is disabled unless `execution.candidateRetention` is explicitly configured. Review-gated integration approval is host-authorized and defaults to deny.

## Stop, upgrade, and rollback

Stop the DSH process before changing linked package contents or profile composition. To upgrade, pull the intended checkout revision, run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm install:profile`, then restart the profile. Preserve the coordinator directory, Team session storage, and worker checkouts before rollback. Do not downgrade journals containing newer strict fields without a compatible backup.

The repository does not deploy a server through package installation. A systemd user service must point at this checkout's runtime and working directory, for example:

```ini
WorkingDirectory=%h/projects/gasteam
ExecStart=/absolute/path/to/node %h/projects/gasteam/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open
```

After editing a user service, use the normal `systemctl --user daemon-reload` and restart procedure for that service. Clean-install, service, backup, and rollback commands remain documentation obligations until validated in an independent environment.

Before an upgrade, back up the profile layer and the separate coordinator directory while the process is stopped:

```sh
tar -C "$DSH_HOME" -czf /absolute/path/backup/dsh-profiles-$(date +%Y%m%d).tgz profiles/web
tar -C /absolute/path/outside/session-storage -czf /absolute/path/backup/gasteam-workspace-$(date +%Y%m%d).tgz gasteam-workspace
```

The journals are append-only JSONL. There is no automatic downgrade or migration command. Keep the backup and restore the matching runtime/profile revision before reopening a journal with stricter schemas. If an upgrade cannot read a journal, stop the service, preserve the original directory, and restore the prior profile/runtime plus the backup; do not edit or truncate JSONL by hand.

To remove the linked Team packages from a disposable or selected profile, stop the profile first and use the runtime's profile package command with the exact package names:

```sh
pnpm dsh plugin --profile web remove \
  @deepseek-ai/dsh-experimental-agent-team \
  @deepseek-ai/dsh-experimental-agent-team-profile \
  @deepseek-ai/dsh-experimental-agent-team-web-profile \
  @deepseek-ai/dsh-experimental-client-ui-agent-team \
  @deepseek-ai/dsh-experimental-tool-agent-team
```

For headless profiles remove the Web-only packages from that list. This removes profile links; it does not delete Team journals, worker checkouts, or project repositories. Preserve or remove those directories separately only after confirming their exact paths and retention requirements.

## Validation record

On 2026-09-05, the commands above were checked against a disposable archive of committed `016a976e5bb843153a2a888c14630d6805f68ab4`. In `/tmp/gasteam-docs-install-8D5nQh`, frozen dependency installation, `pnpm build`, `pnpm dsh --profile web --no-open --help`, and both `DSH_HOME`-isolated `install:profile` commands passed. The Web profile linked the host, tool, host-profile, Web-profile, and client packages; the headless profile linked the host, tool, and host-profile packages. Logs are recorded in `/tmp/gasteam-docs-install-{pnpm,build,help,web-profile,headless-profile}.log`.

This validates command and profile-link mechanics in an isolated checkout. It does not validate authenticated model calls, `pnpm start`, a production service, clean external installation, backup/restore, or rollback.
