# Development

Contributor guide for `openclaw-code-agent`. For operator setup and runtime usage, see [REFERENCE.md](REFERENCE.md).

## Local Setup

```bash
pnpm install
pnpm verify
```

Build output is the ESM bundle at `dist/index.js`.

## Repository Layout

```text
openclaw-code-agent/
├── index.ts
├── openclaw.plugin.json
├── src/
│   ├── actions/
│   ├── application/
│   ├── commands/
│   ├── harness/
│   ├── tools/
│   ├── config.ts
│   ├── session.ts
│   ├── session-state.ts
│   ├── session-manager.ts
│   ├── session-interactions.ts
│   ├── session-notifications.ts
│   ├── session-worktree-controller.ts
│   ├── worktree-lifecycle-resolver.ts
│   ├── session-store.ts
│   ├── session-metrics.ts
│   ├── wake-dispatcher.ts
│   ├── notifications.ts
│   └── worktree.ts
├── tests/
├── docs/
└── skills/
```

## Main Code Paths

- `index.ts`: plugin registration, service lifecycle, startup cleanup
- `src/session-manager.ts`: session control plane
- `src/session.ts`: single-session lifecycle and event model
- `src/session-state.ts`: reducer-backed lifecycle / approval / runtime / worktree transitions
- `src/session-interactions.ts`: action-token creation and state-driven button sets
- `src/session-notifications.ts`: delivery-state-aware wrapper around lifecycle notifications
- `src/harness/*`: Claude Code and Codex integrations
- `src/tools/*`: OpenClaw tool implementations
- `src/commands/*`: chat command implementations
- `src/worktree.ts`: git worktree, merge, and PR helpers
- `src/worktree-lifecycle-resolver.ts`: lifecycle-first cleanup and `released` detection

## Build And Test

```bash
pnpm verify
```

Use `pnpm verify` before merging behavior changes. CI and release workflows both gate on that exact command. `pnpm test` runs the stable per-file suite without force-exit, and `pnpm test:file tests/foo.test.ts` is the fastest way to rerun one file while debugging orchestration edge cases.

Release metadata for external plugin installs lives in `package.json` under `openclaw.compat` and `openclaw.build`. When bumping the supported OpenClaw baseline, update those fields together with `peerDependencies.openclaw`.

Additional smoke entry points:

- `pnpm smoke:backend-parity` for the shared backend-contract surface
- `pnpm smoke:codex-worktrees` for Codex native-worktree bootstrap/restore behavior
- `pnpm smoke:codex-live` for opt-in real App Server validation when a live Codex environment is available
- `pnpm smoke:codex-release` for the fuller opt-in operator/release check covering launch, `agent_respond`-style resume, structured plan delivery, restart/resume, and native worktree reuse

### Live Codex Release Check

Use `pnpm smoke:codex-release` only when you have a real Codex App Server environment available and want a release-confidence pass against the live protocol. It intentionally stays out of `pnpm verify`.

Before running it:

1. Make sure the local Codex App Server environment is configured and reachable.
2. Run it from a workspace where creating or reusing a native backend worktree is acceptable.
3. Treat failures as operator/runtime regressions first, not just test flakes.

## Extending The Plugin

### Add A Tool

1. Create a file in `src/tools/`.
2. Export a `makeAgentXxxTool()` factory.
3. Register it in `index.ts`.
4. Add or update tests.
5. Document it in [REFERENCE.md](REFERENCE.md).

### Add A Chat Command

1. Create a file in `src/commands/`.
2. Export `registerAgentXxxCommand()`.
3. Register it in `index.ts`.
4. Keep the behavior aligned with the corresponding tool when one exists.

### Add A Harness

1. Implement the `AgentHarness` interface in `src/harness/`.
2. Register it in the harness registry.
3. Define its default config shape in `src/config.ts`.
4. Update `openclaw.plugin.json` if the harness adds user-facing config.
5. Add launch, resume, and waiting-path tests.
6. Document the harness behavior in [REFERENCE.md](REFERENCE.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Contributor Notes

- Keep docs and schema text aligned. `README.md`, `docs/REFERENCE.md`, `skills/.../SKILL.md`, and `openclaw.plugin.json` should agree on defaults and parameter names.
- Prefer source-of-truth facts from `src/config.ts`, `src/types.ts`, and the tool factories.
- When editing docs for lifecycle behavior, verify the notification and resume flow in `src/session-manager.ts` and `src/actions/respond.ts`.
- When editing worktree behavior, verify the orchestration path in `src/session-manager.ts`, the lifecycle resolver in `src/worktree-lifecycle-resolver.ts`, and the git helper path in `src/worktree.ts`.

## Service Lifecycle

- `start()`: load config, create `SessionManager`, run orphan worktree cleanup, start periodic cleanup
- `stop()`: kill active sessions, clear timers, drop the singleton

## Docs Maintenance Checklist

Before merging a behavior change, confirm:

1. Tool parameters match the TypeBox schemas in `src/tools/*`.
2. Config defaults match `src/config.ts` and `openclaw.plugin.json`.
3. README only links to deeper docs; it should not become the full reference again.
4. Historical implementation plans stay out of the main docs surface.
5. `package.json` compatibility/build metadata matches the intended OpenClaw release floor.
