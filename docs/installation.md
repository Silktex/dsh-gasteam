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

## Validate a standalone package bundle

The five GasTeam packages are private and are not currently available from the public registry. Before publication, create tarballs and install them with the published DSH runtime into a disposable, unrelated consumer and profile:

```sh
test -d /var/tmp
GASTEAM_RELEASE_ROOT=/var/tmp pnpm test:release
```

The command builds and packs all five packages, installs them together with `@deepseek-ai/dsh@0.1.2-rc.1` and the two committed patches, generates a lockfile, repeats the install with `--frozen-lockfile`, and loads every host entry point. It installs the tarballs into new Web and headless profiles under a nonempty, generated `/var/tmp/.../dsh-home`, composes the Web profile, and rejects package resolutions outside the disposable consumer/profile. It then runs the actual headless CLI with a copied deterministic model fixture in a separate Git repository; this must create a worker, commit in its isolated worktree, verify and promote the candidate, and release the worktree. A second deterministic provider seeds a four-task DAG, kills the coordinator process after durable admission, and lets a fresh process complete all four tasks through real Git verification, merge, and acceptance. The script prints the retained artifact path for review.

Packed profile packages refer to the other private GasTeam packages by their exact `0.1.2-alpha.2` versions. Until all five packages are published, a standalone tarball consumer must pin all five tarballs and override those five package names to the same local artifacts. The validation fixture generates that configuration. Once a registry release exists, replace the tarball paths and overrides with the exact published versions; that registry path has not yet been executed.

## Link a development-checkout profile

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

The complete [autonomous profile patch](../examples/autonomous.cordis.patch.yml) composes the worktree, integration worker, recovery supervisor, coordinator, and coordinator tool layers together. Replace every `__...__` token, keep the two state directories outside the target repository and session storage, and replace the example `node --version` verification with the target repository's frozen install, build, type, and test commands. `pnpm test:release` substitutes disposable values and validates this patch through the packed profile's `--dump-config`; starting it still requires a real registered provider, model credentials, repository permissions, and Lead project registration.

## Stop, upgrade, and rollback

Stop the DSH process before changing linked package contents or profile composition. To upgrade, pull the intended checkout revision, run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm install:profile`, then restart the profile. Preserve the coordinator directory, Team session storage, and worker checkouts before rollback. Do not downgrade journals containing newer strict fields without a compatible backup.

The repository does not deploy a server through package installation. A systemd user service must point at this checkout's runtime and working directory, for example:

```ini
WorkingDirectory=%h/projects/gasteam
ExecStart=/absolute/path/to/node %h/projects/gasteam/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open
```

After editing a user service, use the normal `systemctl --user daemon-reload` and restart procedure for that service. The standalone validator does not edit or restart a localhost service.

Before an upgrade, back up the profile layer and the separate coordinator directory while the process is stopped:

```sh
profile_home=${DSH_HOME:-"$HOME/.dsh"}
backup_root=/absolute/path/backup
coordinator_parent=/absolute/path/outside/session-storage
test -n "$profile_home" && test -d "$profile_home/profiles/web"
test -n "$coordinator_parent" && test -d "$coordinator_parent/gasteam-workspace"
install -d -m 700 "$backup_root"
tar -C "$profile_home" -czf "$backup_root/dsh-profiles-$(date +%Y%m%d).tgz" profiles/web
tar -C "$coordinator_parent" -czf "$backup_root/gasteam-workspace-$(date +%Y%m%d).tgz" gasteam-workspace
```

Record the exact Git revision, Node path, service unit, profile name, coordinator path, and archive checksums with the backup. Upgrade only after both archives succeed. Verify CLI/profile composition first, then start the service and check its normal health URL and coordinator view. If the new process cannot read a journal, stop it, move the failed upgraded directories aside, restore both archives, restore the recorded checkout/runtime revision and service unit, and only then restart. Do not extract over a live or partially upgraded directory, and do not edit or truncate JSONL by hand.

The journals are append-only JSONL. There is no general migration or downgrade command. `pnpm test:release` copies and backs up committed legacy assignment and numeric-revision batch journals, opens and advances one disposable copy with the packed current package, then restores and reopens the untouched backup. It checks the assignment identity, runtime, active phase, checkpoint, generation, revision, recovery record, and migrated retry/handoff defaults before adding a current health-recovery record. That proves these specific legacy formats remain readable and restorable; later formats still require matching-runtime backups.

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

On 2026-09-05, `pnpm test:release` passed at commit `8702840`. The retained packed-profile run is `/var/tmp/gasteam-standalone-release-ghHE6e`; the complete log is `/var/tmp/gasteam-m11-packed-profile-exact-8702840.log`. It installed all five tarballs plus published DSH into an unrelated consumer and isolated profiles, verified the consumer runtime contains both pinned patches, executed the headless profile through worker commit/verification/promotion/release, composed the autonomous patch, completed the restarted four-task real-Git coordinator DAG, and upgraded and restored the backed-up legacy assignment/batch fixtures.

This validates packed-package installation, generated Web/headless profiles, actual headless CLI execution with a keyless deterministic provider, deterministic coordinator restart through verified Git acceptance, and fixture-level backup/restore mechanics. Authenticated paid-model calls, a production service restart, user-data backup/restore, registry installation, and localhost rollback remain context-dependent and were not executed.
