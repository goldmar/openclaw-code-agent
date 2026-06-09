# Architecture

Internal design notes for `openclaw-code-agent`. This document is about how the plugin works, not how to operate it. For setup and tool usage, see [REFERENCE.md](REFERENCE.md).

## System Context

```text
User (Telegram / Discord / other OpenClaw channel)
  -> OpenClaw Gateway
  -> orchestrator agent
  -> plugin tools / commands
  -> SessionManager
  -> Agent harness (Claude Code, Codex, or experimental OpenCode)
  -> coding session

SessionManager
  -> SessionNotificationService
  -> SessionInteractionService
  -> SessionWorktreeController
  -> WakeDispatcher
  -> OpenClaw runtime channel outbound adapter
  -> openclaw gateway call chat.send
  -> openclaw system event --mode now

Interactive callbacks (Telegram / Discord)
  -> CallbackHandler
  -> agent_merge / agent_pr / agent_respond

Plain-text approval fallback
  -> agent_respond
  -> plan approval / changes requested / reject handling
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

- 15 tools
- 10 chat commands
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

When the OpenClaw runtime exposes the managed TaskFlow API, sessions also mirror high-level lifecycle progress into a gateway-owned flow record. The adapter is intentionally opportunistic: it creates, updates, waits, and finalizes managed flows when the API is present, and otherwise degrades to a no-op so session execution, notifications, and persistence do not depend on unreleased runtime surfaces.

### Harness Abstraction

`src/harness/types.ts` defines the `AgentHarness` interface. The built-in harnesses are:

- `claude-code`: native Claude Code harness with plan-mode and `AskUserQuestion` interception
- `codex`: native Codex App Server harness with structured pending input, structured plan artifacts, backend refs, and native worktree thread state
- `opencode`: experimental OpenCode server harness using a per-session local `opencode serve` process, classic session lifecycle routes for prompt/status/messages/replies, native pending input, plugin-managed worktrees, and no native OpenClaw plan artifacts

Important mapping detail:

- Claude Code maps plugin `permissionMode` directly to the SDK modes.
- Codex runs through the Codex App Server transport. Plugin `plan` mode remains a plugin-owned approval workflow even when the backend exposes structured plan artifacts. Fresh Codex worktree launches use the plugin-managed worktree cwd, while persisted backend refs can restore Codex backend worktree context during resume.
- OpenCode runs through a localhost OpenCode server transport. Fresh prompts use classic `prompt_async`, completion waits poll classic session status, message/result fetches use classic message routes, and permission/question replies use classic reply routes because v2 session wait is not available yet. Session create, fork, abort, and permission-rule updates also use classic routes.
- `agent_respond` is the only continuation primitive across built-in backends; fork flows still go through `agent_launch(..., resume_session_id=..., fork_session=true)`.

Boundary note:

- this plugin's internal `codex` harness is local to this plugin
- it is separate from OpenClaw core's bundled `codex` provider/harness plugin
- this plugin's experimental `opencode` harness is local to this plugin
- it is also separate from ACPX, which is an ACP backend rather than this plugin's execution runtime

### `WakeDispatcher`

`src/wake-dispatcher.ts` owns outbound lifecycle delivery:

- direct user-notification path: OpenClaw runtime channel outbound adapters
- wake path: `openclaw gateway call chat.send`
- fallback path: `openclaw system event --mode now`
- bounded retries
- per-session retry timers
- structured delivery logs
- no per-instance process signal hooks

`SessionNotificationService` decides the delivery-state transitions. `WakeDispatcher` decides how to deliver each transport request.

Security boundary note:

- direct notifications use the gateway-owned in-process outbound adapter instead of shelling back into `openclaw message send`, avoiding service re-entry while preserving account and topic/thread routing
- Telegram and Discord interactive direct notifications share the same gateway-owned presentation contract; only callback/routing details remain provider-specific

### Notification Idempotency

Notification delivery is at-least-once at the transport layer. Producers must make user-visible one-shot outcomes idempotent before they reach `WakeDispatcher`.

`SessionNotificationService` owns that boundary:

- producers attach a semantic `idempotencyKey` for one-shot user-visible outcomes such as plan prompts, goal success, terminal completion, worktree decisions, PR outcomes, and structured questions
- the service scopes the semantic key to the resolved notification route, hashes it, and stores a bounded `notificationDedupe` ledger on the persisted session
- duplicate claims in the same route are suppressed before direct notification or wake delivery starts
- successful notification or wake delivery marks the key `delivered`
- notify-only failures and wake failures release the in-flight key so retries can try again
- completion-summary wakes still use `CompletionSummaryCoordinator`; the generic dedupe ledger prevents the visible status line itself from being emitted twice

The invariant is: if two code paths represent the same user-visible outcome in the same chat/topic, they must share the same semantic `idempotencyKey`. If the outcome is intentionally repeatable, include the natural version in the key, such as plan version, turn number, question request id, PR number plus update identity, or snooze timestamp.

### `CallbackHandler`

`src/callback-handler.ts` handles interactive callbacks under the `code-agent` namespace for both Telegram and Discord.

It dispatches:

- plan approval actions
- revision prompts
- plain-text Approve / Revise / Reject fallback while a plan is awaiting review
- reply prompts
- retry/output shortcuts
- worktree actions (`merge`, `pr`, `new-pr`)

This keeps plan approval and worktree decisions inside the plugin instead of leaking semantic callback payloads into chat. Buttons carry opaque action tokens, not `verb:session` strings. When the transport cannot deliver or render buttons, the same review version can still be decided by plain text in the session thread.

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
agent_launch / /agent / /oca
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

For `ask`, Telegram and Discord plan buttons share OpenClaw's direct-message presentation contract. Plain text `Approve`, `Revise`, and `Reject` is accepted only while the session is awaiting a plan decision; rejection or kill closes that review version so stale prompts are not treated as actionable.

### Worktree Completion

When a session completes with worktree metadata:

- `ask`: keep the branch local, notify the user, and attach `Merge` / `Open PR` buttons
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
- persisted Codex and OpenCode resume state is restored through the backend thread ref, not through SDK-era harness session guessing

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

`backendRef` is required for all new-schema sessions. Codex SDK-era persisted sessions are archived and not loaded; that legacy cleanup is Codex-specific and does not apply to OpenCode backend refs.

## Notification Pipeline

The notification pipeline is intentionally centralized:

1. `SessionManager` builds one notification request per event.
2. `WakeDispatcher` decides whether it is notify-only, wake-only, or both.
3. Direct user notifications use `message.send`; Telegram and Discord interactive notifications attach buttons through `--presentation`.
4. Wakes use `chat.send` because it targets the originating runtime session precisely.
5. `system event` is the recovery path when richer routing metadata is missing or delivery fails repeatedly.

The design goal is deterministic wakes with the fewest possible duplicate pings.

Worktree terminal outcomes use a two-step UX contract. The plugin first delivers the canonical merge or PR status line, then sends a wake with `completionWakeSummaryRequired=true` so the orchestrator reads `agent_output(..., full=true)` and sends one short factual follow-up summary. A final summary inside `agent_output` is source material, not visible delivery, so it is not a valid reason to skip when the human only saw the plugin status line. That summary is owned by the orchestrator, not by the plugin's status formatter, and there must be at most one orchestrator-owned human summary for the same terminal/worktree outcome. The wake includes the canonical outcome facts and the authoritative origin route block; if the active session row no longer has origin metadata, persisted `route` remains the routing source of truth so the follow-up preserves provider, target, and thread/topic rather than leaking to the tool caller's current route. Persisted `completionWakeSummaryRequired` is a pending-delivery repair flag: it is cleared only when the routed wake transport succeeds with a non-empty final response that is not `NO_REPLY`; LLM-authored marker text and skip reasons are not delivery proof. For PR outcomes, the canonical status is the only message that carries the raw PR URL, while follow-up wakes refer to the PR by number, repository, and branch to avoid repeated link previews.

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
- fresh Codex and OpenCode worktree launches use plugin-managed worktrees, while persisted Codex backend refs can restore native backend worktree context during resume
- push and PR flows need a configured remote
- the main checkout is not modified during isolated worktree execution
- cleanup is lifecycle-driven: safe cleanup applies only to `merged`, `released`, `dismissed`, and `no_change`

Backend capabilities intentionally differ:

- Claude Code: plugin-managed worktree substrate
- Codex App Server: plugin-managed fresh worktrees plus native backend worktree restore refs
- OpenCode: plugin-managed worktree substrate
- User-facing worktree strategy and decision UX remain identical above all built-in harnesses

## Design Decisions

1. The plugin treats coding sessions as managed background jobs, not as inline chat completions.
2. Notification transport is gateway-owned. Direct notifications use runtime channel adapters, and wake/fallback paths use OpenClaw gateway/system event surfaces instead of a plugin-owned transport.
3. `Session` is an event emitter, not a callback bucket. This keeps the lifecycle model explicit.
4. Subprocess use is an accepted part of the architecture, but it should stay limited to backend launch, worktree/PR operations, gateway-owned delivery, and explicit verifier commands.
5. Runtime GC and persisted resume are separate concerns. Eviction from memory does not mean losing the session.
6. Worktree decisions are first-class orchestration states, not afterthoughts bolted on after completion.
7. Codex, Claude Code, and experimental OpenCode share the same session-centric control plane even though their backend transports differ.
8. Worktree cleanup is lifecycle-first and evidence-based. Tooling and maintenance only remove worktrees when local repository evidence proves a safe resolved state such as `merged`, `released`, `dismissed`, or `no_change`.

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
