# openclaw-code-agent: Coding-Agent orchestration for OpenClaw

> Current comparison against OpenClaw core ACP.
> https://github.com/goldmar/openclaw-code-agent

---

This plugin was originally created because OpenClaw's built-in ACP support did not provide a coding-agent orchestration layer. Early ACP integration was mainly a relay into ACP backends: useful for launching a session, but not for reviewing plans, revising them inline, forking work, tracking costs, or sending explicit async notifications back to the originating chat. OpenClaw ACP has since evolved and now covers more of the basics, especially multi-turn sessions, resume flows, and backend coverage. The remaining difference is no longer "ACP can do nothing"; it is that ACP still does not replace the orchestration model this plugin adds.

## Version baseline

This comparison is based on:

- `openclaw --version` → `OpenClaw 2026.3.23 (630f147)`
- Plugin version → `2.4.0`

## OpenClaw core ACP surfaces

OpenClaw core ACP now spans two related surfaces:

- **`openclaw acp` stdio bridge** — exposes an ACP agent over stdio, forwards prompts to a running OpenClaw Gateway over WebSocket, keeps ACP session ids mapped to Gateway session keys for reconnects and resets
- **ACP runtime sessions** inside OpenClaw via `/acp ...` and `sessions_spawn({ runtime: "acp" })`

OpenClaw core ACP is now broader than a one-shot relay, but it still focuses on ACP session routing/runtime control rather than coding-agent orchestration.

## OpenClaw core ACP vs. openclaw-code-agent

| Area | OpenClaw core ACP | openclaw-code-agent |
|------|-------------------|---------------------|
| Run Codex / Claude Code from OpenClaw | ✅ Via ACP runtime backends (`codex`, `claude`, `opencode`, `gemini`, `pi`, `kimi`) | ✅ Via native harnesses (Claude Code + Codex today) |
| Multi-turn sessions | ✅ ACP sessions accept follow-ups; `prompt` → Gateway `chat.send` per turn | ✅ Background sessions are multi-turn by default |
| Resume previous work | ✅ `resumeSessionId`, `session/load`, `loadSession` exist; replays stored user/assistant text history; tool/system history is not reconstructed | ✅ Resume by internal ID, name, or harness session ID with persisted metadata and full output replay |
| Fork a prior session | ❌ No documented fork flow | ✅ `fork_session` and `/agent_resume --fork` |
| Plan approval before coding | ❌ No dedicated propose/revise/approve workflow | ✅ Native `ask` / `delegate` / `approve` flow with inline Telegram buttons |
| Revise a plan inline | ❌ No explicit plan-revision control loop | ✅ Send feedback, iterate, then `approve=true` |
| Runtime controls on active sessions | ✅ `session/set_mode` supports thought level, tool verbosity, reasoning, usage detail, elevated actions | ⚠️ Mostly launch-time options plus respond/approval flow; `interrupt: true` for redirect |
| Parallel sessions | ✅ `maxConcurrentSessions` and ACP runtime session management | ✅ `maxSessions` with dedicated session manager |
| Live streaming | ✅ Message/tool streaming, `tool_call_update`, best-effort file locations | ✅ `agent_output`, turn-end notifications, wake events |
| Persistence across restarts | ⚠️ ACP sessions can be mapped to Gateway sessions and rehydrated; transcript fidelity is text-only (tool/system history not reconstructed) | ✅ Serialized to disk with persisted output and metadata; startup recovery marks crashed sessions |
| Usage / cost reporting | ⚠️ `usage_update` notifications sent from cached Gateway snapshots; approximate, no per-session cost data | ✅ Per-session USD cost tracking plus `agent_stats` aggregates |
| Session history / operator view | ⚠️ `listSessions` maps to Gateway `sessions.list`; no dedicated persisted session catalog with operator-facing stats | ✅ `agent_sessions`, `agent_output`, `agent_stats` |
| Multiple harness backends | ✅ `codex`, `claude`, `opencode`, `gemini`, `pi`, `kimi` via ACP runtime backends | ⚠️ Claude Code + Codex today; plugin architecture supports adding new harnesses |
| Origin-targeted async notifications | ⚠️ Thread-bound ACP replies route back into the active conversation; no separate background wake/notification pipeline | ✅ Explicit notification + wake routing back to the origin chat/thread via `chat.send` + fallback |
| Git worktree isolation | ❌ Not provided | ✅ Full worktree lifecycle with `off` / `manual` / `ask` / `delegate` / `auto-merge` / `auto-pr` strategies |
| PR lifecycle management | ❌ Not provided | ✅ `agent_pr` detects existing open/merged/closed PRs; `auto-pr` strategy automates full lifecycle |
| Inline UI for decisions | ❌ Not provided | ✅ Telegram inline keyboard buttons for `ask` worktree strategy; callback routing built in |
| IDE-native ACP server | ✅ `openclaw acp` stdio bridge (Zed, Cursor, other ACP-native editors) | ❌ Not an ACP server |
| Per-session MCP servers | ❌ Bridge rejects `mcpServers` per session; configure on the gateway instead | ❌ MCP configuration is at the gateway/agent level |
| Client filesystem / terminal methods | ❌ Bridge does not call ACP client `fs/*` or `terminal/*` methods | ❌ Not applicable |
| Setup complexity | ⚠️ Bridge is built in, but ACP coding runtimes still require backend/plugin setup | ⚠️ Requires plugin install + config |

---

## Known ACP bridge limitations (2026.3.23)

The `openclaw acp` bridge is a Gateway-backed ACP bridge, not a full ACP-native editor runtime. Key current limitations:

- **`loadSession` fidelity** — replays stored user and assistant text history only; does not reconstruct historic tool calls, system notices, or richer ACP-native event types
- **Usage data** — `session_info_update` and `usage_update` are derived from Gateway session snapshots, not live ACP-native runtime accounting; usage is approximate, carries no cost data, and is only emitted when the Gateway marks total token data as fresh
- **Tool follow-along** — bridge surfaces file paths from known tool args/results; does not emit ACP terminals or structured file diffs
- **Model selection** — not yet exposed as an ACP session config option; set at the Gateway/agent level
- **Session plans / thought streaming** — unsupported; bridge emits output text and tool status, not ACP plan or thought updates

---

## In practice

OpenClaw core ACP is now good enough for straightforward ACP routing: launch a supported runtime, keep the conversation thread-bound, resume some prior work, and integrate with ACP-native editors. If that is all you need, built-in ACP may be enough.

`openclaw-code-agent` is still the better fit when you want the coding agent to behave like a managed background job with explicit orchestration:

```
You: Build a REST API for todos

Alice → agent_launch(prompt="...", permission_mode="plan", worktree_strategy="auto-pr")

[Claude Code proposes plan: 5 files, REST endpoints, PostgreSQL]

Alice: Here's the plan — want any changes?
You: Add rate limiting

Alice → agent_respond(session, "Add rate limiting to all endpoints")
Alice → agent_respond(session, approve=true)  // once revised

[Claude Code implements — silently, in an isolated worktree branch]
[GitHub PR created automatically when done]
[You get a notification with a link to the PR]
```

That is the remaining gap in practice. ACP can route and continue sessions, but it still does not provide this plugin's plan review loop, fork workflow, dedicated session catalog/stats view, cost accounting, explicit async notification pipeline back to the origin chat, or git worktree isolation with PR lifecycle management.

---

## Tool surface

```
agent_launch          — start a session in background (with optional worktree isolation)
agent_respond         — reply mid-session, approve a plan, or interrupt
agent_output          — read buffered session output
agent_sessions        — list active/recent sessions with status and worktree info
agent_kill            — terminate a session
agent_stats           — usage metrics and costs
agent_merge           — merge a worktree branch back to base
agent_pr              — create or update a GitHub PR for a worktree branch
agent_worktree_status — show worktree status and pending decisions
agent_worktree_cleanup— clean up merged agent/* branches
```

---

**When to use OpenClaw core ACP:** When you want ACP-native interoperability, built-in persistent ACP sessions, IDE/editor integration via `openclaw acp`, runtime controls (`session/set_mode`), or broader ACP backend coverage from core OpenClaw.

**When to use openclaw-code-agent:** When you want coding-agent orchestration rather than ACP compatibility: review/approve plans before execution (with inline Telegram buttons), revise them inline, fork and resume work with a persisted session catalog, track cost/stats, get explicit async notifications when work needs attention or completes, and manage git worktree isolation with automatic merge-back or PR creation.
