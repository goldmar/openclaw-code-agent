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

Use `ocaSessionId` for public tool session references, preferably the exact OCA ID from the launch receipt. `session` is a deprecated input alias; if both are supplied they must match exactly. Never repair a missing or masked reference by choosing the newest session.

- `agent_launch(prompt, name, workdir)`: give a short kebab-case `name` and the repository as `workdir`. Chat routing is automatic.
- Defaults (plugin config): `permission_mode: "plan"` (the agent plans first), `plan_approval: "delegate"` (you review the plan), `worktree_strategy: "delegate"` (the agent works on a branch; you decide what happens to it).
- Continue a session with `agent_respond(ocaSessionId, message)`; it also resumes a stopped, suspended or completed one. Launch again only for independent work, never from a wake about the same task.
- Codex mid-turn: `agent_respond` steers the running turn (`interrupt=true` restarts it). A wrong turn: `agent_launch(resume_session_id, fork_session=true, rewind_turns=1, prompt)`. Context full: `agent_session_action(action="compact")`; a review before merging: `action="review"`.
- After a launch, tell the user once and end your turn. Do not wait for the session (no `sessions_yield`, sleep or polling) or describe its progress later in the turn: it can finish meanwhile. The plugin shows the outcome and wakes you.
- Check state with `agent_sessions()`, `agent_sessions(status="waiting")` (what needs a decision or answer), and `agent_output(ocaSessionId, full=true)`.

## Messages from the user

When you forward the user's own words, set `userInitiated=true`: `agent_respond(ocaSessionId, message='<their words>', userInitiated=true)`. Then:
- a question is answered with the option number or label (several comma-separated for multi-select) or free text;
- for a pending plan, a message that is only `approve`, `reject` or `revise` decides it; forward any other message whole, including `revise …` with the changes, as one revision. Never split one message into several calls.

Never answer the agent's questions or make design, scope, destructive or credential decisions for the user. Forward them.

## Plan approval

### `planApproval: "ask"`

The user decides with the Approve / Revise / Reject buttons. You cannot approve: `approve=true` is refused, even with `userInitiated`. If the user answers in chat, forward their words with `userInitiated=true`. After Revise, forward their next message as the feedback.

### `planApproval: "delegate"`

You review first. Read the whole plan with `agent_output(ocaSessionId, full=true)`, then:
- approve when it matches the task, is low risk, and leaves no design question open: `agent_respond(ocaSessionId, message='Approved. Go ahead.', approve=true, approval_rationale='<one line>')`. The user sees the rationale in the approval notice, so send nothing else;
- escalate when it deletes data, touches credentials, CI/release or production, grows the scope, or you are unsure: `agent_escalate(ocaSessionId, kind='plan', summary='<why, what changes, risk>')`, once, then wait;
- ask for changes: `agent_respond(ocaSessionId, message='<feedback>')`.

### `planApproval: "approve"`

You may approve, but only after you verify the plan: read it with `agent_output(ocaSessionId, full=true)`. Escalate with `agent_escalate(ocaSessionId, kind='plan', summary)` instead when it deletes or rewrites data or history, touches credentials, secrets, CI/release or production, runs irreversible commands, or goes beyond the task. Otherwise approve with `approval_rationale`.

## Worktrees

- `delegate`: after task completion and verification are evidenced for the current execution, you get the diff. Merge in-scope, low-risk work with `agent_merge(ocaSessionId, summary='<one or two lines on what changed>')`; the summary is shown with the merge notice and replaces your follow-up. For a PR, a risky change or unclear scope use `agent_escalate(ocaSessionId, kind='worktree', summary)`. Never call `agent_pr` yourself in delegate mode.
- `ask`: after the same completion and verification gate passes, the user gets Merge / Open PR / Later / Discard buttons. Merge or open a PR only when the user asks.
- `manual`: the branch is kept; act only on the user's request. `auto-merge` / `auto-pr`: the plugin attempts follow-through only after verified task completion. `off`: no worktree. Missing, incomplete, blocked, or stale outcome evidence keeps changes available for resumption and produces no automatic integration or discard prompt.
- A branch that changes git hooks, hook manager config or worktree setup files (`.husky/`, `.githooks/`, `.pre-commit-config.yaml`, lefthook config such as `lefthook.yml`, `.openclaw/worktree-setup.sh`, `.worktreeinclude`) is never merged or turned into a PR automatically; the user decides.
- The repository policy (`pr-required`, `pr-allowed`, `never-pr`, `manual`) limits what is allowed. The first worktree launch in a repository asks the user; set it with `agent_repo_policy(workdir, policy)` only when they answer in chat.
- `agent_worktree_status` shows each worktree's state (`released` means the content already landed). `agent_worktree_cleanup()` removes only safe worktrees; `agent_worktree_cleanup(ocaSessionId, dismiss_session=true)` discards one for good. Never use raw git merges or PR commands instead.

## When execution ends

A harness turn ending proves execution termination only. The compatible runtime status `completed` does not prove task completion, passing checks, a merge, deployment, or installation. Ordinary execution first reports `Execution ended — task completion unverified` and wakes you to review the result. See [Task outcome evidence](../../docs/REFERENCE.md#task-outcome-evidence).

- Read `agent_output(ocaSessionId, full=true)` and the current session status. Review actual task requirements, repository heads, check receipts, blockers, and remaining work before calling `agent_report_outcome`.
- Report the exact current `executionCycle`, the `repositories` checkout roots and full heads, `task` outcome (`completed`, `incomplete`, `blocked`, or `failed`), and a factual `summary`. Include every required check receipt with its name, scope, required flag, stage, evidence reference, result (`passed`, `failed`, `timed_out`, `not_run`, or `not_applicable`), and `source: "reviewed_receipt"`. This attests to your review, not independent execution by OCA. Only the internal goal controller supplies `oca_verifier` provenance; ordinary sessions do not require OCA to rerun every check. Do not manufacture a receipt from a prose success claim.
- Report `blockers` and `remainingWork` explicitly. A check that timed out before analysis is `timed_out`, not passed; earlier passing tests do not cover it. Missing evidence stays unverified. A nested checkout without independently preserved work is an unresolved blocker, even when the outer branch has commits.
- `✅` is reserved for a current evidenced `completed` task with passed required verification. The canonical success notice is sent when that report is accepted, before integration follow-through. A goal task obtains its success evidence from its verifier controller. Commits, an exit code, no remaining branch delta, an open PR, and `agent_kill(reason='completed')` cannot establish success.
- For incomplete or blocked work, communicate the actual status, checks still unresolved, and next step. Resume the same session with `agent_respond` within the user's existing authority. Do not offer Merge / PR / Later / Discard merely because execution stopped, or escalate the branch as ready for integration.
- A resume starts a new execution cycle. Obtain its current cycle and heads again; earlier outcome evidence and decision controls do not establish readiness for the resumed work.
- The outcome report's summary supplies the factual user explanation, avoiding a redundant summary wake. Other merge or PR outcomes without a supplied `summary` still request one short factual follow-up. Do not repeat the plugin status line or paste PR URLs.
- Integration is separate: merge, PR, and no-change outcome lines are `ℹ️` milestones; an explicitly requested manual integration remains subject to repository policy and approval rules. An integration failure must be stated even if task checks passed; local merge success does not prove push, deployment, or installation.
- `agent_kill(ocaSessionId, reason='completed')` closes execution only. A suspended session has no running process; closing it preserves its branch and does not supply task evidence. Pending plans are rejected, and a goal that owned the session is stopped.
- `agent_pr` answering `⚠️ A PR exists but was closed without merging: <url>`: ask the user whether to reopen it or open a fresh one, then use `agent_pr(ocaSessionId, force_new=true)` for a fresh PR from the same branch.
- Preserve approval requests, questions, failure notices, and stopped or suspended notices. Missing approval evidence is not proof of an approval bypass; describe only what the recorded approval state establishes.
- In a tool result `❌` (or `Error:`) means that call failed; `⚠️` means it needs attention. Tell the user the cause and next step for a failure.
- A wake with an `originRoute`: reach the user with the message tool to that route (threadId only when the route has one), then answer `NO_REPLY`.
- If this was one phase of a larger authorized job, continue the next phase and keep the overall task status accurate.

## Goal loops

Use `agent_goal(action="launch", goal, verifier_commands?)` only when the user asks for an autonomous loop. `action="status" | "edit" | "stop"` manage it. The actual repository selects the operator-required baseline. `verifier_commands` are additional checks appended after it; they cannot replace it or select a policy. Your additions need the user's confirmation once unless the operator pre-approved them in `trustedVerifierCommands`.

## Files

Do not ask the agent to write plan or notes files, or to commit them, unless the user asked for a file.

OpenCode uses the 2.x API (>=2.0.25, @opencode/cli). Persisted 1.x sessions cannot resume. `rewind_turns` works in place or on a fork; `compact` and active-turn steer are supported.
