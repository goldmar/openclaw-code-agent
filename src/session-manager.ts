import { existsSync } from "fs";

import { Session } from "./session";
import { pluginConfig, getDefaultHarnessName } from "./config";
import { generateSessionName, lastCompleteLines } from "./format";
import { formatLaunchSummaryFromSession } from "./launch-summary";
import { pathsReferToSameLocation } from "./path-utils";
import { SessionSemanticAdapter } from "./session-semantic-adapter";
import { SessionRestoreService } from "./session-restore-service";
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
import { SessionQuestionService, type PendingAskUserQuestion } from "./session-question-service";
import { SessionReminderService } from "./session-reminder-service";
import { SessionLifecycleService } from "./session-lifecycle-service";
import {
  buildDelegateWorktreeWakeMessage,
  buildDelegateReminderWakeMessage,
  buildNoChangeDeliverableMessage,
  buildWorktreeDecisionSummary,
  getStoppedStatusLabel as formatStoppedStatusLabel,
} from "./session-notification-builder";
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
  private readonly questions: SessionQuestionService;
  private readonly reminders: SessionReminderService;
  private readonly lifecycle: SessionLifecycleService;
  private readonly restore: SessionRestoreService;

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
    this.restore = new SessionRestoreService((ref) => this.store.getPersistedSession(ref));
    this.questions = new SessionQuestionService(
      this.pendingAskUserQuestions,
      (session, request) => this.dispatchSessionNotification(session, request),
      (sessionId, options) => this.interactions.getQuestionButtons(sessionId, options),
    );
    this.reminders = new SessionReminderService(
      (session) => this.buildRoutingProxy(session),
      (session, request) => this.notifications.dispatch(session, request),
      (ref, patch) => this.updatePersistedSession(ref, patch),
      (sessionId) => this.getWorktreeDecisionButtons(sessionId),
    );
    this.lifecycle = new SessionLifecycleService({
      persistSession: (session) => this.persistSession(session),
      clearWaitingTimestamp: (sessionId) => { this.lastWaitingEventTimestamps.delete(sessionId); },
      handleWorktreeStrategy: (session) => this.handleWorktreeStrategy(session),
      resolveWorktreeRepoDir: (repoDir, worktreePath) => this.resolveWorktreeRepoDir(repoDir, worktreePath),
      updatePersistedSession: (ref, patch) => this.updatePersistedSession(ref, patch),
      dispatchSessionNotification: (session, request) => this.dispatchSessionNotification(session, request),
      notifySession: (session, text, label) => this.notifySession(session, text, label),
      clearRetryTimersForSession: (sessionId) => this.wakeDispatcher.clearRetryTimersForSession(sessionId),
      hasTurnCompleteWakeMarker: (sessionId) => this.lastTurnCompleteMarkers.has(sessionId),
      shouldEmitTurnCompleteWake: (session) => this.shouldEmitTurnCompleteWake(session),
      shouldEmitTerminalWake: (session) => this.shouldEmitTerminalWake(session),
      resolvePlanApprovalMode: (session) => this.resolvePlanApprovalMode(session),
      getPlanApprovalButtons: (sessionId, session) => this.interactions.getPlanApprovalButtons(sessionId, session),
      getResumeButtons: (sessionId, session) => this.interactions.getResumeButtons(sessionId, session),
      extractLastOutputLine: (session) => this.extractLastOutputLine(session),
      getOutputPreview: (session, maxChars) => this.getOutputPreview(session, maxChars),
      originThreadLine: (session) => this.originThreadLine(session),
      debounceWaitingEvent: (sessionId) => this.debounceWaitingEvent(sessionId),
      isAlreadyMerged: (harnessSessionId) => this.isAlreadyMerged(harnessSessionId),
    });
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

    const preparedLaunch = this.restore.prepareSpawn(config, name);

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
      workdir: preparedLaunch.actualWorkdir,
      systemPrompt: preparedLaunch.effectiveSystemPrompt,
      canUseTool,
      turnBoundaryDecision: (context) => this.semantic.classifyTurnBoundary(context),
    }, name);
    sessionIdRef = session.id; // bind late — canUseTool closure captures this ref
    this.restore.hydrateSpawnedSession(session, preparedLaunch, config);
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
    permissionMode: SessionConfig["permissionMode"];
    planApproval: PlanApprovalMode;
    forceNewSession?: boolean;
    resumeSessionId?: string;
    forkSession?: boolean;
    clearedPersistedCodexResume?: boolean;
  }, session: Session): string {
    return formatLaunchSummaryFromSession({
      prompt: config.prompt,
      workdir: config.workdir,
      harness: config.harness,
      permissionMode: config.permissionMode ?? pluginConfig.permissionMode,
      planApproval: config.planApproval,
      resumeSessionId: config.resumeSessionId,
      forkSession: config.forkSession,
      forceNewSession: config.forceNewSession,
      clearedPersistedCodexResume: config.clearedPersistedCodexResume,
    }, session);
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
    return buildDelegateWorktreeWakeMessage(args);
  }

  private buildDelegateReminderWakeMessage(session: PersistedSessionInfo, pendingHours: number): string {
    return buildDelegateReminderWakeMessage(session, pendingHours);
  }

  private buildWorktreeDecisionSummary(diffSummary: {
    changedFiles: string[];
    commitMessages: Array<{ message: string }>;
  }): string[] {
    return buildWorktreeDecisionSummary(diffSummary);
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
    return buildNoChangeDeliverableMessage(session, preview, cleanupSucceeded, worktreePath);
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
    return this.lifecycle.handleSessionTerminal(session);
  }

  private getStoppedStatusLabel(killReason?: KillReason): string {
    return formatStoppedStatusLabel(killReason);
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
    this.lifecycle.emitCompleted(session);
  }

  private triggerFailedEvent(session: Session, errorSummary: string, worktreeAutoCleaned: boolean = false): void {
    this.lifecycle.emitFailed(session, errorSummary, worktreeAutoCleaned);
  }

  private triggerWaitingForInputEvent(session: Session): void {
    this.lifecycle.emitWaitingForInput(session);
  }

  private resolvePlanApprovalMode(session: Session | PersistedSessionInfo): PlanApprovalMode {
    return session.planApproval ?? pluginConfig.planApproval ?? "delegate";
  }

  private onTurnEnd(session: Session, hadQuestion: boolean): void {
    this.lifecycle.handleTurnEnd(session, hadQuestion);
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
    this.lifecycle.emitTurnComplete(session);
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
    this.reminders.remindStaleDecisions(this.store.listPersistedSessions());
  }

  /** Send a notification for a persisted (not active) session using its stored origin channel. */
  private sendReminderNotification(session: PersistedSessionInfo, text: string): void {
    const now = Date.now();
    const pendingSince = session.pendingWorktreeDecisionSince
      ? new Date(session.pendingWorktreeDecisionSince).getTime()
      : now - 4 * 60 * 60 * 1000;
    this.reminders.remindStaleDecisions([{
      ...session,
      pendingWorktreeDecisionSince: new Date(pendingSince).toISOString(),
      lastWorktreeReminderAt: undefined,
    }], now);
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
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found for AskUserQuestion intercept`);
    }
    return this.questions.handleAskUserQuestion(session, input);
  }

  /**
   * Resolve a pending AskUserQuestion by option index (from button callback).
   */
  resolveAskUserQuestion(sessionId: string, optionIndex: number): void {
    this.questions.resolveAskUserQuestion(sessionId, optionIndex);
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
    this.questions.dispose();
    this.notifications.dispose();
  }
}
