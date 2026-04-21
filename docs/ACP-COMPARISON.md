# ACPX, Codex, and Code Agent

This note compares three adjacent OpenClaw surfaces as of the `openclaw-code-agent` `3.2.0` / OpenClaw `2026.4.20-beta.2` baseline:

- OpenClaw ACP and the bundled `acpx` runtime backend
- OpenClaw's bundled `codex` plugin
- `openclaw-code-agent`

The important answer up front: **ACPX and Codex are different things**. ACPX is OpenClaw's ACP runtime backend. The bundled `codex` plugin is OpenClaw's native Codex provider and harness. `openclaw-code-agent` is a separate external plugin that orchestrates coding sessions from chat.

## The Short Version

- Use **OpenClaw ACP / ACPX** when you want ACP-native editor interoperability, ACP session/runtime controls, configured bindings, or a broad ACP backend surface.
- Use **OpenClaw's bundled Codex plugin** when you want embedded OpenClaw agent turns to run through Codex App Server as a native harness/provider pair.
- Use **`openclaw-code-agent`** when you want coding agents to behave like managed background jobs from chat: plan review before execution, resume/fork/interrupt flows, operator-visible session state, and worktree/merge/PR follow-through.

## Architecture Relationship

```text
ACP client / editor
  -> OpenClaw ACP bridge (`openclaw acp`)
  -> ACP runtime backend (`acpx`)
  -> ACP agent command / runtime session

OpenClaw embedded agent turn
  -> bundled `codex` provider + harness
  -> Codex App Server

OpenClaw chat session using `openclaw-code-agent`
  -> plugin tools / SessionManager / wake pipeline / worktree policy
  -> plugin-native Claude Code or Codex harness
  -> Claude SDK or Codex App Server
```

The same Codex App Server substrate can appear in more than one place. That does **not** make the products the same:

- ACPX is about ACP runtime/session interoperability.
- The bundled core `codex` plugin is about OpenClaw embedded harness/provider execution.
- `openclaw-code-agent` is about chat-native orchestration and finish-line control.

## Side-By-Side

| Area | OpenClaw ACP / ACPX | OpenClaw bundled `codex` plugin | `openclaw-code-agent` |
| --- | --- | --- | --- |
| Primary role | ACP bridge and runtime backend | Native Codex provider + harness for embedded OpenClaw turns | Chat orchestration plugin for coding sessions |
| Are ACPX and Codex the same thing? | No | No | No |
| IDE-native ACP server/bridge | Yes | No | No |
| ACP session/runtime controls | Yes | No | No |
| Configured ACP bindings and ACP session identities | Yes | No | No |
| Can run Codex | Yes, if the ACP runtime targets a Codex-backed agent | Yes, natively through Codex App Server | Yes, through the plugin's native Codex harness |
| Can run Claude Code | Yes, via ACP-backed agent commands | No | Yes |
| Provider registration inside OpenClaw core | No | Yes | No |
| Native Codex model discovery/catalog in core | No | Yes | No |
| Multi-turn sessions | Yes | Yes, within OpenClaw embedded sessions | Yes |
| Resume previous work | Yes | Yes | Yes |
| Fork a previous session | Not the focus of the ACP surface | Not the focus of the harness surface | Yes |
| Plan review before coding | No plugin-owned review loop | No plugin-owned review loop | Yes |
| Revise / approve loop in chat | No | No | Yes |
| Async wake back to origin chat | ACP/control-plane and reply-hook oriented | Core chat runtime owns delivery | Explicit plugin-owned wake and notification pipeline |
| Session catalog and operator view | ACP/runtime status and identities | Core embedded session status | Dedicated session list, output view, and stats |
| Per-session USD cost tracking | Approximate usage only | Core session/provider accounting | Yes, plugin-facing cost reporting |
| Git worktree lifecycle | No | No | Yes |
| Merge / PR finish-line control | No | No | Yes |
| Inline chat actions | No dedicated coding-session UX | No dedicated coding-session UX | Yes, Telegram and Discord callbacks |

## What Each Supports Today

### OpenClaw ACP / ACPX

Today OpenClaw ACP is more than a thin prompt bridge:

- ACP bridge over stdio with `initialize`, `newSession`, `prompt`, `cancel`, `listSessions`, and partial `loadSession`
- session updates such as `available_commands_update`, `usage_update`, and `tool_call_update`
- runtime controls including `session/set_mode`, `session/set_config_option`, and `session/status`
- configured ACP bindings and persisted ACP backend identity
- embedded ACP runtime backend registration through the bundled `acpx` plugin
- ACP runtime config for cwd, state dir, permission mode, MCP server injection, and per-agent command overrides

What ACPX is **not**:

- not the bundled Codex provider
- not this plugin's session orchestrator
- not a git worktree / merge / PR workflow

### OpenClaw bundled `codex` plugin

Today the bundled `codex` plugin provides:

- a `codex` provider for OpenClaw model selection
- Codex App Server model discovery with fallback model catalog
- a native `codex` harness for embedded OpenClaw agent turns
- synthetic auth/provider availability because the harness owns the native Codex login/session
- Codex-specific app-server transport, approval-policy, sandbox, and service-tier config

What the bundled `codex` plugin is **not**:

- not ACPX
- not an ACP runtime backend
- not this plugin's plan-review/worktree/session UX

### `openclaw-code-agent`

Today this plugin provides:

- native Claude Code and Codex harnesses behind one plugin-owned control plane
- plan-first execution with explicit `ask`, `delegate`, and `approve` behavior
- revise / approve / reject loop for plan-gated sessions
- multi-turn session catalog, buffered output, suspend/resume/fork/interrupt, and restart recovery
- operator-facing session/cost/status tooling
- worktree lifecycle, cleanup, merge, and PR follow-through
- explicit wake/notification routing back to the originating chat thread
- goal-task loops above the normal session model

What this plugin deliberately does **not** try to be:

- not an ACP server
- not an ACP runtime backend
- not OpenClaw's general provider registry

## Where `openclaw-code-agent` Wins

### 1. Plan -> Review -> Execute

The plugin has a first-class approval workflow:

- `permissionMode: "plan"` is the default
- `planApproval: "ask"` is the default
- plans can be revised before implementation
- approval happens with `agent_respond(..., approve=true)` or the shared Approve / Revise / Reject callback flow

Neither ACPX nor the bundled core Codex plugin owns this chat-native review loop.

### 2. Worktree Isolation And Finish-Line Control

The plugin treats the git lifecycle as part of the product:

- isolated worktrees and `agent/*` branches when the selected backend needs plugin-managed worktrees
- `ask`, `delegate`, `manual`, `auto-merge`, and `auto-pr` strategies
- `agent_merge`, `agent_pr`, `agent_worktree_status`, and `agent_worktree_cleanup`
- inline `Merge locally` / `Create PR` actions in Telegram and Discord

ACPX and the bundled core Codex plugin do not solve this layer.

### 3. Background-Job Semantics In Chat

The plugin is built for long-running coding jobs in chat:

- explicit suspended/resume behavior
- persisted session catalog
- interrupt and redirect
- startup recovery
- cost and duration tracking

ACPX is best thought of as an ACP runtime/backend surface. The bundled core Codex plugin is a native harness/provider surface. This plugin is a session orchestrator.

## Where ACPX Or Core Codex Win

Use **ACPX / OpenClaw ACP** when you need:

- ACP-native editor integration
- ACP runtime controls and interoperability
- configured ACP bindings and backend session identity
- a broader ACP backend matrix

Use the **bundled core Codex plugin** when you need:

- embedded OpenClaw turns on `codex/*` models
- Codex-managed model discovery and model refs inside OpenClaw core
- native Codex harness execution without adopting this plugin's chat orchestration model

If the job is running coding agents from chat like managed engineering tasks, use `openclaw-code-agent`.
