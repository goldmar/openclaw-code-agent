---
name: Code Agent Orchestration (OCA)
description: Skill for orchestrating coding agent sessions from OpenClaw, including OCA requests such as "let oca do...", "ask oca to...", or "have oca handle...". Covers launching, monitoring, plan approval, lifecycle management, and worktree decisions.
metadata:
  openclaw:
    homepage: https://github.com/goldmar/openclaw-code-agent
    requires:
      bins:
        - openclaw
    install:
      - id: npm
        kind: node
        package: openclaw-code-agent
        label: Install OpenClaw Code Agent (npm)
---

# Code Agent Orchestration

Use `openclaw-code-agent` to run Claude Code, Codex, or experimental OpenCode sessions as background coding jobs from chat. Treat `oca` as the built-in short name for OpenClaw Code Agent when a user says phrases such as "let oca do ...", "ask oca to ...", or "have oca handle ...".

## Launch

- Routing comes from the current chat context, `agentChannels`, and `fallbackChannel`; `agent_launch` has no channel parameter.
- Sessions are multi-turn. Continue existing work with `agent_respond` or `agent_launch(..., resume_session_id=...)`; do not start a fresh session for the same task.
- Always set a short kebab-case `name` when you care about later follow-up.
- Set `workdir` to the target repo.
- Use `permission_mode: "plan"` when the user wants a real review gate before implementation.
- Use `permission_mode: "bypassPermissions"` only for autonomous execution.
- Treat `harness: "opencode"` as experimental. Use it only when requested or configured and local `opencode >= 1.16.2` has provider auth ready.
- `defaultWorktreeStrategy` defaults to `delegate`, so new sessions normally use branch isolation and orchestrator-led follow-through. Use `worktree_strategy: "off"` only when the task must run in the main checkout or outside a git repo.
- In `plan` mode the agent submits its plan through the harness's native plan step (Claude Code `ExitPlanMode`, Codex plan mode, the OpenCode `plan` agent). Read it with `agent_output(session, full=true)`. Do not ask the coding agent to write plan docs or transcript artifacts unless the user explicitly asked for a file.

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

- Waiting for plan approval: `agent_respond(session, message, approve=true)` (not in `planApproval: "ask"`, where only the user approves) or `agent_request_plan_approval(...)` if delegated approval must escalate to the user
- Waiting for a question answer (Claude Code `AskUserQuestion`, OpenCode or Codex pending input): `agent_respond(session, message)` with the option number or label (several, comma-separated, for multi-select) or free text
- Suspended after idle timeout, or stopped by a restart: `agent_respond(session, message)`
- Completed but needs follow-up: `agent_respond(session, message)` resumes the same backend conversation (Claude Code, Codex, and OpenCode), or `agent_launch(resume_session_id=session_id, prompt="...")` when you need to change launch settings
- Running Codex session needs a correction mid-turn: `agent_respond(session, message)` steers it into the current turn; add `interrupt=true` only to stop the turn and restart from your message
- Codex went down a wrong path in its last turn(s): `agent_launch(resume_session_id=session_id, fork_session=true, rewind_turns=1, prompt="...")` forks from before those turns (omit `fork_session` to revert the thread in place). File changes are not undone; tell the agent to revert them if needed
- Long Codex session near its context limit: `agent_session_action(session, action="compact")`
- Want an independent code review before merge/PR (Codex): `agent_session_action(session, action="review")` reviews a worktree session's branch against its base, or uncommitted changes otherwise; pass `review_target` / `base_branch` / `commit_sha` / `instructions` to change the target, and read the findings with `agent_output`. Actions need a running Codex session; resume a stopped one with `agent_respond` first
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

For worktree cleanup and follow-through, use that tool's lifecycle, derived state, cleanup disposition, and retained reasons as the plugin state source. Avoid deciding cleanup safety from transcript summaries or branch names alone.

When wake payloads include these fields, use them as the plugin's recorded approval state:

- `requestedPermissionMode`
- `effectivePermissionMode` / `currentPermissionMode`
- `approvalExecutionState`

Use those deterministic fields for approval follow-through before consulting transcript fragments.

When OpenClaw exposes managed TaskFlow state for a session, use it as a high-level progress mirror of the plugin session. For operational follow-up, check `agent_sessions`, `agent_output`, and `agent_worktree_status`.

Approval/execution meanings:

- `approved_then_implemented`: normal approved execution
- `implemented_without_required_approval`: actual approval bypass
- `awaiting_approval`: still stopped at the approval gate
- `awaiting_plan_output`: approved; waiting for the implementation turn
- `not_plan_gated`: no plan gate applied

Completion ownership:

- The plugin sends the canonical completion notification.
- The plugin owns the canonical completion status line; the orchestrator owns any additional plain-text follow-up.
- Completion wakes may arrive in a different chat than the session's original user route. Treat the wake's `originRoute` block as the source of truth for human follow-ups.
- If `originRoute` differs from the current chat, do not use a normal final assistant reply for the user-facing follow-up. Use a routed send path that preserves `provider`, `target`, and `threadId` instead.
- After a coding-agent session completes, the orchestrator should usually add at least a short human-useful summary of what changed, what was done, or the concrete outcome.
- That expectation applies to ordinary terminal/manual completions, manual no-change completions, and delegated worktree completions alike.
- Use the plugin's canonical `✅` line as the status signal and your follow-up as the factual outcome summary that should usually come right after it.
- That summary can be brief; one sentence is often enough.
- Extra synthesis, risk framing, and next-step guidance are optional. Add them when useful; do not force them every time.
- Do not generate your own heuristic completion summary from transcript tail lines. Base any summary on reliable result data such as `agent_output(..., full=true)`, diff context, or deterministic tool state.
- Skip the summary only in narrow cases:
  - no user-facing follow-up will be sent at all because the orchestrator is silently continuing an internal multi-phase pipeline
  - the completion produced no meaningful outcome to report, or the reliable result data is still too incomplete to support even a short factual summary
  - the session is a silent cron/system pipeline that already returned `NO_REPLY` or otherwise explicitly opted out of a user-facing follow-up summary

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
- Telegram and Discord buttons use the shared direct-message presentation path; if buttons are missing, a plain-text `approve` or `reject` in the same thread drives the same decision path, and any other reply is sent back as revision feedback.
- If the user requests changes, wait for the revised plan from that same session; the revised submission becomes the latest actionable review version automatically.
- If the user rejects the plan or the session is killed, treat older plan prompts as stale and verify state with `agent_sessions` before acting.
- Wait for the user's answer. If they answer in chat instead of with a button, forward their exact words with `agent_respond(session='...', message='<their words>', userInitiated=true)`. Never approve yourself: `approve=true` is refused in `ask` mode.
- Do not send a duplicate approval recap or second approval prompt.

### `planApproval: "delegate"`

- Approval belongs to the orchestrator first.
- This is wake-first: the plugin wakes the orchestrator without user buttons.
- Before deciding, read the full plan with `agent_output(session, full=true)`; do not rely on the truncated preview.
- Approve directly with `agent_respond(..., approve=true)` only when the latest actionable plan version is clearly in-bounds and low risk.
- When approving directly, pass a structured rationale with `approval_rationale`, for example: `agent_respond(session='...', message='Approved. Go ahead.', approve=true, approval_rationale='Scope matches the request and the changes are low risk.')`
- After approving directly, send the user a short plain-text follow-up explaining what was approved and why. The plugin's `👍 Plan approved` line is only a fallback signal, not the full explanation.
- If a prior version had `changes_requested`, that stale state should not block approval of the latest revised plan version.
- `agent_respond(session='...', message='Reject')` rejects the plan and stops the session; use it only when the plan should not proceed at all. To ask for changes, send the feedback itself as the message instead.
- If escalation is needed, call `agent_request_plan_approval(session='...', summary='...')` exactly once so the plugin sends the single canonical user approval prompt.
- That escalation summary must concisely explain why you are escalating, plus risk/scope notes the user needs to decide.
- After that canonical prompt exists, wait for the user's decision; do not send a second plain-text approval summary.

### `planApproval: "approve"`

- The orchestrator may approve without asking the user, but only after it verifies the plan. This setting never approves a plan on its own.
- Verify first: read the full plan with `agent_output(session, full=true)` and confirm that it stays within the requested task, the session's workdir or worktree, and the repository's policy.
- Send the plan to the user with `agent_request_plan_approval(session='...', summary='...')` instead of approving when it deletes or rewrites data, history, or files outside the task; touches credentials, secrets, CI/release, or deployment; runs destructive or irreversible commands; or goes beyond what the user asked for.
- When verification passes, approve with `agent_respond(..., approve=true, approval_rationale='...')`, and tell the user in one short line what you approved and why.

## Worktree Decisions

Use worktrees as temporary task sandboxes, not as generic branch inventory.

New worktrees receive the repository's `.worktreeinclude` files (for example `.env`) and run its `.openclaw/worktree-setup.sh`, both as committed on the checked-out commit (uncommitted edits to them do not count). If a launch fails with `worktree setup failed`, report the script output to the user instead of retrying with `worktree_strategy: "off"`.

A branch that changes git hooks or worktree setup files (`.husky/`, `.githooks/`, the `core.hooksPath` directory, `.openclaw/worktree-setup.sh`, `.worktreeinclude`) is never merged or turned into a PR automatically, and `agent_merge` / `agent_pr` refuse it: the user gets the Merge / Open PR prompt naming those files. Wait for their button.

Lifecycle meanings:

- `provisioned` (shown as `active`): sandbox still in use; a completed `manual` worktree stays here
- `pending_decision`: still waiting for merge / PR / dismiss follow-through
- `merge_conflict_resolving`: a conflict-resolver session is working on an auto-merge conflict
- `pr_open`: PR exists; preserve the sandbox
- `merged`: normal ancestry merge landed
- `released`: content already landed on the base branch even though SHAs differ after rebase, squash, or cherry-pick
- `dismissed`: sandbox intentionally discarded
- `no_change`: no committed delta
- `cleanup_failed`: removal failed; report it instead of retrying blindly

If `agent_worktree_status` reports `released`, the sandbox content is already landed. Do not narrate it as "still unmerged" just because the branch appears ahead.

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
- If a merge/PR outcome wake has `completionWakeSummaryRequired=true`, read `agent_output(..., full=true)` when available and send one short factual summary. Honor the wake's origin route block; if it differs from the current chat, use a routed send path that preserves provider, target, and thread/topic.
- If the wake already says the plugin sent the canonical completion notification, do not repeat that status line. The follow-up summary is orchestrator-owned and should add only the useful confirmed outcome.

### `manual`

- The worktree is kept after the session completes (lifecycle `provisioned`) until it is merged, turned into a PR, or dismissed.
- Wait for an explicit user request before calling `agent_merge` or `agent_pr`.

### `auto-merge` / `auto-pr`

- The plugin merges or opens/updates the PR itself when the session completes, subject to repo policy. An auto-merge rebase conflict starts a conflict-resolver session; a failed auto-PR falls back to a pending worktree decision.

### Repo Policy

- The repo integration policy (`pr-required`, `pr-allowed`, `never-pr`, `manual`) decides which follow-through is allowed. Set it with `agent_repo_policy(workdir, policy)` when a first launch asks for one.
- `agent_repo_policy(workdir, reset=true)` also works after the repo directory was deleted (pass the stored path); `agent_repo_policy(list=true)` marks missing repos, and `agent_repo_policy(cleanup=true)` removes their policies.

### Cleanup

- Use `agent_worktree_cleanup(mode: "preview_safe")` to review what **Clean all safe** would remove.
- Use `agent_worktree_cleanup(mode: "clean_safe")` only when the user asked to clean up safe sandboxes.
- Use `agent_worktree_cleanup(mode: "preview_all")` when you need both safe candidates and retained reasons.
- Use retained reasons from `agent_worktree_status` / `agent_worktree_cleanup` as lifecycle data, not advisory prose.

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

- All sessions are multi-turn; there is no single-turn option.
- Do not auto-answer design or scope questions.
- Do not infer approval/completion ownership from old transcript snippets when deterministic fields are present.
- Do not post duplicate completion or approval recaps when the plugin already sent the canonical message.
