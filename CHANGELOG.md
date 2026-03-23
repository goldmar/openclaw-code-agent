# Changelog

All notable changes to openclaw-code-agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.0] - 2026-03-24

### Breaking Changes
- **`acceptEdits` permission mode removed** — removed from both harnesses and all APIs. Caused frequent approval stalls in automated sessions mid-execution. Migrate to `bypassPermissions` for fully autonomous execution or `default` for interactive sessions with standard permission prompts.
- **`worktree_strategy` parameter replaces the old `worktree` boolean** in `agent_launch`
  - Old: `worktree: true` → New: `worktree_strategy: "manual"`
  - Tool enum values: `"off"` (default) | `"manual"` | `"ask"` | `"auto-merge"` | `"auto-pr"`
  - `"delegate"` is available via `defaultWorktreeStrategy` plugin config but not exposed as a tool parameter
- **`auto_cleanup` parameter renamed to `delete_branch`** in `agent_merge`
- **`force` parameter renamed to `skip_session_check`** in `agent_worktree_cleanup` (`force` remains a deprecated alias)

### Features

#### Notifications
- **Unified `agent_respond` notifications**: ↪️ for all sends (including redirects), 👍 for plan approval (`approve: true`)
- **📄 Deliverable mode**: `output_mode: "deliverable"` on `agent_launch` sends `📄 Deliverable ready` instead of `✅ Completed` when the session finishes
- **Failure notification** now includes `harnessSessionId` and resume guidance to make recovery easier
- **Inline buttons** on all interactive notifications (Telegram inline keyboards for `ask` strategy worktree decisions)
- **Turn-complete notifications** suppressed for `ask` and `delegate` worktree strategies (the worktree notification replaces it)
- **Per-session retry timers** for wake delivery — no more shared timer contention
- **`beforeExit` notification race fix** — notifications now complete before the process exits

#### Worktree
- **Full worktree strategy enum**: `off | manual | ask | delegate | auto-merge | auto-pr`
  - `ask` — push branch, send Telegram inline buttons (Merge locally / Create PR / Dismiss), wake orchestrator with full decision context
  - `delegate` — push branch, wake orchestrator with diff summary + decision guidance; always sends brief one-liner to user
  - `auto-merge` — merge automatically; spawns Claude Code conflict-resolver on conflicts
  - `auto-pr` — create/update GitHub PR with full lifecycle management; falls back to `ask` if `gh` unavailable
- **`defaultWorktreeStrategy` plugin config option** — set a default strategy for all new sessions
- **PR lifecycle management** (`agent_pr` + `auto-pr`)
  - Detect and update existing open PRs instead of failing or duplicating
  - Detect merged PRs and notify
  - Detect closed PRs and prompt for action (reopen / delete branch / recreate)
  - `force_new` parameter to prevent accidental PR updates
  - Persist `worktreePrNumber` in session metadata for tracking
- **Four new worktree management tools**: `agent_merge`, `agent_pr`, `agent_worktree_status`, `agent_worktree_cleanup`
- **`agent_worktree_cleanup` hardening** (12 fixes)
  - Active session protection — never deletes branches with running/starting sessions
  - Open PR protection — never deletes branches with open GitHub PRs
  - Unmerged commit protection — never deletes branches with commits ahead of base
  - `skip_session_check` parameter (renamed from `force`) bypasses active-session check only; unmerged/PR protections always apply
  - `session` parameter to dismiss a pending worktree decision without merging
  - Structured output showing all four categories (DELETED / KEPT–unmerged / KEPT–active-session / KEPT–open-PR)
- **Stale branch reminders** — daily reminders for unresolved pending worktree decisions
- **`agent_worktree_status`** prominently surfaces sessions with pending decisions
- **Auto-cleanup of worktrees on startup failure** — abandoned worktrees from crashed sessions cleaned up at startup (configurable via `OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS`, default 1 hour)
- **Worktree lifecycle hardening**
  - Atomic mkdir + hex suffix prevents creation race conditions
  - Branch collision handling — reuses existing `agent/*` branches instead of failing
  - `removeWorktree()` falls back to `rmSync` if git command fails
  - `pruneWorktrees()` cleans up stale worktree metadata
  - 100MB free-space check before worktree creation
  - Base branch auto-detection: `OPENCLAW_WORKTREE_BASE_BRANCH` env → origin/HEAD → main → master
- **Resume + worktree context** — `resumeWorktreeFrom` ensures worktree context (branch, strategy, PR URL) is inherited when resuming a session, even if the harness thread resume was cleared (e.g. Codex)

#### Session output
- **Output buffer increased** from 200 to 2000 lines
- **Incremental streaming to `/tmp`** — output is streamed to a temp file as it arrives, reducing memory pressure

#### `planApproval`
- **`planApproval: "ask"` restored** as a user-facing config option — orchestrator always forwards plans to the user, never auto-approves

### New Utility Functions (`src/worktree.ts`)
- `detectDefaultBranch()` — multi-step detection (env var → origin/HEAD → main → master)
- `getBranchName()` — get current branch with detached HEAD detection
- `hasCommitsAhead()` — check if branch has commits ahead of base
- `getDiffSummary()` — commit count, file changes, insertions/deletions, and commit messages
- `pushBranch()` — push branch to remote
- `mergeBranch()` — merge with conflict detection and abort on failure
- `createPR()` — create GitHub PR via gh CLI
- `deleteBranch()` — delete git branch
- `syncWorktreePR()` — query PR state (open/merged/closed/none) via gh CLI
- `commentOnPR()` — add comment to existing PR
- `isGitAvailable()` / `isGitHubCLIAvailable()` — cached availability checks
- `hasEnoughWorktreeSpace()` — check free space before creation
- `pruneWorktrees()` — prune stale worktree metadata

### Changes
- `agent_pr` now handles full PR lifecycle (create/update/detect merged/detect closed) instead of just creation
- Base branch detection defaults to `detectDefaultBranch()` auto-detection instead of hardcoded `"main"`
- Worktree path format: `<OPENCLAW_WORKTREE_DIR>/openclaw-worktree-<session-name>`
- Session store persists original `workdir` (repo path) instead of the tmp worktree path
- `isGitRepo()` simplified — no longer requires a configured remote
- `onSessionTerminal` is now async to support merge-back flow
- Session listing shows worktree branch name, merge status, and PR URL in `agent_sessions`

### Fixes
- Turn-done debounce fix — prevented stale turn-done events from firing after redirect
- Worktree creation race condition when multiple sessions use the same name
- Branch collision errors when resuming sessions with existing `agent/*` branches
- Lost worktree context when resuming sessions after worktree cleanup
- Duplicate PR creation (now detects and updates instead)
- Hardcoded `"main"` base branch replaced with smart detection
- Missing detached HEAD detection in `getBranchName()` (now returns undefined)
- `git worktree remove` and `rmSync` failures now both logged at error level

## [2.3.1] - 2024-03-XX

### Added
- Git worktree support for isolated session branches
- Worktree creation via `worktree: true` parameter in `agent_launch`
- Discord notification support for wake events

### Changed
- Worktree creation is opt-in (defaults to `false`)
- Updated all dependencies to latest versions

### Fixed
- Worktree path conflicts resolved with random suffix
- SDK path resolution issues

## [2.3.0] - 2024-03-XX

### Added
- Redirect lifecycle for active sessions (`interrupt: true` in `agent_respond`)
- Turn-end wake signaling for all turn completions

### Changed
- Refined notification lifecycle wording

## [2.2.0] - 2024-02-XX

### Added
- Auto-resume for all killed sessions via `agent_respond` (except `startup-timeout`)
- Harness-scoped model defaults and allowlists
- Codex SDK streaming harness with thread API

### Fixed
- Codex auto-resume startup confirmation
- Codex auth.json race condition via isolated HOME per session

## [2.1.0] - 2024-02-XX

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
