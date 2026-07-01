# Changelog

All notable changes to `openclaw-code-agent` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.5.7] - 2026-06-30

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.11` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.11` compatibility guidance for the updated SDK API baseline, new `openclaw/plugin-sdk/agent-harness-tool-runtime` export boundary, current callback/completion behavior, cron/session delivery behavior, yielded output/media preservation, plugin tool allowlists, and OCA-owned plan, wake, Codex harness, and worktree follow-through flows.

## [4.5.6] - 2026-06-26

### Fixed
- Treated Telegram `message is not modified` reply-markup cleanup responses as idempotent during plan approval callbacks so already-cleared buttons do not block approval execution from resuming.

## [4.5.5] - 2026-06-24

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.10` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.10` compatibility guidance for fast-talk state persistence, session/channel routing, cron delivery awareness, trusted hook policies, provider model routing, setup registry refresh, Codex/Claude harness model restrictions, plugin tool allowlists, disabled bundled plugin behavior, pnpm workspace metadata, and OCA-owned plan, callback, wake, completion, and worktree follow-through flows, including the latest stale plan approval retry-button and serialized callback fixes.

## [4.5.4] - 2026-06-21

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.9` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.9` compatibility guidance for installed channel plugin discovery, official provider package externalization, declared tool allowlists, plugin write ownership checks, manifest/package metadata contracts, cron/tool behavior changes, yielded media/completion handling, default cron `runMode="due"` behavior, and the current-main callback/follow-up fixes for native callback data, delayed/raw callback handling, serialized plan decisions, retryable token consumption, and PR update summary dedupe.

## [4.5.3] - 2026-06-19

### Fixed
- Normalized Codex model aliases before launch validation so configured defaults, launch requests, and Codex app-server model arguments resolve consistently.
- Preserved stale released worktree reminders when released evidence exists but cleanup still needs a user decision, keeping follow-up actions visible for old completed sessions.

### Changed
- Pinned vulnerable transitive `tar` ranges to `7.5.16` through pnpm overrides so production audits use the patched release.

## [4.5.2] - 2026-06-18

### Fixed
- Guarded Codex App Server resume attempts so plugin-owned session IDs are not sent as backend thread IDs; invalid resume IDs now start a fresh Codex thread instead of failing the app-server resume path.
- Hardened Codex App Server startup by defaulting launches to the stdio listener, extending request timeouts, and including redacted recent stderr in timeout diagnostics.
- Kept pending worktree decision reminders policy-aware when repository policy state is unavailable, preserving Merge/Open PR/Later/Discard actions instead of hiding valid follow-through buttons.
- Updated the Hono production audit override to `4.12.25` so the OpenClaw `2026.6.8` dependency tree stays clear under `pnpm audit --prod`.

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.8` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.8` compatibility guidance for richer Telegram delivery, WhatsApp ACP bindings, Codex startup/resume hardening, worktree decision follow-through, agent/Gateway recovery, provider/model replay hardening, usage footer hooks, managed plugin update repair, and release/test reliability.

## [4.5.1] - 2026-06-12

### Changed
- Retargeted the OpenClaw package and plugin SDK validation metadata to `2026.6.6` while keeping the compatible `>=2026.4.21` peer/API floor.
- Refreshed OpenClaw `2026.6.6` compatibility guidance for wake routing, Telegram topic callbacks, cron/session delivery, runtime tool allowlists, bundled plugin boundaries, Codex/Claude harness model restrictions, and managed worktree follow-through.

## [4.5.0] - 2026-06-12

### Added
- Added repository integration policies for managed worktree sessions, including policy storage, chat/tool commands, policy-aware worktree buttons, and deferred launch continuation after the user chooses how OCA may integrate with a repository.
- Added repo-policy choice buttons for unknown repositories and preserved the original launch context through manual or button-based policy selection.
- Added the built-in `oca` natural-language alias for OpenClaw Code Agent sessions.
- Added structured pending-input option handling so Codex and other harnesses can present compact question buttons while preserving full option semantics.

### Fixed
- Fixed worktree decision prompts so successful Merge/Open PR actions clear the original buttons without posting duplicate selection acknowledgements, while merge and PR outcome summaries remain authoritative.
- Fixed stale plan, pending-input, legacy question, repo-policy, and manual policy continuation callbacks so old buttons cannot affect newer review state or duplicate launches.
- Fixed repo-policy handling in resolver failures, reminders, fallback buttons, and restored sessions so live policy is respected consistently.
- Fixed cross-repository PR head lookup and agent merge cleanup reporting.
- Serialized OpenCode server startup to avoid shared SQLite lock failures.
- Preserved deferred repo-policy worktree strategy, cleared stale manual repo-policy prompts, and rescheduled no-op action-token expiry purges so deferred button state cannot strand later token deadlines.
- Sanitized rendered Telegram inline button callback payloads so invalid callback data cannot reach Telegram delivery.
- Cleared consumed Start Plan buttons when plan-offer launch fails so the chat does not leave a stale retry action visible.

### Changed
- Improved worktree decision summaries with concise implementation details and shorter button rows.
- Agent-created PRs now open as drafts by default.
- Updated OpenClaw, Claude Agent SDK, and Node type dependencies.

## [4.4.2] - 2026-06-07

### Fixed
- Fixed recovered persisted-only sessions so `agent_kill` can dismiss interrupted records without reporting a missing live session.
- Fixed OpenCode turn completion detection so stable assistant output or SSE idle events can complete a turn when classic status polling times out or remains busy.
- Fixed already-merged auto-merge worktrees so ancestry-merged branches are marked merged instead of flagged as suspicious base advancement.
- Preserved active or dirty worktree lifecycle state while recording repository-derived merged/released evidence, avoiding premature cleanup decisions.

## [4.4.1] - 2026-06-07

### Added
- Added static guardrails for source-level explicit `any`, unused private methods, goal command/tool drift, PR metadata safety placement, and notification diagnostic gating.
- Added grouped session state snapshot helpers for approval, worktree, backend, and routing state so persistence paths can consume stable typed state groups.

### Fixed
- Fixed session control patch semantics so explicit `undefined` clears optional active-session fields while omitted persisted patch fields preserve live state.
- Fixed persisted-to-active state sync so approval prompt fields, completion wake fields, and pending worktree decision fields clear deterministically without accidental drift.
- Stabilized OpenCode startup readiness retries so a timed-out `/api/health` probe is isolated and later startup probes can still succeed.
- Gated notification decision stderr diagnostics behind opt-in diagnostics configuration while preserving testable decision logs.

### Changed
- Moved `SessionManager` service assembly into an internal factory while keeping `SessionManager` focused on orchestration entrypoints.
- Consolidated goal status, stop, and edit rendering through a shared application layer used by both tools and chat commands.
- Moved generated PR metadata evidence, redaction, schema validation, prompt-leak checks, and body formatting out of `agent_pr` into a dedicated PR metadata module.
- Migrated metrics and lifecycle coverage away from private `SessionManager` compatibility wrappers and hardened guardrails so those wrappers do not return.

## [4.4.0] - 2026-06-06

### Added
- Added experimental OpenCode harness documentation, manifest guidance, and smoke-test instructions for the local `opencode serve` integration.
- Added experimental OpenCode harness support so `agent_launch`, `goal_launch`, resume handling, plan gating, worktree strategies, and session storage can run through `opencode`.
- Added `agent_request_worktree_decision` as a tool contract so orchestrator wakes can request a state-aware worktree decision prompt without relying on chat commands.

### Fixed
- Allowed OpenCode launches and goal tasks to omit a plugin default model so OpenCode can use its configured provider default.
- Externalized the canonical OpenClaw plugin SDK entry helper from the bundled release artifact to keep bundle size comfortably below the CI limit.
- Fixed OpenCode compatibility with v2 API routing, API-prefixed server routes, managed readiness retries, and classic session lifecycle handling while v2 session wait remains unavailable.
- Fixed OpenCode turn-idle detection so sessions wait for stable assistant completion instead of timing out while backend activity has already settled.
- Hardened completion-summary ownership and notification idempotency so goal, terminal, delegated worktree, PR, and routed wake paths collapse duplicate user-visible summaries while preserving retryable delivery state.
- Fixed delegated worktree notification follow-through, duplicate goal completion statuses, foreground goal summary dedupe, duplicate Later snooze confirmations, and duplicate PR/worktree follow-up summaries.
- Removed LLM-marker-based completion follow-up dedupe as the source of truth; delivery state and semantic outcome identity now govern whether a follow-up should be retried or suppressed.

### Changed
- Session and launch surfaces now include clearer harness/model labels using `harness | model` formatting where the launch status needs both values.
- OpenCode docs now describe the experimental harness as a localhost `opencode serve` integration using OpenCode's configured provider default unless a launch passes an explicit `provider/model`.

## [4.3.8] - 2026-06-04

### Added
- Added `goal_edit` support so active goal tasks can be refined without relaunching the surrounding workflow.
- Added goal iteration summaries so goal progress updates preserve a concise account of what changed between iterations.

### Fixed
- Deduplicated goal-owned terminal completion follow-up wakes so goal success and terminal completion paths collapse to one routed human summary while preserving the canonical plugin status line.
- Deduplicated PR/worktree follow-up summaries using the resolved notification route and material PR outcome key, while still allowing later PR updates with new commits to produce a fresh summary.
- Persisted and restored `goalTaskId` for worktree notification targets so restored goal-owned flows keep the same terminal outcome key after restart or reroute.

### Changed
- Refreshed ACP comparison guidance for current Codex chat binding and explicit ACP routing behavior.

## [4.3.7] - 2026-06-03

### Fixed
- Treated summaries inside `agent_output(session, full=true)` as source material rather than visible delivery, so completion follow-up wakes still post a short routed summary when the user only saw the canonical plugin status line.
- Rejected the stale `COMPLETION_FOLLOWUP_SKIPPED: already summarized by completed session` marker so incomplete completion follow-ups remain retryable instead of being silently cleared.
- Suppressed generic terminal completion notifications after worktree strategy handling already sent an authoritative merge or PR outcome notification, preserving the contract of canonical plugin status plus at most one orchestrator-owned human summary.

## [4.3.6] - 2026-06-03

### Fixed
- Fixed duplicate completion follow-up summaries by releasing completion wake keys on notify-only exits and bounding the completion wake dedupe cache.
- Fixed Start Plan button cleanup so consumed, missing-context, and retried plan-offer callbacks clear the original prompt without surfacing raw callback text.

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.6.1` while keeping the peer and plugin API floors at `>=2026.4.21`.
- Kept the rebased release lockfile on `@anthropic-ai/claude-agent-sdk@0.3.162` and `tsx@4.22.4` from the current `main` dependency baseline.
- Documented the `2026.6.1` compatibility verdict: no plugin source migration was required because `openclaw-code-agent` still imports only `openclaw/plugin-sdk/plugin-entry`, declares its tool surface through `contracts.tools`, and owns its own session store, wake routing, callbacks, worktree flows, and harness model restrictions.
- Refreshed operator guidance for plugin install/index lookup, approval callback behavior, Telegram/topic routing, cron-origin wake delivery, Codex/Claude harness policy boundaries, runtime tool allowlists, disabled bundled plugin behavior, and worktree `delegate`/`ask`/`auto-pr` follow-through under OpenClaw `2026.6.1`.

## [4.3.5] - 2026-06-01

### Fixed
- Hardened Telegram interactive callback handling for OpenClaw `2026.5.28` by accepting the current native callback shape when `callback.payload` is absent and only the full `callback.data` value is provided.
- Deferred OCA worktree outcome follow-up wakes until after merge or PR terminal status is visible, so the orchestrator reads the canonical outcome before sending the routed summary.
- Made OCA completion follow-up wake retries crash-safe and semantic: persisted retry state survives restarts, and `completionWakeSucceededAt` is recorded only after visible follow-up delivery is proven.

### Changed
- Kept the local OpenClaw package target on `openclaw@2026.5.28` while retaining the peer and plugin API floors at `>=2026.4.21`.
- Refreshed release compatibility guidance for OpenClaw `2026.5.28`, including callback/API hardening, runtime tool allowlists, and Codex/Claude harness policy boundaries.

## [4.3.4] - 2026-05-31

### Fixed
- Hardened Telegram interactive callback handling for OpenClaw `2026.5.28` by accepting the current native callback shape when `callback.payload` is absent and only the full `callback.data` value is provided.
- Added regressions for Telegram forum-topic Start Plan, Dismiss, plan-approval, and unauthorized callback flows so `code-agent:<token>` button payloads are consumed by OCA instead of surfacing as raw chat text.

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.28` while keeping the peer and plugin API floors at `>=2026.4.21`.
- Documented the `2026.5.28` compatibility verdict: no plugin source migration was required because `openclaw-code-agent` still imports only `openclaw/plugin-sdk/plugin-entry`, declares its tool surface through `contracts.tools`, and owns its own session store, wake routing, callbacks, worktree flows, and harness model restrictions.
- Refreshed operator guidance for per-plugin npm install roots, `openclaw.compat.pluginApi` package selection, Telegram/topic routing, Start Plan and approval callbacks, cron-origin wake delivery, Codex/Claude harness policy boundaries, runtime tool allowlists, disabled bundled plugin behavior, and worktree `delegate`/`ask`/`auto-pr` follow-through under OpenClaw `2026.5.28`.

## [4.3.3] - 2026-05-27

### Fixed
- Fixed merged worktree session listings so completed worktree outcomes render the resolved lifecycle state and summary consistently.
- Restored Telegram-native action button styling safely by omitting unsupported generic style fields while preserving callback payloads.
- Avoided duplicate fallback notifications after worktree merge or PR outcomes when routed orchestrator wake delivery is already available.
- Improved `agent_pr` pull request descriptions so generated PR bodies include clearer change summaries, validation metadata, and repository/worktree context without false-positive framework labels.

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.26` while keeping the peer floor at `>=2026.4.21`.
- Documented the `2026.5.26` compatibility verdict: no plugin source migration was required because `openclaw-code-agent` still imports only `openclaw/plugin-sdk/plugin-entry`, declares its tool surface through `contracts.tools`, and owns its own session store, wake routing, callbacks, worktree flows, and harness model restrictions.
- Refreshed operator guidance for Telegram topic routing, Start Plan and approval callbacks, cron-origin wake delivery, Codex/Claude harness policy boundaries, runtime tool allowlists, disabled bundled plugin behavior, and worktree `delegate`/`ask`/`auto-pr` follow-through under OpenClaw `2026.5.26`.
- Refreshed dependency metadata by updating the transitive Anthropic SDK lockfile resolution and removing stale pnpm build allowlist entries no longer needed by the current OpenClaw target.

## [4.3.2] - 2026-05-26

### Fixed
- Fixed Telegram worktree decision prompts by stripping generic button `style` fields from Telegram-native callback buttons before dispatch.

## [4.3.1] - 2026-05-25

### Fixed
- Fixed Telegram callback button payload handling so OpenClaw cross-channel callback data is preserved before interactive plan, Start Plan, and worktree decision actions reach the plugin.

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.22` while keeping the peer floor at `>=2026.4.21`.
- Documented the `2026.5.22` compatibility verdict: no plugin source migration was required for the new channel-message poll, row-level session workflow, generic harness task completion, embedding/source-provider, cron delivery, or Codex app-server SDK surfaces because `openclaw-code-agent` still imports only `openclaw/plugin-sdk/plugin-entry` and owns its own session store.
- Refreshed operator guidance for Telegram topic routing, Start Plan and approval callbacks, completion wakes, worktree `delegate`/`ask`/`auto-pr` follow-through, runtime tool visibility, disabled bundled plugin boundaries, and Codex/Claude harness model restrictions under OpenClaw `2026.5.22`.

## [4.3.0] - 2026-05-20

### Added
- Added Codex `harnesses.codex.fastMode` configuration so Codex App Server thread, resume, and turn payloads can opt into `service_tier: "fast"` for new and continued Codex sessions.
- Added orchestrator-owned follow-up summary wakes after merge and PR worktree terminal outcomes, including route preservation back to the originating chat/thread.

### Changed
- Kept Codex reasoning effort on the current App Server `reasoningEffort` field across fresh thread, resume, and turn-start payloads, including plan-mode collaboration settings.
- Updated the local OpenClaw package target to `openclaw@2026.5.18` while keeping the peer floor at `>=2026.4.21`.
- Documented the `2026.5.18` compatibility verdict: no plugin compatibility code update was needed because the plugin SDK `plugin-entry` type surface was unchanged from `2026.5.12`, the manifest already uses `contracts.tools`, and this plugin only imports `openclaw/plugin-sdk/plugin-entry` from the OpenClaw SDK.
- Clarified that merge/PR tools first deliver the canonical plugin status line, then wake the orchestrator to read the full output and send one short factual routed summary.

## [4.2.4] - 2026-05-14

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.12` while keeping the peer floor at `>=2026.4.21`.
- Refreshed OpenClaw `2026.5.12` compatibility guidance around the current TaskFlow runtime surface, final/main Codex app-server churn, and plugin install/runtime scanning.

## [4.2.3] - 2026-05-07

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.7` while keeping the peer floor at `>=2026.4.21`.
- Refreshed OpenClaw `2026.5.7` compatibility guidance around plugin allowlists, bundled discovery, managed npm override inheritance, and Codex provider/runtime routing.

## [4.2.2] - 2026-05-06

### Fixed
- Fixed Codex `ask` and `delegate` worktree launches so fresh sessions start in the prepared plugin-managed worktree instead of the original checkout.
- Preserved worktree strategy, base branch, and PR target when auto-resuming sessions.
- Resumed missing Codex backend worktree refs conservatively without treating native restore metadata as fresh backend-managed execution.
- Added the default managed `.worktrees/` directory to the repo-local git exclude file when creating worktrees.

### Docs
- Replaced the README GIFs with static screenshots for direct completion, plan review, `ask` worktree decisions, and delegated worktree follow-through.
- Refreshed Codex worktree docs to distinguish plugin-managed fresh worktrees from native backend restore refs.

## [4.2.1] - 2026-05-06

### Changed
- Updated the local OpenClaw package target to `openclaw@2026.5.6` while keeping the peer floor at `>=2026.4.21`.
- Refreshed OpenClaw `2026.5.6` compatibility guidance around Codex route warnings, plugin-owned harness model restrictions, and adjacent bundled plugin boundaries.

## [4.2.0] - 2026-05-06

### Changed
- Extracted keyed async operation queueing from `SessionManager` and reused it for per-repository merge serialization.
- Reused the keyed operation queue for ordered wake dispatch and moved session maintenance scheduling into an internal service.
- Centralized chat command argument tokenization so `/agent`, `/agent_respond`, `/agent_output`, and `/goal` share quoted-argument handling.
- Reworked README goal-task examples to use human conversation prompts instead of command invocations.
- Updated the release workflow to publish the same packed artifact to npm and ClawHub.
- Reworked the README into a shorter operator-first guide and moved release-detail emphasis back to the changelog/reference docs.
- Aligned worktree decision button documentation with the current state-aware `Merge`, `Open PR`, `View PR`, `Sync PR`, `Later`, and `Discard` labels.
- Removed the stale `workflows/` package file entry because no workflows are shipped in the npm tarball.
- Reframed README examples around human chat workflows while keeping tools documented as the agent-facing API surface.
- Routed `/agent` through the shared launch resolver used by `agent_launch`, so chat commands and tool launches share workdir, model, routing, and resume-first behavior.
- Deduplicated goal launch validation and output formatting across `/goal` and `goal_launch`.
- Extracted shared plan-approval delivery guards/text builders and session output-preview selection from `SessionManager`.
- Updated the local OpenClaw package target to `openclaw@2026.5.5` while keeping the peer floor at `>=2026.4.21`.
- Added the generic `agent_send_plan_offer` helper for external workflows that need Start Plan / Dismiss buttons without a monitor-specific API.
- Removed the legacy monitor plan-offer tool aliases and compatibility callback path in favor of the generic plan-offer action tokens.
- Refreshed `@anthropic-ai/claude-agent-sdk` and `nanoid` dependency resolutions.

### Fixed
- Reused the shared model allowlist helper in agent launch resolution and cleaned up patch-era comments in launch, merge, session, and startup cleanup code.
- Corrected architecture docs for the current plugin entry surface: 15 tools and 9 chat commands.
- Updated plugin manifest worktree-strategy help text to remove stale `Merge locally` / `Create PR` button names.

## [4.1.2] - 2026-05-06

### Fixed
- Fixed Telegram plan approval prompts so the canonical Approve / Revise / Reject buttons are delivered through the shared direct-message presentation path.
- Added explicit plain-text Approve / Revise / Reject handling while a plan is awaiting review, so sessions remain controllable when interactive buttons cannot be delivered.
- Stopped stale Plan v2 approval prompts from resurfacing after a plan is rejected or the session is killed.

### Docs
- Refreshed README, operator reference, architecture, ACP comparison, development, contributor, and orchestration-skill docs around plan approval, Telegram buttons, text fallback behavior, diagnostics, and release-prep validation. The worktree-default note is a documentation correction: prior skill docs incorrectly described `defaultWorktreeStrategy` as defaulting to `off`; no runtime behavior changed, and the actual default remains `delegate`.
- Documented the release smoke evidence from the Builds & Tools topic: `rust-hello-world-minor-change-2` (`FzPCkqjh`) completed as `approved_then_implemented` after explicit approval, and a later run (`VmUBWOH2`) delivered a clean plan prompt without the old stale Plan v2-after-reject behavior.

## [4.1.1] - 2026-05-05

### Changed
- Updated the local OpenClaw build/test target to stable `2026.5.4` while keeping the minimum compatibility floor at `>=2026.4.21`.
- Aligned harness reasoning-effort handling with OpenClaw `v2026.5.4`: Claude Code now receives configured non-default effort, and Codex fresh thread starts include effort alongside resume and turn-start payloads.
- Added compatibility coverage for v2026.5.4 manifest contracts, model allowlists, disabled bundled-provider assumptions, callback delivery, and bounded monitor launch routing.

## [4.1.0] - 2026-05-01

### Added

- Wired code-agent sessions into OpenClaw's managed TaskFlow lifecycle when the current SDK runtime exposes the required managed-flow surface, with a no-op fallback for older runtimes.
- Added session TaskFlow lifecycle coverage for creation, progress, waiting states, terminal success/failure, revision-conflict handling, and runtimes without the managed-flow API.

### Changed

- Updated the local OpenClaw build/test target to stable `2026.4.29` while keeping the minimum compatibility floor at `>=2026.4.21`.
- Declared explicit startup activation so OpenClaw continues loading the plugin's background services and interactive handlers as startup activation becomes stricter.
- Let monitor-report Start Plan actions carry an explicit worktree strategy so release-follow-up jobs can run in managed branches and auto-open PRs instead of editing local `main`.
- Added compatibility guard coverage for OpenClaw `v2026.4.26`'s deprecated direct config load/write helper surface; plugin code should continue using injected runtime config and plugin-owned state instead of OpenClaw config mutation helpers.
- Refreshed the Claude Code SDK dependency through the current pnpm lockfile resolution.

### Fixed

- Fixed direct notification delivery and fallback handling so runtime-channel notification failures and timeouts are reported deterministically instead of hanging.
- Fixed canonical notification runtime-state handling so completion and no-change paths expose deterministic state rather than relying on transcript inference.
- Improved completion notification delivery diagnostics for direct user-notification paths.

## [4.0.1] - 2026-04-27

### Changed

- Updated the local OpenClaw build/test target to stable `2026.4.25` while keeping the minimum compatibility floor at `>=2026.4.21`.
- Added compatibility guard coverage for OpenClaw `v2026.4.25`'s persisted plugin install registry; plugin code must not read or write legacy authored install metadata.
- Added compatibility guard coverage for OpenClaw `v2026.4.24`'s removed embedded-extension factory path; future tool-result rewriting must use OpenClaw's runtime-neutral middleware contract when available for this plugin.

## [4.0.0] - 2026-04-24

### Breaking Changes

- Raised the minimum supported OpenClaw plugin/gateway contract from `>=2026.4.14` to `>=2026.4.21`.
- Removed the legacy Telegram `--buttons` fallback; interactive direct notifications now require the shared `message.send --presentation` contract.
- Removed the custom Discord component sender path; Discord interactive notifications now use the same shared direct presentation contract as Telegram.
- Migrated persisted approval-prompt transport metadata from `direct-telegram` to `direct-message`; older persisted sessions are normalized on restore.
- Refreshed the built-in model defaults to `anthropic/claude-sonnet-4-7` for Claude Code and `gpt-5.5` / `gpt-5.5-pro` for Codex.

### Changed

- Unified outbound interactive delivery across Telegram and Discord on one shared `message.send --presentation` path.
- Moved interactive button style selection into the shared session-interaction layer instead of transport-specific label inference.
- Added structured dispatch diagnostics for direct interactive delivery, including route, thread, button labels, and callback payload length metadata.
- Updated the local OpenClaw build/test target to stable `2026.4.23` while keeping the minimum compatibility floor at `>=2026.4.21`.

### Fixed

- Fixed Telegram approval delivery compatibility for routes that need the shared direct-message presentation contract.
- Preserved Discord callback cleanup behavior after moving outbound buttons away from the plugin-owned component sender path.

### Docs

- Updated README, reference, architecture, ACP comparison, and package/plugin metadata for the `4.0.0` breaking transport contract and `v2026.4.21` compatibility floor.

## [3.2.1] - 2026-04-22

### Changed

- Raised the external OpenClaw compatibility baseline to `v2026.4.14`.
- Prefer the `deliveryContext` / `requesterSenderId` tool-context surface introduced in newer OpenClaw releases while keeping legacy routing fallbacks for older fixtures and persisted state.
- Allowed `gpt-5.4-pro` in the built-in Codex model allowlist.
- Verified stable `v2026.4.21` compatibility and updated the local OpenClaw build/test target to `2026.4.21` without raising the minimum required gateway baseline.
- Added explicit compatibility coverage for auth-required chat commands and the Telegram topic `13832` monitor-report route used in release smoke checks.

### Fixed

- Cleared `BASH_ENV` / `ENV` from goal-task verifier subprocesses so shell startup hooks cannot silently rewrite verifier execution.
- Improved waiting-for-input notifications so forwarded question prompts carry cleaner recent context without echoing the same question text back at the user.
- Allowed worktree recreation to clean one stale blocked path when resuming against an existing branch before escalating to a hard failure.

### Security

- Added explicit plugin security checks plus dependency-review and security-audit workflow coverage.
- Refreshed vulnerable transitive dependency overrides and documented the current scanner findings and verifier-shell boundary.

## [3.2.0] - 2026-04-10

### Added

- One-attempt autonomous conflict resolution for `auto-merge`, followed by an automatic merge retry when the resolver succeeds.
- Lifecycle-first worktree resolution that can promote landed-but-not-topology-merged branches to `released` for safe cleanup and clearer status reporting.
- Shared release metadata validation so `package.json`, `openclaw.plugin.json`, and the intended release version are checked together before publish.

### Changed

- Returned ordinary successful terminal notifications to deterministic completion messaging only; the plugin no longer generates transcript-based completion summaries for users or wakes.
- Removed the remaining plugin-side no-change/report-only embedded-eval path so worktree completion messaging is fully deterministic.
- Changed the default `defaultWorktreeStrategy` back to `off`.
- Completion wakes now include explicit approval/execution context plus both requested and effective permission modes for plan-gated sessions instead of expecting the orchestrator to infer approval from transcript prose.
- Simplified worktree transition handling around shared pending-decision, conflict-resolving, and merged patch builders, and grouped live-session patch application around clearer control-state and worktree metadata boundaries.
- Standardized contributor and release validation around `pnpm verify`, removed the npm lockfile from the repo, and documented the new release metadata parity check.

### Fixed

- Normalized bare numeric Discord route targets to `channel:<id>` consistently across route/session-key handling and documentation.
- Preserved the dirty-worktree implicit-cleanup guard while removing the unshipped heuristic completion-summary behavior.
- Persisted deterministic approval/execution state so approved plan sessions now surface as `approved_then_implemented`, and plan-gate violations surface as `implemented_without_required_approval`, across terminal and no-change worktree completion paths.
- Fixed `auto-merge` so conflict handling now follows the real resolver path instead of falling through a dead code branch.
- Worktree free-space checks now probe the nearest existing ancestor of the configured base dir, so first-run and custom-dir launches validate the correct filesystem.
- Cross-repo PR auto-targeting now works when only `upstream` is configured.
- Release automation now rejects package/plugin version drift instead of validating only `package.json`.

### Docs

- Reframed the README, operator reference, and contributor docs around the concrete `3.2.0` improvements so the release story, upgrade notes, and release checklist all match the shipped behavior.

## [3.1.0] - 2026-03-28

### Breaking Changes

- Removed `multi_turn_disabled`; sessions are now multi-turn by default and no longer carry the old single-turn compatibility path.
- Changed worktree completion into an explicit pending-decision lifecycle for the newer review flows, including merge, PR, snooze, and dismiss outcomes.
- Expanded the public `worktree_strategy` surface to include `delegate`, which callers with pinned enums or schema validation must now accept.
- Persisted session storage is now new-schema-only. Older or invalid stores are archived to timestamped `.legacy-*.json` backups and are not migrated in place.

### Added

- Cross-repo PR targeting via `worktree_pr_target_repo`.
- Richer worktree decision state, including snooze / dismiss actions, PR-open tracking, and clearer merge-or-PR follow-through.
- A 4-button review flow for worktree decisions: `Merge locally`, `Create PR`, `Decide later`, and `Dismiss`.
- Bounded Codex semantic adapter for structured backend interaction.

### Changed

- Rewrote the control plane around explicit lifecycle, approval, runtime, delivery, and worktree state instead of heuristic status handling.
- Made resume behavior explicit: suspended sessions are resumable, launches are resume-first for linked sessions, and terminal sessions are no longer implicitly revived.
- Hardened notification delivery and split the wake pipeline into clearer route-resolution, delivery, and transport responsibilities.
- Stopped auto-pushing worktree branches by default; branches remain local until an explicit merge, push, or PR path chooses to publish them.
- Replaced Codex SDK with app-server backend.
- Standardized local and CI validation on `pnpm verify`.

### Fixed

- Removed plugin-side natural-language heuristics for waiting, planning, and worktree decisions in favor of explicit state and structured routing.
- Fixed worktree merge, cleanup, PR follow-through, and pending-decision handling so worktrees are preserved or cleaned up deterministically.
- Aligned Telegram and Discord interactive callbacks behind the same action-token model and tightened notification retry / shutdown behavior.
- Codex plan approval, reply forwarding, and worktree preamble behavior for plan-first sessions.
- Codex auth bootstrap so isolated homes live under OpenClaw state instead of temp paths.
- `agent_output` streaming for active sessions and conflict-resolver harness selection.
- Delegate-button routing, branch-decision messaging, and commit-misdirection reporting in worktree flows.
- Plan approval escalation, stale approval blocking, and idle-timeout button display.
- Streamed session output line buffering.
- Interactive notification fallback handling.
- Auto-resume for dead plan approvals.
- Killed-session resume behavior.
- Notification output previews now show the beginning of the output instead of the tail.

### Docs

- Rewrote the operator reference, aligned README messaging with the maintenance release, and normalized the full historical changelog.

## [3.0.0] - 2026-03-25

### Breaking Changes

- Changed the default `planApproval` mode to `ask` so plans are forwarded to the user unless the operator explicitly chooses otherwise.
- Changed the default `defaultWorktreeStrategy` to `ask`, making worktree isolation the default launch behavior at that stage of the project.
- Removed the earlier dismiss button from the `ask` worktree-decision UI at that point in history. Later releases replaced this with the broader explicit decision lifecycle.

### Changed

- Switched `agent_merge(strategy: "merge")` to a rebase-then-fast-forward flow, keeping merged history linear without merge commits.

## [2.4.0] - 2026-03-25

### Breaking Changes

- Removed `acceptEdits` permission mode. Use `default` for interactive sessions or `bypassPermissions` for fully autonomous execution.
- Replaced the old `worktree` boolean on `agent_launch` with `worktree_strategy`.
- Renamed `auto_cleanup` to `delete_branch` in `agent_merge`.
- Renamed `force` to `skip_session_check` in `agent_worktree_cleanup` while keeping `force` as a deprecated alias.

### Added

- Full git-worktree isolation with `off`, `manual`, `ask`, `delegate`, `auto-merge`, and `auto-pr` strategies.
- Worktree tools: `agent_merge`, `agent_pr`, `agent_worktree_status`, and `agent_worktree_cleanup`.
- PR lifecycle handling that can create, update, and inspect existing GitHub PRs instead of blindly opening duplicates.
- Resume-aware worktree context so branch, strategy, and PR metadata survive follow-up work.
- Daily stale-branch reminders, startup cleanup of abandoned worktrees, and stronger worktree creation safeguards.
- Telegram inline button callbacks for worktree decisions and Claude Code `AskUserQuestion` interception for plan/worktree approval flows.
- Better failure/wake notifications, per-session retry timers, larger output buffering, incremental output files, and CI/publishing workflows.

### Changed

- Defaulted `planApproval` to `ask` and `defaultWorktreeStrategy` to `ask` for safer out-of-box orchestration at that stage of the project.
- Switched base-branch detection to automatic detection instead of assuming `main`.
- Persisted the original repo `workdir` instead of the temporary worktree path so resume flows keep the correct repo context.
- Simplified `isGitRepo()` so it no longer depends on a configured remote.

### Fixed

- Button payload compatibility with the OpenClaw CLI callback shape.
- PR fallback behavior when the worktree directory is gone.
- Plan approval routing and permission-mode transitions across `ask`, `delegate`, and `approve`.
- Notification deduplication, turn-done debounce, startup recovery, worktree path races, branch collisions, lost worktree context, duplicate PR creation, and merge serialization.

## [2.3.1] - 2026-03-23

### Added

- Initial git-worktree support for isolated session branches.
- Opt-in worktree creation through `agent_launch(worktree: true)`.
- Discord wake notifications.

### Changed

- Kept worktree creation opt-in by default at this stage of the project.

### Fixed

- Worktree path collisions by adding random suffixes.
- SDK path resolution issues in early worktree-enabled launches.

## [2.3.0] - 2026-03-22

### Added

- Redirect support for active sessions via `agent_respond(interrupt: true)`.
- Turn-end wake signaling for completed turns.

### Changed

- Refined notification lifecycle wording and delivery behavior.

## [2.2.0] - 2026-02-XX

### Added

- Broad auto-resume for killed sessions through `agent_respond` except `startup-timeout`. Later releases replaced this with the explicit suspended-session resume model.
- Harness-scoped model defaults and allowlists.
- The Codex streaming harness based on the thread API.

### Fixed

- Codex resume startup confirmation.
- Codex `auth.json` race conditions through isolated per-session home handling.

## [2.1.0] - 2026-02-XX

### Added

- Multi-agent support with workspace-based channel routing.
- Plan approval modes: `ask`, `delegate`, and `approve`.

### Changed

- Default Codex approval policy to `on-request`.
- Raised the default session limit.

[Unreleased]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.7...HEAD
[4.5.7]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.6...v4.5.7
[4.5.6]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.5...v4.5.6
[4.5.5]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.4...v4.5.5
[4.5.4]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.3...v4.5.4
[4.5.3]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.2...v4.5.3
[4.5.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.1...v4.5.2
[4.5.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.4.2...v4.5.0
[4.4.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.4.1...v4.4.2
[4.4.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.4.0...v4.4.1
[4.4.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.8...v4.4.0
[4.3.8]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.7...v4.3.8
[4.3.7]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.6...v4.3.7
[4.3.6]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.5...v4.3.6
[4.3.5]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.4...v4.3.5
[4.3.4]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.3...v4.3.4
[4.3.3]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.2...v4.3.3
[4.3.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.1...v4.3.2
[4.3.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.3.0...v4.3.1
[4.3.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.4...v4.3.0
[4.2.4]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.3...v4.2.4
[4.2.3]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.2...v4.2.3
[4.2.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.1...v4.2.2
[4.2.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.1.2...v4.2.0
[4.1.2]: https://github.com/goldmar/openclaw-code-agent/compare/v4.1.1...v4.1.2
[4.1.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.1.0...v4.1.1
[4.1.0]: https://github.com/goldmar/openclaw-code-agent/compare/v4.0.1...v4.1.0
[4.0.1]: https://github.com/goldmar/openclaw-code-agent/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/goldmar/openclaw-code-agent/compare/v3.2.1...v4.0.0
[3.2.1]: https://github.com/goldmar/openclaw-code-agent/compare/v3.2.0...v3.2.1
[3.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/goldmar/openclaw-code-agent/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.4.0...v3.0.0
[2.4.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/goldmar/openclaw-code-agent/releases/tag/v2.1.0
