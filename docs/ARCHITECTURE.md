# Architecture — OpenClaw Code Agent

## Overview

OpenClaw plugin that enables AI agents to orchestrate coding agent sessions from messaging channels (Telegram, Discord, Rocket.Chat). Agents can spawn, monitor, resume, and manage coding agent processes as background development tasks.

## System Context

```
User (Telegram/Discord) → OpenClaw Gateway → Agent → Plugin Tools → Coding Agent Sessions
                                                  ↓
                                        NotificationService → openclaw message send → User
```

## Core Components

### 1. Plugin Entry (`index.ts`)
- Registers 6 tools, 6 commands, and 1 service
- Creates SessionManager and NotificationService during service start
- Wires outbound messaging via `openclaw message send` CLI

### 2. SessionManager (`src/session-manager.ts`)
- Manages lifecycle of coding agent processes (spawn, track, kill, resume)
- Enforces `maxSessions` concurrent limit
- Persists completed sessions for resume (up to `maxPersistedSessions`)
- GC interval cleans up stale sessions every 5 minutes
- Subscribes to session events (statusChange, turnEnd) instead of callbacks
- Single-index persistence with 3 maps (persisted, idIndex, nameIndex)

### 3. Session (`src/session.ts`)
- Wraps a single coding agent process via the harness SDK (`@anthropic-ai/claude-agent-sdk`)
- Extends `EventEmitter` — emits `statusChange`, `output`, `toolUse`, `turnEnd`
- State machine with validated transitions (`starting → running → completed/failed/killed`)
- Centralized timer management via `setTimer`/`clearTimer`/`clearAllTimers`
- Three named timers: `safetyNet` (15s), `idle` (30min), `postTurnIdle` (5min)
- Handles output buffering and multi-turn conversation via `MessageStream`

### 4. NotificationService (`src/notifications.ts`)
- Routes notifications to appropriate channels via `emitToChannel()`
- Wraps the `sendMessage` callback for outbound delivery

### 5. Config & Singletons
- `src/config.ts` — Plugin config singleton, channel resolution utilities (`resolveToolChannel`, `resolveAgentChannel`, etc.)
- `src/singletons.ts` — Module-level mutable references for `sessionManager` and `notificationService`
- `src/format.ts` — Formatting utilities (duration, session listing, stats, name generation)

### 6. Shared Respond Action (`src/actions/respond.ts`)
- Centralizes all respond logic used by both `agent_respond` tool and `/agent_respond` command
- Auto-resume for idle-killed sessions (post-turn-idle, idle-timeout)
- Permission mode switch (plan → bypassPermissions on approval keywords)
- Auto-respond counter management

## Data Flow

### Session Launch
```
Agent calls agent_launch → tool validates params → SessionManager.spawn()
  → Session created → coding agent process starts
  → Origin channel stored for notifications
  → SessionManager subscribes to session events
```

### Waiting for Input (Wake) — Two-Tier Mechanism
```
Session detects idle (end-of-turn or 15s safety-net timer)
  → Session emits "turnEnd" event with hadQuestion=true
  → SessionManager triggers wake event

Wake tier 1 — Primary (spawn detached):
  → openclaw agent --agent <id> --message <text> --deliver
  → Spawns detached process → delivers message directly
  → Independent of heartbeat configuration

Wake tier 2 — Fallback (system event, requires heartbeat):
  → openclaw system event --mode now
  → Triggers immediate heartbeat with reason="wake"
  → Only used when originAgentId is missing

  → Orchestrator agent wakes up, reads output, forwards to user
```

### Idle-Kill + Auto-Resume
```
Turn completes without a question → post-turn idle timer starts (5min)
  → Timer fires → session.kill("post-turn-idle")
  → SessionManager persists harnessSessionId
  → Notification: "💤 Idle-killed"

On next agent_respond:
  → actions/respond.ts detects killed + idle killReason + harnessSessionId
  → Auto-spawns new session with same harnessSessionId
  → Conversation context preserved
```

### Session Completion
```
Coding agent process exits
  → Session status → completed/failed
  → System event broadcast
  → Orchestrator agent retrieves output, summarizes to user
```

## Plan Approval Modes

Controls how the orchestrator handles plans when a coding agent calls `ExitPlanMode`. Set via `planApproval` in plugin config.

| Mode | Default | Behavior |
|------|---------|----------|
| `ask` | | Always forwards plan to user — orchestrator never auto-approves |
| `delegate` | ✓ | Orchestrator decides: approves low-risk plans autonomously, escalates high-risk or ambiguous plans to user |
| `approve` | | Orchestrator may auto-approve after verification (workdir, scope, codebase correctness); can still escalate complex/risky plans |

- **Permission switch** — on approval, session switches from `plan` → `bypassPermissions`
- **Revision** — responding without `approve=true` keeps the agent in plan mode; it revises and re-submits via `ExitPlanMode`

## Key Design Decisions

1. **CLI for outbound messages** — No runtime API for sending messages; uses `openclaw message send` subprocess
2. **Two-tier wake** — Primary: detached spawn `openclaw agent --message --deliver` (no heartbeat dependency). Fallback: `openclaw system event --mode now` (requires heartbeat)
3. **EventEmitter over callbacks** — Session extends EventEmitter; SessionManager subscribes to events instead of wiring 6 optional callback properties
4. **State machine** — `TRANSITIONS` map validates all status changes; invalid transitions throw
5. **Kill+resume, no hibernation** — No intermediate "hibernated" state. Sessions are killed, then auto-resumed on next respond if they have a valid harnessSessionId
6. **Shared respond action** — `actions/respond.ts` centralizes auto-resume, permission switch, and auto-respond cap logic for both tool and command callers
7. **maxAutoResponds limit** — Prevents infinite agent loops; resets on user interaction (`userInitiated: true`)
8. **Channel propagation** — `resolveToolChannel()` in `config.ts` handles channel resolution once per tool call, replacing 7 duplicated blocks

## Configuration

See `openclaw.plugin.json` for full config schema. Key settings:
- `maxSessions` (5) — concurrent session limit
- `fallbackChannel` — default notification target
- `idleTimeoutMinutes` (30) — auto-kill for idle multi-turn sessions
- `postTurnIdleMinutes` (5) — auto-kill after turn completes without a question
- `maxAutoResponds` (10) — agent auto-respond limit per session
- `permissionMode` (plan) — default coding agent permission mode
