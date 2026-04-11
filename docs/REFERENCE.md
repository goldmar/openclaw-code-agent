# Reference

Canonical operator reference for `openclaw-code-agent`: install, configuration, tool surface, chat commands, routing, notifications, worktree behavior, and troubleshooting.

## Defaults At A Glance

| Setting | Default |
| --- | --- |
| `defaultHarness` | `claude-code` |
| `harnesses.claude-code.defaultModel` | `sonnet` |
| `harnesses.codex.defaultModel` | `gpt-5.4` |
| `harnesses.codex.reasoningEffort` | `medium` |
| `permissionMode` | `plan` |
| `planApproval` | `ask` |
| `defaultWorktreeStrategy` | `off` |
| `maxSessions` | `20` |
| `maxAutoResponds` | `10` |
| `idleTimeoutMinutes` | `15` |
| `sessionGcAgeMinutes` | `1440` |
| `maxPersistedSessions` | `10000` |

Sessions are multi-turn. Active sessions accept follow-up messages via `agent_respond`, and explicitly suspended sessions can also be continued with `agent_respond`.

## Upgrade Note

Current releases treat persisted session storage as new-schema-only. If startup finds an older or invalid session store, the plugin archives it to a timestamped `.legacy-*.json` backup and starts with a fresh index instead of migrating rows in place.

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
    "defaultWorktreeStrategy": "off",
    "harnesses": {
      "claude-code": {
        "defaultModel": "sonnet",
        "allowedModels": ["sonnet", "opus"]
      },
      "codex": {
        "defaultModel": "gpt-5.4",
        "allowedModels": ["gpt-5.4"],
        "reasoningEffort": "medium"
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
| `default` | Plugin-managed interactive execution. The session can ask questions or pause between turns, but Codex-side approval prompts stay disabled |
| `plan` | Present the plan first, then block implementation until approval |
| `bypassPermissions` | Fully autonomous execution with no plan checkpoint |

`plan` is the plugin default. Claude Code and Codex both feed the same plugin-owned approval workflow; Codex now supplies structured plan artifacts through the App Server backend instead of relying on text-shape inference.

For Codex, approval behavior is fixed to the supported execution path and is not user-configurable. Use `permissionMode` and `planApproval` to control review gates instead.

### `planApproval`

| Mode | Meaning |
| --- | --- |
| `ask` | Default. Notify the user directly with the full plan and wait for explicit approval or revision |
| `delegate` | Wake the orchestrator, require a full-plan review, then let it either approve directly or escalate back to the user with the same approval buttons |
| `approve` | Auto-approve after verification |

In `ask`, the plugin sends action buttons for `Approve`, `Revise`, and `Reject` when interactive callbacks are available, and the user-facing message includes the full plan text rather than the normal preview budget. Each session keeps one canonical actionable approval prompt per plan review version; later reminders for that same version are non-canonical reminders, not a fresh approval cycle. The same flow still works through plain replies. In `delegate`, the orchestrator must read the full plan with `agent_output(..., full=true)` before approving anything.

Revision and approval rules are version-scoped:

- `Revise` supersedes only the prior review version for that same session
- the revised plan becomes the latest actionable review version
- `agent_respond(..., approve=true)` resolves against that latest actionable version, even if older versions previously had `changes_requested`
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
- skip the summary only when the orchestrator is silently continuing an internal pipeline or there is no meaningful confirmed outcome to report yet

## Worktree Strategies

| Strategy | Where It Is Set | Behavior |
| --- | --- | --- |
| `off` | Tool param or config | No worktree; session runs in the main checkout |
| `manual` | Tool param or config | Create worktree and branch, then stop for manual follow-through |
| `ask` | Tool param or config | Keep the branch local, notify the user, and send inline 4-button decision UI |
| `delegate` | Tool param or config | Keep the branch local and wake the orchestrator with diff context; no user decision buttons are sent automatically |
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
- Explicit per-launch `worktree_strategy` wins over the plugin default.
- Resumed sessions keep the worktree strategy they already had.
- Worktrees are kept alive until explicitly resolved (merge/PR/dismiss) when using non-trivial strategies.
- Stale-decision reminders fire every 3h; users can snooze per-session for 24h.
- Claude Code uses plugin-managed worktrees; Codex may execute inside a native backend-managed worktree while the plugin still owns merge/PR/reminder policy.
- `released` covers different-SHA cases where the base branch already contains the branch content after rebase, cherry-pick, or squash.
- `agent_worktree_cleanup(mode="preview_safe")` previews what Clean all safe would remove, `mode="clean_safe"` performs it, and `mode="preview_all"` shows both safe sandboxes and retained reasons.

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
| `resume_session_id` | `string` | No | Resume by plugin session ID or name. Persisted backend conversation IDs still work for recovery/diagnostics, but they are not the normal operator-facing path |
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
| `session` | `string` | Yes | Prefer the plugin session ID or name. Persisted backend conversation IDs are accepted only for recovery/diagnostics |
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
| `base_branch` | `string` | No | Defaults to detected base branch |
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

For Discord, OpenClaw accepts both canonical route targets and origin-derived session-key variants:

| Source | Supported forms | Normalized route target |
| --- | --- | --- |
| Explicit route target | `discord|channel:<id>` | `channel:<id>` |
| Explicit route target | `discord|user:<id>` | `user:<id>` |
| Origin session key | `agent:<agent>:discord:channel:<id>` | `channel:<id>` |
| Origin session key | `agent:<agent>:discord:group:<id>` | `channel:<id>` |
| Origin session key | `agent:<agent>:discord:dm:<id>` | `user:<id>` |
| Origin session key | `agent:<agent>:discord:direct:<id>` | `user:<id>` |
| Bare numeric Discord target | `discord|1234567890123456789` | `channel:<id>` |

Bare numeric Discord targets default to channel routing unless the originating session key explicitly marks the target as `dm` or `direct`.

### Routing Order

Tool launches resolve the origin channel in this order:

1. `ctx.messageChannel` plus `ctx.agentAccountId`
2. `agentChannels` match for the workspace directory
3. raw `ctx.messageChannel` if already pipe-delimited
4. `fallbackChannel`
5. `"unknown"`

Thread routing is separate from channel routing. When OpenClaw provides the originating session key or thread ID, notifications return to the exact thread or topic where the session started.

Session-key recovery follows OpenClaw's current provider-owned grammar: Telegram `:topic:` parsing is delegated to the SDK helper, while generic `:thread:` suffixes remain available for other providers.

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
| Worktree decision in `delegate` | Orchestrator wake only |

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
