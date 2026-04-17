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

## Adjacent OpenClaw Surfaces

This plugin sits beside, not inside, two OpenClaw core subsystems that are easy to conflate with it:

- **ACPX**: OpenClaw's bundled ACP runtime backend. It exists to back ACP sessions and ACP control-plane behavior.
- **OpenClaw bundled `codex` plugin**: OpenClaw's core Codex provider and native embedded harness for `codex/*` model refs.

`openclaw-code-agent` is neither of those:

- it is not an ACP runtime backend
- it is not OpenClaw's provider registry
- it does not register a core provider into OpenClaw

The overlap is substrate, not responsibility. Both the core bundled `codex` plugin and this plugin can talk to Codex App Server, but they do so for different products:

- ACPX owns ACP runtime/session interoperability
- the bundled core `codex` plugin owns embedded provider/harness execution for OpenClaw core
- `openclaw-code-agent` owns chat UX, approval state, wake routing, session persistence, and worktree/merge/PR policy

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
- backend refs are the authoritative backend identity; legacy harness session ids remain compatibility/display metadata only

### `Session`

`src/session.ts` wraps a single coding session:

- owns the harness instance
- buffers output
- manages the idle timer
- validates state transitions
- emits `statusChange`, `output`, `toolUse`, and `turnEnd`

`Session` now uses an explicit control-state reducer for lifecycle, approval, runtime, and worktree transitions. Suspended sessions are explicitly resumable; terminal sessions stay terminal.

Plan-gated sessions also persist deterministic approval/execution context:

- the originally requested permission mode
- the current effective permission mode
- an explicit approval/execution state such as `awaiting_approval`, `approved_then_implemented`, `implemented_without_required_approval`, or `not_plan_gated`

### Harness Abstraction

`src/harness/types.ts` defines the `AgentHarness` interface. The built-in harnesses are:

- `claude-code`: native Claude Code harness with plan-mode and `AskUserQuestion` interception
- `codex`: native Codex App Server harness with structured pending input, structured plan artifacts, backend refs, and native worktree thread state

Important mapping detail:

- Claude Code maps plugin `permissionMode` directly to the SDK modes.
- Codex runs through the Codex App Server transport. Plugin `plan` mode remains a plugin-owned approval workflow even when the backend exposes structured plan artifacts, and plugin worktree strategy stays policy-only above Codex-native worktree execution.
- `agent_respond` is the only continuation primitive across both backends; fork flows still go through `agent_launch(..., resume_session_id=..., fork_session=true)`.

Boundary note:

- this plugin's internal `codex` harness is local to this plugin
- it is separate from OpenClaw core's bundled `codex` provider/harness plugin
- it is also separate from ACPX, which is an ACP backend rather than this plugin's execution runtime

### `WakeDispatcher`

`src/wake-dispatcher.ts` owns outbound lifecycle delivery:

- primary path: `openclaw gateway call chat.send`
- fallback path: `openclaw system event --mode now`
- bounded retries
- per-session retry timers
- structured delivery logs
- no per-instance process signal hooks

`SessionNotificationService` decides the delivery-state transitions. `WakeDispatcher` decides how to deliver each transport request.

Security boundary note:

- the plugin intentionally shells out to the local `openclaw` CLI for delivery instead of implementing a separate ad hoc network client
- Discord interactive delivery is still gateway/plugin-SDK-owned; test injection is explicit and no longer uses a production env-var override

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
- `src/worktree-lifecycle-resolver.ts`: authoritative lifecycle resolution from persisted state plus live repository evidence
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
  -> create plugin-managed worktree only when the selected backend requires it
  -> SessionManager.spawn()
  -> Session starts streaming output
```

### Waiting For Input

`turnEnd` plus explicit question / approval / worktree state drives the wake path.

- Real question: emit `❓ Waiting for input`
- Plan approval pending: emit `📋 Plan ready for review`
- Plain turn completion: emit `⏸️ Paused after turn`

Plan approval behavior depends on `planApproval`:

- `ask`: notify the user directly and wait
- `delegate`: wake the orchestrator with the full plan and decision criteria; it must review the full plan before approving or escalating back to the user
- `approve`: wake the orchestrator with an immediate approval instruction

### Worktree Completion

When a session completes with worktree metadata:

- `ask`: keep the branch local, notify the user, and attach `Merge locally` / `Create PR` buttons
- `delegate`: keep the branch local and wake the orchestrator with diff context
- `auto-merge`: attempt merge automatically and spawn a conflict resolver on failure
- `auto-pr`: attempt PR creation/update automatically; fall back to explicit pending decision state on failure
- `manual`: keep the branch for explicit follow-up

`ask` and `delegate` suppress the normal turn-complete wake because the worktree decision message is the completion signal.

The worktree model is lifecycle-first:

- authoritative state comes from plugin actions such as `pending_decision`, `pr_open`, `merged`, `dismissed`, and `no_change`
- derived repository evidence can upgrade a sandbox to `released` when the base branch already contains the content even though git ancestry does not show a normal merge
- retained reasons explain why a sandbox was preserved instead of cleaned

This avoids treating “ahead of main” as the only truth source for cleanup.

### Resume, Redirect, And Recovery

- `agent_respond(..., interrupt=true)` aborts the current turn in place and sends a redirect notification
- `agent_respond` is the only continuation primitive for active and explicitly suspended sessions
- sessions found in `running` state during startup recovery are normalized into resumable persisted entries instead of being implicitly restarted
- persisted Codex resume state is restored through the backend thread ref, not through SDK-era harness session guessing

## Persistence Model

Persisted session storage exists to make sessions recoverable and observable after runtime GC or restart.

Path precedence:

1. `OPENCLAW_CODE_AGENT_SESSIONS_PATH`
2. `$OPENCLAW_HOME/code-agent-sessions.json`
3. `~/.openclaw/code-agent-sessions.json`

Stored data includes:

- internal ID and name
- harness, model, and backend ref
- requested and effective permission modes plus deterministic approval/execution state
- workdir and worktree metadata
- persisted worktree lifecycle state, resolution source, and cleanup notes
- origin routing metadata
- backend conversation ID for diagnostics and recovery
- output stubs and persisted stream references

`backendRef` is required for all new-schema sessions. Codex SDK-era persisted sessions are archived and not loaded.

## Notification Pipeline

The notification pipeline is intentionally centralized:

1. `SessionManager` builds one notification request per event.
2. `WakeDispatcher` decides whether it is notify-only, wake-only, or both.
3. `chat.send` is preferred because it targets the originating runtime session precisely.
4. `system event` is the recovery path when the richer routing metadata is missing or delivery fails repeatedly.

The design goal is deterministic wakes with the fewest possible duplicate pings.

## Worktree Internals

`src/worktree.ts` handles the plugin-owned worktree policy layer:

- isolated plugin-managed worktree creation under `.worktrees` or `OPENCLAW_WORKTREE_DIR`
- branch naming and collision handling
- default branch detection
- merge and squash paths
- PR creation and updates via `gh`
- stale worktree cleanup
- diff summary generation for delegated decisions

`src/worktree-lifecycle-resolver.ts` sits above those helpers and produces:

- persisted lifecycle state
- derived lifecycle state such as `released`
- retained reasons
- clean-all-safe eligibility

Important constraints:

- worktree creation only happens for git repos
- Codex can execute inside a native backend-managed worktree while the plugin still owns ask/delegate/auto-merge/auto-pr policy above it
- push and PR flows need a configured remote
- the main checkout is not modified during isolated worktree execution
- cleanup is lifecycle-driven: safe cleanup applies only to `merged`, `released`, `dismissed`, and `no_change`

Backend capabilities intentionally differ:

- Claude Code: plugin-managed worktree substrate
- Codex App Server: native backend worktree substrate with persisted backend refs
- User-facing worktree strategy and decision UX remain identical above both

## Design Decisions

1. The plugin treats coding sessions as managed background jobs, not as inline chat completions.
2. Notification transport is gateway-owned. The plugin shells out to OpenClaw instead of inventing its own delivery channel.
3. `Session` is an event emitter, not a callback bucket. This keeps the lifecycle model explicit.
4. Subprocess use is an accepted part of the architecture, but it should stay limited to backend launch, worktree/PR operations, gateway-owned delivery, and explicit verifier commands.
4. Runtime GC and persisted resume are separate concerns. Eviction from memory does not mean losing the session.
5. Worktree decisions are first-class orchestration states, not afterthoughts bolted on after completion.
6. Codex and Claude Code share the same session-centric control plane even though their backend transports differ.
7. Worktree cleanup is lifecycle-first and evidence-based. Tooling and maintenance only remove worktrees when local repository evidence proves a safe resolved state such as `merged`, `released`, `dismissed`, or `no_change`.

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

New persisted sessions must carry explicit `route` metadata, and any persisted worktree session must carry `worktreeBranch`. Runtime control flow treats a direct persisted route as canonical, repairs degraded notification routes from `originChannel` / `originSessionKey` when needed, and does not infer branch state from worktree paths.
