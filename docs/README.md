# GasTeam documentation

These pages describe the published-runtime plugin checkout and its opt-in Agent Teams features.

- [Installation](installation.md): prerequisites, build, profile linking, standalone profile setup, and rollback.
- [Usage](usage.md): Team tools, tasks, batches, worktrees, integration, coordinator execution, and workflow boundaries.
- [Debugging](debug.md): safe checks for startup, persistence, scheduling, workers, mail, integration, and retained worktrees.
- [Architecture decisions](autonomous-architecture.md): durable authority and recovery rules.
- [Gas Town comparison](gastown-comparison.md): date-pinned capability comparison of reviewed Gas Town roles, primitives, and workflows against the GasTeam plugin.
- [Dark AI Factory PRD](../darkfactory.md): canonical researched requirements, authority boundaries, and goal-based acceptance gates for opt-in autonomous delivery.
- [Master Worklist & Roadmap](worklist.md): consolidated task list combining core engine milestones (M0–M11) and Dark Factory execution tracks for end-user inspection.
- [Completion evidence](completion-evidence.md): tested slices, limits, and unfinished acceptance work.

The repository uses published `@deepseek-ai/dsh@0.1.2-rc.1` dependencies. A DeepSeek Harness source checkout is not required. Commands that install or restart a profile are intentionally kept in [installation](installation.md). A disposable archive validation covered frozen install, build, CLI help, and Web/headless profile linking; clean external installation, service operation, and rollback remain open.
