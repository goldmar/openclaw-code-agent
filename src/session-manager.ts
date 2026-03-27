import { existsSync } from "fs";

import { Session } from "./session";
import { pluginConfig, getDefaultHarnessName } from "./config";
import { generateSessionName, lastCompleteLines } from "./format";
import { formatLaunchSummaryFromSession } from "./launch-summary";
import { pathsReferToSameLocation } from "./path-utils";
import { SessionSemanticAdapter } from "./session-semantic-adapter";
import {
  getBackendConversationId,
  getPrimarySessionLookupRef,
  usesNativeBackendWorktree,
} from "./session-backend-ref";
import { SessionRestoreService } from "./session-restore-service";
import { SessionStateSyncService } from "./session-state-sync-service";
import { SessionReferenceService } from "./session-reference-service";
import { SessionWorktreeStrategyService, type WorktreeStrategyResult } from "./session-worktree-strategy-service";
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
  getStoppedStatusLabel as formatStoppedStatusLabel,
} from "./session-notification-builder";
import {
  removeWorktree,
  deleteBranch,
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
  private readonly stateSync: SessionStateSyncService;
  private readonly references: SessionReferenceService;
  private readonly worktreeStrategy: SessionWorktreeStrategyService;

  constructor(maxSessions: number = 20, maxPersistedSessions: number = 50) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
    this.store = new SessionStore();
    this.metrics = new SessionMetricsRecorder();
    this.wakeDispatcher = new WakeDispatcher();
    this.interactions = new SessionInteractionService(this.store.actionTokenStore, isGitHubCLIAvailable);
    this.references = new SessionReferenceService(this.sessions, this.store);
    this.stateSync = new SessionStateSyncService({
      store: this.store,
      sessions: this.sessions,
      resolveSession: (ref) => this.references.resolveActive(ref),
    });
    this.notifications = new SessionNotificationService(
      this.wakeDispatcher,
      (ref, patch) => this.stateSync.applySessionPatch(ref, patch),
    );
    this.worktrees = new SessionWorktreeController();
    this.semantic = new SessionSemanticAdapter();
    this.restore = new SessionRestoreService((ref) => this.store.getPersistedSession(ref));
    this.worktreeStrategy = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: (session) => this.shouldRunWorktreeStrategy(session),
      isAlreadyMerged: (harnessSessionId) => this.isAlreadyMerged(harnessSessionId),
      resolveWorktreeRepoDir: (repoDir, worktreePath) => this.resolveWorktreeRepoDir(repoDir, worktreePath),
      getWorktreeCompletionState: (repoDir, worktreePath, branchName, baseBranch) => (
        this.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch)
      ),
      classifyNoChangeDeliverable: (context) => this.semantic.classifyNoChangeDeliverable(context),
      updatePersistedSession: (ref, patch) => this.updatePersistedSession(ref, patch),
      dispatchSessionNotification: (session, request) => this.dispatchSessionNotification(session, request),
      getWorktreeDecisionButtons: (sessionId) => this.getWorktreeDecisionButtons(sessionId),
      makeOpenPrButton: (sessionId) => this.makeActionButton(sessionId, "worktree-create-pr", "Open PR"),
      enqueueMerge: (repoDir, fn, onQueued) => this.enqueueMerge(repoDir, fn, onQueued),
      spawnConflictResolver: async (session, repoDir, prompt) => {
        this.spawn({
          prompt,
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
      },
      runAutoPr: async (session, baseBranch) => {
        const { makeAgentPrTool } = await import("./tools/agent-pr");
        const result = await makeAgentPrTool().execute("auto-pr", {
          session: session.id,
          base_branch: baseBranch,
        }) as { meta?: { success?: boolean } };
        return { success: result?.meta?.success === true };
      },
    });
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
      getQuestionButtons: (sessionId, options) => this.interactions.getQuestionButtons(sessionId, options),
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

    // Inject AskUserQuestion intercept for CC sessions. Codex App Server exposes
    // structured pending input natively, so only Claude needs the tool intercept.
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
    sessionId?: string;
    harnessSessionId?: string;
    backendRef?: PersistedSessionInfo["backendRef"];
    route?: PersistedSessionInfo["route"];
  }): Session {
    return {
      id: getPrimarySessionLookupRef(session) ?? getBackendConversationId(session) ?? session.harnessSessionId ?? "unknown-session",
      harnessSessionId: session.harnessSessionId,
      backendRef: session.backendRef ? { ...session.backendRef } : undefined,
      route: session.route,
    } as Session;
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
    const nativeBackendWorktree = !!session && usesNativeBackendWorktree(session);
    if (!nativeBackendWorktree && worktreePath && existsSync(worktreePath)) {
      removeWorktree(repoDir, worktreePath);
    }

    // Delete branch
    if (branchName) {
      deleteBranch(repoDir, branchName);
    }

    // Update persisted state
    const persistedRef = activeSession
      ? getPrimarySessionLookupRef(activeSession)
      : (persistedSession ? getPrimarySessionLookupRef(persistedSession) : undefined);
    if (persistedRef) {
      this.updatePersistedSession(persistedRef, {
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
    const msg = nativeBackendWorktree
      ? `🗑️ [${sessionName}] Branch \`${branchName ?? "unknown"}\` dismissed. Native backend worktree released for backend cleanup.`
      : `🗑️ [${sessionName}] Branch \`${branchName ?? "unknown"}\` dismissed and permanently deleted.`;
    const routingProxy = this.buildRoutingProxy({
      id: getPrimarySessionLookupRef(activeSession ?? persistedSession ?? { id: ref }) ?? ref,
      sessionId: persistedSession?.sessionId,
      harnessSessionId: activeSession?.harnessSessionId ?? persistedSession?.harnessSessionId,
      backendRef: activeSession?.backendRef ?? persistedSession?.backendRef,
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
    this.updatePersistedSession(getPrimarySessionLookupRef(persistedSession) ?? persistedSession.harnessSessionId, {
      worktreeDecisionSnoozedUntil: snoozedUntil,
      lastWorktreeReminderAt: new Date().toISOString(),
    } as Partial<PersistedSessionInfo>);

    const branchName = persistedSession.worktreeBranch ?? "unknown";
    const msg = `⏭️ Reminder snoozed 24h for \`${branchName}\` (session: ${persistedSession.name})`;

    const routingProxy = this.buildRoutingProxy({
      id: getPrimarySessionLookupRef(persistedSession) ?? persistedSession.harnessSessionId,
      sessionId: persistedSession.sessionId,
      harnessSessionId: persistedSession.harnessSessionId,
      backendRef: persistedSession.backendRef,
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
    return this.worktreeStrategy.handleWorktreeStrategy(session);
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
    return this.references.resolveActive(idOrName);
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
    return this.references.resolveBackendConversationId(ref);
  }

  /** Read persisted metadata by harness id, internal id, or name. */
  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.references.getPersistedSession(ref);
  }

  /** Returns true if this session's branch has already been merged (idempotency guard). */
  private isAlreadyMerged(ref: string | undefined): boolean {
    if (!ref) return false;
    return this.store.getPersistedSession(ref)?.worktreeMerged === true;
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
    return this.stateSync.applySessionPatch(ref, patch);
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

  async resolvePendingInputOption(sessionId: string, optionIndex: number): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session && await session.submitPendingInputOption(optionIndex)) {
      return true;
    }
    this.questions.resolveAskUserQuestion(sessionId, optionIndex);
    return true;
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
        if (!usesNativeBackendWorktree(session)) {
          removeWorktree(repoDir, session.worktreePath);
        }
        this.updatePersistedSession(getPrimarySessionLookupRef(session) ?? session.harnessSessionId, {
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
