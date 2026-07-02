# Development

Contributor guide for `openclaw-code-agent`. For operator setup and runtime usage, see [REFERENCE.md](REFERENCE.md).

## Local Setup

```bash
pnpm install
pnpm verify
```

Build output is the ESM bundle at `dist/index.js`.
`pnpm-lock.yaml` is the only committed JavaScript lockfile in this repo. Do not add `package-lock.json`; npm is only used for `npm publish` in release, while install, CI, and dependency resolution are all pnpm-based.

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
- `src/harness/*`: Claude Code, Codex, and experimental OpenCode integrations
- `src/tools/*`: OpenClaw tool implementations
- `src/commands/*`: chat command implementations
- `src/worktree.ts`: git worktree, merge, and PR helpers
- `src/worktree-lifecycle-resolver.ts`: lifecycle-first cleanup and `released` detection

## Build And Test

```bash
pnpm verify
```

Use `pnpm verify` before merging behavior changes. CI and release workflows both gate on that exact command. `pnpm test` runs the stable per-file suite without force-exit, and `pnpm test:file tests/foo.test.ts` is the fastest way to rerun one file while debugging orchestration edge cases.

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

Plugin-behavior review should also include:

```bash
pnpm check-plugin-security
```

That checker currently allowlists the accepted `child_process` surface while still failing on any additional OpenClaw dangerous-code finding. Treat the known warning as a review item, not as an auto-fix target. The current rationale and accepted subprocess inventory live in [SECURITY.md](SECURITY.md).

This repo currently has dev-only transitive advisories coming from upstream dependencies, so a blanket failing `pnpm audit` step is not the right merge gate until those findings are either remediated upstream or intentionally allowlisted with pnpm audit configuration.

For release preparation, also validate metadata parity explicitly:

```bash
pnpm run validate:release-metadata -- <version>
```

Release metadata for external plugin installs lives in `package.json` under `openclaw.compat` and `openclaw.build`, while the plugin manifest version and manifest-owned activation/setup descriptors live in `openclaw.plugin.json`. When cutting a release, keep the package/plugin versions aligned and update the manifest descriptors whenever the plugin-owned command or onboarding surface changes.

Release-prep docs should also cover behavior that changed since the previous tag. Keep release-specific details in `CHANGELOG.md` and current user-facing docs, and avoid hardcoding one release's feature list into this permanent developer guide.

Release-prep branches should stop after PR-ready changes and validation unless the maintainer explicitly asks to publish. Do not push a `v*` tag, dispatch `.github/workflows/release.yml`, or run `npm publish` / `clawhub package publish` during preparation-only work. Use `npm pack --dry-run` to check package contents without publishing.

The release workflow publishes one packed artifact to both npm and ClawHub. npm uses Trusted Publishing via GitHub OIDC; ClawHub publishing requires the repository secret `CLAWHUB_TOKEN`.

Additional smoke entry points:

- `pnpm smoke:backend-parity` for the shared backend-contract surface
- `pnpm smoke:codex-worktrees` for Codex plugin-managed worktree bootstrap and backend restore behavior
- `pnpm test:integ:crabbox` for deterministic Codex proof/Crabbox harness coverage; live Telegram Desktop proof stays disabled unless `OPENCLAW_RUN_LIVE_TELEGRAM_PROOF=1` and `--allow-live` are both used
- `pnpm smoke:codex-live` for opt-in real App Server validation when a live Codex environment is available
- `pnpm smoke:codex-release` for the fuller opt-in operator/release check covering launch, `agent_respond`-style resume, structured plan delivery, restart/resume, and worktree restore behavior
- `pnpm smoke:opencode-live` for opt-in real OpenCode server validation when `opencode >= 1.16.2` and provider auth are available

### Live Telegram / Crabbox Proof

Use the native Telegram Desktop proof only when you intentionally want to touch live
Telegram, the QA credential broker, and a Crabbox desktop lease. The deterministic
Crabbox suite above is the normal CI-safe gate.

Start with local checks:

```bash
pnpm test tests/oca-codex-telegram-proof.test.ts
pnpm typecheck
node --import tsx scripts/e2e/oca-codex-telegram-proof.ts doctor
node --import tsx scripts/e2e/oca-codex-telegram-proof.ts local-smoke --scenario basic
node --import tsx scripts/e2e/oca-codex-telegram-proof.ts run --dry-run
```

For real runs, prefer a prebuilt TDLib archive and pass both the archive path and
SHA-256. Building TDLib inside Crabbox is slow and older TDLib releases can fail
login with `UPDATE_APP_TO_LOGIN`; use a current `libtdjson.so` archive when one is
available.

```bash
export OPENCLAW_RUN_LIVE_TELEGRAM_PROOF=1
export OPENCLAW_TDLIB_ARCHIVE=/path/to/tdlib-main-linux-x64.tgz
export OPENCLAW_TDLIB_SHA256=<sha256>

node --import tsx scripts/e2e/oca-codex-telegram-proof.ts run \
  --allow-live \
  --tdlib-archive "$OPENCLAW_TDLIB_ARCHIVE" \
  --tdlib-sha256 "$OPENCLAW_TDLIB_SHA256"
```

If the leased QA Telegram state has expired, refresh it before blaming Crabbox:

1. Use `scripts/e2e/telegram-user-driver.py login` with a current TDLib library.
2. Provide the fresh Telegram login code when prompted. If Telegram also asks for
   2FA, use the Telegram account password from the correct 1Password login item.
3. Export the refreshed Desktop/TDLib state with
   `scripts/e2e/telegram-user-credential.ts export`.
4. Seed the `telegram-user` credential broker with the refreshed payload.
5. Rerun `run --dry-run`, then the live proof command above.

The runner also supports noninteractive credential injection for recovery runs:

```bash
export OPENCLAW_QA_TELEGRAM_LOGIN_CODE=<fresh-telegram-code>
export OPENCLAW_QA_TELEGRAM_USER_PASSWORD=<telegram-2fa-password>
```

Do not put the password or code in command-line args or committed files. A 1Password
passkey can help a human recover the account, but TDLib does not expose that WebAuthn
path to this runner; automation needs a live Telegram code/password flow or a
refreshed credential payload.

After every live attempt, verify cleanup:

- The JSON result has `ok: true` for a passed proof.
- Public artifacts are under `.artifacts/qa-e2e/oca-codex-telegram/.../public-artifacts`.
- Sensitive `.session` artifacts stay private and redacted artifacts do not contain
  credential payloads.
- The `telegram-user` lease was released.
- The Crabbox lease was stopped unless `--keep-box` was used for debugging.

### Live Codex Release Check

Use `pnpm smoke:codex-release` only when you have a real Codex App Server environment available and want a release-confidence pass against the live protocol. It intentionally stays out of `pnpm verify`.

Before running it:

1. Make sure the local Codex App Server environment is configured and reachable.
2. Run it from a workspace where creating plugin-managed worktrees and restoring Codex backend refs is acceptable.
3. Treat failures as operator/runtime regressions first, not just test flakes.

### Live OpenCode Smoke Check

Use `pnpm smoke:opencode-live` only when a real OpenCode environment is available. It starts `opencode serve`, creates a trivial session, sends a prompt through the harness's OpenCode compatibility path, waits for completion, and verifies that an assistant response was produced. It intentionally stays out of `pnpm verify` because it depends on local OpenCode installation and provider auth.

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
7. If the harness is experimental, mark that status in README, reference docs, manifest help text, and skill guidance without adding invalid config keys.

## Contributor Notes

- Keep docs and schema text aligned. `README.md`, `docs/REFERENCE.md`, `skills/.../SKILL.md`, and `openclaw.plugin.json` should agree on defaults and parameter names.
- Prefer source-of-truth facts from `src/config.ts`, `src/types.ts`, and the tool factories.
- When editing docs for lifecycle behavior, verify the notification and resume flow in `src/session-manager.ts` and `src/actions/respond.ts`.
- When editing worktree behavior, verify the orchestration path in `src/session-manager.ts`, the lifecycle resolver in `src/worktree-lifecycle-resolver.ts`, and the git helper path in `src/worktree.ts`.
- Keep first-run onboarding narrow. `uiHints` without `advanced: true` are what OpenClaw's plugin-config wizard prompts by default, so only genuinely first-run fields should remain non-advanced.
- Treat `fallbackChannel` as routing metadata, not a secret. Multi-workspace maps like `agentChannels` should stay advanced/manual because the generic wizard cannot collect them well.
- Do not re-surface deprecated legacy model keys in onboarding. New setup should point operators at `defaultHarness` and `harnesses.*` instead.

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
6. `package.json.version` and `openclaw.plugin.json.version` match the intended release version.
7. Approval docs mention both interactive Approve / Revise / Reject buttons and plain-text fallback behavior.
