# Tools Reference

All tools provided by the OpenClaw Code Agent. Each tool is exposed to agents via the OpenClaw tool system.

> **Source of truth:** `src/tools/`

---

## Tool Summary

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `agent_launch` | Launch a coding agent session | `prompt`, `workdir`, `name`, `model`, `resume_session_id` |
| `agent_respond` | Send follow-up message to a running session | `session`, `message`, `interrupt`, `userInitiated` |
| `agent_kill` | Terminate a session | `session` |
| `agent_output` | Show session output (read-only) | `session`, `lines`, `full` |
| `agent_sessions` | List all sessions | `status` |
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
| `model` | string | no | plugin default | Model name to use |
| `system_prompt` | string | no | — | Additional system prompt injected into the session |
| `allowed_tools` | string[] | no | — | List of allowed tools for the coding agent session |
| `resume_session_id` | string | no | — | Session ID to resume (from a previous session's `harnessSessionId`). Accepts name, internal ID, or harness UUID — the plugin resolves it |
| `fork_session` | boolean | no | `false` | When resuming, fork to a new session instead of continuing the existing one. Use with `resume_session_id` |
| `multi_turn_disabled` | boolean | no | `false` | Disable multi-turn mode. Set to `true` for fire-and-forget sessions that don't accept follow-ups |
| `permission_mode` | enum | no | plugin config / `bypassPermissions` | One of: `default`, `plan`, `acceptEdits`, `bypassPermissions` |

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

Send a follow-up message to a running multi-turn coding agent session. If the session was idle-killed (post-turn-idle or idle-timeout), the plugin auto-resumes it with conversation context preserved.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID |
| `message` | string | **yes** | — | The message to send |
| `interrupt` | boolean | no | `false` | Interrupt the current turn before sending. Useful to redirect the session mid-response |
| `userInitiated` | boolean | no | `false` | Set to `true` when the message comes from the user (not auto-generated). Resets the auto-respond counter |

### Auto-Respond Safety Cap

The plugin tracks how many times an agent auto-responds to a session. When the counter reaches `maxAutoResponds` (default: 10), further agent-initiated responds are blocked. This prevents infinite agent-session loops.

- **Agent responds** increment the counter
- **User-initiated responds** (`userInitiated: true`) reset the counter to 0
- When blocked, the agent is instructed to ask the user for input

### Auto-Resume

When responding to a session that was killed due to idle timeout (`idle-timeout` or `post-turn-idle`), the plugin automatically spawns a new session with the same harness session ID, preserving conversation context. Sessions killed explicitly by the user (`agent_kill`) do NOT auto-resume.

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

---

## agent_kill

Terminate a running coding agent session. Cannot kill sessions that are already in a terminal state (`completed`, `failed`, `killed`).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | **yes** | — | Session name or ID to terminate |

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

List all coding agent sessions with their status and progress. When called by an agent with a workspace context, sessions are filtered to show only that agent's sessions (matched via `originChannel`).

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | enum | no | `all` | Filter by status: `all`, `running`, `completed`, `failed`, `killed` |

### Example

```
agent_sessions(status: "running")
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

                               (errors)    ──►  FAILED
```

- **STARTING** — Session is initializing (building SDK options, connecting)
- **RUNNING** — Session is active and accepting messages
- **COMPLETED** — Session finished successfully
- **FAILED** — Session errored out
- **KILLED** — Session was terminated (user, idle-timeout, or post-turn-idle)

---

## Session Resolution

Most tools accept a `session` parameter that can be either a **session name** (e.g. `fix-auth-bug`) or a **session ID** (e.g. `a1b2c3d4`). The plugin resolves by ID first, then falls back to name matching.

For `agent_launch` with `resume_session_id`, the plugin additionally checks persisted sessions (sessions that have been garbage-collected from memory but whose metadata is still stored). It accepts internal IDs, session names, or harness UUIDs.

---

## Plugin Configuration

Settings in `openclaw.plugin.json` that affect tool and session behavior. See `docs/ARCHITECTURE.md` for full config list.

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
