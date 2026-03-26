# OpenClaw Code Agent

[![npm version](https://img.shields.io/npm/v/openclaw-code-agent.svg)](https://www.npmjs.com/package/openclaw-code-agent)
[![npm downloads](https://img.shields.io/npm/dm/openclaw-code-agent.svg)](https://www.npmjs.com/package/openclaw-code-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An [OpenClaw](https://openclaw.com) plugin that lets AI agents orchestrate coding agent sessions as managed background processes. Launch, monitor, and interact with multiple concurrent coding sessions directly from Telegram, Discord, or any OpenClaw-supported messaging platform — without leaving your chat interface.

## Why?

This plugin started as a response to a real gap in OpenClaw's built-in ACP support. At the time, ACP was effectively a raw relay into ACP backends: useful for handing off a prompt, but without the orchestration layer needed for coding-agent work in chat. There was no plan review flow, no plugin-managed pause/resume model, no fork flow, no cost or session stats, and no async notification path back to the originating chat when a session needed input or finished.

ACP has improved since then. OpenClaw core ACP now supports multi-turn sessions, resuming prior work, and a broader set of ACP runtimes and harnesses. That closes part of the original gap.

What still remains is the orchestration layer this plugin was built to provide: propose/revise/approve plan review before execution, forkable coding sessions, dedicated session catalog + operator-facing stats, cost accounting, and an explicit async notification pipeline that wakes the origin chat only when the job needs attention or completes.

For the current version-pinned breakdown, see [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md).

## Demo
<img src="assets/ask-readme.gif" alt="Ask mode demo showing plan review and approval before execution">

*Plan review and approval in ask mode: the agent pauses for your decision before executing.*

### Autonomous mode (delegate)

<img src="assets/delegate-readme.gif" alt="Delegate mode demo showing autonomous execution with selective escalation">

*In delegate mode, the orchestrator auto-approves low-risk plans and only escalates when needed.*

## Supported Agents

| Agent | Status | Notes |
|-------|--------|-------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | ✅ Supported | Full support via `@anthropic-ai/claude-agent-sdk` |
| [Codex](https://github.com/openai/codex) | ✅ Supported | Full support via `@openai/codex-sdk` thread API |
| Other agents | 🚧 Planned | Plugin architecture supports adding new harnesses |

> **vs. built-in ACP?** See [docs/ACP-COMPARISON.md](docs/ACP-COMPARISON.md) for the current version-pinned breakdown.

---

## Features

- **Multi-session management** — Run multiple concurrent coding agent sessions, each with a unique ID and human-readable name
- **Plan → Execute workflow** — Claude Code sessions expose plan mode; Codex uses a soft first-turn planning prompt while staying externally in implement mode
- **Plan approval modes** — Three configurable modes (`ask` / `delegate` / `approve`) control how the orchestrator handles plan-approval events before execution
- **Real Codex approval policy support** — Codex sessions default to the real Codex SDK/CLI `approvalPolicy: "on-request"` and can be pinned back to `"never"` via `harnesses.codex.approvalPolicy`
- **Git worktree isolation** — Opt-in worktree support keeps main checkout clean; configurable strategies: `manual`, `ask`, `delegate`, `auto-merge`, `auto-pr`
- **Telegram inline buttons** — `ask` strategy sends inline keyboard buttons (Merge locally / Create PR / Dismiss) directly in chat; button taps route back to the plugin
- **PR lifecycle management** — `agent_pr` detects existing open/merged/closed PRs and updates instead of duplicating; full lifecycle handling via `gh` CLI
- **Conflict resolution** — Auto-merge conflicts spawn Claude Code conflict-resolver sessions automatically
- **Thread-based routing** — Notifications go to the Telegram thread/topic where the session was launched
- **Pause + auto-resume** — Non-question turn completion pauses sessions (`done`) and next `agent_respond` auto-resumes with context intact
- **Turn-end wake signaling** — Every turn end emits a deterministic wake signal with output preview and waiting hint
- **Smart waiting detection** — Heuristic waiting detector reduces false-positive wake escalations
- **Multi-turn conversations** — Send follow-up messages, interrupt, or iterate with a running agent
- **Session resume & fork** — Resume any completed session or fork it into a new conversation branch
- **Deliverable mode** — `output_mode: "deliverable"` switches from `✅ Completed` to `📄 Deliverable ready` for document/report generation tasks
- **Merged session listing** — `agent_sessions` shows active + persisted sessions in one view (deduped by internal session ID)
- **Pending MessageStream safety** — queued follow-ups are preserved across turn completion so messages are not dropped
- **Codex SDK streaming harness** — uses `@openai/codex-sdk` thread streaming with soft first-turn planning, waiting detection, and activity heartbeats
- **Multi-agent support** — Route notifications to the correct agent/chat via workspace-based channel mapping
- **Auto-respond rules** — Orchestrator auto-handles permission requests and confirmations; forwards real decisions to you
- **Anti-cascade protection** — Orchestrator never launches new sessions from wake events
- **Startup recovery** — Orphaned worktrees and crashed running-state sessions are automatically cleaned up on gateway restart
- **Automatic cleanup** — Completed sessions are garbage-collected after a configurable TTL (`sessionGcAgeMinutes`, default 24h); IDs persist for resume
- **Harness-agnostic architecture** — Pluggable `AgentHarness` interface allows adding new coding agent backends

---

## Compatibility

| Plugin version | OpenClaw version |
|---|---|
| 2.3.x | >=2026.3.13 |
| 2.4.x | >=2026.3.22 |

Tested against OpenClaw v2026.3.23. The plugin uses CLI-based integration and is unaffected by OpenClaw plugin SDK surface changes.

**Codex model options (v2026.3.22+):** In addition to the default `gpt-5.4`, you can configure `gpt-5.4-mini` or `gpt-5.4-nano` in `harnesses.codex.allowedModels` for lower-cost Codex sessions.

---

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install openclaw-code-agent
openclaw plugins enable openclaw-code-agent
openclaw gateway restart
```

### 2. Configure notifications

Add to `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-code-agent"]`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-code-agent": {
        "enabled": true,
        "config": {
          "fallbackChannel": "telegram|my-bot|123456789",
          "maxSessions": 20,
          "harnesses": {
            "codex": {
              "defaultModel": "gpt-5.4",
              "allowedModels": ["gpt-5.4"],
              "reasoningEffort": "medium",
              "approvalPolicy": "on-request"
            },
            "claude-code": {
              "defaultModel": "sonnet",
              "allowedModels": ["sonnet", "opus"]
            }
          }
        }
      }
    }
  }
}
```

Replace `my-bot` with your Telegram bot account name and `123456789` with your Telegram chat ID.

### 2a. Codex auth safety

If you run Codex sessions, strongly recommend forcing ChatGPT login in your Codex config:

```toml
forced_login_method = "chatgpt"
```

Put that in `~/.codex/config.toml`. This keeps Codex on the ChatGPT auth path and avoids account/login mismatches that can surface as unsupported-model or auth failures.

### 3. Typical workflow

1. Ask your agent: *"Fix the bug in auth.ts"*
2. A coding agent session launches and explores the task. Claude Code exposes **plan mode**; Codex can do a plan-first turn without surfacing plan mode in session status
3. The agent's questions and plan appear in the **same Telegram thread** where you launched
4. When a session is awaiting plan approval, approve it with `agent_respond(..., approve=true)` and the session switches to implement mode
5. The agent implements with full permissions, then you get a brief completion summary

---

## Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `agent_launch` | Start a new coding agent session in background | `prompt`, `name`, `workdir`, `model`, `resume_session_id`, `fork_session`, `permission_mode`, `harness`, `worktree_strategy`, `output_mode` |
| `agent_respond` | Send a follow-up message to a running session | `session`, `message`, `interrupt`, `approve`, `userInitiated` |
| `agent_kill` | Terminate or complete a running session | `session`, `reason` |
| `agent_output` | Read buffered output from a session | `session`, `lines`, `full` |
| `agent_sessions` | List recent sessions (5 by default, `full` for 24h view) | `status`, `full` |
| `agent_stats` | Show usage metrics (counts, durations, costs) | *(none)* |
| `agent_merge` | Merge a worktree branch back to base branch | `session`, `base_branch`, `strategy`, `push`, `delete_branch` |
| `agent_pr` | Create or update a GitHub PR for a worktree branch (full lifecycle) | `session`, `title`, `body`, `base_branch`, `force_new` |
| `agent_worktree_status` | Show worktree status for sessions | `session` (optional) |
| `agent_worktree_cleanup` | Clean up merged agent/* branches | `workdir`, `base_branch`, `skip_session_check`, `dry_run`, `session` |

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

# Approve a pending plan (tool call)
agent_respond(session='fix-auth', message='Approved. Go ahead.', approve=true)

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
| ❓ | Waiting for input | Session is waiting for user input |
| 📋 | Plan ready | Plan approval requested — reply "go" to approve |
| ⏸️ | Paused after turn | Turn completed, session paused (auto-resumable) |
| ↪️ | Responded / Redirected | `agent_respond` sent a message; also fires when `interrupt: true` redirects active work |
| 👍 | Plan approved | Plan was approved via `agent_respond(..., approve: true)` |
| ▶️ | Auto-resumed | Session resumed on the next `agent_respond` |
| ✅ | Completed | Completion summary with cost and duration |
| 📄 | Deliverable ready | Session finished with `output_mode: "deliverable"` |
| ❌ | Failed | Error notification with `harnessSessionId` and resume guidance |
| 💤 | Idle timeout | Session timed out while waiting; auto-resumes on next respond |
| ⛔ | Stopped | Session was stopped by user, shutdown, or another forced stop |
| 🔀 | Worktree decision (`ask`) | Telegram inline buttons sent: Merge locally / Create PR / Dismiss |
| 🤖 | Worktree decision (`delegate`) | Wake sent to orchestrator with diff context for autonomous decision |

---

## Plan → Execute Mode Switch

- **Claude Code** starts in `plan` mode by default. Approve a pending plan with `agent_respond(..., approve=true)` and the session switches to `bypassPermissions`.
- **Codex** does not surface `plan` or `awaiting-plan-approval` in session state. When launched with `permissionMode: "plan"`, its first turn is prompted to return a plan and ask whether to proceed, while the exposed session phase remains implementation-oriented.
- For **Codex**, plugin `permissionMode` is a plugin-orchestrated planning/approval workflow. It is not the same thing as the Codex SDK/CLI `approvalPolicy`.
- The real Codex SDK/CLI approval behavior is controlled by `harnesses.codex.approvalPolicy`. Supported values are `"on-request"` (default) and `"never"`.

On approval, the plugin prepends a system instruction telling the agent to exit plan mode and implement with full permissions.

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

Set values in `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-code-agent"].config`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentChannels` | `object` | — | Map workdir paths → notification channels (see [docs/AGENT_CHANNELS.md](docs/AGENT_CHANNELS.md)) |
| `fallbackChannel` | `string` | — | Default notification channel when no workspace match found |
| `maxSessions` | `number` | `20` | Maximum concurrent sessions |
| `maxAutoResponds` | `number` | `10` | Max consecutive auto-responds before requiring user input |
| `permissionMode` | `string` | `"plan"` | Plugin orchestration mode: `"default"` (standard prompts) / `"plan"` (present plan first) / `"bypassPermissions"` (fully autonomous) |
| `idleTimeoutMinutes` | `number` | `15` | Idle timeout before auto-kill |
| `sessionGcAgeMinutes` | `number` | `1440` | TTL for completed/failed/killed runtime sessions before GC eviction |
| `maxPersistedSessions` | `number` | `10000` | Max completed sessions kept for resume; the 24h GC TTL (`sessionGcAgeMinutes`) is the primary retention control |
| `planApproval` | `string` | `"ask"` | `"ask"` (always forward to user) / `"delegate"` (orchestrator decides) / `"approve"` (orchestrator can auto-approve) |
| `defaultHarness` | `string` | `"claude-code"` | Default harness for new sessions (`"claude-code"` / `"codex"`) |
| `harnesses` | `object` | built-in defaults | Per-harness defaults and restrictions. Built-in defaults: `claude-code.defaultModel = "sonnet"`, `claude-code.allowedModels = ["sonnet","opus"]`, `codex.defaultModel = "gpt-5.4"`, `codex.allowedModels = ["gpt-5.4"]`, `codex.reasoningEffort = "medium"`, `codex.approvalPolicy = "on-request"` |
| `defaultWorkdir` | `string` | — | Default working directory for new sessions |
| `defaultWorktreeStrategy` | `string` | `"ask"` | Default worktree strategy for new sessions when `worktree_strategy` is omitted from `agent_launch`. Accepts any `WorktreeStrategy` value including `"delegate"` |
| `worktreeDir` | `string` | `<repoRoot>/.worktrees` | Override base directory for agent worktrees |

Out of the box (with no custom config), the plugin delivers the full interactive experience: `planApproval: "ask"` ensures every plan is forwarded to the user for review before execution, and `defaultWorktreeStrategy: "ask"` means every session runs in an isolated git worktree and presents inline Telegram buttons (Merge locally / Create PR / Dismiss) on completion. Set either to `"delegate"` to hand those decisions to the orchestrator autonomously.

### Permission Mode Mapping By Harness

Permission modes are shared at the plugin API, but each harness maps them differently:

- **Claude Code harness**
  - `default`, `plan`, `bypassPermissions` are passed through the SDK
- **Codex harness**
  - Always runs with SDK thread option `sandboxMode: "danger-full-access"`
  - Uses Codex SDK/CLI `approvalPolicy: "on-request"` by default, or `"never"` when `harnesses.codex.approvalPolicy` is set
  - Supports `harnesses.codex.defaultModel`, `harnesses.codex.allowedModels`, `harnesses.codex.reasoningEffort`, and `harnesses.codex.approvalPolicy`
  - In `bypassPermissions`, the harness adds filesystem root (`/` on POSIX) to Codex `additionalDirectories`, plus optional extras from `OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS` (comma-separated)
  - `setPermissionMode()` is applied by recreating the thread on the next turn via `resumeThread` (same thread ID)
  - `plan` remains a plugin behavioral orchestration constraint (planning/approval flow), not a Codex sandbox or SDK approval setting

### Runtime Environment Overrides

- `OPENCLAW_CODE_AGENT_SESSIONS_PATH` — explicit persisted session index path
- `OPENCLAW_HOME` — base dir for persisted session index when explicit path is unset (`$OPENCLAW_HOME/code-agent-sessions.json`)
- `OPENCLAW_WORKTREE_DIR` — base directory for worktrees (default: system tmpdir)
- `OPENCLAW_WORKTREE_BASE_BRANCH` — global base branch override (default: auto-detected from repo)
- `OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS` — age threshold for orphan worktree cleanup (default: 1 hour)
- `OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS` — comma-separated extra directories for Codex bypass mode
- `OPENCLAW_CODEX_HEARTBEAT_MS` — Codex activity heartbeat interval in milliseconds (default `10000`)

### Session Lifecycle + GC

- Active sessions live in runtime memory (`SessionManager.sessions`)
- Terminal sessions are persisted with metadata/output stubs for resume and listing
- Runtime records are evicted after `sessionGcAgeMinutes` (default 1440 / 24h)
- Eviction means **removed from runtime cache**, not deleted permanently; persisted session records remain resumable

### Discord Notifications

To route notifications to a Discord channel or user, set `originChannel` (or `fallbackChannel`) using the Discord format:

```
discord|channel:CHANNEL_ID
discord|accountId|channel:CHANNEL_ID
```

- Use `channel:CHANNEL_ID` for a server channel, or `user:USER_ID` for a DM.
- The `accountId` segment is optional and selects a specific Discord bot account when you have multiple Discord integrations.
- Discord session keys (`agent:*:discord:channel:ID`) are auto-parsed — no explicit `originChannel` is required when a session is launched from a Discord thread.
- If using bot notifications, set `allowBots: "mentions"` in your OpenClaw Discord integration config so the bot is permitted to receive and forward mention events.

Example `fallbackChannel` for Discord:

```json
"fallbackChannel": "discord|channel:1234567890123456789"
```

With an explicit account:

```json
"fallbackChannel": "discord|my-discord-bot|channel:1234567890123456789"
```

### Git Worktree Support

When `worktree_strategy` is set to anything other than `"off"` (via `agent_launch` or plugin config `defaultWorktreeStrategy`), the agent will automatically create a git worktree for the session if the `workdir` is a git repository. This keeps the main checkout clean while the agent works in an isolated branch.

**Behavior:**
- Worktree path: `<OPENCLAW_WORKTREE_DIR>/openclaw-worktree-<session-name>` (default: system tmpdir)
- Branch name: `agent/<session-name>` (sanitized, with random suffix if needed)
- Worktrees are automatically cleaned up when the session terminates
- **Branches are kept** — `agent/<name>` branches persist after session cleanup to allow pushing commits
- Base branch auto-detection: `OPENCLAW_WORKTREE_BASE_BRANCH` env var → origin/HEAD → main → master

**Worktree Strategies:**

Control what happens to worktree branches when a session completes via `worktree_strategy`. Set it per-launch in `agent_launch`, or set a default for all sessions via `defaultWorktreeStrategy` in plugin config.

- **`ask`** (plugin config default) — Push branch and send a Telegram notification with inline buttons (Merge locally / Create PR / Dismiss). Also wakes the orchestrator with full decision context (diff summary, original prompt, decision guidance) to present the choice to the user.
- **`off`** — No worktree. Session runs in the main checkout.
- **`manual`** — Create worktree but no automatic action. Branch is kept for manual handling via `agent_merge` or `agent_pr`.
- **`delegate`** — Push branch and wake the orchestrator with full decision context. The orchestrator autonomously decides to merge, open a PR, or escalate to the user. Always sends a brief one-line notification to the user. **Available via `defaultWorktreeStrategy` plugin config; not exposed as a `worktree_strategy` tool parameter.**
- **`auto-merge`** — Automatically merge to base branch and push. On conflicts, spawns a Claude Code conflict-resolver session.
- **`auto-pr`** — Automatically create/update GitHub PR with full lifecycle management (requires `gh` CLI). If `gh` is unavailable, falls back to `ask` strategy.

Example with auto-pr:
```javascript
agent_launch({
  prompt: "Fix the auth bug",
  worktree_strategy: "auto-pr"
})
```

**`output_mode: "deliverable"`:**

Use this when the session is producing a document, report, or artifact rather than a code change. Instead of the default `✅ Completed` notification, the session emits `📄 Deliverable ready`:

```javascript
agent_launch({
  prompt: "Write a technical spec for the new auth system",
  output_mode: "deliverable"
})
```

**Merge-Back Tools:**

Four tools are available for manual worktree management:

- `agent_merge` — Merge a worktree branch to base branch. On conflicts, spawns conflict-resolver session.
- `agent_pr` — Create or update a GitHub PR for a worktree branch (requires `gh` CLI). Handles full PR lifecycle: creates new PRs, updates existing open PRs with comments, detects merged/closed PRs.
- `agent_worktree_status` — Show worktree status for sessions (branch name, commits ahead, merge/PR status).
- `agent_worktree_cleanup` — List and delete merged `agent/*` branches. Use `dry_run: true` to preview, `force: true` to delete all agent branches regardless of merge status.

**PR Lifecycle Management:**

When using `auto-pr` strategy or calling `agent_pr` manually:

- **No PR exists**: Creates a new PR with auto-generated title and commit summary
- **Open PR exists**: Pushes new commits and adds a detailed comment with diff stats
- **Merged PR**: Notifies that the PR was already merged
- **Closed PR**: Prompts user to choose: reopen manually, delete branch, or recreate PR

**Conflict Resolution:**

When auto-merge encounters conflicts, a Claude Code session is automatically spawned with `bypassPermissions` to resolve conflicts and commit the resolution. You'll receive a notification when this happens.

**Cleanup:**
Users can manually prune accumulated agent branches with `agent_worktree_cleanup`. Three categories are always protected from deletion: branches with active sessions, branches with unmerged commits, and branches with open PRs.

```javascript
// Preview what would be deleted
agent_worktree_cleanup({ workdir: "/path/to/repo", dry_run: true })

// Delete fully merged branches (unmerged and open-PR branches are always kept)
agent_worktree_cleanup({ workdir: "/path/to/repo" })

// Skip the active-session check (e.g. session crashed and left a stale branch)
// NOTE: unmerged-commit and open-PR protections still apply
agent_worktree_cleanup({ workdir: "/path/to/repo", skip_session_check: true })

// Dismiss a pending worktree decision for a session without merging
agent_worktree_cleanup({ session: "fix-auth-bug" })
```

**Environment Variables:**
- `OPENCLAW_WORKTREE_DIR` — Base directory for worktrees (default: system tmpdir)
- `OPENCLAW_WORKTREE_BASE_BRANCH` — Global base branch override (default: auto-detected)
- `OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS` — Age threshold for orphan worktree cleanup (default: 1 hour)

**Limitations:**
- Worktree creation requires the workdir to be a git repository
- Only works with committed changes — uncommitted changes in the main checkout are not transferred to the worktree
- Worktree creation is enabled by default via `defaultWorktreeStrategy: "ask"`. Pass `worktree_strategy: "off"` to `agent_launch` (or set `defaultWorktreeStrategy: "off"` in plugin config) to disable
- Push and PR operations (`ask`, `auto-pr`, `delegate`) require a configured remote

### Example

```json
{
  "plugins": {
    "entries": {
      "openclaw-code-agent": {
        "enabled": true,
        "config": {
          "maxSessions": 3,
          "harnesses": {
            "codex": {
              "defaultModel": "gpt-5.4",
              "allowedModels": ["gpt-5.4"],
              "reasoningEffort": "high",
              "approvalPolicy": "on-request"
            },
            "claude-code": {
              "defaultModel": "sonnet",
              "allowedModels": ["sonnet", "opus"]
            }
          },
          "permissionMode": "plan",
          "fallbackChannel": "telegram|my-bot|123456789",
          "agentChannels": {
            "/home/user/project-alpha": "telegram|my-bot|123456789",
            "/home/user/project-beta": "telegram|ops-bot|987654321"
          }
        }
      }
    }
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
│   ├── tools/                  # Tool implementations (9 tools)
│   └── commands/               # Chat command implementations (7 commands)
├── tests/                      # Unit tests (node:test + tsx)
├── skills/                     # Orchestration skill definitions
└── docs/                       # Architecture & reference docs
```

---

## Troubleshooting

- Plugin installed but the gateway does not see it yet: run `openclaw gateway restart`.
- Notifications are not arriving: verify `fallbackChannel` uses the exact format `"telegram|bot-name|chat-id"` in `~/.openclaw/openclaw.json`.

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
