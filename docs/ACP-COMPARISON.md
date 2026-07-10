# ACPX, Codex, and Code Agent

This note compares three adjacent OpenClaw surfaces as of the current `openclaw-code-agent` / OpenClaw `2026.6.5` installable SDK readiness baseline:

- OpenClaw ACP and the `acpx` runtime backend
- OpenClaw's `codex` plugin
- `openclaw-code-agent`

The important answer up front: **ACPX and Codex are different things**. ACPX is OpenClaw's ACP runtime backend with plugin-owned session and transport management. The `codex` plugin is OpenClaw's Codex app-server harness and model provider plugin. `openclaw-code-agent` is a separate external plugin that orchestrates coding sessions from chat.

## The Short Version

- Use **OpenClaw ACP / ACPX** when you want ACP-native editor interoperability, ACP session/runtime controls, configured bindings, or a broad ACP backend surface.
- Use **OpenClaw's Codex plugin** when you want embedded OpenClaw agent turns to run through Codex App Server as a native harness/provider pair.
- Use **`openclaw-code-agent`** when you want coding agents to behave like managed background jobs from chat: plan review before execution, resume/fork/interrupt flows, operator-visible session state, and worktree/merge/PR follow-through.

## Current Routing Guidance

The current OpenClaw routing split is:

| Intent | Use | Owned by |
| --- | --- | --- |
| Normal embedded Codex agent turn from OpenClaw chat | `openai/gpt-*` model ref with the `codex` runtime available | OpenClaw `codex` plugin |
| Fail closed if Codex is unavailable | Provider/model-scoped `agentRuntime.id: "codex"` | OpenClaw `codex` plugin |
| Intentionally run an OpenAI agent model through the OpenClaw embedded runtime | Provider/model-scoped `agentRuntime.id: "openclaw"` | OpenClaw core runtime selection |
| Bind, inspect, resume, steer, or stop native Codex app-server threads from chat | `/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`, `/codex stop`, and related `/codex ...` commands | OpenClaw `codex` plugin |
| Run Codex through the ACP adapter path | ACP runtime config with `runtime: "acp"` and `agentId: "codex"` | OpenClaw ACP / ACPX |
| Run Gemini CLI, Cursor, Droid, or another external harness through OpenClaw core | ACP / ACPX, unless a dedicated native runtime exists and is explicitly selected | OpenClaw ACP / ACPX |
| Launch managed coding work from chat with plan review, worktrees, wake notifications, and PR follow-through | `openclaw-code-agent` tools and `harnesses.codex.*` / `harnesses["claude-code"].*` / experimental `harnesses.opencode` config | `openclaw-code-agent` |

In current OpenClaw docs, public runtime policy lives on provider/model entries as `agentRuntime.id`; whole-agent runtime pins are legacy and ignored. Legacy Codex GPT refs and `codex-cli/*` refs should be repaired with `openclaw doctor --fix` rather than copied into new config.

## Architecture Relationship

```text
ACP client / editor
  -> OpenClaw ACP bridge (`openclaw acp`)
  -> ACP runtime backend (`acpx`)
  -> ACP agent command / runtime session

OpenClaw embedded agent turn
  -> `codex` provider + harness
  -> Codex App Server

OpenClaw chat session using `openclaw-code-agent`
  -> plugin tools / SessionManager / wake pipeline / worktree policy
  -> plugin-native Claude Code, Codex, or experimental OpenCode harness
  -> Claude SDK, Codex App Server, or OpenCode server
```

The same Codex App Server substrate can appear in more than one place. That does **not** make the products the same:

- ACPX is about ACP runtime/session interoperability.
- The OpenClaw `codex` plugin is about OpenClaw embedded harness/provider execution.
- `openclaw-code-agent` is about chat-native orchestration and finish-line control.

## Side-By-Side

| Area | OpenClaw ACP / ACPX | OpenClaw `codex` plugin | `openclaw-code-agent` |
| --- | --- | --- | --- |
| Primary role | ACP bridge and runtime backend | Native Codex provider + harness for embedded OpenClaw turns | Chat orchestration plugin for coding sessions |
| Are ACPX and Codex the same thing? | No | No | No |
| IDE-native ACP server/bridge | Yes | No | No |
| ACP session/runtime controls | Yes | No | No |
| Configured ACP bindings and ACP session identities | Yes | No | No |
| Can run Codex | Yes, through the Codex ACP adapter (`runtime: "acp"`, `agentId: "codex"`) | Yes, natively through Codex App Server | Yes, through the plugin's native Codex harness |
| Can run Claude Code | Yes, via ACP-backed agent commands | No | Yes, through the plugin's native Claude Code harness |
| External harness fit | Best fit for Gemini CLI, Cursor, Droid, and similar ACP-backed harnesses in OpenClaw core | Not the external harness path | Owns its configured native Claude Code, Codex, and experimental OpenCode harnesses |
| Provider/model runtime selection inside OpenClaw core | No | Yes, via provider/model-scoped `agentRuntime.id` and `openai/*` model refs | No |
| Native Codex model discovery/catalog in core | No | Yes | No |
| Native `/codex` chat-control commands | No | Yes | No |
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
| Inline chat actions | No dedicated coding-session UX | No dedicated coding-session UX | Yes, Telegram and Discord callbacks over the shared `message.send --presentation` contract |

## What Each Supports Today

### OpenClaw ACP / ACPX

Today OpenClaw ACP is more than a thin prompt bridge:

- ACP bridge over stdio with lifecycle and prompt methods such as `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, and `session/resume`
- session updates such as `available_commands_update`, `usage_update`, and `tool_call_update`
- runtime controls including `session/set_mode`, `session/set_config_option`, and `session/status`
- configured ACP bindings and persisted ACP backend identity
- embedded ACP runtime backend registration through the `acpx` plugin
- ACP runtime config for cwd, state dir, permission mode, MCP server injection, and per-agent command overrides
- Codex adapter routing when the request explicitly needs ACP/acpx, using `runtime: "acp"` and `agentId: "codex"`

What ACPX is **not**:

- not the OpenClaw Codex provider
- not this plugin's session orchestrator
- not a git worktree / merge / PR workflow
- not the preferred chat-control surface for native Codex app-server threads

### OpenClaw `codex` plugin

Today the `codex` plugin provides:

- Codex-backed OpenAI agent turns using canonical `openai/gpt-*` model refs
- Codex App Server model discovery with fallback model catalog
- a native `codex` harness for embedded OpenClaw agent turns
- synthetic auth/provider availability because the harness owns the native Codex login/session
- provider/model-scoped runtime routing through `agentRuntime.id: "codex"` or `agentRuntime.id: "openclaw"`
- native `/codex ...` chat-control commands for app-server bind/status/models/threads/resume/steer/stop flows
- Codex-specific App Server transport, native code-mode policy, sandbox integration, `reasoningEffort`, and service-tier config

OpenClaw `2026.6.5` documents Codex as an explicit provider/runtime split. `openai/gpt-5.6-sol` selects an OpenAI model ref and, in the normal Codex setup, runs embedded agent turns through the native Codex app-server runtime. Provider/model-scoped `agentRuntime.id: "codex"` makes that selection fail closed if Codex is unavailable. Provider/model-scoped `agentRuntime.id: "openclaw"` intentionally opts an OpenAI agent model into the OpenClaw embedded runtime. Legacy Codex GPT refs and `codex-cli/*` refs are migration inputs for `openclaw doctor --fix`, not new config to copy.

That routing policy is separate from this plugin's `harnesses.codex.*` configuration. It is also separate from the ACP/acpx Codex adapter path, which is selected only when ACP/acpx is explicitly needed.

What the `codex` plugin is **not**:

- not ACPX
- not an ACP runtime backend
- not this plugin's plan-review/worktree/session UX

### `openclaw-code-agent`

Today this plugin provides:

- native Claude Code, Codex, and experimental OpenCode harnesses behind one plugin-owned control plane
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
- not the owner of OpenClaw core's native `/codex` command surface or provider/model `agentRuntime.id` routing

## Where `openclaw-code-agent` Wins

### 1. Plan -> Review -> Execute

The plugin has a first-class approval workflow:

- `permissionMode: "plan"` is the default
- `planApproval: "delegate"` is the default
- plans can be revised before implementation
- approval happens with `agent_respond(..., approve=true)` or the shared Approve / Revise / Reject callback flow
- plain-text `Approve`, `Revise`, and `Reject` replies provide the same control path when interactive buttons are unavailable

Neither ACPX nor the OpenClaw Codex plugin owns this chat-native review loop.

### 2. Worktree Isolation And Finish-Line Control

The plugin treats the git lifecycle as part of the product:

- isolated worktrees and `agent/*` branches when the selected backend needs plugin-managed worktrees
- `ask`, `delegate`, `manual`, `auto-merge`, and `auto-pr` strategies
- `agent_merge`, `agent_pr`, `agent_worktree_status`, and `agent_worktree_cleanup`
- inline `Merge` / `Open PR` actions in Telegram and Discord

ACPX and the OpenClaw Codex plugin do not solve this layer.

### 3. Background-Job Semantics In Chat

The plugin is built for long-running coding jobs in chat:

- explicit suspended/resume behavior
- persisted session catalog
- interrupt and redirect
- startup recovery
- cost and duration tracking

ACPX is best thought of as an ACP runtime/backend surface. The OpenClaw Codex plugin is a native harness/provider surface. This plugin is a session orchestrator.

## Where ACPX Or Core Codex Win

Use **ACPX / OpenClaw ACP** when you need:

- ACP-native editor integration
- ACP runtime controls and interoperability
- configured ACP bindings and backend session identity
- a broader ACP backend matrix
- Codex through an explicit ACP adapter path
- Gemini CLI, Cursor, Droid, or another external harness path in OpenClaw core

Use the **OpenClaw Codex plugin** when you need:

- embedded OpenClaw turns on canonical `openai/gpt-*` model refs through Codex App Server
- Codex-managed model discovery and model refs inside OpenClaw core
- provider/model-scoped `agentRuntime.id` routing for Codex fail-closed or intentional OpenClaw fallback behavior
- native `/codex ...` chat-control commands for Codex app-server threads
- native Codex harness execution without adopting this plugin's chat orchestration model

If the job is running coding agents from chat like managed engineering tasks, use `openclaw-code-agent`.

## Review Sources

This comparison was checked against:

- OpenClaw docs for agent runtimes, Codex harness routing, and plugin inventory in the OpenClaw source tree.
- ACP v1 protocol docs for the JSON-RPC session model and session lifecycle methods.
- ACP updates through May 2026, including stabilized session list, session resume, session close, logout, and config options.
- Zed's public ACP Codex registry entry, which describes Codex as an ACP adapter integration.
