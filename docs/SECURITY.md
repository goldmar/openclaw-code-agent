# Security

Security notes for `openclaw-code-agent`: the subprocesses it runs, its network and self-update behavior, the data it stores, and how the release gates check the packed bundle.

## Threat Model Summary

This plugin is an orchestration layer around local developer tooling. It is expected to:

- start local coding-agent backends (Claude Code in-process through its SDK; Codex and OpenCode as child processes)
- run local `git` / `gh` commands for worktree, merge, and PR flows
- run a repository's own `.openclaw/worktree-setup.sh` when it creates a worktree
- optionally run operator-provided verifier shell commands in explicit goal-task flows
- use OpenClaw's in-process runtime for notifications, system events, logging, LLM summaries, and Task Flow mirroring, and the local `openclaw` CLI for the few host operations external plugins cannot call in-process

Anyone who can launch an OCA session can make a coding agent run arbitrary commands in the chosen repository. Treat access to the orchestrator, and the repositories you point OCA at, accordingly.

The package declares OpenClaw install metadata in `package.json` and dangerous configuration flags in `openclaw.plugin.json`, so review tools can identify it as an executable, high-trust developer automation plugin rather than an instruction-only helper.

## Subprocess Inventory

Nothing runs through a shell string except the goal verifier, which is a shell command by design.

### Fixed executables

These call sites name the executable as a string literal with an argument array (`execFile("git", [...])`), never with `shell: true`.

| Executable | Source | What runs |
| --- | --- | --- |
| `git` | `src/git-exec.ts` (`runGit`), used by `src/worktree*.ts`, `src/worktree-ref-validation.ts`, `src/repo-policy.ts`, `src/tools/agent-pr.ts` | Worktree add/remove, status, diff, merge, rebase, push, and `git check-ref-format` branch-name validation. Explicit per-call timeouts, closed stdin, the Gateway's environment. Mutating sequences are serialized per repository. |
| `gh` | `src/git-exec.ts` (`runGh`), used by `src/worktree-repo.ts`, `src/worktree-pr.ts` | PR create, view, list, and edit when the GitHub CLI is installed and authenticated. |
| `openclaw` | `src/wake-delivery-executor.ts` | `openclaw gateway call chat.send --params <json>` for session wakes. This is the only delivery path that still uses the CLI: the in-process `runtime.gateway.request` surface is reserved for trusted plugins. |
| `openclaw` | `src/auto-update.ts` | `openclaw plugins inspect openclaw-code-agent --json` and, for ClawHub installs, `openclaw plugins search <package> --json` (update check); `openclaw plugins install <package>@<version> --force` (only after the user presses **Update now**); `openclaw gateway restart` (only after the user presses **Restart Gateway**). See [Self-update](#self-update). |

### Dynamic executables

These run a configurable command or a repository-provided file, so the executable cannot be a literal. Each has one call site.

| Command | Source | Notes |
| --- | --- | --- |
| Codex App Server | `src/harness/codex-rpc.ts` | `codex app-server --listen stdio://` (override with `OPENCLAW_CODEX_APP_SERVER_COMMAND` / `OPENCLAW_CODEX_APP_SERVER_ARGS`). JSON-RPC over stdio; one process per Codex session. |
| OpenCode server | `src/harness/opencode.ts` | One shared `opencode serve --hostname 127.0.0.1 --port 0 --print-logs` (override the binary with `OPENCLAW_OPENCODE_COMMAND`). Started lazily for the first OpenCode session, addressed through the URL it prints, and shut down about 30 seconds after the last OpenCode session ends. Binds to localhost only. |
| Worktree setup script | `src/worktree-provisioning.ts` | The repository's executable `.openclaw/worktree-setup.sh`, run directly (no shell, no stdin) in each new OCA worktree with a 120 s timeout and process-group termination. See [Worktree setup script](#worktree-setup-script). |
| Goal verifier | `src/goal-controller.ts` | `bash -lc <command>` for operator-supplied verifier commands in `agent_goal_launch(verifier...)`. `BASH_ENV` and `ENV` are removed from its environment so shell bootstrap hooks cannot rewrite verifier execution. Verifier commands are trusted operator input; do not expose goal launches to untrusted users. |

### In-process host surfaces (no subprocess)

- Direct user notifications: `sendDurableMessageBatch` from `openclaw/plugin-sdk/channel-outbound` (`src/direct-notification-transport.ts`). The host durable queue owns rendering, routing, and retries.
- System events and wake fallbacks: `api.runtime.system.enqueueSystemEvent` plus `requestHeartbeat` (`src/wake-transport.ts`).
- LLM summaries: `api.runtime.llm.complete` against the default agent's model (`src/runtime-llm.ts`); OCA never requests a model, agent, or auth-profile override.
- Logging: `api.runtime.logging.getChildLogger` (`src/logger.ts`).
- Task Flow mirroring: `api.runtime.tasks.async.managedFlows` (`src/session-task-lifecycle.ts`).

## Network

OCA makes one outbound request of its own: the npm update check, a bounded HTTPS `GET https://registry.npmjs.org/openclaw-code-agent/latest` with a 10 s timeout, sent only for npm installs and only while `autoUpdate` is on. It lives in its own bundle chunk (`dist/chunks/npm-release-client-*.js`), which reads no environment variables and sends no local data. ClawHub installs check through `openclaw plugins search` instead. Coding-agent backends make their own model-provider requests with their own credentials; OCA does not read or forward those credentials.

The environment variables OCA reads are local configuration: harness command overrides (`OPENCLAW_CODEX_APP_SERVER_*`, `OPENCLAW_OPENCODE_COMMAND`), OpenCode localhost server auth (`OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD`), worktree and state path overrides (`OPENCLAW_WORKTREE_DIR`, `OPENCLAW_STATE_DIR`, `OPENCLAW_HOME`, `OPENCLAW_CODE_AGENT_*_PATH`), and diagnostics switches. None are serialized into notifications, wakes, or the update check.

## Self-Update

The plugin config key `autoUpdate` (default `true`) controls the self-updater:

- **On:** about once a day OCA checks for a newer stable release from the plugin's recorded install source and, if one exists, sends **Update now** / **Remind later** / **Dismiss** buttons. Nothing is installed until a user presses **Update now**. OCA then reinstalls exactly the approved version from the recorded npm or ClawHub source (`openclaw plugins install <package>@<version> --force`) and verifies the installed version and install record with `openclaw plugins inspect`. The Gateway is restarted only after a separate **Restart Gateway** press (`openclaw gateway restart`).
- **Off (`autoUpdate: false`):** no update checks, installs, or restarts. Update buttons sent before the change reply that self-update is disabled.

Update buttons are single-use action tokens bound to the approved version.

## Worktree Setup Script

OpenClaw core runs `.openclaw/worktree-setup.sh` for its managed worktrees only when the caller has admin scope, because the `worktrees.create` Gateway method can be reached by lower-privileged clients. OCA always runs it for its own worktrees. An OCA worktree is created only for a coding session that the orchestrator launched in an operator-chosen repository, and the coding agent then runs in that same checkout with write and command access (full access by default after plan approval). The setup script therefore grants nothing the session does not already have. Do not use repositories whose setup scripts you do not trust as OCA workdirs.

## Data Locations

State lives under the OpenClaw state directory (`$OPENCLAW_STATE_DIR`, default `~/.openclaw`):

| Path | Contents |
| --- | --- |
| `<stateDir>/code-agent-sessions.json` | Session index: prompts, routes, worktree metadata, costs, and action tokens (override with `OPENCLAW_CODE_AGENT_SESSIONS_PATH`) |
| `<stateDir>/code-agent-goal-tasks.json` | Goal-task definitions and progress (override with `OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH`) |
| `<stateDir>/plugin-state/openclaw-code-agent/output/` | Session output transcripts (private directory and files) |
| `<stateDir>/plugin-state/openclaw-code-agent/auto-update.json` | Update-check state |
| `<repoRoot>/.worktrees/` | OCA worktrees (override with `worktreeDir` or `OPENCLAW_WORKTREE_DIR`) |

JSON stores are written as private (`0600`) files. [REFERENCE.md](REFERENCE.md#openclaw-host-integration) lists every path.

## Release Gates

- `pnpm check-clawhub-scan` (part of `pnpm verify`) runs ClawHub's static moderation scan, vendored from the ClawHub repository with its MIT license in `scripts/vendor/clawhub-moderation-engine.mjs`, over the exact packed file list. Any finding fails the gate. The release workflow repeats the scan on the exact tarball it publishes (`--tarball=<file>`), after `prepack` has rebuilt `dist/`. It also requires that `fetch(` appears only in the npm release-client chunk and that no packed file combines `process.env` with a network call. Refresh the vendored engine with `pnpm sync:clawhub-scan -- --clawhub <checkout>`.
- `pnpm check-plugin-security` packs and installs the plugin under an isolated temporary home and runs OpenClaw's deep static code-safety audit. It accepts only the reviewed `dangerous-exec` finding (`Shell command execution detected (child_process)`), which maps to the subprocess inventory above. Missing scans, scan errors, and any other finding fail the gate.

OpenClaw no longer blocks dangerous code during plugin installation. Operators who need a host-specific install decision should configure `security.installPolicy` after reviewing the inventory above.

## Review Guidance

When reviewing scanner output or a change touching subprocess or transport code:

- `child_process` findings must map to the inventory above. New executables, shell strings, or `shell: true` need a documented reason.
- Keep fixed commands literal (`execFile("git", [...])`); add new dynamic commands only with an entry here.
- Treat any path that reads environment values or secrets and sends them in outbound messages, subprocess arguments, or network requests as suspicious until reviewed.
- Keep the wake-delivery, direct-notification, auto-update, and goal-verifier tests green.
