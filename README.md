# OpenClaw Code Agent

An [OpenClaw](https://openclaw.com) plugin that lets AI agents orchestrate coding agent sessions as managed background processes. Launch, monitor, and interact with multiple concurrent coding sessions directly from Telegram, Discord, or any OpenClaw-supported messaging platform — without leaving your chat interface.

## Supported Agents

| Agent | Status | Notes |
|-------|--------|-------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | ✅ Supported | Full support via `@anthropic-ai/claude-agent-sdk` |
| [Codex](https://github.com/openai/codex) | 🚧 Planned | — |
| Other agents | 🚧 Planned | Plugin architecture supports adding new harnesses |

> **vs. built-in ACP?** See [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md) for a full breakdown.

---

## Features

- **Multi-session management** — Run multiple concurrent coding agent sessions, each with a unique ID and human-readable name
- **Plan → Execute workflow** — Sessions start in plan mode; approve the plan and the session auto-switches to full implementation mode
- **Thread-based routing** — Notifications go to the Telegram thread/topic where the session was launched
- **Idle-kill + auto-resume** — Sessions auto-complete after idle timeout, then seamlessly auto-resume with full conversation context on next message
- **Smart question detection** — Only notifies when the agent actually asks a question, not on every turn end
- **Multi-turn conversations** — Send follow-up messages, interrupt, or iterate with a running agent
- **Session resume & fork** — Resume any completed session or fork it into a new conversation branch
- **Multi-agent support** — Route notifications to the correct agent/chat via workspace-based channel mapping
- **Auto-respond rules** — Orchestrator auto-handles permission requests and confirmations; forwards real decisions to you
- **Anti-cascade protection** — Orchestrator never launches new sessions from wake events
- **Automatic cleanup** — Completed sessions garbage-collected after 1 hour; IDs persist for resume
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

| Tool | Description |
|------|-------------|
| `agent_launch` | Start a new coding agent session in background |
| `agent_respond` | Send a follow-up message to a running session |
| `agent_kill` | Terminate a running session |
| `agent_output` | Read buffered output from a session |
| `agent_sessions` | List all sessions with status and progress |
| `agent_stats` | Show usage metrics (counts, durations, costs) |

All tools are also available as **chat commands** (`/agent`, `/agent_respond`, `/agent_kill`, `/agent_sessions`, `/agent_resume`, `/agent_stats`).

---

## Usage Examples

```bash
# Launch a session (starts in plan mode by default)
/agent Fix the authentication bug in src/auth.ts
/agent --name fix-auth Fix the authentication bug

# Monitor
/agent_sessions

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
| 🔄 | Turn done | Turn completed, session still running |
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
| `idleTimeoutMinutes` | `number` | `30` | Idle timeout before auto-kill |
| `postTurnIdleMinutes` | `number` | `5` | Minutes after turn completes before session auto-completes |
| `maxPersistedSessions` | `number` | `50` | Max completed sessions kept for resume |
| `planApproval` | `string` | `"delegate"` | `"approve"` (orchestrator can auto-approve) / `"ask"` (always forward to user) / `"delegate"` (orchestrator decides) |
| `defaultModel` | `string` | — | Default model for new sessions (e.g. `"sonnet"`, `"opus"`) |
| `defaultWorkdir` | `string` | — | Default working directory for new sessions |

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

```bash
# Install dependencies
npm install

# Build (esbuild → dist/index.js)
npm run build

# Type-check
npx tsc --noEmit

# Run tests
npm test
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
│   │   └── index.ts            # Harness registry
│   ├── types.ts                # TypeScript interfaces
│   ├── config.ts               # Config singleton + channel resolution
│   ├── format.ts               # Formatting utilities
│   ├── singletons.ts           # Module-level singleton refs
│   ├── session.ts              # Session class (state machine, timers, harness)
│   ├── session-manager.ts      # Session pool management + lifecycle
│   ├── notifications.ts        # Notification service
│   ├── actions/respond.ts      # Shared respond logic (tool + command)
│   ├── tools/                  # Tool implementations (6 tools)
│   └── commands/               # Chat command implementations (6 commands)
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
