# Notification System

## Session Lifecycle Notifications

Sent by SessionManager via gateway runtime channel senders (fire-and-forget) to the originating Telegram thread.

| Emoji | Event | When | Agent Reaction |
|-------|-----------|---------------------|--------------------------------------|
| 🚀    | Launched  | Session started     | No                                   |
| 🔔    | Agent asks | Waiting for input | Yes - agent_respond                 |
| 📋    | Plan ready | Plan approval requested | Yes - reply "go" to approve      |
| 🔄    | Turn done | Turn completed      | No                                   |
| ✅    | Completed | Session finished    | Yes - agent_output + summarize      |
| ❌    | Failed    | Session error       | No                                   |
| ⛔    | Killed    | Session terminated (including idle-timeout) | No |

## Thread-Based Routing

Notifications are routed back to the originating chat session with `originSessionKey`. For Telegram topics, the key already includes the topic/thread identifier, so topic routing stays exact without separate delivery logic.

- `agentChannels` config handles chat-level routing (which bot, which chat)
- `originSessionKey` handles the exact originating runtime session
- `originThreadId` is still persisted for listing/debug output and resume metadata

## Wake Mechanism

### One Notification Pipeline
`SessionManager` builds a single notification request per lifecycle event and hands it to `WakeDispatcher`.

- `userMessage` is the compact chat-facing status update
- `wakeMessage` is the richer orchestrator/system-event payload
- `WakeDispatcher` decides whether to send a direct notification, a wake, or both

### Primary: `chat.send`
`execFile("openclaw", ["gateway", "call", "chat.send", ...])`
- Targets the exact originating runtime session via `originSessionKey`
- Used for direct lifecycle notifications and orchestrator wakes
- Logs start, completion, and failure for each dispatch attempt
- Retries with bounded backoff before falling back to `system event`

### Fallback: System Event
`openclaw system event --mode now`
- Used when `originSessionKey` is missing, the originating agent metadata is incomplete, or `chat.send` exhausts retries
- Provides the final recovery path for non-Telegram and degraded routing scenarios

## Idle-Kill + Auto-Resume

When a session completes a turn without asking a question, it is immediately **completed** with reason `done`. The turn already emitted a 🔄 notification, so no extra terminal wake is emitted for that `done` transition. If the session remains untouched for `idleTimeoutMinutes` (default: 15 min), it is killed with reason `idle-timeout` and appears as a standard ⛔ killed lifecycle event.

On the next `agent_respond` to either a `done`-paused or `idle-timeout`-killed session, the plugin auto-resumes by spawning a new session with the same harness session ID — conversation context is preserved. Sessions killed explicitly by the user (`agent_kill`) do NOT auto-resume.

## Configuration

Notifications route to Telegram via `agentChannels` config mapping workspace paths to channel strings. See [AGENT_CHANNELS.md](AGENT_CHANNELS.md) for details.
