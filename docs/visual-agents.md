# Visual agents (GasView)

## What it is

GasView visual agents is an opt-in, Web-only companion plugin that renders each project's Team agents as animated pixel-art characters — a gastown-inspired steampunk factory floor with original art — on a full-screen overlay opened from the conversation header. The overlay's project selector scopes the scene: each registered project has its own visual agents view, drawn from that project's agents.

The plugin is read-only. It consumes the existing `agentTeams` Remote projection (`workspaceDashboard`) that already backs the Team dashboard; it requires no host-side changes and adds no new RPC namespace. Omitting the plugin layer leaves the base Agent Teams installation untouched.

## Enable it

Prerequisites: this checkout is built with `pnpm build`, and the base Agent Teams packages are installed and linked into the Web profile as described in [installation](installation.md). The visual Web profile layer is then linked explicitly; linking applies its `cordis.patch.yml` through the same mechanism as the base Web profile, so it composes after the Team layers it depends on.

```sh
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add \
  link:$PWD/packages/agent-team-visual-web-profile
```

Restart the profile after changing its composition. To remove the plugin, stop the profile first and use the runtime's profile package command with the exact package name, mirroring the rollback procedure in [installation](installation.md):

```sh
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web remove \
  @deepseek-ai/dsh-experimental-agent-team-visual-web-profile
```

Removal unlinks the profile layer only; it does not touch Team journals, worker checkouts, or project repositories.

## Using it

Open a session in the Web profile and use the **视觉视图 / Visual agents** action in the conversation header. The overlay toolbar offers a project selector, a refresh button, and a close button. The project selector chooses which registered project's scene is shown; a selection that disappears from the latest dashboard is cleared with a notice.

The scene is gated by a per-project toggle. The flag is persisted in `localStorage` under the key `gasteam.visual-agents.<projectId>` and defaults to OFF; while it is off, the overlay shows a disabled notice instead of the canvas. The toggle is independent per project.

Each agent is painted as one character at a desk. States render as:

- **idle** — the agent idles at its desk; no badge.
- **working** — a work animation; no badge.
- **blocked** — a bronze clock badge above the head.
- **error** — an oxide alarm badge that flashes.
- **done** — a brass star badge; the agent celebrates for 3 seconds, then walks out of the scene.

Characters are cast into visual archetypes. The Team Lead is a static overseer at the top-right of the floor. Every other agent is assigned teammate, reviewer, or coordinator by a deterministic djb2 hash of its agent id (`djb2(agentId) % 4` → 50% teammate, 25% reviewer, 25% coordinator), because the Remote projection exposes no roles yet. Teammates carry dedicated blocked/error/done poses; reviewers and coordinators convey those states through the badges alone.

The right wall carries a wanted board with up to eight task posters for the selected project. The scene follows `prefers-color-scheme`: dark system themes get the dark palette, and the scene tracks changes while the overlay is open. For screen readers, a visually hidden roster mirror lists each agent's label and localized state; it updates only when dashboard data refreshes, never per animation frame.

## Architecture

The browser plugin registers a cordis slot action (`conversation.session.header.actions`) plus its own locale namespace, and calls the existing `remote.agentTeams.workspaceDashboard` operation — the same read the Team dashboard uses. On top of that projection sit five engine pieces:

- An **adaptive poller** refreshes every 2s while any actor is moving or working, every 10s when the scene is settled, and backs off exponentially on errors up to a 30s cap (`min(2^errors * 2s, 30000)`). The manual refresh button pokes the poller.
- A **per-actor finite-state machine** walks each agent through arriving → walking → settled → leaving. Settled done actors linger for 3000ms before walking out.
- **A\* pathfinding** routes actors around desk obstacles on a 20×12 navigation grid over the normalized scene.
- A **Canvas 2D render loop** driven by `requestAnimationFrame` (with a `setTimeout` fallback) paints the scene; actors live outside React state so 60fps stepping never re-renders the component tree.
- **Data-driven sprite sheets**: 15 sheets across the four archetypes, generated from authored pixel art by [scripts/sprites/generate.mjs](../scripts/sprites/generate.mjs) and validated by [scripts/sprites/verify.mjs](../scripts/sprites/verify.mjs). Re-running the generator leaves the checked-in sheets byte-identical.

The client and engine sources live under [packages/client-ui-agent-team-visual](../packages/client-ui-agent-team-visual/); the Web profile layer is [packages/agent-team-visual-web-profile](../packages/agent-team-visual-web-profile/).

## Development and testing

Regenerate the sprite sheets after editing the art modules under `scripts/sprites/art/`, then verify them against the sheet rules:

```sh
node scripts/sprites/generate.mjs
node scripts/sprites/verify.mjs
```

`pnpm test` runs both vitest projects: the `host` project (node environment) covers the engine, reconcile, and sprite suites, and the `client` project (jsdom) covers the toggle and scene component specs. The visual package's suites live in `packages/client-ui-agent-team-visual/tests/`.

The frame-time budget is an average under 8ms and a p95 under 16ms per painted frame. The browser smoke measured an average of 4.0ms and p95 of 4.8ms with 8 concurrent agents (7 actors plus the lead overseer) in the light theme, within budget in both themes.

## Limitations

- **Polling-based.** Scene updates come from periodic `workspaceDashboard` reads; there is no push channel, so changes appear on the next poll tick (2s while active).
- **Archetype heuristic.** Teammate/reviewer/coordinator casting is a stable hash of the agent id, not a real role; the Remote projection exposes no roles yet.
- **Client specs need the dev environment.** The jsdom client specs run inside this repository's networked development environment; they are not part of the standalone release validation.
- **Release validation scope.** `pnpm test:release` packs and validates the five Team packages only. The two visual packages are validated by the seven-package `pnpm build`, the vitest suites, and the browser smoke.
- **Not in the `dsh-team` distribution.** The single-package `dsh-team` distribution does not ship the visual plugin in v1 (Web-only, experimental, polling-based); this can be revisited when a dedicated push RPC namespace exists.
