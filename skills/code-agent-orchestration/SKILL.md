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
- Check state with `agent_sessions()`, `agent_sessions(status="waiting")` (what needs a decision or answer), and `agent_output(session, full=true)`.

## Messages from the user

When you forward the user's own words, set `userInitiated=true`: `agent_respond(session, message='<their words>', userInitiated=true)`. Then:
- a question is answered with the option number or label (several comma-separated for multi-select) or free text;
- for a pending plan, `approve`, `reject` or `revise` decide it and any other text is revision feedback.

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

You may approve, but only after it verifies the plan: read it with `agent_output(session, full=true)`. Escalate with `agent_escalate(session, kind='plan', summary)` instead when it deletes or rewrites data or history, touches credentials, secrets, CI/release or production, runs irreversible commands, or goes beyond the task. Otherwise approve with `approval_rationale`.

## Worktrees

- `delegate`: when the session finishes you get the diff. Merge in-scope, low-risk work with `agent_merge(session, summary='<one or two lines on what changed>')`; the summary is shown with the merge notice and replaces your follow-up. For a PR, a risky change or unclear scope use `agent_escalate(session, kind='worktree', summary)`. Never call `agent_pr` yourself in delegate mode.
- `ask`: the user gets Merge / Open PR / Later / Discard buttons. Merge or open a PR only when the user asks.
- `manual`: the branch is kept; act only on the user's request. `auto-merge` / `auto-pr`: the plugin lands the branch. `off`: no worktree.
- A branch that changes git hooks or worktree setup files (`.husky/`, `.githooks/`, `.openclaw/worktree-setup.sh`, `.worktreeinclude`) is never merged or turned into a PR automatically; the user decides.
- The repository policy (`pr-required`, `pr-allowed`, `never-pr`, `manual`) limits what is allowed. The first worktree launch in a repository asks the user; set it with `agent_repo_policy(workdir, policy)` only when they answer in chat.
- `agent_worktree_status` shows each worktree's state (`released` means the content already landed). `agent_worktree_cleanup()` removes only safe worktrees; `agent_worktree_cleanup(session, dismiss_session=true)` discards one for good. Never use raw git merges or PR commands instead.

## After a session finishes

- The plugin posts the status line (`✅ [name] Completed`, merge and PR outcomes). A wake then asks you for a short follow-up: tell the user in one or two sentences what was done, from the output. Do not repeat the status line or paste PR URLs.
- A merge or PR made with `summary` needs no follow-up.
- A failure: tell the user the cause and your next step (continue with `agent_respond`, or fix the launch).
- If the wake names an `originRoute` that is not your current chat, send your message there. If the wake says your reply is not shown, send your message with the message tool to `originRoute`, then answer `NO_REPLY`.
- If the session finished one phase of a larger job, start the next phase instead.

## Goal loops

Use `agent_goal(action="launch", goal, verifier_commands?)` only when the user asks for an autonomous loop. `action="status" | "edit" | "stop"` manage it. Verifier commands suggested by you need the user's confirmation once.

## Files

Do not ask the agent to write plan or notes files, or to commit them, unless the user asked for a file.
