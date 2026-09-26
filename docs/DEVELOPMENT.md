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

`pnpm typecheck` checks the plugin source (`tsconfig.typecheck.json`, ES2022 library) and then the tests with the source (`tsconfig.tests.json`: ES2024 library for Node 24+ test code, and `allowJs` so imported `scripts/*.mjs` helpers are typed from their JavaScript and JSDoc). Keep test fakes typed: derive their types from the production or SDK types (`Pick<SessionManager, ...>`, `satisfies`, the vendored protocol types) instead of `any`; when a partial fake must stand in for a full type, cast once at that boundary with `as unknown as T` and say why.

### Coverage

```bash
pnpm coverage                          # whole suite
pnpm coverage tests/agent-pr-execute.test.ts  # selected files
```

`scripts/coverage.mjs` runs `scripts/run-tests.mjs` with `NODE_V8_COVERAGE` set and renders the result with c8 (pinned in the script and fetched through `pnpm dlx`, so it is not a project dependency). It prints a per-file table and totals for `src/` (excluding the generated Codex protocol types) and writes `coverage/coverage-summary.json` and `coverage/lcov.info` (gitignored). Coverage is for review only; CI does not gate on it. The full suite is CPU-heavy, so on a shared host run it remotely like `pnpm verify`.

### Property And Model-Based Tests

Some invariants are checked with generated inputs ([fast-check](https://fast-check.dev/), a dev dependency only):

- `tests/session-state-model.test.ts`: random event and control-patch sequences against the session control reducer (terminal statuses absorb, plan versions only increase, a closed or rejected plan version is never approved, `approvalExecutionState` follows the other fields, worktree states change only through worktree events).
- `tests/action-token-model.test.ts`: random mint / click / double-click / expire / consume / purge / delete / settle sequences through a real `SessionActionTokenStore` and the real callback handler (a stale, consumed, or expired token never acts, a token acts at most once, a worktree button never acts on a settled decision).
- `tests/session-route-properties.test.ts`: session keys built with the host's `buildAgentSessionKey` / `resolveThreadSessionKeys` (Telegram topics, Discord and Slack threads, account-scoped DMs) round-trip through OCA's route parsing, and `canonicalizeSessionRoute` is idempotent.
- `tests/pending-input-properties.test.ts`, `tests/store-normalization-properties.test.ts`, `tests/config-callback-properties.test.ts`: answer parsing, persisted-row normalization (seeded from `tests/fixtures/session-store-4.7.20.json`), config defaults, and callback payloads.

CI runs each property with a fixed seed and a small run budget (`tests/property-harness.ts`), so a failure reproduces exactly and the files add only seconds. On failure fast-check prints the seed, the shrink path, and the shrunk counterexample. For a deeper search, for example nightly or through `remote-heavy-run`, raise the budget and vary the seed:

```bash
OCA_PROPERTY_RUNS=5000 pnpm test:file tests/session-route-properties.test.ts   # 5000 runs per property
OCA_PROPERTY_RUNS=5000 OCA_PROPERTY_SEED=random pnpm test                      # fresh seed per property
OCA_PROPERTY_SEED=<seed from the failure> pnpm test:file tests/<file>.test.ts   # replay a failure
```

Keep a found counterexample as a plain regression test next to the fix.

### Test Fakes

- `tests/fake-host.ts`: a fake OpenClaw host. `createFakeHost()` returns an `OpenClawPluginApi` whose members OCA uses are typed as the SDK members: `runtime.llm.complete` (scripted replies; fails like a host without a model by default), `runtime.system.enqueueSystemEvent` / `requestHeartbeat`, `runtime.tasks.async.managedFlows` (an in-memory managed Task Flow store with revisions), `runtime.logging`, `runtime.config.current`, `runtime.state.resolveStateDir`, a `sendDurableMessageBatch` stand-in (`directNotificationTransport()` wires it into `RuntimeDirectNotificationTransport`), and tool, command, service, and interactive-handler registration with `runTool`, `runCommand`, `runInteractive`, `startServices`, and `stopServices`. Every call is recorded. `tests/host-sdk-contract.test.ts` pins OCA's payloads to the SDK types with `satisfies`.
- `tests/fake-github.ts`: real git repositories behind a `git@github.com:<owner>/<repo>.git` remote (served offline from a local bare repository through a repo-local `core.sshCommand`, so OCA's GitHub detection sees github.com) and a scriptable `gh` on `PATH` backed by a JSON state file (`pr list/view/create/edit/comment`, failure switches, recorded calls). `tests/agent-pr-execute.test.ts` drives `agent_pr` and the auto-PR worktree strategy through it.
- `tests/harness-backends.ts`: fake Claude, Codex, and OpenCode backends behind the production harness classes (see below). The Codex fake builds its frames from `tests/codex-fixtures.ts`, typed with the vendored protocol types, and both the Codex and the OpenCode fake validate every frame they send and receive against the vendored schemas (`tests/protocol-schema.ts`); a mismatch throws where it happens and fails the fixture's `dispose()`. `tests/codex-harness.test.ts` checks OCA's Codex request params and its mock's replies the same way.

### Test Isolation

Tests must never read or write the real OpenClaw state (`~/.openclaw`), however a file is started: `pnpm test`, `pnpm test:file`, `node --import tsx --test tests/foo.test.ts`, `node --import tsx tests/foo.test.ts`, or an IDE runner.

- Every `tests/**/*.test.ts` file starts with `import "./test-env";` (the relative path to `tests/test-env.ts`). `pnpm check-static-guardrails` fails otherwise. Put new test helpers in non-`.test.ts` files; they are loaded after `test-env` through the test file.
- `tests/test-env.ts` reuses only the per-file temp home that `scripts/run-tests.mjs` creates and names in `OPENCLAW_CODE_AGENT_TEST_HOME`. Any other `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR`, including a live Gateway configured under the OS temp dir, is replaced by a fresh temp home that is removed on exit. It drops `OPENCLAW_CODE_AGENT_SESSIONS_PATH` / `OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH` values outside the test home, and points `TMPDIR`/`TMP`/`TEMP` at a per-process directory so output cleanup cannot remove a real Gateway's legacy `/tmp/openclaw-agent-*.txt` files. `HOME` is left alone: OpenClaw paths resolve from `OPENCLAW_HOME` first, and git/gh fixtures read the developer's `HOME` config.
- Defense in depth: under `node:test` (`NODE_TEST_CONTEXT`, `--test`, or the flag `test-env` sets), the session store, goal store, output files, and auto-update state refuse to write, rename, or delete anything inside the OS account's `~/.openclaw` (or legacy `~/.clawdbot`), throw, and set a failing exit code (`src/test-state-guard.ts`). The Gateway never sets these markers, so production behavior is unchanged.
- A test that needs a specific store path passes an explicit `env` or sets `OPENCLAW_STATE_DIR` to its own `mkdtemp` directory and restores the previous value afterwards.
- Test files and worktrees live under the per-run temp dir (`tmpdir()` inside a test). `tests/test-env.ts` and `scripts/run-tests.mjs` clear an inherited `OPENCLAW_WORKTREE_DIR`, a test run fails when it leaves new `openclaw-worktree-*` or `openclaw-auto-merge-*` entries in the shared temp dir, and `pnpm check-static-guardrails` rejects literal `"/tmp/openclaw-"` paths in tests (use `tmpdir()` or a `/nonexistent/` placeholder).
- The repository is public, so tests, docs, and fixtures use synthetic identifiers only. `pnpm check-static-guardrails` fails on a Telegram chat id (`-100` followed by ten digits) other than the fakes `-1001234567890` and `-1009876543210`, and on token-shaped strings (`sk-…`, `sk-ant-…`, `ghp_…` and other GitHub tokens, `github_pat_…`, Slack `xox?-…`, AWS `AKIA…`, JWTs, private-key blocks, Telegram bot tokens) in `src/`, `tests/`, `docs/`, `scripts/`, `skills/`, `.github/`, and the top-level docs, except the fixture fakes listed in `scripts/check-static-guardrails.mjs`. Add a new fake there rather than a real value.
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
- Version maintenance: Dependabot updates the JavaScript dependency set through the npm ecosystem support that covers pnpm projects, GitHub Actions, and the release workflow's pinned ClawHub CLI (`.github/release-tools/`). Every entry has a 3-day `cooldown`, so Dependabot proposes only releases that have been public for 3 days. `.github/workflows/dependabot-automerge.yml` auto-merges only grouped patch/minor development updates and CodeQL action updates after an exact-head 5/5 Greptile review; runtime dependencies, OpenClaw, and the build toolchain (`esbuild`, `typescript`, `tsx`, and the bundled `typebox`) always need a manual review.
- Full snapshot audit: run `pnpm audit` when you need the current advisory set for the full resolved pnpm graph, including dev dependencies.

Automated updates wait out Dependabot's 3-day cooldown. pnpm's `minimumReleaseAge` stays `0` (the pinned pnpm otherwise applies a one-day default): pnpm 11 checks every lockfile entry against that window at install time, including frozen CI and release installs, so a window would block same-day OpenClaw compatibility updates. For a manual bump, check the publication date (`npm view <package> time`) and prefer releases older than 3 days unless compatibility requires a newer one. Regenerate `pnpm-lock.yaml` with pnpm and `npm-shrinkwrap.json` through `pnpm generate:npm-shrinkwrap`; then require frozen installation, exact runtime-version validation, the full build/test suite, production audit, dependency review, packed-consumer installation, and exact-head review. Do not hand-edit either lock artifact or weaken those gates for a newly published package.

Pinned runtime dependencies (`@hono/node-server`, `express-rate-limit`, `fast-uri`, `hono`, `ip-address`, `qs`) have two values, each kept in one place. The pinned version is the exact entry in `package.json` `dependencies`. The security floor, the lowest release with the relevant advisory fixes, is `RUNTIME_SECURITY_FLOORS` in `scripts/lib/runtime-dependency-pins.mjs`; raise it only for a new advisory. `scripts/check-npm-shrinkwrap.mjs` (part of `pnpm check-static-guardrails`) requires each pin to be an exact direct dependency at or above its floor that the shrinkwrap resolves, and requires any `pnpm-workspace.yaml` override of the same package to read `<name>@<<version>: <version>` with the `package.json` version. `pnpm verify:npm-consumer` reads the same pins. To bump a pin, change `package.json` and the matching override, then regenerate both lock files.

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

### Releasing

Releases are cut only by a maintainer, after the target OpenClaw release is out. Preparation happens in a normal PR; publishing is a manual dispatch of `.github/workflows/release.yml`.

1. **Versions.** Set the release version in `package.json` `version` and `openclaw.plugin.json` `version`, then run `pnpm generate:npm-shrinkwrap` (the shrinkwrap root carries the version) and `pnpm install` so `pnpm-lock.yaml` stays in sync.
2. **OpenClaw target and floor.** When a new OpenClaw release ships, update the build target (`openclaw.build.openclawVersion`, `openclaw.build.pluginSdkVersion`, `openclaw.install.minHostVersion`, and the exact `openclaw` dev dependency). Raise the compatibility floor (`openclaw.compat.pluginApi`, `openclaw.compat.minGatewayVersion`, and `peerDependencies.openclaw`) only when OCA starts depending on the new host. `pnpm validate:release-metadata -- <version>` and the plugin-entry tests derive both from `package.json`.
3. **CHANGELOG.** Rename `## [Unreleased]` to exactly `## [<version>] - YYYY-MM-DD` (`validate:release-metadata` requires the section, and the release job extracts the notes from it; `## [<version>]` alone is also accepted) and start a new empty `## [Unreleased]` above it. Breaking changes and upgrade notes belong in the release section.
4. **Protocol checks.** `pnpm sync:codex-protocol --check` against the Codex CLI you validate with (at least `MIN_CODEX_CLI_VERSION`, currently 0.156.1) and `pnpm sync:opencode-openapi --check` against the OpenCode you validate with; both must report no drift, or regenerate and retest. With a live Codex environment, run `pnpm smoke:codex-live` and `pnpm smoke:codex-release`, which repeat that check first, and `pnpm smoke:opencode-live` for OpenCode.
5. **Gates.** `pnpm verify` (includes the ClawHub static scan of the packed files), `pnpm check-plugin-security`, `pnpm run audit:prod`, `pnpm run validate:release-metadata -- <version>`, and `pnpm verify:npm-consumer`. Keep the complete bundle under the 700 KB limit that the **Bundle Size Check** enforces (`scripts/check-bundle-size.mjs`); the CI report shows the current size.
6. **Package contents.** `npm pack --dry-run` to review the files (`prepack` rebuilds `dist/`).
7. **Release tools.** The release workflow installs the ClawHub CLI from `.github/release-tools/package-lock.json` (currently `clawhub` 0.23.3, used for the inspector, the dry run, and the publish). Bump it deliberately in its own PR.
8. **Dispatch and approve.** After the PR merges, dispatch `release.yml` with the version and the full `main` commit SHA. The `release` environment requires a reviewer and holds `CLAWHUB_TOKEN`. The run pauses twice: approve the **Create release tag** job, then **Publish to npm** and **Publish to ClawHub**, which wait together and are approved at once. The GitHub release is created after both publishes.

Release metadata for external plugin installs lives in `package.json` under `openclaw.compat` and `openclaw.build`, while the plugin manifest version and manifest-owned activation/setup descriptors live in `openclaw.plugin.json`. When cutting a release, keep the package/plugin versions aligned and update the manifest descriptors whenever the plugin-owned command or onboarding surface changes.

Release-prep docs should also cover behavior that changed since the previous tag. Keep release-specific details in `CHANGELOG.md` and current user-facing docs, and avoid hardcoding one release's feature list into this permanent developer guide.

Release-prep branches should stop after PR-ready changes and validation unless the maintainer explicitly asks to publish. Do not push a `v*` tag, dispatch `.github/workflows/release.yml`, or run `npm publish` / `clawhub package publish` during preparation-only work. Use `npm pack --dry-run` to check package contents without publishing.

The manually dispatched release workflow verifies one selected `main` commit, packs one artifact, and publishes that exact tarball to npm and ClawHub from the protected `release` environment, in separate jobs. The npm job holds only the GitHub OIDC token for Trusted Publishing (`--provenance`), checks out nothing, and installs nothing, so no npm token is stored. The ClawHub job has no OIDC token and no repository write access; it publishes with the `CLAWHUB_TOKEN` secret of the `release` environment, written to a temporary private CLI config for that step. The workflow validates the `version` input as a strict semantic version and the `commit` input as a full SHA, passes both to shell steps only through environment variables, and uses no dependency cache.

Additional smoke entry points:

- `pnpm smoke:backend` and `pnpm smoke:backend-parity` for the Codex harness, plan-mode, restore, and shared backend-contract surface
- `pnpm smoke:codex-worktrees` for Codex plugin-managed worktree bootstrap and session restore behavior
- `pnpm test:integ:crabbox` for deterministic Codex proof/Crabbox harness coverage; live Telegram Desktop proof stays disabled unless `OPENCLAW_RUN_LIVE_TELEGRAM_PROOF=1` and `--allow-live` are both used
- `pnpm smoke:codex-live` for opt-in real App Server validation when a live Codex environment is available (developer instructions, resume, steering, compaction, and rewind-fork; uses `gpt-6-luna` unless `OPENCLAW_CODEX_SMOKE_MODEL` is set)
- `pnpm smoke:codex-release` for the opt-in release check covering structured plan delivery and resume after a plan turn
- `pnpm smoke:opencode-live` for opt-in real OpenCode server validation when `opencode >= 1.16.2` is available. Add `OPENCLAW_RUN_LIVE_OPENCODE_COMPLETION_SMOKE=1` to run a real prompt (needs provider auth), `OPENCLAW_OPENCODE_SMOKE_MODEL=provider/model` to pick its model, and `OPENCLAW_OPENCODE_COMMAND` to test a different `opencode` binary

### User-Interaction Flow Tests

Questions, permission requests, plan reviews, and worktree decisions are tested end to end for every harness, in `pnpm verify`:

- `tests/cross-harness-questions.test.ts`: answers by option number and label, multi-select picks, free text, multi-question requests, rejected answers (empty, option number outside the list), Telegram and Discord buttons, repeated and outdated button clicks, question timeouts, and answers after idle suspension or a Gateway restart.
- `tests/cross-harness-permission-requests.test.ts`: Codex approvals under the `on-request` policy and OpenCode `permission.asked` (once / always / reject), from buttons and from text replies.
- `tests/cross-harness-plan-approval.test.ts`: `planApproval` `ask`, `delegate`, and `approve`; Approve, Revise, and Reject from buttons and from plain-text replies; plan versions and stale buttons; approval after idle suspension or a Gateway restart; and how each harness receives the decision (Claude Code's held `ExitPlanMode`, Codex's `plan` collaboration mode with `[SYSTEM:]` prompts, OpenCode's `plan` → `build` agent switch).
- `tests/worktree-decision-flows.test.ts`: `ask` and `delegate` worktree decisions, the Merge / Later / Discard buttons, buttons from a decision that was already settled, and the repo-policy prompt before launch.

The same flows also run through the real plugin entry (`register` from `index.ts`) on the fake host, so the WakeDispatcher, route resolution, and delivery transports are the production code: `tests/fullstack-fixture.ts` points `sendDurableMessageBatch` (through `directNotificationTransportInternals`) and the `openclaw gateway call chat.send` wake (through `wakeDeliveryExecutorInternals.execFile`) at recorders, gives each runtime its own session index and goal store, decodes the buttons of every durable send, and clicks them through the interactive handler the plugin registered.

- `tests/fullstack-flows.test.ts`: a question on a Telegram topic, a plan approval in a Discord thread, and a worktree Merge, once per harness; the plain-text plan prompt when the host refuses buttons; the orchestrator wake and system-event fallbacks when delivery fails; and buttons that are never shown because their prompt was answered while their tokens were being persisted.
- `tests/fullstack-faults.test.ts`: a Gateway restart from the store snapshot taken after every save of a question, plan, and worktree flow (no lost pending prompt or live button, no used button acting twice, no orphan worktree state); saves that throw; a failing or hung `runtime.llm`; a backend dying mid-turn (Codex stdio close, Claude query error, OpenCode server exit) and an OpenCode event-stream drop; and a Gateway stop while a Merge runs.
- `tests/fullstack-gaps.test.ts`: a failed Merge re-offering fresh controls, the auto-merge conflict resolver on a real rebase conflict, the 24h snooze and the reminder after it, the Resume / Restart / View output buttons, a button whose action this build does not know, and the goal loop (verifier, repair, idle-timeout resume, waiting for user).
- `tests/concurrency-properties.test.ts`: a fast-check model of two writers of one session index (random mints, clicks, rows, syncs, and lock contention; nothing is lost and each button acts at most once), overlapping saves from two module copies of the store, concurrent clicks on one button, and a click racing a Gateway stop.

Each suite runs its scenarios once per harness through the real `SessionManager`, `agent_respond` (`executeRespond`), and button callback handler. The harness adapters are the production classes with fake backends from `tests/harness-backends.ts`: a scripted Claude SDK query, a Codex app-server JSON-RPC client, and an OpenCode HTTP/SSE server. `tests/user-interaction-fixture.ts` launches the session, captures notifications, and clicks buttons as Telegram or Discord deliver them. A scenario that a backend cannot produce (Codex has no multi-select questions; Claude Code raises no permission requests) is listed as an empty test whose title gives the reason. When a backend protocol changes, update its fake in `tests/harness-backends.ts` and check the change against the live smoke below.

### Live User-Interaction Smoke

The deterministic suites above use fake backends. To check the same flows against a real backend, run a short session per harness through a Gateway with a Telegram or Discord route. This uses model quota, so run it before a release or after a harness protocol change, not on every change. Use a cheap model and low effort, a scratch git repository as `workdir`, and `worktree_strategy: "off"` except for the worktree step.

For each harness (`claude-code`, `codex`, `opencode`):

1. Questions: `agent_launch(harness=..., permission_mode="default", prompt="Use your structured question tool to ask me two questions at once: which color (Red, Green, Blue) and which sizes (Small, Medium, Large, several allowed). Then repeat my answers and stop.")`. Codex has no multi-select questions and may offer `request_user_input` only in its `plan` collaboration mode; if the question arrives as plain text, rerun with `permission_mode="plan"`. Answer the first question with an option button, then send `7` and an empty reply with `agent_respond` (both must be rejected with the question shown again), then answer `1, 3`. Click the first button again: it must say the question is no longer active.
2. Permission requests (Codex and OpenCode): with `harnesses.codex.permissionProfile: ":workspace"`, `approvalPolicy: "on-request"`, and `approvalsReviewer: "user"` for Codex, and `permission_mode="default"` for OpenCode, ask for a command that needs approval (for example a network call). Answer once with a button and once with a text reply (`yes`, `no`, or feedback text).
3. Plan review: `agent_launch(harness=..., permission_mode="plan", plan_approval="ask", prompt="Plan a one-line README change.")`. Press Revise and send feedback, check that the Approve button of the first version reports stale, then approve the revised plan. Repeat with `plan_approval="delegate"` (the orchestrator approves or asks the user) and with `plan_approval="approve"`.
4. Restart and suspension: while a question or a plan waits, restart the Gateway (or wait for the idle timeout) and then press the pending button. The session must resume with the answer or the approval.
5. Worktree decision: launch with `worktree_strategy="ask"` in a repository whose policy is `never-pr`, let the session commit a change, press Merge, then press Discard on the same prompt: it must report the decision as already resolved.

Stop the sessions with `agent_kill` and delete the scratch repository afterwards. The opt-in automated smokes (`pnpm smoke:codex-live`, `pnpm smoke:codex-release`, `pnpm smoke:opencode-live`) cover protocol shapes but not these interactive flows.

### Codex App Server Protocol Types

`src/harness/codex-app-server-protocol/` and `tests/protocol/codex-app-server.schema.json` are generated. Do not edit them by hand. Regenerate both from the installed Codex CLI with `pnpm sync:codex-protocol` (runs `codex app-server generate-ts --experimental` and keeps only the import closure of the types the harness uses, and `codex app-server generate-json-schema --experimental` pruned to the requests, notifications, and server requests the harness handles, listed in the script), and check drift with `pnpm sync:codex-protocol --check`. Add a method to the script's lists before a test fake sends it. After a Codex upgrade, regenerate, run `pnpm typecheck`, and run the live Codex smoke. Both `pnpm smoke:codex-live` and `pnpm smoke:codex-release` start with that `--check`, so a live smoke fails when the installed Codex CLI's protocol no longer matches the vendored types.

### Live Codex Release Check

Use `pnpm smoke:codex-release` only when you have a real Codex App Server environment available and want a release-confidence pass against the live protocol. It intentionally stays out of `pnpm verify`.

Before running it:

1. Make sure the local Codex App Server environment is configured and reachable.
2. Run it from a workspace where short-lived Codex threads in temporary directories are acceptable.
3. Treat failures as operator/runtime regressions first, not just test flakes.

### OpenCode OpenAPI Document

`tests/protocol/opencode-openapi.json` is generated from `opencode serve` (`GET /doc`) by `pnpm sync:opencode-openapi`, pruned to the operations the harness calls (listed in `scripts/sync-opencode-openapi.mjs`) and the component schemas they reference. The server runs under a throwaway `HOME`/XDG profile. The document records the OpenCode version it came from in `x-oca-source-version` (currently `opencode 1.18.32`; the harness supports `opencode >= 1.16.2`). Check drift against the installed OpenCode with `pnpm sync:opencode-openapi --check`, and after an OpenCode upgrade regenerate it, rerun the OpenCode tests, and run the live smoke below.

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
- Log through `createLogger(...)` from `src/logger.ts` instead of `console.*`: it writes to the Gateway log via `api.runtime.logging.getChildLogger`. The console fallback is used only before plugin registration, in tests, or if the host logger throws; the build marks `console.log` / `info` / `debug` as pure, so only `console.warn` and `console.error` from that fallback reach production output (`tests/logger.test.ts` bundles the logger with the build flags to keep it that way).

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
