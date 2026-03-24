---
name: Code Agent Orchestration
description: Skill for orchestrating coding agent sessions from OpenClaw. Covers launching, monitoring, multi-turn interaction, lifecycle management, notifications, and parallel work patterns.
metadata:
  openclaw:
    homepage: https://github.com/goldmar/openclaw-code-agent
    requires:
      bins:
        - openclaw
    install:
      - kind: node
        package: openclaw-code-agent
        bins: []
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
| `model` | When you want to force a specific model (`"sonnet"`, `"opus"`, `"gpt-5.4"`). Subject to `harnesses.<name>.allowedModels` restrictions if configured. |
| `system_prompt` | To inject project-specific context. |
| `permission_mode` | `"plan"` by default. `"bypassPermissions"` for trusted tasks. |

### Harness-scoped model restrictions

The plugin config restricts models per harness via `harnesses.<name>.allowedModels`:

- **Matching:** Case-insensitive substring matching (e.g., `"sonnet"` matches `"claude-sonnet-4-6"`)
- **Explicit model blocked:** If a caller explicitly requests a model not in that harness's `allowedModels`, the launch fails with an error
- **Default model blocked:** If no model is specified and the resolved `harnesses.<name>.defaultModel` is not in `allowedModels`, the launch fails with a config error
- **Not configured:** If `allowedModels` is empty or undefined for that harness, all models are allowed for that harness

**Example configuration:**
```json
{
  "harnesses": {
    "claude-code": {
      "defaultModel": "sonnet",
      "allowedModels": ["sonnet", "haiku"]
    },
    "codex": {
      "defaultModel": "gpt-5.4",
      "allowedModels": ["gpt-5.4"]
    }
  }
}
```

This configuration allows Claude models containing "sonnet" or "haiku" in their identifier, and restricts Codex launches to `gpt-5.4`.

**Interaction with harness compatibility:**
When both `harnesses.<name>.allowedModels` and harness compatibility constraints apply, you must satisfy BOTH:
1. The model must be in `harnesses.<name>.allowedModels` (if configured)
2. The model must be compatible with the chosen harness

Example: If `harnesses.claude-code.allowedModels = ["sonnet", "gpt-4"]` and you use the default `claude-code` harness, only "sonnet" will work because "gpt-4" is not a Claude-compatible model.

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

### Harness and model compatibility

| Harness | Supported Models | Examples |
|---------|-----------------|---------|
| `claude-code` | Anthropic only | `sonnet`, `opus`, `haiku`, `claude-sonnet-4-6` |
| `codex` | OpenAI only | `gpt-4`, `gpt-5`, `o1`, `o3-mini` |

- When user says "with sonnet/opus/haiku" → use `harness: "claude-code"` (or omit — it's the default)
- When user says "with gpt-4/o1/o3" → use `harness: "codex"`
- **Never** pass Anthropic models to codex harness or OpenAI models to claude-code harness

If `harnesses.<name>.allowedModels` is configured, both explicit model requests and default models outside that list are rejected with an error. When the default model is not allowed, the error message directs you to update the plugin config.

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

# Full output (up to 2000 lines)
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

- After a turn completes without a question, the session is immediately **paused** (killed with reason `done`, auto-resumable).
- On the next `agent_respond` to a completed or idle-killed session, the plugin **auto-resumes** by spawning a new session with the same session ID — conversation context is preserved.
- Sessions idle for `idleTimeoutMinutes` (default: 15 min) are killed with reason `idle-timeout` and also auto-resume on next respond.
- Sessions killed for any reason except `startup-timeout` auto-resume on next `agent_respond`. This includes user-killed sessions (`agent_kill`), shutdown-killed sessions (gateway restart), and idle-timeout sessions.

### Timeouts

- Idle multi-turn sessions are automatically killed after `idleTimeoutMinutes` (default: 15 min)
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
| Session completed | `✅ Completed` — brief one-liner to originating thread |
| Session completed (deliverable mode) | `📄 Deliverable ready` — when launched with `output_mode: "deliverable"` |
| Session failed | `❌ Failed` — error notification with `harnessSessionId` and resume guidance |
| Waiting for input | `❓ Waiting for input` — wake event (only when the agent actually asks a question) |
| Turn completes without a question | `⏸️ Paused after turn \| Auto-resumable` |
| `agent_respond` send | `↪️` — notification sent for every `agent_respond` call |
| `agent_respond` plan approval | `👍` — notification sent when `approve: true` |
| Session auto-resumes | `▶️ Auto-resumed` |
| Session idle-times out | `💤 Idle timeout` |
| Session is forcibly stopped | `⛔ Stopped ...` with the specific stop reason |
| Worktree decision pending (`ask`) | Inline Telegram buttons sent to user (Merge locally / Create PR / Dismiss) — Alice must NOT preempt |
| Worktree decision pending (`delegate`) | Wake sent to Alice with diff context — Alice must decide and call `agent_merge` or `agent_pr` |

### Sending completion summaries — use `message send`, not inline reply

When you process a CC session completion wake and want to notify the user with a summary, **always send the summary via the `message` tool** rather than as an inline session reply:

```bash
# Correct — standalone message, guaranteed notification ping
openclaw message send --channel telegram --target <chatId> --thread-id <topicId> \
  --message "✅ [session-name] Done — <one-line summary>"
```

**Why this matters**: Alice's inline session replies are sent as Telegram *replies* (`reply_to_message_id`) to the message that triggered the wake. Because the plugin's ⏸️ status notification typically arrives just before the wake fires, Alice's reply targets that bot message — and Telegram does not re-ping the user when a bot replies to a recent bot message in an already-active topic thread. The `message` tool sends a standalone new message (`message_thread_id` only, no `reply_to_message_id`), which always generates a fresh notification ping.

**Rule**: Inline replies are fine for conversational back-and-forth. For any user-facing "session done" notification that must reliably reach the user, use `message send` explicitly.

The Telegram chat ID and topic thread ID are available from the current conversation context.

---

### Plan → Execute mode switch

Sessions start in `plan` mode by default. When you reply with **only** an approval keyword as the **entire message** (`"go ahead"`, `"implement"`, `"looks good"`, `"approved"`, `"lgtm"`, `"do it"`, `"proceed"`, `"execute"`, `"ship it"`), the plugin switches the session to `bypassPermissions` mode. The message must contain **only** the keyword — extra text will prevent the switch. To approve and also give instructions, send the approval keyword first, then send implementation details as a separate follow-up message.

### Permission escalation with `approve: true`

The `approve` parameter on `agent_respond` escalates session permissions to `bypassPermissions`. It works in two scenarios:

1. **Plan mode approval**: When a session has a pending plan approval (after `ExitPlanMode` / `set_permission_mode`), `approve: true` approves the plan and switches to `bypassPermissions`. Sends a 👍 notification.
2. **`default` mode escalation**: When a session in `default` mode keeps prompting for shell/exec command permissions, `approve: true` escalates to `bypassPermissions` to skip all remaining prompts.

If the session is already in `bypassPermissions` mode, `approve: true` is a no-op. In `plan` mode without a pending plan, it is ignored.

```
# Escalate a session that keeps prompting for bash permissions
agent_respond(session: "fix-auth", message: "proceed", approve: true)
```

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

## 7. Worktree workflow

When a session uses `worktree_strategy`, the agent runs in an isolated git branch. After completion, the branch needs to be merged or published as a PR.

### Strategies at a glance

| Strategy | What it does | When to use |
|---|---|---|
| `off` (default) | No worktree. Session runs in main checkout | Simple/trusted tasks |
| `manual` | Creates worktree; no auto action | You want to review diffs before merging |
| `ask` | Sends Telegram inline buttons (Merge locally / Create PR / Dismiss) | User should decide |
| `auto-merge` | Merges automatically; spawns conflict-resolver if needed | Trusted tasks on a safe branch |
| `auto-pr` | Creates/updates GitHub PR automatically (requires `gh`) | Feature branches needing review |
| `delegate` | Wakes orchestrator with diff context; Alice decides merge/PR/escalate | Set via `defaultWorktreeStrategy` config — orchestrator decides autonomously |

### Launch with worktree isolation

```
agent_launch(
  prompt: "Implement the new user settings page",
  name: "user-settings",
  workdir: "/app",
  worktree_strategy: "auto-pr"
)
```

### Post-completion behavior by strategy

When a session with a worktree completes, your action depends on the strategy:

| Strategy | What to do after completion |
|---|---|
| `ask` | **Do nothing.** The plugin sends inline Telegram buttons (Merge locally / Create PR / Dismiss) to the user. **Never** call `agent_merge`, `agent_pr`, or any `git` command — wait for the user to decide. |
| `delegate` | You receive a `worktree-delegate` wake with diff context. Evaluate and act (see *Delegate mode* below). |
| `auto-merge` | No action needed — merge happens automatically. Watch for `worktree-merge-success` or `worktree-merge-conflict` notification. |
| `auto-pr` | No action needed — PR is created/updated automatically. |
| `manual` | Call `agent_merge` or `agent_pr` **only** when the user explicitly asks. |
| `off` | No worktree — nothing to merge. |

Note: the ⏸️ turn-complete wake is suppressed for both `ask` and `delegate` strategies — the worktree decision notification replaces it as the completion signal.

### Delegate mode: deciding merge vs PR

When you receive a `worktree-delegate` wake:

1. **Evaluate the diff** — read the commit count, files changed, and diff summary included in the wake message
2. **Compare to original task scope** — does the diff match what was asked?
3. **Decide:**
   - **Call `agent_merge`** when: changes are low-risk, well-scoped, match the original task, and no code review is needed
   - **Call `agent_pr`** when: changes are non-trivial, touch many files, introduce significant complexity, or when uncertain
   - **Escalate to the user** when: changes are ambiguous, out of scope, or involve sensitive areas
4. **Notify the user briefly** — send a short message with your decision and one-sentence reasoning (e.g. "Merged `agent/feature-x` — straightforward 2-file change matching the original task.")
5. **Never use raw `git` commands** — always use `agent_merge` or `agent_pr`

### Check worktree status

```
agent_worktree_status()                      # all sessions with worktrees
agent_worktree_status(session: "user-settings")  # specific session
```

### Manual merge or PR after `manual`/`ask`

```
# Merge back to base branch
agent_merge(session: "user-settings", strategy: "merge")

# Or create/update a GitHub PR
agent_pr(session: "user-settings", title: "Add user settings page")
```

### Resume with worktree context

When resuming a session that had a worktree, the worktree context (branch, strategy, PR URL) is inherited automatically — no need to pass `worktree_strategy` again:

```
agent_launch(
  prompt: "Continue — also add unit tests",
  resume_session_id: "user-settings"
)
```

### Deliverable mode

For document/report generation tasks, use `output_mode: "deliverable"` to send 📄 instead of ✅:

```
agent_launch(
  prompt: "Write a technical spec for the new auth system",
  name: "auth-spec",
  output_mode: "deliverable"
)
```

---

## 8. Best practices

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

## 9. Anti-patterns

| Anti-pattern | Consequence | Fix |
|---|---|---|
| Launching new sessions from wake events | Cascading sessions | Only use `agent_respond`/`agent_output` when woken |
| Adding commentary when forwarding questions | User gets noise, not the question | Quote the agent's exact question, nothing else |
| Auto-responding to design/architecture questions | Decisions made without user input | Only auto-respond to permissions and explicit confirmations |
| Passing `channel` explicitly | Bypasses automatic routing | Let `agentChannels` handle routing automatically |
| Not checking the result of a completed session | User doesn't know what happened | Always read `agent_output` and summarize briefly |
| Launching too many sessions in parallel | `maxSessions` limit reached | Respect the limit, prioritize, sequence if necessary |
| Calling `agent_merge` or `agent_pr` when strategy is `ask` | Bypasses the user's inline-button decision | Wait for the Telegram buttons — do nothing until the user decides |
| Using raw `git merge` instead of `agent_merge` | Skips conflict resolution, cleanup, and session state tracking | Always use `agent_merge` when the user asks to merge a worktree branch |

---

## 10. Quick tool reference

| Tool | Usage | Key parameters |
|---|---|---|
| `agent_launch` | Launch a session | `prompt`, `name`, `workdir`, `multi_turn`, `worktree_strategy`, `output_mode` |
| `agent_sessions` | List sessions | `status` (all/running/completed/failed/killed) |
| `agent_output` | Read the output | `session`, `full`, `lines` |
| `agent_kill` | Kill or complete a session | `session`, `reason` (`"completed"` or omit) |
| `agent_respond` | Send a follow-up | `session`, `message`, `interrupt`, `approve` |
| `agent_stats` | Usage metrics | none |
| `agent_worktree_status` | Show worktree status for sessions | `session` (optional — omit for all) |
| `agent_merge` | Merge worktree branch to base | `session`, `base_branch`, `strategy`, `push`, `delete_branch` |
| `agent_pr` | Create/update GitHub PR for worktree branch | `session`, `title`, `body`, `base_branch`, `force_new` |
| `agent_worktree_cleanup` | Clean up merged agent/* branches | `workdir`, `base_branch`, `skip_session_check`, `dry_run`, `session` |
