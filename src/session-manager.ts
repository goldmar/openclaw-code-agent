import { Session } from "./session";
import { pluginConfig, getDefaultHarnessName } from "./config";
import { generateSessionName, firstCompleteLines, lastCompleteLines } from "./format";
import { formatLaunchSummaryFromSession } from "./launch-summary";
import { pathsReferToSameLocation } from "./path-utils";
import {
  getBackendConversationId,
  getPersistedMutationRefs,
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
  SessionRoute,
  GoalTaskState,
} from "./types";
import { SessionStore } from "./session-store";
import type { SessionStoreOptions } from "./session-store";
import { SessionMetricsRecorder } from "./session-metrics";
import { WakeDispatcher, type SessionNotificationRequest } from "./wake-dispatcher";
import { SessionInteractionService, type NotificationButton } from "./session-interactions";
import { SessionNotificationService } from "./session-notifications";
import { SessionWorktreeController } from "./session-worktree-controller";
import { SessionQuestionService, type PendingAskUserQuestion } from "./session-question-service";
import { SessionReminderService } from "./session-reminder-service";
import { SessionLifecycleService } from "./session-lifecycle-service";
import { buildPlanApprovalFallbackText, formatPlanApprovalSummary } from "./session-notification-builder";
import { SessionWorktreeDecisionService } from "./session-worktree-decision-service";
import { SessionRuntimeRegistry } from "./session-runtime-registry";
import { SessionRuntimeBootstrapService } from "./session-runtime-bootstrap-service";
import { SessionWorktreeMessageService } from "./session-worktree-message-service";
import { resolveWorktreeLifecycle } from "./worktree-lifecycle-resolver";
import {
  getStoppedStatusLabel as formatStoppedStatusLabel,
} from "./session-notification-builder";
import {
  getPrimaryRepoRootFromWorktree,
  isGitHubCLIAvailable,
  removeWorktree,
} from "./worktree";
import { KeyedDeadlineScheduler } from "./keyed-deadline-scheduler";
import { unlinkSync } from "fs";


const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const KILLABLE_STATUSES = new Set<SessionStatus>(["starting", "running"]);
const WAITING_EVENT_DEBOUNCE_MS = 5_000;
const RESOLVED_WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WORKTREE_REMINDER_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const TMP_OUTPUT_CLEANUP_KEY = "tmp-output:cleanup";


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
  private readonly registry: SessionRuntimeRegistry;
  private sessions: Map<string, Session>;
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
  private readonly interactions: SessionInteractionService;
  private readonly notifications: SessionNotificationService;
  private readonly worktrees: SessionWorktreeController;
  private readonly questions: SessionQuestionService;
  private readonly reminders: SessionReminderService;
  private readonly lifecycle: SessionLifecycleService;
  private readonly restore: SessionRestoreService;
  private readonly stateSync: SessionStateSyncService;
  private readonly references: SessionReferenceService;
  private readonly worktreeStrategy: SessionWorktreeStrategyService;
  private readonly worktreeDecisions: SessionWorktreeDecisionService;
  private readonly runtimeBootstrap: SessionRuntimeBootstrapService;
  private readonly worktreeMessages: SessionWorktreeMessageService;
  private readonly maintenance = new KeyedDeadlineScheduler();

  constructor(
    maxSessions: number = 20,
    maxPersistedSessions: number = 50,
    options: { store?: SessionStoreOptions } = {},
  ) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
    this.registry = new SessionRuntimeRegistry();
    this.sessions = this.registry.sessions;
    this.store = new SessionStore(options.store);
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
    this.store.onActionTokensChanged(() => this.syncActionTokenExpiryDeadline());
    this.worktrees = new SessionWorktreeController();
    this.restore = new SessionRestoreService((ref) => this.store.getPersistedSession(ref));
    this.worktreeMessages = new SessionWorktreeMessageService();
    this.worktreeStrategy = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: (session) => this.shouldRunWorktreeStrategy(session),
      isAlreadyMerged: (ref) => this.isAlreadyMerged(ref),
      resolveWorktreeRepoDir: (repoDir, worktreePath) => this.resolveWorktreeRepoDir(repoDir, worktreePath),
      getWorktreeCompletionState: (repoDir, worktreePath, branchName, baseBranch) => (
        this.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch)
      ),
      updatePersistedSession: (ref, patch) => this.updatePersistedSession(ref, patch),
      dispatchSessionNotification: (session, request) => this.dispatchSessionNotification(session, request),
      getOutputPreview: (session, maxChars) => this.getOutputPreview(session, maxChars),
      originThreadLine: (session) => this.originThreadLine(session),
      getWorktreeDecisionButtons: (sessionId) => this.getWorktreeDecisionButtons(sessionId),
      makeOpenPrButton: (sessionId) => this.makeActionButton(sessionId, "worktree-create-pr", "Open PR"),
      worktreeMessages: this.worktreeMessages,
      enqueueMerge: (repoDir, fn, onQueued) => this.enqueueMerge(repoDir, fn, onQueued),
      spawnConflictResolver: async ({ session, worktreePath, prompt }) => {
        return this.spawn({
          prompt,
          workdir: worktreePath,
          name: `${session.name}-conflict-resolver`,
          harness: session.harnessName || getDefaultHarnessName(),
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          permissionMode: "bypassPermissions",
          multiTurn: true,
          worktreeStrategy: "off",
          autoMergeParentSessionId: session.id,
          route: session.route,
          originChannel: session.originChannel,
          originThreadId: session.originThreadId,
          originAgentId: session.originAgentId,
          originSessionKey: session.originSessionKey,
        }, { notifyLaunch: false });
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
      (sessionId) => { this.lastWaitingEventTimestamps.delete(sessionId); },
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
      isAlreadyMerged: (ref) => this.isAlreadyMerged(ref),
    });
    this.worktreeDecisions = new SessionWorktreeDecisionService({
      getPersistedSession: (ref) => this.store.getPersistedSession(ref),
      resolveActiveSession: (ref) => this.references.resolveActive(ref),
      resolveWorktreeRepoDir: (repoDir, worktreePath) => this.resolveWorktreeRepoDir(repoDir, worktreePath),
      updatePersistedSession: (ref, patch) => this.updatePersistedSession(ref, patch),
      dispatchNotification: (session, request) => this.notifications.dispatch(session, request),
      buildRoutingProxy: (session) => this.buildRoutingProxy(session),
    });
    this.runtimeBootstrap = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: (session, preparedLaunch, config) => {
        this.restore.hydrateSpawnedSession(session, preparedLaunch, config);
      },
      markRunning: (session) => {
        this.store.markRunning(session);
        this.onPersistedSessionChanged(this.store.getPersistedSession(session.id));
      },
      handleTerminal: async (session) => this.onSessionTerminal(session),
      handleTurnEnd: (session, hadQuestion) => this.onTurnEnd(session, hadQuestion),
      formatLaunchWorkdirLabel: (session) => this.formatLaunchWorkdirLabel(session),
      notifySession: (session, text, label) => this.notifySession(session, text, label),
    });
  }

  // Back-compat for tests and internal inspection.
  get persisted(): Map<string, PersistedSessionInfo> { return this.store.persisted; }
  get idIndex(): Map<string, string> { return this.store.idIndex; }
  get nameIndex(): Map<string, string> { return this.store.nameIndex; }

  private uniqueName(baseName: string): string {
    return this.registry.uniqueName(baseName);
  }

  private persistedMaintenanceRef(
    session: Pick<PersistedSessionInfo, "sessionId" | "harnessSessionId" | "backendRef">,
  ): string | undefined {
    return session.sessionId ?? getBackendConversationId(session) ?? session.harnessSessionId;
  }

  private runtimeGcKey(sessionId: string): string {
    return `runtime-gc:${sessionId}`;
  }

  private persistedMaintenanceKey(ref: string, kind: "worktree-reminder" | "worktree-retention"): string {
    return `persisted:${ref}:${kind}`;
  }

  private runtimeGcMaxAgeMs(): number {
    return (pluginConfig.sessionGcAgeMinutes ?? 1440) * 60_000;
  }

  private syncRuntimeGcDeadline(session: Pick<Session, "id" | "completedAt">): void {
    if (!session.completedAt) return;
    const key = this.runtimeGcKey(session.id);
    this.maintenance.schedule(key, session.completedAt + this.runtimeGcMaxAgeMs(), () => {
      const active = this.sessions.get(session.id);
      if (!active || !active.completedAt) return;
      const cleanupMaxAgeMs = this.runtimeGcMaxAgeMs();
      if (!this.store.shouldGcActiveSession(active, Date.now(), cleanupMaxAgeMs)) {
        this.syncRuntimeGcDeadline(active);
        return;
      }
      this.registry.remove(session.id);
      this.persistSession(active, { scheduleRuntimeGc: false });
      this.lastWaitingEventTimestamps.delete(session.id);
      this.lastTurnCompleteMarkers.delete(session.id);
      this.lastTerminalWakeMarkers.delete(session.id);
    });
  }

  private cancelPersistedMaintenance(session: Pick<PersistedSessionInfo, "sessionId" | "harnessSessionId" | "backendRef">): void {
    const ref = this.persistedMaintenanceRef(session);
    if (!ref) return;
    this.maintenance.cancelPrefix(`persisted:${ref}:`);
  }

  private onPersistedSessionChanged(session?: PersistedSessionInfo): void {
    if (!session) return;
    this.syncPersistedSessionMaintenance(session);
    this.enforcePersistedRetention();
  }

  private isLegacyResolvedWorktree(session: Pick<
    PersistedSessionInfo,
    "worktreeMerged" | "worktreeDisposition" | "worktreeState"
  >): boolean {
    return session.worktreeMerged === true
      || session.worktreeDisposition === "dismissed"
      || session.worktreeDisposition === "no-change-cleaned"
      || session.worktreeState === "merged"
      || session.worktreeState === "dismissed";
  }

  private syncPersistedSessionMaintenance(session: PersistedSessionInfo): void {
    const ref = this.persistedMaintenanceRef(session);
    if (!ref) return;

    this.maintenance.cancel(this.persistedMaintenanceKey(ref, "worktree-reminder"));
    const nextReminderAt = this.reminders.getNextReminderAt(session);
    if (nextReminderAt != null) {
      this.schedulePersistedWorktreeReminder(ref, nextReminderAt);
    }

    this.maintenance.cancel(this.persistedMaintenanceKey(ref, "worktree-retention"));
    const resolved = resolveWorktreeLifecycle(session, {
      activeSession: false,
      includePrSync: session.worktreeLifecycle?.state === "pr_open" || Boolean(session.worktreePrUrl),
    });
    const resolvedAtIso = session.worktreeLifecycle?.resolvedAt
      ?? session.worktreeMergedAt
      ?? session.worktreeDismissedAt
      ?? (session.completedAt ? new Date(session.completedAt).toISOString() : undefined);
    const legacyResolved = this.isLegacyResolvedWorktree(session);
    if ((resolved.cleanupSafe || legacyResolved) && typeof resolvedAtIso === "string") {
      const resolvedAt = new Date(resolvedAtIso).getTime();
      if (Number.isFinite(resolvedAt)) {
        this.maintenance.schedule(this.persistedMaintenanceKey(ref, "worktree-retention"), resolvedAt + RESOLVED_WORKTREE_RETENTION_MS, () => {
          const latest = this.store.getPersistedSession(ref);
          if (!latest) return;
          this.reconcileResolvedWorktreeRetention(latest, Date.now());
        });
      }
    }
  }

  private schedulePersistedWorktreeReminder(ref: string, at: number): void {
    const key = this.persistedMaintenanceKey(ref, "worktree-reminder");
    this.maintenance.schedule(key, at, () => {
      const latest = this.store.getPersistedSession(ref);
      if (!latest) return;
      const delivered = this.reminders.sendReminderIfDue(latest, Date.now());
      if (delivered) return;

      const nextReminderAt = this.reminders.getNextReminderAt(latest);
      if (nextReminderAt == null) return;
      this.schedulePersistedWorktreeReminder(ref, Math.max(nextReminderAt, Date.now() + WORKTREE_REMINDER_RETRY_BACKOFF_MS));
    });
  }

  private reconcileResolvedWorktreeRetention(session: PersistedSessionInfo, now: number): void {
    const resolved = resolveWorktreeLifecycle(session, {
      activeSession: false,
      includePrSync: session.worktreeLifecycle?.state === "pr_open" || Boolean(session.worktreePrUrl),
    });
    const resolvedAtIso = session.worktreeLifecycle?.resolvedAt
      ?? session.worktreeMergedAt
      ?? session.worktreeDismissedAt
      ?? (session.completedAt ? new Date(session.completedAt).toISOString() : undefined);
    const resolvedAt = resolvedAtIso ? new Date(resolvedAtIso).getTime() : 0;
    const legacyResolved = this.isLegacyResolvedWorktree(session);
    if ((!resolved.cleanupSafe && !legacyResolved) || !resolvedAt || now - resolvedAt < RESOLVED_WORKTREE_RETENTION_MS) return;

    try {
      if (!session.worktreePath && !usesNativeBackendWorktree(session)) return;
      const repoDir = this.resolveWorktreeRepoDir(session.workdir, session.worktreePath);
      if (!repoDir) return;
      const removed = usesNativeBackendWorktree(session)
        ? false
        : removeWorktree(repoDir, session.worktreePath!);
      if (!usesNativeBackendWorktree(session) && !removed) return;
      for (const mutationRef of getPersistedMutationRefs(session)) {
        this.updatePersistedSession(mutationRef, {
          worktreePath: undefined,
          worktreeBranch: undefined,
          worktreeState: "none",
          worktreeLifecycle: {
            ...(session.worktreeLifecycle ?? resolved.lifecycle),
            state: resolved.derivedState,
            updatedAt: new Date(now).toISOString(),
            resolvedAt: session.worktreeLifecycle?.resolvedAt ?? new Date(now).toISOString(),
            resolutionSource: session.worktreeLifecycle?.resolutionSource ?? "maintenance",
            notes: resolved.reasons,
          },
        });
      }
    } catch (err) {
      console.warn(`[SessionManager] Failed maintenance cleanup for worktree ${session.worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private syncActionTokenExpiryDeadline(): void {
    const key = "tokens:expiry";
    this.maintenance.cancel(key);
    const nextExpiryAt = this.store.getNextActionTokenExpiry();
    if (nextExpiryAt == null) return;
    this.maintenance.schedule(key, nextExpiryAt, () => {
      this.store.purgeExpiredActionTokens(Date.now());
    });
  }

  private syncTmpOutputCleanupDeadline(now: number = Date.now()): void {
    this.maintenance.cancel(TMP_OUTPUT_CLEANUP_KEY);
    const nextCleanupAt = this.store.getNextTmpOutputCleanupAt(now);
    if (nextCleanupAt == null) return;
    this.maintenance.schedule(TMP_OUTPUT_CLEANUP_KEY, nextCleanupAt, () => {
      const cleanupNow = Date.now();
      this.store.cleanupTmpOutputFiles(cleanupNow);
      this.syncTmpOutputCleanupDeadline(cleanupNow);
    });
  }

  private cleanupOutputPathIfUnreferenced(outputPath: string | undefined): void {
    if (!outputPath || this.store.hasOutputPathReference(outputPath)) return;
    try {
      unlinkSync(outputPath);
    } catch {
      // best-effort
    }
  }

  private enforcePersistedRetention(): void {
    const evicted = this.store.evictOldestPersisted(this.maxPersistedSessions);
    for (const session of evicted) {
      this.cancelPersistedMaintenance(session);
      if (session.sessionId) {
        this.maintenance.cancel(this.runtimeGcKey(session.sessionId));
      }
      this.cleanupOutputPathIfUnreferenced(session.outputPath);
    }
  }

  bootstrapMaintenanceSchedules(): void {
    const now = Date.now();
    this.store.cleanupTmpOutputFiles(now);
    for (const session of this.store.listPersistedSessions()) {
      this.syncPersistedSessionMaintenance(session);
    }
    this.syncActionTokenExpiryDeadline();
    this.store.cleanupOrphanOutputFiles();
    this.syncTmpOutputCleanupDeadline(now);
  }

  private disposeMaintenance(): void {
    this.maintenance.dispose();
  }

  /** Spawn and start a new session, wiring lifecycle listeners and launch notification. */
  spawn(config: SessionConfig, options: SpawnOptions = {}): Session {
    const activeCount = this.registry.activeSessionCount();
    if (activeCount >= this.maxSessions) {
      throw new Error(`Max sessions reached (${this.maxSessions}). Use agent_sessions to list active sessions and agent_kill to end one.`);
    }

    if (config.sessionIdOverride) {
      const existing = this.registry.get(config.sessionIdOverride);
      if (existing?.status === "starting" || existing?.status === "running") {
        throw new Error(`Cannot reuse session ID ${config.sessionIdOverride}: that session is still ${existing.status}.`);
      }
      if (existing) {
        this.registry.remove(existing.id);
      }
      this.lastWaitingEventTimestamps.delete(config.sessionIdOverride);
      this.lastTurnCompleteMarkers.delete(config.sessionIdOverride);
      this.lastTerminalWakeMarkers.delete(config.sessionIdOverride);
      this.maintenance.cancel(this.runtimeGcKey(config.sessionIdOverride));
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
    this.registry.add(session);
    this.metrics.incrementLaunched();
    return this.runtimeBootstrap.initializeSession(session, preparedLaunch, config, options);
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

  getActionToken(tokenId: string): SessionActionToken | undefined {
    return this.interactions.getActionToken(tokenId);
  }

  clearPlanDecisionTokens(sessionId: string, keepVersion?: number): void {
    this.interactions.clearPlanDecisionTokens(sessionId, keepVersion);
  }

  private hasProvablePlanReviewPrompt(
    session: Pick<PersistedSessionInfo, "approvalPromptRequiredVersion" | "approvalPromptStatus"> | Pick<Session, "approvalPromptRequiredVersion" | "approvalPromptStatus">,
    planDecisionVersion?: number,
  ): boolean {
    return planDecisionVersion != null
      && session.approvalPromptRequiredVersion === planDecisionVersion
      && (session.approvalPromptStatus === "delivered" || session.approvalPromptStatus === "fallback_delivered");
  }

  private buildPlanApprovalWakeText(
    session: Pick<Session, "id" | "name">,
    planDecisionVersion: number | undefined,
    explicitFallback: boolean = false,
  ): string {
    return [
      explicitFallback
        ? `Plan review fallback text delivered to the user because interactive buttons could not be delivered.`
        : `Plan approval buttons delivered to the user.`,
      `Session: ${session.name} | ID: ${session.id} | Plan v${planDecisionVersion ?? "?"}`,
      `Wait for their ${explicitFallback ? "explicit reply" : "button callback"} — do NOT approve or reject this plan yourself.`,
    ].join("\n");
  }

  private buildPlanApprovalDeliveryFailureWake(
    session: Pick<Session, "id" | "name" | "originThreadId">,
    planDecisionVersion: number | undefined,
  ): string {
    return [
      `[PLAN APPROVAL DELIVERY FAILED] The plugin could not deliver the canonical plan review buttons or the explicit fallback text to the user.`,
      `Name: ${session.name} | ID: ${session.id} | Plan v${planDecisionVersion ?? "?"}`,
      session.originThreadId != null ? `Origin thread: ${session.originThreadId}` : "",
      ``,
      `No user-visible actionable review prompt is confirmed for this plan version.`,
      `Intervene manually before assuming the user saw the plan review request.`,
    ].filter(Boolean).join("\n");
  }

  private dispatchPlanApprovalFallback(
    session: Session,
    planDecisionVersion: number | undefined,
    summary: string,
  ): void {
    const attemptedAt = new Date().toISOString();
    this.notifications.dispatch(session, {
      label: "plan-approval-fallback",
      userMessage: buildPlanApprovalFallbackText({ session, summary }),
      notifyUser: "always",
      hooks: {
        onNotifyStarted: () => {
          this.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "sending",
            approvalPromptTransport: "direct-telegram",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: attemptedAt,
          });
        },
        onNotifySucceeded: () => {
          this.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "fallback_delivered",
            approvalPromptTransport: "direct-telegram",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: attemptedAt,
            approvalPromptDeliveredAt: new Date().toISOString(),
            approvalPromptFailedAt: undefined,
          });
        },
        onNotifyFailed: () => {
          this.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "failed",
            approvalPromptTransport: "direct-telegram",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: attemptedAt,
            approvalPromptFailedAt: new Date().toISOString(),
          });
        },
      },
      wakeMessageOnNotifySuccess: this.buildPlanApprovalWakeText(session, planDecisionVersion, true),
      wakeMessageOnNotifyFailed: this.buildPlanApprovalDeliveryFailureWake(session, planDecisionVersion),
    });
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

  requestPlanApprovalFromUser(ref: string, summary: string): string {
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) return "Error: summary must not be empty.";
    const formattedSummary = formatPlanApprovalSummary(trimmedSummary);

    const activeSession = this.resolve(ref);
    const persistedSession = activeSession ? undefined : this.getPersistedSession(ref);
    const session = activeSession ?? persistedSession;
    if (!session) return `Error: Session "${ref}" not found.`;
    if (!session.pendingPlanApproval) {
      return `Error: Session "${ref}" is not awaiting plan approval.`;
    }
    const sessionId = getPrimarySessionLookupRef(activeSession ?? persistedSession ?? { id: ref }) ?? ref;
    if (this.resolvePlanApprovalMode(session) !== "delegate") {
      return `Error: Session "${ref}" already uses direct user plan approval. Do not send a duplicate approval prompt.`;
    }
    const actionableVersion = session.actionablePlanDecisionVersion ?? session.planDecisionVersion;
    if (this.hasProvablePlanReviewPrompt(session, actionableVersion)) {
      return [
        `An actionable plan review prompt already exists for session ${session.name} [${sessionId}].`,
        `Wait for the user's Approve, Revise, or Reject response.`,
        `Do not send a separate plain-text approval message.`,
      ].join(" ");
    }
    if (session.deliveryState === "notifying") {
      return [
        `A plan approval prompt is already being delivered for session ${session.name} [${sessionId}].`,
        `Wait for delivery to finish before retrying.`,
      ].join(" ");
    }

    const buttons = this.interactions.getPlanApprovalButtons(sessionId, {
      ...session,
      planDecisionVersion: actionableVersion,
    });
    const message = [
      `📋 [${session.name}] Plan v${actionableVersion ?? "?"} needs your decision:`,
      ``,
      `Why this was escalated:`,
      ``,
      formattedSummary,
      ``,
      `Choose Approve, Revise, or Reject below.`,
    ].join("\n");

    this.notifications.dispatch(
      this.buildRoutingProxy({
        id: sessionId,
        name: session.name,
        sessionId: persistedSession?.sessionId,
        harnessSessionId: activeSession?.harnessSessionId ?? persistedSession?.harnessSessionId,
        backendRef: activeSession?.backendRef ?? persistedSession?.backendRef,
        route: activeSession?.route ?? persistedSession?.route,
      }),
      {
        label: "plan-approval",
        userMessage: message,
        notifyUser: "always",
        buttons,
        hooks: {
          onNotifyStarted: () => {
            this.updatePersistedSession(sessionId, {
              approvalPromptRequiredVersion: actionableVersion,
              approvalPromptStatus: "sending",
              approvalPromptVersion: actionableVersion,
              approvalPromptTransport: "direct-telegram",
              approvalPromptMessageKind: "canonical_buttons",
              approvalPromptLastAttemptAt: new Date().toISOString(),
            });
          },
          onNotifySucceeded: () => {
            this.updatePersistedSession(sessionId, {
              canonicalPlanPromptVersion: actionableVersion,
              approvalPromptRequiredVersion: actionableVersion,
              approvalPromptVersion: actionableVersion,
              approvalPromptStatus: "delivered",
              approvalPromptTransport: "direct-telegram",
              approvalPromptMessageKind: "canonical_buttons",
              approvalPromptDeliveredAt: new Date().toISOString(),
              approvalPromptFailedAt: undefined,
            });
          },
          onNotifyFailed: () => {
            this.updatePersistedSession(sessionId, {
              approvalPromptRequiredVersion: actionableVersion,
              approvalPromptVersion: actionableVersion,
              approvalPromptStatus: "failed",
              approvalPromptTransport: "direct-telegram",
              approvalPromptMessageKind: "canonical_buttons",
              approvalPromptFailedAt: new Date().toISOString(),
            });
          },
        },
        onUserNotifyFailed: () => this.dispatchPlanApprovalFallback(
          this.buildRoutingProxy({
            id: sessionId,
            name: session.name,
            sessionId: persistedSession?.sessionId,
            harnessSessionId: activeSession?.harnessSessionId ?? persistedSession?.harnessSessionId,
            backendRef: activeSession?.backendRef ?? persistedSession?.backendRef,
            route: activeSession?.route ?? persistedSession?.route,
          }),
          actionableVersion,
          formattedSummary,
        ),
        wakeMessageOnNotifySuccess: this.buildPlanApprovalWakeText({ id: sessionId, name: session.name } as Session, actionableVersion),
      },
    );

    return [
      `Canonical plan approval prompt sent for session ${session.name} [${sessionId}].`,
      `Wait for the user's Approve, Revise, or Reject response.`,
      `Do not send a separate plain-text approval message.`,
    ].join(" ");
  }

  private buildRoutingProxy(session: {
    id?: string;
    name?: string;
    sessionId?: string;
    harnessSessionId?: string;
    backendRef?: PersistedSessionInfo["backendRef"];
    route?: PersistedSessionInfo["route"];
  }): Session {
    return {
      id: getPrimarySessionLookupRef(session) ?? getBackendConversationId(session) ?? session.harnessSessionId ?? "unknown-session",
      name: session.name,
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
    return this.worktreeDecisions.dismissWorktree(ref);
  }

  snoozeWorktreeDecision(ref: string): string {
    return this.worktreeDecisions.snoozeWorktreeDecision(ref);
  }

  /**
   * Handle worktree merge-back strategy when a session with a worktree terminates.
   * Called from onSessionTerminal BEFORE worktree cleanup.
   */
  private async handleWorktreeStrategy(session: Session): Promise<WorktreeStrategyResult> {
    return this.worktreeStrategy.handleWorktreeStrategy(session);
  }

  private async onSessionTerminal(session: Session): Promise<void> {
    if (session.autoMergeParentSessionId) {
      await this.handleAutoMergeResolverTerminal(session);
      return;
    }
    return this.lifecycle.handleSessionTerminal(session);
  }

  private async handleAutoMergeResolverTerminal(session: Session): Promise<void> {
    this.persistSession(session);
    this.lastWaitingEventTimestamps.delete(session.id);
    this.wakeDispatcher.clearRetryTimersForSession(session.id);

    const parentRef = session.autoMergeParentSessionId;
    if (!parentRef) return;

    const parentSession = this.resolve(parentRef);
    const parentPersisted = this.getPersistedSession(parentRef);
    const parentRoutingTarget = parentSession ?? (parentPersisted
      ? this.buildRoutingProxy({
          id: parentPersisted.sessionId,
          name: parentPersisted.name,
          sessionId: parentPersisted.sessionId,
          harnessSessionId: parentPersisted.harnessSessionId,
          backendRef: parentPersisted.backendRef,
          route: parentPersisted.route,
        })
      : undefined);

    if (!parentRoutingTarget) {
      console.warn(
        `[SessionManager] Auto-merge resolver ${session.id} completed, but original session ${parentRef} could not be found.`,
      );
      return;
    }

    if (session.status === "completed" && parentSession) {
      this.updatePersistedSession(parentRef, {
        autoMergeResolverSessionId: undefined,
      });
      await this.handleWorktreeStrategy(parentSession);
      return;
    }

    const worktreeBranch = parentSession?.worktreeBranch ?? parentPersisted?.worktreeBranch ?? "unknown";
    const worktreePath = parentSession?.worktreePath ?? parentPersisted?.worktreePath ?? "(unknown worktree)";
    const worktreeBaseBranch = parentSession?.worktreeBaseBranch ?? parentPersisted?.worktreeBaseBranch;
    const worktreePrTargetRepo = parentSession?.worktreePrTargetRepo ?? parentPersisted?.worktreePrTargetRepo;
    const worktreePushRemote = parentSession?.worktreePushRemote ?? parentPersisted?.worktreePushRemote;

    this.updatePersistedSession(parentRef, {
      autoMergeResolverSessionId: undefined,
      pendingWorktreeDecisionSince: new Date().toISOString(),
      lastWorktreeReminderAt: undefined,
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
      worktreeLifecycle: {
        state: "pending_decision",
        updatedAt: new Date().toISOString(),
        baseBranch: worktreeBaseBranch,
        targetRepo: worktreePrTargetRepo,
        pushRemote: worktreePushRemote,
        notes: [
          session.status === "completed"
            ? "auto_merge_conflict_resolver_completed_without_retry_target"
            : "auto_merge_conflict_resolver_failed",
        ],
      },
    });

    this.dispatchSessionNotification(parentRoutingTarget, {
      label: "worktree-merge-conflict-resolver-failed",
      userMessage: [
        `⚠️ [${parentRoutingTarget.name}] Auto-merge conflict resolution did not complete successfully.`,
        `Branch \`${worktreeBranch}\` was preserved for manual follow-up in ${worktreePath}.`,
        session.status === "completed"
          ? `The resolver finished, but the original session could not be resumed for the merge retry.`
          : `Resolver session ${session.name} ended with status=${session.status}.`,
      ].join("\n"),
      buttons: [[this.makeActionButton(parentRef, "worktree-create-pr", "Open PR")]],
    });
  }

  private getStoppedStatusLabel(killReason?: KillReason): string {
    return formatStoppedStatusLabel(killReason);
  }

  private persistSession(session: Session, options: { scheduleRuntimeGc?: boolean } = {}): void {
    const scheduleRuntimeGc = options.scheduleRuntimeGc ?? true;
    // Record metrics once
    const alreadyPersisted = this.store.hasRecordedSession(session.id);
    if (!alreadyPersisted) {
      this.metrics.recordSession(session);
    }

    this.store.persistTerminal(session);
    if (scheduleRuntimeGc) {
      this.syncRuntimeGcDeadline(session);
    }
    this.onPersistedSessionChanged(this.store.getPersistedSession(session.id));
    this.syncTmpOutputCleanupDeadline();
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

  sendMonitorReport(args: {
    reportId: string;
    route: SessionRoute;
    text: string;
    planName: string;
    planPrompt: string;
    planWorkdir: string;
  }): void {
    const buttons = this.interactions.getMonitorReportButtons({
      reportId: args.reportId,
      route: args.route,
      planName: args.planName,
      planPrompt: args.planPrompt,
      planWorkdir: args.planWorkdir,
    });
    this.dispatchSessionNotification(this.buildRoutingProxy({
      id: args.reportId,
      route: args.route,
    }), {
      label: "monitor-report",
      userMessage: args.text,
      notifyUser: "always",
      buttons,
    });
  }

  emitGoalTaskUpdate(
    task: Pick<GoalTaskState, "id" | "sessionId" | "route" | "originChannel" | "originThreadId" | "originSessionKey">,
    text: string,
    label: string = "goal-task",
  ): void {
    const routingProxy = this.buildRoutingProxy({
      id: task.sessionId ?? task.id,
      route: task.route,
    }) as Session & {
      originChannel?: string;
      originThreadId?: string | number;
      originSessionKey?: string;
    };
    routingProxy.originChannel = task.originChannel;
    routingProxy.originThreadId = task.originThreadId;
    routingProxy.originSessionKey = task.originSessionKey;
    this.dispatchSessionNotification(routingProxy, {
      label,
      userMessage: text,
      notifyUser: "always",
    });
  }

  launchMonitorPlan(args: {
    route?: SessionRoute;
    prompt: string;
    workdir: string;
    name?: string;
  }): Session {
    const route = args.route ?? { provider: "system", target: "system" };
    return this.spawn({
      prompt: args.prompt,
      workdir: args.workdir,
      name: args.name,
      harness: getDefaultHarnessName(),
      permissionMode: "plan",
      planApproval: "ask",
      worktreeStrategy: "off",
      multiTurn: true,
      route,
      originChannel: this.originChannelFromRoute(route),
      originThreadId: route.threadId,
      originSessionKey: route.sessionKey,
    });
  }

  private dispatchSessionNotification(session: Session, request: SessionNotificationRequest): void {
    this.notifications.dispatch(session, request);
  }

  private originChannelFromRoute(route: SessionRoute): string {
    if (route.accountId) return `${route.provider}|${route.accountId}|${route.target}`;
    return `${route.provider}|${route.target}`;
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
    const useFullOutput = !Number.isFinite(maxChars);
    const outputLines = typeof (session as Partial<Session>).getOutput === "function"
      ? session.getOutput()
      : [];
    const raw = useFullOutput
      ? outputLines.join("\n")
      : this.selectCompletionPreviewSource(session);
    if (useFullOutput) return raw;
    return raw.length > maxChars
      ? this.shouldPreferTailPreview(session)
        ? lastCompleteLines(raw, maxChars)
        : firstCompleteLines(raw, maxChars)
      : raw;
  }

  private selectCompletionPreviewSource(session: Session): string {
    const outputLines = typeof (session as Partial<Session>).getOutput === "function"
      ? session.getOutput()
      : [];
    const fullOutput = outputLines.join("\n").trim();
    if (!fullOutput) return "";
    if (!this.shouldPreferTailPreview(session)) {
      return outputLines.slice(-20).join("\n");
    }

    const lastBlock = this.extractLastSubstantiveBlock(fullOutput);
    return lastBlock ?? fullOutput;
  }

  private shouldPreferTailPreview(session: Session): boolean {
    if (session.status === "completed" || session.killReason === "done") return true;
    const control = session as unknown as {
      approvalState?: string;
      planDecisionVersion?: number;
      planModeApproved?: boolean;
      pendingPlanApproval?: boolean;
    };
    return control.approvalState === "approved"
      || control.planModeApproved === true
      || (control.planDecisionVersion ?? 0) > 0;
  }

  private extractLastSubstantiveBlock(text: string): string | undefined {
    const blocks = text
      .split(/\n\s*\n+/)
      .map((block) => block.trim())
      .filter((block) => /[A-Za-z0-9]/.test(block));
    const lastBlock = blocks.at(-1);
    if (!lastBlock) return undefined;
    return lastBlock.length >= 120 || lastBlock.includes("\n")
      ? lastBlock
      : undefined;
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
    return this.registry.get(id);
  }

  /** List sessions sorted newest-first, optionally filtered by status. */
  list(filter?: SessionStatus | "all"): Session[] {
    let result = this.registry.list();
    if (filter && filter !== "all") {
      result = result.filter((s) => s.status === filter);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Kill a session by internal id. */
  kill(id: string, reason?: KillReason): boolean {
    const session = this.registry.get(id);
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

  /** Resolve any reference to a canonical backend conversation id for resume flows. */
  resolveBackendConversationId(ref: string): string | undefined {
    return this.references.resolveBackendConversationId(ref);
  }

  /** Compatibility wrapper retained for older callers/tests. */
  resolveHarnessSessionId(ref: string): string | undefined {
    return this.resolveBackendConversationId(ref);
  }

  /** Read persisted metadata by harness id, internal id, or name. */
  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.references.getPersistedSession(ref);
  }

  /** Returns true if this session's branch has already been merged (idempotency guard). */
  private isAlreadyMerged(ref: string | undefined): boolean {
    if (!ref) return false;
    const persisted = this.store.getPersistedSession(ref);
    return persisted?.worktreeMerged === true
      || persisted?.worktreeLifecycle?.state === "merged"
      || persisted?.worktreeLifecycle?.state === "released";
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
    const updated = this.stateSync.applySessionPatch(ref, patch);
    if (updated) {
      this.onPersistedSessionChanged(this.store.getPersistedSession(ref));
    }
    return updated;
  }

  /** Return persisted sessions newest-first. */
  listPersistedSessions(): PersistedSessionInfo[] {
    return this.store.listPersistedSessions();
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
      this.lastWaitingEventTimestamps.delete(sessionId);
      return true;
    }
    this.questions.resolveAskUserQuestion(sessionId, optionIndex);
    return true;
  }

  dispose(): void {
    this.disposeMaintenance();
    this.questions.dispose();
    this.notifications.dispose();
  }
}
