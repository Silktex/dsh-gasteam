# dsh-team

Durable agent teams for the DeepSeek Harness web profile: shared tasks, peer
messaging, lifecycle controls, and a live workspace dashboard.

This is a community plugin and is not affiliated with or maintained by the
DeepSeek Harness team.

## Install

```sh
dsh plugin --profile web add git+https://github.com/Silktex/dsh-team.git
```

Restart DSH after installation:

```sh
dsh --profile web
```

To remove it:

```sh
dsh plugin --profile web remove dsh-team
```

The package ships compiled host and browser bundles, so the Git install does
not need a local build step.

## What it adds

- Team creation and durable membership
- Shared dependency-aware task boards
- Direct and broadcast teammate messages
- Graceful and forced teammate interruption
- Batch coordination and status tools
- A web workspace dashboard with roster, tasks, and activity

## Screenshots

![Workspace controls](docs/dashboard-controls.png)

![Workspace activity](docs/dashboard-activity.png)

The default bundle uses DSH's built-in `spawn` and `fork` continuable-agent
providers. It supports the `web` profile on DSH `0.1.2-rc.1`, Node.js 22.19+
or 24+, and pnpm 11.

## Permissions and side effects

The default bundle writes Team events into the configured DSH session store
and starts continuable subagents through DSH. It does not enable Git worktree,
merge, external-process, or coordinator plugins by default. Those optional
entry points are included for custom profile patches, but worktree-isolated
child sessions currently require the companion DSH runtime patch maintained in
the source repository.

## Source and license

The development source, tests, and reproducible distribution builder live at
[Silktex/dsh-gasteam](https://github.com/Silktex/dsh-gasteam). This repository
contains the generated, install-ready package and its corresponding source
snapshot. Licensed under the MIT License.
