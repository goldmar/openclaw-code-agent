# Tools Reference

All tools provided by the OpenClaw Code Agent. Each tool is exposed to agents via the OpenClaw tool system.

> **Source of truth:** `src/tools/`

---

## Tool Summary

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `agent_launch` | Launch a coding agent session | `prompt`, `workdir`, `name`, `model`, `resume_session_id` |
| `agent_respond` | Send follow-up message to a running session | `session`, `message`, `interrupt`, `userInitiated`, `approve` |
| `agent_kill` | Terminate a session | `session` |
| `agent_output` | Show session output (read-only) | `session`, `lines`, `full` |
| `agent_sessions` | List recent sessions (5 by default, `full` for 24h view) | `status`, `full` |
| `agent_stats` | Show usage metrics | *(none)* |

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
| `permission_mode` | enum | no | plugin config (`plan` by default) | One of: `default`, `plan`, `acceptEdits`, `bypassPermissions` |
| `harness` | string | no | plugin `defaultHarness` (`claude-code`) | Harness backend. Built-ins: `claude-code`, `codex` |

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

- Claude Code harness: passes `default` / `plan` / `acceptEdits` / `bypassPermissions` through SDK permissions.
- Codex harness:
  - Always uses SDK thread option `sandboxMode: "danger-full-access"` and defaults to `approvalPolicy: "on-request"` unless `harnesses.codex.approvalPolicy` sets `"never"`
  - In `bypassPermissions`, adds filesystem root plus `OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS` entries to SDK `additionalDirectories`
  - `plan` / `acceptEdits` are orchestration behaviors (plan approval flow), not SDK sandbox restrictions
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
