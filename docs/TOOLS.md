# Tools Reference

All tools provided by the OpenClaw Code Agent. Each tool is exposed to agents via the OpenClaw tool system.

> **Source of truth:** `src/tools/`

---

## Tool Summary

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `agent_launch` | Launch a coding agent session | `prompt`, `workdir`, `name`, `model`, `resume_session_id`, `worktree`, `worktree_strategy`, `worktree_base_branch` |
| `agent_respond` | Send follow-up message to a running session | `session`, `message`, `interrupt`, `userInitiated`, `approve` |
| `agent_kill` | Terminate a session | `session`, `reason` |
| `agent_output` | Show session output (read-only) | `session`, `lines`, `full` |
| `agent_sessions` | List recent sessions (5 by default, `full` for 24h view) | `status`, `full` |
| `agent_stats` | Show usage metrics | *(none)* |
| `agent_merge` | Merge a worktree branch to base branch | `session`, `base_branch`, `strategy`, `push`, `auto_cleanup` |
| `agent_pr` | Create or update a GitHub PR for a worktree branch (full lifecycle) | `session`, `title`, `body`, `base_branch`, `force_new` |
| `agent_worktree_status` | Show worktree status for sessions (branch, commits, merge/PR status) | `session` (optional) |
| `agent_worktree_cleanup` | Clean up merged agent/* branches | `workdir`, `base_branch`, `force`, `dry_run` |

> **Note:** There is no separate `agent_resume` tool. To resume a previous session, use `agent_launch` with the `resume_session_id` parameter. The `/agent_resume` chat command provides a convenient wrapper.

---

## agent_launch

Launch a coding agent session in the background to execute a development task. Sessions are multi-turn by default (they stay open for follow-up messages via `agent_respond`).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | **yes** | — | The task prompt to execute |
| `name` | string | no | auto-generated | Short kebab-case name (e.g. `fix-auth`). Auto-generated from prompt if omitted |
| `workdir` | string | no | agent workspace / cwd | Working directory for the session |
| `model` | string | no | harness default | Model name to use. If omitted, the plugin uses `harnesses.<selected-harness>.defaultModel` |
| `system_prompt` | string | no | — | Additional system prompt injected into the session |
| `allowed_tools` | string[] | no | — | List of allowed tools for the coding agent session |
| `resume_session_id` | string | no | — | Session ID to resume (from a previous session's `harnessSessionId`). Accepts name, internal ID, or harness UUID — the plugin resolves it |
| `fork_session` | boolean | no | `false` | When resuming, fork to a new session instead of continuing the existing one. Use with `resume_session_id` |
| `multi_turn_disabled` | boolean | no | `false` | Disable multi-turn mode. Set to `true` for fire-and-forget sessions that don't accept follow-ups |
| `permission_mode` | enum | no | plugin config (`plan` by default) | One of: `default` (standard prompts), `plan` (present plan first, wait for approval), `bypassPermissions` (fully autonomous execution) |
| `harness` | string | no | plugin `defaultHarness` (`claude-code`) | Harness backend. Built-ins: `claude-code`, `codex` |
| `worktree` | boolean | no | `false` | Create a git worktree for the session (keeps main checkout clean) |
| `worktree_strategy` | enum | no | `none` | Merge-back strategy: `none`, `ask`, `auto-merge`, `auto-pr` |
| `worktree_base_branch` | string | no | `main` | Base branch for merge/PR operations |

### Example

```
agent_launch(
  prompt: "Fix the authentication bug in src/auth.ts — users are logged out after refresh",
  name: "fix-auth-bug",
  workdir: "/home/user/my-project"
)
```

### Resuming a Previous Session

```
agent_launch(
  prompt: "Continue where you left off — also add tests for the fix",
  resume_session_id: "abc12345",
  name: "fix-auth-continued"
)
```

### Forking a Session

```
agent_launch(
  prompt: "Try an alternative approach using JWT instead",
  resume_session_id: "abc12345",
  fork_session: true,
  name: "fix-auth-jwt-approach"
)
```

---

## agent_respond

Send a follow-up message to a running multi-turn coding agent session. If the session hit idle timeout or paused after a completed turn (`done`), the plugin auto-resumes it with conversation context preserved. After a gateway restart, `agent_respond` can also target the persisted session by internal ID, name, or harness session ID and resume it directly.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID |
| `message` | string | **yes** | — | The message to send |
| `interrupt` | boolean | no | `false` | Interrupt the current turn before sending. Useful to redirect the session mid-response |
| `userInitiated` | boolean | no | `false` | Set to `true` when the message comes from the user (not auto-generated). Resets the auto-respond counter |
| `approve` | boolean | no | `false` | When `true` and the session has a pending plan approval, switches to implementation mode (`bypassPermissions`) before sending the message |

### Auto-Respond Safety Cap

The plugin tracks how many times an agent auto-responds to a session. When the counter reaches `maxAutoResponds` (default: 10), further agent-initiated responds are blocked. This prevents infinite agent-session loops.

- **Agent responds** increment the counter
- **User-initiated responds** (`userInitiated: true`) reset the counter to 0
- When blocked, the agent is instructed to ask the user for input

### Auto-Resume

When responding to a terminal session that is resumable, the plugin automatically spawns a new session with the same harness session ID, preserving conversation context. Sessions paused after turn completion, stopped by the user, recovered after gateway shutdown, or ended by idle timeout all auto-resume on the next `agent_respond`. The only exception is `startup-timeout` (sessions that failed to start), which does not auto-resume to avoid retry loops.

### Permission Modes By Harness

- Claude Code harness: passes `default` / `plan` / `bypassPermissions` through SDK permissions.
- Codex harness:
  - Always uses SDK thread option `sandboxMode: "danger-full-access"` and defaults to `approvalPolicy: "on-request"` unless `harnesses.codex.approvalPolicy` sets `"never"`
  - In `bypassPermissions`, adds filesystem root plus `OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS` entries to SDK `additionalDirectories`
  - `plan` is an orchestration behavior (plan approval flow), not an SDK sandbox restriction
  - Session continuation uses `codex.resumeThread(<thread-id>, options)` under the hood

### Crash / Restart Recovery

Session metadata (harness, workdir, model, name, harness session ID) is written when a session transitions to `"running"` — before the session completes. Persisted index path precedence:
1. `OPENCLAW_CODE_AGENT_SESSIONS_PATH`
2. `$OPENCLAW_HOME/code-agent-sessions.json` (when `OPENCLAW_HOME` is set)
3. `~/.openclaw/code-agent-sessions.json`

After a plugin restart, sessions that were mid-flight appear as `"killed"` in `/agent_resume --list` and can be resumed by name or harness session ID. The correct harness and workdir are restored automatically.

### Example

```
agent_respond(
  session: "fix-auth-bug",
  message: "Yes, use the refresh token stored in httpOnly cookies"
)
```

### Interrupting and Redirecting

```
agent_respond(
  session: "fix-auth-bug",
  message: "Stop — don't modify the database schema. Only change the token logic.",
  interrupt: true
)
```

If the session is actively working, this emits a single redirect lifecycle notification:

```
↪️ [fix-auth-bug] Redirected
```

`interrupt: true` does not convert an intentional redirect into ❌ `Failed`, and it does not emit a fresh 🚀 `Launched` or ▶️ `Auto-resumed` notification. If the session is already between turns and not actively working, the message is sent normally and no redirect notification is emitted.

---

## agent_kill

Terminate a running coding agent session. Cannot kill sessions that are already in a terminal state (`completed`, `failed`, `killed`).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID to terminate |
| `reason` | enum | no | `killed` | `killed` terminates; `completed` marks as completed (sends completion lifecycle behavior) |

### Example

```
agent_kill(session: "fix-auth-bug")
```

---

## agent_output

Show recent output from a coding agent session. Read-only — does not affect session state.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID |
| `lines` | number | no | `50` | Number of recent lines to show |
| `full` | boolean | no | `false` | Show all available output (up to the 200-line buffer) |

For garbage-collected sessions, output is retrieved from the persisted `/tmp` file if available.

### Example

```
agent_output(session: "fix-auth-bug", lines: 100)
```

---

## agent_sessions

List coding agent sessions with their status and progress. By default, it shows only the 5 most recent sessions. Set `full: true` to show all sessions from the last 24 hours instead. When called by an agent with a workspace context, sessions are filtered to show only that agent's sessions (matched via `originChannel`).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | enum | no | `all` | Filter by status: `all`, `running`, `completed`, `failed`, `killed` |
| `full` | boolean | no | `false` | Show all sessions from the last 24h instead of just the most recent 5 |

### Example

```
agent_sessions(status: "running")
```

```
agent_sessions(full: true)
```

---

## agent_stats

Show OpenClaw Code Agent usage metrics: session counts by status, total cost, average duration, and the most expensive session.

### Parameters

*(none)*

### Example

```
agent_stats()
```

---

## agent_merge

Merge a worktree branch back to the base branch. Automatically handles conflicts by spawning a Claude Code conflict-resolver session.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID (must have a worktree) |
| `base_branch` | string | no | `main` | Base branch to merge into |
| `strategy` | enum | no | `merge` | `merge` (creates merge commit) or `squash` (squashes all commits) |
| `push` | boolean | no | `true` | Push the base branch after successful merge |
| `auto_cleanup` | boolean | no | `true` | Delete the agent branch after successful merge |

### Example

```
agent_merge(
  session: "fix-auth-bug",
  base_branch: "main",
  strategy: "merge",
  push: true,
  auto_cleanup: true
)
```

### Conflict Resolution

When merge conflicts are detected, `agent_merge` automatically spawns a new Claude Code session with `bypassPermissions` to resolve the conflicts. The conflict-resolver session receives a list of conflicted files and instructions to resolve and commit.

---

## agent_pr

Create or update a GitHub Pull Request for a worktree branch with full lifecycle management. Automatically handles:
- Creating new PRs when none exist
- Updating existing open PRs with new commits (adds detailed comment)
- Detecting merged PRs (notifies user)
- Detecting closed PRs (prompts user for action)

Requires the `gh` CLI to be installed and authenticated.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID (must have a worktree) |
| `title` | string | no | auto-generated | PR title (defaults to `[openclaw-code-agent] <session-name>`) |
| `body` | string | no | auto-generated | PR body with commit summary |
| `base_branch` | string | no | detected from repo | Base branch for the PR (auto-detected via git or `OPENCLAW_WORKTREE_BASE_BRANCH`) |
| `force_new` | boolean | no | `false` | Reject if a PR already exists (prevents accidental updates) |

### Example: Create new PR

```
agent_pr(
  session: "fix-auth-bug",
  title: "Fix authentication token refresh",
  base_branch: "main"
)
```

### Example: Update existing PR with new commits

```
agent_pr(session: "fix-auth-bug")
```

If the PR already exists and is open, this will push new commits and add a comment detailing the changes.

### PR Lifecycle States

- **No PR**: Creates a new PR
- **Open PR**: Pushes new commits and adds a detailed comment (commit list, diff stats)
- **Merged PR**: Notifies that the PR was already merged
- **Closed PR**: Prompts user to choose: reopen manually, delete branch, or recreate PR

The PR URL and number are persisted in session metadata for automatic lifecycle tracking.

---

## agent_worktree_status

Show the current status of worktree branches for coding agent sessions. Displays branch names, repository paths, merge-back strategy, commits ahead of base, merge status, and PR URLs.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | no | — | Session name or ID to show status for. If omitted, shows all sessions with worktrees |

### Example: Show all worktree sessions

```
agent_worktree_status()
```

### Example: Show specific session

```
agent_worktree_status(session: "fix-auth-bug")
```

### Output Format

```
Session: fix-auth-bug [abc123]
  Branch:   agent/fix-auth-bug → main
  Repo:     /home/user/my-project
  Strategy: auto-pr
  Commits:  3 ahead of main (+45 / -12)
  PR:       https://github.com/user/repo/pull/42
```

---

## agent_worktree_cleanup

List and clean up `agent/*` branches. Uses `git merge-base` to detect which branches have been fully merged into the base branch.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `workdir` | string | no | cwd | Working directory (git repository) |
| `base_branch` | string | no | `main` | Base branch to check merge status against |
| `force` | boolean | no | `false` | Delete ALL `agent/*` branches regardless of merge status |
| `dry_run` | boolean | no | `false` | Preview what would be deleted without actually deleting |

### Example

```
// Preview what would be deleted
agent_worktree_cleanup(
  workdir: "/home/user/my-project",
  dry_run: true
)

// Delete merged branches
agent_worktree_cleanup(workdir: "/home/user/my-project")

// Force delete all agent/* branches
agent_worktree_cleanup(
  workdir: "/home/user/my-project",
  force: true
)
```

---

## Session Lifecycle

```
agent_launch  ──►  STARTING  ──►  RUNNING  ──►  COMPLETED
                                     │
                                     ▼
                               agent_respond
                               agent_output
                                     │
                                     ▼
                               agent_kill  ──►  KILLED
                               (idle timeout)──► KILLED (auto-resumes on respond)
                               (turn done) ────► COMPLETED(reason=done, auto-resumes on respond)

                               (errors)    ──►  FAILED
```

- **STARTING** — Session is initializing (building SDK options, connecting)
- **RUNNING** — Session is active and accepting messages
- **COMPLETED** — Session finished successfully
- **FAILED** — Session errored out
- **KILLED** — Session was terminated (user or idle-timeout; paused sessions are auto-resumable without appearing as KILLED)

---

## Session Resolution

Most tools accept a `session` parameter that can be either a **session name** (e.g. `fix-auth-bug`) or a **session ID** (e.g. `a1b2c3d4`). The plugin resolves by ID first, then falls back to name matching.

For `agent_launch` with `resume_session_id`, the plugin additionally checks persisted sessions (sessions that have been garbage-collected from memory but whose metadata is still stored). It accepts internal IDs, session names, or harness UUIDs.

---

## Plugin Configuration

Settings in `openclaw.plugin.json` that affect tool and session behavior. See `docs/ARCHITECTURE.md` for full config list.

### `harnesses`

| Property | Value |
|----------|-------|
| Type | `object` |
| Default | `{"claude-code":{"defaultModel":"sonnet","allowedModels":["sonnet","opus"]},"codex":{"defaultModel":"gpt-5.4","allowedModels":["gpt-5.4"],"reasoningEffort":"medium","approvalPolicy":"on-request"}}` |

Per-harness launch defaults and restrictions.

- `harnesses.<name>.defaultModel` sets the model used when `agent_launch` omits `model`
- `harnesses.<name>.allowedModels` restricts which explicit or default models are accepted for that harness
- `harnesses.codex.reasoningEffort` controls Codex SDK reasoning effort
- `harnesses.codex.approvalPolicy` controls Codex SDK/CLI approval behavior

Example:

```json
{
  "harnesses": {
    "codex": {
      "defaultModel": "gpt-5.4",
      "allowedModels": ["gpt-5.4"],
      "reasoningEffort": "high",
      "approvalPolicy": "on-request"
    },
    "claude-code": {
      "defaultModel": "sonnet",
      "allowedModels": ["sonnet", "opus"]
    }
  }
}
```

### `planApproval`

| Property | Value |
|----------|-------|
| Type | enum: `ask`, `delegate`, `approve` |
| Default | `delegate` |

Controls orchestrator behavior when a coding agent submits a plan via `ExitPlanMode`:

- **`ask`** — Always forward the plan to the user for explicit approval. Orchestrator never auto-approves.
- **`delegate`** — Orchestrator decides autonomously: approve low-risk plans that match the original task scope, escalate high-risk, ambiguous, or scope-expanding plans to the user. When in doubt, escalates.
- **`approve`** — Orchestrator may auto-approve after verifying the working directory, codebase, and scope are correct. Can still escalate complex or risky plans to the user.

On approval, the session's permission mode switches from `plan` to `bypassPermissions`.
