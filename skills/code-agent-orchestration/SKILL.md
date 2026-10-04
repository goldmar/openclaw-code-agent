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

`openclaw-code-agent` runs Claude Code, Codex, or OpenCode sessions as background coding jobs. `oca` is the built-in short name for OpenClaw Code Agent ("let oca do …", "ask oca to …", "have oca handle …").

## Launch and continue

- `agent_launch(prompt, name, workdir)`: give a short kebab-case `name` and the repository as `workdir`. Chat routing is automatic.
- Defaults (plugin config): `permission_mode: "plan"` (the agent plans first), `plan_approval: "delegate"` (you review the plan), `worktree_strategy: "delegate"` (the agent works on a branch; you decide what happens to it).
- Continue a session with `agent_respond(session, message)`; it also resumes a stopped, suspended or completed one. Launch again only for independent work, never from a wake about the same task.
- Codex mid-turn: `agent_respond` steers the running turn (`interrupt=true` restarts it). A wrong turn: `agent_launch(resume_session_id, fork_session=true, rewind_turns=1, prompt)`. Context full: `agent_session_action(action="compact")`; a review before merging: `action="review"`.
- After a launch, tell the user once and end your turn. Do not wait for the session (no `sessions_yield`, sleep or polling) or describe its progress later in the turn: it can finish meanwhile. The plugin shows the outcome and wakes you.
- Check state with `agent_sessions()`, `agent_sessions(status="waiting")` (what needs a decision or answer), and `agent_output(session, full=true)`.

## Messages from the user

When you forward the user's own words, set `userInitiated=true`: `agent_respond(session, message='<their words>', userInitiated=true)`. Then:
- a question is answered with the option number or label (several comma-separated for multi-select) or free text;
- for a pending plan, a message that is only `approve`, `reject` or `revise` decides it; forward any other message whole, including `revise …` with the changes, as one revision. Never split one message into several calls.

Never answer the agent's questions or make design, scope, destructive or credential decisions for the user. Forward them.

## Plan approval

### `planApproval: "ask"`

The user decides with the Approve / Revise / Reject buttons. You cannot approve: `approve=true` is refused, even with `userInitiated`. If the user answers in chat, forward their words with `userInitiated=true`. After Revise, forward their next message as the feedback.

### `planApproval: "delegate"`

You review first. Read the whole plan with `agent_output(session, full=true)`, then:
- approve when it matches the task, is low risk, and leaves no design question open: `agent_respond(session, message='Approved. Go ahead.', approve=true, approval_rationale='<one line>')`. The user sees the rationale in the approval notice, so send nothing else;
- escalate when it deletes data, touches credentials, CI/release or production, grows the scope, or you are unsure: `agent_escalate(session, kind='plan', summary='<why, what changes, risk>')`, once, then wait;
- ask for changes: `agent_respond(session, message='<feedback>')`.

### `planApproval: "approve"`

You may approve, but only after you verify the plan: read it with `agent_output(session, full=true)`. Escalate with `agent_escalate(session, kind='plan', summary)` instead when it deletes or rewrites data or history, touches credentials, secrets, CI/release or production, runs irreversible commands, or goes beyond the task. Otherwise approve with `approval_rationale`.

## Worktrees

- `delegate`: when the session finishes you get the diff. Merge in-scope, low-risk work with `agent_merge(session, summary='<one or two lines on what changed>')`; the summary is shown with the merge notice and replaces your follow-up. For a PR, a risky change or unclear scope use `agent_escalate(session, kind='worktree', summary)`. Never call `agent_pr` yourself in delegate mode.
- `ask`: the user gets Merge / Open PR / Later / Discard buttons. Merge or open a PR only when the user asks.
- `manual`: the branch is kept; act only on the user's request. `auto-merge` / `auto-pr`: the plugin lands the branch. `off`: no worktree.
- A branch that changes git hooks or worktree setup files (`.husky/`, `.githooks/`, `.openclaw/worktree-setup.sh`, `.worktreeinclude`) is never merged or turned into a PR automatically; the user decides.
- The repository policy (`pr-required`, `pr-allowed`, `never-pr`, `manual`) limits what is allowed. The first worktree launch in a repository asks the user; set it with `agent_repo_policy(workdir, policy)` only when they answer in chat.
- `agent_worktree_status` shows each worktree's state (`released` means the content already landed). `agent_worktree_cleanup()` removes only safe worktrees; `agent_worktree_cleanup(session, dismiss_session=true)` discards one for good. Never use raw git merges or PR commands instead.

## After a session finishes

- `✅` means the session completed: `✅ [name] Completed`, or `✅ [name] Completed — <outcome>`. Outcomes: `Merged: …`, `PR opened: …`, `PR updated: …`, `PR was already merged: …`, `PR is up to date: …` (auto-merge, auto-pr, or the merge or PR that resolves the `🔀 [name] Finished on …` prompt) and `no changes to merge` (a worktree session without commits). A goal task that succeeded is `✅ [task] Completed — goal succeeded`. `ℹ️ [name] Merged/PR opened/PR updated: …` is a milestone, not session completion: the session may still be running. In `delegate` mode the user already got `✅ [name] Completed`, so your merge is reported as `ℹ️`.
- The plugin posts the status line (`✅ [name] Completed`, merge and PR outcomes). A wake then asks you for a short follow-up: tell the user in one or two sentences what was done, from the output. Do not repeat the status line or paste PR URLs.
- A merge or PR made with `summary` needs no follow-up.
- A completed session that needs attention is announced as `⚠️ [name] Completed — <problem>` (conflict, blocked or failed merge, failed auto-PR, policy, uncommitted changes) and gets no `✅`; a merge or PR you make for it afterwards is `ℹ️`. `❌` means the session, goal or launch itself failed.
- A turn that ends without a question or a plan decision completes the session by itself. `agent_kill(session, reason='completed')` on a session that still runs (it waits for an answer or a plan decision) answers `ℹ️ [name] Marked as completed; the user gets the completion notice (✅ Completed, or the worktree prompt or outcome).`; do not announce it again.
- `agent_kill` on a suspended session (idle timeout, or recovered after a restart) closes it without a user notice and answers `⛔ [name] Stopped (it was not running).`, or `⛔ [name] Stopped (it was not running); goal task "<task>" stopped.` when a goal task owned it (the user gets that task's `⛔ [task] Goal task stopped` notice) (`ℹ️ [name] Marked as completed (it was not running).` with `reason='completed'`; for a worktree session that result names the branch that is left as it is, which you then land with `agent_merge` / `agent_pr` or discard); a plan that still waited is rejected. Tell the user yourself if they asked for it.
- `agent_pr` answering `⚠️ A PR exists but was closed without merging: <url>`: ask the user whether to reopen it or open a fresh one, then use `agent_pr(session, force_new=true)` for a fresh PR from the same branch.
- In a tool result `❌` (or `Error:`) means that call failed; the session is unchanged. `⚠️` in a tool result means the call needs your attention (rebase conflict, push failed).
- A failure: tell the user the cause and your next step (continue with `agent_respond`, or fix the launch).
- A wake with an `originRoute`: reach the user with the message tool to that route (threadId only when the route has one), then answer `NO_REPLY`.
- If the session finished one phase of a larger job, start the next phase instead.

## Goal loops

Use `agent_goal(action="launch", goal, verifier_commands?)` only when the user asks for an autonomous loop. `action="status" | "edit" | "stop"` manage it. Verifier commands suggested by you need the user's confirmation once.

## Files

Do not ask the agent to write plan or notes files, or to commit them, unless the user asked for a file.
