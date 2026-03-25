import { existsSync } from "fs";

import { Session } from "./session";
import { pluginConfig } from "./config";
import { formatDuration, generateSessionName, lastCompleteLines, truncateText } from "./format";
import type { SessionConfig, SessionStatus, SessionMetrics, PersistedSessionInfo, KillReason } from "./types";
import { SessionStore } from "./session-store";
import { SessionMetricsRecorder } from "./session-metrics";
import { WakeDispatcher, type SessionNotificationRequest } from "./wake-dispatcher";
import { looksLikeWaitingForUser } from "./waiting-detector";
import {
  isGitRepo,
  createWorktree,
  removeWorktree,
  pruneWorktrees,
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


const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const KILLABLE_STATUSES = new Set<SessionStatus>(["starting", "running"]);
const WAITING_EVENT_DEBOUNCE_MS = 5_000;
const WAKE_CLI_TIMEOUT_MS = 30_000;


type SpawnOptions = {
  notifyLaunch?: boolean;
};

type LaunchConfirmationSession = Pick<Session, "status" | "name" | "id" | "killReason" | "error" | "result"> & {
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
};


/**
 * Orchestrates active session lifecycles, wake signaling, persistence, and GC.
 */
/** Structured input passed by Claude Code's AskUserQuestion tool. */
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    options?: Array<{ label: string; preview?: string }>;
    multiSelect?: boolean;
  }>;
}

/** Pending AskUserQuestion state stored per session. */
interface PendingAskUserQuestion {
  resolve: (result: { behavior: "allow"; updatedInput: Record<string, unknown> }) => void;
  reject: (err: Error) => void;
  questions: AskUserQuestionInput["questions"];
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  maxSessions: number;
  maxPersistedSessions: number;

  private lastWaitingEventTimestamps: Map<string, number> = new Map();
  private lastTurnCompleteMarkers: Map<string, string> = new Map();
  private lastTerminalWakeMarkers: Map<string, string> = new Map();
  /** Serializes concurrent merge operations per repo directory (keyed by repoDir). */
  private mergeQueues: Map<string, Promise<void>> = new Map();
  /** Pending AskUserQuestion intercepts awaiting user button selection. */
  private pendingAskUserQuestions: Map<string, PendingAskUserQuestion> = new Map();
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

    // Hoist worktree variables before D1 so the D1 block can populate them.
    // (Bug 1 fix: previously declared after D1, leaving them undefined on resume.)
    let worktreePath: string | undefined;
    let worktreeBranchName: string | undefined; // Fix 2-B: capture once at creation

    // D1: Resume context — if resuming and worktree info exists, try to recreate or warn.
    // F10: Restore worktreeStrategy from persisted record if not explicitly provided.
    // Bug 3 fix: use resumeWorktreeFrom as fallback so Codex resumes (where resumeSessionId
    // is cleared by decideResumeSessionId) still inherit the persisted worktree context.
    const resumeWorktreeId = config.resumeSessionId ?? config.resumeWorktreeFrom;
    if (resumeWorktreeId) {
      const persistedSession = this.store.getPersistedSession(resumeWorktreeId);
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
            // Bug 1 fix: assign hoisted variables so system prompt injection and
            // session property assignment are reached downstream.
            worktreePath = persistedSession.worktreePath;
            worktreeBranchName = persistedSession.worktreeBranch ?? getBranchName(persistedSession.worktreePath);
          } else if (persistedSession.worktreeBranch && persistedSession.workdir) {
            // Try to recreate worktree from branch.
            // Bug 2 fix: prune stale .git/worktrees/ metadata first to avoid
            // "branch already used by worktree" errors after manual directory deletion.
            try {
              const repoDir = persistedSession.workdir;
              pruneWorktrees(repoDir);
              const newWorktreePath = createWorktree(repoDir, persistedSession.worktreeBranch.replace(/^agent\//, ""));
              console.info(`[SessionManager] Recreated worktree from branch ${persistedSession.worktreeBranch}: ${newWorktreePath}`);
              config.workdir = newWorktreePath;
              // Bug 1 fix: assign hoisted variables for the recreation path too.
              worktreePath = newWorktreePath;
              worktreeBranchName = persistedSession.worktreeBranch;
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
    let worktreeCreationFailed = false;
    let worktreeSkippedNotGitRemote = false; // Fix 1-A
    // F2: Enforce admin defaultWorktreeStrategy — agents cannot override it unless it is
    // "delegate" or unset.  Resumed sessions inherit their strategy at creation time and are
    // exempt from this enforcement (their worktreeStrategy was already baked in above).
    const isResumedSession = !!(config.resumeSessionId ?? config.resumeWorktreeFrom);
    const strategy = (!isResumedSession &&
      pluginConfig.defaultWorktreeStrategy &&
      pluginConfig.defaultWorktreeStrategy !== "delegate")
      ? pluginConfig.defaultWorktreeStrategy   // Admin pinned a non-delegate strategy — override
      : (config.worktreeStrategy ?? pluginConfig.defaultWorktreeStrategy); // delegate/unset — respect per-launch
    // Bake effective strategy back into config so Session and handleWorktreeStrategy see it
    if (strategy && !config.worktreeStrategy) config.worktreeStrategy = strategy;
    // Bug 3 fix: also gate on !worktreePath — if we already inherited a worktree from the
    // persisted session (via resumeWorktreeFrom), don't attempt a new worktree creation.
    const shouldWorktree = !config.resumeSessionId && !worktreePath && strategy && strategy !== "off";
    if (shouldWorktree && isGitRepo(config.workdir)) {
      // A3: Check space before creating worktree
      if (!hasEnoughWorktreeSpace()) {
        console.warn(`[SessionManager] Insufficient space for worktree (< 100MB), skipping worktree creation`);
        worktreeCreationFailed = true; // Fix 2-B: surface disk-space skip as a user-visible warning
      } else {
        try {
          worktreePath = createWorktree(config.workdir, name);
          actualWorkdir = worktreePath;
          worktreeBranchName = getBranchName(worktreePath); // Fix 2-B: cache branch name immediately
          console.log(`[SessionManager] Created worktree at ${worktreePath}`);
        } catch (err) {
          worktreeCreationFailed = true;
          console.warn(`[SessionManager] Failed to create worktree: ${err instanceof Error ? err.message : String(err)}, using original workdir`);
        }
      }
    } else if (shouldWorktree) {
      // Fix 1-A: workdir is not a git repo — skip with dedicated notification
      worktreeSkippedNotGitRemote = true;
      console.info(`[SessionManager] Worktree creation skipped for "${name}" — workdir is not a git repo`);
    }

    // Fix 1-B: Inject worktree-aware system prompt so the agent commits to its branch
    let effectiveSystemPrompt = config.systemPrompt;
    if (worktreePath && worktreeBranchName) {
      const worktreeSuffix = [
        ``,
        `You are working in a git worktree.`,
        `Worktree path: ${worktreePath}`,
        `Branch: ${worktreeBranchName}`,
        ``,
        `IMPORTANT: ALL file edits must be made within this worktree at ${worktreePath}.`,
        `Do NOT edit files directly in ${config.workdir} (the original workspace).`,
        `If your task references files by absolute path under ${config.workdir}, rewrite those`,
        `paths relative to your current working directory. For example:`,
        `  "${config.workdir}/src/file.py"  →  use relative path "src/file.py"`,
        ``,
        `Commit all your file changes to this branch before finishing.`,
        `Use \`git add\` and \`git commit\`. Do NOT run \`git checkout\`, \`git switch\`, or \`git reset --hard\` as these will detach or corrupt the worktree HEAD.`,
      ].join("\n");
      effectiveSystemPrompt = (config.systemPrompt ?? "") + worktreeSuffix;
    }

    // Inject AskUserQuestion intercept for CC sessions. Codex sessions do not support
    // canUseTool — their questions appear as plain text in the message stream.
    // Use a late-bound wrapper so we can capture session.id after construction.
    const harnessName = config.harness ?? "claude-code";
    const selfRef = this;
    let sessionIdRef: string | undefined;
    const canUseTool = (harnessName === "claude-code" && !config.canUseTool)
      ? async (_toolName: string, input: Record<string, unknown>) => {
          if (!sessionIdRef) throw new Error("canUseTool called before session ID was set");
          return selfRef.handleAskUserQuestion(sessionIdRef, input);
        }
      : config.canUseTool;

    const session = new Session({ ...config, workdir: actualWorkdir, systemPrompt: effectiveSystemPrompt, canUseTool }, name);
    sessionIdRef = session.id; // bind late — canUseTool closure captures this ref
    if (worktreePath) {
      session.worktreePath = worktreePath;
      session.originalWorkdir = config.workdir;
      session.worktreeBranch = worktreeBranchName; // Fix 2-B: store cached branch name on session
    }
    this.sessions.set(session.id, session);
    this.metrics.incrementLaunched();

    // Wire event handlers for lifecycle management
    session.on("statusChange", (_s: Session, newStatus: SessionStatus) => {
      if (newStatus === "running" && session.harnessSessionId) {
        this.store.markRunning(session);
      } else if (TERMINAL_STATUSES.has(newStatus)) {
        // Fire async handler without awaiting to avoid blocking event loop
        this.onSessionTerminal(session).catch((err) => {
          console.error(`[SessionManager] onSessionTerminal threw for session ${session.id}:`, err);
        });
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

    // Fix 1-A: Notify when worktree was skipped because workdir is not a git repo with a remote
    if (worktreeSkippedNotGitRemote) {
      this.wakeDispatcher.dispatchSessionNotification(session, {
        label: "worktree-skipped-not-git-remote",
        userMessage: `⚠️ [${session.name}] Worktree creation skipped — workdir is not a git repo with a remote. Running in original workdir.`,
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
  private async handleWorktreeStrategy(session: Session): Promise<boolean> {
    // Early-return guard: if branch was already merged, skip all strategy handling
    if (this.isAlreadyMerged(session.harnessSessionId)) {
      console.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" already merged — skipping strategy handling`);
      return true;
    }

    // Only handle completed sessions (not failed/killed)
    if (session.status !== "completed") return false;

    const strategy = session.worktreeStrategy;
    // Skip merge-back for "off", "manual", or undefined
    if (!strategy || strategy === "off" || strategy === "manual") return false;

    const repoDir = session.originalWorkdir!;
    const worktreePath = session.worktreePath!;
    // Fix 2-C: Fall back to session.worktreeBranch if live lookup fails (worktree may be removed)
    const branchName = getBranchName(worktreePath) ?? session.worktreeBranch;
    if (!branchName) {
      this.dispatchSessionNotification(session, {
        label: "worktree-no-branch-name",
        userMessage: `⚠️ [${session.name}] Cannot determine branch name for worktree ${worktreePath}. The worktree may have been removed or is in detached HEAD state. Manual cleanup may be needed.`,
      });
      return true;
    }

    const baseBranch = session.worktreeBaseBranch ?? detectDefaultBranch(repoDir);

    // Check if there are any commits ahead
    // Fix 1-C: Replace silent return with a user notification
    if (!hasCommitsAhead(repoDir, branchName, baseBranch)) {
      this.dispatchSessionNotification(session, {
        label: "worktree-no-commits-ahead",
        userMessage: `⚠️ [${session.name}] Auto-merge: branch '${branchName}' has no commits ahead of '${baseBranch}'.\nChanges may be uncommitted. Check worktree directory: ${worktreePath}`,
      });
      return true;
    }

    const diffSummary = getDiffSummary(repoDir, branchName, baseBranch);
    if (!diffSummary) {
      console.warn(`[SessionManager] Failed to get diff summary for ${branchName}, skipping merge-back`);
      return false;
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
        ``,
        ...askCommitLines,
        ...(askMoreNote ? [askMoreNote] : []),
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
        ``,
        `Wait for user reply before acting.`,
      ].join("\n");

      const askButtons: Array<Array<{ label: string; callbackData: string }>> = [[
        { label: "⬇️ Merge locally", callbackData: `code-agent:merge:${session.id}` },
        { label: "🔀 Create PR", callbackData: `code-agent:pr:${session.id}` },
      ]];

      this.wakeDispatcher.dispatchSessionNotification(session, {
        label: "worktree-merge-ask",
        userMessage: userNotifyMessage,
        notifyUser: "always",
        buttons: askButtons,
        wakeMessageOnNotifySuccess:
          `Worktree strategy buttons delivered to user. Wait for their button callback — do NOT act on this worktree yourself. The user has already received the full diff summary and decision buttons. Do NOT send a duplicate completion message.`,
        wakeMessageOnNotifyFailed: wakeDecisionMessage,
      });

      // Stamp pending decision timestamp
      if (session.harnessSessionId) {
        this.updatePersistedSession(session.harnessSessionId, {
          pendingWorktreeDecisionSince: new Date().toISOString(),
        });
      }
      return true;
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
      return true;
    }

    if (strategy === "auto-merge") {
      // Idempotency guard: skip entirely if already merged before we even enter the queue
      if (this.isAlreadyMerged(session.harnessSessionId)) return true;

      await this.enqueueMerge(
        repoDir,
        async () => {
          // Re-check inside the queue slot in case a concurrent merge completed while we waited
          if (this.isAlreadyMerged(session.harnessSessionId)) return;

          // Attempt merge (no push — auto-merge is local-only)
          const mergeResult = mergeBranch(repoDir, branchName, baseBranch);

          if (mergeResult.success) {
            // Delete branch
            deleteBranch(repoDir, branchName);

            // Persist merge status
            if (session.harnessSessionId) {
              this.updatePersistedSession(session.harnessSessionId, {
                worktreeMerged: true,
                worktreeMergedAt: new Date().toISOString(),
              });
            }

            let successMsg = `✅ [${session.name}] Merged ${branchName} → ${baseBranch} locally. Branch cleaned up.`;
            if (mergeResult.stashPopConflict) {
              successMsg += `\n⚠️ Pre-merge stash pop conflicted — run \`git stash show ${mergeResult.stashRef ?? "stash@{0}"}\` in ${repoDir} to review stashed changes.`;
            } else if (mergeResult.stashed) {
              successMsg += `\n(Pre-existing changes on ${baseBranch} were auto-stashed and restored.)`;
            }

            this.wakeDispatcher.dispatchSessionNotification(session, {
              label: "worktree-merge-success",
              userMessage: successMsg,
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
                buttons: [[{ label: "🔀 Open PR instead", callbackData: `code-agent:open-pr:${session.id}` }]],
              });
            } catch (err) {
              this.wakeDispatcher.dispatchSessionNotification(session, {
                label: "worktree-merge-conflict-spawn-failed",
                userMessage: `❌ [${session.name}] Merge conflicts detected, but failed to spawn resolver: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          } else {
            const errorMsg = mergeResult.dirtyError
              ? `❌ [${session.name}] Merge blocked: ${mergeResult.error}`
              : `❌ [${session.name}] Merge failed: ${mergeResult.error ?? "unknown error"}`;
            this.wakeDispatcher.dispatchSessionNotification(session, {
              label: "worktree-merge-error",
              userMessage: errorMsg,
            });
          }
        },
        () => {
          // Notify user that this merge is waiting behind another in-progress merge
          this.wakeDispatcher.dispatchSessionNotification(session, {
            label: "worktree-merge-queued",
            userMessage: `🕐 [${session.name}] Merge queued — another merge for this repo is in progress. Will notify when complete.`,
          });
        },
      );
      return true;
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
        ].join("\n");

        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-pr-fallback-ask",
          userMessage: askMessage,
          buttons: [[
            { label: "✅ Merge instead", callbackData: `code-agent:merge:${session.id}` },
          ]],
        });
        return true;
      }

      // Push branch first (required for PR operations)
      if (!pushBranch(repoDir, branchName)) {
        this.wakeDispatcher.dispatchSessionNotification(session, {
          label: "worktree-pr-push-failed",
          userMessage: `❌ [${session.name}] Failed to push ${branchName} — cannot create/update PR`,
        });
        return true;
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
        return true;
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
        return true;
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
          buttons: [[
            { label: "🆕 New PR", callbackData: `code-agent:new-pr:${session.id}` },
            { label: "✅ Merge locally", callbackData: `code-agent:merge-locally:${session.id}` },
          ]],
        });
        return true;
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
        return true;
      }
    }
    return false;
  }

  private async onSessionTerminal(session: Session): Promise<void> {
    this.persistSession(session);
    this.lastWaitingEventTimestamps.delete(session.id);

    // Handle worktree merge-back strategy BEFORE cleanup
    let worktreeNotificationSent = false;
    if (session.worktreePath && session.originalWorkdir) {
      worktreeNotificationSent = await this.handleWorktreeStrategy(session);
    }

    // Detect early startup failure: session failed with a worktree but zero cost and
    // very short runtime — meaning no real work was done (e.g. usage limit hit at launch).
    // In that case, auto-clean both the worktree directory AND the branch, and clear the
    // worktree fields from the persisted record so no orphaned entries remain.
    let worktreeAutoCleaned = false;
    if (
      session.worktreePath &&
      session.originalWorkdir &&
      session.status === "failed" &&
      session.costUsd === 0 &&
      session.duration < 30_000
    ) {
      const repoDir = session.originalWorkdir;
      const branchName = getBranchName(session.worktreePath);
      console.info(
        `[SessionManager] Early startup failure for "${session.name}" — auto-cleaning worktree ` +
        `(cost=$${session.costUsd.toFixed(2)}, duration=${session.duration}ms)`
      );

      // Remove worktree directory (replaces the generic removeWorktree call below)
      removeWorktree(repoDir, session.worktreePath);

      // Delete the branch — no real work was committed, so it's safe to drop
      if (branchName) {
        deleteBranch(repoDir, branchName);
      }

      // Clear worktree fields from the persisted session record
      if (session.harnessSessionId) {
        this.updatePersistedSession(session.harnessSessionId, {
          worktreePath: undefined,
          worktreeBranch: undefined,
        });
      }

      worktreeAutoCleaned = true;
    }

    // Best-effort worktree cleanup — remove the worktree but keep the branch.
    // Skipped if the early-failure path already handled it.
    // Also skipped when a pending worktree decision is set (ask strategy button callback
    // may still fire — deleting the dir before the user clicks would break the callback).
    const hasPendingWorktreeDecision = !!session.harnessSessionId &&
      !!this.store.getPersistedSession(session.harnessSessionId)?.pendingWorktreeDecisionSince;
    if (!worktreeAutoCleaned && session.worktreePath && session.originalWorkdir) {
      if (hasPendingWorktreeDecision) {
        console.info(
          `[SessionManager] Skipping worktree directory removal for "${session.name}" — ` +
          `pendingWorktreeDecision is set (ask-strategy button callback may still fire).`,
        );
      } else {
        removeWorktree(session.originalWorkdir, session.worktreePath);
      }
    }

    // Multi-turn sessions that naturally end after a successful no-input turn
    // use reason "done". The worktree notification (if sent) IS the completion signal;
    // otherwise fall back to a terminal completion wake.
    if (session.killReason === "done") {
      if (worktreeNotificationSent) return; // worktree path already notified
      // If a turn-complete wake was dispatched, suppress the terminal notification to
      // avoid duplicates (⏸️ + ✅). The `onUserNotifyFailed` callback in
      // `triggerTurnCompleteEventWithSignal` handles the fallback if delivery fails.
      if (this.lastTurnCompleteMarkers.has(session.id)) return;
      if (!this.shouldEmitTerminalWake(session)) return;
      this.triggerAgentEvent(session);
      return;
    }

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
      this.triggerFailedEvent(session, errorSummary, worktreeAutoCleaned);
      return;
    }

    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = formatDuration(session.duration);

    if (session.killReason === "idle-timeout") {
      this.notifySession(session, `💤 [${session.name}] Idle timeout | ${costStr} | ${duration}`);
      this.wakeDispatcher.clearRetryTimersForSession(session.id);
      return;
    }

    const statusLabel = this.getStoppedStatusLabel(session.killReason);
    this.notifySession(session, `⛔ [${session.name}] ${statusLabel} | ${costStr} | ${duration}`);
    this.wakeDispatcher.clearRetryTimersForSession(session.id);
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
      `(Note: a turn-complete wake may have already been sent for this session. If you already acted on it, treat this as confirmation — do not repeat actions.)`,
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
    const telegramText = session.outputMode === "deliverable"
      ? `📄 [${session.name}] Deliverable ready | ${costStr} | ${duration}`
      : `✅ [${session.name}] Completed | ${costStr} | ${duration}`;

    this.dispatchSessionNotification(session, {
      label: "completed",
      userMessage: telegramText,
      wakeMessage: eventText,
      notifyUser: "always",
    });
  }

  private triggerFailedEvent(session: Session, errorSummary: string, worktreeAutoCleaned: boolean = false): void {
    const preview = this.getOutputPreview(session);
    const outputSection = preview.trim()
      ? ["", "Output preview:", preview]
      : [];

    const worktreeCleanupNote = worktreeAutoCleaned
      ? [``, `Note: Worktree and branch were auto-removed (zero cost, startup failure).`]
      : [];

    const eventText = [
      `Coding agent session failed.`,
      `Name: ${session.name} | ID: ${session.id}`,
      `Status: ${session.status}`,
      this.originThreadLine(session),
      `Harness session ID: ${session.harnessSessionId ?? "unknown"}`,
      ``,
      `Failure summary:`,
      errorSummary,
      ...outputSection,
      ...worktreeCleanupNote,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session failure:`,
      `1. Use agent_output(session='${session.id}', full=true) to inspect the full failure context.`,
      `2. If the failure is a runtime error (usage limit, API error, crash), resume with a different harness:`,
      `   agent_launch(resume_session_id='${session.harnessSessionId ?? "unknown"}', harness='claude-code', ...)`,
      `   Note: agent_respond also resumes, but uses the same harness (may hit the same error).`,
      `   If the failure is a launch/config issue, relaunch fresh with agent_launch(prompt=...).`,
      `3. Notify the user with the failure cause and the next action you are taking.`,
    ].join("\n");

    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = formatDuration(session.duration);
    const telegramText = [
      `❌ [${session.name}] Failed | ${costStr} | ${duration}`,
      `   ⚠️ ${errorSummary}`,
    ].join("\n");

    const failedButtons: Array<Array<{ label: string; callbackData: string }>> = [[
      { label: "🔄 Retry", callbackData: `code-agent:retry:${session.id}` },
      { label: "📋 View output", callbackData: `code-agent:view-output:${session.id}` },
    ]];

    this.dispatchSessionNotification(session, {
      label: "failed",
      userMessage: telegramText,
      wakeMessage: eventText,
      notifyUser: "always",
      buttons: failedButtons,
    });
  }

  private triggerWaitingForInputEvent(session: Session): void {
    if (!this.debounceWaitingEvent(session.id)) return;

    const preview = this.getOutputPreview(session);
    const isPlanApproval = session.pendingPlanApproval;

    const telegramText = isPlanApproval
      ? `📋 [${session.name}] Plan ready for review:\n\n${preview}\n\nReply to approve or provide feedback.`
      : `❓ [${session.name}] Waiting for input`;

    const planApprovalMode = isPlanApproval ? (pluginConfig.planApproval ?? "delegate") : undefined;

    let eventText: string;
    if (isPlanApproval) {
      const _planApprovalMode = planApprovalMode ?? "delegate";
      if (_planApprovalMode === "delegate") {
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
      } else if (_planApprovalMode === "ask") {
        // ask mode — notify the user directly; Alice must wait for explicit user approval
        eventText = [
          `[USER APPROVAL REQUESTED] Coding agent session has finished its plan. The user has been notified via Telegram and must approve directly.`,
          `Name: ${session.name} | ID: ${session.id}`,
          this.originThreadLine(session),
          ``,
          `DO NOT approve this plan yourself. Wait for the user's explicit approval or rejection.`,
          `Once the user responds, forward their decision:`,
          `  To approve: agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
          `  To request changes: agent_respond(session='${session.id}', message='<user feedback>')`,
          ``,
          `Preview (truncated):`,
          preview,
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

    const waitingButtons: Array<Array<{ label: string; callbackData: string }>> | undefined =
      isPlanApproval && planApprovalMode === "ask"
        ? [[
            { label: "✅ Approve", callbackData: `code-agent:approve:${session.id}` },
            { label: "❌ Reject", callbackData: `code-agent:reject:${session.id}` },
            { label: "✏️ Revise", callbackData: `code-agent:revise:${session.id}` },
          ]]
        : !isPlanApproval
          ? [[{ label: "💬 Reply", callbackData: `code-agent:reply:${session.id}` }]]
          : undefined; // delegate and approve modes: no buttons

    if (isPlanApproval && planApprovalMode === "ask") {
      // ask mode: send buttons to user and gate the orchestrator wake on delivery outcome
      this.dispatchSessionNotification(session, {
        label: "plan-approval",
        userMessage: telegramText,
        notifyUser: "always",
        buttons: waitingButtons,
        wakeMessageOnNotifySuccess:
          `Plan approval buttons delivered to user. Wait for their button callback — do NOT approve or reject this plan yourself.`,
        wakeMessageOnNotifyFailed: eventText,
      });
    } else {
      // delegate and approve modes: immediate wake, no buttons
      this.dispatchSessionNotification(session, {
        label: isPlanApproval ? "plan-approval" : "waiting",
        userMessage: telegramText,
        wakeMessage: eventText,
        notifyUser: "always",
        buttons: waitingButtons,
      });
    }
  }

  private onTurnEnd(session: Session, hadQuestion: boolean): void {
    // Use the dedicated waiting path for explicit question/plan-approval turns.
    // This preserves plan approval policy handling and waiting-specific guidance.
    if (hadQuestion || session.pendingPlanApproval) {
      this.triggerWaitingForInputEvent(session);
      return;
    }

    // Suppress turn-complete for ask/delegate — the worktree notification IS the completion signal
    if (session.worktreeStrategy === "ask" || session.worktreeStrategy === "delegate") {
      console.info(
        `[SessionManager] Suppressing turn-complete wake for session ${session.id} ` +
        `(worktreeStrategy=${session.worktreeStrategy}) — worktree notification will follow.`,
      );
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
    if (prev === marker) {
      console.info(
        `[SessionManager] shouldEmitTurnCompleteWake: debounced for session ${session.id} ` +
        `(marker unchanged: ${marker})`,
      );
      return false;
    }
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
    console.info(
      `[SessionManager] turn-complete wake dispatching for session ${session.id} ` +
      `(turns=${session.result?.num_turns ?? 0}, strategy=${session.worktreeStrategy ?? "none"})`,
    );
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
      // If all turn-complete delivery paths fail, fire the terminal notification as fallback
      // so the user still learns the session completed. The `onSessionTerminal` path is
      // suppressed when a turn-complete was dispatched (see killReason === "done" block),
      // so this callback is the only recovery path on full delivery failure.
      onUserNotifyFailed: () => {
        console.warn(
          `[SessionManager] turn-complete delivery failed for session ${session.id} — ` +
          `firing terminal notification as fallback`,
        );
        if (!this.shouldEmitTerminalWake(session)) return;
        this.triggerAgentEvent(session);
      },
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

  /** Kill all active sessions. Per-session retry timers are cleared in onSessionTerminal. */
  killAll(reason: KillReason = "user"): void {
    for (const session of this.sessions.values()) {
      if (KILLABLE_STATUSES.has(session.status)) {
        this.kill(session.id, reason);
      }
    }
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

  /** Returns true if this session's branch has already been merged (idempotency guard). */
  private isAlreadyMerged(harnessSessionId: string | undefined): boolean {
    if (!harnessSessionId) return false;
    return this.store.getPersistedSession(harnessSessionId)?.worktreeMerged === true;
  }

  /**
   * Enqueue a merge operation for a given repo, ensuring only one merge runs at a time
   * per repo directory. If another merge is already in progress, `onQueued` is called
   * immediately (before waiting), and the new operation waits its turn.
   *
   * The returned Promise resolves/rejects with the result of `fn()`.
   * A prior failure in the queue does NOT block subsequent items.
   */
  async enqueueMerge(
    repoDir: string,
    fn: () => Promise<void>,
    onQueued?: () => void,
  ): Promise<void> {
    const current = this.mergeQueues.get(repoDir);
    if (current !== undefined && onQueued) onQueued();

    // Chain off the current tail; swallow prior errors so they don't block the queue
    const next: Promise<void> = (current ?? Promise.resolve())
      .catch(() => {})
      .then(() => fn());

    // The tail stored in the map must never reject (unhandled rejection)
    const tail = next.catch(() => {});
    this.mergeQueues.set(repoDir, tail);
    tail.finally(() => {
      // Only delete if no newer operation has replaced this entry
      if (this.mergeQueues.get(repoDir) === tail) this.mergeQueues.delete(repoDir);
    });

    return next; // caller awaits this — will reject if fn() throws
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

  /** Send hourly reminders for sessions with unresolved pending worktree decisions. */
  private remindStaleDecisions(): void {
    const REMINDER_INTERVAL_MS = 60 * 60 * 1000; // 1h
    const now = Date.now();

    for (const session of this.store.listPersistedSessions()) {
      // Only sessions with pending decisions that aren't resolved
      if (!session.pendingWorktreeDecisionSince) continue;
      if (session.worktreeMerged || session.worktreePrUrl) continue;

      const pendingMs = now - new Date(session.pendingWorktreeDecisionSince).getTime();
      if (pendingMs < REMINDER_INTERVAL_MS) continue;

      // Rate-limit: max once per 1h per session
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
      buttons: [[
        { label: "⬇️ Merge locally", callbackData: `code-agent:merge:${session.harnessSessionId}` },
        { label: "🔀 Create PR", callbackData: `code-agent:open-pr:${session.harnessSessionId}` },
      ]],
    });
  }

  /**
   * Intercept an AskUserQuestion tool call from a CC session.
   * Sends inline buttons to the user and returns a Promise that resolves when
   * the user clicks a button (via resolveAskUserQuestion) or rejects on timeout.
   */
  async handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }> {
    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found for AskUserQuestion intercept`);
    }

    const typedInput = input as unknown as AskUserQuestionInput;
    const questions = typedInput?.questions ?? [];
    if (questions.length === 0) {
      throw new Error(`AskUserQuestion: no questions in input`);
    }

    const firstQuestion = questions[0];
    const options = firstQuestion.options ?? [];

    const fallbackWakeText = [
      `[ASK USER QUESTION] Session "${session.name}" has a question requiring user input.`,
      ``,
      `Question: ${firstQuestion.question}`,
      ...(options.length > 0 ? [`Options:`, ...options.map((o, i) => `  ${i + 1}. ${o.label}`)] : []),
      ``,
      `Send the question to the user and call agent_respond(session="${session.id}", message="<answer>") with their answer.`,
    ].join("\n");

    let buttons: Array<Array<{ label: string; callbackData: string }>> | undefined;
    if (options.length > 0) {
      buttons = [options.map((o, i) => ({
        label: o.label,
        callbackData: `code-agent:question-answer:${session.id}:${i}`,
      }))];
    }

    const userMessage = [
      `❓ [${session.name}] ${firstQuestion.question}`,
    ].join("\n");

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingAskUserQuestions.delete(sessionId);
        reject(new Error(`AskUserQuestion timed out after ${TIMEOUT_MS / 1000}s for session "${session.name}"`));
      }, TIMEOUT_MS);

      this.pendingAskUserQuestions.set(sessionId, {
        resolve,
        reject,
        questions,
        timeoutHandle,
      });

      this.wakeDispatcher.dispatchSessionNotification(session, {
        label: "ask-user-question",
        userMessage,
        notifyUser: "always",
        buttons,
        wakeMessageOnNotifySuccess:
          `AskUserQuestion buttons delivered to user. Await their selection — do NOT answer this question yourself.`,
        wakeMessageOnNotifyFailed: fallbackWakeText,
      });
    });
  }

  /**
   * Resolve a pending AskUserQuestion by option index (from button callback).
   */
  resolveAskUserQuestion(sessionId: string, optionIndex: number): void {
    const pending = this.pendingAskUserQuestions.get(sessionId);
    if (!pending) {
      console.warn(`[SessionManager] resolveAskUserQuestion: no pending question for session "${sessionId}"`);
      return;
    }
    clearTimeout(pending.timeoutHandle);
    this.pendingAskUserQuestions.delete(sessionId);

    const firstQuestion = pending.questions[0];
    const options = firstQuestion.options ?? [];
    const selectedOption = options[optionIndex];
    if (!selectedOption) {
      pending.reject(new Error(`AskUserQuestion: invalid option index ${optionIndex} (${options.length} options available)`));
      return;
    }

    pending.resolve({
      behavior: "allow",
      updatedInput: {
        questions: pending.questions,
        answers: { [firstQuestion.question]: selectedOption.label },
      },
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
