# Reference

Canonical operator reference for `openclaw-code-agent`: install, configuration, tool surface, chat commands, routing, notifications, worktree behavior, and troubleshooting.

## Defaults At A Glance

| Setting | Default |
| --- | --- |
| `defaultHarness` | `claude-code` |
| `harnesses.claude-code.defaultModel` | `opus` |
| `harnesses.codex.defaultModel` | `gpt-6-sol` |
| `harnesses.codex.allowedModels` | `["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]` |
| `harnesses.codex.reasoningEffort` | unset; Codex applies its configured/model default |
| `harnesses.codex.fastMode` | `false` |
| `harnesses.codex.permissionProfile` | unset; follows `tools.exec.mode` (`:danger-full-access` when that is unset) |
| `harnesses.codex.approvalPolicy` | unset; follows `tools.exec.mode` (`never` when that is unset) |
| `harnesses.codex.approvalsReviewer` | unset; follows `tools.exec.mode` (`user` when that is unset) |
| `harnesses.opencode.defaultModel` | unset; OpenCode uses its configured provider default |
| `permissionMode` | `plan` |
| `planApproval` | `delegate` |
| `defaultWorktreeStrategy` | `delegate` |
| `maxSessions` | `20` |
| `maxAutoResponds` | `10` |
| `idleTimeoutMinutes` | `15` |
| `sessionGcAgeMinutes` | `1440` |
| `maxPersistedSessions` | `10000` |
| `autoUpdate` | `true` (check and offer; install and restart only after a button press) |
| `worktreeGitHooks` | `run` (repository hooks run during OCA's git operations) |
| `trustedVerifierCommands` | unset (every orchestrator-supplied goal verifier needs one user confirmation) |

Sessions are multi-turn. Active sessions accept follow-up messages via `agent_respond`, and stopped, completed, or suspended sessions that still have a backend conversation can also be continued with `agent_respond`.

## Compatibility And Upgrades

The current `openclaw-code-agent` package requires, is built against, and is validated against OpenClaw `2026.9.6`. Package installation therefore requires `2026.9.6` and Node `>=24.16.0 <25 || >=26.1.0`, and the plugin API, Gateway, and peer dependency metadata keep the verified `2026.9.6` compatibility floor (raised from `2026.8.1` in 5.0). OCA calls the host surfaces listed under [OpenClaw Host Integration](#openclaw-host-integration) directly, without presence checks, so older hosts are not supported. No host config migration is performed by this package; pnpm build policy and overrides stay in `pnpm-workspace.yaml`, and code-agent session storage stays plugin-owned. Release-by-release host notes live in [CHANGELOG.md](../CHANGELOG.md).

### Upgrading from 4.x

- **Back up first.** Stop the Gateway and copy `code-agent-sessions.json` and `code-agent-goal-tasks.json` from the state directory (see [SECURITY.md](SECURITY.md#data-locations)) before installing 5.0. See **Rolling back** below.
- **Session store.** 5.0 loads a 4.7.x `code-agent-sessions.json` in place. Rows that no longer normalize (for example a row without a harness session id, or an action token of a removed kind) are dropped individually after OCA writes a verbatim `.legacy-<timestamp>.json` backup next to the store; the remaining sessions stay loaded. Pre-4 array stores and stores with a different schema version are still archived whole. Retired enum values are dropped rather than remapped (`planApprovalContext: soft-plan` / `codex-first-turn-plan`), and 4.x worktree rows without `worktreeLifecycle` get a lifecycle synthesized from `worktreeMerged`, `worktreeDisposition`, and `worktreeState`.
- **Removed flat model keys.** `defaultModel`, `model`, `reasoningEffort`, and the global `allowedModels` are no longer part of the config schema. The schema keeps `additionalProperties: false`, so OpenClaw refuses to load the plugin while they remain (`invalid config: must not have additional properties: "defaultModel"`). Move them under `harnesses.<name>`:

  ```json
  {
    "harnesses": {
      "codex": {
        "defaultModel": "gpt-6-sol",
        "allowedModels": ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
      },
      "claude-code": {
        "defaultModel": "opus",
        "allowedModels": ["sonnet", "opus"]
      }
    }
  }
  ```

  Place these fields under `plugins.entries.openclaw-code-agent.config`. An empty `allowedModels: []` removes that harness restriction; omission keeps the built-in list, but setting a custom `defaultModel` without an explicit list drops the built-in restriction.
- **Codex sessions.** Rows from the pre-App-Server Codex SDK backend are dropped when the store loads, and 4.x rows whose worktree was a native Codex backend worktree load without worktree metadata. `harnesses.codex.reasoningEffort` no longer defaults to `medium` (unset uses Codex's own default), and Codex execution settings come from `harnesses.codex.permissionProfile` / `approvalPolicy` / `approvalsReviewer`. When they are unset, Codex follows the host `tools.exec.mode` like OpenClaw's bundled Codex plugin; with no `tools.exec.mode` (or `full`) that is the 4.x full-access, no-prompt behavior (see [Harnesses](#harnesses)). OCA's `permissionMode` no longer affects Codex execution: in 4.x `bypassPermissions` always meant `danger-full-access` with no approvals, while in 5.0 a host with `tools.exec.mode` `auto` or `ask` runs Codex in the `:workspace` sandbox even for `bypassPermissions` sessions, and `deny` / `allowlist` refuse Codex launches. Set `harnesses.codex.permissionProfile: ":danger-full-access"` and `approvalPolicy: "never"` to keep the 4.x behavior on such hosts. Codex CLI `0.156.1` or newer is required: older App Servers (or ones whose version cannot be read) fail the launch with an error naming both versions.
- **State paths.** OCA resolves its state directory like the Gateway (`OPENCLAW_STATE_DIR`; `OPENCLAW_HOME` is the home-directory override, so state lives in `$OPENCLAW_HOME/.openclaw`). If you set `OPENCLAW_HOME` to point OCA at a state directory, set `OPENCLAW_STATE_DIR` (or `OPENCLAW_CODE_AGENT_SESSIONS_PATH` / `OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH`) instead. Output transcripts moved from `/tmp/openclaw-agent-<id>.txt`, and auto-update state from `<stateDir>/openclaw-code-agent-auto-update.json`, to `<stateDir>/plugin-state/openclaw-code-agent/` (see [OpenClaw Host Integration](#openclaw-host-integration)).
- **Minimum host.** OpenClaw `2026.9.6` is required for installation, the plugin API, the Gateway, and the peer dependency; upgrade the host first.
- **Tool allowlists.** 5.0 adds the `agent_session_action` tool (Codex compact and review). If an agent's tool allowlist names OCA tools individually, add it.
- **Stricter tools.** `agent_kill` accepts only `session` and `reason`; any other parameter is rejected and nothing is stopped. Session references match an OCA session id, name, or backend conversation id, not a bare `harnessSessionId`, and Codex resume ids must be plain thread UUIDs.
- **Safety defaults.** Goal loops start with the configured `permissionMode` (plan) and wait for the user to confirm orchestrator-supplied verifier commands (pre-approve fixed ones in `trustedVerifierCommands`). With `planApproval: "ask"` only the user approves plans. `.worktreeinclude` and `.openclaw/worktree-setup.sh` must be committed to take effect, and the setup script and verifiers get a minimal environment. Branches that change git hooks or those files need the user's Merge / Open PR button. Coding agents no longer see `GH_TOKEN` and similar unrelated secrets; see [Child process environments](#child-process-environments).
- **Removed knobs.** `OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS` and the startup sweep of unmanaged `openclaw-worktree-*` directories are gone, a launch that needs a worktree outside a git repository fails instead of using the OS temp directory, and OCA no longer copies `~/.claude.json` MCP servers into Claude Code launches.
- **In-process integrations.** `SessionManager.spawn` is `launchSession`, and the worktree, repo-policy, and branch-name helpers return promises. The full list is in the [CHANGELOG](../CHANGELOG.md).
- **Rolling back.** 5.0 rewrites the session index in place, and 4.7.x uses the same store schema version, so a 4.7.x build loads the rewritten file without an error but may drop or misread 5.0-only rows, fields, and buttons. To roll back: stop the Gateway, reinstall 4.7.20 (`openclaw plugins install openclaw-code-agent@4.7.20 --force`), restore the session and goal-task files you backed up, and start the Gateway. Sessions started under 5.0 are then gone from OCA, but their worktrees and branches stay in git. Output transcripts and update state written under `plugin-state/openclaw-code-agent/` are not read by 4.x; the 4.x `/tmp` transcripts and `openclaw-code-agent-auto-update.json` are still where 4.x expects them, unless maintenance aged them out.

### Host Configuration Notes

- If `plugins.allow` is present, add `openclaw-code-agent`; the allowlist is exclusive. Keep the `agent_*` tools in restrictive runtime tool allowlists. OCA does not require or enable the bundled Codex or ACPX plugins.
- OpenClaw migrates host-owned `codex/*` and `openai-codex/*` model references to `openai/*`. That does not change OCA's harness syntax: keep unprefixed Codex model names under `harnesses.codex.*`. An explicit `openai/<model>` launch alias is canonicalized to the bare model before the allowlist check; `codex/*`, `openai-codex/*`, and disallowed models are rejected. Claude Code likewise accepts `anthropic/<id>` and sends the bare id (`anthropic/claude-opus-5-5` → `claude-opus-5-5`). Restored sessions and explicit overrides pass through the same harness-scoped validation. New host catalog models never widen OCA's harness allowlists.
- Host-level agent `cwd`, `agents.defaults.cwd`, and `worktreeRoot` do not replace OCA's per-launch workdir or `worktreeDir`; do not point both worktree managers at the same directory.
- `tools.deny` does not disable OpenClaw's `apply_patch` tool. To restrict patch edits, configure `tools.exec.applyPatch.enabled`, `tools.exec.applyPatch.workspaceOnly`, or `tools.exec.applyPatch.allowModels`.

### Callback And Delivery Contracts

- Telegram topic routes are ordinary code-agent route metadata. Start Plan, plan decisions, questions, completion, merge, and PR callbacks and wakes route through stored delivery context and single-use action tokens; keep fully routable channel strings and topic/thread ids such as `telegram|<chat-id>` with thread `<topic-id>`. Host callback acknowledgement is not proof that the requested state transition or routed follow-up completed.
- Buttons carry `code-agent:<token>` data. OpenClaw's interactive dispatcher hands OCA the part after the namespace as `ctx.callback.payload` (Telegram) or `ctx.interaction.payload` (Discord); that payload is the only callback field OCA reads.
- Text answers to a question work the same way for every harness: an option label (case-insensitive, preferred over a number) or option number selects that option, a multi-select question takes several comma-separated entries, and any other text is a free-text answer unless the question accepts only its options (OpenCode `custom: false`). An empty reply or an option number outside the list is not sent to the agent: `agent_respond` returns an error with the question shown again, and the question stays open.
- A question button for a question the session no longer shows (answered in text, timed out, or cancelled) replies that the question is no longer waiting and does nothing. When the session was suspended or stopped by a Gateway restart, the button resumes it with the selected answer instead. A worktree decision button (Merge, Open PR, Sync PR, Later, Discard) on a decision that was already settled (merged or discarded) replies that it was already resolved and does nothing.
- A Gateway restart keeps a pending plan decision: pressing Approve, Revise, or Reject after the restart resumes the session the same way as after an idle suspension. Stopping the session any other way (`agent_kill`) rejects the plan.
- Plan approval and pending-input question callbacks use apply-then-consume token semantics. If a decision fails before state is applied, the token remains retryable and the buttons stay active; once approval state is applied, a later delivery failure leaves the token treated as terminal so it cannot replay a completed decision. Approve, reject, and request-changes callbacks are serialized per session/version, so sibling clicks re-validate and report stale or already handled.
- Completion wakes deliver the canonical plugin status first and request at most one orchestrator follow-up when `completionWakeSummaryRequired=true`; `NO_REPLY` or an empty response is not delivery proof. PR update completion summaries are deduplicated by material outcome, so later updates with new commits still produce a fresh summary.

## Install

```bash
openclaw plugins install openclaw-code-agent
openclaw plugins enable openclaw-code-agent
openclaw gateway restart
openclaw plugins inspect openclaw-code-agent --runtime --json
```

Since OpenClaw 2026.7.1, plugin installation performs no built-in
dangerous-code blocking. Review [SECURITY.md](SECURITY.md) before installing this
plugin because it launches local coding harnesses and git tooling. Operators
who require a local allow/block decision should configure
`security.installPolicy`. To replace an existing reviewed installation and pin
the resolved version, use:

```bash
openclaw plugins install openclaw-code-agent --force --pin
```

Use `--force` only for a package/source you already trust. When validating a
specific reviewed release, add its version after the package name.

Restart or reload the gateway only as part of normal installation or upgrade. Documentation-only release prep does not require a local gateway restart.

Runtime inspection after the restart should report this plugin's commands, service, and tool contracts without diagnostics. If `tools.effective` or `tools.invoke` cannot see `agent_launch` or `agent_sessions`, update/reinstall the plugin and restart the gateway so the installed manifest and bundle match the release.

## First-Run Onboarding

OpenClaw's generic plugin onboarding should stay narrow for this plugin. The first-run questions should be:

- `defaultWorkdir`
- `defaultHarness`
- `fallbackChannel`

Those three choices are enough to get to a predictable first launch without forcing the operator through multi-workspace routing or policy decisions too early. Because `defaultWorktreeStrategy` now defaults to `delegate`, choose a git repository root for `defaultWorkdir` unless you plan to disable worktrees through Advanced setup or config.

### Harness Readiness Guidance

The host wizard does not currently provide a plugin-specific readiness panel, so harness availability still needs operator judgment:

- `codex`
  - Expect this to work only when the `codex` command, or your `OPENCLAW_CODEX_APP_SERVER_COMMAND` override, is resolvable.
  - Local auth under `~/.codex` also needs to be present.
  - `forced_login_method = "chatgpt"` in `~/.codex/config.toml` is recommended when Codex auth behaves inconsistently, but it is not a hard prerequisite.
- `claude-code`
  - The bundled Claude SDK/CLI is part of the plugin dependency set, so installation is usually the easy part.
  - Authenticated usability may still require Claude-side login/account setup when you launch the first session.
- `opencode`
  - Experimental. Expect this to work only with local `opencode >= 1.16.2` and provider auth already configured for OpenCode.
  - The plugin lazily starts one shared `opencode serve` process on `127.0.0.1` for all OpenCode sessions and uses OpenCode's classic session routes (with `?directory=` per project) for prompt submission, message fetches, and replies. Turn completion comes from the server's event stream.
  - Leave the model unset for OpenCode's configured provider default, or pass an explicit `provider/model` string.

When choosing `defaultHarness`:

- prefer `codex` if the command and auth are already working on this machine
- prefer `claude-code` if Claude Code is the expected path and Codex is not locally ready
- choose `opencode` only for experimental use after `opencode serve` works locally
- if neither harness is ready, finish onboarding with `defaultWorkdir` and optional `fallbackChannel`, then fix harness setup before launching sessions

This setting picks between this plugin's own harnesses. It does not select OpenClaw ACPX, and it does not enable or disable OpenClaw core's bundled `codex` provider/harness plugin. Those are adjacent OpenClaw surfaces with different responsibilities. See [ACP-COMPARISON.md](ACP-COMPARISON.md).

## Minimal Config

Add this under `plugins.entries["openclaw-code-agent"]` in `~/.openclaw/openclaw.json`:

```json
{
  "enabled": true,
  "config": {
    "defaultWorkdir": "/home/user/project",
    "defaultHarness": "claude-code",
    "fallbackChannel": "telegram|my-bot|123456789",
    "harnesses": {
      "claude-code": {
        "defaultModel": "opus",
        "allowedModels": ["sonnet", "opus"]
      },
      "codex": {
        "defaultModel": "gpt-6-sol",
        "allowedModels": ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
        "fastMode": false
      },
      "opencode": {}
    }
  }
}
```

The rest can stay at defaults for the first run:

- `permissionMode: "plan"`
- `planApproval: "delegate"`
- `defaultWorktreeStrategy: "delegate"`

With those defaults, new sessions expect a git repository so they can create an isolated worktree. For non-git directories, set `defaultWorktreeStrategy: "off"` globally or pass `worktree_strategy: "off"` for that launch.

If you use Codex, recommend this in `~/.codex/config.toml`:

```toml
forced_login_method = "chatgpt"
```

## Harnesses

| Harness | Models | Notes |
| --- | --- | --- |
| `claude-code` | Controlled by `harnesses.claude-code.allowedModels` | Native Claude Code harness with native `ExitPlanMode` plan review and `AskUserQuestion` interception |
| `codex` | Controlled by `harnesses.codex.allowedModels` | Native Codex App Server harness with structured pending input, structured plans, approvals, steering, rewind/fork, compaction, and inline review |
| `opencode` | Optional `provider/model`; unset uses OpenCode's configured provider default | Experimental OpenCode server harness with native pending input, OpenCode's built-in `plan`/`build` agents behind the plugin-owned plan gate, and plugin-managed worktrees |

Codex allowlists match the exact model id, ignoring case, after an `openai/` prefix is removed. Claude Code and OpenCode allowlists match any model whose name contains an entry (substring, ignoring case). If the resolved model is not allowed, `agent_launch` fails immediately.

The built-in Codex default (`gpt-6-sol`) and allowlist are static operator policy. OCA does not substitute the `model/list` entry marked `isDefault`: the allowlist check runs before launch, when no Codex connection (and so no catalog) exists yet, and a catalog default that moves with a Codex upgrade would silently change the model new sessions use, possibly to one outside the allowlist. Set `harnesses.codex.defaultModel` to choose another default. Because OpenCode can use its own configured provider default, do not configure `harnesses.opencode.allowedModels` unless you also configure or pass an explicit OpenCode model that can be checked.

Codex harness details:

- Wire types are vendored from `codex app-server generate-ts --experimental` into `src/harness/codex-app-server-protocol/` (regenerate with `pnpm sync:codex-protocol`; currently Codex CLI 0.156.1). Each OCA session owns one `codex app-server` stdio process.
- Minimum Codex CLI: `0.156.1` (`MIN_CODEX_CLI_VERSION` in `src/harness/codex-protocol.ts`). After `initialize`, the harness reads the version from the App Server's `userAgent` (`<originator>/<version> (...)`) and fails the launch, before any thread is started, when the version is older or cannot be read. The error names the reported and the required version.
- The session system prompt, including the worktree preamble, is sent as thread-level `developerInstructions` on `thread/start`, `thread/resume`, and `thread/fork`. Every `turn/start` carries the model, the top-level `effort`, and a `collaborationMode` (`plan` for OCA plan mode, otherwise `default`) whose snake_case settings repeat the model and `reasoning_effort` and leave `developer_instructions: null` so Codex's built-in mode instructions stay active.
- Reasoning effort: `harnesses.codex.reasoningEffort` (or the launch `reasoning_effort`) is sent when set. There is no built-in default; unset means Codex's own configured/model default. When the session's own Codex connection (`model/list`) says a model does not support the requested effort, the harness omits it rather than failing the turn and reports that to the session, so status lines only show efforts that are actually applied (before the first Codex session loads the catalog, only `low`/`medium`/`high` are shown).
- `harnesses.codex.fastMode: true` requests `serviceTier: "priority"` (Codex's fast tier). API-key cost estimates apply the fast multiplier only when Codex reports `priority` as the thread's effective tier.
- Resume sends `excludeTurns: true`; OCA never hydrates full thread history.
- Cost: for API-key accounts the harness prices each `thread/tokenUsage/updated` response (`last` breakdown) against the built-in price table and reports the running total as each response is priced, so the session cost is current mid-turn (for example while an approval is pending). ChatGPT-login sessions stay unpriced.
- Permissions and approvals are configured per operator, identically for every OCA permission mode (OCA permission modes only select Codex's `plan` vs `default` collaboration mode):
  - `harnesses.codex.permissionProfile`: `:danger-full-access` (no sandbox), `:workspace`, or `:read-only`. Sent as the thread `permissions` profile.
  - `harnesses.codex.approvalPolicy`: `never` (no Codex prompts), `on-request` (Codex asks before escalating out of the sandbox), or `untrusted`.
  - `harnesses.codex.approvalsReviewer`: `user` (approval buttons in chat) or `auto_review` (opt-in; Codex's reviewer subagent decides).
  - When these keys are unset, OCA follows the host `tools.exec.mode` at each Codex launch, like OpenClaw's bundled Codex plugin:

    | `tools.exec.mode` | `permissionProfile` | `approvalPolicy` | `approvalsReviewer` |
    | --- | --- | --- | --- |
    | unset or `full` | `:danger-full-access` | `never` | `user` |
    | `auto` | `:workspace` | `on-request` | `auto_review` |
    | `ask` | `:workspace` | `on-request` | `user` |
    | `deny` or `allowlist` | Codex launch is refused, unless `permissionProfile` is set explicitly | | |

  - Explicit `harnesses.codex.*` values always win, field by field. This differs from the bundled Codex plugin, where `tools.exec.mode: "auto"` overrides configured values.
  - Under `:workspace`, Codex may write only inside the workspace and has no network access. A command that needs more (network, for example `git push`, package installs, or API calls; or writes outside the workspace) is an escalation: with `on-request` Codex asks, and `auto_review` has Codex's reviewer subagent approve or deny it based on the task and its risk, usually within seconds and without a chat prompt. Denied requests fail back to the model. In an OCA worktree, `git add` and `git commit` also escalate, because they write to the main checkout's `.git` directory outside the worktree; in live testing the reviewer approved each in 3–5 s. Set `approvalsReviewer: "user"` to get approval buttons in chat instead, or `[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml` to allow network inside the sandbox.
  - To pin the full-access, no-prompt posture regardless of `tools.exec.mode`, set `permissionProfile: ":danger-full-access"` and `approvalPolicy: "never"`. To opt into auto-review without changing the host exec mode, set `permissionProfile: ":workspace"`, `approvalPolicy: "on-request"`, and `approvalsReviewer: "auto_review"`.
  - Command, file-change, and permission approval requests appear as pending-input approvals with buttons (for example `Approve once`, `Approve for session`, `Always allow \`<prefix>\``, `Decline`, `Decline and stop turn`). Plain-text replies such as `yes`, `approve for session`, `no`, or `cancel` also work; any other text declines the request and is steered into the turn as feedback.
- Server requests OCA cannot serve are answered explicitly: MCP elicitations are declined, dynamic tool calls return `success: false`, and ChatGPT token refresh / unknown requests get a JSON-RPC method-not-found error.
- Follow-ups sent with `agent_respond` while a Codex turn is running are steered into that turn (`turn/steer` with `expectedTurnId`). With `interrupt: true` the turn is interrupted instead and the message starts a new turn. If Codex rejects the steer (the turn just ended), the message is queued as the next turn.
- `agent_launch(resume_session_id=..., rewind_turns=N)` drops the latest N turns: with `fork_session: true` the fork is created before those turns (`thread/fork` with `beforeTurnId`); without it the thread's history is reverted in place (`thread/revert`). Files changed by those turns are not reverted.
- `agent_session_action` runs `compact` (`thread/compact/start`) or an inline `review` (`review/start`) on a running Codex session.
- Rate limits: ChatGPT-login sessions read `account/rateLimits/read` at startup and track `account/rateLimits/updated`. Snapshots are kept per account (never merged across accounts; account ids are not displayed; a connection whose account id is unknown keeps its own snapshot only while it is open); `agent_stats` shows each account's current windows, and usage-limit turn failures include the reset time unless it already passed.
- Permission approval prompts list every requested filesystem entry (path or glob and access mode) and network access before a grant is offered. Plain free-text replies (`yes`, `no`, `always`) never select an "Always allow/deny" policy amendment; use its button or option number.
- Goals: OCA keeps its own cross-harness goal loop (`agent_goal_*`, verifier-driven) and does not map it onto Codex's native `thread/goal/*`, which is Codex-only and judges completion by the model rather than by verifier commands.

Claude Code harness details:

- Plan mode uses Claude Code's native plan protocol. When Claude calls `ExitPlanMode`, OCA holds the permission request open (Claude Code applies no deadline to permission prompts) and raises the plan for review using the tool's `plan` text and `planFilePath`. Approval answers the request with `allow` plus a session-scoped `setMode` update (normally `bypassPermissions`). Revision feedback answers it with `deny` and the user's feedback, so Claude revises and resubmits in the same turn. Any other mutating tool that Claude Code routes to OCA while in plan mode is denied.
- If a plan waits long enough for the session to be idle-suspended, the pending request ends with the process. A later approval resumes the Claude Code session in `bypassPermissions` with a plain approval message; a revision resumes it in plan mode.
- OCA passes its review workflow as the SDK `planModeInstructions` option instead of framing approvals and revisions as `[SYSTEM: …]` prompt text.
- Worktree sessions set the SDK `projectConfigRoot` to the original checkout, so project settings, hooks, `.mcp.json`, and `.claude/` configuration come from the trusted checkout rather than from the branch under edit.
- MCP servers come from Claude Code's own settings sources; OCA does not re-inject `~/.claude.json` servers.
- Completed Claude Code sessions can be resumed with `agent_respond` or `agent_launch(resume_session_id=...)`. OCA first checks that the transcript still exists (`getSessionInfo()`) and fails with a clear message if it does not. Forks use the SDK `resume` + `forkSession` options, which report the new session id at startup.
- Turn outcomes come from structured SDK fields: `is_error`, the assistant `error` code (for example `authentication_failed`), `startup_failure_reason`, and `terminal_reason` (aborted turns become interrupted turns). Results are deferred while `queued_turn_count` says more queued user turns follow, and empty background-task notification results (`origin.kind: "task-notification"`, zero turns) are skipped.
- `AskUserQuestion` can be answered through `agent_respond` as well as with buttons: reply with an option number, an option label, several comma-separated numbers or labels for multi-select questions, or free text. Multi-question requests are answered one question at a time. Like Codex and OpenCode questions, a Claude question has no deadline of its own and is posted to the user once: it waits until it is answered or the session is idle-suspended (`idleTimeoutMinutes`), after which an answer (button or text) resumes the session.
- A turn that ends while SDK background tasks (for example background shells) are still running keeps the session running until the tasks finish; the follow-up turn Claude Code starts to report them ends the session normally.
- If `ExitPlanMode` carries neither `plan` nor `planFilePath`, the pending plan is read from the last file this session wrote to a Claude plans directory (never another session's plan), so `agent_output` and the approval prompt still show it.
- A forked session reports only its own cost: the parent's usage at fork time is subtracted from the SDK totals. When the parent is no longer live, only its total cost is known, so the fork's per-model breakdown is omitted rather than showing the parent's tokens.
- Cost is the sum of the SDK's per-model `modelUsage` entries. `agent_output` shows the per-model cost and tokens, the context window fill from `getContextUsage()`, and the number of live background tasks. The SDK reports cost only in each turn's `result`, so the session cost updates when a turn completes, not while it waits on a question (the only mid-turn cost read, `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, is marked unstable and is not used). OCA enables session-state events and records permission denials as diagnostics.
- File rewind (`rewindFiles`) is not used: it needs SDK file checkpointing, the checkpoints live only in the Claude Code process, and OCA already isolates edits in git worktrees that can be reset or discarded with git.

OpenCode harness details:

- Experimental support targets `opencode >= 1.16.2`. The shared-server design needs the `?directory=` request parameter, the `/global/event` stream with its `{ directory, payload }` envelope, and the classic session, `prompt_async`, permission-reply, and question-reply routes; 1.16.2 serves the same operations as the 1.18.32 document vendored in `tests/protocol/`, and its schema differences are in fields OCA does not read. Protocol shapes are validated against 1.18.32.
- The plugin lazily starts one shared `opencode serve --port 0` process on localhost and reads the bound URL from its `opencode server listening on …` output. Every request names its project with `?directory=`, so sessions in different worktrees run concurrently on the same server. The server shuts down about 30 seconds after the last OpenCode session ends. Requests do not use HTTP keep-alive: a restarted server usually binds the same port, and a pooled connection to the previous process would fail the first request. A read whose connection is reset is repeated once.
- One `/global/event` stream is demultiplexed by session id. A turn completes on `session.idle` (or an idle `session.status`) once the turn has shown activity; an idle event without activity is confirmed against session status and messages. Session status is polled only while the event stream is disconnected, to catch up on missed events.
- If the server process dies, every in-flight turn fails with the exit reason, and the next turn starts a fresh server. OpenCode persists sessions, so they continue.
- Fresh launches create sessions through OpenCode's classic session-create route. Prompts use classic `prompt_async`; message, permission reply, and question reply flows use the classic routes. Responses that are not JSON (for example the web UI's HTML shell) are rejected with a diagnostic.
- The session system prompt (including the worktree preamble) is sent with every prompt, because OpenCode applies only the latest user message's `system`.
- A turn fails after 15 minutes without any event from OpenCode; the limit restarts on every event and is paused while a question or permission request waits for the user. When it fires, and when the OCA session is interrupted, closed, or aborted, OCA sends `/abort` so the shared server stops working (and spending) on the turn. A question or permission request belongs to its turn: when the turn ends unanswered, it is cleared, and the next message starts a new turn instead of being taken as the answer.
- Plan mode prompts OpenCode's built-in `plan` agent, which denies edits except its own plan files. OCA adds a session overlay that also denies `bash` and access outside the project, because the plan agent otherwise relies on instructions to keep shell commands read-only. After approval, prompts use the `build` agent; OpenCode then adds its own build-switch reminder. The plugin still owns the plan approval gate. (OpenCode's own `plan_exit` tool is only available in the OpenCode CLI.)
- Multi-question requests are answered with one answer list per question. Text replies send the selected option labels (an option number selects that option), and multi-select questions accept several comma-separated labels or option numbers.
- Permission requests (`permission.asked`) show Allow once / Always allow / Reject buttons. Text replies also work: `yes` or `allow` (once), `always` (always), `no` or `reject`, or the option number; any other text rejects the request and passes the text to the agent as the rejection message.
- The session's reasoning effort is sent as the prompt's `variant`. OpenCode ignores variant names that the model does not define.
- Turn duration, per-model tokens, and cost come from OpenCode's assistant message records; the session record's cost is used when available. The running cost is refreshed after each finished step and when a question or permission request opens, so `agent_output` shows the spend so far mid-turn. OpenCode prices a step only when it finishes: a step that is blocked on a question (for example the first step of a turn that opens with a question) adds its cost after the answer.
- `OPENCLAW_OPENCODE_COMMAND` can override the `opencode` executable. If `OPENCODE_SERVER_PASSWORD` is set, the plugin sends Basic Auth using `OPENCODE_SERVER_USERNAME` or `opencode` as the default username.
- Native OpenCode worktrees are out of scope for this integration. Worktree strategies use the plugin-managed worktree path.
- OpenCode does not emit structured OpenClaw plan artifacts in this version, so `nativePlanArtifacts` is false.

Important boundary:

- this plugin's `codex` harness is part of `openclaw-code-agent`
- it is not the same thing as OpenClaw ACPX
- it is not the same thing as OpenClaw core's bundled `codex` plugin, even though both can use the same local Codex App Server substrate
- this plugin's experimental `opencode` harness is also plugin-local; it is not OpenClaw ACPX's broader external-harness path

## Security Model

This plugin is expected to use local subprocesses. That is part of the product design, not an accidental implementation detail.

Accepted subprocess surfaces:

- local `openclaw` CLI calls for `chat.send` wakes and for the button-confirmed self-update (`plugins inspect` / `search` / `install`, `gateway restart`); notifications and system events stay in-process
- Codex App Server launch over stdio
- one shared OpenCode server on `127.0.0.1` for experimental OpenCode sessions
- local `git` / `gh` commands for worktree and PR flows
- a repository's committed, executable `.openclaw/worktree-setup.sh` in new OCA worktrees
- goal verifier shell commands the user confirmed (or typed, or the operator pre-approved in `trustedVerifierCommands`)

Self-update: with `autoUpdate: true` (default) OCA checks about once a day for a newer release and offers it with buttons. It reinstalls itself only after a user presses **Update now**, and restarts the Gateway only after a separate **Restart Gateway** press. `autoUpdate: false` disables update checks, installs, and restarts.

Operator guidance:

- goal verifier commands run only after the user confirms them (the confirmation message lists the exact commands), unless the user typed them in `/agent_goal` or they are listed in `trustedVerifierCommands`
- verifier commands and the worktree setup script get a minimal environment without API keys or tokens (see [Child process environments](#child-process-environments))
- expect plugin-security scanners to flag `child_process` usage for this plugin
- use [SECURITY.md](SECURITY.md) when reviewing whether a finding is expected or a real regression

## Config Tiers

### Onboarding Fields

These belong in the first-run setup flow:

- `defaultWorkdir`
- `defaultHarness`
- `fallbackChannel`

`defaultWorkdir` should normally be a git repository root because delegated worktree isolation is the default first-run behavior.

### Advanced / Manual Fields

These should remain manual or follow-up configuration:

- `agentChannels`
- `harnesses.*`
- `permissionMode`
- `planApproval`
- `defaultWorktreeStrategy`
- `worktreeDir`
- `autoUpdate`
- `worktreeGitHooks` and `trustedVerifierCommands`
- session/concurrency/retention limits such as `maxSessions`, `idleTimeoutMinutes`, `sessionGcAgeMinutes`, `maxPersistedSessions`, and `maxAutoResponds`

### Removed Fields

`defaultModel`, `model`, `reasoningEffort`, and the global `allowedModels` were removed in 5.0.0. The config schema rejects them; see [Upgrading from 4.x](#upgrading-from-4x).

## Permission And Approval Modes

### `permissionMode`

| Mode | Meaning |
| --- | --- |
| `default` | Plugin-managed interactive execution. The session can ask questions or pause between turns. Codex-side approvals follow `harnesses.codex.approvalPolicy` and `approvalsReviewer`, or the host `tools.exec.mode` when those are unset (none by default) |
| `plan` | Present the plan first, then block implementation until approval |
| `bypassPermissions` | Fully autonomous execution with no plan checkpoint |

`plan` is the plugin default. Claude Code, Codex, and experimental OpenCode feed the same plugin-owned approval workflow. Claude Code supplies its plan through the native `ExitPlanMode` request and receives the decision as that request's answer; Codex supplies structured plan artifacts through the App Server backend; OpenCode plans are text from its built-in `plan` agent.

For Codex, `permissionMode` selects Codex's `plan` or `default` collaboration mode. Codex's plan collaboration mode only instructs the model: the thread sandbox stays what `harnesses.codex.permissionProfile` (or the host `tools.exec.mode`) selects, which is `:danger-full-access` by default, so a plan turn can technically write files and run commands before approval (see [SECURITY.md](SECURITY.md#codex-sandbox)). Set `permissionProfile` to `:workspace` or `:read-only` when that matters. Approval prompts come from `approvalPolicy` and `approvalsReviewer` in both phases. Use `permissionMode` and `planApproval` to control plan review gates.

### `planApproval`

| Mode | Meaning |
| --- | --- |
| `ask` | Notify the user directly with a bounded decision-grade plan brief and wait for explicit approval or revision. Only the user approves: the Approve button, or the user's own reply forwarded with `agent_respond(..., userInitiated=true)`. `agent_respond(approve=true)` without `userInitiated` is refused |
| `delegate` | Default. Wake the orchestrator, require a full-plan review, then let it either approve directly or escalate back to the user with the same approval buttons |
| `approve` | Wake the orchestrator, which may approve without asking the user only after reading and verifying the full plan; destructive, credential-touching, or out-of-scope plans still go to the user with `agent_request_plan_approval` |

In `ask`, the plugin sends action buttons for `Approve`, `Revise`, and `Reject` when interactive callbacks are available. The user-facing message is a bounded decision brief with objective/scope, implementation approach, affected files or systems, verification, destructive or external effects, material risks, and unknowns or decisions. Only routine implementation detail is counted and compacted. Scope, affected systems, verification, destructive/external actions, costs, risks, choices, and rollback remain explicit and paginate when necessary. The detail notice provides `/agent_output <session-name> --full` for available full output (or a request for the complete plan when a command-safe name is unavailable). Inspect details before approval; requesting a revision remains available. Empty sections are absent, each section label shares a line with its first item, and Markdown tables become labeled fields on both Telegram and Discord. Pagination keeps a heading with its first body item; supporting pages have no decision controls. Telegram and Discord both use OpenClaw's shared direct-message presentation contract for the outbound button UI. Each session keeps one canonical actionable approval prompt per plan review version; later reminders for that same version are non-canonical reminders, not a fresh approval cycle. For a multi-message brief, delivery is successful only after the final action-bearing message is confirmed; an earlier informational chunk cannot prove canonical delivery. When a newer review state supersedes an older one, the plugin invalidates older plan-decision tokens and clears old controls where the transport supports edits; an already-visible old callback can still be acknowledged as stale. If buttons are unavailable, hidden by the client, or fail to deliver, the same flow still works through plain replies: `Approve` approves and resumes implementation, `Revise` records changes requested for the current review version, and `Reject` kills the pending plan session instead of forwarding the word as normal task input. In `delegate`, the orchestrator must read the full plan with `agent_output(..., full=true)` before approving anything.

Direct interactive notifications for Telegram and Discord share OpenClaw's durable outbound `presentation` contract (`sendDurableMessageBatch`). Callback handling and route repair still remain provider-specific.

Revision and approval rules are version-scoped:

- `Revise` closes the current plan decision, invalidates its decision tokens, and supersedes only the prior review version for that same session
- the revised plan becomes the latest actionable review version
- `agent_respond(..., approve=true)` resolves against that latest actionable version, even if older versions previously had `changes_requested`
- `Reject` closes the current plan decision, invalidates its decision tokens, and prevents old Plan v2 prompts for that killed/rejected session from being treated as actionable
- approval-prompt delivery state is tracked separately from backend approval state, so a missing button delivery should be treated as a delivery problem, not as proof that the plan is no longer awaiting approval

Terminal completion wakes and no-change worktree completion wakes now include deterministic approval context for plan-gated sessions:

- `requestedPermissionMode`: the original launch-time mode
- `currentPermissionMode`: the effective mode at completion time
- `approvalExecutionState`: one of `awaiting_approval`, `approved_then_implemented`, `implemented_without_required_approval`, or `not_plan_gated`

Treat those fields as authoritative in orchestration logic:

- `approved_then_implemented` is normal approved execution and should not be narrated as an approval bypass
- `implemented_without_required_approval` is the explicit approval-bypass case
- successful completion wakes already correspond to a canonical plugin-sent completion notification, and the orchestrator should usually follow that with a short factual outcome summary
- that expectation applies to ordinary terminal/manual completions and no-change completion wakes too, not just delegated worktree flows
- a final summary that exists only inside `agent_output(session, full=true)` is source material, not visible delivery; when the plugin has posted only its terse status line, the orchestrator must still send one short routed summary
- send at most one orchestrator-owned human summary for a terminal/worktree outcome; if a duplicate wake can confirm that prior orchestrator follow-up was already visibly delivered, skip the duplicate
- otherwise skip the summary only when the orchestrator is silently continuing an internal pipeline, there is no meaningful confirmed outcome to report yet, result data is incomplete or unreliable, or an explicit NO_REPLY/silent cron/system opt-out applies

## Worktree Strategies

Worktree strategies now control isolation and the requested follow-through mode. The repository integration policy is the authority for whether direct merge or PR automation is allowed.

On first worktree use in a git repo with no stored policy, `agent_launch` blocks and asks the operator to set one policy with `agent_repo_policy` or `/agent_policy`. Inline policy buttons continue the deferred launch automatically. If buttons are unavailable, `agent_repo_policy(workdir="...", policy="...")` or `/agent_policy <policy>` also continues automatically when exactly one matching pending launch is waiting.

| Repo policy | Meaning |
| --- | --- |
| `pr-required` | Direct merge is blocked; automatic merge requests are downgraded to PR when GitHub PR automation is available |
| `pr-allowed` | Merge or PR follow-through may be used according to the requested worktree strategy |
| `never-pr` | PR creation/update is hidden and blocked; use merge or manual handling |
| `manual` | Automatic merge/PR follow-through is disabled; every changed worktree requires explicit follow-up |

Worktrees are created under `OPENCLAW_WORKTREE_DIR`, else `worktreeDir`, else `<repoRoot>/.worktrees`. Outside a git repository there is no base directory: a launch that needs a worktree fails with a clear error instead of creating one in the OS temp directory. Use `worktree_strategy: "off"` for non-git directories.

GitHub is the only PR provider supported in this release. OCA calls `gh` only when a remote points at a GitHub host `gh` can serve: github.com, `GH_HOST`, or a host listed in `gh`'s `hosts.yml` (GitHub Enterprise). Non-GitHub repos keep worktree isolation, but PR buttons/actions are disabled by policy resolution. The `goldmar/openclaw-code-agent` repository is treated as `pr-required`.

| Strategy | Where It Is Set | Behavior |
| --- | --- | --- |
| `off` | Tool param or config | No worktree; session runs in the main checkout |
| `manual` | Tool param or config | Create worktree and branch, then stop for manual follow-through; the worktree is kept after the session ends (lifecycle `provisioned`, shown as `active`) |
| `ask` | Tool param or config | Keep the branch local, notify the user, and send inline 4-button decision UI |
| `delegate` | Tool param or config | Keep the branch local and wake the orchestrator with diff context; no user decision buttons are sent automatically |
| `auto-merge` | Tool param or config | Merge back automatically; spawn a conflict resolver if needed |
| `auto-pr` | Tool param or config | Create or update the PR automatically; on failure, fall back to an explicit pending worktree decision |

### Worktree Decision Buttons

When a session completes with changes under `ask` or `delegate`, users receive explicit decision buttons:

| Button | Action |
| --- | --- |
| **Merge** | Merge branch into base locally |
| **Open PR** | Create a GitHub PR when none exists |
| **View PR / Sync PR** | Shown instead of `Open PR` once a PR already exists |
| **Later** | Snooze reminders for 24h |
| **Discard** | Permanently delete branch and worktree (irreversible) |

Each button acts once: its token is used before the action runs, so a second click (or a click in another runtime) never repeats it. When Merge, Open PR / Sync PR, or Discard fails (for example on a rebase conflict), OCA sends the still-open decision again with fresh buttons and, once that message is delivered, clears the used controls and retires the older buttons, so the user can fix the cause and retry. If the new message cannot be delivered, the original buttons stay usable. A merge that started a conflict-resolver session is in progress and is not re-offered.

### Worktree Lifecycle

| Lifecycle state | Meaning | Cleanup semantics |
| --- | --- | --- |
| `provisioned` / active | Sandbox exists and is still in play | Never auto-clean |
| `pending_decision` | Waiting for merge / PR / dismiss follow-through | Preserved and reminded |
| `pr_open` | PR exists and sandbox is being preserved | Preserved while PR is open |
| `merged` | Branch landed by normal git ancestry | Safe cleanup candidate |
| `released` | Content already exists on the base branch even though branch SHAs differ | Safe cleanup candidate |
| `dismissed` | User intentionally discarded the sandbox | Safe cleanup candidate |
| `no_change` | Session finished without a committed delta | Safe cleanup candidate |
| `cleanup_failed` | Cleanup tried but could not finish cleanly | Retained for review |

Notes:

- `agent_launch` accepts `off`, `manual`, `ask`, `delegate`, `auto-merge`, and `auto-pr` as `worktree_strategy`.
- `delegate` can also be configured at the plugin level with `defaultWorktreeStrategy`.
- Explicit per-launch `worktree_strategy` wins over the plugin default, but repo policy can downgrade unsafe or impossible follow-through.
- Resumed sessions keep the worktree strategy they already had.
- Worktrees are kept alive until explicitly resolved (merge/PR/dismiss) when using non-trivial strategies.
- Stale-decision reminders fire every 3h; users can snooze per-session for 24h.
- Claude Code, Codex, and experimental OpenCode all use plugin-managed worktrees for isolated edits. Codex App Server has no worktree API; OCA passes the prepared worktree as the thread `cwd`. Sessions persisted by 4.x with a native Codex backend worktree load without worktree metadata so OCA never removes Codex-owned checkouts. If a resumed session's worktree directory is gone, OCA recreates it from the stored `agent/*` branch; if that fails, the launch fails closed for every harness unless `worktree_strategy: "off"` is chosen.
- `released` covers different-SHA cases where the base branch already contains the branch content after rebase, cherry-pick, or squash.
- `agent_worktree_cleanup(mode="preview_safe")` previews what Clean all safe would remove, `mode="clean_safe"` performs it, and `mode="preview_all"` shows both safe sandboxes and retained reasons.

### Worktree Provisioning

New OCA worktrees follow the same repository conventions as OpenClaw managed worktrees:

1. **`.worktreeinclude`** at the source checkout root lists gitignored files to copy into the new worktree (for example `.env` or local config). It uses gitignore syntax (comments, `!` negation, `**`, trailing `/`) and is evaluated by git itself: a file is copied only when it matches `.worktreeinclude` and is ignored by the repository's standard excludes, so tracked files are never copied. Symlinked files, paths through symlinked directories, and files that already exist in the worktree are skipped; file modes are preserved. A `.worktreeinclude` that is not a regular file fails the launch.
2. **`.openclaw/worktree-setup.sh`**, when the committed version is executable (git mode `100755`), then runs inside the new worktree. It is executed directly (give it a shebang) from a private temporary copy, with the new worktree as its working directory, a minimal environment (see [Child process environments](#child-process-environments)) plus `OPENCLAW_SOURCE_TREE_PATH` and `OPENCLAW_WORKTREE_PATH`, no stdin, and a 120 s timeout after which its whole process group is terminated. Use those variables or the working directory, not `$0`, to find files.

Both inputs are read from the commit the source checkout has checked out (`HEAD`), never from the working tree: an untracked, modified, or agent-written copy of `.worktreeinclude` or `worktree-setup.sh` is ignored, and so is the agent branch's version when a worktree is recreated for a resume. Commit changes to either file before they take effect.

OCA always runs the setup script for its worktrees, unlike OpenClaw core, which runs it for managed worktrees only when the caller has admin scope. Core's rule protects the `worktrees.create` Gateway method, which lower-privileged clients can reach. An OCA worktree exists only for a coding session launched in an operator-chosen repository, so running the repository's own setup script is part of trusting that repository. The script runs unsandboxed with the Gateway's privileges, which can be more than a Codex session gets inside a `:workspace` sandbox. Do not point OCA at repositories whose setup scripts you do not trust.

If either step fails, the launch fails with the reason (for the setup script, the exit code or timeout plus the tail of its output), the new worktree is removed, and the new `agent/*` branch is deleted; a resumed session's existing branch is kept. Git hooks are disabled for the provisioning git calls. OCA keeps its `agent/*` branch prefix so its branches never collide with core's `openclaw/*` managed worktrees.

### Git Hooks

`worktreeGitHooks` controls repository hooks during OCA's own git operations: the merge (rebase, fast-forward or squash commit), pushes, and `git worktree add`. `run` (default) lets them run as git normally would; `skip` runs those commands with `core.hooksPath=/dev/null`.

Whatever the setting, a merge or PR whose branch changes hook or worktree-provisioning locations is never automatic: `.husky/`, `.githooks/`, the repository's in-repo `core.hooksPath` directory, `.openclaw/worktree-setup.sh`, and `.worktreeinclude`. Those files run code on the next git operation or worktree creation. For such a branch `auto-merge` and `auto-pr` post the Merge / Open PR / Later / Discard prompt instead, the prompt names the changed files, and `agent_merge` / `agent_pr` called by the orchestrator are refused (they post the same prompt). The user's Merge or Open PR button proceeds.

### Child Process Environments

| Child | Environment |
| --- | --- |
| `.openclaw/worktree-setup.sh`, goal verifier commands | Minimal allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TMPDIR`/`TMP`/`TEMP`, `TERM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `CI`, the `XDG_*` base directories, CA bundle variables (`SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`), proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and lowercase forms), and the Windows process basics. No API keys or tokens. The setup script also gets `OPENCLAW_SOURCE_TREE_PATH` and `OPENCLAW_WORKTREE_PATH` |
| Codex app server, Claude Agent SDK, OpenCode server | The Gateway environment (provider credentials, cloud-provider variables for Bedrock or Vertex, and whatever MCP servers need) minus secrets unrelated to a coding agent: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITHUB_PAT`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `CLAWHUB_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`, `OP_CONNECT_TOKEN`, `OP_SESSION_*`, `HCLOUD_TOKEN`, `DIGITALOCEAN_TOKEN`, `CLOUDFLARE_API_TOKEN`, chat bot tokens (`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_USER_TOKEN`, `SLACK_SIGNING_SECRET`), and every `OPENCLAW_*TOKEN`, `OPENCLAW_*PASSWORD`, and `OPENCLAW_*SECRET` variable. An agent that needs the GitHub CLI uses `gh`'s own stored login |
| `git`, `gh` | The full Gateway environment: pushing and opening pull requests need `SSH_AUTH_SOCK`, `GH_TOKEN`, and git credential helpers |

## Tool Reference

### `agent_launch`

Launch a background coding session.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `prompt` | `string` | Yes | Task to execute |
| `name` | `string` | No | Short session name; auto-generated if omitted |
| `workdir` | `string` | No | Defaults to an existing absolute path in a leading `Workdir:` or `Repo:` prompt header line, then the tool workspace, plugin `defaultWorkdir`, or cwd |
| `reasoning_effort` | `low \| medium \| high \| xhigh \| max` | No | Per-launch override. Otherwise retains saved resume/fork effort, then uses the harness default. Known supported settings appear as `reasoning: <level>` in session status headings; unknown/unsupported settings are omitted. |
| `model` | `string` | No | Defaults to the selected harness default model. For experimental OpenCode, omit to use OpenCode's configured provider default or pass `provider/model` explicitly |
| `system_prompt` | `string` | No | Extra system prompt |
| `allowed_tools` | `string[]` | No | Harness tool allowlist |
| `resume_session_id` | `string` | No | Resume by plugin session ID or name. Persisted backend conversation IDs still work for recovery/diagnostics, but they are not the normal operator-facing path |
| `fork_session` | `boolean` | No | Fork instead of continuing when resuming |
| `rewind_turns` | positive integer | No | Codex only, with `resume_session_id`: drop the latest N turns first. With `fork_session: true` the fork starts before those turns; otherwise the thread's history is reverted in place. Conversation history only; files are not reverted |
| `force_new_session` | `boolean` | No | Start a new session even when a resumable or active session is already linked to this thread (skips resume-first protection) |
| `permission_mode` | `default \| plan \| bypassPermissions` | No | Defaults to plugin `permissionMode` |
| `plan_approval` | `ask \| delegate \| approve` | No | Per-session override of the plugin `planApproval` |
| `harness` | `string` | No | Defaults to `defaultHarness` |
| `worktree_strategy` | `off \| manual \| ask \| delegate \| auto-merge \| auto-pr` | No | Explicit per-launch value wins over plugin default; `auto-pr` attempts PR creation/update automatically |
| `worktree_base_branch` | `string` | No | Literal Git branch name; options and revision expressions rejected. Defaults to detected base branch |
| `worktree_pr_target_repo` | `string` | No | Cross-repo PR target (e.g. `openai/codex`); auto-detected from `upstream` remote if unset |

Example:

```text
agent_launch(
  prompt: "Fix the auth middleware bug and add tests",
  name: "fix-auth",
  workdir: "/home/user/my-app"
)
```

### `agent_respond`

Send a follow-up, steer or redirect work, answer a pending question, approve a plan, or escalate a `default` mode session to `bypassPermissions`. A session that is not running is resumed first when it still has a backend conversation.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Prefer the plugin session ID or name. Persisted backend conversation IDs are accepted only for recovery/diagnostics |
| `message` | `string` | Yes | Follow-up text |
| `interrupt` | `boolean` | No | Abort the current turn before sending. Without it, Codex sessions steer the message into a running turn (other harnesses queue it for the next turn) |
| `userInitiated` | `boolean` | No | Reset the auto-respond counter |
| `approve` | `boolean` | No | Approve a pending plan or escalate `default` mode permissions. With `planApproval: "ask"` a plan approval needs `userInitiated=true` (the user's own words); otherwise it is refused |
| `approval_rationale` | `string` | No | Structured rationale for a direct delegated plan approval (use with `approve=true` instead of putting it in `message`) |

Example:

```text
agent_respond(
  session: "fix-auth",
  message: "Approved. Go ahead.",
  approve: true
)
```

### `agent_session_action`

Run a backend thread action on a running session. Supported by Codex only; other harnesses and sessions that are not running return an error. Actions queue behind a running turn and report through the normal turn output (`agent_output`).

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Running session name or ID |
| `action` | `compact \| review` | Yes | `compact` summarizes the conversation to free context (`thread/compact/start`). `review` runs Codex's built-in reviewer inline (`review/start`) |
| `review_target` | `uncommitted \| base_branch \| commit \| custom` | No | Defaults to `base_branch` (the session's worktree base) for worktree sessions, otherwise `uncommitted` |
| `base_branch` | `string` | No | Branch to diff against for `base_branch` |
| `commit_sha` | `string` | No | Commit for `commit` |
| `instructions` | `string` | No | Reviewer instructions for `custom` |

A pre-PR review is an explicit orchestrator step: call `agent_session_action(session, action: "review")` before `agent_pr` when a review pass is wanted. OCA does not insert reviews automatically into worktree PR flows.

### `agent_request_plan_approval`

Escalate a `delegate` or `approve` mode plan review to the user with the normal Approve / Revise / Reject buttons. In `ask` mode the user already has the prompt, so the call is refused.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Session waiting on a `delegate` or `approve` mode plan review |
| `summary` | `string` | Yes | Concise scope/risk summary shown with the approval prompt |

### `agent_request_worktree_decision`

Escalate a delegated worktree decision to the user with the state-aware worktree decision buttons (for example Merge, Open PR, Later, Discard).

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Delegated session awaiting a worktree decision |
| `summary` | `string` | Yes | Concise user-facing summary of scope, risk, and why a human choice is needed |

### `agent_send_plan_offer`

Send a user-facing message with `Start Plan` / `Dismiss` inline buttons. `Start Plan` launches a plan-gated code-agent session from the supplied prompt while preserving the chosen route, Telegram/Discord thread, and optional worktree strategy.

Use this as the primary generic primitive for external/local automation that wants to offer a human-gated follow-up plan from a notification.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `offer_id` | `string` | Yes | Stable identifier for the button action tokens |
| `offer_text` | `string` | Yes | User-facing message body |
| `plan_prompt` | `string` | Yes | Prompt for the plan-only follow-up session |
| `plan_workdir` | `string` | Yes | Working directory for the follow-up session |
| `plan_worktree_strategy` | `off \| manual \| ask \| delegate \| auto-merge \| auto-pr` | No | Preserved on the launched plan session |
| `plan_name` | `string` | No | Optional session name; defaults to `offer_id` |
| `target_channel` | `string` | No | Explicit route, for example `telegram|<chat-id>` |
| `target_thread_id` | `string \| number` | No | Optional topic/thread id |
| `target_session_key` | `string` | No | Optional explicit wake-routing key |

### `agent_output`

Read buffered output without changing session state. Where the harness reports them, the output also shows the running cost, the per-model cost, Claude Code context fill and live background tasks, and a pending Claude Code plan.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Name or internal ID |
| `lines` | `number` | No | Defaults to `50` |
| `full` | `boolean` | No | Show the full buffered stream |

### `agent_sessions`

List active and recent sessions.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `all \| running \| completed \| failed \| killed` | No | Filter by runtime state |
| `full` | `boolean` | No | Show the broader recent view instead of the short default |

`agent_sessions` merges active runtime sessions and persisted sessions into one view.

### `agent_kill`

Terminate a running session or mark it complete.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Name or internal ID |
| `reason` | `killed \| completed` | No | Omit to stop; use `completed` to mark success |

Any other parameter is rejected with `Invalid parameters` and nothing is stopped.

### `agent_stats`

Show session counts (from the persisted store), estimated cost, average duration, and the most expensive session. When Codex ChatGPT-login sessions have observed account rate limits, each account's latest primary/secondary usage windows and reset times are appended (labelled `account N` when there are several; account ids are never shown).

This tool takes no parameters.

### Goal Tools

Explicit goal tools use the same `agent_goal_*` public namespace as the chat commands. The previous unprefixed `goal_*` public tool names are not registered as aliases.

| Tool | Purpose |
| --- | --- |
| `agent_goal_launch` | Start an explicit verifier or Ralph-style goal loop |
| `agent_goal_status` | Show one goal task (by `task`, `name`, or id) or list all goal tasks |
| `agent_goal_edit` | Change the goal text for an active goal task |
| `agent_goal_stop` | Stop a running goal task |

`agent_goal_launch` accepts `goal`, optional `verifier_commands`, `name`, `workdir`, `model`, `system_prompt`, `allowed_tools`, `max_iterations`, `max_cost_usd`, `permission_mode`, `harness`, `goal_mode`, and `completion_promise`. Verifier commands select verifier mode, otherwise Ralph-style completion-promise mode is used.

- **Verifier confirmation.** Verifier commands the orchestrator supplies run only after the user confirms them once: the task waits (`awaiting_verifier_confirmation`) and the user gets a message listing the exact commands with **Run these checks** / **Cancel** buttons; nothing runs before that. Commands the user typed in `/agent_goal` and commands listed in the `trustedVerifierCommands` config need no confirmation.
- **Plan gate.** The first iteration uses the configured `permissionMode` (default `plan`), so its plan goes through the normal plan approval (`planApproval`); the goal loop never approves its own plan. Later iterations continue within the approved scope (`bypassPermissions`). A plan that waits past the idle timeout keeps the task waiting (`waiting_for_plan_approval`) until the decision resumes the session.
- **Limits.** `max_iterations` defaults to 8 and is capped at 25; restarts after a Gateway restart or an idle suspension count as iterations. The task stops after the same failure fingerprint repeats 3 times in a row. `max_cost_usd` stops the task before the next iteration once its sessions cost that much (sessions without a reported price, such as Codex with a ChatGPT login, count as $0).
- **Verifier execution.** Each command runs with `bash -c` (no login profile) in the task workdir, with the minimal environment from [Child process environments](#child-process-environments), in its own process group. Only the last 64 KiB of output is kept (a noisy passing check still passes), and on timeout (default 10 minutes, bounded to 1 second..30 minutes) the whole process group is terminated.

### `agent_merge`

Merge a worktree branch back to base.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Must resolve to a session with worktree metadata |
| `base_branch` | `string` | No | Literal Git branch name; options and revision expressions rejected. Defaults to detected base branch |
| `strategy` | `merge \| squash` | No | `merge` means rebase-then-fast-forward |

A merge never switches the user's checkout to another branch. `merge` rebases the branch onto base only when needed: in the session worktree, the checkout that already has the branch, or a temporary worktree. The base branch moves where it lives: when base is checked out (usually the main checkout) the fast-forward or squash commit runs there, uncommitted changes there are auto-stashed and restored on that same branch, and repository hooks run per `worktreeGitHooks`; when base is not checked out anywhere, the base ref is updated directly (compare-and-swap) and no checkout is touched. Uncommitted changes in the branch's own checkout are reported as such, not as a rebase conflict, and rebasing a branch that was already pushed adds a warning because the remote copy keeps the old commits. A branch that changes hook locations needs the user's button (see [Git Hooks](#git-hooks)).
| `push` | `boolean` | No | Defaults to `false`; set `true` only when you want the merged base branch pushed |
| `delete_branch` | `boolean` | No | Defaults to `true` |

`agent_merge` does not start a conflict resolver: with `strategy: merge`, rebase conflicts are reported with manual resolution steps, and a conflicting `strategy: squash` merge is reported as a merge failure. Only the `auto-merge` worktree strategy starts a conflict-resolver session for rebase conflicts.

After a successful local merge, auto-merge, or local-merge-with-push-failure outcome, the plugin sends the canonical worktree status and wakes the orchestrator with `completionWakeSummaryRequired=true`. The wake carries the authoritative session origin route/thread block, including persisted route metadata when the active row no longer has it. The orchestrator must read `agent_output(session, full=true)` when available and send one short factual routed summary to that origin route; a good summary inside that output is not itself visible delivery. The generic terminal completion path must not emit a second completion follow-up for that same worktree outcome. If `push=true` fails after the local merge, that follow-up must describe the push failure and must not claim the merge reached the remote. The persisted `completionWakeSummaryRequired` bit is pending-only; it is cleared only after the routed wake transport succeeds with a non-empty final response that is not `NO_REPLY`. For PR outcomes, the canonical status is the only message that carries the raw PR URL; follow-up summaries should refer to PR number, repository, and branch instead.

### `agent_pr`

Create or update a GitHub PR for a worktree branch.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Must resolve to a session with worktree metadata |
| `title` | `string` | No | Auto-generated if omitted |
| `body` | `string` | No | Auto-generated if omitted |
| `base_branch` | `string` | No | Literal Git branch name; options and revision expressions rejected. Defaults to detected base branch |
| `force_new` | `boolean` | No | Reject instead of updating an existing PR |
| `update_metadata` | `boolean` | No | For an open PR, refresh the title and body. By default only OpenClaw-generated bodies and fallback titles are refreshed |
| `update_body` | `boolean` | No | Alias for `update_metadata` |
| `target_repo` | `string` | No | Cross-repo PR target (e.g. `openai/codex`); auto-detected from the `upstream` remote |

The PR path pushes the worktree branch on demand, then handles open, merged, and closed PR states instead of blindly creating duplicates. When session metadata already points at an open PR, `agent_pr` treats that PR's head branch as authoritative; a follow-up/helper worktree branch is fast-forwarded into the original PR branch when safe, and divergent branches are rejected instead of creating a sibling PR. Newly created agent-authored worktree PRs are opened as GitHub draft PRs by default so a human can review before marking them ready. Existing open PR updates preserve the PR's current draft/ready state.

When `title` or `body` is omitted, `agent_pr` prefers LLM-generated PR metadata from the host's `api.runtime.llm.complete(...)`. It also reads a bounded, redacted preview of active or persisted coding-session output. If no metadata provider is configured, or if the provider fails or returns invalid/unsafe output, structured `Root cause`, `Fix`/`Changes`, and `Validation` sections from the completed session report provide task-specific metadata; the commit subject supplies the title. If neither source is usable while creating a new PR, it falls back to deterministic conservative metadata derived from the session name, branch, prompt snippet, and diff summary so explicit PR creation flows can still complete. Existing generated PR metadata refreshes are non-destructive: unavailable task-specific evidence preserves the current generated PR title/body and reports the refresh failure instead of replacing richer metadata with generic fallback text.

PR opened and PR updated outcomes use the same post-outcome follow-up contract as merge outcomes: the canonical PR status is delivered first, then the orchestrator is woken with the authoritative session origin route/thread block and must send one concise factual summary in that route/topic.

### `agent_worktree_status`

Show lifecycle-first worktree status for one session or all sessions with worktree metadata.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | No | Omit to list all tracked worktrees |

Status output is authoritative from persisted lifecycle plus current repository evidence. Each entry includes:

- persisted lifecycle state
- derived lifecycle state when local evidence upgrades it, including `released` when branch content already landed on base without a topology merge
- cleanup disposition: `safe now`, `preserve`, or `blocked`
- retained reasons such as `active session`, `pending decision`, `PR open`, `dirty worktree`, or `content already on base`

### `agent_worktree_cleanup`

Clean managed worktree lifecycle state safely, or dismiss one pending worktree decision.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `workdir` | `string` | No | Repository to inspect |
| `base_branch` | `string` | No | Literal Git branch name; options and revision expressions rejected. Defaults to detected base branch |
| `mode` | `preview_safe \| clean_safe \| preview_all` | No | Defaults to `preview_safe` when `dry_run=true`, otherwise `clean_safe` |
| `skip_session_check` | `boolean` | No | Deprecated; safe cleanup still never removes live sessions |
| `force` | `boolean` | No | Deprecated alias for `skip_session_check` |
| `dry_run` | `boolean` | No | Backward-compatible alias for `mode="preview_safe"` |
| `session` | `string` | No | Restrict cleanup to one session |
| `dismiss_session` | `boolean` | No | With `session`, permanently dismiss that worktree instead of resolving by repo evidence |

With no `session`, the tool performs a deterministic "clean all safe" pass over all managed worktrees in scope. It removes only sessions whose lifecycle resolves as safe now:

- `merged`
- `released`
- `dismissed`
- `no_change`

The cleanup tool always preserves:

- branches with active sessions
- worktrees with dirty tracked changes
- pending review/decision worktrees
- branches with open PRs or PR state that has not been reflected locally yet
- anything whose local repo evidence does not prove a safe resolved state

Successful cleanup clears the tracked branch/path and persists the resolved lifecycle state plus the retained reasons used for the cleanup decision.

### `agent_repo_policy`

Inspect or update the repo integration policy (see [Worktree Strategies](#worktree-strategies)).

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `workdir` | `string` | No | Repo directory; defaults to the current tool workspace. Reset also accepts a stored repo path or key |
| `policy` | `pr-required \| pr-allowed \| never-pr \| manual` | No | Sets the policy for the repo |
| `reset` | `boolean` | No | Removes a stored policy; also works after the repo directory was deleted |
| `list` | `boolean` | No | Lists stored repo policies |
| `cleanup` | `boolean` | No | Removes stored repo policies whose repo root no longer exists on disk |

Examples:

- `agent_repo_policy(workdir="/repo", policy="pr-required")`
- `agent_repo_policy(workdir="/deleted/repo", reset=true)`
- `agent_repo_policy(cleanup=true)`
- `/agent_policy pr-allowed`
- `/agent_policy reset /deleted/repo`
- `/agent_policy cleanup`
- `/agent_policy list`

A stored policy is keyed by the repo root and its normalized remote URL. Reset and the status view first resolve the live repo; when the directory is gone or is no longer a git checkout, they match stored records by repo path (a path inside the deleted repo matches its deepest stored root) or by a stored key. Resetting a live repo also removes records left at the same path under an older remote. `list` marks policies whose repo directory is missing with `(missing)`.

Stored policies for deleted repos are not pruned automatically: a directory can be missing only for a while (an unmounted volume, or a re-clone at the same path, which reuses the policy), and the records are small. Remove them with `reset` or `cleanup`, which also drops records whose repo now resolves to a different remote.

## Chat Commands

For natural-language launches, the plugin ships with `oca` as a built-in short name for OpenClaw Code Agent. No custom local alias config is needed for these phrase shapes:

```text
Let oca do the auth middleware bug fix.
Ask oca to add tests for the billing flow.
Have oca handle the failing dashboard smoke test.
```

| Command | Usage | Purpose |
| --- | --- | --- |
| `/agent` | `/agent [--name <name>] <prompt>` | Launch a session from chat |
| `/agent_sessions` | `/agent_sessions [--full]` | List sessions |
| `/agent_output` | `/agent_output <id-or-name> [--full] [--lines N]` | Show recent output |
| `/agent_respond` | `/agent_respond [--interrupt] <id-or-name> <message>` | Send a reply |
| `/agent_kill` | `/agent_kill <name-or-id>` | Stop a session |
| `/agent_stats` | `/agent_stats` | Show aggregate metrics |
| `/agent_policy` | `/agent_policy [pr-required\|pr-allowed\|never-pr\|manual\|reset [repo-path]\|list\|cleanup]` | Set or inspect repository worktree/PR policy; no argument shows the current repo |
| `/agent_goal` | `/agent_goal [--name <name>] [--workdir <dir>] [--model <model>] [--harness <name>] [--mode ralph\|verifier] [--completion-promise <text>] [--max-iterations N] [--max-cost-usd N] [--permission-mode <mode>] [--verify <cmd> ...] <goal>` | Launch an explicit goal task (commands typed here need no extra confirmation) |
| `/agent_goal_status` | `/agent_goal_status [<task-id-or-name>]` | Show one goal task or list all goal tasks |
| `/agent_goal_edit` | `/agent_goal_edit <task-id-or-name> <replacement-goal>` | Change the goal text for an active goal task |
| `/agent_goal_stop` | `/agent_goal_stop <task-id-or-name>` | Stop a running goal task |

Use `agent_sessions` to inspect resumable sessions. Continue them with `agent_respond`, or fork from prior context with `agent_launch(..., resume_session_id=..., fork_session=true)`. `agent_respond` is the normal continuation path; `agent_launch(resume_session_id=...)` without `fork_session` also continues a stopped session in place (needed for `rewind_turns`) and refuses a running one.

## Routing And Channels

### `agentChannels`

`agentChannels` maps workspace paths to notification channels. The plugin uses longest-prefix matching, so a specific project can override a broader catch-all path.

Example:

```json
{
  "agentChannels": {
    "/home/user/projects": "telegram|default-bot|1111111111",
    "/home/user/projects/critical-app": "telegram|ops-bot|2222222222"
  }
}
```

A session launched in `/home/user/projects/critical-app/api` routes to `telegram|ops-bot|2222222222`, not the broader default entry.

### Channel Formats

| Format | Example |
| --- | --- |
| Telegram with explicit bot | `telegram|my-bot|123456789` |
| Telegram with default bot | `telegram|123456789` |
| Discord channel | `discord|channel:1234567890123456789` |
| Discord with explicit bot account | `discord|my-bot|channel:1234567890123456789` |
| Discord DM | `discord|user:1234567890123456789` |

For Discord, OpenClaw accepts both canonical route targets and origin-derived session-key variants:

| Source | Supported forms | Normalized route target |
| --- | --- | --- |
| Explicit route target | `discord|channel:<id>` | `channel:<id>` |
| Explicit route target | `discord|user:<id>` | `user:<id>` |
| Origin session key | `agent:<agent>:discord:channel:<id>` | `channel:<id>` |
| Origin session key | `agent:<agent>:discord:group:<id>` | `channel:<id>` |
| Origin session key | `agent:<agent>:discord:dm:<id>` | `user:<id>` |
| Origin session key | `agent:<agent>:discord:direct:<id>` | `user:<id>` |
| Origin session key (`per-account-channel-peer` DM scope) | `agent:<agent>:discord:<account>:direct:<id>` | `user:<id>` |
| Bare numeric Discord target | `discord|1234567890123456789` | `channel:<id>` |

Bare numeric Discord targets default to channel routing unless the originating session key explicitly marks the target as `dm` or `direct`. The same account-scoped DM keys work for every channel (for example `agent:<agent>:telegram:<account>:direct:<id>` routes to `<id>`); when the session key is the only route source, its account segment becomes the route account.

### Routing Order

Tool launches resolve the origin channel in this order:

1. the trusted `ctx.deliveryContext` (channel, target, and account)
2. `ctx.messageChannel` when it is already `channel|account|target`, or combined with `ctx.agentAccountId`, the chat id, or the sender id
3. `agentChannels` match for the workspace directory
4. raw `ctx.messageChannel` if already pipe-delimited
5. `fallbackChannel`
6. `"unknown"`

Thread routing is separate from channel routing. When OpenClaw provides the originating session key or thread ID, notifications return to the exact thread or topic where the session started.

Session-key recovery follows OpenClaw's current provider-owned grammar: generic `:thread:` suffixes (Discord, Slack, and other channels) use the public `openclaw/plugin-sdk/routing` `parseThreadSessionSuffix` helper, for both the route and the session's recorded origin thread. Telegram forum `:topic:` suffixes are parsed by OCA itself: the host's topic helpers are private to the Telegram channel plugin and the private-local `channel-route` runtime, and the public `parseAgentSessionKey` lower-cases peer ids, so it cannot recover a deliverable target.

Prefer fully routable channel strings in `fallbackChannel` and `agentChannels`. A bare provider such as `telegram` is treated as a weak fallback; the plugin will repair topic routing from `originSessionKey` when it can, but explicit channel targets remain the cleanest configuration.

## Notifications

| Event | User Message |
| --- | --- |
| Launch | `🚀` session launched |
| Waiting for input | `❓` session asked a real question |
| Plan ready | `📋` plan ready for review |
| Reply or redirect sent | `↪️` follow-up delivered |
| Plan approved | `👍` plan approved |
| Resumed | `▶️` session resumed from persisted context |
| Turn completed | `⏸️` paused after turn |
| Completed | `✅` done with cost and duration |
| Failed | `❌` failed, with recovery guidance |
| Idle timeout | `💤` idle kill |
| Stopped | `⛔` stopped by user or shutdown |
| Worktree decision in `ask` | Inline `Merge` / `Open PR` / `Later` / `Discard` buttons (state-aware) |
| Worktree decision in `delegate` | Orchestrator wake only |

`ask` and `delegate` suppress the normal turn-complete wake at the end of the session because the worktree decision message becomes the completion signal.

## OpenClaw Host Integration

OCA uses only public plugin-SDK surfaces that OpenClaw grants untrusted external plugins. Trusted-only surfaces (`runtime.state` keyed/blob stores, scoped `runtime.gateway.request`, private-local `*-runtime` SDK subpaths) are not used.

| Concern | Host surface | Notes |
| --- | --- | --- |
| Plugin entry and types | `openclaw/plugin-sdk/plugin-entry` | `api.runtime` is typed as the published `PluginRuntime`. Telegram/Discord interactive handler contexts stay local in `api.ts` because the host only publishes a generic `PluginInteractiveRegistration<unknown>`; OCA reads only the namespace-stripped `payload` field. |
| Tool parameter schemas | `typebox` (bundled) | Tool parameters are TypeBox schemas, the format the plugin SDK types tool parameters with. |
| Direct user notifications | `openclaw/plugin-sdk/channel-outbound` `sendDurableMessageBatch` | Text plus a channel-agnostic `presentation` (buttons) goes through the host's durable outbound queue with `durability: "required"`. Core renders Telegram inline keyboards / Discord components and owns retry and crash recovery for an admitted send, so OCA sends each notification once and never re-sends it to the user. When the host reports a definite failure for a text-only notification that does not require direct delivery, OCA hands the text to the agent session as a system event instead; notifications with buttons or that require direct delivery are reported as failed. A send that times out with an unknown outcome is reported as a delivery failure without any system-event fallback. There is no `openclaw message send` CLI fallback. |
| Orchestrator wakes | `openclaw gateway call chat.send` subprocess | Stays a subprocess: in-process `runtime.gateway.request` with operator scopes is trusted-only. |
| Wake fallback / system notices | `api.runtime.system.enqueueSystemEvent` + `requestHeartbeat` (wakes only) | Replaces `openclaw system event --mode now`. Events always target the session's origin session key. A wake fallback (a failed or `NO_REPLY` `chat.send`, or a session without a chat route) also requests an immediate `notifications-event` heartbeat, because the orchestrator must act on it now. A text-only notice whose direct send failed is only enqueued when the same dispatch also sends an OCA wake: the host prepends the notice to that wake's `chat.send` turn. A notice with no following wake (for example a launch or stop notice) still requests the heartbeat, because otherwise nothing guarantees a turn that shows it. The trade-off is cost against delivery: OpenClaw 2026.9.6 has no plugin-usable wake that handles a generic system event without the heartbeat routine. Every `requestHeartbeat` intent runs the agent's configured heartbeat prompt (its `HEARTBEAT.md` checklist, with any memory reads and workspace checks it asks for) with the queued events attached. Only exec completions and `cron:` events get an event-only prompt, and those belong to their host producers. `intent: "event"` uses the same prompt with cooldown gating and is not admitted for agents without a heartbeat schedule. Operators can make wake-fallback heartbeats cheaper with the host's `heartbeat.lightContext` / `heartbeat.isolatedSession` settings. OCA never falls back to the bare `main` alias (a multi-agent host rejects it, and on a single-agent host it would land in the user's direct-message session): a session without an origin key, or a key the host refuses, logs a warning and skips the system event. |
| LLM summaries | `api.runtime.llm.complete` | Worktree decision summaries, question context summaries, and PR metadata send `messages`, `systemPrompt`, `purpose` (`openclaw-code-agent.*`), `maxTokens`, and `reasoning: "low"`, and parse `LlmCompleteResult.text`. OCA requests no model/agent/profile override, so no `plugins.entries.openclaw-code-agent.llm.*` opt-in is needed; an operator `llm.allowedCompletionModels` allowlist can still deny the default model (`LLM_COMPLETION_NOT_AUTHORIZED`). Completions run in a context detached from the tool call that started the session, because the host rejects work scheduled from a request scope that has already closed (`Async work scope is closed`). Every summary keeps its deterministic fallback. Question summaries have a 5 s budget and abort the completion when it expires. `runtime.subagent.complete` is not used: it is only bound inside a Gateway request scope, and these summaries run from background session events. |
| Session lifecycle mirror | `api.runtime.tasks.async.managedFlows` (no `runtime.taskFlow` or synchronous fallback) | Creates flows with `tryCreateManaged` (no mirror when the host cannot persist), mirrors progress with `setWaiting`/`resume`, and finishes with `finish`/`fail`. A user stop records `requestCancel` (retried against the host's current revision after a concurrent update, and repeated by restart reconciliation if it was never recorded), so the host settles the flow as `cancelled`. `openclaw tasks flow cancel <flow>` is honored: live mirrors re-read their flow every 15 s (and inspect every mutation result) and stop the session when a cancel intent appears. `getTaskSummary` is not used because OCA flows never own child tasks. |
| State paths | `openclaw/plugin-sdk/state-paths` `resolveStateDir` | Follows the Gateway's `OPENCLAW_STATE_DIR` / `OPENCLAW_HOME` rules. |
| JSON stores | `openclaw/plugin-sdk/json-store` `saveJsonFile` / `loadJsonFile` | The session index, goal task store, and auto-update state are written as private (`0600`) files in a `0700` directory: the helper writes a temp file in the same directory, fsyncs it, renames it over the target, then fsyncs the directory on a best-effort basis. Where rename cannot replace an existing file (Windows `EPERM`/`EEXIST`) it removes the target first, so that replacement is not atomic. The synchronous helper is used because these stores are saved from synchronous code paths; the async `writeJsonFileAtomically` would let concurrent saves reorder. |
| Logging | `api.runtime.logging.getChildLogger` | Plugin diagnostics are written to the Gateway log with `{ plugin: "openclaw-code-agent", subsystem }` bindings. Per-dispatch delivery progress logs at `debug`; failures at `warn`/`error`. |

Files owned by the plugin:

| Path | Contents |
| --- | --- |
| `<stateDir>/code-agent-sessions.json` | Session index (override: `OPENCLAW_CODE_AGENT_SESSIONS_PATH`) |
| `<stateDir>/code-agent-goal-tasks.json` | Goal tasks (override: `OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH`) |
| `<stateDir>/plugin-state/openclaw-code-agent/output/openclaw-agent-<session>.txt` | Full session output transcripts (private `0700` directory, `0600` files) |
| `<stateDir>/plugin-state/openclaw-code-agent/auto-update.json` | Update-check state; a pre-5.0 `openclaw-code-agent-auto-update.json` is read once when this file does not exist yet |

Output transcripts are removed by the maintenance schedule when they are no longer referenced by a persisted session or have aged out. Pre-5.0 transcripts in the OS temp directory (`/tmp/openclaw-agent-*.txt`) stay readable through their stored paths and are aged out by the same cleanup.

Worktree cleanup is owned by the maintenance schedules (resolved worktrees after their retention window) and `agent_worktree_cleanup`. There is no startup sweep that deletes unmanaged `openclaw-worktree-*` directories by age; remove orphaned directories with `git worktree remove`/`git worktree prune` after reviewing them.

Worktree-decision reminders use in-process deadline timers that are rebuilt from persisted session state on startup. Host scheduling is not used: `api.session.workflow.registerSessionSchedulerJob` only records cleanup metadata, `scheduleSessionTurn` is bundled-only, and service `getCron()` jobs run agent turns or system events rather than plugin callbacks, so they cannot build the policy-aware reminder buttons.

## Session Lifecycle

- A launched session starts in `starting`, becomes active while the harness is running, and then moves into explicit review, waiting, suspended, or terminal states.
- `agent_respond` sends follow-up messages to running sessions and automatically resumes a stopped, completed, or suspended session that still has a backend conversation id; otherwise it explains how to fork or relaunch.
- `agent_respond` is the explicit continuation path for persisted resumable sessions after GC or restart.
- Runtime GC evicts old runtime records from memory after `sessionGcAgeMinutes`, but explicitly resumable persisted sessions remain available through `agent_sessions`.
- Startup recovery may convert interrupted running sessions into resumable persisted entries so they can be continued intentionally.
- Persisted session resolution accepts OCA session IDs, names, and backend conversation IDs.
- `idleTimeoutMinutes` suspends a session that waits: for the user (a question or a plan decision) or for the next message between turns. A turn that is still working is not idle, even when its backend reports no progress (for example one long, silent shell command). Claude Code progress heartbeats (`tool_progress`, subagent and hook progress, partial output) also count as activity.
- When a backend stops without finishing (its process exited or its event stream closed, for example the Codex app server dying between turns), the session fails with that reason instead of staying `running`; the next `agent_respond` resumes it.
- A Codex resume id that is not a Codex thread UUID fails the launch instead of silently starting a fresh thread.
- An early startup failure (failed, zero cost, under 30 s) removes the worktree and branch only when this launch created them and the branch has no commits of its own; a resumed session's worktree and branch are always kept.

## Troubleshooting

- Why OCA reinstalls itself instead of calling `openclaw plugins update`: OpenClaw `2026.9.6` resolves `<npm-package>@<version>` against npm install records, but still cannot retarget a ClawHub install (`<id>@<version>` reports "No tracked plugin or hook pack found", and a bare-id update stays on the version pinned in the recorded `clawhub:` spec). OCA therefore keeps its own exact-version reinstall: npm installs use `openclaw plugins install <recorded-npm-package>@<approved-version> --force`, ClawHub installs use `openclaw plugins install clawhub:<recorded-package>@<approved-version> --force`, and success requires the installed plugin discovery plus managed source, package, and version metadata from `plugins inspect --json` to match. The running Gateway can legitimately retain the prior loaded version until the separately confirmed restart.
- An OCA Telegram update button spins but no action runs: temporarily enable `OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS=1` and inspect logs for `callback_handler_registered`, `callback_received`, `callback_token_lookup_completed`, and `callback_update_action_started`. Diagnostics contain hashes rather than callback tokens. Registration without `callback_received` means OpenClaw core did not dispatch the tap to OCA; the plugin cannot acknowledge or act on a callback it never receives.
- A button reports "⚠️ This action is stale or has already been used." although it is the latest prompt: turn on debug logging for the plugin and look for `callback_token_miss` and `action_token_lookup_miss`. They record the runtime instance and build (`instanceId`), the store `storeRevision`, and the number of tokens in memory, never the token. Every plugin registry in one Gateway process shares one runtime, so two different `instanceId` values in one process mean two runtimes and should be reported. `index_reloaded_after_external_write` means another writer changed the session index and OCA merged its rows. "This session is running in another OpenClaw Code Agent runtime" means the session belongs to another writer of the same index; use the buttons from that runtime's latest message.
- A tool fails with "superseded by a newer build": a hot reload loaded a newer OCA build in the same Gateway, which took over the runtime. Retry; the call runs on the new build.
- No notifications: verify `fallbackChannel` or `agentChannels` use fully routable channel strings. If you changed plugin config on disk, reload or restart the gateway through your normal operator process.
- Wrong chat receives the update: check `agentChannels` longest-prefix matches and remove ambiguous path entries.
- Worktree was not created: confirm the workdir is a git repo and there is enough free space for the worktree.
- Push or PR failed: `agent_pr` needs a GitHub remote plus `gh` installed and authenticated, and repo policy must allow PRs. `agent_merge(push=true)` also needs a configured remote. `ask` and `delegate` keep branches local until one of those explicit push paths is chosen; `auto-pr` falls back into the same explicit pending-decision state when automatic PR creation fails.
- Model launch rejected: update `harnesses.<name>.allowedModels` or the harness default model so they agree.
- Codex auth weirdness: prefer `forced_login_method = "chatgpt"` and relaunch.
- Notification delivery failed or timed out: inspect direct-delivery diagnostics and routing metadata first. Do not treat missing interactive buttons as proof that the underlying plan, worktree decision, or runtime state changed.
- Plan approval buttons are missing: reply with plain text `Approve`, `Revise`, or `Reject` in the same thread while the plan is awaiting review, then inspect delivery diagnostics separately.
- A stale plan prompt appears after rejection, requested changes, kill, or a newer review prompt: treat it as stale UI unless `agent_sessions` shows the session is still awaiting approval for that current review version. Supported transports clear old controls, but clients may still surface an old prompt long enough for the callback handler to report it as stale.
