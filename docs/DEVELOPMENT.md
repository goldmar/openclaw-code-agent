# Development

## Project Structure

```
openclaw-code-agent/
├── index.ts                    # Plugin entry point (register function)
├── openclaw.plugin.json        # Plugin manifest and config schema
├── package.json                # Dependencies
├── src/
│   ├── types.ts                # TypeScript interfaces (session config, metrics, etc.)
│   ├── config.ts               # Plugin config singleton + channel resolution
│   ├── format.ts               # Formatting utilities (duration, listings, stats)
│   ├── singletons.ts           # Module-level sessionManager/notificationService refs
│   ├── session.ts              # Session class (EventEmitter, state machine, timers)
│   ├── session-manager.ts      # Session pool management + lifecycle
│   ├── session-store.ts        # Persistence/index store abstraction
│   ├── session-metrics.ts      # Metrics recorder abstraction
│   ├── wake-dispatcher.ts      # Wake delivery + retry abstraction
│   ├── notifications.ts        # NotificationService (Telegram delivery, reminders)
│   ├── application/
│   │   ├── session-view.ts     # Shared output/list rendering for tool + command parity
│   │   └── session-control.ts  # Shared kill/complete logic for tool + command parity
│   ├── actions/
│   │   └── respond.ts          # Shared respond logic (tool + command)
│   ├── tools/
│   │   ├── agent-launch.ts     # agent_launch tool
│   │   ├── agent-sessions.ts   # agent_sessions tool
│   │   ├── agent-output.ts     # agent_output tool
│   │   ├── agent-kill.ts       # agent_kill tool
│   │   ├── agent-respond.ts    # agent_respond tool
│   │   └── agent-stats.ts      # agent_stats tool
│   ├── commands/
│   │   ├── agent.ts            # /agent command
│   │   ├── agent-sessions.ts   # /agent_sessions command
│   │   ├── agent-kill.ts       # /agent_kill command
│   │   ├── agent-resume.ts     # /agent_resume command
│   │   ├── agent-respond.ts    # /agent_respond command
│   │   └── agent-stats.ts      # /agent_stats command
│   └── harness/                # Coding agent harness abstraction layer
│       ├── types.ts            # AgentHarness interface + message types
│       ├── claude-code.ts      # Claude Code harness (wraps @anthropic-ai/claude-agent-sdk)
│       ├── codex.ts            # Codex harness (wraps @openai/codex-sdk thread streaming)
│       └── index.ts            # Harness registry + re-exports
├── skills/
│   └── code-agent-orchestration/
│       └── SKILL.md            # Orchestration skill definition
└── docs/
    ├── ARCHITECTURE.md         # Architecture overview
    ├── NOTIFICATIONS.md        # Notification system details
    ├── AGENT_CHANNELS.md       # Multi-agent notification routing
    ├── TOOLS.md                # Tool reference
    └── DEVELOPMENT.md          # This file
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | Claude harness SDK — powers Claude Code sessions. Version policy: `^0.2.37`. |
| `@openai/codex-sdk` | Codex harness SDK — powers Codex thread start/resume and streamed turn events. Version policy: `^0.107.0`. |
| `@sinclair/typebox` | JSON Schema type builder for tool parameter definitions. |
| `nanoid` | Generates short unique session IDs (8 characters). |

---

## Key Design Decisions

1. **Multi-turn uses `AsyncIterable` prompts.** The `MessageStream` class implements `Symbol.asyncIterator` to feed user messages into the SDK's `query()` function as an async generator, keeping the session alive across turns.

2. **Persisted sessions survive GC.** When a session is garbage-collected (default 24 hours after completion, configurable via `sessionGcAgeMinutes`), its harness session ID is retained in a separate persistence map so it can be resumed later. Entries are stored under three indexes (internal ID, name, harness UUID) for flexible lookup. Persistence path precedence is:
   - `OPENCLAW_CODE_AGENT_SESSIONS_PATH`
   - `$OPENCLAW_HOME/code-agent-sessions.json`
   - `~/.openclaw/code-agent-sessions.json`

3. **Notifications and wakes use CLI shelling.** Since the plugin API doesn't expose runtime delivery/wake APIs, the plugin shells out via `child_process.execFile` to:
   - `openclaw message send` (direct channel notifications)
   - `openclaw agent --deliver` (orchestrator wake path)
   - `openclaw system event --mode now` (fallback wake path)

4. **Metrics are in-memory only.** Session metrics are aggregated in the `SessionManager` and reset on service restart. They are not persisted to disk.

5. **Waiting-for-input uses end-of-turn detection.** End-of-turn detection (when a multi-turn result resolves) is the signal. The `turnEnd` event carries a `hadQuestion` boolean.

6. **Channel `"unknown"` falls through.** If `channelId` is `"unknown"`, the notification system explicitly falls through to `fallbackChannel` rather than attempting delivery to an invalid destination.

7. **EventEmitter over callbacks.** Session extends `EventEmitter` and emits typed events (`statusChange`, `output`, `toolUse`, `turnEnd`). SessionManager subscribes to these events instead of wiring optional callback properties during spawn.

8. **State machine validates transitions.** A `TRANSITIONS` map defines valid status changes. Invalid transitions throw an error, preventing impossible state changes like `completed → running`.

9. **Shared respond action.** `actions/respond.ts` centralizes all respond logic (auto-resume, permission switch, auto-respond cap) used by both the tool and command.

---

## Adding a New Tool or Command

1. Create a new file under `src/tools/` or `src/commands/`.
2. Export a `makeAgentXxxTool(ctx)` or `registerAgentXxxCommand(api)` function.
3. Import and call it in `index.ts` inside the `register()` function.

---

## Build

```bash
pnpm run build      # esbuild → dist/index.js (ESM bundle)
pnpm run typecheck  # Type-check only
```

---

## Service Lifecycle

- **`start()`** — Creates `SessionManager` and `NotificationService`, wires them together, and starts a GC interval (5 min).
- **`stop()`** — Stops the notification service, kills all active sessions, clears intervals, and nulls singletons.
