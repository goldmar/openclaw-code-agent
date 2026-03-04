# Notification System

## Session Lifecycle Notifications

Sent by SessionManager via `openclaw message send` (fire-and-forget) to the originating Telegram thread.

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

Notifications are routed to the Telegram thread/topic where the session was launched. This is handled automatically via `originThreadId` — no manual configuration needed.

- `agentChannels` config handles chat-level routing (which bot, which chat)
- `originThreadId` handles within-chat routing (which thread/topic)

## Wake Mechanism

### Primary: Agent Wake CLI
`execFile("openclaw", ["agent", "--agent", id, "--message", text, "--deliver", ...])`
- Invokes the originating orchestrator agent directly
- `--deliver` routes wake content back to the same chat/thread
- Used for 🔔 waiting, 🔄 turn-done, and ✅ completed wakes
- Retries once on failure before falling back to direct Telegram notification

### Fallback: System Event
`openclaw system event --mode now`
- Requires heartbeat to be configured
- Used when `originAgentId` is missing; wake dispatcher retries once before giving up

## Idle-Kill + Auto-Resume

When a session completes a turn without asking a question, it is immediately **completed** with reason `done`. The turn already emitted a 🔄 notification, so no extra terminal wake is emitted for that `done` transition. If the session remains untouched for `idleTimeoutMinutes` (default: 15 min), it is killed with reason `idle-timeout` and appears as a standard ⛔ killed lifecycle event.

On the next `agent_respond` to either a `done`-paused or `idle-timeout`-killed session, the plugin auto-resumes by spawning a new session with the same harness session ID — conversation context is preserved. Sessions killed explicitly by the user (`agent_kill`) do NOT auto-resume.

## Configuration

Notifications route to Telegram via `agentChannels` config mapping workspace paths to channel strings. See [AGENT_CHANNELS.md](AGENT_CHANNELS.md) for details.
