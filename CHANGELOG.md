# Changelog

All notable changes to openclaw-code-agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- **`acceptEdits` permission mode** — removed from both harnesses and all APIs
  - Caused frequent approval stalls in automated sessions mid-execution
  - Replaced by: `bypassPermissions` for fully autonomous execution, or `default` for interactive sessions with standard permission prompts
  - Removed from `PermissionMode` type definition (`src/types.ts`)
  - Removed from Claude Code harness supported modes (`src/harness/claude-code.ts`)
  - Removed from Codex harness supported modes (`src/harness/codex.ts`)
  - Removed from `agent_launch` tool parameter enum and updated description
  - Updated `agent_respond` tool description (removed `acceptEdits` escalation scenario)
  - Updated session-store validation function
  - Updated respond action logic (`src/actions/respond.ts`)
  - Updated all documentation (README.md, TOOLS.md, ARCHITECTURE.md)

### Added
- **PR lifecycle management** for `agent_pr` and `auto-pr` strategy
  - Automatic PR state detection (open, merged, closed, none)
  - Update existing open PRs with new commits (adds detailed comment with diff stats)
  - Detect merged PRs and notify user
  - Detect closed PRs and prompt user for action (reopen, delete branch, or recreate)
  - `force_new` parameter to prevent accidental PR updates
  - `syncWorktreePR()` utility to query PR state via gh CLI
  - `commentOnPR()` utility to add comments to existing PRs
  - Persist `worktreePrNumber` in session metadata for lifecycle tracking
  - `agent_worktree_status` tool to show worktree status (branch, commits, merge/PR info)

- **Worktree merge-back flow** with configurable strategies (`off`, `manual`, `ask`, `auto-merge`, `auto-pr`)
  - `agent_merge` tool for manual merge operations with automatic conflict resolution
  - `agent_pr` tool for creating/updating GitHub PRs via `gh` CLI (full lifecycle)
  - `agent_worktree_cleanup` tool for cleaning up merged agent/* branches
  - `worktree_strategy` parameter to `agent_launch` (collapsed from separate `worktree` boolean)
  - Auto-merge spawns Claude Code conflict-resolver sessions on conflicts
  - `"ask"` strategy now sends Telegram inline buttons and wakes orchestrator with decision context
  - Auto-PR creates/updates GitHub PRs with auto-generated commit summaries and lifecycle handling

- **Worktree lifecycle improvements**
  - Startup orphan cleanup scans for abandoned worktrees (age configurable via `OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS`)
  - `/tmp` space check (100MB minimum) before worktree creation
  - Atomic mkdir race fix with retry + hex suffix to prevent collisions
  - Branch collision handling - reuses existing branches instead of failing
  - Worktree creation failure sends wake notification
  - `OPENCLAW_WORKTREE_DIR` environment variable for custom worktree location
  - Resume context check - recreates worktrees from branch if directory is missing
  - `removeWorktree()` falls back to `rmSync` if git command fails
  - Orphan worktree cleanup no longer parses `.git` files (direct rmSync)
  - `OPENCLAW_WORKTREE_BASE_BRANCH` env var for global base branch override

- **New worktree utility functions**
  - `detectDefaultBranch()` - multi-step detection (env var → origin/HEAD → main → master)
  - `getBranchName()` - get current branch using git CLI with detached HEAD detection
  - `hasCommitsAhead()` - check if branch has commits ahead of base
  - `getDiffSummary()` - get commit count, file changes, and commit messages
  - `pushBranch()` - push branch to remote
  - `mergeBranch()` - merge with conflict detection and abort on failure
  - `createPR()` - create GitHub PR via gh CLI
  - `deleteBranch()` - delete git branch
  - `syncWorktreePR()` - query PR state (open/merged/closed/none) via gh CLI
  - `commentOnPR()` - add comment to existing PR
  - `isGitAvailable()` / `isGitHubCLIAvailable()` - cached availability checks
  - `hasEnoughWorktreeSpace()` - check free space before creation

- **Session listing improvements**
  - Show worktree branch name in session listings
  - Display merge status (merged ✓ / PR URL / not merged) in `agent_sessions`
  - Display original repo path instead of tmp path for worktree sessions
  - Persist `worktreeBranch`, `worktreeStrategy`, `worktreeMerged`, `worktreeMergedAt`, `worktreePrUrl`, `worktreePrNumber` in session metadata

- **Worktree ask/delegate UX improvements**
  - `WorktreeStrategy`: added `"delegate"` mode — orchestrator autonomously decides merge/PR/escalate
  - `"ask"` strategy: real Telegram inline buttons (✅ Merge / 🔀 Open PR / ❌ Dismiss) via `--buttons`
  - `"ask"` and `"delegate"` strategies: `wakeMessage` added for orchestrator routing with full decision context
  - `"delegate"`: always sends brief one-liner notification to user + full context `wakeMessage` to orchestrator
  - `SessionNotificationRequest`: new `buttons` field for Telegram inline keyboards; `fireDirectNotificationWithRetry` appends `--buttons` arg when channel is telegram
  - `PersistedSessionInfo`: new `pendingWorktreeDecisionSince` and `lastWorktreeReminderAt` fields
  - Stale branch reminders: daily reminders for unresolved pending worktree decisions via `SessionManager.cleanup()`
  - `agent_worktree_status`: prominently surfaces sessions with pending decisions at the top
  - `agent_merge`, `agent_pr`: clear `pendingWorktreeDecisionSince` on resolution
  - `agent_worktree_cleanup`: new `session` parameter to dismiss a pending decision

### Changed
- **BREAKING**: `worktree_strategy` parameter replaces separate `worktree` boolean in `agent_launch`
  - Old: `worktree: true` → New: `worktree_strategy: "manual"`
  - Enum values: `"off"` (default) | `"manual"` | `"ask"` | `"delegate"` | `"auto-merge"` | `"auto-pr"`
- **BREAKING**: `auto_cleanup` parameter renamed to `delete_branch` in `agent_merge`
- `agent_pr` now handles full PR lifecycle (create/update/detect merged/detect closed) instead of just creation
- Base branch detection: defaults to auto-detection via `detectDefaultBranch()` instead of hardcoded `"main"`
- Worktree path format: `<OPENCLAW_WORKTREE_DIR>/openclaw-worktree-<session-name>` (was `/tmp/openclaw-worktree-<session-name>`)
- Session store now persists `originalWorkdir` instead of worktree path in `workdir` field
- `onSessionTerminal` is now async to support merge-back flow
- `saveIndex()` in SessionStore is now public (was private)

### Fixed
- Worktree creation race condition when multiple sessions use same name
- Branch collision errors when resuming sessions with existing agent/* branches
- Lost worktree context when resuming sessions after worktree cleanup
- Both `git worktree remove` and `rmSync` failures now logged at error level
- Duplicate PR creation when PR already exists (now detects and updates instead)
- Hardcoded `"main"` base branch replaced with smart detection
- `.git` file parsing in orphan worktree cleanup (now uses direct rmSync)
- Missing detached HEAD detection in `getBranchName()` (now returns undefined)

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

[Unreleased]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.1...HEAD
[2.3.1]: https://github.com/goldmar/openclaw-code-agent/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/goldmar/openclaw-code-agent/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/goldmar/openclaw-code-agent/releases/tag/v2.1.0
