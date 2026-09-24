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
  -> openclaw/plugin-sdk/channel-outbound sendDurableMessageBatch (direct notifications)
  -> openclaw gateway call chat.send (orchestrator wakes)
  -> api.runtime.system.enqueueSystemEvent (+ requestHeartbeat for wake fallbacks only)

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

- 18 tools
- 11 chat commands
- the shared interactive callback handlers for Telegram and Discord
- the background session service

Service startup loads config, instantiates `SessionManager`, restores persisted state, and bootstraps the maintenance schedules (worktree retention cleanup, reminders, output-file cleanup). There is no startup sweep of unmanaged worktree directories.

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

Sessions launched with a bound OpenClaw session key also mirror high-level lifecycle progress into a gateway-owned flow record through `api.runtime.tasks.async.managedFlows`. The adapter captures each lifecycle event and serializes its asynchronous mutations per session, using the latest completed flow revision. It does not fall back to the deprecated synchronous task API. Mirroring stays opportunistic: a failed mutation is logged and retried on the next lifecycle event, and a host that cannot persist the flow (`tryCreateManaged` returns `null`) leaves the session unmirrored. Flows are created with `tryCreateManaged`; a user stop records `requestCancel` so the host settles the flow as `cancelled`. The mirror also honors host-side cancellation (`openclaw tasks flow cancel`): it re-reads the flow every 15 s and inspects every mutation result, and a cancel intent stops the session through `SessionManager.kill`.

Service startup joins persisted mirror reconciliation before exposing the session manager or starting maintenance. Terminal persistence waits for mirror finalization, and service shutdown drains pending mirror and terminal work before disposing the manager and clearing the runtime. Synchronous plugin registration and session construction remain unchanged. The async managed-flow binding is part of the supported OpenClaw floor (2026.9.6), so OCA uses it directly; no synchronous or legacy mirror surface is consulted.

The opt-in `tests/session-task-lifecycle-candidate.test.ts` exercises actual async SQLite mutations, delayed creation, terminal drainage, and persisted recovery against an independently installed OpenClaw source checkout. Candidate `b01c37d6692eb7ccec7a50c161b97a81e009a632` contains upstream #146495 (merge `5b792cf8f396ddc4c11f54d8d370d64a6354b2b2`). From the OCA checkout, set `OPENCLAW_TASKFLOW_CANDIDATE` to that source directory and `TSX_TSCONFIG_PATH` to its `tsconfig.json`, then run `node --import "$OPENCLAW_TASKFLOW_CANDIDATE/scripts/tsx.mjs" --test tests/session-task-lifecycle-candidate.test.ts` on each supported Node lane. The test uses temporary state and closes the candidate's workers; the regular verification suite skips this optional source gate.

### Harness Abstraction

`src/harness/types.ts` defines the `AgentHarness` interface. The built-in harnesses are:

- `claude-code`: native Claude Code harness. `canUseTool` intercepts `AskUserQuestion` (structured pending input) and holds `ExitPlanMode` open as a native plan-approval request that approve/revise decisions answer directly
- `codex`: native Codex App Server harness (typed against vendored `codex app-server generate-ts` output in `src/harness/codex-app-server-protocol/`) with structured pending input and approvals, structured plan artifacts, backend refs, steering, rewind/fork, and compact/review thread actions
- `opencode`: experimental OpenCode server harness using one lazily started, shared local `opencode serve` process, classic session routes with `?directory=` for prompts/messages/replies, event-stream turn completion, OpenCode's built-in `plan`/`build` agents, native pending input, plugin-managed worktrees, and no native OpenClaw plan artifacts

Important mapping detail:

- Claude Code maps plugin `permissionMode` directly to the SDK modes. Plan approval leaves plan mode through the `ExitPlanMode` permission result (`setMode`), not through a prompt.
- Codex runs through the Codex App Server transport. Plugin `plan` mode maps to Codex's `plan` collaboration mode and remains a plugin-owned approval workflow even when the backend exposes structured plan artifacts; the session system prompt travels as thread `developerInstructions`. Codex's sandbox/approval settings come from `harnesses.codex` and do not change with the OCA permission mode. Codex worktree launches use the plugin-managed worktree as the thread cwd (the App Server has no worktree API).
- Codex follow-ups during a running turn are steered into it; `compact` and `review` thread actions travel through the same ordered prompt stream as user messages so they never overlap a turn.
- OCA keeps its own verifier-driven goal loop for every harness instead of Codex's native `thread/goal/*`, which is Codex-only and model-judged.
- OpenCode runs through one shared localhost OpenCode server. Fresh prompts use classic `prompt_async`; completion comes from the demultiplexed `/global/event` stream (`session.idle`), with session-status polling only while that stream is disconnected. Message/result fetches, permission/question replies, session create, fork, abort, and permission-rule updates use classic routes. Plan mode prompts the built-in `plan` agent; approved plans continue on the `build` agent. If the server dies, in-flight turns fail and the next turn starts a new server.
- `agent_respond` is the only continuation primitive across built-in backends; fork flows still go through `agent_launch(..., resume_session_id=..., fork_session=true)`.

Boundary note:

- this plugin's internal `codex` harness is local to this plugin
- it is separate from OpenClaw core's bundled `codex` provider/harness plugin
- this plugin's experimental `opencode` harness is local to this plugin
- it is also separate from ACPX, which is an ACP backend rather than this plugin's execution runtime

### `WakeDispatcher`

`src/wake-dispatcher.ts` owns outbound lifecycle delivery:

- direct user-notification path: the host durable outbound queue (`sendDurableMessageBatch` from `openclaw/plugin-sdk/channel-outbound`)
- wake path: `openclaw gateway call chat.send`
- fallback path: in-process `api.runtime.system.enqueueSystemEvent`; wake fallbacks add an immediate `requestHeartbeat`, while notice fallbacks wait for the origin session's next turn (see REFERENCE "OpenClaw Host Integration" for why: every host heartbeat runs the agent's full heartbeat routine)
- bounded retries for `chat.send` and system events; direct sends are single-attempt because the host queue owns retry of an admitted send
- per-session retry timers
- structured delivery logs
- no per-instance process signal hooks

`SessionNotificationService` decides the delivery-state transitions. `WakeDispatcher` decides how to deliver each transport request.

Security boundary note:

- direct notifications use the gateway-owned durable outbound queue in-process instead of shelling back into `openclaw message send`, avoiding service re-entry while preserving account and topic/thread routing
- Telegram and Discord interactive direct notifications send the same channel-agnostic `presentation`; core renders the native buttons, and only callback/routing details remain provider-specific

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

This keeps plan approval and worktree decisions inside the plugin instead of leaking semantic callback payloads into chat. Buttons carry opaque action tokens, not `verb:session` strings. When a newer review state supersedes an older one, the plugin invalidates older plan-decision tokens and clears the prompt controls on transports that support edits. If an already-visible old control still sends a callback, the handler may report it as stale. When the transport cannot deliver or render buttons, the same review version can still be decided by plain text in the session thread.

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
  -> SessionManager.launchSession()
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

For `ask`, Telegram and Discord plan buttons share OpenClaw's direct-message presentation contract. Plain text `Approve`, `Revise`, and `Reject` is accepted only while the session is awaiting a plan decision; `Approve`, `Revise`, `Reject`, or kill closes that review version, invalidates its plan-decision tokens, and clears old controls where the transport allows it. Stale callbacks can still be acknowledged as stale if a client surfaces an old prompt.

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
- persisted Codex and OpenCode resume state is restored through the backend thread ref; Codex resumes with `excludeTurns: true`, and `rewind_turns` forks before or reverts the latest turns

## Persistence Model

Persisted session storage exists to make sessions recoverable and observable after runtime GC or restart.

Path precedence:

1. `OPENCLAW_CODE_AGENT_SESSIONS_PATH`
2. `<stateDir>/code-agent-sessions.json`, where `<stateDir>` comes from the host's public `resolveStateDir` (`OPENCLAW_STATE_DIR`, else `$OPENCLAW_HOME/.openclaw`, else `~/.openclaw`)

The index is written with the host `json-store` helper (private file, fsync'd temp write, atomic rename). Full session output transcripts live in `<stateDir>/plugin-state/openclaw-code-agent/output/`.

Stored data includes:

- internal ID and name
- harness, model, and backend ref
- requested and effective permission modes plus deterministic approval/execution state
- workdir and worktree metadata
- persisted worktree lifecycle state, resolution source, and cleanup notes
- origin routing metadata
- backend conversation ID for diagnostics and recovery
- output stubs and persisted stream references

`backendRef` is required for all new-schema sessions. Pre-App-Server Codex SDK rows (Codex sessions without a `codex-app-server` backend ref) are dropped on load; there is no legacy migration path.

## Notification Pipeline

The notification pipeline is intentionally centralized:

1. `SessionManager` builds one notification request per event.
2. `WakeDispatcher` decides whether it is notify-only, wake-only, or both.
3. Direct user notifications go through the host durable outbound queue; Telegram and Discord interactive notifications attach buttons as a `presentation`.
4. Wakes use `chat.send` because it targets the originating runtime session precisely.
5. An in-process system event (targeting the origin session when known) is the recovery path when a wake fails or the session has no deliverable route. A text-only notification whose durable send definitively failed is also handed to the agent session as a system event; notifications with buttons or that require direct delivery are reported as failed instead, and a send with an unknown outcome (timeout) is never followed by a system event. Only a wake fallback requests an immediate host heartbeat. The host has no lighter wake: a heartbeat for a generic system event runs the agent's configured heartbeat prompt and routine. A notice fallback is therefore only enqueued and reaches the orchestrator on the origin session's next turn.

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
- new-worktree provisioning (`src/worktree-provisioning.ts`): `.worktreeinclude` gitignored-file copies and the repository's `.openclaw/worktree-setup.sh`, with rollback of the worktree and new branch on failure

Every `git` / `gh` call in this layer is asynchronous and goes through `src/git-exec.ts` (argument arrays, per-call timeouts, closed stdin). Because the calls no longer block the event loop, multi-step mutating sequences (worktree add/remove, checkout plus merge, branch deletion) are serialized per repository, session launches are serialized in `SessionManager.launchSession`, and persisted-session maintenance applies only the latest schedule computed for a session.

`src/worktree-lifecycle-resolver.ts` sits above those helpers and produces:

- persisted lifecycle state
- derived lifecycle state such as `released`
- retained reasons
- clean-all-safe eligibility

Important constraints:

- worktree creation only happens for git repos
- every harness uses plugin-managed worktrees; there is no backend-native worktree restore
- push and PR flows need a configured remote
- the main checkout is not modified during isolated worktree execution
- cleanup is lifecycle-driven: safe cleanup applies only to `merged`, `released`, `dismissed`, and `no_change`

Backend capabilities intentionally differ:

- Claude Code: plugin-managed worktree substrate
- Codex App Server: plugin-managed worktree substrate (the worktree is the thread cwd)
- OpenCode: plugin-managed worktree substrate
- User-facing worktree strategy and decision UX remain identical above all built-in harnesses

## Design Decisions

1. The plugin treats coding sessions as managed background jobs, not as inline chat completions.
2. Notification transport is gateway-owned. Direct notifications use the host durable outbound queue, wakes use `chat.send`, and fallbacks use runtime system events instead of a plugin-owned transport.
3. `Session` is an event emitter, not a callback bucket. This keeps the lifecycle model explicit.
4. Subprocess use is an accepted part of the architecture, but it should stay limited to backend launch, worktree/PR operations, the `chat.send` wake (in-process gateway requests are trusted-only), plugin self-update, and explicit verifier commands.
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

The persisted-session store is loaded row by row. A store with an older schema version (or a pre-schema array store, or a wrongly shaped collection) is archived whole to a timestamped `.legacy-*.json` backup and replaced with a fresh index. Within a current-schema store, rows or action tokens that no longer normalize are dropped individually after a verbatim `.legacy-*.json` backup is written, so valid sessions survive an upgrade; if the backup cannot be written, the whole store is archived instead. Unknown enum values normalize to `undefined`, and worktree rows without `worktreeLifecycle` get one synthesized from the older `worktreeMerged` / `worktreeDisposition` / `worktreeState` fields.

New persisted sessions must carry explicit `route` metadata, and any persisted worktree session must carry `worktreeBranch`. Runtime control flow treats a direct persisted route as canonical, repairs degraded notification routes from `originChannel` / `originSessionKey` when needed, and does not infer branch state from worktree paths.
