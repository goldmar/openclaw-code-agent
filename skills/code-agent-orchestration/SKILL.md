---
name: Code Agent Orchestration
description: Skill for orchestrating coding agent sessions from OpenClaw. Covers launching, monitoring, multi-turn interaction, lifecycle management, notifications, and parallel work patterns.
metadata: {"openclaw": {"requires": {"plugins": ["openclaw-code-agent"]}}}
---

# Code Agent Orchestration

You orchestrate coding agent sessions via the `openclaw-code-agent`. Each session is an autonomous agent that executes code tasks in the background.

---

## 1. Launching sessions

### Mandatory rules

- **Notifications are routed automatically** via `agentChannels` config. Do NOT pass `channel` manually — it bypasses automatic routing.
- **Thread-aware routing**: When launched from a Telegram thread/topic, notifications are routed back to that same thread via `originThreadId`. This is handled automatically.
- **Always pass `multi_turn: true`** unless the task is a guaranteed one-shot with no possible follow-up.
- **Name the sessions** with `name` in kebab-case, short and descriptive.
- **Set `workdir`** to the target project directory, not the agent's workspace.
- **Default mode is `plan`**: Sessions start in plan mode. When the user approves a plan (e.g. "looks good", "go ahead"), the plugin automatically switches to `bypassPermissions` mode.

### Essential parameters

| Parameter | When to use |
|---|---|
| `prompt` | Always. Clear and complete instruction. |
| `name` | Always. Descriptive kebab-case (`fix-auth-bug`, `add-dark-mode`). |
| `channel` | **Do NOT pass.** Resolved automatically via `agentChannels`. |
| `workdir` | Always when the project is not in the `defaultWorkdir`. |
| `multi_turn` | `true` by default unless explicitly one-shot. |
| `model` | When you want to force a specific model (`"sonnet"`, `"opus"`). |
| `system_prompt` | To inject project-specific context. |
| `permission_mode` | `"plan"` by default. `"bypassPermissions"` for trusted tasks. |

### Examples

```
# Simple task
agent_launch(
  prompt: "Fix the null pointer in src/auth.ts line 42",
  name: "fix-null-auth",
  workdir: "/home/user/projects/myapp",
  multi_turn: true
)

# Full feature
agent_launch(
  prompt: "Implement dark mode toggle in the settings page. Use the existing theme context in src/context/theme.tsx. Add a toggle switch component and persist the preference in localStorage.",
  name: "add-dark-mode",
  workdir: "/home/user/projects/myapp",
  multi_turn: true
)
```

### Resume and fork

```
# Resume a completed session
agent_launch(
  prompt: "Continue. Also add error handling for the edge cases we discussed.",
  resume_session_id: "fix-null-auth",
  multi_turn: true
)

# Fork to try an alternative approach
agent_launch(
  prompt: "Try a completely different approach: use middleware instead of decorators.",
  resume_session_id: "refactor-db-repositories",
  fork_session: true,
  name: "refactor-db-middleware-approach",
  multi_turn: true
)
```

---

## 2. Anti-cascade rules (CRITICAL)

**When woken by a waiting-for-input or completion event, you MUST ONLY use `agent_respond` or `agent_output` for the referenced session. NEVER launch new sessions in response to wake events.**

This prevents cascading session creation. The orchestrator exists to manage existing sessions, not to spawn new ones from wake events.

---

## 3. Monitoring sessions

### List sessions

```
# All sessions
agent_sessions()

# Only running sessions
agent_sessions(status: "running")

# Completed sessions (for resume)
agent_sessions(status: "completed")
```

### View output

```
# Summary (last 50 lines)
agent_output(session: "fix-null-auth")

# Full output (up to 200 blocks)
agent_output(session: "fix-null-auth", full: true)

# Specific last N lines
agent_output(session: "fix-null-auth", lines: 100)
```

### Interpreting session state

The `agent_output` header shows status, phase, cost, and duration:
```
Session: fix-auth [abc123] | Status: RUNNING | Phase: planning | Cost: $0.0312 | Duration: 2m15s
```

The `Phase:` indicator for running sessions:
- `Phase: planning` — the agent is writing a plan
- `Phase: awaiting-plan-approval` — plan submitted, waiting for review
- `Phase: implementing` — actively writing code

The `agent_sessions` listing also shows phase and cost when available:
```
🟢 fix-auth [abc123] (2m15s | $0.03) — multi-turn
   ⚙️  Phase: planning
```

**Recency rule:** Always trust the Phase indicator and the *latest* (bottom) output lines. If earlier output mentions plan mode but Phase says `implementing`, the session has transitioned. Do NOT report it as "waiting for approval."

---

## 4. Multi-turn interaction

### Send a follow-up

```
# Reply to an agent question
agent_respond(session: "add-dark-mode", message: "Yes, use CSS variables for the theme colors.")

# Redirect a running session (interrupts the current turn)
agent_respond(session: "add-dark-mode", message: "Stop. Use Tailwind dark: classes instead of CSS variables.", interrupt: true)
```

### Auto-respond rules (STRICT)

**Auto-respond immediately with `agent_respond`:**
- Permission requests to read/write files or run bash commands -> `"Yes, proceed."`
- Explicit confirmations like "Should I continue?" -> `"Yes, continue."`

**Forward to the user (everything else):**
- Architecture decisions (Redis vs PostgreSQL, REST vs GraphQL...)
- Destructive operations (deleting files, dropping tables...)
- Ambiguous requirements not covered by the initial prompt
- Scope changes ("This will require refactoring 15 files")
- Anything involving credentials, secrets, or production environments
- Questions about approach, design, or implementation choices
- Codebase clarification questions
- When in doubt -> always forward to the user

**When forwarding to the user, quote the agent's exact question. Do NOT add your own analysis, interpretation, or commentary.**

### Interaction cycle

1. Session launches -> runs in background
2. Wake event arrives when the session is waiting for input
3. Read the question with `agent_output(session, full: true)`
4. Decide: auto-respond (permissions/confirmations only) or forward
5. If auto-respond: `agent_respond(session, answer)`
6. If forward: relay the agent's exact question to the user, wait for their response, then `agent_respond`

---

## 5. Lifecycle management

### Stop or complete a session

```
# Kill a stuck/looping session
agent_kill(session: "fix-null-auth")

# Mark a session as successfully completed
agent_kill(session: "fix-null-auth", reason: "completed")
```

Use `agent_kill` (no reason) when:
- The session is stuck or looping
- The user requests a stop

Use `agent_kill(reason: "completed")` when:
- The turn output shows the task is done — this sends a `✅ Completed` notification
- Prefer this over letting the idle timer expire

### Idle completion and auto-resume

- After a turn completes without a question, a **post-turn idle timer** starts (default: 5 min). If no follow-up arrives, the session transitions to **completed** (not killed).
- On the next `agent_respond` to a completed or idle-killed session, the plugin **auto-resumes** by spawning a new session with the same session ID — conversation context is preserved.
- Sessions idle for `idleTimeoutMinutes` (default: 30 min) are killed with reason `idle-timeout` and also auto-resume on next respond.
- Sessions killed explicitly by the user (`agent_kill` without `reason: "completed"`) do NOT auto-resume.

### Timeouts

- Idle multi-turn sessions are automatically killed after `idleTimeoutMinutes` (default: 30 min)
- Completed sessions are garbage-collected after 1h but remain resumable via persisted IDs

### Check the result after completion

When a session completes (completion wake event):

1. `agent_output(session: "xxx", full: true)` to read the result
2. Summarize briefly: files changed, cost, duration, any issues
3. If failed, analyze the error and decide: relaunch, fork, or escalate

---

## 6. Notifications

### Thread-based routing

Notifications are routed to the Telegram thread/topic where the session was launched. This is handled automatically via `originThreadId` — no manual configuration needed. The `agentChannels` config handles chat-level routing, and the thread ID handles within-chat routing.

### Events

| Event | What happens |
|---|---|
| Session starts | Silent (command response confirms launch) |
| Session completed | Brief one-liner to originating thread |
| Session failed | Error notification to originating thread |
| Waiting for input | Wake event + "Agent asks" in thread (only when the agent actually asks a question) |
| Session idle-killed | Brief notification with kill reason |

### Plan → Execute mode switch

Sessions start in `plan` mode by default. When you reply with **only** an approval keyword as the **entire message** (`"go ahead"`, `"implement"`, `"looks good"`, `"approved"`, `"lgtm"`, `"do it"`, `"proceed"`, `"execute"`, `"ship it"`), the plugin switches the session to `bypassPermissions` mode. The message must contain **only** the keyword — extra text will prevent the switch. To approve and also give instructions, send the approval keyword first, then send implementation details as a separate follow-up message.

### Plan approval modes

The `planApproval` config controls how the orchestrator handles plan-approval events:

- **`delegate`** (default): The orchestrator autonomously decides whether to approve or escalate each plan to the user. Approve when the plan is low-risk, well-scoped, and matches the original task. Escalate when the plan involves destructive operations, credentials/production, architectural decisions, scope expansion, or ambiguous requirements. When in doubt, always escalate.
- **`approve`**: The orchestrator can auto-approve straightforward, low-risk plans. Before approving, it verifies the working directory, codebase, and scope.
- **`ask`**: The orchestrator always forwards plans to the user. It never auto-approves on the user's behalf.

#### Delegate mode decision criteria

When operating in `delegate` mode, **approve** the plan directly if ALL of the following are true:
- The plan scope matches the original task request
- The changes are low-risk (no destructive operations, no credential handling, no production deployments)
- The plan is clear and well-scoped (no ambiguous requirements or open design questions)
- No architectural decisions that the user should weigh in on
- The working directory and codebase are correct

**Escalate** to the user (forward with 👋 and wait) if ANY of the following are true:
- Destructive operations (deleting files, dropping tables, force-pushing)
- Credentials, secrets, or production environments
- Architectural decisions not covered by the original task
- Scope expanded beyond the original request
- Ambiguous requirements or assumptions the user should confirm
- When in doubt — always escalate

---

## 7. Best practices

### Launch checklist

1. `agentChannels` is configured for this workdir -> notifications arrive
2. `multi_turn: true` -> interaction is possible after launch
3. `name` is descriptive -> easy to identify in `agent_sessions`
4. `workdir` points to the correct project -> the agent works in the right directory

### Parallel tasks

```
# Launch multiple sessions on independent tasks
agent_launch(prompt: "Build the frontend auth page", name: "frontend-auth", workdir: "/app/frontend", multi_turn: true)
agent_launch(prompt: "Build the backend auth API", name: "backend-auth", workdir: "/app/backend", multi_turn: true)
```

- Respect the `maxSessions` limit (default: 5)
- Each session must have a unique `name`
- Monitor each session individually via wake events

### Reporting results

When a session completes, keep summaries brief:
- Files changed
- Cost and duration
- Any issues or remaining TODOs

---

## 8. Anti-patterns

| Anti-pattern | Consequence | Fix |
|---|---|---|
| Launching new sessions from wake events | Cascading sessions | Only use `agent_respond`/`agent_output` when woken |
| Adding commentary when forwarding questions | User gets noise, not the question | Quote the agent's exact question, nothing else |
| Auto-responding to design/architecture questions | Decisions made without user input | Only auto-respond to permissions and explicit confirmations |
| Passing `channel` explicitly | Bypasses automatic routing | Let `agentChannels` handle routing automatically |
| Not checking the result of a completed session | User doesn't know what happened | Always read `agent_output` and summarize briefly |
| Launching too many sessions in parallel | `maxSessions` limit reached | Respect the limit, prioritize, sequence if necessary |

---

## 9. Quick tool reference

| Tool | Usage | Key parameters |
|---|---|---|
| `agent_launch` | Launch a session | `prompt`, `name`, `workdir`, `multi_turn` |
| `agent_sessions` | List sessions | `status` (all/running/completed/failed/killed) |
| `agent_output` | Read the output | `session`, `full`, `lines` |
| `agent_kill` | Kill or complete a session | `session`, `reason` (`"completed"` or omit) |
| `agent_respond` | Send a follow-up | `session`, `message`, `interrupt` |
| `agent_stats` | Usage metrics | none |
