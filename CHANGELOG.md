# Changelog

All notable changes to openclaw-code-agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.0] - 2026-03-25

### Breaking Changes

- **`acceptEdits` permission mode removed** — removed from both harnesses and all APIs. Caused frequent approval stalls in automated sessions mid-execution. Migrate to `bypassPermissions` for fully autonomous execution or `default` for interactive sessions with standard permission prompts.
- **`worktree_strategy` parameter replaces the old `worktree` boolean** in `agent_launch`
  - Old: `worktree: true` → New: `worktree_strategy: "manual"`
  - Enum values: `"off"` (default) | `"manual"` | `"ask"` | `"auto-merge"` | `"auto-pr"`
  - `"delegate"` is available via `defaultWorktreeStrategy` plugin config but not exposed as a tool parameter
- **`auto_cleanup` parameter renamed to `delete_branch`** in `agent_merge`
- **`force` parameter renamed to `skip_session_check`** in `agent_worktree_cleanup` (`force` remains a deprecated alias)

### Added

#### Git worktree isolation
- **Full worktree strategy enum**: `off | manual | ask | delegate | auto-merge | auto-pr`
  - `manual` — creates worktree but no automatic action; branch is kept for manual `agent_merge` or `agent_pr`
  - `ask` — push branch, send Telegram inline buttons (Merge locally / Create PR / Dismiss), wake orchestrator with full decision context
  - `delegate` — push branch, wake orchestrator with diff summary + decision guidance; always sends brief one-liner to user
  - `auto-merge` — merge automatically; spawns Claude Code conflict-resolver session on conflicts
  - `auto-pr` — create/update GitHub PR with full lifecycle management; falls back to `ask` if `gh` unavailable
- **`defaultWorktreeStrategy` plugin config option** — set a default strategy for all new sessions
- **`worktreeDir` plugin config option** — override base directory for agent worktrees
- **`OPENCLAW_WORKTREE_DIR` env var** — alternative worktree base directory override

#### Worktree tools
- **Four new worktree management tools**: `agent_merge`, `agent_pr`, `agent_worktree_status`, `agent_worktree_cleanup`
- **PR lifecycle management** (`agent_pr` + `auto-pr`)
  - Detect and update existing open PRs instead of failing or duplicating
  - Detect merged PRs and notify
  - Detect closed PRs and prompt for action (reopen / delete branch / recreate)
  - `force_new` parameter to prevent accidental PR updates
  - Persist `worktreePrNumber` in session metadata for tracking
- **`agent_worktree_cleanup` hardening** — 12 fixes including:
  - Active session protection — never deletes branches with running/starting sessions
  - Open PR protection — never deletes branches with open GitHub PRs
  - Unmerged commit protection — never deletes branches with commits ahead of base
  - `session` parameter to dismiss a pending worktree decision without merging
  - Structured output: DELETED / KEPT–unmerged / KEPT–active-session / KEPT–open-PR
- **`agent_worktree_status`** prominently surfaces sessions with pending decisions
- **Resume + worktree context** — worktree context (branch, strategy, PR URL) is inherited automatically on resume via `resumeWorktreeFrom`

#### Worktree hardening
- **Stale branch reminders** — daily reminders for unresolved pending worktree decisions
- **Auto-cleanup of worktrees on startup** — abandoned worktrees from crashed sessions cleaned up at gateway restart (configurable via `OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS`, default 1 hour)
- Atomic mkdir + hex suffix prevents worktree creation race conditions
- Branch collision handling — reuses existing `agent/*` branches instead of failing
- 100 MB free-space check before worktree creation
- Base branch auto-detection: `OPENCLAW_WORKTREE_BASE_BRANCH` env → `origin/HEAD` → `main` → `master`
- `removeWorktree()` falls back to `rmSync` if git command fails
- `pruneWorktrees()` cleans up stale worktree metadata

#### Telegram inline buttons and callback routing
- **Inline keyboard buttons** on `ask` strategy worktree decisions (Merge locally / Create PR / Dismiss)
- **Callback router** (`src/callback-handler.ts`) — routes Telegram inline button responses back to the plugin and dispatches the correct worktree action
- **`AskUserQuestion` interception** (Claude Code only) — intercepts plan-approval and worktree-decision tool calls from the CC harness and handles them in the plugin layer before they surface in chat

#### Notifications
- **`output_mode: "deliverable"`** on `agent_launch` — sends `📄 Deliverable ready` instead of `✅ Completed` when the session finishes; use for document/report/artifact generation
- **Failure notification** now includes `harnessSessionId` and resume guidance for easier recovery
- **Per-session retry timers** for wake delivery — eliminates shared timer contention between concurrent sessions
- **`beforeExit` race fix** — notifications now complete before the process exits
- **Turn-complete notifications** suppressed for `ask` and `delegate` worktree strategies — the worktree decision notification replaces the turn-done ping
- Unified `agent_respond` notifications: `↪️` for all sends (including redirects), `👍` for plan approval (`approve: true`)

#### Plan approval
- **`planApproval: "ask"` restored** as a user-facing config option — orchestrator always forwards plans to the user, never auto-approves
- **Three distinct `planApproval` modes**:
  - `ask` — always forward to user, never auto-approve
  - `delegate` (default) — orchestrator decides: approve low-risk plans, escalate high-risk or ambiguous plans
  - `approve` — orchestrator may auto-approve after verifying workdir, scope, and codebase

#### Session output
- **Output buffer increased** from 200 to 2000 lines
- **Incremental streaming to `/tmp`** — output is streamed to a temp file as it arrives, reducing memory pressure

#### CI / publishing
- GitHub Actions workflows for CI, PR checks, and OIDC npm publishing
- PR template and contributing guide

### Changed

- `agent_pr` now handles full PR lifecycle (create / update / detect merged / detect closed) instead of just creation
- Base branch detection defaults to `detectDefaultBranch()` auto-detection instead of hardcoded `"main"`
- Session store persists original `workdir` (repo path) instead of the tmp worktree path, so resumed sessions reference the correct repo
- `isGitRepo()` simplified — no longer requires a configured remote
- `onSessionTerminal` is now async to support merge-back flow
- `planApproval` defaults to `"ask"` (always forward plans to user) — provides the safest out-of-box experience; set to `"delegate"` to let the orchestrator decide autonomously
- `defaultWorktreeStrategy` defaults to `"ask"` (push branch and send inline Telegram buttons on completion) — worktree isolation is now on by default; set to `"off"` to disable
- Session listing shows worktree branch name, merge status, and PR URL in `agent_sessions`

### Fixed

- Button format: `label` / `callbackData` field names mapped to `text` / `callback_data` for OpenClaw CLI compatibility
- `agent_pr` fallback when worktree dir is gone — uses persisted branch name instead of failing
- Plan approval auto-approve flow and permission mode split between `ask` / `delegate` / `approve`
- AskUserQuestion buttons in Claude Code harness — CC-only interception now correctly routes plan and worktree decisions through the plugin callback router
- Worktree lifecycle for PR path and `agent_merge` workdir fallback
- Notification deduplication — prevents duplicate wake pings when multiple events fire simultaneously
- Turn-done debounce — prevented stale turn-done events from firing after an `interrupt: true` redirect
- Startup recovery — sessions in `"running"` state at load are marked `"killed"` and orphaned worktrees are cleaned up
- Worktree creation race condition when multiple sessions use the same name
- Branch collision errors when resuming sessions with existing `agent/*` branches
- Lost worktree context when resuming sessions after worktree cleanup
- Duplicate PR creation (now detects and updates instead)
- Missing detached HEAD detection in `getBranchName()` (now returns `undefined`)
- `git worktree remove` and `rmSync` failures now both logged at error level
- Merge queue serialization — concurrent `agent_merge` calls are serialized to prevent conflicts

## [2.3.1] - 2026-03-23

### Added
- Git worktree support for isolated session branches
- Worktree creation via `worktree: true` parameter in `agent_launch`
- Discord notification support for wake events

### Changed
- Worktree creation is opt-in (defaults to `false`)

### Fixed
- Worktree path conflicts resolved with random suffix
- SDK path resolution issues

## [2.3.0] - 2026-03-22

### Added
- Redirect lifecycle for active sessions (`interrupt: true` in `agent_respond`)
- Turn-end wake signaling for all turn completions

### Changed
- Refined notification lifecycle wording

## [2.2.0] - 2026-02-XX

### Added
- Auto-resume for all killed sessions via `agent_respond` (except `startup-timeout`)
- Harness-scoped model defaults and allowlists
- Codex SDK streaming harness with thread API

### Fixed
- Codex auto-resume startup confirmation
- Codex auth.json race condition via isolated HOME per session

## [2.1.0] - 2026-02-XX

### Added
- Multi-agent support with workspace-based channel mapping
- Plan approval modes: `ask`, `delegate`, `approve`

### Changed
- Default Codex approval policy to `on-request`
- Raised default session limit

[Unreleased]: https://github.com/goldmar/openclaw-code-agent/compare/v2.4.0...HEAD
[2.4.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/goldmar/openclaw-code-agent/releases/tag/v2.1.0
