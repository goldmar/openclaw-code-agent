# Development

Contributor guide for `openclaw-code-agent`. For operator setup and runtime usage, see [REFERENCE.md](REFERENCE.md).

## Local Setup

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
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
│   ├── session-manager.ts
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
- `src/harness/*`: Claude Code and Codex integrations
- `src/tools/*`: OpenClaw tool implementations
- `src/commands/*`: chat command implementations
- `src/worktree.ts`: git worktree, merge, and PR helpers

## Build And Test

```bash
pnpm run build
pnpm run typecheck
pnpm test
```

Use `pnpm test` before merging behavior changes. The plugin has a lot of orchestration state, and regressions tend to hide in resume, worktree, and notification edge cases.

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
- When editing worktree behavior, verify both the orchestration path in `src/session-manager.ts` and the git helper path in `src/worktree.ts`.

## Service Lifecycle

- `start()`: load config, create `SessionManager`, run orphan worktree cleanup, start periodic cleanup
- `stop()`: kill active sessions, clear timers, drop the singleton

## Docs Maintenance Checklist

Before merging a behavior change, confirm:

1. Tool parameters match the TypeBox schemas in `src/tools/*`.
2. Config defaults match `src/config.ts` and `openclaw.plugin.json`.
3. README only links to deeper docs; it should not become the full reference again.
4. Historical implementation plans stay out of the main docs surface.
