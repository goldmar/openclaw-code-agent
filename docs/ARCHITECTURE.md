# Architecture

Internal design notes for `openclaw-code-agent`. This document is about how the plugin works, not how to operate it. For setup and tool usage, see [REFERENCE.md](REFERENCE.md).

## System Context

```text
User (Telegram / Discord / other OpenClaw channel)
  -> OpenClaw Gateway
  -> orchestrator agent
  -> plugin tools / commands
  -> SessionManager
  -> Agent harness (Claude Code or Codex)
  -> coding session

SessionManager
  -> SessionNotificationService
  -> SessionInteractionService
  -> SessionWorktreeController
  -> WakeDispatcher
  -> openclaw gateway call chat.send
  -> openclaw system event --mode now

Interactive callbacks (Telegram / Discord)
  -> CallbackHandler
  -> agent_merge / agent_pr / agent_respond
```

## Core Components

### Plugin Entry

`index.ts` registers:

- 10 tools
- 7 chat commands
- the shared interactive callback handlers for Telegram and Discord
- the background session service

Service startup loads config, instantiates `SessionManager`, restores persisted state, and runs orphan worktree cleanup.

### `SessionManager`

`src/session-manager.ts` is the control plane:

- enforces `maxSessions`
- spawns and tracks sessions
- resolves resume and fork requests
- persists runtime metadata and output
- handles waiting, completion, failure, and worktree follow-through
- composes the notification, interaction, and worktree controller services

Key behavior:

- runtime sessions are garbage-collected after `sessionGcAgeMinutes`
- persisted session records remain resumable after runtime GC
- fresh launches are resume-first: linked resumable sessions must be resumed or forked unless `force_new_session=true`
- explicit per-launch `worktreeStrategy` overrides the plugin default
- sessions with pending worktree decisions are kept visible and protected from cleanup
- persisted control-state patches are mirrored back onto active runtime sessions to keep lifecycle/worktree state coherent

### `Session`

`src/session.ts` wraps a single coding session:

- owns the harness instance
- buffers output
- manages the idle timer
- validates state transitions
- emits `statusChange`, `output`, `toolUse`, and `turnEnd`

`Session` now uses an explicit control-state reducer for lifecycle, approval, runtime, and worktree transitions. Suspended sessions are explicitly resumable; terminal sessions stay terminal.

### Harness Abstraction

`src/harness/types.ts` defines the `AgentHarness` interface. The built-in harnesses are:

- `claude-code`: native Claude Code harness with plan-mode and `AskUserQuestion` interception
- `codex`: native Codex thread harness with soft plan-first behavior, `reasoningEffort`, and `approvalPolicy`

Important mapping detail:

- Claude Code maps plugin `permissionMode` directly to the SDK modes.
- Codex always runs with `sandboxMode: "danger-full-access"`. Plugin `plan` mode is implemented as orchestrated behavior, not as a Codex SDK permission state.

### `WakeDispatcher`

`src/wake-dispatcher.ts` owns outbound lifecycle delivery:

- primary path: `openclaw gateway call chat.send`
- fallback path: `openclaw system event --mode now`
- bounded retries
- per-session retry timers
- structured delivery logs
- no per-instance process signal hooks

`SessionNotificationService` decides the delivery-state transitions. `WakeDispatcher` decides how to deliver each transport request.

### `CallbackHandler`

`src/callback-handler.ts` handles interactive callbacks under the `code-agent` namespace for both Telegram and Discord.

It dispatches:

- plan approval actions
- revision prompts
- reply prompts
- retry/output shortcuts
- worktree actions (`merge`, `pr`, `new-pr`)

This keeps plan approval and worktree decisions inside the plugin instead of leaking semantic callback payloads into chat. Buttons carry opaque action tokens, not `verb:session` strings.

### Supporting Modules

- `src/session-interactions.ts`: state-driven button construction and opaque action-token persistence
- `src/session-notifications.ts`: delivery-state-aware notification wrapper over `WakeDispatcher`
- `src/session-worktree-controller.ts`: worktree completion/retention rules
- `src/session-store.ts`: persisted metadata and output index
- `src/session-metrics.ts`: in-memory aggregate metrics
- `src/worktree.ts`: worktree creation, merge, PR, cleanup, diff summaries
- `src/actions/respond.ts`: shared respond logic for tool and command callers
- `src/application/*`: shared presentation and session-control helpers
- `src/config.ts`: config defaults, migration logic, and routing utilities

## Lifecycle Flows

### Launch

```text
agent_launch / /agent
  -> resolve model, harness, origin channel, origin thread
  -> resolve resume/fork metadata if present
  -> decide effective worktree strategy
  -> create worktree if required
  -> SessionManager.spawn()
  -> Session starts streaming output
```

### Waiting For Input

`turnEnd` plus waiting detection drives the wake path.

- Real question: emit `❓ Waiting for input`
- Plan approval pending: emit `📋 Plan ready for review`
- Plain turn completion: emit `⏸️ Paused after turn`

Plan approval behavior depends on `planApproval`:

- `ask`: notify the user directly and wait
- `delegate`: wake the orchestrator with the full plan and decision criteria
- `approve`: wake the orchestrator with an immediate approval instruction

### Worktree Completion

When a session completes with worktree metadata:

- `ask`: keep the branch local, notify the user, and attach `Merge locally` / `Create PR` buttons
- `delegate`: keep the branch local, send a brief user ping, and wake the orchestrator with diff context
- `auto-merge`: attempt merge automatically and spawn a conflict resolver on failure
- `auto-pr`: attempt PR creation/update automatically; fall back to explicit pending decision state on failure
- `manual`: keep the branch for explicit follow-up

`ask` and `delegate` suppress the normal turn-complete wake because the worktree decision message is the completion signal.

### Resume, Redirect, And Recovery

- `agent_respond(..., interrupt=true)` aborts the current turn in place and sends a redirect notification
- only explicitly suspended sessions are resumable through `agent_respond` / `agent_resume`
- sessions found in `running` state during startup recovery are marked killed and remain resumable
- persisted Codex resume state is treated more conservatively after restart because thread reuse is brittle across auth and process boundaries

## Persistence Model

Persisted session storage exists to make sessions recoverable and observable after runtime GC or restart.

Path precedence:

1. `OPENCLAW_CODE_AGENT_SESSIONS_PATH`
2. `$OPENCLAW_HOME/code-agent-sessions.json`
3. `~/.openclaw/code-agent-sessions.json`

Stored data includes:

- internal ID and name
- harness and model
- workdir and worktree metadata
- origin routing metadata
- harness session ID
- output stubs and persisted stream references

## Notification Pipeline

The notification pipeline is intentionally centralized:

1. `SessionManager` builds one notification request per event.
2. `WakeDispatcher` decides whether it is notify-only, wake-only, or both.
3. `chat.send` is preferred because it targets the originating runtime session precisely.
4. `system event` is the recovery path when the richer routing metadata is missing or delivery fails repeatedly.

The design goal is deterministic wakes with the fewest possible duplicate pings.

## Worktree Internals

`src/worktree.ts` handles:

- isolated worktree creation under `.worktrees` or `OPENCLAW_WORKTREE_DIR`
- branch naming and collision handling
- default branch detection
- merge and squash paths
- PR creation and updates via `gh`
- stale worktree cleanup
- diff summary generation for delegated decisions

Important constraints:

- worktree creation only happens for git repos
- push and PR flows need a configured remote
- the main checkout is not modified during isolated worktree execution

## Design Decisions

1. The plugin treats coding sessions as managed background jobs, not as inline chat completions.
2. Notification transport is gateway-owned. The plugin shells out to OpenClaw instead of inventing its own delivery channel.
3. `Session` is an event emitter, not a callback bucket. This keeps the lifecycle model explicit.
4. Runtime GC and persisted resume are separate concerns. Eviction from memory does not mean losing the session.
5. Worktree decisions are first-class orchestration states, not afterthoughts bolted on after completion.
6. Codex and Claude Code share the same control plane even though their SDK semantics differ.

## Config Touchpoints

The architecture is most sensitive to these config settings:

- `defaultHarness`
- `permissionMode`
- `planApproval`
- `defaultWorktreeStrategy`
- `agentChannels`
- `fallbackChannel`
- `idleTimeoutMinutes`
- `sessionGcAgeMinutes`
- `maxPersistedSessions`
- `harnesses.*`

See [REFERENCE.md](REFERENCE.md) for the operator-facing meaning of those settings.
## Breaking Schema Policy

The current persisted-session store is new-schema-only. On startup, any older or invalid store is archived to a timestamped `.legacy-*.json` backup and replaced with a fresh index. Legacy rows are not migrated or repaired in place.

New persisted sessions must carry explicit `route` metadata, and any persisted worktree session must carry `worktreeBranch`. Runtime control flow does not reconstruct notifications from `originChannel` / `originSessionKey`, and it does not infer branch state from worktree paths.
