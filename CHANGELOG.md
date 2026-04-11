# Changelog

All notable changes to `openclaw-code-agent` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.0] - 2026-04-10

### Changed

- Returned ordinary successful terminal notifications to deterministic completion messaging only; the plugin no longer generates transcript-based completion summaries for users or wakes.
- Removed the remaining plugin-side no-change/report-only embedded-eval path so worktree completion messaging is fully deterministic.
- Changed the default `defaultWorktreeStrategy` back to `off`.
- Completion wakes now include explicit approval/execution context plus both requested and effective permission modes for plan-gated sessions instead of expecting the orchestrator to infer approval from transcript prose.
- Worktree status and cleanup are now lifecycle-first and repository-evidence-driven, including explicit `released` resolution, retained reasons, and deterministic clean-all-safe behavior.
- Simplified worktree transition handling around shared pending-decision, conflict-resolving, and merged patch builders.
- Standardized contributor and release validation around `pnpm verify` and removed the npm lockfile from the repo.

### Fixed

- Normalized bare numeric Discord route targets to `channel:<id>` consistently across route/session-key handling and documentation.
- Preserved the dirty-worktree implicit-cleanup guard while removing the unshipped heuristic completion-summary behavior.
- Persisted deterministic approval/execution state so approved plan sessions now surface as `approved_then_implemented`, and plan-gate violations surface as `implemented_without_required_approval`, across terminal and no-change worktree completion paths.
- `auto-merge` now performs one autonomous conflict-resolution attempt and retries automatically instead of falling through a dead resolver path.
- Worktree free-space checks now probe the nearest existing ancestor of the configured base dir, so first-run and custom-dir launches validate the correct filesystem.
- Grouped live-session patch application to keep control-state, metadata, and worktree sync behavior consistent, including explicit auto-merge field clears.
- Cross-repo PR auto-targeting now works when only `upstream` is configured.

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

[Unreleased]: https://github.com/goldmar/openclaw-code-agent/compare/v3.2.0...HEAD
[3.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/goldmar/openclaw-code-agent/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.4.0...v3.0.0
[2.4.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/goldmar/openclaw-code-agent/releases/tag/v2.1.0
