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
| ⛔    | Killed    | Session terminated  | No                                   |
| 💤    | Idle-killed | Post-turn idle or idle timeout | Auto-resumes on next respond |
| ⏱️    | Long-running | Session > 10 min  | One-shot reminder                   |

## Thread-Based Routing

Notifications are routed to the Telegram thread/topic where the session was launched. This is handled automatically via `originThreadId` — no manual configuration needed.

- `agentChannels` config handles chat-level routing (which bot, which chat)
- `originThreadId` handles within-chat routing (which thread/topic)

## Wake Mechanism

### Primary: Detached Spawn
`spawn("openclaw", ["agent", "--agent", id, "--message", text, "--deliver", ...], { detached: true })` + `child.unref()`
- Non-blocking, agent response routed to Telegram via --deliver
- Used for 🔔 waiting and ✅ completed

### Fallback: System Event
`openclaw system event --mode now`
- Requires heartbeat to be configured
- Only used when originAgentId is missing

## Idle-Kill + Auto-Resume

When a session completes a turn without asking a question, a post-turn idle timer starts (default: 5 minutes). If no follow-up arrives, the session is killed with reason `post-turn-idle` and a 💤 notification is sent.

On the next `agent_respond` to that session, the plugin auto-resumes by spawning a new session with the same harness session ID — conversation context is preserved. Sessions killed explicitly by the user (`agent_kill`) do NOT auto-resume.

## Configuration

Notifications route to Telegram via `agentChannels` config mapping workspace paths to channel strings. See [AGENT_CHANNELS.md](AGENT_CHANNELS.md) for details.
