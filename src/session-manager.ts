import { existsSync } from "fs";

import { Session } from "./session";
import { pluginConfig, getDefaultHarnessName } from "./config";
import { prepareSessionBootstrap } from "./session-bootstrap";
import { formatDuration, generateSessionName, lastCompleteLines, truncateText } from "./format";
import { formatLaunchSummary } from "./launch-summary";
import { pathsReferToSameLocation } from "./path-utils";
import { SessionSemanticAdapter } from "./session-semantic-adapter";
import type {
  SessionConfig,
  SessionStatus,
  SessionMetrics,
  PersistedSessionInfo,
  KillReason,
  PlanApprovalMode,
  SessionActionKind,
  SessionActionToken,
} from "./types";
import { SessionStore } from "./session-store";
import { SessionMetricsRecorder } from "./session-metrics";
import { WakeDispatcher, type SessionNotificationRequest } from "./wake-dispatcher";
import { SessionInteractionService, type NotificationButton } from "./session-interactions";
import { SessionNotificationService } from "./session-notifications";
import { SessionWorktreeController } from "./session-worktree-controller";
import {
  removeWorktree,
  getDiffSummary,
  mergeBranch,
  deleteBranch,
  detectDefaultBranch,
  formatWorktreeOutcomeLine,
  getPrimaryRepoRootFromWorktree,
  isGitHubCLIAvailable,
} from "./worktree";


const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const KILLABLE_STATUSES = new Set<SessionStatus>(["starting", "running"]);
const WAITING_EVENT_DEBOUNCE_MS = 5_000;


type SpawnOptions = {
  notifyLaunch?: boolean;
};

type LaunchConfirmationSession = Pick<Session, "status" | "name" | "id" | "killReason" | "error" | "result"> & {
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
};

type WorktreeStrategyResult = {
  notificationSent: boolean;
  worktreeRemoved: boolean;
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
  private lastDailyMaintenanceAt = 0;

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
  private readonly interactions: SessionInteractionService;
  private readonly notifications: SessionNotificationService;
  private readonly worktrees: SessionWorktreeController;
  private readonly semantic: SessionSemanticAdapter;

  constructor(maxSessions: number = 20, maxPersistedSessions: number = 50) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
    this.store = new SessionStore();
    this.metrics = new SessionMetricsRecorder();
    this.wakeDispatcher = new WakeDispatcher();
    this.interactions = new SessionInteractionService(this.store, isGitHubCLIAvailable);
    this.notifications = new SessionNotificationService(
      this.wakeDispatcher,
      (ref, patch) => this.applySessionPatch(ref, patch),
    );
    this.worktrees = new SessionWorktreeController();
    this.semantic = new SessionSemanticAdapter();
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

    if (!config.route?.provider || !config.route.target) {
      throw new Error(`Cannot launch session "${name}": missing explicit route metadata.`);
    }

    const {
      actualWorkdir,
      originalWorkdir,
      effectiveSystemPrompt,
      worktreePath,
      worktreeBranchName,
    } = prepareSessionBootstrap(config, name, (ref) => this.store.getPersistedSession(ref));

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

    const session = new Session({
      ...config,
      workdir: actualWorkdir,
      systemPrompt: effectiveSystemPrompt,
      canUseTool,
      turnBoundaryDecision: (context) => this.semantic.classifyTurnBoundary(context),
    }, name);
    sessionIdRef = session.id; // bind late — canUseTool closure captures this ref
    if (worktreePath) {
      session.worktreePath = worktreePath;
      session.originalWorkdir = originalWorkdir;
      session.worktreeBranch = worktreeBranchName; // Fix 2-B: store cached branch name on session
      session.worktreeState = "provisioned";
    }
    if (config.worktreePrTargetRepo) {
      session.worktreePrTargetRepo = config.worktreePrTargetRepo;
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
      const workdirLabel = this.formatLaunchWorkdirLabel(session);
      const launchText = `🚀 [${session.name}] Launched | ${workdirLabel} | ${session.model ?? "default"}`;
      this.notifySession(session, launchText, "launch");
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

  formatLaunchResult(config: {
    prompt: string;
    workdir: string;
    harness: string;
    permissionMode: string;
    planApproval: string;
    forceNewSession?: boolean;
    resumeSessionId?: string;
    forkSession?: boolean;
    clearedPersistedCodexResume?: boolean;
  }, session: Session): string {
    return formatLaunchSummary({
      sessionId: session.id,
      sessionName: session.name,
      prompt: config.prompt,
      workdir: config.workdir,
      harness: config.harness,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      permissionMode: config.permissionMode,
      planApproval: config.planApproval,
      worktreeStrategy: session.worktreeStrategy ?? "off",
      worktreePath: session.worktreePath,
      originalWorkdir: session.originalWorkdir,
      codexApprovalPolicy: session.codexApprovalPolicy,
      resumeSessionId: config.resumeSessionId,
      forkSession: config.forkSession,
      forceNewSession: config.forceNewSession,
      clearedPersistedCodexResume: config.clearedPersistedCodexResume,
    });
  }

  private shouldRunWorktreeStrategy(session: Session): boolean {
    const phase = session.lifecycle;
    if (phase === "starting" || phase === "awaiting_plan_decision" || phase === "awaiting_user_input") return false;
    if (session.pendingPlanApproval) return false;
    return true;
  }

  private makeActionButton(
    sessionId: string,
    kind: SessionActionKind,
    label: string,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): NotificationButton {
    return this.interactions.makeActionButton(sessionId, kind, label, options);
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    return this.interactions.consumeActionToken(tokenId);
  }

  private getWorktreeDecisionButtons(sessionId: string): NotificationButton[][] | undefined {
    const session = this.resolve(sessionId) ?? this.getPersistedSession(sessionId);
    if (!session || session.worktreeStrategy === "delegate") return undefined;
    return this.interactions.getWorktreeDecisionButtons(sessionId, session);
  }

  private getWorktreeCompletionState(
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): "no-change" | "dirty-uncommitted" | "base-advanced" | "has-commits" {
    return this.worktrees.getCompletionState(repoDir, worktreePath, branchName, baseBranch);
  }

  notifyWorktreeOutcome(
    sessionOrPersisted: Session | {
      id: string;
      harnessSessionId?: string;
      route?: PersistedSessionInfo["route"];
    },
    outcomeLine: string,
  ): void {
    this.notifications.notifyWorktreeOutcome(sessionOrPersisted as Session, outcomeLine);
  }

  private buildRoutingProxy(session: {
    id?: string;
    harnessSessionId?: string;
    route?: PersistedSessionInfo["route"];
  }): Session {
    return {
      id: session.id ?? session.harnessSessionId ?? "unknown-session",
      harnessSessionId: session.harnessSessionId,
      route: session.route,
    } as Session;
  }

  private buildDelegateWorktreeWakeMessage(args: {
    sessionName: string;
    sessionId: string;
    branchName: string;
    baseBranch: string;
    promptSnippet: string;
    commitLines: string[];
    moreNote?: string;
    diffSummary: {
      commits: number;
      filesChanged: number;
      insertions: number;
      deletions: number;
    };
  }): string {
    const {
      sessionName,
      sessionId,
      branchName,
      baseBranch,
      promptSnippet,
      commitLines,
      moreNote,
      diffSummary,
    } = args;

    return [
      `[DELEGATED WORKTREE DECISION] Session "${sessionName}" completed with changes.`,
      ``,
      `Session ID: ${sessionId}`,
      `Branch: ${branchName} → ${baseBranch}`,
      `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
      ``,
      ...commitLines,
      ...(moreNote ? [moreNote] : []),
      ``,
      `Original task prompt (first 500 chars):`,
      promptSnippet,
      ``,
      `You own the next step for this worktree.`,
      `- Merge immediately with agent_merge(session="${sessionName}", base_branch="${baseBranch}") if the changes are clearly in-scope and low-risk.`,
      `- If a PR is safer, message the user with the summary and ask for confirmation before calling agent_pr().`,
      `- If scope or risk is unclear, message the user and ask for guidance.`,
      `- Never call agent_pr() autonomously in delegate mode.`,
      `- After deciding, notify the user briefly with what you did and why.`,
    ].join("\n");
  }

  private buildDelegateReminderWakeMessage(session: PersistedSessionInfo, pendingHours: number): string {
    return [
      `[DELEGATED WORKTREE DECISION REMINDER] Session "${session.name}" still has an unresolved worktree decision.`,
      ``,
      `Session ID: ${session.sessionId ?? session.harnessSessionId}`,
      `Branch: ${session.worktreeBranch ?? "unknown"}`,
      `Pending: ${pendingHours}h`,
      ``,
      `Resolve it now:`,
      `- agent_merge(session="${session.name}") if the diff is clearly safe and in scope`,
      `- If a PR is safer, ask the user before agent_pr()`,
      `- If scope or risk is unclear, ask the user for guidance`,
      `- Never call agent_pr() autonomously in delegate mode`,
    ].join("\n");
  }

  private buildWorktreeDecisionSummary(diffSummary: {
    changedFiles: string[];
    commitMessages: Array<{ message: string }>;
  }): string[] {
    const summaryLines: string[] = [];
    const topFiles = diffSummary.changedFiles.slice(0, 3).map((file) => `\`${file}\``);
    if (topFiles.length > 0) {
      const remainingFiles = diffSummary.changedFiles.length - topFiles.length;
      summaryLines.push(
        remainingFiles > 0
          ? `Touches ${topFiles.join(", ")} and ${remainingFiles} more file${remainingFiles === 1 ? "" : "s"}`
          : `Touches ${topFiles.join(", ")}`,
      );
    }

    const recentSubjects = [...new Set(
      diffSummary.commitMessages
        .map((commit) => commit.message.trim())
        .filter(Boolean),
    )].slice(0, 2);
    if (recentSubjects.length > 0) {
      summaryLines.push(`Recent work: ${recentSubjects.join("; ")}`);
    }

    return summaryLines;
  }

  private resolveWorktreeRepoDir(repoDir: string | undefined, worktreePath?: string): string | undefined {
    if (repoDir && (!worktreePath || !pathsReferToSameLocation(repoDir, worktreePath))) return repoDir;
    if (!worktreePath) return repoDir;
    return getPrimaryRepoRootFromWorktree(worktreePath) ?? repoDir;
  }

  private formatLaunchWorkdirLabel(session: Pick<Session, "workdir" | "worktreePath" | "originalWorkdir">): string {
    if (!session.worktreePath) return session.workdir;
    const repoDir = this.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
    if (!repoDir || repoDir === session.worktreePath) return session.worktreePath;
    return `${session.worktreePath} (worktree of ${repoDir})`;
  }

  private buildNoChangeDeliverableMessage(
    session: Pick<Session, "name">,
    preview: string,
    cleanupSucceeded: boolean,
    worktreePath: string,
  ): string {
    const cleanupLine = cleanupSucceeded
      ? "No code changes were made; the worktree was cleaned up."
      : `No code changes were made; worktree cleanup failed. Worktree still exists at ${worktreePath}`;
    return [
      `📋 [${session.name}] Completed with report-only output:`,
      ``,
      preview,
      ``,
      cleanupLine,
    ].join("\n");
  }

  private getNoChangeOutputText(
    session: Pick<Session, "getOutput">,
    maxChars: number = 5_000,
  ): string {
    return session.getOutput()
      .join("\n")
      .slice(-maxChars)
      .trim();
  }

  private async classifyNoChangeDeliverable(
    session: Pick<Session, "harnessName" | "name" | "prompt" | "originAgentId" | "getOutput"> & {
      workdir?: string;
      originalWorkdir?: string;
    },
  ): Promise<string | undefined> {
    if (typeof session.getOutput !== "function") return undefined;
    const preview = this.getOutputPreview(session as Session, 2_500).trim();
    if (!preview) return undefined;
    const outputText = this.getNoChangeOutputText(session);
    const workspaceDir = session.workdir ?? session.originalWorkdir;
    if (!outputText) return undefined;
    if (!workspaceDir) return undefined;

    const result = await this.semantic.classifyNoChangeDeliverable({
      harnessName: session.harnessName,
      sessionName: session.name,
      prompt: session.prompt,
      workdir: workspaceDir,
      agentId: session.originAgentId,
      outputText,
    });
    return result.classification === "report_worthy_no_change" ? preview : undefined;
  }

  async dismissWorktree(ref: string): Promise<string> {
    const persistedSession = this.store.getPersistedSession(ref);
    const activeSession = this.resolve(ref);
    const session = activeSession ?? persistedSession;
    if (!session) return `Error: Session "${ref}" not found.`;

    const worktreePath = activeSession?.worktreePath ?? persistedSession?.worktreePath;
    const repoDir = this.resolveWorktreeRepoDir(activeSession?.originalWorkdir ?? persistedSession?.workdir, worktreePath);
    const branchName = activeSession?.worktreeBranch ?? persistedSession?.worktreeBranch;
    const sessionName = activeSession?.name ?? persistedSession?.name ?? ref;

    if (!repoDir) return `Error: No workdir found for session "${ref}".`;

    // Remove worktree directory
    if (worktreePath && existsSync(worktreePath)) {
      removeWorktree(repoDir, worktreePath);
    }

    // Delete branch
    if (branchName) {
      deleteBranch(repoDir, branchName);
    }

    // Update persisted state
    const harnessId = activeSession?.harnessSessionId ?? persistedSession?.harnessSessionId;
    if (harnessId) {
      this.updatePersistedSession(harnessId, {
        worktreeDisposition: "dismissed",
        worktreeDismissedAt: new Date().toISOString(),
        pendingWorktreeDecisionSince: undefined,
        worktreeState: "dismissed",
        lifecycle: "terminal",
        worktreePath: undefined,
        worktreeBranch: undefined,
      } as Partial<PersistedSessionInfo>);
    }

    // Notify
    const msg = `🗑️ [${sessionName}] Branch \`${branchName ?? "unknown"}\` dismissed and permanently deleted.`;
    const routingProxy = this.buildRoutingProxy({
      id: harnessId ?? ref,
      harnessSessionId: harnessId ?? ref,
      route: activeSession?.route ?? persistedSession?.route,
    });
    this.notifications.dispatch(routingProxy, {
      label: "worktree-dismissed",
      userMessage: msg,
      notifyUser: "always",
    });

    return msg;
  }

  snoozeWorktreeDecision(ref: string): string {
    const persistedSession = this.store.getPersistedSession(ref);
    if (!persistedSession) return `Error: Session "${ref}" not found.`;

    const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.updatePersistedSession(persistedSession.harnessSessionId, {
      worktreeDecisionSnoozedUntil: snoozedUntil,
      lastWorktreeReminderAt: new Date().toISOString(),
    } as Partial<PersistedSessionInfo>);

    const branchName = persistedSession.worktreeBranch ?? "unknown";
    const msg = `⏭️ Reminder snoozed 24h for \`${branchName}\` (session: ${persistedSession.name})`;

    const routingProxy = this.buildRoutingProxy({
      id: persistedSession.harnessSessionId,
      harnessSessionId: persistedSession.harnessSessionId,
      route: persistedSession.route,
    });
    this.notifications.dispatch(routingProxy, {
      label: "worktree-snoozed",
      userMessage: msg,
      notifyUser: "always",
    });

    return msg;
  }

  /**
   * Handle worktree merge-back strategy when a session with a worktree terminates.
   * Called from onSessionTerminal BEFORE worktree cleanup.
   */
  private async handleWorktreeStrategy(session: Session): Promise<WorktreeStrategyResult> {
    // Early-return guard: if branch was already merged, skip all strategy handling
    if (this.isAlreadyMerged(session.harnessSessionId)) {
      console.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" already merged — skipping strategy handling`);
      return { notificationSent: true, worktreeRemoved: false };
    }

    // Only handle completed sessions (not failed/killed)
    if (session.status !== "completed") return { notificationSent: false, worktreeRemoved: false };

    // Phase gate: skip strategy during plan turns
    if (!this.shouldRunWorktreeStrategy(session)) {
      console.info(`[SessionManager] handleWorktreeStrategy: skipping — session "${session.name}" is in phase "${session.phase}"`);
      return { notificationSent: false, worktreeRemoved: false };
    }

    const strategy = session.worktreeStrategy;
    // Skip merge-back for "off", "manual", or undefined
    if (!strategy || strategy === "off" || strategy === "manual") {
      return { notificationSent: false, worktreeRemoved: false };
    }

    const worktreePath = session.worktreePath!;
    const repoDir = this.resolveWorktreeRepoDir(session.originalWorkdir, worktreePath);
    const branchName = session.worktreeBranch;
    if (!repoDir) {
      this.dispatchSessionNotification(session, {
        label: "worktree-missing-repo-dir",
        userMessage: `⚠️ [${session.name}] Cannot determine the original repo for worktree ${worktreePath}. Manual inspection is required.`,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (!branchName) {
      this.dispatchSessionNotification(session, {
        label: "worktree-no-branch-name",
        userMessage: `⚠️ [${session.name}] Cannot determine branch name for worktree ${worktreePath}. The worktree may have been removed or is in detached HEAD state. Manual cleanup may be needed.`,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }

    const baseBranch = session.worktreeBaseBranch ?? detectDefaultBranch(repoDir);

    const completionState = this.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch);

    if (completionState === "no-change") {
      const deliverablePreview = await this.classifyNoChangeDeliverable(session);
      const removed = removeWorktree(repoDir, worktreePath);
      if (removed) {
        session.worktreePath = undefined;
        if (session.harnessSessionId) {
          this.updatePersistedSession(session.harnessSessionId, {
            worktreePath: undefined,
            worktreeDisposition: "no-change-cleaned",
            worktreeState: "none",
          });
        }
        this.dispatchSessionNotification(session, {
          label: deliverablePreview ? "worktree-no-change-deliverable" : "worktree-no-changes",
          userMessage: deliverablePreview
            ? this.buildNoChangeDeliverableMessage(session, deliverablePreview, true, worktreePath)
            : `ℹ️ [${session.name}] Session completed with no changes — worktree cleaned up`,
        });
      } else {
        this.dispatchSessionNotification(session, {
          label: deliverablePreview ? "worktree-no-change-deliverable-cleanup-failed" : "worktree-no-changes-cleanup-failed",
          userMessage: deliverablePreview
            ? this.buildNoChangeDeliverableMessage(session, deliverablePreview, false, worktreePath)
            : `⚠️ [${session.name}] Session completed with no changes, but worktree cleanup failed. Worktree still exists at ${worktreePath}`,
        });
      }
      return { notificationSent: true, worktreeRemoved: removed };
    }

    if (completionState === "base-advanced") {
      this.dispatchSessionNotification(session, {
        label: "worktree-no-commits-ahead",
        userMessage: `⚠️ [${session.name}] Auto-merge: branch '${branchName}' has no commits ahead of '${baseBranch}', but '${baseBranch}' has new commits — commits likely landed outside the worktree branch. Verify that commits were not made directly to '${baseBranch}' instead of the worktree branch. Worktree: ${worktreePath}`,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }

    if (completionState === "dirty-uncommitted") {
      this.dispatchSessionNotification(session, {
        label: "worktree-dirty-uncommitted",
        userMessage: `⚠️ [${session.name}] Session completed with uncommitted changes. The branch has no commits ahead of '${baseBranch}' but there are modified tracked files in the worktree. Check: ${worktreePath}`,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }

    // completionState === "has-commits" — proceed with strategy
    const diffSummary = getDiffSummary(repoDir, branchName, baseBranch);
    if (!diffSummary) {
      console.warn(`[SessionManager] Failed to get diff summary for ${branchName}, skipping merge-back`);
      return { notificationSent: false, worktreeRemoved: false };
    }

    if (strategy === "ask") {
      const askSummaryLines = this.buildWorktreeDecisionSummary(diffSummary);
      const askCommitLines = diffSummary.commitMessages
        .slice(0, 5)
        .map((c) => `• ${c.hash} ${c.message} (${c.author})`);
      const askMoreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : "";

      const askBranchLine = session.worktreePrTargetRepo
        ? `Branch: \`${branchName}\` → \`${baseBranch}\` | PR target: ${session.worktreePrTargetRepo}`
        : `Branch: \`${branchName}\` → \`${baseBranch}\``;

      const userNotifyMessage = [
        `🔀 Worktree decision required for session \`${session.name}\``,
        ``,
        askBranchLine,
        `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
        ``,
        ...(askSummaryLines.length > 0
          ? [
              `Summary:`,
              ...askSummaryLines.map((line) => `- ${line}`),
              ``,
            ]
          : []),
        `Recent commits:`,
        ...askCommitLines,
        ...(askMoreNote ? [askMoreNote] : []),
        ``,
        `⚠️ Discard will permanently delete branch \`${branchName}\` and all local changes. This cannot be undone.`,
      ].join("\n");

      this.dispatchSessionNotification(session, {
        label: "worktree-merge-ask",
        userMessage: userNotifyMessage,
        notifyUser: "always",
        buttons: this.getWorktreeDecisionButtons(session.id),
        wakeMessageOnNotifySuccess:
          `Worktree strategy buttons delivered to user. Wait for their button callback — do NOT act on this worktree yourself.`,
        wakeMessageOnNotifyFailed: userNotifyMessage,
      });

      // Stamp pending decision timestamp
      if (session.harnessSessionId) {
        this.updatePersistedSession(session.harnessSessionId, {
          pendingWorktreeDecisionSince: new Date().toISOString(),
          lifecycle: "awaiting_worktree_decision",
          worktreeState: "pending_decision",
        });
      }
      return { notificationSent: true, worktreeRemoved: false };
    }

    if (strategy === "delegate") {
      const delegateCommitLines = diffSummary.commitMessages
        .slice(0, 5)
        .map((c) => `• ${c.hash} ${c.message} (${c.author})`);
      const delegateMoreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : "";
      const promptSnippet = session.prompt ? session.prompt.slice(0, 500) : "(no prompt)";

      this.dispatchSessionNotification(session, {
        label: "worktree-delegate",
        wakeMessage: this.buildDelegateWorktreeWakeMessage({
          sessionName: session.name,
          sessionId: session.id,
          branchName,
          baseBranch,
          promptSnippet,
          commitLines: delegateCommitLines,
          moreNote: delegateMoreNote || undefined,
          diffSummary,
        }),
        notifyUser: "never",
      });

      // Stamp pending decision timestamp
      if (session.harnessSessionId) {
        this.updatePersistedSession(session.harnessSessionId, {
          pendingWorktreeDecisionSince: new Date().toISOString(),
          lifecycle: "awaiting_worktree_decision",
          worktreeState: "pending_decision",
        });
      }
      return { notificationSent: true, worktreeRemoved: false };
    }

    if (strategy === "auto-merge") {
      // Idempotency guard: skip entirely if already merged before we even enter the queue
      if (this.isAlreadyMerged(session.harnessSessionId)) {
        return { notificationSent: true, worktreeRemoved: false };
      }

      await this.enqueueMerge(
        repoDir,
        async () => {
          // Re-check inside the queue slot in case a concurrent merge completed while we waited
          if (this.isAlreadyMerged(session.harnessSessionId)) return;

          // Attempt merge (no push — auto-merge is local-only)
          const mergeResult = mergeBranch(repoDir, branchName, baseBranch, "merge", worktreePath);

          if (mergeResult.success) {
            // Delete branch
            deleteBranch(repoDir, branchName);

            // Persist merge status
            if (session.harnessSessionId) {
              this.updatePersistedSession(session.harnessSessionId, {
                worktreeMerged: true,
                worktreeMergedAt: new Date().toISOString(),
                lifecycle: "terminal",
                worktreeState: "merged",
                pendingWorktreeDecisionSince: undefined,
                lastWorktreeReminderAt: undefined,
              });
            }

            const outcomeLine = formatWorktreeOutcomeLine({
              kind: "merge",
              branch: branchName,
              base: baseBranch,
              filesChanged: diffSummary.filesChanged,
              insertions: diffSummary.insertions,
              deletions: diffSummary.deletions,
            });
            let successMsg = outcomeLine;
            if (mergeResult.stashPopConflict) {
              successMsg += `\n⚠️ Pre-merge stash pop conflicted — run \`git stash show ${mergeResult.stashRef ?? "stash@{0}"}\` in ${repoDir} to review stashed changes.`;
            } else if (mergeResult.stashed) {
              successMsg += `\n(Pre-existing changes on ${baseBranch} were auto-stashed and restored.)`;
            }

            this.dispatchSessionNotification(session, {
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
                harness: getDefaultHarnessName(),
                permissionMode: "bypassPermissions",
                multiTurn: true,
                route: session.route,
                originChannel: session.originChannel,
                originThreadId: session.originThreadId,
                originAgentId: session.originAgentId,
                originSessionKey: session.originSessionKey,
              });

              this.dispatchSessionNotification(session, {
                label: "worktree-merge-conflict",
                userMessage: `⚠️ [${session.name}] Merge conflicts in ${mergeResult.conflictFiles.length} file(s) — spawned conflict resolver session`,
                buttons: [[this.makeActionButton(session.id, "worktree-create-pr", "Open PR instead")]],
              });
            } catch (err) {
              this.dispatchSessionNotification(session, {
                label: "worktree-merge-conflict-spawn-failed",
                userMessage: `❌ [${session.name}] Merge conflicts detected, but failed to spawn resolver: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          } else {
            const errorMsg = mergeResult.dirtyError
              ? `❌ [${session.name}] Merge blocked: ${mergeResult.error}`
              : `❌ [${session.name}] Merge failed: ${mergeResult.error ?? "unknown error"}`;
            this.dispatchSessionNotification(session, {
              label: "worktree-merge-error",
              userMessage: errorMsg,
            });
          }
        },
        () => {
          // Notify user that this merge is waiting behind another in-progress merge
          this.dispatchSessionNotification(session, {
            label: "worktree-merge-queued",
            userMessage: `🕐 [${session.name}] Merge queued — another merge for this repo is in progress. Will notify when complete.`,
          });
        },
      );
      return { notificationSent: true, worktreeRemoved: false };
    }

    if (strategy === "auto-pr") {
      const { makeAgentPrTool } = await import("./tools/agent-pr");
      if (session.harnessSessionId) {
        this.updatePersistedSession(session.harnessSessionId, {
          lifecycle: "terminal",
          worktreeState: "pr_in_progress",
        });
      }
      const result = await makeAgentPrTool().execute("auto-pr", { session: session.id, base_branch: baseBranch }) as {
        meta?: { success?: boolean };
      };
      if (result?.meta?.success !== true) {
        if (session.harnessSessionId) {
          this.updatePersistedSession(session.harnessSessionId, {
            pendingWorktreeDecisionSince: new Date().toISOString(),
            lifecycle: "awaiting_worktree_decision",
            worktreeState: "pending_decision",
          });
        }
      }
      return { notificationSent: true, worktreeRemoved: false };
    }
    return { notificationSent: false, worktreeRemoved: false };
  }

  private async onSessionTerminal(session: Session): Promise<void> {
    this.persistSession(session);
    this.lastWaitingEventTimestamps.delete(session.id);

    // Handle worktree merge-back strategy BEFORE cleanup
    let worktreeResult: WorktreeStrategyResult = {
      notificationSent: false,
      worktreeRemoved: false,
    };
    if (session.worktreePath && session.originalWorkdir) {
      worktreeResult = await this.handleWorktreeStrategy(session);
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
      const repoDir = this.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
      const branchName = session.worktreeBranch;
      console.info(
        `[SessionManager] Early startup failure for "${session.name}" — auto-cleaning worktree ` +
        `(cost=$${session.costUsd.toFixed(2)}, duration=${session.duration}ms)`
      );

      // Remove worktree directory (replaces the generic removeWorktree call below)
      if (repoDir) {
        removeWorktree(repoDir, session.worktreePath);
      }

      // Delete the branch — no real work was committed, so it's safe to drop
      if (repoDir && branchName) {
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
    // Strategy A: Keep worktree alive until explicitly resolved.
    // Only remove worktree on:
    // 1. Early startup failure (zero cost, very short duration) — already handled above
    // 2. Clean no-change completion — worktree was cleaned up in handleWorktreeStrategy
    // 3. Strategy is "off" or "manual" — no decision needed
    // Otherwise: keep worktree until user resolves (merge/pr/dismiss/cleanup)
    const nonTrivialWorktreeStrategy = session.worktreeStrategy &&
      session.worktreeStrategy !== "off" && session.worktreeStrategy !== "manual";
    if (!worktreeAutoCleaned && session.worktreePath && session.originalWorkdir) {
      const repoDir = this.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
      if (worktreeResult.worktreeRemoved) {
        console.info(
          `[SessionManager] Worktree already removed for "${session.name}" during strategy handling.`,
        );
      } else if (nonTrivialWorktreeStrategy) {
        console.info(
          `[SessionManager] Keeping worktree alive for "${session.name}" (strategy=${session.worktreeStrategy}) — will be cleaned up on explicit resolution.`,
        );
      } else if (repoDir) {
        removeWorktree(repoDir, session.worktreePath);
      }
    }

    // Multi-turn sessions that naturally end after a successful no-input turn
    // use reason "done". The worktree notification (if sent) IS the completion signal;
    // otherwise fall back to a terminal completion wake.
    if (session.killReason === "done") {
      if (worktreeResult.notificationSent) return; // worktree path already notified
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
      this.dispatchSessionNotification(session, {
        label: "suspended",
        userMessage: `💤 [${session.name}] Suspended after idle timeout | ${costStr} | ${duration}`,
        notifyUser: "always",
        buttons: this.interactions.getResumeButtons(session.id, session),
      });
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
    this.notifications.dispatch(session, request);
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
    const telegramText = `✅ [${session.name}] Completed | ${costStr} | ${duration}`;

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

    const failedButtons = this.interactions.getResumeButtons(session.id, session);

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
    const planApprovalMode = isPlanApproval
      ? this.resolvePlanApprovalMode(session)
      : undefined;

    const telegramText = isPlanApproval
      ? (
          planApprovalMode === "ask"
            ? `📋 [${session.name}] Plan ready for approval:\n\n${preview}\n\nChoose Approve, Reject, or Revise below.`
            : `📋 [${session.name}] Plan awaiting approval:\n\n${preview}`
        )
      : `❓ [${session.name}] Question waiting for reply:\n\n${preview}`;

    let eventText: string;
    if (isPlanApproval) {
      const _planApprovalMode = planApprovalMode ?? "delegate";
      const permissionModeLine = `Permission mode: plan → will switch to bypassPermissions on approval`;
      if (_planApprovalMode === "delegate") {
        eventText = [
          `[DELEGATED PLAN APPROVAL] Coding agent session has finished its plan and is requesting approval to implement.`,
          `Name: ${session.name} | ID: ${session.id}`,
          this.originThreadLine(session),
          permissionModeLine,
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
          permissionModeLine,
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
        `${sessionType} is waiting for a genuine user reply.`,
        `Name: ${session.name} | ID: ${session.id}`,
        this.originThreadLine(session),
        ``,
        `Last output:`,
        preview,
        ``,
        `Use agent_respond(session='${session.id}', message='...') to send a reply, or agent_output(session='${session.id}', full: true) to see full context before deciding.`,
      ].join("\n");
    }

    const waitingButtons =
      isPlanApproval && planApprovalMode === "ask"
        ? this.interactions.getPlanApprovalButtons(session.id, session)
        : undefined; // omit standalone Reply buttons; direct replies already work without a callback

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

  private resolvePlanApprovalMode(session: Session | PersistedSessionInfo): PlanApprovalMode {
    return session.planApproval ?? pluginConfig.planApproval ?? "delegate";
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

    // Non-question turns still emit a lightweight turn-complete wake so the
    // orchestrator can evaluate the next step explicitly.
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
    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const telegramText = `⏸️ [${session.name}] Turn completed | ${costStr}`;

    const eventText = [
      `Coding agent session turn ended.`,
      `Name: ${session.name}`,
      `ID: ${session.id}`,
      `Status: ${session.status}`,
      `Lifecycle: ${session.lifecycle}`,
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
    return this.applySessionPatch(ref, patch);
  }

  private applySessionPatch(ref: string, patch: Partial<PersistedSessionInfo>): boolean {
    const existing = this.store.getPersistedSession(ref);
    if (existing) {
      Object.assign(existing, patch);
      this.store.assertPersistedEntry(existing);
    }

    const active = this.findActiveSessionForRef(ref, existing);
    if (active) {
      this.applyPatchToActiveSession(active, patch);
    }

    if (!existing && !active) return false;
    if (existing) this.store.saveIndex();
    return true;
  }

  private findActiveSessionForRef(ref: string, existing?: PersistedSessionInfo): Session | undefined {
    const byResolve = this.resolve(ref);
    if (byResolve) return byResolve;

    for (const session of this.sessions.values()) {
      if (session.harnessSessionId === ref) return session;
      if (existing?.sessionId && session.id === existing.sessionId) return session;
      if (existing?.harnessSessionId && session.harnessSessionId === existing.harnessSessionId) return session;
      if (existing?.name && session.name === existing.name) return session;
    }

    return undefined;
  }

  private applyPatchToActiveSession(session: Session, patch: Partial<PersistedSessionInfo>): void {
    if (typeof (session as Session & { applyControlPatch?: unknown }).applyControlPatch === "function") {
      session.applyControlPatch({
        lifecycle: patch.lifecycle,
        approvalState: patch.approvalState,
        worktreeState: patch.worktreeState,
        runtimeState: patch.runtimeState,
        deliveryState: patch.deliveryState,
        pendingPlanApproval: patch.pendingPlanApproval,
        planApprovalContext: patch.planApprovalContext,
        planDecisionVersion: patch.planDecisionVersion,
        pendingWorktreeDecisionSince: patch.pendingWorktreeDecisionSince,
      });
    } else {
      if (patch.lifecycle !== undefined) session.lifecycle = patch.lifecycle;
      if (patch.approvalState !== undefined) session.approvalState = patch.approvalState;
      if (patch.worktreeState !== undefined) session.worktreeState = patch.worktreeState;
      if (patch.runtimeState !== undefined) session.runtimeState = patch.runtimeState;
      if (patch.deliveryState !== undefined) session.deliveryState = patch.deliveryState;
      if (patch.pendingPlanApproval !== undefined) session.pendingPlanApproval = patch.pendingPlanApproval;
      if (patch.planApprovalContext !== undefined) session.planApprovalContext = patch.planApprovalContext;
      if (patch.planDecisionVersion !== undefined) session.planDecisionVersion = patch.planDecisionVersion;
    }
    if (patch.worktreePath !== undefined) session.worktreePath = patch.worktreePath;
    if (patch.worktreeBranch !== undefined) session.worktreeBranch = patch.worktreeBranch;
    if (patch.worktreePrUrl !== undefined) session.worktreePrUrl = patch.worktreePrUrl;
    if (patch.worktreePrNumber !== undefined) session.worktreePrNumber = patch.worktreePrNumber;
    if (patch.worktreeMerged !== undefined) session.worktreeMerged = patch.worktreeMerged;
    if (patch.worktreeMergedAt !== undefined) session.worktreeMergedAt = patch.worktreeMergedAt;
    if (patch.worktreeDisposition !== undefined) session.worktreeDisposition = patch.worktreeDisposition;
    if (patch.worktreePrTargetRepo !== undefined) session.worktreePrTargetRepo = patch.worktreePrTargetRepo;
    if (patch.worktreePushRemote !== undefined) session.worktreePushRemote = patch.worktreePushRemote;
  }

  /** Return persisted sessions newest-first. */
  listPersistedSessions(): PersistedSessionInfo[] {
    return this.store.listPersistedSessions();
  }

  /** Send periodic reminders for sessions with unresolved pending worktree decisions. */
  private remindStaleDecisions(): void {
    const REMINDER_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3h
    const now = Date.now();

    for (const session of this.store.listPersistedSessions()) {
      // Only sessions with pending decisions that aren't resolved
      if (!session.pendingWorktreeDecisionSince) continue;
      if (session.worktreeMerged || session.worktreePrUrl) continue;

      // Skip if decision is snoozed
      if (session.worktreeDecisionSnoozedUntil) {
        const snoozedUntilMs = new Date(session.worktreeDecisionSnoozedUntil).getTime();
        if (now < snoozedUntilMs) continue;
      }

      const pendingMs = now - new Date(session.pendingWorktreeDecisionSince).getTime();
      if (pendingMs < REMINDER_INTERVAL_MS) continue;

      // Rate-limit: max once per 3h per session
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
    const routingProxy = this.buildRoutingProxy({
      id: session.harnessSessionId,
      harnessSessionId: session.harnessSessionId,
      route: session.route,
    });

    if (session.worktreeStrategy === "delegate") {
      const pendingSince = session.pendingWorktreeDecisionSince
        ? new Date(session.pendingWorktreeDecisionSince).getTime()
        : Date.now();
      const pendingHours = Math.max(0, Math.floor((Date.now() - pendingSince) / (60 * 60 * 1000)));

      this.notifications.dispatch(routingProxy, {
        label: `worktree-stale-reminder-${session.name}`,
        wakeMessage: this.buildDelegateReminderWakeMessage(session, pendingHours),
        notifyUser: "never",
      });
      return;
    }

    this.notifications.dispatch(routingProxy, {
      label: `worktree-stale-reminder-${session.name}`,
      userMessage: text,
      notifyUser: "always",
      buttons: this.getWorktreeDecisionButtons(session.harnessSessionId),
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

    const buttons = this.interactions.getQuestionButtons(session.id, options);

    const userMessage = [
      `❓ [${session.name}] ${firstQuestion.question}`,
    ].join("\n");

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingAskUserQuestions.delete(sessionId);
        reject(new Error(`AskUserQuestion timed out after ${TIMEOUT_MS / 1000}s for session "${session.name}"`));
      }, TIMEOUT_MS);
      timeoutHandle.unref?.();

      this.pendingAskUserQuestions.set(sessionId, {
        resolve,
        reject,
        questions,
        timeoutHandle,
      });

      this.dispatchSessionNotification(session, {
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
    this.runDailyWorktreeMaintenance(now);
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

  private runDailyWorktreeMaintenance(now: number): void {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const RESOLVED_RETENTION_MS = 7 * DAY_MS;
    if (now - this.lastDailyMaintenanceAt < DAY_MS) return;
    this.lastDailyMaintenanceAt = now;

    for (const session of this.store.listPersistedSessions()) {
      if (!this.worktrees.isResolvedWorktreeEligibleForCleanup(session, now, RESOLVED_RETENTION_MS)) continue;

      try {
        const repoDir = this.resolveWorktreeRepoDir(session.workdir, session.worktreePath);
        if (!repoDir) continue;
        removeWorktree(repoDir, session.worktreePath);
        this.updatePersistedSession(session.harnessSessionId, {
          worktreePath: undefined,
          worktreeState: "none",
        });
      } catch (err) {
        console.warn(`[SessionManager] Failed daily cleanup for worktree ${session.worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  dispose(): void {
    for (const pending of this.pendingAskUserQuestions.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error("SessionManager disposed before AskUserQuestion resolved."));
    }
    this.pendingAskUserQuestions.clear();
    this.notifications.dispose();
  }
}
