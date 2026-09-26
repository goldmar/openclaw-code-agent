# Security

Security notes for `openclaw-code-agent`: the subprocesses it runs, its network and self-update behavior, the data it stores, and how the release gates check the packed bundle.

## Threat Model Summary

This plugin is an orchestration layer around local developer tooling. It is expected to:

- start local coding-agent backends as child processes (Claude Code through the Claude Agent SDK, which spawns its bundled `claude` executable; Codex and OpenCode directly)
- run local `git` / `gh` commands for worktree, merge, and PR flows
- run a repository's own `.openclaw/worktree-setup.sh` when it creates a worktree
- optionally run verifier shell commands in explicit goal-task flows, after the user confirms them
- use OpenClaw's in-process runtime for notifications, system events, logging, LLM summaries, and Task Flow mirroring, and the local `openclaw` CLI for the few host operations external plugins cannot call in-process

Anyone who can launch an OCA session can make a coding agent run arbitrary commands in the chosen repository. The orchestrator is itself a model: it fills in tool parameters such as the launch `workdir` and goal `verifier_commands` from the conversation, so a prompt it reads can steer them. Treat access to the orchestrator, and every repository the Gateway user can reach, accordingly.

The package declares OpenClaw install metadata in `package.json` and dangerous configuration flags in `openclaw.plugin.json`, so review tools can identify it as an executable, high-trust developer automation plugin rather than an instruction-only helper.

## Subprocess Inventory

Nothing runs through a shell string except the goal verifier, which is a shell command by design.

### Fixed executables

These call sites name the executable as a string literal with an argument array (`execFile("git", [...])`), never with `shell: true`.

| Executable | Source | What runs |
| --- | --- | --- |
| `git` | `src/git-exec.ts` (`runGit`), used by `src/worktree*.ts`, `src/worktree-ref-validation.ts`, `src/repo-policy.ts`, `src/tools/agent-pr.ts` | Worktree add/remove, status, diff, merge, rebase, push, and `git check-ref-format` branch-name validation. Explicit per-call timeouts, closed stdin, the Gateway's environment. Mutating sequences are serialized per repository. Repository git hooks run during OCA's merge, rebase, and commit steps unless `worktreeGitHooks` is `"skip"` (default `"run"`); a merge whose changes touch the repository's hook paths or `.openclaw/worktree-setup.sh` asks the user to confirm first. |
| `gh` | `src/git-exec.ts` (`runGh`), used by `src/worktree-repo.ts`, `src/worktree-pr.ts` | PR create, view, list, edit, and comment when the GitHub CLI is installed and authenticated, plus a `gh --version` availability probe. |
| `openclaw` | `src/wake-delivery-executor.ts` | `openclaw gateway call chat.send --expect-final --timeout 30000 --params <json>` for session wakes. This is the only delivery path that still uses the CLI: the in-process `runtime.gateway.request` surface is reserved for trusted plugins. The wake text (session name, status, fenced agent output) is part of that command line for up to 30 s, so other local users can read it in `ps` unless `/proc` is mounted with `hidepid=2` (recommended on shared hosts). `openclaw gateway call` accepts params only as `--params <json>` (no stdin or file option as of OpenClaw 2026.9.6), and the in-process alternatives are worse: a system event would label every line of the agent output as `System:` in the orchestrator's prompt, and `runtime.subagent.run` starts an `agent` run rather than a `chat.send` turn and is only bound inside a Gateway request scope. |
| `openclaw` | `src/auto-update.ts` | `openclaw plugins inspect openclaw-code-agent --json` and, for ClawHub installs, `openclaw plugins search <package> --limit 100 --json` (update check); `openclaw plugins install <package>@<version> --force` for npm installs or `openclaw plugins install clawhub:<package>@<version> --force` for ClawHub installs (only after the user presses **Update now**); `openclaw gateway restart` (only after the user presses **Restart Gateway**). See [Self-update](#self-update). |

### Dynamic executables

These run a configurable command or a repository-provided file, so the executable cannot be a literal. Each has one call site.

| Command | Source | Notes |
| --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk`, called from `src/harness/claude-code.ts` | The SDK spawns its bundled native `claude` executable for each session. The spawn happens inside the SDK dependency, not in OCA's own code. |
| Codex App Server | `src/harness/codex-rpc.ts` | `codex app-server --listen stdio://` (override with `OPENCLAW_CODEX_APP_SERVER_COMMAND` / `OPENCLAW_CODEX_APP_SERVER_ARGS`). JSON-RPC over stdio; one process per Codex session, in its own process group (closing the session stops the commands it started; the app server exits when the Gateway's end of the pipe closes). Its sandbox and approvals come from `harnesses.codex.*` or, when unset, the host `tools.exec.mode`; see [Codex sandbox](#codex-sandbox). |
| OpenCode server | `src/harness/opencode.ts`, `src/harness/process-lifeline.ts` | One shared `opencode serve --hostname 127.0.0.1 --port 0 --print-logs` (override the binary with `OPENCLAW_OPENCODE_COMMAND`), in its own process group, so closing it stops its tool processes too. A watchdog, `node -e <fixed source> <group id>` with the Gateway's Node executable, holds a pipe from the Gateway and signals only that process group when the pipe closes, so the server stops with the Gateway even on SIGKILL; it starts nothing itself. Started lazily for the first OpenCode session, addressed through the URL it prints, and shut down about 30 seconds after the last OpenCode session ends. Binds to localhost only and requires a random per-spawn password; see [Network](#network). |
| Worktree setup script | `src/worktree-provisioning.ts` | The repository's `.openclaw/worktree-setup.sh` as committed on the base branch (never an uncommitted or modified working-tree copy), run directly (no shell, no stdin) in each new OCA worktree with a 120 s timeout and process-group termination. It gets a minimal environment plus `OPENCLAW_SOURCE_TREE_PATH` and `OPENCLAW_WORKTREE_PATH`, not the Gateway environment. See [Worktree setup script](#worktree-setup-script). |
| Goal verifier | `src/goal-controller.ts` | `bash` runs each command from `agent_goal_launch(verifier_commands=...)` in the goal's workdir. The orchestrator model supplies these commands, so they are not operator input: OCA shows the exact list to the user, who confirms it once when the goal launches, and nothing runs before that. Verifiers run with a minimal environment instead of the Gateway's. Do not expose goal launches to untrusted users. |

### Environment

Coding-agent processes (the Claude Code executable, the Codex App Server, and the OpenCode server) get the Gateway's environment minus secrets unrelated to a coding agent: GitHub, npm, ClawHub, 1Password, and cloud-infrastructure tokens, chat bot tokens, and every `OPENCLAW_*TOKEN` / `*PASSWORD` / `*SECRET` variable (the exact list is in [REFERENCE.md](REFERENCE.md#child-process-environments)). The agents still read their own provider credentials and configuration from it, so anything else in the Gateway environment is visible to them and to the commands they run: keep credentials the agents should not see out of the Gateway environment. OCA's own `git` / `gh` calls keep the full environment (pushes and pull requests need `SSH_AUTH_SOCK`, `GH_TOKEN`, and git credential helpers). The worktree setup script and goal verifiers get a minimal allowlisted environment.

### In-process host surfaces (no subprocess)

- Direct user notifications: `sendDurableMessageBatch` from `openclaw/plugin-sdk/channel-outbound` (`src/direct-notification-transport.ts`). The host durable queue owns rendering, routing, and retries.
- System events and wake fallbacks: `api.runtime.system.enqueueSystemEvent` plus `requestHeartbeat` (`src/wake-transport.ts`).
- LLM summaries: `api.runtime.llm.complete` against the default agent's model (`src/runtime-llm.ts`); OCA never requests a model, agent, or auth-profile override.
- Logging: `api.runtime.logging.getChildLogger` (`src/logger.ts`).
- Task Flow mirroring: `api.runtime.tasks.async.managedFlows` (`src/session-task-lifecycle.ts`).

## Codex Sandbox

When `harnesses.codex.permissionProfile` / `approvalPolicy` / `approvalsReviewer` are unset, OCA follows the host `tools.exec.mode` like OpenClaw's bundled Codex plugin: unset or `full` gives the trusted local operator posture (`:danger-full-access`, `never`, `user`), `auto` gives `:workspace` + `on-request` + `auto_review`, `ask` the same with approvals in chat, and `deny` / `allowlist` refuse Codex launches unless `permissionProfile` is set explicitly. Explicit OCA values always win. `auto_review` is otherwise an opt-in. OCA's `permissionMode` does not change these settings (in 4.x, `bypassPermissions` always meant full access).

Codex's `plan` collaboration mode only tells the model to plan; it enforces nothing. A live check with Codex CLI 0.156.1 under the default `:danger-full-access` + `never` posture showed it: a plan turn asked to run `python3 -c 'import calc'` wrote `__pycache__` before the plan was approved. OCA therefore enforces read-only plan review itself (D5): every plan turn runs with the `:read-only` profile **and** approval policy `never`, and OCA declines any approval request that still arrives during a plan turn. The approval policy matters: a first attempt that switched only the profile still wrote under `tools.exec.mode: "auto"` and `"ask"`, because the model asked to escalate out of the sandbox and, with `on-request`, the `auto_review` reviewer approved the escalation (`auto`) or the request was routed to chat and approved there (`ask`). Turn settings are sticky in Codex, so every turn after approval re-sends the configured posture. A `compact` or `review` started during plan review also runs read-only.

Explicit `harnesses.codex.*` settings that run Codex while the host's `tools.exec.mode` is `deny` or `allowlist` are an operator opt-in, but they are logged as a warning, and `openclaw doctor` flags `permissionProfile: ":danger-full-access"` and `approvalPolicy: "never"` as dangerous configuration (`dangerousFlags` in `openclaw.plugin.json`).

Under `:workspace`, Codex may write only inside the workspace and has no network access. A command that needs more (network, for example `git push`, package installs, or API calls; or writes outside the workspace) is an escalation: with `on-request` Codex asks, and `auto_review` has Codex's reviewer subagent approve or deny it based on the task and its risk, usually within seconds and without a chat prompt. Denied requests fail back to the model. Set `approvalsReviewer: "user"` to get approval buttons in chat instead, or `[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml` to allow network inside the sandbox. Claude Code and OpenCode have no equivalent OCA-managed sandbox: after plan approval they run with the permissions their permission mode grants (`bypassPermissions` by default). Goal sessions do not skip plan review: the first iteration of a goal loop goes through the plan gate like any other launch, and later iterations run with the approved permissions.

## Network

OCA makes one outbound request of its own: the npm update check, a bounded HTTPS `GET https://registry.npmjs.org/openclaw-code-agent/latest` with a 10 s timeout, sent only for npm installs and only while `autoUpdate` is on. It lives in its own bundle chunk (`dist/chunks/npm-release-client-*.js`), which reads no environment variables and sends no local data. ClawHub installs check through `openclaw plugins search` instead. Apart from that, OCA talks only to local processes: stdio JSON-RPC to Codex, and HTTP to the shared `opencode serve` on 127.0.0.1. Every spawn of that server gets its own random password (passed to it as `OPENCODE_SERVER_PASSWORD`, never logged or persisted), and OCA sends it as Basic auth with each request, so other local users and processes cannot drive the server even though it listens on 127.0.0.1. Coding-agent backends make their own model-provider requests with their own credentials; OCA does not read or forward those credentials.

The environment variables OCA reads are local configuration: harness command overrides (`OPENCLAW_CODEX_APP_SERVER_*`, `OPENCLAW_OPENCODE_COMMAND`), worktree and state path overrides (`OPENCLAW_WORKTREE_DIR`, `OPENCLAW_WORKTREE_BASE_BRANCH`, `OPENCLAW_CODE_AGENT_*_PATH`, and `OPENCLAW_STATE_DIR` / `OPENCLAW_HOME` through the host's `resolveStateDir`), the Claude Code plans directory (`CLAUDE_CONFIG_DIR`), the GitHub CLI host settings (`GH_HOST`, `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `APPDATA`, plus only the host names from `gh`'s `hosts.yml`), `PATH` for command resolution, and diagnostics switches (`OPENCLAW_CODE_AGENT_*_DIAGNOSTICS`, `OPENCLAW_DEBUG_SESSION_STORE`). None are serialized into notifications, wakes, or the update check.

## Self-Update

The plugin config key `autoUpdate` (default `true`) controls the self-updater:

- **On:** about once a day OCA checks for a newer stable release from the plugin's recorded install source and, if one exists, sends **Update now** / **Remind later** / **Dismiss** buttons. Nothing is installed until a user presses **Update now**. OCA then reinstalls exactly the approved version from the recorded npm or ClawHub source (`openclaw plugins install <package>@<version> --force`, or `clawhub:<package>@<version>` for ClawHub installs) and verifies the installed version and install record with `openclaw plugins inspect`. The Gateway is restarted only after a separate **Restart Gateway** press (`openclaw gateway restart`).
- **Off (`autoUpdate: false`):** no update checks, installs, or restarts. Update buttons sent before the change reply that self-update is disabled.

Update buttons are single-use action tokens bound to the approved version.

Every OCA button is an opaque, expiring action token. Besides the host's authorized-sender check, a token is bound to the chat its button was delivered to: a callback carrying it from another chat or channel is refused, so a token copied out of one conversation cannot act from another.

## Worktree Setup Script

OpenClaw core runs `.openclaw/worktree-setup.sh` for its managed worktrees only when the caller has admin scope, because the `worktrees.create` Gateway method can be reached by lower-privileged clients. OCA runs it for its own worktrees. The repository is not necessarily one an operator picked: the launch `workdir` is a tool parameter the orchestrator model fills in from the conversation (or `defaultWorkdir`), so any repository the Gateway user can read can become an OCA workdir. OCA therefore runs only the version of the script committed on the base branch, never an untracked or modified copy in the working tree, with a minimal environment rather than the Gateway's. A merge whose changes touch the setup script asks the user to confirm first. The script still runs unsandboxed with the Gateway user's filesystem privileges, which can be more access than a Codex session has inside a `:workspace` sandbox. Do not point OCA at repositories whose committed setup scripts you do not trust.

## Data Locations

State lives under the OpenClaw state directory (`$OPENCLAW_STATE_DIR`; otherwise `$OPENCLAW_HOME/.openclaw` or `~/.openclaw`, resolved by the host's `resolveStateDir`):

| Path | Contents |
| --- | --- |
| `<stateDir>/code-agent-sessions.json` | Session index: prompts, routes, worktree metadata, costs, action tokens, and repo policies (override with `OPENCLAW_CODE_AGENT_SESSIONS_PATH`) |
| `<index>.legacy-<timestamp>.json` | Verbatim backup written before an upgrade drops rows that no longer load |
| `<stateDir>/code-agent-goal-tasks.json` | Goal-task definitions and progress (override with `OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH`) |
| `<stateDir>/plugin-state/openclaw-code-agent/output/` | Session output transcripts (private directory and files) |
| `<stateDir>/plugin-state/openclaw-code-agent/auto-update.json` | Update-check state |
| `<repoRoot>/.worktrees/` | OCA worktrees (override with `worktreeDir` or `OPENCLAW_WORKTREE_DIR`); OCA adds the worktree directory to `<repoRoot>/.git/info/exclude` |
| `/tmp/openclaw-agent-*.txt` | Pre-5.0 transcripts, readable through their stored paths until maintenance ages them out |

JSON stores are written as private (`0600`) files. [REFERENCE.md](REFERENCE.md#openclaw-host-integration) lists every path.

## Release Gates

- `pnpm check-clawhub-scan` (part of `pnpm verify`) runs ClawHub's static moderation scan, vendored from the ClawHub repository with its MIT license in `scripts/vendor/clawhub-moderation-engine.mjs`, over the exact packed file list. Any finding fails the gate. The release workflow repeats the scan on the exact tarball it publishes (`--tarball=<file>`), after `prepack` has rebuilt `dist/`. It also requires that `fetch(` appears only in the npm release-client chunk and that no packed file combines `process.env` with a network call. Refresh the vendored engine with `pnpm sync:clawhub-scan --clawhub <checkout>`.
- `pnpm check-plugin-security` packs and installs the plugin under an isolated temporary home and runs OpenClaw's deep static code-safety audit. It accepts only the reviewed `dangerous-exec` finding (`Shell command execution detected (child_process)`), which maps to the subprocess inventory above. Missing scans, scan errors, and any other finding fail the gate.
- The release workflow also runs `pnpm validate:release-metadata`, `pnpm audit:prod`, `pnpm verify:npm-consumer`, the ClawHub package inspector (`clawhub package validate --runtime`), and an isolated-home install plus `openclaw plugins inspect --runtime` of the exact tarball. `pnpm check-plugin-security` runs in the release workflow, not in PR CI.

OpenClaw no longer blocks dangerous code during plugin installation. Operators who need a host-specific install decision should configure `security.installPolicy` after reviewing the inventory above.

## Review Guidance

When reviewing scanner output or a change touching subprocess or transport code:

- `child_process` findings must map to the inventory above. New executables, shell strings, or `shell: true` need a documented reason.
- Keep fixed commands literal (`execFile("git", [...])`); add new dynamic commands only with an entry here.
- Treat any path that reads environment values or secrets and sends them in outbound messages, subprocess arguments, or network requests as suspicious until reviewed.
- Keep the wake-delivery, direct-notification, auto-update, and goal-verifier tests green.
