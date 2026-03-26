# ACP Comparison

This note compares OpenClaw core ACP and `openclaw-code-agent` as of March 25, 2026. The point is not that ACP is weak. ACP is now a solid runtime surface. The difference is that this plugin is built around coding-session orchestration, not ACP interoperability.

## The Short Version

Use OpenClaw core ACP when you want ACP-native editors, broad backend coverage, and built-in ACP runtime control.

Use `openclaw-code-agent` when you want coding agents to behave like managed background jobs: review the plan before execution, resume or fork prior work, track session cost and status, and finish isolated worktree branches with merges or PRs from chat.

## Side-By-Side

| Area | OpenClaw core ACP | `openclaw-code-agent` |
| --- | --- | --- |
| Run Codex or Claude from OpenClaw | Yes, via ACP runtimes | Yes, via native harnesses |
| Multi-turn sessions | Yes | Yes |
| Resume previous work | Yes | Yes |
| Fork a previous session | No documented fork flow | Yes |
| Plan review before coding | No dedicated orchestration loop | Yes |
| Revise a plan inline | No explicit review/revise/approve loop | Yes |
| Session catalog and operator view | Basic runtime/session view | Dedicated session list, output view, and stats |
| Per-session cost tracking | Approximate usage only | Yes, with USD cost reporting |
| Async wake back to origin chat | Thread-bound ACP replies | Explicit notification and wake pipeline |
| Git worktree isolation | No | Yes |
| Merge or PR lifecycle | No | Yes |
| Inline chat actions | No | Yes, Telegram callbacks |
| Harness coverage | Broader ACP backend set | Claude Code and Codex today |
| IDE-native ACP server | Yes | No |

## Where The Plugin Wins

### 1. Plan -> Review -> Execute

The plugin has a first-class approval workflow:

- `permissionMode: "plan"` is the default
- `planApproval: "ask"` is the default
- plans can be revised before implementation
- approval happens with `agent_respond(..., approve=true)` or the Telegram approval buttons

ACP can run sessions. It does not give you this orchestration loop out of the box.

### 2. Worktree Isolation And Finish-Line Control

The plugin treats the git lifecycle as part of the product:

- isolated worktrees and `agent/*` branches
- `ask`, `delegate`, `manual`, `auto-merge`, and `auto-pr` strategies
- `agent_merge`, `agent_pr`, `agent_worktree_status`, and `agent_worktree_cleanup`
- inline `Merge locally` / `Create PR` actions in Telegram

ACP does not solve this layer.

### 3. Background-Job Semantics

The plugin is built for long-running coding jobs in chat:

- explicit pause and auto-resume behavior
- persisted session catalog
- interrupt and redirect
- startup recovery
- cost and duration tracking

ACP is better thought of as a session runtime and bridge. This plugin is a session orchestrator.

## Where ACP Wins

ACP still has clear advantages when you need:

- ACP-native editor integration
- a broader runtime matrix from OpenClaw core
- ACP runtime controls and interoperability
- a built-in ACP server surface instead of a chat orchestration layer

If that is the job, use ACP. If the job is running coding agents from chat like managed engineering tasks, use this plugin.
