import { execFile } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { Session } from "./session";
import { pluginConfig } from "./config";
import { formatDuration, generateSessionName, lastCompleteLines, truncateText } from "./format";
import type { SessionConfig, SessionStatus, SessionMetrics, PersistedSessionInfo, KillReason } from "./types";
import { SessionStore } from "./session-store";
import { SessionMetricsRecorder } from "./session-metrics";
import { WakeDispatcher, type SessionNotificationRequest } from "./wake-dispatcher";
import { looksLikeWaitingForUser } from "./waiting-detector";
import {
  isGitRepoWithRemote,
  createWorktree,
  removeWorktree,
  hasEnoughWorktreeSpace,
  getBranchName,
  hasCommitsAhead,
  getDiffSummary,
  pushBranch,
  mergeBranch,
  createPR,
  isGitHubCLIAvailable,
  deleteBranch,
  detectDefaultBranch,
  syncWorktreePR,
  commentOnPR,
} from "./worktree";

/**
 * Resolve the plan-approval workflow path for both source and bundled layouts.
 *
 * Precedence:
 * 1) `OPENCLAW_CODE_AGENT_PLAN_WORKFLOW_PATH`
 * 2) CWD-relative workflow (dev/local runs)
 * 3) module-relative candidates (bundled/dist layouts)
 * 4) legacy relative fallback
 */
function resolveLobsterWorkflowPath(): string {
  const explicit = process.env.OPENCLAW_CODE_AGENT_PLAN_WORKFLOW_PATH?.trim();
  if (explicit) return explicit;

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "workflows", "plan-approval.lobster"),
    join(moduleDir, "..", "workflows", "plan-approval.lobster"),
    join(moduleDir, "..", "..", "workflows", "plan-approval.lobster"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Preserve historical behavior as best-effort fallback.
  return fileURLToPath(new URL("../workflows/plan-approval.lobster", import.meta.url));
}

const LOBSTER_WORKFLOW_PATH = resolveLobsterWorkflowPath();

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const KILLABLE_STATUSES = new Set<SessionStatus>(["starting", "running"]);
const WAITING_EVENT_DEBOUNCE_MS = 5_000;
const WAKE_CLI_TIMEOUT_MS = 30_000;

type LobsterResponseShape = {
  resumeToken?: string;
  requiresApproval?: { resumeToken?: string };
  details?: { requiresApproval?: { resumeToken?: string } };
};

type SpawnOptions = {
  notifyLaunch?: boolean;
};

type LaunchConfirmationSession = Pick<Session, "status" | "name" | "id" | "killReason" | "error" | "result"> & {
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
};

/**
 * Extract a Lobster resume token from CLI output.
 *
 * We prefer `--json`, but keep this defensive parser because some runtimes can
 * still prepend banners/log lines around the JSON body.
 */
export function parseLobsterResumeToken(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const isLikelyToken = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && /^[A-Za-z0-9._:-]+$/.test(value.trim());

  const candidates: string[] = [trimmed];
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) candidates.push(t);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as LobsterResponseShape;
      const token = parsed?.resumeToken
        ?? parsed?.requiresApproval?.resumeToken
        ?? parsed?.details?.requiresApproval?.resumeToken;
      if (isLikelyToken(token)) return token.trim();
    } catch {
      // Keep scanning other candidate JSON fragments.
    }
  }

  // Fallback for mixed stdout/stderr output that embeds JSON-ish token fields.
  const tokenMatch = trimmed.match(/"resumeToken"\s*:\s*"([^"]+)"/);
  if (tokenMatch && isLikelyToken(tokenMatch[1])) return tokenMatch[1].trim();

  return undefined;
}

/**
 * Orchestrates active session lifecycles, wake signaling, persistence, and GC.
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  maxSessions: number;
  maxPersistedSessions: number;

  private lastWaitingEventTimestamps: Map<string, number> = new Map();
  private lastTurnCompleteMarkers: Map<string, string> = new Map();
  private lastTerminalWakeMarkers: Map<string, string> = new Map();
  private readonly store: SessionStore;
  private readonly metrics: SessionMetricsRecorder;
  private readonly wakeDispatcher: WakeDispatcher;

  constructor(maxSessions: number = 20, maxPersistedSessions: number = 50) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
    this.store = new SessionStore();
    this.metrics = new SessionMetricsRecorder();
    this.wakeDispatcher = new WakeDispatcher();
  }

  // Back-compat for tests and internal inspection.
  get persisted(): Map<string, PersistedSessionInfo> { return this.store.persisted; }
  get idIndex(): Map<string, string> { return this.store.idIndex; }
  get nameIndex(): Map<string, string> { return this.store.nameIndex; }

  private uniqueName(baseName: string): string {
    const activeNames = new Set(
      [...this.sessions.values()]
        .filter((s) => KILLABLE_STATUSES.has(s.status))
        .map((s) => s.name),
    );
    if (!activeNames.has(baseName)) return baseName;
    let i = 2;
    while (activeNames.has(`${baseName}-${i}`)) i++;
    return `${baseName}-${i}`;
  }

  /** Spawn and start a new session, wiring lifecycle listeners and launch notification. */
  spawn(config: SessionConfig, options: SpawnOptions = {}): Session {
    const activeCount = [...this.sessions.values()].filter(
      (s) => KILLABLE_STATUSES.has(s.status),
    ).length;
    if (activeCount >= this.maxSessions) {
      throw new Error(`Max sessions reached (${this.maxSessions}). Use agent_sessions to list active sessions and agent_kill to end one.`);
    }

    const baseName = config.name || generateSessionName(config.prompt);
    const name = this.uniqueName(baseName);
    if (name !== baseName) {
      console.warn(`[SessionManager] Name conflict: "${baseName}" → "${name}" (active session with same name exists)`);
    }

    // D1: Resume context — if resuming and worktree info exists, try to recreate or warn
    // F10: Restore worktreeStrategy from persisted record if not explicitly provided
    if (config.resumeSessionId) {
      const persistedSession = this.store.getPersistedSession(config.resumeSessionId);
      if (persistedSession) {
        // Restore strategy if not explicitly overridden
        if (!config.worktreeStrategy && persistedSession.worktreeStrategy) {
          config.worktreeStrategy = persistedSession.worktreeStrategy;
        }

        if (persistedSession.worktreePath) {
          const worktreeExists = existsSync(persistedSession.worktreePath);
          if (worktreeExists) {
            console.info(`[SessionManager] Resuming with existing worktree: ${persistedSession.worktreePath}`);
            config.workdir = persistedSession.worktreePath;
          } else if (persistedSession.worktreeBranch && persistedSession.workdir) {
            // Try to recreate worktree from branch
            try {
              const repoDir = persistedSession.workdir;
              const newWorktreePath = createWorktree(repoDir, persistedSession.worktreeBranch.replace(/^agent\//, ""));
              console.info(`[SessionManager] Recreated worktree from branch ${persistedSession.worktreeBranch}: ${newWorktreePath}`);
              config.workdir = newWorktreePath;
            } catch (err) {
              console.warn(`[SessionManager] Failed to recreate worktree for resume: ${err instanceof Error ? err.message : String(err)}, using original workdir`);
              config.workdir = persistedSession.workdir;
            }
          } else {
            console.warn(`[SessionManager] Worktree ${persistedSession.worktreePath} no longer exists and cannot be recreated, using original workdir`);
            config.workdir = persistedSession.workdir;
          }
        }
      }
    }

    // Worktree auto-creation: create a git worktree so the main checkout stays clean.
    // Strategy: off (or undefined) = no worktree, any other value = create worktree
    // Skip entirely for resume — the resume block above already restored the correct workdir.
    let actualWorkdir = config.workdir;
    let worktreePath: string | undefined;
    let worktreeCreationFailed = false;
    const strategy = config.worktreeStrategy ?? pluginConfig.defaultWorktreeStrategy;
    // Bake effective strategy back into config so Session and handleWorktreeStrategy see it
    if (strategy && !config.worktreeStrategy) config.worktreeStrategy = strategy;
    const shouldWorktree = !config.resumeSessionId && strategy && strategy !== "off";
    if (shouldWorktree && isGitRepoWithRemote(config.workdir)) {
      // A3: Check space before creating worktree
      if (!hasEnoughWorktreeSpace()) {
        console.warn(`[SessionManager] Insufficient space for worktree (< 100MB), skipping worktree creation`);
      } else {
        try {
          worktreePath = createWorktree(config.workdir, name);
          actualWorkdir = worktreePath;
          console.log(`[SessionManager] Created worktree at ${worktreePath}`);
        } catch (err) {
          worktreeCreationFailed = true;
          console.warn(`[SessionManager] Failed to create worktree: ${err instanceof Error ? err.message : String(err)}, using original workdir`);
        }
      }
    }

    const session = new Session({ ...config, workdir: actualWorkdir }, name);
    if (worktreePath) {
      session.worktreePath = worktreePath;
      session.originalWorkdir = config.workdir;
    }
    this.sessions.set(session.id, session);
    this.metrics.incrementLaunched();

    // Wire event handlers for lifecycle management
    session.on("statusChange", (_s: Session, newStatus: SessionStatus) => {
      if (newStatus === "running" && session.harnessSessionId) {
        this.store.markRunning(session);
      } else if (TERMINAL_STATUSES.has(newStatus)) {
        // Fire async handler without awaiting to avoid blocking event loop
        void this.onSessionTerminal(session);
      }
    });

    // `turnEnd` is the canonical signal for "turn is over" in multi-turn mode.
    // We wake the orchestrator even for non-question turns so it can inspect
    // output and decide whether to continue autonomous workflows.
    session.on("turnEnd", (_s: Session, hadQuestion: boolean) => {
      this.onTurnEnd(session, hadQuestion);
    });

    session.start();

    if (options.notifyLaunch !== false) {
      const workdirLabel = session.worktreePath
        ? `${session.worktreePath} (worktree of ${session.originalWorkdir})`
        : session.workdir;
      const launchText = `🚀 [${session.name}] Launched | ${workdirLabel} | ${session.model ?? "default"}`;
      this.notifySession(session, launchText, "launch");
    }

    // F2: Send warning notification if worktree creation was requested but failed
    if (worktreeCreationFailed) {
      const warningText = `⚠️ [${session.name}] Worktree creation failed — session running in original workdir`;
      this.wakeDispatcher.dispatchSessionNotification(session, {
        label: "worktree-creation-failed",
        userMessage: warningText,
      });
    }

    return session;
  }

  /** Spawn a session and wait until it is truly running or fails before startup. */
  async spawnAndAwaitRunning(config: SessionConfig, options: SpawnOptions = {}): Promise<Session> {
    const session = this.spawn(config, options);
    await this.waitForRunningSession(session);
    return session;
  }

  private async waitForRunningSession(session: LaunchConfirmationSession): Promise<void> {
    if (session.status === "running") return;
    if (TERMINAL_STATUSES.has(session.status)) {
      throw new Error(this.describeLaunchFailure(session));
    }

    const addListener = session.on?.bind(session);
    const removeListener = session.off?.bind(session) ?? session.removeListener?.bind(session);
    if (!addListener || !removeListener) {
      throw new Error(`Session ${session.name} [${session.id}] did not expose lifecycle events during startup.`);
    }

    await new Promise<void>((resolve, reject) => {
      const onStatusChange = (_session: Session, newStatus: SessionStatus): void => {
        if (newStatus === "running") {
          cleanup();
          resolve();
          return;
        }
        if (TERMINAL_STATUSES.has(newStatus)) {
          cleanup();
          reject(new Error(this.describeLaunchFailure(session)));
        }
      };

      const cleanup = (): void => {
        removeListener("statusChange", onStatusChange);
      };

      addListener("statusChange", onStatusChange);
    });
  }

  private describeLaunchFailure(session: LaunchConfirmationSession): string {
    const reason = session.killReason ? ` (reason: ${session.killReason})` : "";
    const detail = session.error
      || session.result?.result
      || `status=${session.status}${reason}`;
    return `Session ${session.name} [${session.id}] failed to start: ${detail}`;
  }

  /**
   * Handle worktree merge-back strategy when a session with a worktree terminates.
   * Called from onSessionTerminal BEFORE worktree cleanup.
   */
  private async handleWorktreeStrategy(session: Session): Promise<void> {
    // Only handle completed sessions (not failed/killed)
    if (session.status !== "completed") return;

    const strategy = session.worktreeStrategy;
    // Skip merge-back for "off", "manual", or undefined
    if (!strategy || strategy === "off" || strategy === "manual") return;

    const repoDir = session.originalWorkdir!;
    const worktreePath = session.worktreePath!;
    const branchName = getBranchName(worktreePath);
    if (!branchName) {
      console.warn(`[SessionManager] Cannot determine branch name for worktree ${worktreePath}`);
      return;
    }

    const baseBranch = session.worktreeBaseBranch ?? detectDefaultBranch(repoDir);

    // Check if there are any commits ahead
    if (!hasCommitsAhead(repoDir, branchName, baseBranch)) {
      console.info(`[SessionManager] No commits ahead of ${baseBranch} for ${branchName}, skipping merge-back`);
      return;
    }

    const diffSummary = getDiffSummary(repoDir, branchName, baseBranch);
    if (!diffSummary) {
      console.warn(`[SessionManager] Failed to get diff summary for ${branchName}, skipping merge-back`);
      return;
    }

    // Build notification message
    const commitMessages = diffSummary.commitMessages
      .slice(0, 5)
      .map((c) => `• ${c.hash} ${c.message} (${c.author})`)
      .join("\n");
    const moreCommits = diffSummary.commits > 5 ? `\n...and ${diffSummary.commits - 5} more` : "";
    const notificationBody = [
      `🔀 Session ${session.name} completed with changes`,
      ``,
      `Branch: ${branchName} → ${baseBranch}`,
      `Commits: ${diffSummary.commits}  |  Files: ${diffSummary.filesChanged}  |  +${diffSummary.insertions} / -${diffSummary.deletions}`,
      ``,
      commitMessages + moreCommits,
    ].join("\n");

    if (strategy === "ask") {
      // Push branch first (best-effort)
      pushBranch(repoDir, branchName);

      const askCommitLines = diffSummary.commitMessages
        .slice(0, 5)
        .map((c) => `• ${c.hash} ${c.message} (${c.author})`);
      const askMoreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : "";

      const userNotifyMessage = [
        `🔀 Session \`${session.name}\` completed with changes — decision required`,
        ``,
        `Branch: \`${branchName}\` → \`${baseBranch}\``,
        `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
      ].join("\n");

      const wakeDecisionMessage = [
        `[WORKTREE DECISION REQUIRED] Session "${session.name}" completed with changes.`,
        ``,
        `Branch: ${branchName} → ${baseBranch}`,
        `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
        ``,
        ...askCommitLines,
        ...(askMoreNote ? [askMoreNote] : []),
        ``,
        `Present this to the user and wait for their choice:`,
        `  1. Merge: agent_merge(session="${session.name}", base_branch="${baseBranch}")`,
        `  2. Open PR: agent_pr(session="${session.name}")`,
        `  3. Dismiss: agent_worktree_cleanup(workdir="${repoDir}")`,
        ``,
        `Wait for user reply before acting.`,
      ].join("\n");

      const askButtons: Array<Array<{ label: string; callbackData: string }>> = [[
        { label: "✅ Merge", callbackData: "merge" },
        { label: "🔀 Open PR", callbackData: "pr" },
        { label: "❌ Dismiss", callbackData: "dismiss" },
      ]];

      this.wakeDispatcher.dispatchSessionNotification(session, {
        label: "worktree-merge-ask",
        userMessage: userNotifyMessage,
        wakeMessage: wakeDecisionMessage,
        notifyUser: "always",
        buttons: askButtons,
      });

      // Stamp pending decision timestamp
      if (session.harnessSessionId) {
        this.updatePersistedSession(session.harnessSessionId, {
          pendingWorktreeDecisionSince: new Date().toISOString(),
        });
      }
      return;
    }

    if (strategy === "delegate") {
      // Push branch first (best-effort)
      pushBranch(repoDir, branchName);

      const delegateCommitLines = diffSummary.commitMessages
        .slice(0, 5)
        .map((c) => `• ${c.hash} ${c.message} (${c.author})`);
      const delegateMoreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : "";

      const delegateUserMessage = `🤖 Delegating merge decision for \`${branchName}\` to orchestrator`;

      const promptSnippet = session.prompt ? session.prompt.slice(0, 500) : "(no prompt)";

      const delegateWakeMessage = [
        `[DELEGATED WORKTREE DECISION] Session "${session.name}" completed with changes.`,
        ``,
        `Branch: ${branchName} → ${baseBranch}`,
        `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
        ``,
        ...delegateCommitLines,
        ...(delegateMoreNote ? [delegateMoreNote] : []),
        ``,
        `Original task prompt (first 500 chars):`,
        promptSnippet,
        ``,
        `━━━ DECISION REQUIRED ━━━`,
        `You are the delegated decision-maker for this worktree branch.`,
        ``,
        `MERGE if:`,
        `  - Changes match the original task scope`,
        `  - No breaking changes or architectural concerns`,
        `  → agent_merge(session="${session.name}", base_branch="${baseBranch}")`,
        ``,
        `OPEN PR if:`,
        `  - Changes are non-trivial and benefit from review`,
        `  - User has previously requested PRs for this kind of work`,
        `  - You are unsure — PRs are the safer default`,
        `  → agent_pr(session="${session.name}")`,
        ``,
        `ESCALATE to user if:`,
        `  - Scope is ambiguous or changes are risky`,
        `  - User has standing preferences that apply here`,
        ``,
        `Always notify the user briefly with what you decided and why.`,
      ].join("\n");

      this.wakeDispatcher.dispatchSessionNotification(session, {
        label: "worktree-delegate",
        userMessage: delegateUserMessage,
        wakeMessage: delegateWakeMessage,
        notifyUser: "always",
      });

      // Stamp pending decision timestamp
      if (session.harnessSessionId) {
        this.updatePersistedSession(session.harnessSessionId, {
          pendingWorktreeDecisionSince: new Date().toISOString(),
        });
      }
      return;
    }

    if (strategy === "auto-merge") {
      // Push branch first
      if (!pushBranch(repoDir, branchName)) {
        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-merge-push-failed",
          userMessage: `❌ [${session.name}] Failed to push ${branchName} — cannot auto-merge`,
        });
        return;
      }

      // Attempt merge
      const mergeResult = mergeBranch(repoDir, branchName, baseBranch);

      if (mergeResult.success) {
        // Push base branch
        if (!pushBranch(repoDir, baseBranch)) {
          this.wakeDispatcher.dispatchSessionNotification(session, {
            label: "worktree-merge-base-push-failed",
            userMessage: `⚠️ [${session.name}] Merged ${branchName} → ${baseBranch} locally, but failed to push ${baseBranch}`,
          });
          return;
        }

        // Delete branch
        deleteBranch(repoDir, branchName);

        // Persist merge status
        if (session.harnessSessionId) {
          this.updatePersistedSession(session.harnessSessionId, {
            worktreeMerged: true,
            worktreeMergedAt: new Date().toISOString(),
          });
        }

        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-merge-success",
          userMessage: `✅ [${session.name}] Merged and pushed ${branchName} → ${baseBranch}. Branch cleaned up.`,
        });
      } else if (mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0) {
        // Spawn conflict resolver session
        const conflictPrompt = [
          `Resolve merge conflicts in the following files and commit the resolution:`,
          ``,
          ...mergeResult.conflictFiles.map((f) => `- ${f}`),
          ``,
          `After resolving, commit with message: "Resolve merge conflicts from ${branchName}"`,
        ].join("\n");

        try {
          this.spawn({
            prompt: conflictPrompt,
            workdir: repoDir,
            name: `${session.name}-conflict-resolver`,
            harness: "claude-code",
            permissionMode: "bypassPermissions",
            multiTurn: true,
          });

          this.wakeDispatcher.dispatchSessionNotification(session, {
            label: "worktree-merge-conflict",
            userMessage: `⚠️ [${session.name}] Merge conflicts in ${mergeResult.conflictFiles.length} file(s) — spawned conflict resolver session`,
          });
        } catch (err) {
          this.wakeDispatcher.dispatchSessionNotification(session, {
            label: "worktree-merge-conflict-spawn-failed",
            userMessage: `❌ [${session.name}] Merge conflicts detected, but failed to spawn resolver: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else {
        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-merge-error",
          userMessage: `❌ [${session.name}] Merge failed: ${mergeResult.error ?? "unknown error"}`,
        });
      }
      return;
    }

    if (strategy === "auto-pr") {
      // Check if gh CLI is available
      if (!isGitHubCLIAvailable()) {
        console.warn(`[SessionManager] GitHub CLI not available, falling back to 'ask' strategy`);
        // Fall back to ask
        const askMessage = [
          notificationBody,
          ``,
          `(GitHub CLI not available for auto-PR)`,
          ``,
          `Reply with one of the following:`,
          `1. Merge to ${baseBranch}`,
          `2. Dismiss`,
        ].join("\n");

        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-pr-fallback-ask",
          userMessage: askMessage,
        });
        return;
      }

      // Push branch first (required for PR operations)
      if (!pushBranch(repoDir, branchName)) {
        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-pr-push-failed",
          userMessage: `❌ [${session.name}] Failed to push ${branchName} — cannot create/update PR`,
        });
        return;
      }

      // Sync PR state from GitHub
      const prStatus = syncWorktreePR(repoDir, branchName);

      // PR Lifecycle Handling for auto-pr
      if (prStatus.exists && prStatus.state === "open") {
        // Case: Open PR exists — update with summary comment
        if (diffSummary && diffSummary.commits > 0) {
          const commentBody = [
            `🔄 **New commits pushed**`,
            ``,
            `${diffSummary.commits} commits (+${diffSummary.insertions} / -${diffSummary.deletions})`,
            ``,
            `---`,
            `🤖 [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)`,
          ].join("\n");

          const commented = commentOnPR(repoDir, prStatus.number!, commentBody);

          if (session.harnessSessionId) {
            this.updatePersistedSession(session.harnessSessionId, {
              worktreePrUrl: prStatus.url,
              worktreePrNumber: prStatus.number,
            });
          }

          if (commented) {
            this.wakeDispatcher.dispatchSessionNotification(session, {
              label: "worktree-pr-updated",
              userMessage: `✅ [${session.name}] PR updated: ${prStatus.url} (+${diffSummary.commits} commits)`,
            });
          } else {
            this.wakeDispatcher.dispatchSessionNotification(session, {
              label: "worktree-pr-updated-no-comment",
              userMessage: `⚠️ [${session.name}] Pushed to ${prStatus.url} (comment failed)`,
            });
          }
        } else {
          // No new commits
          if (session.harnessSessionId) {
            this.updatePersistedSession(session.harnessSessionId, {
              worktreePrUrl: prStatus.url,
              worktreePrNumber: prStatus.number,
            });
          }
          this.wakeDispatcher.dispatchSessionNotification(session, {
            label: "worktree-pr-up-to-date",
            userMessage: `ℹ️ [${session.name}] PR up to date: ${prStatus.url}`,
          });
        }
        return;
      } else if (prStatus.exists && prStatus.state === "merged") {
        // Case: PR was merged
        if (session.harnessSessionId) {
          this.updatePersistedSession(session.harnessSessionId, {
            worktreePrUrl: prStatus.url,
            worktreePrNumber: prStatus.number,
          });
        }
        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-pr-merged",
          userMessage: `✅ [${session.name}] PR already merged: ${prStatus.url}`,
        });
        return;
      } else if (prStatus.exists && prStatus.state === "closed") {
        // Case: PR was closed without merging
        if (session.harnessSessionId) {
          this.updatePersistedSession(session.harnessSessionId, {
            worktreePrUrl: prStatus.url,
            worktreePrNumber: prStatus.number,
          });
        }
        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-pr-closed",
          userMessage: `⚠️ [${session.name}] PR was closed without merging: ${prStatus.url}`,
        });
        return;
      } else {
        // Case: No PR exists — create new PR
        const prTitle = `[openclaw-code-agent] ${session.name}`;
        const prBody = [
          `Automated changes from OpenClaw Code Agent session: ${session.name}`,
          ``,
          `## Summary`,
          `${diffSummary.commits} commits, ${diffSummary.filesChanged} files changed (+${diffSummary.insertions} / -${diffSummary.deletions})`,
          ``,
          `## Commits`,
          commitMessages + moreCommits,
          ``,
          `---`,
          `🤖 Generated with [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)`,
        ].join("\n");

        const prResult = createPR(repoDir, branchName, baseBranch, prTitle, prBody);

        if (prResult.success && prResult.prUrl) {
          // Sync again to get PR number
          const newPrStatus = syncWorktreePR(repoDir, branchName);

          // Persist PR URL and number
          if (session.harnessSessionId) {
            this.updatePersistedSession(session.harnessSessionId, {
              worktreePrUrl: prResult.prUrl,
              worktreePrNumber: newPrStatus.number,
            });
          }

          this.wakeDispatcher.dispatchSessionNotification(session, {
            label: "worktree-pr-success",
            userMessage: `🔀 [${session.name}] PR created: ${prResult.prUrl}`,
          });
        } else {
          this.wakeDispatcher.dispatchSessionNotification(session, {
            label: "worktree-pr-error",
            userMessage: `❌ [${session.name}] Failed to create PR: ${prResult.error ?? "unknown error"}`,
          });
        }
        return;
      }
    }
  }

  private async onSessionTerminal(session: Session): Promise<void> {
    this.persistSession(session);
    this.lastWaitingEventTimestamps.delete(session.id);

    // Handle worktree merge-back strategy BEFORE cleanup
    if (session.worktreePath && session.originalWorkdir) {
      await this.handleWorktreeStrategy(session);
    }

    // Best-effort worktree cleanup — remove the worktree but keep the branch.
    if (session.worktreePath && session.originalWorkdir) {
      removeWorktree(session.originalWorkdir, session.worktreePath);
    }

    // Multi-turn sessions that naturally end after a successful no-input turn
    // use reason "done". Turn-complete wake already fired for that turn.
    if (session.killReason === "done") return;

    if (session.status === "completed") {
      if (!this.shouldEmitTerminalWake(session)) return;
      this.triggerAgentEvent(session);
      return;
    }

    if (session.status === "failed") {
      if (!this.shouldEmitTerminalWake(session)) return;
      const rawError = session.error
        || (session.result?.is_error && session.result.result)
        || (session.result?.result)
        || this.extractLastOutputLine(session)
        || `Session failed with no error details (session=${session.id}, subtype=${session.result?.subtype ?? "none"}, turns=${session.result?.num_turns ?? 0})`;
      const errorSummary = truncateText(rawError, 200);
      this.triggerFailedEvent(session, errorSummary);
      return;
    }

    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = formatDuration(session.duration);

    if (session.killReason === "idle-timeout") {
      this.notifySession(session, `💤 [${session.name}] Idle timeout | ${costStr} | ${duration}`);
      return;
    }

    const statusLabel = this.getStoppedStatusLabel(session.killReason);
    this.notifySession(session, `⛔ [${session.name}] ${statusLabel} | ${costStr} | ${duration}`);
  }

  private getStoppedStatusLabel(killReason?: string): string {
    switch (killReason) {
      case "user":
        return "Stopped by user";
      case "shutdown":
        return "Stopped by shutdown";
      case "startup-timeout":
        return "Stopped by startup timeout";
      case "unknown":
      case undefined:
        return "Stopped unexpectedly";
      default:
        return "Stopped";
    }
  }

  private persistSession(session: Session): void {
    // Record metrics once
    const alreadyPersisted = this.store.hasRecordedSession(session.id);
    if (!alreadyPersisted) {
      this.metrics.recordSession(session);
    }

    this.store.persistTerminal(session);
  }

  getMetrics(): SessionMetrics { return this.metrics.getMetrics(); }

  // Back-compat helper retained for test access.
  private recordSessionMetrics(session: Session): void {
    this.metrics.recordSession(session);
  }

  // -- Wake / notification delivery --

  notifySession(session: Session, text: string, label: string = "notification"): void {
    this.dispatchSessionNotification(session, {
      label,
      userMessage: text,
      notifyUser: "always",
    });
  }

  private dispatchSessionNotification(session: Session, request: SessionNotificationRequest): void {
    this.wakeDispatcher.dispatchSessionNotification(session, request);
  }

  /**
   * Run the Lobster plan-approval workflow as a structural gate.
   * Sends a direct Telegram notification with the plan summary and a resume token,
   * bypassing the orchestrator entirely. The user approves/rejects via Lobster's
   * approval mechanism which then calls agent_respond on the session.
   */
  private runLobsterApproval(session: Session, planSummary: string): void {
    const argsJson = JSON.stringify({
      session_id: session.id,
      session_name: session.name,
      plan_summary: planSummary,
    });

    const args = [
      "--json",
      "invoke", "--tool", "lobster",
      "--args-json", JSON.stringify({
        action: "run",
        pipeline: LOBSTER_WORKFLOW_PATH,
        argsJson,
        timeoutMs: 0, // No timeout — waits for human approval
      }),
    ];

    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[SessionManager] Lobster launch failed for session=${session.id}: ${err.message}`);
        // Fallback: send Telegram directly so the user isn't left in the dark
        this.notifySession(session, `📋 [${session.name}] Plan ready — Lobster gate failed, please review manually:\n\n${truncateText(planSummary, 800)}`);
        return;
      }

      // Parse the Lobster response to get the resume token.
      const stdoutText = typeof stdout === "string" ? stdout : String(stdout ?? "");
      const stderrText = typeof stderr === "string" ? stderr : String(stderr ?? "");
      const resumeToken = parseLobsterResumeToken(`${stdoutText}\n${stderrText}`);
      if (!resumeToken) {
        const combinedPreview = `${stdoutText}\n${stderrText}`.trim().substring(0, 200);
        console.warn(`[SessionManager] Lobster response missing resume token for session=${session.id}: ${combinedPreview}`);
      }

      // Store token on session for programmatic resume via agent_respond
      if (resumeToken) {
        session.lobsterResumeToken = resumeToken;
      }

      // Send Telegram notification with plan summary
      const telegramLines = [
        `📋 [${session.name}] Plan ready for approval`,
        ``,
        truncateText(planSummary, 1200),
        ``,
        `Session: ${session.name} (${session.id})`,
        ``,
        `To approve: reply "approve"`,
        `To reject: reply with feedback`,
      ];
      this.notifySession(session, telegramLines.join("\n"));
    });
  }

  /**
   * Resume (or cancel) a Lobster approval workflow by token.
   * Calls `openclaw invoke --tool lobster` with the resume action.
   */
  resumeLobsterApproval(token: string, approve: boolean): Promise<void> {
    const timeoutMs = approve ? 30_000 : 10_000;
    return new Promise<void>((resolve, reject) => {
      const args = [
        "--json",
        "invoke", "--tool", "lobster",
        "--args-json", JSON.stringify({ action: "resume", token, approve }),
      ];
      execFile("openclaw", args, { timeout: timeoutMs }, (err) => {
        if (err) {
          console.error(`[SessionManager] Lobster resume failed (approve=${approve}): ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /** Returns true if the event should proceed; false if debounced. */
  private debounceWaitingEvent(sessionId: string): boolean {
    const now = Date.now();
    const lastTs = this.lastWaitingEventTimestamps.get(sessionId);
    if (lastTs && now - lastTs < WAITING_EVENT_DEBOUNCE_MS) return false;
    this.lastWaitingEventTimestamps.set(sessionId, now);
    return true;
  }

  private originThreadLine(session: Session): string {
    return session.originThreadId != null
      ? `Session origin thread: ${session.originThreadId}`
      : "";
  }

  private extractLastOutputLine(session: Session): string | undefined {
    const lines = session.getOutput(3);
    const last = lines.filter(l => l.trim()).pop()?.trim();
    return last || undefined;
  }

  private getOutputPreview(session: Session, maxChars: number = 1000): string {
    const raw = session.getOutput(20).join("\n");
    return raw.length > maxChars ? lastCompleteLines(raw, maxChars) : raw;
  }

  private triggerAgentEvent(session: Session): void {
    const preview = this.getOutputPreview(session);

    const eventText = [
      `Coding agent session completed.`,
      `Name: ${session.name} | ID: ${session.id}`,
      `Status: ${session.status}`,
      this.originThreadLine(session),
      ``,
      `Output preview:`,
      preview,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session completion:`,
      `1. Use agent_output(session='${session.id}', full=true) to read the full result.`,
      `2. If this is part of a multi-phase pipeline, launch the next phase NOW — do not wait for user input.`,
      `3. Notify the user with a summary of what was done.`,
    ].join("\n");

    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = formatDuration(session.duration);
    const telegramText = `✅ [${session.name}] Completed | ${costStr} | ${duration}`;

    this.dispatchSessionNotification(session, {
      label: "completed",
      userMessage: telegramText,
      wakeMessage: eventText,
      notifyUser: "always",
    });
  }

  private triggerFailedEvent(session: Session, errorSummary: string): void {
    const preview = this.getOutputPreview(session);
    const outputSection = preview.trim()
      ? ["", "Output preview:", preview]
      : [];

    const eventText = [
      `Coding agent session failed.`,
      `Name: ${session.name} | ID: ${session.id}`,
      `Status: ${session.status}`,
      this.originThreadLine(session),
      ``,
      `Failure summary:`,
      errorSummary,
      ...outputSection,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session failure:`,
      `1. Use agent_output(session='${session.id}', full=true) to inspect the full failure context.`,
      `2. If the failure is a launch/config issue or other recoverable error, relaunch the task now or continue it yourself.`,
      `3. Notify the user with the failure cause and the next action you are taking.`,
    ].join("\n");

    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = formatDuration(session.duration);
    const telegramText = [
      `❌ [${session.name}] Failed | ${costStr} | ${duration}`,
      `   ⚠️ ${errorSummary}`,
    ].join("\n");

    this.dispatchSessionNotification(session, {
      label: "failed",
      userMessage: telegramText,
      wakeMessage: eventText,
      notifyUser: "always",
    });
  }

  private triggerWaitingForInputEvent(session: Session): void {
    if (!this.debounceWaitingEvent(session.id)) return;

    const preview = this.getOutputPreview(session);
    const isPlanApproval = session.pendingPlanApproval;

    const telegramText = isPlanApproval
      ? `📋 [${session.name}] Plan ready for review:\n\n${preview}\n\nReply to approve or provide feedback.`
      : `❓ [${session.name}] Waiting for input`;

    let eventText: string;
    if (isPlanApproval) {
      const planApprovalMode = pluginConfig.planApproval ?? "delegate";
      if (planApprovalMode === "ask") {
        // ASK mode: bypass the orchestrator entirely. Use Lobster's approval: required
        // to create a hard structural gate. Send the user a direct Telegram
        // notification with the plan summary. On approve/reject, Lobster
        // calls agent_respond on the session directly.
        this.runLobsterApproval(session, preview);
        return; // Do NOT wake the orchestrator — Lobster handles the full flow
      } else if (planApprovalMode === "delegate") {
        eventText = [
          `[DELEGATED PLAN APPROVAL] Coding agent session has finished its plan and is requesting approval to implement.`,
          `Name: ${session.name} | ID: ${session.id}`,
          this.originThreadLine(session),
          `Permission mode: plan → will switch to bypassPermissions on approval`,
          ``,
          `⚠️ YOU MUST COMPLETE THESE STEPS IN ORDER. Do NOT skip any step.`,
          ``,
          `━━━ STEP 1 (MANDATORY): Read the full plan ━━━`,
          `Call agent_output(session='${session.id}', full=true) to read the FULL plan output.`,
          `The preview below is truncated — you MUST read the full output before making any decision.`,
          ``,
          `Preview (truncated):`,
          preview,
          ``,
          `━━━ STEP 2 (MANDATORY): Notify the user ━━━`,
          `After reading the full plan, use the message tool to send the user a summary that includes:`,
          `- What files/components will be changed`,
          `- Risk level (low/medium/high) and why`,
          `- Scope: does this match the original task or has it expanded?`,
          `- Any concerns or assumptions the plan makes`,
          `This message creates accountability — you cannot approve blindly.`,
          ``,
          `━━━ STEP 3 (ONLY AFTER steps 1 and 2): Decide ━━━`,
          `You are the delegated decision-maker. Choose ONE:`,
          ``,
          `APPROVE the plan directly if ALL of the following are true:`,
          `- You have read the FULL plan (not just the preview)`,
          `- You have sent the user the summary message`,
          `- The plan scope matches the original task request`,
          `- The changes are low-risk (no destructive operations, no credential handling, no production deployments)`,
          `- The plan is clear and well-scoped (no ambiguous requirements or open design questions)`,
          `- No architectural decisions that the user should weigh in on`,
          `- The working directory and codebase are correct`,
          ``,
          `ESCALATE to the user and WAIT if ANY of the following are true:`,
          `- The plan involves destructive operations (deleting files, dropping tables, force-pushing)`,
          `- The plan involves credentials, secrets, or production environments`,
          `- The plan requires architectural decisions not covered by the original task`,
          `- The scope has expanded beyond the original request`,
          `- The requirements are ambiguous or the plan makes assumptions the user should confirm`,
          `- You are unsure — when in doubt, always escalate`,
          ``,
          `If approving: agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
          `If escalating: tell the user you need their decision and WAIT for his explicit response.`,
          `To request changes: agent_respond(session='${session.id}', message='<your feedback>') — do NOT set approve=true. The agent will revise the plan.`,
        ].join("\n");
      } else {
        // approve mode — always auto-approve
        eventText = [
          `[AUTO-APPROVE] Session has a plan ready. Approve it now:`,
          `agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
        ].join("\n");
      }
    } else {
      const sessionType = session.multiTurn ? "Multi-turn session" : "Session";
      eventText = [
        `[SYSTEM INSTRUCTION: Follow your auto-respond rules strictly. If this is a permission request or "should I continue?" → auto-respond. For ALL other questions → forward the agent's EXACT question to the user. Do NOT add your own analysis, commentary, or interpretation. Do NOT "nudge" or "poke" the session.]`,
        ``,
        `${sessionType} is waiting for input.`,
        `Name: ${session.name} | ID: ${session.id}`,
        this.originThreadLine(session),
        ``,
        `Last output:`,
        preview,
        ``,
        `Use agent_respond(session='${session.id}', message='...') to send a reply, or agent_output(session='${session.id}', full: true) to see full context before deciding.`,
      ].join("\n");
    }

    this.dispatchSessionNotification(session, {
      label: isPlanApproval ? "plan-approval" : "waiting",
      userMessage: telegramText,
      wakeMessage: eventText,
      notifyUser: isPlanApproval ? "always" : "on-wake-fallback",
    });
  }

  private onTurnEnd(session: Session, hadQuestion: boolean): void {
    // Use the dedicated waiting path for explicit question/plan-approval turns.
    // This preserves plan approval policy handling and waiting-specific guidance.
    if (hadQuestion || session.pendingPlanApproval) {
      this.triggerWaitingForInputEvent(session);
      return;
    }

    // Non-question turns still emit a lightweight turn-complete wake. We keep
    // a heuristic waiting hint in that payload as a fallback.
    if (!this.shouldEmitTurnCompleteWake(session)) return;
    this.triggerTurnCompleteEventWithSignal(session);
  }

  private shouldEmitTurnCompleteWake(session: Session): boolean {
    const marker = `${session.result?.session_id ?? ""}|${session.result?.num_turns ?? 0}|${session.result?.duration_ms ?? 0}`;
    const prev = this.lastTurnCompleteMarkers.get(session.id);
    if (prev === marker) return false;
    this.lastTurnCompleteMarkers.set(session.id, marker);
    return true;
  }

  private shouldEmitTerminalWake(session: Session): boolean {
    const marker = `${session.status}|${session.completedAt ?? 0}|${session.result?.session_id ?? ""}|${session.result?.num_turns ?? 0}|${session.killReason}`;
    const prev = this.lastTerminalWakeMarkers.get(session.id);
    if (prev === marker) return false;
    this.lastTerminalWakeMarkers.set(session.id, marker);
    return true;
  }

  private triggerTurnCompleteEventWithSignal(session: Session): void {
    const preview = this.getOutputPreview(session);
    // Heuristic fallback only: explicit waiting turns should already route via
    // `triggerWaitingForInputEvent`. This hint helps catch plain-text asks
    // without introducing high false-positive wake churn.
    const waitingForInput = looksLikeWaitingForUser(preview);
    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const waitingText = waitingForInput ? "yes" : "no";
    const telegramText = `⏸️ [${session.name}] Paused after turn | Auto-resumable | ${costStr} | Waiting input: ${waitingText}`;

    const eventText = [
      `Coding agent session turn ended.`,
      `Name: ${session.name}`,
      `ID: ${session.id}`,
      `Status: ${session.status}`,
      ``,
      `Looks like waiting for user input: ${waitingText}`,
      ``,
      `Last output (~20 lines):`,
      preview,
      ...(this.originThreadLine(session) ? ["", this.originThreadLine(session)] : []),
    ].join("\n");

    // Turn-complete wakes are synthetic CLI-originated `chat.send` events, so any
    // `[[reply_to_current]]` response from the main session targets the gateway
    // caller instead of the user's Telegram topic. Keep the compact status ping
    // in the same pipeline, but always deliver it directly alongside the wake.
    this.dispatchSessionNotification(session, {
      label: "turn-complete",
      userMessage: telegramText,
      wakeMessage: eventText,
      notifyUser: "always",
    });
  }

  // -- Public API --

  /** Resolve by internal id first, then by name with active-session preference. */
  resolve(idOrName: string): Session | undefined {
    const byId = this.sessions.get(idOrName);
    if (byId) return byId;

    const matches = [...this.sessions.values()].filter((s) => s.name === idOrName);
    if (matches.length === 0) return undefined;

    const activeMatches = matches.filter((s) => KILLABLE_STATUSES.has(s.status));
    if (activeMatches.length > 0) {
      return activeMatches.sort((a, b) => b.startedAt - a.startedAt)[0];
    }

    return matches.sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  /** Return an active session by internal id. */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** List sessions sorted newest-first, optionally filtered by status. */
  list(filter?: SessionStatus | "all"): Session[] {
    let result = [...this.sessions.values()];
    if (filter && filter !== "all") {
      result = result.filter((s) => s.status === filter);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Kill a session by internal id. */
  kill(id: string, reason?: KillReason): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill(reason ?? "user");
    return true;
  }

  /** Kill all active sessions and clear pending wake retries. */
  killAll(reason: KillReason = "user"): void {
    for (const session of this.sessions.values()) {
      if (KILLABLE_STATUSES.has(session.status)) {
        this.kill(session.id, reason);
      }
    }
    this.wakeDispatcher.clearPendingRetries();
  }

  /** Resolve any reference to a persisted harness session id for resume flows. */
  resolveHarnessSessionId(ref: string): string | undefined {
    const active = this.resolve(ref);
    return this.store.resolveHarnessSessionId(ref, active?.harnessSessionId);
  }

  /** Read persisted metadata by harness id, internal id, or name. */
  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.store.getPersistedSession(ref);
  }

  /** Update fields on a persisted session record and flush to disk. */
  updatePersistedSession(ref: string, patch: Partial<PersistedSessionInfo>): boolean {
    const existing = this.store.getPersistedSession(ref);
    if (!existing) return false;
    Object.assign(existing, patch);
    this.store.saveIndex();
    return true;
  }

  /** Return persisted sessions newest-first. */
  listPersistedSessions(): PersistedSessionInfo[] {
    return this.store.listPersistedSessions();
  }

  /** Send daily reminders for sessions with unresolved pending worktree decisions. */
  private remindStaleDecisions(): void {
    const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
    const now = Date.now();

    for (const session of this.store.listPersistedSessions()) {
      // Only sessions with pending decisions that aren't resolved
      if (!session.pendingWorktreeDecisionSince) continue;
      if (session.worktreeMerged || session.worktreePrUrl) continue;

      const pendingMs = now - new Date(session.pendingWorktreeDecisionSince).getTime();
      if (pendingMs < REMINDER_INTERVAL_MS) continue;

      // Rate-limit: max once per 24h per session
      if (session.lastWorktreeReminderAt) {
        const lastReminderMs = now - new Date(session.lastWorktreeReminderAt).getTime();
        if (lastReminderMs < REMINDER_INTERVAL_MS) continue;
      }

      const pendingHours = Math.floor(pendingMs / (60 * 60 * 1000));
      const reminderText = [
        `⏰ Reminder: branch \`${session.worktreeBranch ?? "unknown"}\` is still waiting for a merge decision.`,
        `Session: ${session.name} | Pending: ${pendingHours}h`,
        ``,
        `agent_merge(session="${session.name}") or agent_pr(session="${session.name}") or agent_worktree_cleanup() to resolve.`,
      ].join("\n");

      try {
        this.sendReminderNotification(session, reminderText);
      } catch (err) {
        console.warn(`[SessionManager] Failed to send stale-decision reminder for session ${session.name}: ${err instanceof Error ? err.message : String(err)}`);
      }

      this.updatePersistedSession(session.harnessSessionId, {
        lastWorktreeReminderAt: new Date().toISOString(),
      });
    }
  }

  /** Send a notification for a persisted (not active) session using its stored origin channel. */
  private sendReminderNotification(session: PersistedSessionInfo, text: string): void {
    // Build a minimal routing proxy with the fields WakeDispatcher needs
    const routingProxy = {
      id: session.harnessSessionId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
    } as Session;

    this.wakeDispatcher.dispatchSessionNotification(routingProxy, {
      label: `worktree-stale-reminder-${session.name}`,
      userMessage: text,
      notifyUser: "always",
    });
  }

  /** Evict stale runtime records and enforce persisted/session-output retention limits. */
  cleanup(): void {
    const now = Date.now();
    this.remindStaleDecisions();
    // GC only evicts terminal sessions from the runtime in-memory map.
    // Persisted entries stay in SessionStore for resume/list/output lookups.
    // "evicted from runtime cache" means removed from `this.sessions`, not lost.
    const cleanupMaxAgeMs = (pluginConfig.sessionGcAgeMinutes ?? 1440) * 60_000;
    for (const [id, session] of this.sessions) {
      if (this.store.shouldGcActiveSession(session, now, cleanupMaxAgeMs)) {
        this.persistSession(session);
        this.sessions.delete(id);
        this.lastWaitingEventTimestamps.delete(id);
        this.lastTurnCompleteMarkers.delete(id);
        this.lastTerminalWakeMarkers.delete(id);
      }
    }

    this.store.cleanupTmpOutputFiles(now);
    this.store.evictOldestPersisted(this.maxPersistedSessions);
  }
}
