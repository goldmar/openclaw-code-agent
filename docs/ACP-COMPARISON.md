# openclaw-code-agent: Coding-Agent orchestration for OpenClaw

> The dedicated OpenClaw plugin for Claude Code and Codex — more powerful than the built-in ACP integration.
> https://github.com/goldmar/openclaw-code-agent

---

## Built-in ACP vs. openclaw-code-agent

| Feature | Built-in ACP | openclaw-code-agent |
|---------|-------------|----------------------|
| Launch coding-agent sessions | ✅ | ✅ |
| Multi-turn sessions | ❌ | ✅ Fully resumable |
| Plan mode (propose before coding) | ❌ | ✅ Native support |
| Approve / revise plans inline | ❌ | ✅ `approve=true` or send feedback |
| Session persistence across restarts | ❌ | ✅ Serialized to disk |
| Parallel sessions | ❌ | ✅ Unlimited concurrent sessions |
| Stream live output mid-session | ❌ | ✅ `agent_output` anytime |
| Auto-respond rules | ❌ | ✅ Define autonomy level per session |
| Cost tracking per session | ❌ | ✅ USD, per-session |
| Session history & stats | ❌ | ✅ `agent_sessions`, `agent_stats` |
| Resume a previous session by ID | ❌ | ✅ Full history preserved |
| Fork a session to explore alternatives | ❌ | ✅ |
| Multiple harness backends | ❌ | ✅ Claude Code + Codex |

---

## The difference in practice

The built-in ACP is a **relay bridge** — it connects your OpenClaw agent to Claude Code CLI. Great for simple one-shot tasks.

`openclaw-code-agent` is a **full orchestration layer**:

```
You: Build a REST API for todos

Alice → agent_launch(prompt="...", permission_mode="plan")

[Claude Code proposes plan: 5 files, REST endpoints, PostgreSQL]

Alice: Here's the plan — want any changes?
You: Add rate limiting

Alice → agent_respond(session, "Add rate limiting to all endpoints")
Alice → agent_respond(session, approve=true)  // once revised

[Claude Code implements — silently, in the background]
[You get a notification when it's done]
```

No babysitting. No copy-pasting. Full async, full control.

---

## Tool surface

```
agent_launch     — start a session (background)
agent_respond    — reply mid-session or approve a plan
agent_output     — stream live output
agent_sessions   — list all active/recent sessions
agent_kill       — terminate a session
agent_stats      — usage metrics and costs
```

---
