# Reference

Canonical operator reference for `openclaw-code-agent`: install, configuration, tool surface, chat commands, routing, notifications, worktree behavior, and troubleshooting.

## Defaults At A Glance

| Setting | Default |
| --- | --- |
| `defaultHarness` | `claude-code` |
| `harnesses.claude-code.defaultModel` | `sonnet` |
| `harnesses.codex.defaultModel` | `gpt-5.4` |
| `harnesses.codex.reasoningEffort` | `medium` |
| `harnesses.codex.approvalPolicy` | `on-request` |
| `permissionMode` | `plan` |
| `planApproval` | `ask` |
| `defaultWorktreeStrategy` | `ask` |
| `maxSessions` | `20` |
| `maxAutoResponds` | `10` |
| `idleTimeoutMinutes` | `15` |
| `sessionGcAgeMinutes` | `1440` |
| `maxPersistedSessions` | `10000` |

Sessions are multi-turn. Active sessions accept follow-up messages via `agent_respond`, and explicitly suspended sessions can also be continued with `agent_respond`.

## Upgrade Note

`3.5.0` treats persisted session storage as new-schema-only. If startup finds an older or invalid session store, the plugin archives it to a timestamped `.legacy-*.json` backup and starts with a fresh index instead of migrating rows in place.

Old Codex SDK persisted sessions are archived separately and are not resumed. App Server-backed Codex sessions are the only supported Codex runtime going forward.

## Install

```bash
openclaw plugins install openclaw-code-agent
openclaw plugins enable openclaw-code-agent
openclaw gateway restart
```

## Minimal Config

Add this under `plugins.entries["openclaw-code-agent"]` in `~/.openclaw/openclaw.json`:

```json
{
  "enabled": true,
  "config": {
    "fallbackChannel": "telegram|my-bot|123456789",
    "planApproval": "ask",
    "defaultWorktreeStrategy": "ask",
    "harnesses": {
      "claude-code": {
        "defaultModel": "sonnet",
        "allowedModels": ["sonnet", "opus"]
      },
      "codex": {
        "defaultModel": "gpt-5.4",
        "allowedModels": ["gpt-5.4"],
        "reasoningEffort": "medium",
        "approvalPolicy": "on-request"
      }
    }
  }
}
```

If you use Codex, recommend this in `~/.codex/config.toml`:

```toml
forced_login_method = "chatgpt"
```

## Harnesses

| Harness | Models | Notes |
| --- | --- | --- |
| `claude-code` | Controlled by `harnesses.claude-code.allowedModels` | Native Claude Code harness with plan-mode interception |
| `codex` | Controlled by `harnesses.codex.allowedModels` | Native Codex App Server harness with structured pending input, structured plans, and native backend worktree refs |

Allowed-model matching is case-insensitive substring matching. If the resolved model is not allowed, `agent_launch` fails immediately.

## Permission And Approval Modes

### `permissionMode`

| Mode | Meaning |
| --- | --- |
| `default` | Standard interactive execution |
| `plan` | Present the plan first, then wait for approval before implementation |
| `bypassPermissions` | Fully autonomous execution |

`plan` is the plugin default. Claude Code and Codex both feed the same plugin-owned approval workflow; Codex now supplies structured plan artifacts through the App Server backend instead of relying on text-shape inference.

### `planApproval`

| Mode | Meaning |
| --- | --- |
| `ask` | Default. Notify the user directly and wait for explicit approval or revision |
| `delegate` | Wake the orchestrator with the full plan and let it decide whether to approve or escalate |
| `approve` | Auto-approve after verification |

In `ask`, the plugin sends action buttons for `Approve`, `Reject`, and `Request changes` when interactive callbacks are available. The same flow still works through plain replies.

## Worktree Strategies

| Strategy | Where It Is Set | Behavior |
| --- | --- | --- |
| `off` | Tool param or config | No worktree; session runs in the main checkout |
| `manual` | Tool param or config | Create worktree and branch, then stop for manual follow-through |
| `ask` | Tool param or config | Default. Keep the branch local, notify the user, and send inline 4-button decision UI |
| `delegate` | Tool param or config | Keep the branch local, wake the orchestrator with diff context; orchestrator must merge or escalate |
| `auto-merge` | Tool param or config | Merge back automatically; spawn a conflict resolver if needed |
| `auto-pr` | Tool param or config | Create or update the PR automatically; on failure, fall back to an explicit pending worktree decision |

### Worktree Decision Buttons

When a session completes with changes under `ask` or `delegate`, users receive explicit decision buttons:

| Button | Action |
| --- | --- |
| **Merge locally** | Merge branch into base locally |
| **Create PR** | Create a GitHub PR when none exists |
| **View PR / Update PR** | Shown instead of `Create PR` once a PR already exists |
| **Decide later** | Snooze reminders for 24h |
| **Dismiss** | Permanently delete branch and worktree (irreversible) |

### Worktree Lifecycle

| State | `worktreeDisposition` | Notes |
| --- | --- | --- |
| Active with pending decision | `active` | Worktree preserved; decision buttons sent |
| PR created | `pr-opened` | Worktree preserved for follow-up commits |
| Merged | `merged` | Worktree and branch cleaned up |
| Dismissed | `dismissed` | Branch and worktree permanently deleted |
| No-change clean | `no-change-cleaned` | No commits made; worktree silently cleaned up |

Notes:

- `agent_launch` accepts `off`, `manual`, `ask`, `delegate`, `auto-merge`, and `auto-pr` as `worktree_strategy`.
- `delegate` can also be configured at the plugin level with `defaultWorktreeStrategy`.
- Explicit per-launch `worktree_strategy` wins over the plugin default.
- Resumed sessions keep the worktree strategy they already had.
- Worktrees are kept alive until explicitly resolved (merge/PR/dismiss) when using non-trivial strategies.
- Stale-decision reminders fire every 3h; users can snooze per-session for 24h.
- Claude Code uses plugin-managed worktrees; Codex may execute inside a native backend-managed worktree while the plugin still owns merge/PR/reminder policy.

## Tool Reference

### `agent_launch`

Launch a background coding session.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `prompt` | `string` | Yes | Task to execute |
| `name` | `string` | No | Short session name; auto-generated if omitted |
| `workdir` | `string` | No | Defaults to tool workspace, plugin `defaultWorkdir`, or cwd |
| `model` | `string` | No | Defaults to the selected harness default model |
| `system_prompt` | `string` | No | Extra system prompt |
| `allowed_tools` | `string[]` | No | Harness tool allowlist |
| `resume_session_id` | `string` | No | Resume by plugin session ID, name, or persisted backend conversation ID; linked resumable sessions are preferred over creating a duplicate fresh launch |
| `fork_session` | `boolean` | No | Fork instead of continuing when resuming |
| `permission_mode` | `default \| plan \| bypassPermissions` | No | Defaults to plugin `permissionMode` |
| `harness` | `string` | No | Defaults to `defaultHarness` |
| `worktree_strategy` | `off \| manual \| ask \| delegate \| auto-merge \| auto-pr` | No | Explicit per-launch value wins over plugin default; `auto-pr` attempts PR creation/update automatically |
| `worktree_base_branch` | `string` | No | Defaults to detected base branch |
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

Send a follow-up, redirect work, approve a plan, or escalate a `default` mode session to `bypassPermissions`.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Prefer the plugin session ID or name; persisted backend conversation IDs are still accepted for recovery/diagnostics |
| `message` | `string` | Yes | Follow-up text |
| `interrupt` | `boolean` | No | Abort the current turn before sending |
| `userInitiated` | `boolean` | No | Reset the auto-respond counter |
| `approve` | `boolean` | No | Approve a pending plan or escalate `default` mode permissions |

Example:

```text
agent_respond(
  session: "fix-auth",
  message: "Approved. Go ahead.",
  approve: true
)
```

### `agent_output`

Read buffered output without changing session state.

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

### `agent_stats`

Show aggregate session counts, cost, average duration, and most expensive sessions.

This tool takes no parameters.

### `agent_merge`

Merge a worktree branch back to base.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Must resolve to a session with worktree metadata |
| `base_branch` | `string` | No | Defaults to detected base branch |
| `strategy` | `merge \| squash` | No | `merge` means rebase-then-fast-forward |
| `push` | `boolean` | No | Defaults to `false`; set `true` only when you want the merged base branch pushed |
| `delete_branch` | `boolean` | No | Defaults to `true` |

On conflicts, the plugin spawns a conflict-resolver session using the configured default harness.

### `agent_pr`

Create or update a GitHub PR for a worktree branch.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | Yes | Must resolve to a session with worktree metadata |
| `title` | `string` | No | Auto-generated if omitted |
| `body` | `string` | No | Auto-generated if omitted |
| `base_branch` | `string` | No | Defaults to detected base branch |
| `force_new` | `boolean` | No | Reject instead of updating an existing PR |

The PR path pushes the worktree branch on demand, then handles open, merged, and closed PR states instead of blindly creating duplicates.

### `agent_worktree_status`

Show the worktree state for one session or all sessions with worktree metadata.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `session` | `string` | No | Omit to list all tracked worktrees |

### `agent_worktree_cleanup`

Clean up merged `agent/*` branches or dismiss a pending worktree decision.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `workdir` | `string` | No | Repository to inspect |
| `base_branch` | `string` | No | Defaults to detected base branch |
| `skip_session_check` | `boolean` | No | Skip only the active-session protection |
| `dry_run` | `boolean` | No | Preview without deleting |
| `session` | `string` | No | Clear a pending worktree decision for that session |

The cleanup tool always protects:

- branches with active sessions
- branches with unmerged commits
- branches with open PRs

## Chat Commands

| Command | Purpose |
| --- | --- |
| `/agent` | Launch a session from chat |
| `/agent_sessions` | List sessions |
| `/agent_output` | Show recent output |
| `/agent_respond` | Send a reply |
| `/agent_kill` | Stop a session |
| `/agent_stats` | Show aggregate metrics |

Use `agent_sessions` to inspect resumable sessions. Continue them with `agent_respond`, or fork from prior context with `agent_launch(..., resume_session_id=..., fork_session=true)`. `agent_respond` is the only continuation primitive.

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

### Routing Order

Tool launches resolve the origin channel in this order:

1. `ctx.messageChannel` plus `ctx.agentAccountId`
2. `agentChannels` match for the workspace directory
3. raw `ctx.messageChannel` if already pipe-delimited
4. `fallbackChannel`
5. `"unknown"`

Thread routing is separate from channel routing. When OpenClaw provides the originating session key or thread ID, notifications return to the exact thread or topic where the session started.

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
| Worktree decision in `ask` | Inline `Merge locally` / `Create PR` buttons |
| Worktree decision in `delegate` | Brief user ping plus orchestrator wake |

`ask` and `delegate` suppress the normal turn-complete wake at the end of the session because the worktree decision message becomes the completion signal.

## Session Lifecycle

- A launched session starts in `starting`, becomes active while the harness is running, and then moves into explicit review, waiting, suspended, or terminal states.
- `agent_respond` sends follow-up messages to active sessions. It only resumes a session automatically when that session is explicitly suspended and still has resumable harness state.
- `agent_respond` is the explicit continuation path for persisted resumable sessions after GC or restart.
- Runtime GC evicts old runtime records from memory after `sessionGcAgeMinutes`, but explicitly resumable persisted sessions remain available through `agent_sessions`.
- Startup recovery may convert interrupted running sessions into resumable persisted entries so they can be continued intentionally.
- Persisted session resolution accepts internal IDs, names, and harness session IDs.

## Troubleshooting

- No notifications: verify `fallbackChannel` or `agentChannels` use fully routable channel strings, then restart the gateway.
- Wrong chat receives the update: check `agentChannels` longest-prefix matches and remove ambiguous path entries.
- Worktree was not created: confirm the workdir is a git repo and there is enough free space for the worktree.
- Push or PR failed: `agent_pr` always needs a configured remote plus `gh` installed and authenticated. `agent_merge(push=true)` also needs a configured remote. `ask` and `delegate` keep branches local until one of those explicit push paths is chosen; `auto-pr` falls back into the same explicit pending-decision state when automatic PR creation fails.
- Model launch rejected: update `harnesses.<name>.allowedModels` or the harness default model so they agree.
- Codex auth weirdness: prefer `forced_login_method = "chatgpt"` and relaunch.
