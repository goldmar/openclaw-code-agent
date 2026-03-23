# Notification System

## Session Lifecycle Notifications

Sent by SessionManager via gateway runtime channel senders (fire-and-forget) to the originating Telegram thread.

Turn-end notifications are always enabled for multi-turn sessions. There is no caller override.

| Emoji | Event | When | Agent Reaction |
|-------|-----------|---------------------|--------------------------------------|
| 🚀    | Launched  | Session started     | No                                   |
| ❓    | Waiting for input | Agent asked a follow-up question | Yes - agent_respond |
| 📋    | Plan ready | Plan approval requested | Yes - reply "go" to approve      |
| ⏸️    | Paused after turn | Turn completed without a question; auto-resumable | No |
| ↪️    | Responded / Redirected | `agent_respond` sent a message; or `interrupt=true` redirected active work in-place | No |
| 👍    | Plan approved | `agent_respond(..., approve=true)` approved a pending plan | No |
| ▶️    | Auto-resumed | Next `agent_respond` resumed the session | No |
| ✅    | Completed | Session finished    | Yes - agent_output + summarize      |
| 📄    | Deliverable ready | Session finished with `output_mode: "deliverable"` | Yes - agent_output + summarize |
| ❌    | Failed    | Session error (includes harnessSessionId + resume guidance) | No |
| 💤    | Idle timeout | Session timed out while waiting between turns | No |
| ⛔    | Stopped    | Session stopped by user, shutdown, startup timeout, or another forced stop | No |

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

When a session completes a turn without asking a question, it is immediately **completed** with reason `done`. The turn always emits a ⏸️ `Paused after turn | Auto-resumable` notification first, so no extra terminal wake is emitted for that `done` transition. If the session remains untouched for `idleTimeoutMinutes` (default: 15 min), it is killed with reason `idle-timeout` and emits a dedicated 💤 idle-timeout notification.

On the next `agent_respond` to either a `done`-paused or `idle-timeout`-killed session, the plugin auto-resumes by spawning a new session with the same harness session ID — conversation context is preserved. The user-facing resume ping is always ▶️ `Auto-resumed`; it does not expose internal labels like `completed` or `shutdown-killed`. Sessions killed for any reason except `startup-timeout` are auto-resumable, including explicit user stops and shutdown recovery.

Intentional redirect is distinct from both fresh launch and auto-resume. When `agent_respond(..., interrupt=true)` interrupts active work successfully, the user-facing notification is ↪️. All `agent_respond` sends now emit ↪️ (for regular sends) or 👍 (for plan approvals via `approve=true`). Deliberate redirect is not reported as ❌ `Failed`, and it does not emit a successor 🚀 `Launched`/▶️ `Auto-resumed` notification because the redirect stays in the same live session. Turn-complete (⏸️) is suppressed for sessions using `ask` or `delegate` worktree strategies — the worktree decision notification replaces it.

## Configuration

Notifications route to Telegram via `agentChannels` config mapping workspace paths to channel strings. See [AGENT_CHANNELS.md](AGENT_CHANNELS.md) for details.
