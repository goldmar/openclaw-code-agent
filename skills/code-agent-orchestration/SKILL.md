---
name: Code Agent Orchestration
description: Skill for orchestrating coding agent sessions from OpenClaw. Covers launching, monitoring, multi-turn interaction, lifecycle management, notifications, and worktree decision rules.
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

Use `openclaw-code-agent` to run Claude Code or Codex sessions as background coding jobs from chat.

## 1. Launch Rules

- Do not pass `channel` manually. Routing comes from `agentChannels`, the current chat context, and `fallbackChannel`.
- Sessions are multi-turn. All sessions stay open for follow-up messages via `agent_respond`.
- Always set a short kebab-case `name` when you care about later follow-up.
- Set `workdir` to the target repo, not to the agent's own workspace.
- Default behavior is `permission_mode: "plan"` plus `planApproval: "ask"` plus `defaultWorktreeStrategy: "ask"`.

Example:

```text
agent_launch(
  prompt: "Fix the auth middleware bug and add tests",
  name: "fix-auth",
  workdir: "/home/user/projects/my-app"
)
```

Resume and fork:

```text
agent_launch(
  prompt: "Continue where you left off",
  resume_session_id: "fix-auth"
)

agent_launch(
  prompt: "Try a different approach",
  resume_session_id: "fix-auth",
  fork_session: true,
  name: "fix-auth-alt"
)
```

## 2. Anti-Cascade Rule

When you are woken because a session is waiting or completed, do not launch a new coding session in response. Only use the existing session with:

- `agent_output`
- `agent_respond`
- `agent_merge`
- `agent_pr`
- `agent_worktree_status`

## 3. Monitoring

Use:

```text
agent_sessions()
agent_sessions(status: "running")
agent_output(session: "fix-auth", lines: 100)
agent_output(session: "fix-auth", full: true)
```

Trust the latest output and current phase. Do not report an old planning state after the session has already moved into implementation.

## 4. Respond Rules

Auto-respond immediately only for:

- permission requests for file reads, writes, or shell commands
- explicit continuation prompts such as "Should I continue?"

Forward everything else to the user:

- architecture or design choices
- destructive operations
- scope changes
- credentials or production questions
- ambiguous requirements
- anything you are not certain you should answer autonomously

When forwarding, quote the session's exact question. Do not add your own commentary.

Examples:

```text
agent_respond(session: "fix-auth", message: "Yes, proceed.")

agent_respond(
  session: "fix-auth",
  message: "Stop. Do not touch the database schema.",
  interrupt: true
)
```

## 5. Plan Approval

Approve a pending plan with:

```text
agent_respond(
  session: "fix-auth",
  message: "Approved. Go ahead.",
  approve: true,
  userInitiated: true
)
```

Rules:

- `approve: true` approves a pending plan or escalates a `default` mode session into `bypassPermissions`.
- Do not send approval and revision feedback in the same call.
- In `planApproval: "ask"`, the user is expected to approve or revise. Wait for that input.
- Telegram users may get inline `Approve`, `Reject`, and `Revise` buttons for plan review.

## 6. Worktree Decision Rules

### `ask`

Do nothing after completion. The plugin already informed the user and attached `Merge locally` / `Create PR` buttons. Do not call `agent_merge` or `agent_pr` unless the user explicitly asks after that.

### `delegate`

Read the diff context from the wake, then decide:

- `agent_merge` for low-risk, clearly scoped changes that match the task
- `agent_pr` when review is safer or the change is non-trivial
- escalate to the user if scope or risk is unclear

### `manual`

Wait for an explicit user request before calling `agent_merge` or `agent_pr`.

### Never

- never use raw `git merge` or raw PR commands in place of the plugin tools
- never clear a pending worktree decision by inventing your own workaround; use `agent_worktree_cleanup(session: "...")` if the user wants to dismiss it

## 7. Lifecycle Notes

- `agent_respond` auto-resumes paused, idle-killed, and most other terminal sessions.
- The only common non-resumable path is `startup-timeout`.
- Terminal runtime sessions are evicted after `sessionGcAgeMinutes` (default 1440 minutes), but persisted metadata remains resumable.
- `agent_stats` is the quick operator view for aggregate cost and duration.

## 8. Chat Commands

Common command equivalents:

```text
/agent --name fix-auth Fix the auth middleware bug
/agent_sessions
/agent_output fix-auth
/agent_respond fix-auth Add tests too
/agent_kill fix-auth
/agent_resume --fork fix-auth Try a different approach
/agent_stats
```

## 9. Anti-Patterns

- Do not pass a `multi_turn` or `multi_turn_disabled` parameter; all sessions are multi-turn and the parameter no longer exists.
- Do not pass `channel` manually unless you are debugging routing at a very low level.
- Do not auto-answer design or scope questions.
- Do not launch new sessions from wake events.
- Do not merge or PR an `ask` worktree behind the user's back.

See `README.md` for the product overview and `docs/REFERENCE.md` for the canonical operator reference.
