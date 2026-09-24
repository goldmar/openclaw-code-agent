import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "crypto";
import { Session } from "./session";
import { pluginConfig, getDefaultHarnessName } from "./config";
import { generateSessionName } from "./format";
import { formatLaunchSummaryFromSession, formatResumedLaunchMessage } from "./launch-summary";
import { formatHarnessModelLabel } from "./session-display";
import { pathsReferToSameLocation } from "./path-utils";
import {
  getBackendConversationId,
  getPrimarySessionLookupRef,
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
  WorktreeStrategy,
  RepoIntegrationPolicy,
  RepoPolicyRecord,
  ReasoningEffort,
} from "./types";
import { SessionStore } from "./session-store";
import type { SessionStoreOptions } from "./session-store";
import { computeSessionMetrics } from "./session-metrics";
import { WakeDispatcher, type SessionNotificationRequest } from "./wake-dispatcher";
import { SessionInteractionService, type NotificationButton } from "./session-interactions";
import { SessionNotificationService } from "./session-notifications";
import { SessionWorktreeController, type WorktreeCompletionState } from "./session-worktree-controller";
import {
  SessionQuestionService,
  type AskUserQuestionResolutionContext,
  type PendingAskUserQuestion,
} from "./session-question-service";
import { SessionReminderService } from "./session-reminder-service";
import { resolvePlanArtifactForPrompt, SessionLifecycleService } from "./session-lifecycle-service";
import {
  buildGoalTaskSucceededFollowupWake,
  buildPlanApprovalFallbackMessages,
  buildPlanApprovalPromptContent,
  formatPlanApprovalSummary,
} from "./session-notification-builder";
import { SessionWorktreeDecisionService } from "./session-worktree-decision-service";
import type { WorktreeDecisionSummaryProvider } from "./worktree-decision-summary";
import {
  createRuntimeQuestionContextSummaryProvider,
  type QuestionContextSummaryProvider,
} from "./question-context-summary";
import { SessionRuntimeRegistry } from "./session-runtime-registry";
import { SessionRuntimeBootstrapService } from "./session-runtime-bootstrap-service";
import { buildFailedPlanResumeRollbackState, buildResumedPlanState } from "./plan-decision-state";
import { SessionWorktreeMessageService } from "./session-worktree-message-service";
import { getSessionOutputPreview } from "./session-output-preview";
import { formatOriginRouteWakeBlock } from "./session-route";
import {
  buildPlanApprovalDeliveryFailureWake,
  buildPlanApprovalWakeText,
  hasProvablePlanReviewPrompt,
  isCurrentPendingPlanDecision as isCurrentPendingPlanDecisionState,
} from "./session-plan-approval-delivery";
import {
  detectDefaultBranch,
  getDiffSummary,
  getPrimaryRepoRootFromWorktree,
  isGitHubCLIAvailable,
  mergeBranch,
  syncWorktreePR,
  syncWorktreePRByUrl,
  deleteBranch,
  removeWorktree,
} from "./worktree";
import { KeyedOperationQueue } from "./keyed-operation-queue";
import { SessionMaintenanceService } from "./session-maintenance-service";
import { reconcilePersistedSessionTaskMirror } from "./session-task-lifecycle";
import { buildPendingDecisionPatch } from "./worktree-session-patches";
import {
  createRepoPolicyRecord,
  formatUnknownRepoPolicyMessage,
  isPrAvailableForResolution,
  resolveAllowedWorktreeActions,
  resolveRepoIdentity,
  seededRepoPolicy,
  findStoredRepoPolicies,
  type RepoPolicyResolution,
} from "./repo-policy";
import { createLogger } from "./logger";

const log = createLogger("session-manager");


const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const KILLABLE_STATUSES = new Set<SessionStatus>(["starting", "running"]);
const WAITING_EVENT_DEBOUNCE_MS = 5_000;


export type ForgetSessionResult =
  | { ok: true; name: string; id?: string }
  | {
    ok: false;
    reason: "not_found" | "running" | "suspended" | "worktree" | "delivery";
    detail?: string;
    name?: string;
    id?: string;
  };

const UNSETTLED_WORKTREE_STATES = new Set<string>([
  "provisioned",
  "pending_decision",
  "merge_conflict_resolving",
  "merge_in_progress",
  "pr_in_progress",
  "pr_open",
]);

/** Why a persisted session must be kept, or undefined when it can be forgotten. */
function forgetBlockReason(
  session: PersistedSessionInfo,
): { reason: "running" | "suspended" | "worktree" | "delivery"; detail?: string } | undefined {
  if (!TERMINAL_STATUSES.has(session.status) || session.runtimeState === "live") return { reason: "running" };
  if (session.lifecycle && session.lifecycle !== "terminal") return { reason: "suspended", detail: session.lifecycle };
  const worktreeState = session.worktreeLifecycle?.state ?? session.worktreeState;
  if (session.pendingWorktreeDecisionSince || (worktreeState && UNSETTLED_WORKTREE_STATES.has(worktreeState))) {
    return { reason: "worktree", detail: worktreeState ?? "pending_decision" };
  }
  if (session.worktreePath && existsSync(session.worktreePath)) {
    return { reason: "worktree", detail: `worktree still on disk at ${session.worktreePath}` };
  }
  if (session.deliveryState === "notifying" || session.deliveryState === "wake_pending") {
    return { reason: "delivery", detail: session.deliveryState };
  }
  return undefined;
}

type LaunchOptions = {
  notifyLaunch?: boolean;
};

type RepoPolicyLaunchArgs = {
  route?: SessionRoute;
  prompt: string;
  workdir: string;
  name?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  resumedFromSessionName?: string;
  resumeWorktreeFrom?: string;
  sessionIdOverride?: string;
  rewindTurns?: number;
  forkSession?: boolean;
  forceNewSession?: boolean;
  permissionMode?: SessionConfig["permissionMode"];
  planApproval?: PlanApprovalMode;
  harness?: string;
  worktreeStrategy?: WorktreeStrategy;
  worktreeBaseBranch?: string;
  worktreePrTargetRepo?: string;
  originAgentId?: string;
};

function digestRepoPolicyLaunchContext(args: RepoPolicyLaunchArgs, strategy: WorktreeStrategy): string {
  return createHash("sha256").update(JSON.stringify({
    route: args.route ? {
      provider: args.route.provider,
      target: args.route.target,
      accountId: args.route.accountId,
      threadId: args.route.threadId,
      sessionKey: args.route.sessionKey,
    } : undefined,
    prompt: args.prompt,
    workdir: args.workdir,
    name: args.name,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
    fastMode: args.fastMode,
    systemPrompt: args.systemPrompt,
    allowedTools: args.allowedTools ? [...args.allowedTools].sort() : args.allowedTools,
    resumeSessionId: args.resumeSessionId,
    resumedFromSessionName: args.resumedFromSessionName,
    resumeWorktreeFrom: args.resumeWorktreeFrom,
    sessionIdOverride: args.sessionIdOverride,
    rewindTurns: args.rewindTurns,
    forkSession: args.forkSession,
    forceNewSession: args.forceNewSession,
    permissionMode: args.permissionMode,
    planApproval: args.planApproval,
    harness: args.harness,
    worktreeStrategy: args.worktreeStrategy,
    effectiveWorktreeStrategy: strategy,
    worktreeBaseBranch: args.worktreeBaseBranch,
    worktreePrTargetRepo: args.worktreePrTargetRepo,
    originAgentId: args.originAgentId,
  })).digest("hex").slice(0, 16);
}

function digestRepoPolicyTokenLaunchContext(token: SessionActionToken): string {
  return createHash("sha256").update(JSON.stringify({
    route: token.route ? {
      provider: token.route.provider,
      target: token.route.target,
      accountId: token.route.accountId,
      threadId: token.route.threadId,
      sessionKey: token.route.sessionKey,
    } : undefined,
    prompt: token.launchPrompt,
    workdir: token.launchWorkdir,
    name: token.launchName,
    model: token.launchModel,
    reasoningEffort: token.launchReasoningEffort,
    fastMode: token.launchFastMode,
    systemPrompt: token.launchSystemPrompt,
    allowedTools: token.launchAllowedTools ? [...token.launchAllowedTools].sort() : token.launchAllowedTools,
    resumeSessionId: token.launchResumeSessionId,
    resumedFromSessionName: token.launchResumedFromSessionName,
    resumeWorktreeFrom: token.launchResumeWorktreeFrom,
    sessionIdOverride: token.launchSessionIdOverride,
    rewindTurns: token.launchRewindTurns,
    forkSession: token.launchForkSession,
    forceNewSession: token.launchForceNewSession,
    permissionMode: token.launchPermissionMode,
    planApproval: token.launchPlanApproval,
    harness: token.launchHarness,
    worktreeStrategy: token.launchWorktreeStrategy,
    worktreeBaseBranch: token.launchWorktreeBaseBranch,
    worktreePrTargetRepo: token.launchWorktreePrTargetRepo,
    originAgentId: token.launchOriginAgentId,
  })).digest("hex").slice(0, 16);
}

type LaunchConfirmationSession = Pick<Session, "status" | "name" | "id" | "killReason" | "error" | "result"> & {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

interface SessionManagerServiceBundle {
  registry: SessionRuntimeRegistry;
  sessions: Map<string, Session>;
  store: SessionStore;
  wakeDispatcher: WakeDispatcher;
  interactions: SessionInteractionService;
  notifications: SessionNotificationService;
  worktrees: SessionWorktreeController;
  questions: SessionQuestionService;
  lifecycle: SessionLifecycleService;
  restore: SessionRestoreService;
  stateSync: SessionStateSyncService;
  references: SessionReferenceService;
  worktreeStrategy: SessionWorktreeStrategyService;
  worktreeDecisions: SessionWorktreeDecisionService;
  runtimeBootstrap: SessionRuntimeBootstrapService;
  worktreeMessages: SessionWorktreeMessageService;
  maintenance: SessionMaintenanceService;
}

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
  private readonly mergeQueue = new KeyedOperationQueue();
  private spawnTail: Promise<void> = Promise.resolve();
  /** Pending AskUserQuestion intercepts awaiting user button selection. */
  private pendingAskUserQuestions: Map<string, PendingAskUserQuestion> = new Map();
  private readonly store: SessionStore;
  private readonly wakeDispatcher: WakeDispatcher;
  private readonly interactions: SessionInteractionService;
  private readonly notifications: SessionNotificationService;
  /** How long a tool waits for a prompt's direct delivery result before reporting it as in progress. */
  userDeliveryResultWaitMs = 10_000;
  private readonly worktrees: SessionWorktreeController;
  private readonly questions: SessionQuestionService;
  private readonly lifecycle: SessionLifecycleService;
  private readonly restore: SessionRestoreService;
  private readonly stateSync: SessionStateSyncService;
  private readonly references: SessionReferenceService;
  private readonly worktreeStrategy: SessionWorktreeStrategyService;
  private readonly worktreeDecisions: SessionWorktreeDecisionService;
  private readonly runtimeBootstrap: SessionRuntimeBootstrapService;
  private readonly worktreeMessages: SessionWorktreeMessageService;
  private readonly maintenance: SessionMaintenanceService;
  readonly ready: Promise<void>;
  private shuttingDown = false;
  private readonly pendingPlanResumeClaims = new Map<string, PersistedSessionInfo>();

  constructor(
    maxSessions: number = 20,
    maxPersistedSessions: number = 50,
    options: {
      store?: SessionStoreOptions;
      worktreeSummaryProvider?: WorktreeDecisionSummaryProvider;
      questionContextSummaryProvider?: QuestionContextSummaryProvider;
    } = {},
  ) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
    const services = SessionManager.createServiceBundle(this, options);
    this.registry = services.registry;
    this.sessions = services.sessions;
    this.store = services.store;
    this.wakeDispatcher = services.wakeDispatcher;
    this.interactions = services.interactions;
    this.notifications = services.notifications;
    this.worktrees = services.worktrees;
    this.questions = services.questions;
    this.lifecycle = services.lifecycle;
    this.restore = services.restore;
    this.stateSync = services.stateSync;
    this.references = services.references;
    this.worktreeStrategy = services.worktreeStrategy;
    this.worktreeDecisions = services.worktreeDecisions;
    this.runtimeBootstrap = services.runtimeBootstrap;
    this.worktreeMessages = services.worktreeMessages;
    this.maintenance = services.maintenance;
    this.ready = this.reconcilePersistedTaskFlowMirrors();
  }

  private static createServiceBundle(
    manager: SessionManager,
    options: {
      store?: SessionStoreOptions;
      worktreeSummaryProvider?: WorktreeDecisionSummaryProvider;
      questionContextSummaryProvider?: QuestionContextSummaryProvider;
    },
  ): SessionManagerServiceBundle {
    const registry = new SessionRuntimeRegistry();
    const sessions = registry.sessions;
    const store = new SessionStore(options.store);
    const wakeDispatcher = new WakeDispatcher();
    const interactions = new SessionInteractionService(store.actionTokenStore, isGitHubCLIAvailable);
    const references = new SessionReferenceService(sessions, store);
    const stateSync = new SessionStateSyncService({
      store,
      sessions,
      resolveSession: (ref) => references.resolveActive(ref),
    });
    const notifications = new SessionNotificationService(
      wakeDispatcher,
      (ref, patch) => stateSync.applySessionPatch(ref, patch),
      {
        getPersistedSession: (ref) => store.getPersistedSession(ref),
      },
    );
    const worktrees = new SessionWorktreeController();
    const restore = new SessionRestoreService((ref) => store.getPersistedSession(ref));
    const worktreeMessages = new SessionWorktreeMessageService();
    const worktreeStrategy = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: (session) => manager.shouldRunWorktreeStrategy(session),
      isAlreadyMerged: (ref) => manager.isAlreadyMerged(ref),
      resolveWorktreeRepoDir: (repoDir, worktreePath) => manager.resolveWorktreeRepoDir(repoDir, worktreePath),
      getWorktreeCompletionState: (repoDir, worktreePath, branchName, baseBranch) => (
        manager.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch)
      ),
      updatePersistedSession: (ref, patch) => manager.updatePersistedSession(ref, patch),
      getPersistedSession: (ref) => store.getPersistedSession(ref),
      dispatchSessionNotification: (session, request) => manager.dispatchSessionNotification(session, request),
      getOutputPreview: (session, maxChars) => manager.getOutputPreview(session, maxChars),
      originThreadLine: (session) => manager.originThreadLine(session),
      getWorktreeDecisionButtons: (sessionId) => manager.getWorktreeDecisionButtons(sessionId),
      getPolicyAwareWorktreeDecisionButtons: (sessionId, options, allowedActions) => (
        manager.getWorktreeDecisionButtons(sessionId, options, allowedActions)
      ),
      makeOpenPrButton: (sessionId) => manager.makeActionButton(sessionId, "worktree-create-pr", "Open PR"),
      isPrAvailable: async (repoDir) => (await manager.resolveRepoPolicy(repoDir)).prAvailable,
      hasOpenPrForBranch: async (repoDir, branchName, targetRepo) => {
        const status = await syncWorktreePR(repoDir, branchName, targetRepo);
        return status.exists && status.state === "open";
      },
      getPrStatusForBranch: (repoDir, branchName, targetRepo) => syncWorktreePR(repoDir, branchName, targetRepo),
      getPrStatusForUrl: (repoDir, prUrl, targetRepo) => syncWorktreePRByUrl(repoDir, prUrl, targetRepo),
      resolveRepoPolicy: (repoDir) => manager.resolveRepoPolicy(repoDir),
      worktreeSummaryProvider: options.worktreeSummaryProvider,
      worktreeMessages,
      enqueueMerge: (repoDir, fn, onQueued) => manager.enqueueMerge(repoDir, fn, onQueued),
      mergeBranch,
      spawnConflictResolver: async ({ session, worktreePath, prompt }) => {
        return manager.launchSession({
          prompt,
          workdir: worktreePath,
          name: `${session.name}-conflict-resolver`,
          harness: session.harnessName || getDefaultHarnessName(),
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          fastMode: session.fastMode,
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
    const questions = new SessionQuestionService(
      manager.pendingAskUserQuestions,
      (session, request) => manager.dispatchSessionNotification(session, request),
      (sessionId) => { manager.clearWaitingTimestampsForSession(sessionId); },
      (sessionId, questionOptions, context) => interactions.getQuestionButtons(sessionId, questionOptions, context),
    );
    const reminders = new SessionReminderService(
      (session) => manager.buildRoutingProxy(session),
      (session, request) => notifications.dispatch(session, request),
      (ref, patch) => manager.updatePersistedSession(ref, patch),
      (sessionId, persistedSession) => manager.getPolicyAwareWorktreeDecisionButtons(
        sessionId,
        {},
        undefined,
        persistedSession,
      ),
    );
    const maintenance = new SessionMaintenanceService({
      store,
      sessions,
      reminders,
      removeRuntimeSession: (sessionId, reason) => registry.remove(sessionId, reason),
      persistSession: (session, persistOptions) => manager.persistSession(session, persistOptions),
      clearRuntimeSessionState: (sessionId) => {
        manager.clearWaitingTimestampsForSession(sessionId);
        manager.lastTurnCompleteMarkers.delete(sessionId);
        manager.lastTerminalWakeMarkers.delete(sessionId);
      },
      resolveWorktreeRepoDir: (repoDir, worktreePath) => manager.resolveWorktreeRepoDir(repoDir, worktreePath),
      updatePersistedSession: (ref, patch) => manager.updatePersistedSession(ref, patch),
      getMaxPersistedSessions: () => manager.maxPersistedSessions,
    });
    store.onActionTokensChanged(() => manager.syncActionTokenExpiryDeadline());
    const lifecycle = new SessionLifecycleService({
      persistSession: (session) => manager.persistSession(session),
      clearWaitingTimestamp: (sessionId) => { manager.clearWaitingTimestampsForSession(sessionId); },
      handleWorktreeStrategy: (session) => manager.handleWorktreeStrategy(session),
      resolveWorktreeRepoDir: (repoDir, worktreePath) => manager.resolveWorktreeRepoDir(repoDir, worktreePath),
      updatePersistedSession: (ref, patch) => manager.updatePersistedSession(ref, patch),
      dispatchSessionNotification: (session, request) => manager.dispatchSessionNotification(session, request),
      notifySession: (session, text, label, idempotencyKey) => manager.notifySession(session, text, label, idempotencyKey),
      clearRetryTimersForSession: (sessionId) => wakeDispatcher.clearRetryTimersForSession(sessionId),
      hasTurnCompleteWakeMarker: (sessionId) => manager.lastTurnCompleteMarkers.has(sessionId),
      shouldEmitTurnCompleteWake: (session) => manager.shouldEmitTurnCompleteWake(session),
      shouldEmitTerminalWake: (session) => manager.shouldEmitTerminalWake(session),
      resolvePlanApprovalMode: (session) => manager.resolvePlanApprovalMode(session),
      getPlanApprovalButtons: (sessionId, session) => interactions.getPlanApprovalButtons(sessionId, session),
      getResumeButtons: (sessionId, session) => interactions.getResumeButtons(sessionId, session),
      getQuestionButtons: (sessionId, questionOptions, context) => interactions.getQuestionButtons(sessionId, questionOptions, context),
      extractLastOutputLine: (session) => manager.extractLastOutputLine(session),
      getOutputPreview: (session, maxChars) => manager.getOutputPreview(session, maxChars),
      originThreadLine: (session) => manager.originThreadLine(session),
      debounceWaitingEvent: (sessionId, identityKey) => manager.debounceWaitingEvent(sessionId, identityKey),
      isAlreadyMerged: (ref) => manager.isAlreadyMerged(ref),
      questionContextSummaryProvider: options.questionContextSummaryProvider ?? createRuntimeQuestionContextSummaryProvider(),
    });
    const worktreeDecisions = new SessionWorktreeDecisionService({
      getPersistedSession: (ref) => store.getPersistedSession(ref),
      resolveActiveSession: (ref) => references.resolveActive(ref),
      resolveWorktreeRepoDir: (repoDir, worktreePath) => manager.resolveWorktreeRepoDir(repoDir, worktreePath),
      updatePersistedSession: (ref, patch) => manager.updatePersistedSession(ref, patch),
      dispatchNotification: (session, request) => notifications.dispatch(session, request),
      buildRoutingProxy: (session) => manager.buildRoutingProxy(session),
    });
    const runtimeBootstrap = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: (session, preparedLaunch, config) => {
        restore.hydrateSpawnedSession(session, preparedLaunch, config);
      },
      markRunning: (session) => {
        store.markRunning(session);
        if (session.approvalState === "approved" && session.planDecisionVersion > 0) {
          interactions.consumePlanDecisionTokens(session.id, session.planDecisionVersion - 1);
        }
        manager.pendingPlanResumeClaims.delete(session.id);
        manager.onPersistedSessionChanged(store.getPersistedSession(session.id));
      },
      syncTaskMirror: (session) => {
        if (sessions.get(session.id) !== session || !session.taskFlowMirror) return;
        const persisted = store.getPersistedSession(session.id);
        if (!persisted || persisted.taskFlowMirror === session.taskFlowMirror) return;
        manager.updatePersistedSession(session.id, { taskFlowMirror: session.taskFlowMirror });
      },
      handleTerminal: async (session) => {
        if (sessions.get(session.id) !== session) return;
        const retryablePlan = manager.pendingPlanResumeClaims.get(session.id);
        try {
          await manager.onSessionTerminal(session);
        } finally {
          // A failed approved resume must remain retryable even when terminal
          // persistence, cleanup, or notification handling itself throws.
          if (retryablePlan) {
            const rollbackState = buildFailedPlanResumeRollbackState(
              retryablePlan,
              store.getPersistedSession(session.id),
            );
            store.replacePersistedSession(rollbackState);
            manager.pendingPlanResumeClaims.delete(session.id);
            manager.onPersistedSessionChanged(rollbackState);
          }
        }
      },
      handleTurnEnd: (session, hadQuestion) => lifecycle.handleTurnEnd(session, hadQuestion),
      formatLaunchWorkdirLabel: (session) => manager.formatLaunchWorkdirLabel(session),
      notifySession: (session, text, label, idempotencyKey) => manager.notifySession(session, text, label, idempotencyKey),
      cancelSession: (session) => {
        if (sessions.get(session.id) !== session || !KILLABLE_STATUSES.has(session.status)) return;
        manager.kill(session.id, "user");
      },
    });

    return {
      registry,
      sessions,
      store,
      wakeDispatcher,
      interactions,
      notifications,
      worktrees,
      questions,
      lifecycle,
      restore,
      stateSync,
      references,
      worktreeStrategy,
      worktreeDecisions,
      runtimeBootstrap,
      worktreeMessages,
      maintenance,
    };
  }

  private uniqueName(baseName: string): string {
    return this.registry.uniqueName(baseName);
  }

  private syncRuntimeGcDeadline(session: Pick<Session, "id" | "completedAt">): void {
    this.maintenance.syncRuntimeGcDeadline(session);
  }

  private onPersistedSessionChanged(session?: PersistedSessionInfo): void {
    if (!session) return;
    this.syncPersistedSessionMaintenance(session);
    this.enforcePersistedRetention();
  }

  private syncPersistedSessionMaintenance(session: PersistedSessionInfo): void {
    this.maintenance.syncPersistedSessionMaintenance(session);
  }

  private syncActionTokenExpiryDeadline(): void {
    this.maintenance.syncActionTokenExpiryDeadline();
  }

  private syncSessionOutputCleanupDeadline(now: number = Date.now()): void {
    this.maintenance.syncSessionOutputCleanupDeadline(now);
  }

  private enforcePersistedRetention(): void {
    this.maintenance.enforcePersistedRetention();
  }

  /** Seed maintenance deadlines; resolves once the git-backed schedule checks have settled. */
  bootstrapMaintenanceSchedules(): Promise<void> {
    this.maintenance.bootstrapMaintenanceSchedules();
    return this.maintenance.whenIdle();
  }

  private disposeMaintenance(): void {
    this.maintenance.dispose();
  }

  /**
   * Spawn and start a new session, wiring lifecycle listeners and launch notification.
   *
   * Launches run one at a time. Preparation (repo policy lookup, worktree
   * creation) is asynchronous, and the next launch's max-session, unique-name,
   * and session-id checks must see the previous launch already registered.
   */
  launchSession(config: SessionConfig, options: LaunchOptions = {}): Promise<Session> {
    const launch = this.spawnTail.then((): Promise<Session> => this.launchSerialized(config, options));
    this.spawnTail = launch.then((): void => undefined, (): void => undefined);
    return launch;
  }

  private async launchSerialized(config: SessionConfig, options: LaunchOptions): Promise<Session> {
    if (this.shuttingDown) {
      throw new Error("Cannot launch a session: the code-agent service is shutting down.");
    }
    const activeCount = this.registry.activeSessionCount();
    if (activeCount >= this.maxSessions) {
      throw new Error(`Max sessions reached (${this.maxSessions}). Use agent_sessions to list active sessions and agent_kill to end one.`);
    }

    let pendingPlanResumeClaim: PersistedSessionInfo | undefined;
    let startAfter: Promise<void> | undefined;
    const appendStartBarrier = (barrier: Promise<void>): void => {
      startAfter = startAfter
        ? Promise.all([startAfter, barrier]).then((): void => undefined)
        : barrier;
    };
    if (config.resumeSessionId && !config.forkSession) {
      const resumeOwners = this.registry.list().filter((candidate) => (
        candidate.backendKind === "codex-app-server"
        && (
          candidate.backendRef?.conversationId === config.resumeSessionId
          || (
            !candidate.backendRef?.conversationId
            && candidate.resumeSessionId === config.resumeSessionId
          )
        )
      ));
      const activeResumeOwner = resumeOwners.find((candidate) => (
        candidate.status === "starting" || candidate.status === "running"
      ));
      if (activeResumeOwner) {
        throw new Error(
          `Cannot resume backend thread ${config.resumeSessionId}: session ${activeResumeOwner.id} still owns its active writer.`,
        );
      }
      for (const resumeOwner of resumeOwners) {
        if (typeof resumeOwner.waitForTeardown === "function") {
          appendStartBarrier(resumeOwner.waitForTeardown());
        }
      }
    }
    if (config.sessionIdOverride) {
      const replacedPersisted = this.getPersistedSession(config.sessionIdOverride);
      if (config.resumeSessionId && replacedPersisted?.pendingPlanApproval) {
        const resumedPlanState = buildResumedPlanState(
          replacedPersisted,
          config.permissionMode ?? pluginConfig.permissionMode,
        );
        config = {
          ...config,
          permissionMode: resumedPlanState.permissionMode,
          ...resumedPlanState.patch,
        };
        if (resumedPlanState.approvalApplied) {
          pendingPlanResumeClaim = replacedPersisted;
        }
      }
      const existing = this.registry.get(config.sessionIdOverride);
      if (existing?.status === "starting" || existing?.status === "running") {
        throw new Error(`Cannot reuse session ID ${config.sessionIdOverride}: that session is still ${existing.status}.`);
      }
      if (existing) {
        if (typeof existing.waitForTeardown === "function") {
          appendStartBarrier(existing.waitForTeardown());
        }
        this.registry.remove(existing.id, "session-id-override-replacement");
      }
      this.clearWaitingTimestampsForSession(config.sessionIdOverride);
      this.lastTurnCompleteMarkers.delete(config.sessionIdOverride);
      this.lastTerminalWakeMarkers.delete(config.sessionIdOverride);
      this.maintenance.cancelRuntimeGc(config.sessionIdOverride);
    }

    const baseName = config.name || generateSessionName(config.prompt);
    const name = this.uniqueName(baseName);
    if (name !== baseName) {
      log.info(`[SessionManager] Name conflict: "${baseName}" → "${name}" (active session with same name exists)`);
    }

    const launchPolicy = await this.checkRepoPolicyForLaunch(config.workdir, config.worktreeStrategy);
    if (!launchPolicy.ok) {
      const blocked = launchPolicy as { ok: false; text: string };
      throw new Error(blocked.text);
    }
    config.repoIntegrationPolicy = launchPolicy.resolution.policy;
    config.repoIntegrationPolicySource = launchPolicy.resolution.source === "none" ? undefined : launchPolicy.resolution.source;
    config.repoProvider = launchPolicy.resolution.provider;

    const preparedLaunch = await this.restore.prepareSpawn(config, name);
    // Repo-policy lookup and worktree preparation await git; shutdown may have
    // started meanwhile, and a session registered now would outlive it.
    if (this.shuttingDown) {
      if (preparedLaunch.worktreePath && !config.resumeSessionId && !config.resumeWorktreeFrom) {
        await removeWorktree(preparedLaunch.originalWorkdir, preparedLaunch.worktreePath, { destructive: true });
        if (preparedLaunch.worktreeBranchName) await deleteBranch(preparedLaunch.originalWorkdir, preparedLaunch.worktreeBranchName);
      }
      throw new Error("Cannot launch a session: the code-agent service is shutting down.");
    }

    if (!config.route?.provider || !config.route.target) {
      throw new Error(`Cannot launch session "${name}": missing explicit route metadata.`);
    }

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
      ...(config.forkSession && config.resumeSessionId && !config.forkBaselineUsage
        ? { forkBaselineUsage: this.resolveForkBaselineUsage(config.resumeSessionId) }
        : {}),
    }, name);
    sessionIdRef = session.id; // bind late — canUseTool closure captures this ref
    // A question answered directly through the harness (agent_respond text or an
    // option) no longer needs the button-callback wait held by the question service.
    session.on("pendingInputAnswered", (answered: Session, requestId: string | undefined) => {
      this.questions.discardAskUserQuestion(answered.id, requestId);
    });
    if (pendingPlanResumeClaim) {
      this.pendingPlanResumeClaims.set(session.id, pendingPlanResumeClaim);
    }
    this.registry.add(session);
    try {
      return await this.runtimeBootstrap.initializeSession(session, preparedLaunch, config, {
        ...options,
        startAfter,
      });
    } catch (err) {
      this.pendingPlanResumeClaims.delete(session.id);
      throw err;
    }
  }

  /**
   * The parent's usage at fork time. A Claude Code fork's SDK totals include the
   * parent conversation, so the harness subtracts this to report the fork's own spend.
   */
  private resolveForkBaselineUsage(parentRef: string): SessionConfig["forkBaselineUsage"] {
    const active = [...this.sessions.values()].find((candidate) => (
      getBackendConversationId(candidate) === parentRef || candidate.id === parentRef
    ));
    if (active) {
      return { costUsd: active.costUsd, ...(active.usage?.models ? { models: active.usage.models } : {}) };
    }
    const persisted = this.getPersistedSession(parentRef);
    return persisted ? { costUsd: persisted.costUsd } : undefined;
  }

  /** Spawn a session and wait until it is truly running or fails before startup. */
  async launchAndAwaitRunning(config: SessionConfig, options: LaunchOptions = {}): Promise<Session> {
    const session = await this.launchSession(config, options);
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
    resumeSessionName?: string;
    forkSession?: boolean;
    rewindTurns?: number;
  }, session: Session): string {
    return formatLaunchSummaryFromSession({
      prompt: config.prompt,
      workdir: config.workdir,
      harness: config.harness,
      permissionMode: config.permissionMode ?? pluginConfig.permissionMode,
      planApproval: config.planApproval,
      resumeSessionId: config.resumeSessionId,
      resumeSessionName: config.resumeSessionName,
      forkSession: config.forkSession,
      forceNewSession: config.forceNewSession,
      rewindTurns: config.rewindTurns,
    }, session);
  }

  private shouldRunWorktreeStrategy(session: Session): boolean {
    const phase = session.lifecycle;
    if (phase === "starting" || phase === "awaiting_plan_decision" || phase === "awaiting_user_input") return false;
    if (session.pendingPlanApproval) return false;
    return true;
  }

  async resolveRepoPolicy(workdir: string): Promise<RepoPolicyResolution> {
    const identity = await resolveRepoIdentity(workdir);
    if (!identity) {
      return { source: "none", provider: "unsupported", prAvailable: false };
    }
    const stored = this.store.getRepoPolicy(identity.key);
    if (stored) {
      const resolution = {
        identity,
        policy: stored.policy,
        source: "stored" as const,
        provider: identity.provider,
        prAvailable: identity.provider === "github" && await isGitHubCLIAvailable(),
        record: stored,
      };
      return resolution;
    }
    const seeded = seededRepoPolicy(identity);
    if (seeded) {
      const record = createRepoPolicyRecord(identity, seeded, "seeded");
      return {
        identity,
        policy: seeded,
        source: "seeded",
        provider: identity.provider,
        prAvailable: await isPrAvailableForResolution({ provider: identity.provider }),
        record,
      };
    }
    return {
      identity,
      source: "unknown",
      provider: identity.provider,
      prAvailable: await isPrAvailableForResolution({ provider: identity.provider }),
    };
  }

  async checkRepoPolicyForLaunch(workdir: string, requestedStrategy?: WorktreeStrategy): Promise<{ ok: true; resolution: RepoPolicyResolution } | { ok: false; text: string }> {
    const strategy = requestedStrategy ?? pluginConfig.defaultWorktreeStrategy ?? "off";
    const resolution = await this.resolveRepoPolicy(workdir);
    if (strategy === "off") return { ok: true, resolution };
    if (resolution.source === "none") return { ok: true, resolution };
    if (resolution.source === "unknown" && resolution.identity) {
      return { ok: false, text: formatUnknownRepoPolicyMessage(resolution.identity, strategy, resolution.prAvailable) };
    }
    return { ok: true, resolution };
  }

  async getRepoPolicyRecordForWorkdir(workdir: string): Promise<RepoPolicyRecord | undefined> {
    const resolution = await this.resolveRepoPolicy(workdir);
    return resolution.record;
  }

  listRepoPolicies(): RepoPolicyRecord[] {
    return this.store.listRepoPolicies();
  }

  async cleanupRepoPolicies(): Promise<RepoPolicyRecord[]> {
    const removed = [...this.store.cleanupRepoPolicies()];
    const staleIdentityKeys: string[] = [];
    for (const record of this.store.listRepoPolicies()) {
      const currentIdentity = await resolveRepoIdentity(record.repoRoot);
      if (!currentIdentity || currentIdentity.key === record.key) continue;
      staleIdentityKeys.push(record.key);
    }
    removed.push(...this.store.removeRepoPolicies(staleIdentityKeys));
    return removed.sort((a, b) => a.repoRoot.localeCompare(b.repoRoot) || a.key.localeCompare(b.key));
  }

  async setRepoPolicy(workdir: string, policy: RepoIntegrationPolicy): Promise<RepoPolicyRecord | undefined> {
    const identity = await resolveRepoIdentity(workdir);
    if (!identity) return undefined;
    return this.store.setRepoPolicy(createRepoPolicyRecord(identity, policy, "stored"));
  }

  /**
   * Stored policy records for a repo whose identity cannot be resolved (the
   * directory was deleted or is no longer a git checkout). Matches by stored
   * key or repo root; see `findStoredRepoPolicies`.
   */
  findStoredRepoPolicies(ref: string): RepoPolicyRecord[] {
    return findStoredRepoPolicies(this.store.listRepoPolicies(), ref);
  }

  /**
   * Remove the stored policy for a repo. `ref` is a workdir, a stored repo
   * root, or a stored key. When the repo still resolves, its live key is
   * removed together with records left at the same root under an older
   * remote; when it no longer resolves (for example the directory was
   * deleted), records are matched from what they store.
   */
  async resetRepoPolicy(ref: string): Promise<RepoPolicyRecord[]> {
    const identity = await resolveRepoIdentity(ref);
    const records = this.store.listRepoPolicies();
    const keys = identity
      ? records
        .filter((record) => record.key === identity.key || record.repoRoot === identity.repoRoot)
        .map((record) => record.key)
      : findStoredRepoPolicies(records, ref).map((record) => record.key);
    return this.store.removeRepoPolicies(keys);
  }

  async requestRepoPolicyForLaunch(args: RepoPolicyLaunchArgs): Promise<string> {
    const strategy = args.worktreeStrategy ?? pluginConfig.defaultWorktreeStrategy ?? "off";
    const resolution = await this.resolveRepoPolicy(args.workdir);
    if (!resolution.identity) {
      return `Error: ${args.workdir} is not a git repository.`;
    }
    const message = formatUnknownRepoPolicyMessage(resolution.identity, strategy, resolution.prAvailable);
    if (!args.route?.provider || !args.route.target) {
      return message;
    }

    const choiceId = `repo-policy:${resolution.identity.key}`;
    const buttons = this.interactions.getRepoPolicyChoiceButtons({
      choiceId,
      route: args.route,
      repoRoot: resolution.identity.repoRoot,
      launchPrompt: args.prompt,
      launchWorkdir: args.workdir,
      launchName: args.name,
      launchModel: args.model,
      launchReasoningEffort: args.reasoningEffort,
      launchFastMode: args.fastMode,
      launchSystemPrompt: args.systemPrompt,
      launchAllowedTools: args.allowedTools,
      launchResumeSessionId: args.resumeSessionId,
      launchResumedFromSessionName: args.resumedFromSessionName,
      launchResumeWorktreeFrom: args.resumeWorktreeFrom,
      launchSessionIdOverride: args.sessionIdOverride,
      launchRewindTurns: args.rewindTurns,
      launchForkSession: args.forkSession,
      launchForceNewSession: args.forceNewSession,
      launchPermissionMode: args.permissionMode,
      launchPlanApproval: args.planApproval,
      launchHarness: args.harness,
      launchWorktreeStrategy: strategy,
      launchWorktreeBaseBranch: args.worktreeBaseBranch,
      launchWorktreePrTargetRepo: args.worktreePrTargetRepo,
      launchOriginAgentId: args.originAgentId,
      prAvailable: resolution.prAvailable,
    });
    const launchContextDigest = digestRepoPolicyLaunchContext(args, strategy);

    const delivery = await this.dispatchAndAwaitUserDelivery(
      this.buildRoutingProxy({
        id: choiceId,
        name: "repo-policy",
        route: args.route,
      }),
      {
        label: "repo-policy-choice",
        idempotencyKey: `repo-policy-choice:${resolution.identity.key}:${strategy}:${launchContextDigest}`,
        userMessage: [
          message,
          ``,
          `After you choose a policy, OpenClaw Code Agent will continue this launch automatically.`,
        ].join("\n"),
        notifyUser: "always",
        requireDirectUserNotification: true,
        buttons,
        wakeMessageOnNotifySuccess: [
          `Repo policy choice buttons delivered to the user.`,
          `Repo: ${resolution.identity.repoRoot}`,
          `Wait for their policy choice; do not set the policy or relaunch separately.`,
        ].join("\n"),
        wakeMessageOnNotifyFailed: message,
      },
    );

    if (delivery === "failed") {
      return [
        `Error: The repo policy choice prompt for ${resolution.identity.repoRoot} could not be delivered to the user.`,
        message,
      ].join("\n\n");
    }
    return [
      delivery === "pending"
        ? `Repo policy choice prompt is being delivered for ${resolution.identity.repoRoot}.`
        : delivery === "skipped"
          ? `A repo policy choice prompt was already sent for ${resolution.identity.repoRoot}.`
          : `Repo policy choice prompt sent for ${resolution.identity.repoRoot}.`,
      resolution.prAvailable
        ? `Wait for the user's Require PR, Merge or PR, No PR, or Manual response.`
        : `Wait for the user's No PR or Manual response.`,
      `Do not send a separate plain-text policy question.`,
    ].join(" ");
  }

  async launchAfterRepoPolicyChoice(args: RepoPolicyLaunchArgs): Promise<{ session: Session; text: string }> {
    const route = args.route;
    if (!route?.provider || !route.target) {
      throw new Error("missing route metadata for stored launch");
    }
    const harness = args.harness ?? getDefaultHarnessName();
    const permissionMode = args.permissionMode ?? pluginConfig.permissionMode;
    const planApproval = args.planApproval ?? pluginConfig.planApproval;
    const session = await this.launchSession({
      prompt: args.prompt,
      workdir: args.workdir,
      sessionIdOverride: args.sessionIdOverride,
      name: args.name,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      fastMode: args.fastMode,
      systemPrompt: args.systemPrompt,
      allowedTools: args.allowedTools,
      resumeSessionId: args.resumeSessionId,
      resumedFromSessionName: args.resumedFromSessionName,
      resumeWorktreeFrom: args.resumeWorktreeFrom,
      forkSession: args.resumeSessionId ? args.forkSession : false,
      rewindTurns: args.resumeSessionId ? args.rewindTurns : undefined,
      multiTurn: true,
      permissionMode,
      planApproval,
      originChannel: this.originChannelFromRoute(route),
      originThreadId: route.threadId,
      originAgentId: args.originAgentId,
      originSessionKey: route.sessionKey,
      route,
      harness,
      worktreeStrategy: args.worktreeStrategy,
      worktreeBaseBranch: args.worktreeBaseBranch,
      worktreePrTargetRepo: args.worktreePrTargetRepo,
    });
    return {
      session,
      text: this.formatLaunchResult({
        prompt: args.prompt,
        workdir: args.workdir,
        harness,
        permissionMode,
        planApproval,
        forceNewSession: args.forceNewSession,
        resumeSessionId: args.resumeSessionId,
        resumeSessionName: args.resumedFromSessionName,
        forkSession: args.forkSession,
        rewindTurns: args.rewindTurns,
      }, session),
    };
  }

  async continueLaunchAfterManualRepoPolicy(
    workdir: string,
    policy: RepoIntegrationPolicy,
  ): Promise<{ kind: "none" } | { kind: "ambiguous"; count: number } | { kind: "launched"; session: Session; text: string }> {
    const resolution = await this.resolveRepoPolicy(workdir);
    if (!resolution.identity) return { kind: "none" };

    const repoPolicyTokens = this.interactions.listActiveActionTokens("repo-policy-set")
      .filter((token) => (
        token.repoPolicyWorkdir === resolution.identity?.repoRoot
      ));
    const clearRepoPolicyTokenSessions = (): void => {
      for (const sessionId of new Set(repoPolicyTokens.map((token) => token.sessionId))) {
        this.clearRepoPolicyChoiceTokens(sessionId);
      }
    };
    const candidates = repoPolicyTokens.filter((token) => (
      token.repoPolicy === policy
      && Boolean(token.launchPrompt)
      && Boolean(token.launchWorkdir)
      && Boolean(token.route?.provider)
      && Boolean(token.route?.target)
    ));

    if (candidates.length === 0) {
      clearRepoPolicyTokenSessions();
      return { kind: "none" };
    }
    const candidatesByLaunch = new Map<string, SessionActionToken>();
    for (const candidate of candidates) {
      const key = digestRepoPolicyTokenLaunchContext(candidate);
      if (!candidatesByLaunch.has(key)) candidatesByLaunch.set(key, candidate);
    }
    if (candidatesByLaunch.size > 1) {
      clearRepoPolicyTokenSessions();
      return { kind: "ambiguous", count: candidatesByLaunch.size };
    }

    const token = [...candidatesByLaunch.values()][0];
    if (!token.launchPrompt || !token.launchWorkdir) return { kind: "none" };

    const result = await this.launchAfterRepoPolicyChoice({
      route: token.route,
      prompt: token.launchPrompt,
      workdir: token.launchWorkdir,
      name: token.launchName,
      model: token.launchModel,
      reasoningEffort: token.launchReasoningEffort,
      fastMode: token.launchFastMode,
      systemPrompt: token.launchSystemPrompt,
      allowedTools: token.launchAllowedTools,
      resumeSessionId: token.launchResumeSessionId,
      resumedFromSessionName: token.launchResumedFromSessionName,
      resumeWorktreeFrom: token.launchResumeWorktreeFrom,
      sessionIdOverride: token.launchSessionIdOverride,
      rewindTurns: token.launchRewindTurns,
      forkSession: token.launchForkSession,
      forceNewSession: token.launchForceNewSession,
      permissionMode: token.launchPermissionMode,
      planApproval: token.launchPlanApproval,
      harness: token.launchHarness,
      worktreeStrategy: token.launchWorktreeStrategy,
      worktreeBaseBranch: token.launchWorktreeBaseBranch,
      worktreePrTargetRepo: token.launchWorktreePrTargetRepo,
      originAgentId: token.launchOriginAgentId,
    });

    this.consumeActionToken(token.id);
    this.clearRepoPolicyChoiceTokens(token.sessionId);
    return { kind: "launched", ...result };
  }

  private makeActionButton(
    sessionId: string,
    kind: SessionActionKind,
    label: string,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): NotificationButton {
    return this.interactions.makeActionButton(sessionId, kind, label, options);
  }

  makePluginActionButton(
    sessionId: string,
    kind: Extract<
      SessionActionKind,
      "plugin-update-install" | "plugin-update-remind-later" | "plugin-update-dismiss" | "plugin-update-restart"
    >,
    label: string,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): NotificationButton {
    return this.makeActionButton(sessionId, kind, label, options);
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    return this.interactions.consumeActionToken(tokenId);
  }

  getActionToken(tokenId: string): SessionActionToken | undefined {
    return this.interactions.getActionToken(tokenId);
  }

  clearRepoPolicyChoiceTokens(sessionId: string): void {
    this.interactions.clearRepoPolicyChoiceTokens(sessionId);
  }

  clearPlanDecisionTokens(sessionId: string, keepVersion?: number): void {
    this.interactions.clearPlanDecisionTokens(sessionId, keepVersion);
  }

  private isCurrentPendingPlanDecision(ref: string, planDecisionVersion: number | undefined): boolean {
    const session = this.resolve(ref) ?? this.getPersistedSession(ref);
    return isCurrentPendingPlanDecisionState(session, planDecisionVersion);
  }

  private dispatchPlanApprovalFallback(
    session: Session,
    planDecisionVersion: number | undefined,
    summary: string,
  ): void {
    const attemptedAt = new Date().toISOString();
    this.notifications.dispatch(session, {
      label: "plan-approval-fallback",
      idempotencyKey: `plan-approval:${session.id}:v${planDecisionVersion ?? "unknown"}:fallback`,
      userMessages: buildPlanApprovalFallbackMessages({ session, summary }),
      notifyUser: "always",
      shouldDispatch: () => this.isCurrentPendingPlanDecision(session.id, planDecisionVersion),
      hooks: {
        onNotifyStarted: () => {
          this.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "sending",
            approvalPromptTransport: "direct-message",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: attemptedAt,
          });
        },
        onNotifySucceeded: () => {
          this.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "fallback_delivered",
            approvalPromptTransport: "direct-message",
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
            approvalPromptTransport: "direct-message",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: attemptedAt,
            approvalPromptFailedAt: new Date().toISOString(),
          });
        },
      },
      wakeMessageOnNotifySuccess: buildPlanApprovalWakeText(session, planDecisionVersion, true),
      wakeMessageOnNotifyFailed: buildPlanApprovalDeliveryFailureWake({ session, planDecisionVersion }),
      failureWakeConfirmsNotificationDelivery: false,
    });
  }

  private async getWorktreeDecisionButtons(
    sessionId: string,
    options: { allowDelegate?: boolean } = {},
    allowedActions: { merge: boolean; pr: boolean } = { merge: true, pr: true },
  ): Promise<NotificationButton[][] | undefined> {
    const session = this.resolve(sessionId) ?? this.getPersistedSession(sessionId);
    if (!session || (session.worktreeStrategy === "delegate" && options.allowDelegate !== true)) return undefined;
    return this.interactions.getWorktreeDecisionButtons(sessionId, session, allowedActions);
  }

  private async getPolicyAwareWorktreeDecisionButtons(
    sessionId: string,
    options: { allowDelegate?: boolean } = {},
    session?: Session,
    persistedSession?: PersistedSessionInfo,
  ): Promise<NotificationButton[][] | undefined> {
    const activeSession = session ?? this.resolve(sessionId);
    const persisted = persistedSession ?? this.getPersistedSession(sessionId);
    const repoDir = await this.resolveWorktreeRepoDir(
      activeSession?.originalWorkdir ?? persisted?.workdir,
      activeSession?.worktreePath ?? persisted?.worktreePath,
    );
    const policyResolution = repoDir ? await this.resolveRepoPolicy(repoDir) : undefined;
    const sessionPolicy = activeSession?.repoIntegrationPolicy
      ?? persisted?.repoIntegrationPolicy;
    const effectivePolicy = sessionPolicy
      ?? policyResolution?.policy;
    const prAvailable = policyResolution?.prAvailable
      ?? Boolean(sessionPolicy && sessionPolicy !== "never-pr" && sessionPolicy !== "manual");
    const allowedActions = effectivePolicy
      ? resolveAllowedWorktreeActions({ policy: effectivePolicy, prAvailable })
      : { merge: true, pr: true };
    return this.getWorktreeDecisionButtons(sessionId, options, allowedActions);
  }

  private getWorktreeCompletionState(
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<WorktreeCompletionState> {
    return this.worktrees.getCompletionState(repoDir, worktreePath, branchName, baseBranch);
  }

  notifyWorktreeOutcome(
    sessionOrPersisted: Session | {
      id: string;
      harnessSessionId?: string;
      route?: PersistedSessionInfo["route"];
      costUsd?: number;
      createdAt?: number;
      completedAt?: number;
      harnessName?: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
    },
    outcomeLine: string,
    options?: {
      summaryWakeRequired?: boolean;
      detailLines?: string[];
      completionWakeOutcomeKey?: string;
      completionSummaryOwner?: "wake" | "foreground";
    },
  ): void {
    this.notifications.notifyWorktreeOutcome(sessionOrPersisted as Session, outcomeLine, options);
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
    if (hasProvablePlanReviewPrompt(session, actionableVersion)) {
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
    const currentArtifact = activeSession
      ? resolvePlanArtifactForPrompt(activeSession, actionableVersion)
      : undefined;
    const planPrompt = buildPlanApprovalPromptContent({
      sessionName: session.name,
      actionableVersion,
      preview: activeSession?.getOutput().join("\n") ?? "",
      artifact: currentArtifact,
      escalationRationale: formattedSummary,
      hasButtons: true,
      heading: "needs your decision",
    });
    const userMessages = planPrompt.userMessages.map((text, index, all) => ({
      text,
      buttons: index === all.length - 1 ? buttons : undefined,
      requiredForSequenceSuccess: true,
    }));

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
        idempotencyKey: `plan-approval:${sessionId}:v${actionableVersion ?? "unknown"}:canonical`,
        userMessage: userMessages.length === 1 ? userMessages[0]?.text : undefined,
        userMessages: userMessages.length > 1 ? userMessages : undefined,
        notifyUser: "always",
        buttons: userMessages.length === 1 ? buttons : undefined,
        hooks: {
          onNotifyStarted: () => {
            this.updatePersistedSession(sessionId, {
              approvalPromptRequiredVersion: actionableVersion,
              approvalPromptStatus: "sending",
              approvalPromptVersion: actionableVersion,
              approvalPromptTransport: "direct-message",
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
              approvalPromptTransport: "direct-message",
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
              approvalPromptTransport: "direct-message",
              approvalPromptMessageKind: "canonical_buttons",
              approvalPromptFailedAt: new Date().toISOString(),
            });
          },
        },
        shouldDispatch: () => this.isCurrentPendingPlanDecision(sessionId, actionableVersion),
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
          planPrompt.reviewSummary,
        ),
        wakeMessageOnNotifySuccess: buildPlanApprovalWakeText({ id: sessionId, name: session.name }, actionableVersion),
      },
    );

    return [
      `Canonical plan approval prompt queued for session ${session.name} [${sessionId}].`,
      `Wait for the user's Approve, Revise, or Reject response.`,
      `Do not send a separate plain-text approval message.`,
    ].join(" ");
  }

  async requestWorktreeDecisionFromUser(ref: string, summary: string): Promise<string> {
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) return "Error: summary must not be empty.";

    const activeSession = this.resolve(ref);
    const persistedSession = this.getPersistedSession(ref);
    const session = activeSession ?? persistedSession;
    if (!session) return `Error: Session "${ref}" not found.`;
    if (session.worktreeStrategy !== "delegate") {
      return `Error: Session "${ref}" already uses direct user worktree decisions. Do not send a duplicate decision prompt.`;
    }
    const pendingWorktreeDecisionSince = "pendingWorktreeDecisionSince" in session
      ? session.pendingWorktreeDecisionSince
      : undefined;
    const pendingDecision =
      Boolean(pendingWorktreeDecisionSince)
      || session.worktreeState === "pending_decision"
      || session.worktreeLifecycle?.state === "pending_decision";
    if (!pendingDecision) {
      return `Error: Session "${ref}" is not awaiting a delegated worktree decision.`;
    }

    const sessionId = getPrimarySessionLookupRef(activeSession ?? persistedSession ?? { id: ref }) ?? ref;
    const worktreePath = activeSession?.worktreePath ?? persistedSession?.worktreePath;
    const branchName = activeSession?.worktreeBranch ?? persistedSession?.worktreeBranch;
    const repoDir = await this.resolveWorktreeRepoDir(
      activeSession?.originalWorkdir ?? persistedSession?.workdir,
      worktreePath,
    );
    if (!worktreePath) return `Error: Session "${ref}" has no managed worktree path.`;
    if (!branchName) return `Error: Session "${ref}" has no managed worktree branch.`;
    if (!repoDir) return `Error: Session "${ref}" has no resolvable repository root for worktree ${worktreePath}.`;

    const baseBranch = activeSession?.worktreeBaseBranch
      ?? persistedSession?.worktreeBaseBranch
      ?? await detectDefaultBranch(repoDir);
    const diffSummary = await getDiffSummary(repoDir, branchName, baseBranch);
    if (!diffSummary) {
      return `Error: Could not compute worktree diff summary for session "${ref}".`;
    }

    const buttons = await this.getPolicyAwareWorktreeDecisionButtons(
      sessionId,
      { allowDelegate: true },
      activeSession,
      persistedSession,
    );
    if (!buttons || buttons.length === 0) {
      return `Error: Could not create worktree decision buttons for session "${ref}".`;
    }

    const summaryLines = trimmedSummary
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter((line) => line.length > 0);

    const delivery = await this.dispatchAndAwaitUserDelivery(
      this.buildRoutingProxy({
        id: sessionId,
        name: session.name,
        sessionId: persistedSession?.sessionId,
        harnessSessionId: activeSession?.harnessSessionId ?? persistedSession?.harnessSessionId,
        backendRef: activeSession?.backendRef ?? persistedSession?.backendRef,
        route: activeSession?.route ?? persistedSession?.route,
      }),
      this.worktreeMessages.buildAskNotification({
        session: {
          id: sessionId,
          name: session.name,
          worktreePrTargetRepo: activeSession?.worktreePrTargetRepo ?? persistedSession?.worktreePrTargetRepo,
        },
        branchName,
        baseBranch,
        diffSummary,
        summaryLines,
        buttons,
      }),
    );

    if (delivery === "failed") {
      return [
        `Error: The worktree decision prompt for session ${session.name} [${sessionId}] could not be delivered to the user.`,
        `Ask the user in plain text whether to merge, open a PR, keep the branch for later, or discard it, then act with agent_merge, agent_pr, or agent_worktree_cleanup.`,
      ].join(" ");
    }
    return [
      delivery === "pending"
        ? `Canonical worktree decision prompt is being delivered for session ${session.name} [${sessionId}].`
        : delivery === "skipped"
          ? `A canonical worktree decision prompt was already sent for session ${session.name} [${sessionId}].`
          : `Canonical worktree decision prompt sent for session ${session.name} [${sessionId}].`,
      `Wait for the user's Merge, Open PR, Later, or Discard response.`,
      `Do not send a separate plain-text worktree decision message.`,
    ].join(" ");
  }

  /**
   * Dispatch a user-facing prompt and wait (bounded) for the direct delivery
   * result, so tools report what actually happened instead of "sent".
   */
  private dispatchAndAwaitUserDelivery(
    session: Parameters<SessionNotificationService["dispatch"]>[0],
    request: SessionNotificationRequest,
  ): Promise<"delivered" | "failed" | "skipped" | "pending"> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: "delivered" | "failed" | "skipped" | "pending") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => settle("pending"), this.userDeliveryResultWaitMs);
      timer.unref?.();
      const hooks = request.hooks;
      this.notifications.dispatch(session, {
        ...request,
        hooks: {
          ...hooks,
          onNotifySucceeded: () => {
            hooks?.onNotifySucceeded?.();
            settle("delivered");
          },
          onNotifyFailed: () => {
            hooks?.onNotifyFailed?.();
            settle("failed");
          },
          onDuplicateSkipped: (reason) => {
            hooks?.onDuplicateSkipped?.(reason);
            settle("skipped");
          },
        },
      });
    });
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

  private async resolveWorktreeRepoDir(repoDir: string | undefined, worktreePath?: string): Promise<string | undefined> {
    if (repoDir && (!worktreePath || !pathsReferToSameLocation(repoDir, worktreePath))) return repoDir;
    if (!worktreePath) return repoDir;
    return (await getPrimaryRepoRootFromWorktree(worktreePath)) ?? repoDir;
  }

  private async formatLaunchWorkdirLabel(session: Pick<Session, "workdir" | "worktreePath" | "originalWorkdir">): Promise<string> {
    if (!session.worktreePath) return session.workdir;
    const repoDir = await this.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
    if (!repoDir || repoDir === session.worktreePath) return session.worktreePath;
    return `${session.worktreePath} (worktree of ${repoDir})`;
  }

  async dismissWorktree(ref: string): Promise<string> {
    return this.worktreeDecisions.dismissWorktree(ref);
  }

  snoozeWorktreeDecision(ref: string, options?: { notifyUser?: boolean }): string {
    return this.worktreeDecisions.snoozeWorktreeDecision(ref, options);
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
    this.clearWaitingTimestampsForSession(session.id);
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
      log.warn(
        `[SessionManager] Auto-merge resolver ${session.id} completed, but original session ${parentRef} could not be found.`,
      );
      return;
    }

    if (session.status === "completed" && parentSession) {
      this.updatePersistedSession(parentRef, { autoMergeResolverSessionId: undefined });
      await this.handleWorktreeStrategy(parentSession);
      return;
    }

    const worktreeBranch = parentSession?.worktreeBranch ?? parentPersisted?.worktreeBranch ?? "unknown";
    const worktreePath = parentSession?.worktreePath ?? parentPersisted?.worktreePath ?? "(unknown worktree)";
    const worktreeBaseBranch = parentSession?.worktreeBaseBranch ?? parentPersisted?.worktreeBaseBranch;
    const worktreePrTargetRepo = parentSession?.worktreePrTargetRepo ?? parentPersisted?.worktreePrTargetRepo;
    const worktreePushRemote = parentSession?.worktreePushRemote ?? parentPersisted?.worktreePushRemote;

    this.updatePersistedSession(parentRef, buildPendingDecisionPatch({
      worktreeBaseBranch,
      worktreePrTargetRepo,
      worktreePushRemote,
    }, {
      clearResolverSessionId: true,
      notes: [
        session.status === "completed"
          ? "auto_merge_conflict_resolver_completed_without_retry_target"
          : "auto_merge_conflict_resolver_failed",
      ],
    }));

    this.dispatchSessionNotification(parentRoutingTarget, {
      label: "worktree-merge-conflict-resolver-failed",
      idempotencyKey: `worktree-merge-conflict-resolver-failed:${parentRef}:${session.id}`,
      userMessage: [
        `⚠️ [${parentRoutingTarget.name}] Auto-merge conflict resolution did not complete successfully.`,
        `Branch \`${worktreeBranch}\` was preserved for manual follow-up in ${worktreePath}.`,
        session.status === "completed"
          ? `The resolver finished, but the original session could not be resumed for the merge retry.`
          : `Resolver session ${session.name} ended with status=${session.status}.`,
      ].join("\n"),
      buttons: await this.getPolicyAwareWorktreeDecisionButtons(
        parentRef,
        { allowDelegate: true },
        parentSession,
        parentPersisted,
      ),
    });
  }

  private persistSession(session: Session, options: { scheduleRuntimeGc?: boolean } = {}): void {
    const scheduleRuntimeGc = options.scheduleRuntimeGc ?? true;
    this.store.persistTerminal(session);
    if (scheduleRuntimeGc) {
      this.syncRuntimeGcDeadline(session);
    }
    this.onPersistedSessionChanged(this.store.getPersistedSession(session.id));
    this.syncSessionOutputCleanupDeadline();
  }

  private async reconcilePersistedTaskFlowMirrors(): Promise<void> {
    let changed = false;
    for (const session of this.store.listPersistedSessions()) {
      let reconciled: Awaited<ReturnType<typeof reconcilePersistedSessionTaskMirror>>;
      try {
        reconciled = await reconcilePersistedSessionTaskMirror(session);
      } catch (err) {
        log.warn(`[SessionTaskLifecycle] reconciliation failed for session ${session.sessionId}:`, err);
        continue;
      }
      if (!reconciled) continue;
      session.taskFlowMirror = reconciled;
      changed = true;
    }
    if (changed) {
      this.store.saveIndex();
    }
  }

  /** Usage metrics derived from the persisted index plus live sessions. */
  getMetrics(): SessionMetrics {
    return computeSessionMetrics(this.store.listPersistedSessions(), [...this.sessions.values()]);
  }

  // -- Wake / notification delivery --

  notifySession(session: Session, text: string, label: string = "notification", idempotencyKey?: string): void {
    this.dispatchSessionNotification(session, {
      label,
      idempotencyKey: label === "agent-respond" ? undefined : idempotencyKey ?? `notify:${session.id}:${label}:${text}`,
      userMessage: text,
      notifyUser: "always",
    });
  }

  async notifyResumedLaunch(session: Session): Promise<void> {
    if (!session.resumeSessionId) return;
    const workdirLabel = await this.formatLaunchWorkdirLabel(session);
    const harnessLabel = formatHarnessModelLabel({
      harness: session.harnessName,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
    }) ?? "default";
    this.notifySession(
      session,
      formatResumedLaunchMessage({
        sessionName: session.name,
        resumedFromSessionName: session.resumedFromSessionName,
        workdirLabel,
        harnessLabel,
      }),
      "resumed-launch",
      `resumed-launch:${session.id}:${session.startedAt}:${session.resumeSessionId}`,
    );
  }

  sendPlanOffer(args: {
    offerId: string;
    route: SessionRoute;
    text: string;
    planName: string;
    planPrompt: string;
    planWorkdir: string;
    planWorktreeStrategy?: WorktreeStrategy;
  }): void {
    const buttons = this.interactions.getPlanOfferButtons({
      offerId: args.offerId,
      route: args.route,
      planName: args.planName,
      planPrompt: args.planPrompt,
      planWorkdir: args.planWorkdir,
      planWorktreeStrategy: args.planWorktreeStrategy,
    });
    this.dispatchSessionNotification(this.buildRoutingProxy({
      id: args.offerId,
      route: args.route,
    }), {
      label: "plan-offer",
      idempotencyKey: `plan-offer:${args.offerId}`,
      userMessage: args.text,
      notifyUser: "always",
      buttons,
    });
  }

  emitGoalTaskUpdate(
    task: Pick<
      GoalTaskState,
      "id" | "name" | "sessionId" | "sessionName" | "route" | "originChannel" | "originThreadId" | "originSessionKey" | "harness" | "model" | "reasoningEffort"
    >,
    text: string,
    label: string = "goal-task",
  ): void {
    const sessionId = task.sessionId ?? task.id;
    const routingProxy = this.buildRoutingProxy({
      id: sessionId,
      name: task.sessionName ?? task.name,
      route: task.route,
    }) as Session & {
      originChannel?: string;
      originThreadId?: string | number;
      originSessionKey?: string;
    };
    const active = task.sessionId ? this.resolve(task.sessionId) : undefined;
    const saved = task.sessionId ? this.getPersistedSession(task.sessionId) : undefined;
    const metadata = active ?? saved ?? task;
    Object.assign(routingProxy, {
      harnessName: "harnessName" in metadata ? metadata.harnessName : metadata.harness,
      model: metadata.model,
      reasoningEffort: metadata.reasoningEffort,
    });
    routingProxy.originChannel = task.originChannel;
    routingProxy.originThreadId = task.originThreadId;
    routingProxy.originSessionKey = task.originSessionKey;
    const requiresGoalSuccessFollowup = label === "goal-task-succeeded";
    const goalSuccessUserMessage = [
      `✅ [${task.name}] Goal task succeeded`,
      task.sessionId ? `Session: ${task.sessionName ?? task.name} [${task.sessionId}]` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const buildWakeMessage = (canonicalStatusDelivered: boolean): string => buildGoalTaskSucceededFollowupWake({
      sessionId,
      sessionName: task.sessionName,
      taskName: task.name,
      summary: text,
      originThreadLine: formatOriginRouteWakeBlock(routingProxy),
      canonicalStatusDelivered,
    });
    this.dispatchSessionNotification(routingProxy, {
      label,
      idempotencyKey: `goal:${task.id}:${label}:${requiresGoalSuccessFollowup ? "success" : text}`,
      userMessage: requiresGoalSuccessFollowup ? goalSuccessUserMessage : text,
      notifyUser: "always",
      completionSummary: requiresGoalSuccessFollowup
        ? {
            required: true,
            producer: "goal",
            outcomeKey: `goal:${task.id}`,
          }
        : undefined,
      completionWakeSummaryRequired: requiresGoalSuccessFollowup,
      completionWakeOutcomeKey: requiresGoalSuccessFollowup ? `goal:${task.id}` : undefined,
      wakeMessageOnNotifySuccess: requiresGoalSuccessFollowup ? buildWakeMessage(true) : undefined,
      wakeMessageOnNotifyFailed: requiresGoalSuccessFollowup ? buildWakeMessage(false) : undefined,
    });
  }

  launchPlanOffer(args: {
    route?: SessionRoute;
    prompt: string;
    workdir: string;
    name?: string;
    worktreeStrategy?: WorktreeStrategy;
  }): Promise<Session> {
    const route = args.route ?? { provider: "system", target: "system" };
    return this.launchSession({
      prompt: args.prompt,
      workdir: args.workdir,
      name: args.name,
      harness: getDefaultHarnessName(),
      permissionMode: "plan",
      planApproval: "ask",
      worktreeStrategy: args.worktreeStrategy ?? "off",
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
  private debounceWaitingEvent(sessionId: string, identityKey?: string): boolean {
    const now = Date.now();
    const debounceKey = identityKey ? `${sessionId}:${identityKey}` : sessionId;
    const lastTs = this.lastWaitingEventTimestamps.get(debounceKey);
    if (lastTs && now - lastTs < WAITING_EVENT_DEBOUNCE_MS) return false;
    this.lastWaitingEventTimestamps.set(debounceKey, now);
    return true;
  }

  private clearWaitingTimestampsForSession(sessionId: string): void {
    this.lastWaitingEventTimestamps.delete(sessionId);
    const sessionPrefix = `${sessionId}:`;
    for (const key of this.lastWaitingEventTimestamps.keys()) {
      if (key.startsWith(sessionPrefix)) {
        this.lastWaitingEventTimestamps.delete(key);
      }
    }
  }

  private originThreadLine(session: Session): string {
    return formatOriginRouteWakeBlock(session);
  }

  private extractLastOutputLine(session: Session): string | undefined {
    const lines = session.getOutput(3);
    const last = lines.filter(l => l.trim()).pop()?.trim();
    return last || undefined;
  }

  private getOutputPreview(session: Session, maxChars: number = 1000): string {
    return getSessionOutputPreview(session, maxChars);
  }

  private resolvePlanApprovalMode(session: Session | PersistedSessionInfo): PlanApprovalMode {
    return session.planApproval ?? pluginConfig.planApproval ?? "delegate";
  }

  private shouldEmitTurnCompleteWake(session: Session): boolean {
    const marker = `${session.startedAt ?? 0}|${session.result?.session_id ?? ""}|${session.result?.num_turns ?? 0}`;
    const prev = this.lastTurnCompleteMarkers.get(session.id);
    if (prev === marker) {
      log.info(
        `[SessionManager] shouldEmitTurnCompleteWake: debounced for session ${session.id} ` +
        `(marker unchanged: ${marker})`,
      );
      return false;
    }
    this.lastTurnCompleteMarkers.set(session.id, marker);
    return true;
  }

  private shouldEmitTerminalWake(session: Session): boolean {
    const marker = `${session.status}|${session.startedAt ?? 0}|${session.result?.session_id ?? ""}|${session.result?.num_turns ?? 0}|${session.killReason}`;
    const prev = this.lastTerminalWakeMarkers.get(session.id);
    if (prev === marker) return false;
    this.lastTerminalWakeMarkers.set(session.id, marker);
    return true;
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
    if (session.pendingPlanApproval) {
      this.clearPlanDecisionTokens(session.id);
      const patch: Partial<PersistedSessionInfo> = {
        lifecycle: "terminal",
        runtimeState: "stopped",
        pendingPlanApproval: false,
        planApprovalContext: undefined,
        approvalState: session.approvalState === "pending" ? "rejected" : session.approvalState,
        planDecisionVersion: (session.planDecisionVersion ?? 0) + 1,
        actionablePlanDecisionVersion: undefined,
        canonicalPlanPromptVersion: undefined,
        approvalPromptRequiredVersion: undefined,
        approvalPromptVersion: undefined,
        approvalPromptStatus: "not_sent",
        approvalPromptTransport: "none",
        approvalPromptMessageKind: "none",
        approvalPromptLastAttemptAt: undefined,
        approvalPromptDeliveredAt: undefined,
        approvalPromptFailedAt: undefined,
      };
      session.applyControlPatch(patch);
      Object.assign(session, patch);
      this.updatePersistedSession(session.id, patch);
    }
    session.kill(reason ?? "user");
    return true;
  }

  /**
   * Remove a finished session's stored record, schedules, action tokens, and
   * output file. Refuses anything that may still need the record: running or
   * suspended sessions, unsettled worktrees, a PR not confirmed merged or
   * closed, and in-flight terminal delivery. Callers check goal ownership.
   */
  async forgetSession(ref: string): Promise<ForgetSessionResult> {
    const active = this.resolve(ref);
    if (active && !TERMINAL_STATUSES.has(active.status)) {
      return { ok: false, reason: "running", name: active.name, id: active.id };
    }
    const persisted = active ? this.store.getPersistedSession(active.id) : this.getPersistedSession(ref);
    if (!persisted) {
      return active ? { ok: false, reason: "running", name: active.name, id: active.id } : { ok: false, reason: "not_found" };
    }
    const id = persisted.sessionId ?? persisted.harnessSessionId;
    const blocked = forgetBlockReason(persisted);
    if (blocked) return { ok: false, ...blocked, name: persisted.name, id };
    const prUrl = persisted.worktreePrUrl;
    if (prUrl) {
      // A released worktree can still be represented by an open PR; keep the
      // record unless GitHub confirms the PR is finished.
      const cwd = persisted.workdir && existsSync(persisted.workdir) ? persisted.workdir : tmpdir();
      const pr = await syncWorktreePRByUrl(cwd, prUrl, persisted.worktreePrTargetRepo);
      if (pr.state !== "merged" && pr.state !== "closed") {
        return { ok: false, reason: "worktree", detail: `PR ${prUrl} is ${pr.state === "none" ? "not confirmed closed" : pr.state}`, name: persisted.name, id };
      }
    }
    // The PR check awaited: re-read so a concurrent resume or update wins.
    const latest = this.store.getPersistedSession(persisted.sessionId ?? ref);
    const current = this.resolve(ref);
    if (!latest || (current && !TERMINAL_STATUSES.has(current.status)) || forgetBlockReason(latest)) {
      return { ok: false, reason: "running", name: persisted.name, id };
    }

    if (current) {
      this.registry.remove(current.id, "forget");
      this.clearWaitingTimestampsForSession(current.id);
      this.lastTurnCompleteMarkers.delete(current.id);
      this.lastTerminalWakeMarkers.delete(current.id);
    }
    const removed = this.store.removePersistedSession(latest.sessionId ?? ref);
    if (!removed) return { ok: false, reason: "not_found" };
    if (removed.sessionId) this.store.deleteActionTokensForSession(removed.sessionId);
    this.maintenance.forgetPersistedSession(removed);
    return { ok: true, name: removed.name, id };
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
    return this.mergeQueue.enqueue(repoDir, fn, onQueued);
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
  resolveAskUserQuestion(
    sessionId: string,
    optionIndex: number,
    context: AskUserQuestionResolutionContext = {},
  ): boolean {
    return this.questions.resolveAskUserQuestion(sessionId, optionIndex, context);
  }

  async resolvePendingInputOption(
    sessionId: string,
    optionIndex: number,
    context: AskUserQuestionResolutionContext = {},
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session?.canSubmitPendingInputOption?.()) {
      if (await session.submitPendingInputOption(optionIndex, context)) {
        this.clearWaitingTimestampsForSession(sessionId);
        return true;
      }
      return false;
    }
    return this.questions.resolveAskUserQuestion(sessionId, optionIndex, context);
  }

  canSubmitPendingInputOption(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.canSubmitPendingInputOption?.() === true;
  }

  pendingInputSubmissionRequiresMore(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.pendingInputSubmissionRequiresMore() === true;
  }

  consumeQuestionAnswerTokens(sessionId: string, requestId: string, questionId?: string): SessionActionToken[] {
    return this.interactions.consumeQuestionAnswerTokens(sessionId, requestId, questionId);
  }

  consumePlanDecisionTokens(sessionId: string, planDecisionVersion: number): SessionActionToken[] {
    return this.interactions.consumePlanDecisionTokens(sessionId, planDecisionVersion);
  }

  dispose(): void {
    this.disposeMaintenance();
    this.questions.dispose();
    this.notifications.dispose();
  }

  async drainTaskLifecycle(): Promise<void> {
    await this.ready;
    await this.runtimeBootstrap.drain();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      this.disposeMaintenance();
      // Stop active sessions first: a launch still preparing (for example running
      // a worktree setup script) must not delay their termination.
      const sessions = [...this.sessions.values()];
      this.killAll("shutdown");
      // Then wait for in-flight maintenance and launches. A launch that finishes
      // preparing now fails its post-preparation shutdown check, and registration
      // happens synchronously after that check, so none can register afterwards.
      await Promise.all([this.maintenance.whenIdle(), this.spawnTail]);
      await Promise.all(sessions.map((session) => session.waitForTeardown()));
      await this.drainTaskLifecycle();
    } finally {
      this.dispose();
    }
  }
}
