---
name: Code Agent Orchestration
description: Skill for orchestrating coding agent sessions from OpenClaw. Covers launching, monitoring, plan approval, lifecycle management, and worktree decisions.
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

## Launch

- Do not pass `channel` manually. Routing comes from `agentChannels`, the current chat context, and `fallbackChannel`.
- Sessions are multi-turn. Continue existing work with `agent_respond` or `agent_launch(..., resume_session_id=...)`; do not start a fresh session for the same task.
- Always set a short kebab-case `name` when you care about later follow-up.
- Set `workdir` to the target repo.
- Use `permission_mode: "plan"` when the user wants a real review gate before implementation.
- Use `permission_mode: "bypassPermissions"` only for autonomous execution.
- `defaultWorktreeStrategy` now defaults to `off`. Opt into a worktree strategy explicitly when you want branch isolation.
- In `plan` mode, the plan belongs in normal session output. Do not ask the coding agent to write plan docs or transcript artifacts unless the user explicitly asked for a file.

Example:

```text
agent_launch(
  prompt: "Fix the auth middleware bug and add tests",
  name: "fix-auth",
  workdir: "/home/user/projects/my-app"
)
```

## Resume, Don't Respawn

When a session already exists for the task, keep using it.

- Waiting for plan approval: `agent_respond(session, message, approve=true)` or `agent_request_plan_approval(...)` if delegated approval must escalate to the user
- Waiting for a question answer: `agent_respond(session, message)`
- Killed/stopped by restart: `agent_respond(session, message)`
- Completed but needs follow-up: `agent_launch(resume_session_id=session_id, prompt="...")`
- Fresh `agent_launch` is only for genuinely independent work

Do not launch a new coding session from a wake event for the same task.

## State and Monitoring

Use:

```text
agent_sessions()
agent_output(session: "fix-auth", lines: 100)
agent_output(session: "fix-auth", full: true)
```

For worktree follow-through, inspect:

```text
agent_worktree_status()
agent_worktree_status(session: "fix-auth")
```

Treat that tool's lifecycle, derived state, cleanup disposition, and retained reasons as authoritative. Do not infer cleanup safety from a transcript summary or from branch names alone.

Treat these wake fields as authoritative state when present:

- `requestedPermissionMode`
- `effectivePermissionMode` / `currentPermissionMode`
- `approvalExecutionState`

Use those deterministic fields instead of inferring behavior from transcript fragments.

Approval/execution meanings:

- `approved_then_implemented`: normal approved execution
- `implemented_without_required_approval`: actual approval bypass
- `awaiting_approval`: still stopped at the approval gate
- `not_plan_gated`: no plan gate applied

Completion ownership:

- The plugin sends the canonical completion notification.
- The plugin owns the canonical completion status line; the orchestrator owns any additional plain-text follow-up.
- After a coding-agent session completes, the orchestrator should usually add at least a short human-useful summary of what changed, what was done, or the concrete outcome.
- That expectation applies to ordinary terminal/manual completions, manual no-change completions, and delegated worktree completions alike.
- Treat the plugin's canonical `✅` as the status signal and your follow-up as the factual outcome summary that should usually come right after it.
- That summary can be brief; one sentence is often enough.
- Extra synthesis, risk framing, and next-step guidance are optional. Add them when useful; do not force them every time.
- Do not generate your own heuristic completion summary from transcript tail lines. Base any summary on reliable result data such as `agent_output(..., full=true)`, diff context, or deterministic tool state.
- Skip the summary only in narrow cases:
  - no user-facing follow-up will be sent at all because the orchestrator is silently continuing an internal multi-phase pipeline
  - the completion produced no meaningful outcome to report, or the reliable result data is still too incomplete to support even a short factual summary

## Respond Rules

Auto-respond immediately only for:

- permission requests for file reads, writes, or shell commands
- explicit continuation prompts such as "Should I continue?"

Forward everything else to the user:

- architecture or design choices
- destructive operations
- scope changes
- credentials or production questions
- ambiguous requirements

When forwarding, quote the session's exact question. Do not add commentary.

## Plan Approval

Use `permission_mode: "plan"` whenever the user wants a real planning checkpoint.

### `planApproval: "ask"`

- Approval belongs to the user.
- The plugin sends the canonical Approve / Revise / Reject prompt directly to the user.
- If the user requests changes, wait for the revised plan from that same session; the revised submission becomes the latest actionable review version automatically.
- Wait for the user's answer, then forward it with `agent_respond(...)`.
- Do not send a duplicate approval recap or second approval prompt.

### `planApproval: "delegate"`

- Approval belongs to the orchestrator first.
- This is wake-first: the plugin wakes the orchestrator without user buttons.
- Before deciding, read the full plan with `agent_output(session, full=true)`; do not rely on the truncated preview.
- Approve directly with `agent_respond(..., approve=true)` only when the latest actionable plan version is clearly in-bounds and low risk.
- When approving directly, pass a structured rationale with `approval_rationale`, for example: `agent_respond(session='...', message='Approved. Go ahead.', approve=true, approval_rationale='Scope matches the request and the changes are low risk.')`
- After approving directly, send the user a short plain-text follow-up explaining what was approved and why. The plugin's `👍 Plan approved` line is only a fallback signal, not the full explanation.
- If a prior version had `changes_requested`, that stale state should not block approval of the latest revised plan version.
- If escalation is needed, call `agent_request_plan_approval(session='...', summary='...')` exactly once so the plugin sends the single canonical user approval prompt.
- That escalation summary must concisely explain why you are escalating, plus risk/scope notes the user needs to decide.
- After that canonical prompt exists, wait for the user's decision; do not send a second plain-text approval summary.

### `planApproval: "approve"`

- Auto-approve only after verification per the session policy.

## Worktree Decisions

Treat worktrees as temporary task sandboxes, not as generic branch inventory.

Lifecycle meanings:

- `pending_decision`: still waiting for merge / PR / dismiss follow-through
- `pr_open`: PR exists; preserve the sandbox
- `merged`: normal ancestry merge landed
- `released`: content already landed on the base branch even though SHAs differ after rebase, squash, or cherry-pick
- `dismissed`: sandbox intentionally discarded
- `no_change`: no committed delta

If `agent_worktree_status` reports `released`, treat that sandbox as already landed. Do not narrate it as “still unmerged” just because the branch appears ahead.

### `off`

- No worktree. The session runs in the main checkout.

### `ask`

- The plugin owns the user-facing completion/decision message and button UI.
- Do not call `agent_merge` or `agent_pr` unless the user explicitly asks after that.
- A completed ask-session worktree may later resolve as `released` if its content already landed on base through another path. Confirm that with `agent_worktree_status(...)` before deciding what follow-up is still needed.

### `delegate`

- The plugin wakes the orchestrator with diff context and no automatic user buttons.
- Read the diff context and decide whether a local merge is clearly safe.
- `agent_merge` is acceptable for low-risk, clearly scoped changes that match the task.
- Never call `agent_pr()` autonomously in delegate flows. Escalate PR decisions to the user.
- If the wake already says the plugin sent the canonical completion notification, do not repeat that status line, but you should still usually add a short summary of the completed outcome.

### `manual`

- Wait for an explicit user request before calling `agent_merge` or `agent_pr`.

### Cleanup

- Use `agent_worktree_cleanup(mode: "preview_safe")` to review what **Clean all safe** would remove.
- Use `agent_worktree_cleanup(mode: "clean_safe")` only when the user asked to clean up safe sandboxes.
- Use `agent_worktree_cleanup(mode: "preview_all")` when you need both safe candidates and retained reasons.
- Respect retained reasons from `agent_worktree_status` / `agent_worktree_cleanup`; they are the lifecycle model, not advisory prose.

### Never

- Never use raw `git merge` or raw PR commands in place of plugin tools.
- Never invent your own workaround for a pending worktree decision; use `agent_worktree_cleanup(session: "...", dismiss_session: true)` to dismiss permanently.
- Never use `agent_worktree_cleanup` to force-delete unresolved worktrees. The supported bulk action is "clean all safe": omit `session` and let the plugin remove only lifecycle-safe worktrees while preserving anything active, pending, dirty, or PR-open.
- Never merge or PR an `ask` worktree behind the user's back.

## File Artifact Policy

- Do not ask the coding agent to write planning documents, investigation notes, or analysis artifacts as files unless the user explicitly requested a file.
- Do not commit planning documents, investigation notes, or transcript-summary artifacts to the branch.
- Commit only actual code, configuration, tests, and explicitly requested documentation.

## Anti-Patterns

- Do not pass `multi_turn` or `multi_turn_disabled`; all sessions are multi-turn.
- Do not pass `channel` manually unless you are debugging routing.
- Do not auto-answer design or scope questions.
- Do not infer approval/completion ownership from old transcript snippets when deterministic fields are present.
- Do not post duplicate completion or approval recaps when the plugin already sent the canonical message.
