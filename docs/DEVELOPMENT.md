# Development

Contributor guide for `openclaw-code-agent`. For operator setup and runtime usage, see [REFERENCE.md](REFERENCE.md).

## Local Setup

```bash
pnpm install
pnpm verify
```

Build output is the ESM bundle at `dist/index.js`. `pnpm build` deletes `dist/` first, and `prepack` runs the build, so `npm pack` and registry publishing never ship stale chunks.
`pnpm-lock.yaml` is the development lockfile. `npm-shrinkwrap.json` is the published consumer lockfile: generate it only with `pnpm generate:npm-shrinkwrap`; `pnpm check-static-guardrails` checks it. Do not add `package-lock.json`. Install, CI, and dependency resolution use pnpm; npm is used only for the shrinkwrap generator, `npm pack`, and `npm publish`.

## Repository Layout

```text
openclaw-code-agent/
├── index.ts
├── api.ts
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
│   ├── git-exec.ts
│   ├── worktree-provisioning.ts
│   └── worktree.ts
├── scripts/
├── tests/
├── docs/
└── skills/
```

## Main Code Paths

- `index.ts`: plugin registration, lazy service start/stop, interactive handlers
- `src/session-manager.ts`: session control plane
- `src/session.ts`: single-session lifecycle and event model
- `src/session-state.ts`: reducer-backed lifecycle / approval / runtime / worktree transitions
- `src/session-interactions.ts`: action-token creation and state-driven button sets
- `src/session-notifications.ts`: delivery-state-aware wrapper around lifecycle notifications
- `src/harness/*`: Claude Code, Codex, and experimental OpenCode integrations
- `src/harness/codex-app-server-protocol/`: generated Codex App Server wire types (see below; never edit by hand)
- `src/tools/*`: OpenClaw tool implementations
- `src/commands/*`: chat command implementations
- `src/worktree.ts`: git worktree, merge, and PR helpers (re-exports `worktree-repo`, `worktree-lifecycle`, `worktree-lifecycle-resolver`, `worktree-merge`, `worktree-pr`)
- `src/git-exec.ts`: the async `git` / `gh` runner and per-repository lock used by the worktree layer
- `src/worktree-provisioning.ts`: `.worktreeinclude` copies and `.openclaw/worktree-setup.sh` for new worktrees
- `src/worktree-lifecycle-resolver.ts`: lifecycle-first cleanup and `released` detection

## Build And Test

```bash
pnpm verify
```

Use `pnpm verify` before merging behavior changes. CI and release workflows both gate on that exact command. `pnpm test` runs the stable per-file suite without force-exit, and `pnpm test:file tests/foo.test.ts` is the fastest way to rerun one file while debugging orchestration edge cases.

### Test Isolation

Tests must never read or write the real OpenClaw state (`~/.openclaw`), however a file is started: `pnpm test`, `pnpm test:file`, `node --import tsx --test tests/foo.test.ts`, `node --import tsx tests/foo.test.ts`, or an IDE runner.

- Every `tests/**/*.test.ts` file starts with `import "./test-env";` (the relative path to `tests/test-env.ts`). `pnpm check-static-guardrails` fails otherwise. Put new test helpers in non-`.test.ts` files; they are loaded after `test-env` through the test file.
- `tests/test-env.ts` reuses only the per-file temp home that `scripts/run-tests.mjs` creates and names in `OPENCLAW_CODE_AGENT_TEST_HOME`. Any other `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR`, including a live Gateway configured under the OS temp dir, is replaced by a fresh temp home that is removed on exit. It drops `OPENCLAW_CODE_AGENT_SESSIONS_PATH` / `OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH` values outside the test home, and points `TMPDIR`/`TMP`/`TEMP` at a per-process directory so output cleanup cannot remove a real Gateway's legacy `/tmp/openclaw-agent-*.txt` files. `HOME` is left alone: OpenClaw paths resolve from `OPENCLAW_HOME` first, and git/gh fixtures read the developer's `HOME` config.
- Defense in depth: under `node:test` (`NODE_TEST_CONTEXT`, `--test`, or the flag `test-env` sets), the session store, goal store, output files, and auto-update state refuse to write, rename, or delete anything inside the OS account's `~/.openclaw` (or legacy `~/.clawdbot`), throw, and set a failing exit code (`src/test-state-guard.ts`). The Gateway never sets these markers, so production behavior is unchanged.
- A test that needs a specific store path passes an explicit `env` or sets `OPENCLAW_STATE_DIR` to its own `mkdtemp` directory and restores the previous value afterwards.
- Scripts under `scripts/` (e2e and proof helpers) may import only `src/harness/**` from `src/`; the static guardrails reject imports of state-owning modules. `scripts/check-plugin-security.mjs` runs `openclaw` with an isolated profile (`HOME`, `XDG_*`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`).

## Security And Audits

Use the repo's pnpm toolchain for dependency checks:

```bash
pnpm run audit:prod
```

Do not use `npm audit` here. npm audit expects an npm lockfile and fails with `ENOLOCK` when the repo only commits `pnpm-lock.yaml`.

Security automation should work like this:

- PR gating: GitHub Dependency Review checks dependency diffs in pull requests and works with `pnpm-lock.yaml`.
- Runtime/package gate: `pnpm run audit:prod` audits the published dependency set in CI without introducing a second lockfile. Keep `.github/workflows/security-audit.yml` on that script; do not switch the workflow back to `npm audit`.
- Version maintenance: Dependabot updates the JavaScript dependency set through the npm ecosystem support that covers pnpm projects.
- Full snapshot audit: run `pnpm audit` when you need the current advisory set for the full resolved pnpm graph, including dev dependencies.

Dependency updates are admitted by reproducible artifacts and verification rather than publication age. The repository sets pnpm's `minimumReleaseAge` to `0` because the pinned pnpm version otherwise applies a one-day default; do not add age exclusions, strict mode, cooldowns, or another elapsed-time gate. Regenerate `pnpm-lock.yaml` with pnpm and `npm-shrinkwrap.json` through `pnpm generate:npm-shrinkwrap`; then require frozen installation, exact runtime-version validation, the full build/test suite, production audit, dependency review, packed-consumer installation, and exact-head review. Do not hand-edit either lock artifact or weaken those gates for a newly published package.

OpenClaw 2026.9.6 supports Node 24.16.0+ on Node 24 and Node 26.1.0+ on Node 26; Node 22 and 25 are unsupported. CI covers both supported lines and release verification pins Node 24.16.0. Plugin-behavior review should also include:

```bash
pnpm check-plugin-security
```

That checker packs and installs the plugin under an isolated temporary home, runs OpenClaw's deep static code-safety audit, and accepts only the reviewed `dangerous-exec` finding documented in [SECURITY.md](SECURITY.md). It fails for missing scans, scan errors, or additional dangerous-code patterns without reading or migrating operator state.

`pnpm verify` also runs `pnpm check-clawhub-scan` after the build: ClawHub's static moderation scan (vendored in `scripts/vendor/clawhub-moderation-engine.mjs`, MIT) over the exact `npm pack` file list, plus two guards (`fetch(` only in the npm release-client chunk, and no packed file that combines `process.env` with a network call). It must report no findings. The release workflow runs the same check on the exact packed tarball (`node scripts/check-clawhub-scan.mjs --tarball=<file>`), because `prepack` rebuilds `dist/` during `npm pack`. Keep fixed commands literal (`execFile("git", [...])`), never name a function or method `spawn` / `exec` / `execFile`, and add any new dynamic command to the SECURITY.md inventory. Refresh the vendored engine from a ClawHub checkout with `pnpm sync:clawhub-scan --clawhub <dir>` (`--check` reports drift).

This repo currently has dev-only transitive advisories coming from upstream dependencies, so a blanket failing `pnpm audit` step is not the right merge gate until those findings are either remediated upstream or intentionally allowlisted with pnpm audit configuration.

For release preparation, also validate metadata parity explicitly:

```bash
pnpm run validate:release-metadata -- <version>
```

Release checklist:

1. `pnpm verify` (includes the ClawHub static scan of the packed files), `pnpm check-plugin-security`, and `pnpm run audit:prod`. The release workflow also runs the ClawHub package inspector (`clawhub package validate --runtime`).
2. `pnpm run validate:release-metadata -- <version>` and `pnpm verify:npm-consumer`.
3. `pnpm sync:codex-protocol --check` against the Codex CLI you validate with; it must report no drift. With a live Codex environment, run `pnpm smoke:codex-live` and `pnpm smoke:codex-release`, which repeat that check first.
4. `npm pack --dry-run` to review the package contents (`prepack` rebuilds `dist/`).

Release metadata for external plugin installs lives in `package.json` under `openclaw.compat` and `openclaw.build`, while the plugin manifest version and manifest-owned activation/setup descriptors live in `openclaw.plugin.json`. When cutting a release, keep the package/plugin versions aligned and update the manifest descriptors whenever the plugin-owned command or onboarding surface changes.

Release-prep docs should also cover behavior that changed since the previous tag. Keep release-specific details in `CHANGELOG.md` and current user-facing docs, and avoid hardcoding one release's feature list into this permanent developer guide.

Release-prep branches should stop after PR-ready changes and validation unless the maintainer explicitly asks to publish. Do not push a `v*` tag, dispatch `.github/workflows/release.yml`, or run `npm publish` / `clawhub package publish` during preparation-only work. Use `npm pack --dry-run` to check package contents without publishing.

The manually dispatched release workflow verifies one selected `main` commit, packs one artifact, and publishes that exact tarball to npm and ClawHub from the protected `release` environment. npm uses Trusted Publishing through GitHub OIDC (`--provenance`), so no npm token is stored. ClawHub publishes with the `CLAWHUB_TOKEN` repository secret, written to a temporary private CLI config for that step.

Additional smoke entry points:

- `pnpm smoke:backend` and `pnpm smoke:backend-parity` for the Codex harness, plan-mode, restore, and shared backend-contract surface
- `pnpm smoke:codex-worktrees` for Codex plugin-managed worktree bootstrap and session restore behavior
- `pnpm test:integ:crabbox` for deterministic Codex proof/Crabbox harness coverage; live Telegram Desktop proof stays disabled unless `OPENCLAW_RUN_LIVE_TELEGRAM_PROOF=1` and `--allow-live` are both used
- `pnpm smoke:codex-live` for opt-in real App Server validation when a live Codex environment is available (developer instructions, resume, steering, compaction, and rewind-fork; uses `gpt-6-luna` unless `OPENCLAW_CODEX_SMOKE_MODEL` is set)
- `pnpm smoke:codex-release` for the opt-in release check covering structured plan delivery and resume after a plan turn
- `pnpm smoke:opencode-live` for opt-in real OpenCode server validation when `opencode >= 1.16.2` is available. Add `OPENCLAW_RUN_LIVE_OPENCODE_COMPLETION_SMOKE=1` to run a real prompt (needs provider auth), `OPENCLAW_OPENCODE_SMOKE_MODEL=provider/model` to pick its model, and `OPENCLAW_OPENCODE_COMMAND` to test a different `opencode` binary

### Codex App Server Protocol Types

`src/harness/codex-app-server-protocol/` is generated. Do not edit it by hand. Regenerate it from the installed Codex CLI with `pnpm sync:codex-protocol` (runs `codex app-server generate-ts --experimental` and keeps only the import closure of the types the harness uses), and check drift with `pnpm sync:codex-protocol --check`. After a Codex upgrade, regenerate, run `pnpm typecheck`, and run the live Codex smoke. Both `pnpm smoke:codex-live` and `pnpm smoke:codex-release` start with that `--check`, so a live smoke fails when the installed Codex CLI's protocol no longer matches the vendored types.

### Live Codex Release Check

Use `pnpm smoke:codex-release` only when you have a real Codex App Server environment available and want a release-confidence pass against the live protocol. It intentionally stays out of `pnpm verify`.

Before running it:

1. Make sure the local Codex App Server environment is configured and reachable.
2. Run it from a workspace where short-lived Codex threads in temporary directories are acceptable.
3. Treat failures as operator/runtime regressions first, not just test flakes.

### Live OpenCode Smoke Check

Use `pnpm smoke:opencode-live` only when a real OpenCode environment is available. It starts `opencode serve` the way the harness does (`--port 0`) and checks the classic session routes (create, messages, status, fork, `prompt_async`, abort) and the `/global/event` stream without a model call. With `OPENCLAW_RUN_LIVE_OPENCODE_COMPLETION_SMOKE=1` it also runs a trivial prompt through `OpenCodeHarness` and checks the reply, which needs provider auth. It intentionally stays out of `pnpm verify` because it depends on a local OpenCode installation.

## Extending The Plugin

### Add A Tool

1. Create a file in `src/tools/`.
2. Export a `makeAgentXxxTool()` factory.
3. Register it in `index.ts` with `registerCodeAgentTool(..., { name })`.
4. Add the tool name to `openclaw.plugin.json` `contracts.tools` (`tests/plugin-entry.test.ts` enforces this).
5. Add or update tests.
6. Document it in [REFERENCE.md](REFERENCE.md), the README tool table, and the orchestration skill when agents should use it.

### Add A Chat Command

1. Create a file in `src/commands/`.
2. Export `registerAgentXxxCommand()`.
3. Register it in `index.ts`.
4. Add the command name to `openclaw.plugin.json` `activation.onCommands` (`tests/plugin-entry.test.ts` enforces this).
5. Keep the behavior aligned with the corresponding tool when one exists.

### Add A Harness

1. Implement the `AgentHarness` interface in `src/harness/`.
2. Register it in the harness registry.
3. Define its default config shape in `src/config.ts`.
4. Update `openclaw.plugin.json` if the harness adds user-facing config.
5. Add launch, resume, and waiting-path tests.
6. Document the harness behavior in [REFERENCE.md](REFERENCE.md) and [ARCHITECTURE.md](ARCHITECTURE.md).
7. If the harness is experimental, mark that status in README, reference docs, manifest help text, and skill guidance without adding invalid config keys.

## Contributor Notes

- Keep docs and schema text aligned. `README.md`, `docs/REFERENCE.md`, `skills/.../SKILL.md`, and `openclaw.plugin.json` should agree on defaults and parameter names.
- Prefer source-of-truth facts from `src/config.ts`, `src/types.ts`, and the tool factories.
- When editing docs for lifecycle behavior, verify the notification and resume flow in `src/session-manager.ts` and `src/actions/respond.ts`.
- When editing worktree behavior, verify the orchestration path in `src/session-manager.ts`, the lifecycle resolver in `src/worktree-lifecycle-resolver.ts`, and the git helper path in `src/worktree.ts`.
- Keep first-run onboarding narrow. `uiHints` without `advanced: true` are what OpenClaw's plugin-config wizard prompts by default, so only genuinely first-run fields should remain non-advanced.
- Treat `fallbackChannel` as routing metadata, not a secret. Multi-workspace maps like `agentChannels` should stay advanced/manual because the generic wizard cannot collect them well.
- Model settings live only under `harnesses.*` (plus `defaultHarness`); the removed flat keys (`defaultModel`, `model`, `reasoningEffort`, global `allowedModels`) must stay out of the schema and onboarding.
- Tool parameter schemas use the TypeBox builders from `src/tool-parameter-schema.ts`, not the `typebox` root `Type` object, which would pull the whole TypeBox type system into the bundle.
- Every `git` / `gh` call in `src/` (the worktree layer and branch-name validation) goes through the async `runGit` / `runGh` in `src/git-exec.ts`; do not add `execFileSync` anywhere in `src/`. Wrap multi-step mutating git sequences in `withRepoLock`.
- Import only public `openclaw/plugin-sdk/*` subpaths that untrusted external plugins may use (check the host `package.json` exports and `docs/plugins/sdk-subpaths.md`; private-local and trusted-only surfaces are off limits). Type-only imports are erased; every value or dynamic import must also be listed as `--external:` in the `build` script, which `tests/plugin-entry.test.ts` enforces.
- Log through `createLogger(...)` from `src/logger.ts` instead of `console.*`: it writes to the Gateway log via `api.runtime.logging.getChildLogger`. The console fallback is used only before plugin registration, in tests, or if the host logger throws; the build marks `console.log` / `info` / `warn` / `debug` as pure, so only `console.error` from that fallback can reach production output.

## Service Lifecycle

- `start()` runs on Gateway startup or lazily on the first tool, command, or callback: load config, create `SessionManager` and wait for it to restore persisted sessions and reconcile the Task Flow mirror, create and start the `GoalController`, create the auto-update service when `autoUpdate` is on, and bootstrap maintenance schedules (worktree retention cleanup, reminders, output-file cleanup)
- `stop()`: stop the goal controller, then `SessionManager.shutdown()` disposes maintenance, stops active sessions (`shutdown`), waits for in-flight launches, maintenance, and session teardown, and drains the Task Flow mirror; finally the runtime and singletons are cleared

## Docs Maintenance Checklist

Before merging a behavior change, confirm:

1. Tool parameters match the TypeBox schemas in `src/tools/*`.
2. Config defaults match `src/config.ts` and `openclaw.plugin.json`.
3. README only links to deeper docs; it should not become the full reference again.
4. Historical implementation plans stay out of the main docs surface.
5. `package.json` compatibility/build metadata matches the intended OpenClaw release floor.
6. `package.json.version` and `openclaw.plugin.json.version` match the intended release version.
7. Approval docs mention both interactive Approve / Revise / Reject buttons and plain-text fallback behavior.
