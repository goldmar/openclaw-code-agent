# OpenClaw Code Agent

An [OpenClaw](https://openclaw.com) plugin that lets AI agents orchestrate coding agent sessions as managed background processes. Launch, monitor, and interact with multiple concurrent coding sessions directly from Telegram, Discord, or any OpenClaw-supported messaging platform — without leaving your chat interface.

## Supported Agents

| Agent | Status | Notes |
|-------|--------|-------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | ✅ Supported | Full support via `@anthropic-ai/claude-agent-sdk` |
| [Codex](https://github.com/openai/codex) | ✅ Supported | Full support via `@openai/codex-sdk` thread API |
| Other agents | 🚧 Planned | Plugin architecture supports adding new harnesses |

> **vs. built-in ACP?** See [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md) for a full breakdown.

---

## Features

- **Multi-session management** — Run multiple concurrent coding agent sessions, each with a unique ID and human-readable name
- **Plan → Execute workflow** — Sessions start in plan mode; approve the plan and the session auto-switches to full implementation mode
- **Thread-based routing** — Notifications go to the Telegram thread/topic where the session was launched
- **Pause + auto-resume** — Non-question turn completion pauses sessions (`done`) and next `agent_respond` auto-resumes with context intact
- **Turn-end wake signaling** — Every turn end emits a deterministic wake signal with output preview and waiting hint
- **Smart waiting detection** — Heuristic waiting detector reduces false-positive wake escalations
- **Multi-turn conversations** — Send follow-up messages, interrupt, or iterate with a running agent
- **Session resume & fork** — Resume any completed session or fork it into a new conversation branch
- **Merged session listing** — `agent_sessions` shows active + persisted sessions in one view (deduped by internal session ID)
- **Pending MessageStream safety** — queued follow-ups are preserved across turn completion so messages are not dropped
- **Codex SDK streaming harness** — uses `@openai/codex-sdk` thread streaming with synthetic plan/waiting events and activity heartbeats
- **Multi-agent support** — Route notifications to the correct agent/chat via workspace-based channel mapping
- **Auto-respond rules** — Orchestrator auto-handles permission requests and confirmations; forwards real decisions to you
- **Anti-cascade protection** — Orchestrator never launches new sessions from wake events
- **Automatic cleanup** — Completed sessions are garbage-collected after a configurable TTL (`sessionGcAgeMinutes`, default 24h); IDs persist for resume
- **Harness-agnostic architecture** — Pluggable `AgentHarness` interface allows adding new coding agent backends

---

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install openclaw-code-agent
openclaw gateway restart
```

### 2. Configure notifications

Add to `~/.openclaw/openclaw.json` under `plugins.config["openclaw-code-agent"]`:

```json
{
  "fallbackChannel": "telegram|my-bot|123456789",
  "maxSessions": 5
}
```

Replace `my-bot` with your Telegram bot account name and `123456789` with your Telegram chat ID.

### 3. Typical workflow

1. Ask your agent: *"Fix the bug in auth.ts"*
2. A coding agent session launches in **plan mode** — the agent explores and proposes a plan
3. The agent's questions and plan appear in the **same Telegram thread** where you launched
4. Reply with "looks good" or "go ahead" — the session **auto-switches to implement mode**
5. The agent implements with full permissions, then you get a brief completion summary

---

## Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `agent_launch` | Start a new coding agent session in background | `prompt`, `name`, `workdir`, `model`, `resume_session_id`, `fork_session`, `permission_mode`, `harness`, `notify_on_turn_end` |
| `agent_respond` | Send a follow-up message to a running session | `session`, `message`, `interrupt`, `approve`, `userInitiated` |
| `agent_kill` | Terminate or complete a running session | `session`, `reason` |
| `agent_output` | Read buffered output from a session | `session`, `lines`, `full` |
| `agent_sessions` | List recent sessions (5 by default, `full` for 24h view) | `status`, `full` |
| `agent_stats` | Show usage metrics (counts, durations, costs) | *(none)* |

Core orchestration workflows use `agent_launch`, `agent_respond`, `agent_output`, `agent_sessions`, and `agent_kill`.

All tools are also available as **chat commands** (`/agent`, `/agent_respond`, `/agent_kill`, `/agent_sessions`, `/agent_resume`, `/agent_stats`, `/agent_output`).

---

## Usage Examples

```bash
# Launch a session (starts in plan mode by default)
/agent Fix the authentication bug in src/auth.ts
/agent --name fix-auth Fix the authentication bug

# Monitor
/agent_sessions
/agent_sessions --full

# Interact with a running session
/agent_respond fix-auth Also add unit tests
/agent_respond --interrupt fix-auth Stop that and do this instead

# Approve a plan (auto-switches to implement mode)
/agent_respond fix-auth looks good

# Lifecycle management
/agent_kill fix-auth
/agent_resume fix-auth Add error handling
/agent_resume --fork fix-auth Try a different approach
/agent_stats
```

---

## Notifications

The plugin sends targeted notifications to the originating Telegram thread:

| Emoji | Event | Description |
|-------|-------|-------------|
| 🚀 | Launched | Session started with prompt summary |
| 🔔 | Agent asks | Session is waiting for user input |
| 📋 | Plan ready | Plan approval requested — reply "go" to approve |
| 🔄 | Turn done | Turn completed, session paused (auto-resumable) |
| ✅ | Completed | Completion summary with cost and duration |
| ❌ | Failed | Error notification with hint |
| ⛔ | Killed | Session terminated with kill reason |
| 💤 | Idle-killed | Auto-resumes on next respond |

---

## Plan → Execute Mode Switch

Sessions start in `plan` mode by default. When you reply with an approval keyword (case-insensitive), the session automatically switches to `bypassPermissions` mode:

> `go ahead`, `implement`, `looks good`, `approved`, `lgtm`, `do it`, `proceed`, `execute`, `ship it`

The switch prepends a system instruction telling the agent to exit plan mode and implement with full permissions. No manual mode switching needed.

---

## Auto-Respond Rules

The orchestrator agent follows strict auto-respond rules to minimize noise:

**Auto-respond (immediate):**
- Permission requests (file read/write/bash) → "Yes, proceed."
- Explicit "should I continue?" confirmations → "Yes, continue."

**Forward to user (everything else):**
- Architecture/design decisions
- Destructive operations
- Scope changes
- Credential/production questions
- Any ambiguous or non-trivial question

When forwarding, the orchestrator quotes the agent's exact question without adding its own commentary.

---

## Configuration

Set values in `~/.openclaw/openclaw.json` under `plugins.config["openclaw-code-agent"]`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentChannels` | `object` | — | Map workdir paths → notification channels (see [docs/AGENT_CHANNELS.md](docs/AGENT_CHANNELS.md)) |
| `fallbackChannel` | `string` | — | Default notification channel when no workspace match found |
| `maxSessions` | `number` | `5` | Maximum concurrent sessions |
| `maxAutoResponds` | `number` | `10` | Max consecutive auto-responds before requiring user input |
| `permissionMode` | `string` | `"plan"` | `"default"` / `"plan"` / `"acceptEdits"` / `"bypassPermissions"` |
| `idleTimeoutMinutes` | `number` | `15` | Idle timeout before auto-kill |
| `sessionGcAgeMinutes` | `number` | `1440` | TTL for completed/failed/killed runtime sessions before GC eviction |
| `maxPersistedSessions` | `number` | `50` | Max completed sessions kept for resume |
| `planApproval` | `string` | `"delegate"` | `"approve"` (orchestrator can auto-approve) / `"ask"` (always forward to user) / `"delegate"` (orchestrator decides) |
| `defaultHarness` | `string` | `"claude-code"` | Default harness for new sessions (`"claude-code"` / `"codex"`) |
| `defaultModel` | `string` | — | Default model for new sessions (e.g. `"sonnet"`, `"opus"`) |
| `defaultWorkdir` | `string` | — | Default working directory for new sessions |

### Permission Mode Mapping By Harness

Permission modes are shared at the plugin API, but each harness maps them differently:

- **Claude Code harness**
  - `default`, `plan`, `acceptEdits`, `bypassPermissions` are passed through the SDK
- **Codex harness**
  - Always runs with SDK thread options `sandboxMode: "danger-full-access"` and `approvalPolicy: "never"`
  - In `bypassPermissions`, the harness adds filesystem root (`/` on POSIX) to Codex `additionalDirectories`, plus optional extras from `OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS` (comma-separated)
  - `setPermissionMode()` is applied by recreating the thread on the next turn via `resumeThread` (same thread ID)
  - `plan` / `acceptEdits` remain behavioral orchestration constraints (planning/approval flow), not sandbox restrictions

### Runtime Environment Overrides

- `OPENCLAW_CODE_AGENT_SESSIONS_PATH` — explicit persisted session index path
- `OPENCLAW_HOME` — base dir for persisted session index when explicit path is unset (`$OPENCLAW_HOME/code-agent-sessions.json`)
- `OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS` — comma-separated extra directories for Codex bypass mode
- `OPENCLAW_CODEX_HEARTBEAT_MS` — Codex activity heartbeat interval in milliseconds (default `10000`)

### `notify_on_turn_end` (`notifyOnTurnEnd`)

`agent_launch` accepts `notify_on_turn_end` (default `true`). When `false`, turn-end wake notifications are suppressed for that session.  
Internal config field: `notifyOnTurnEnd`.

### Session Lifecycle + GC

- Active sessions live in runtime memory (`SessionManager.sessions`)
- Terminal sessions are persisted with metadata/output stubs for resume and listing
- Runtime records are evicted after `sessionGcAgeMinutes` (default 1440 / 24h)
- Eviction means **removed from runtime cache**, not deleted permanently; persisted session records remain resumable

### Example

```json
{
  "maxSessions": 3,
  "defaultModel": "sonnet",
  "permissionMode": "plan",
  "fallbackChannel": "telegram|my-bot|123456789",
  "agentChannels": {
    "/home/user/project-alpha": "telegram|my-bot|123456789",
    "/home/user/project-beta": "telegram|ops-bot|987654321"
  }
}
```

---

## Orchestration Skill

<details>
<summary>Example orchestration skill (click to expand)</summary>

The plugin is a **transparent transport layer** — business logic lives in **OpenClaw skills**:

```markdown
---
name: Coding Agent Orchestrator
description: Orchestrates coding agent sessions with auto-response rules.
metadata: {"openclaw": {"requires": {"plugins": ["openclaw-code-agent"]}}}
---

# Coding Agent Orchestrator

## Anti-cascade rule
When woken by a waiting-for-input or completion event, ONLY use agent_respond
or agent_output for the referenced session. NEVER launch new sessions from wake events.

## Auto-response rules

When a coding agent session asks a question, analyze and decide:

### Auto-respond (use `agent_respond` immediately):
- Permission requests for file reads, writes, or bash commands -> "Yes, proceed."
- Confirmations like "Should I continue?" -> "Yes, continue."

### Forward to user (everything else):
- Architecture decisions, destructive operations, ambiguous requirements,
  scope changes, credential/production questions
- Quote the agent's exact question. No commentary.

## Workflow
1. User sends a coding task -> `agent_launch(prompt, ...)`
2. Session runs in background. Monitor via wake events.
3. On wake event -> `agent_output` to read the question, then auto-respond or forward.
4. On completion -> summarize briefly: files changed, cost, duration, issues.
```

A comprehensive orchestration skill is available at [`skills/code-agent-orchestration/SKILL.md`](skills/code-agent-orchestration/SKILL.md).

</details>

---

## Architecture

For a detailed look at how the plugin works internally, see the [docs/](docs/) directory:

| Document | Description |
|----------|-------------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, component breakdown, and data flow |
| [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | Notification architecture, delivery model, and wake mechanism |
| [docs/AGENT_CHANNELS.md](docs/AGENT_CHANNELS.md) | Multi-agent setup, notification routing, and workspace mapping |
| [docs/TOOLS.md](docs/TOOLS.md) | Detailed tool reference with parameters and examples |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Development guide, project structure, and build instructions |

---

## Development

Build output is an **ESM bundle** at `dist/index.js` (`package.json` has `"type": "module"`).

```bash
# Install dependencies
pnpm install

# Build (esbuild → dist/index.js)
pnpm run build

# Type-check
pnpm run typecheck

# Run tests
pnpm test
```

### Project Structure

```
openclaw-code-agent/
├── index.ts                    # Plugin entry point
├── openclaw.plugin.json        # Plugin manifest & config schema
├── src/
│   ├── harness/                # Agent harness abstraction layer
│   │   ├── types.ts            # AgentHarness interface & message types
│   │   ├── claude-code.ts      # Claude Code harness (SDK wrapper)
│   │   ├── codex.ts            # Codex harness (@openai/codex-sdk thread stream wrapper)
│   │   └── index.ts            # Harness registry
│   ├── types.ts                # TypeScript interfaces
│   ├── config.ts               # Config singleton + channel resolution
│   ├── format.ts               # Formatting utilities
│   ├── singletons.ts           # Module-level singleton refs
│   ├── session.ts              # Session class (state machine, timers, harness)
│   ├── session-manager.ts      # Session pool management + lifecycle
│   ├── session-store.ts        # Persisted session/index storage abstraction
│   ├── session-metrics.ts      # Metrics recorder abstraction
│   ├── wake-dispatcher.ts      # Wake delivery + retry abstraction
│   ├── notifications.ts        # Notification service
│   ├── actions/respond.ts      # Shared respond logic (tool + command)
│   ├── application/            # Shared app-layer logic used by tools + commands
│   ├── tools/                  # Tool implementations (6 tools)
│   └── commands/               # Chat command implementations (7 commands)
├── tests/                      # Unit tests (node:test + tsx)
├── skills/                     # Orchestration skill definitions
└── docs/                       # Architecture & reference docs
```

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

---

## License

MIT — see [LICENSE](LICENSE) for details.

Originally based on [alizarion/openclaw-claude-code-plugin](https://github.com/alizarion/openclaw-claude-code-plugin). Renamed to `openclaw-code-agent` to be harness-agnostic.
