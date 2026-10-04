import { createHash } from "crypto";
import { Session } from "./session";
import { pluginConfig, getDefaultHarnessName, resolveAllowedModelsForHarness } from "./config";
import { assertModelAllowedForHarness } from "./harness-models";
import { generateSessionName } from "./format";
import { formatLaunchSummaryFromSession, formatResumedLaunchMessage } from "./launch-summary";
import { appendStatusMetadata, formatHarnessModelLabel, formatReasoningMetadataSuffix } from "./session-display";
import { formatSessionStatsSuffix } from "./session-notification-stats";
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
  resolveLandingBaseBranch,
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
import { matchesGeneration, persistedForActiveGeneration, persistedGeneration, type SessionGeneration } from "./session-generation";
import { SessionMaintenanceService } from "./session-maintenance-service";
import { buildPendingDecisionPatch } from "./worktree-session-patches";
import {
  createRepoPolicyRecord,
  formatUnknownRepoPolicyMessage,
  formatRepoPolicyChoicePrompt,
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
/**
 * Stopping a session whose plan still waits for a decision rejects that plan:
 * the decision is closed and no prompt for it stays actionable.
 */
function pendingPlanRejectedPatch(
  session: Pick<PersistedSessionInfo, "approvalState" | "planDecisionVersion">,
): Partial<PersistedSessionInfo> {
  return {
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
}

/** A chat command's view of a goal notice (the goal controller's `GoalReplyNotice`). */
export type GoalStopReply = {
  sameChat: (task: { route?: SessionRoute; originSessionKey?: string }) => boolean;
  text?: string;
  posted?: boolean;
  taskName?: string;
};

export type GoalSessionStopHandlers = {
  closedWhileDormant: (goalTaskId: string, outcome: "completed" | "killed", reply?: GoalStopReply) => string | undefined;
  stopRunning: (goalTaskId: string, reply?: GoalStopReply) => string | undefined;
};

export class SessionManager {
  private readonly registry: SessionRuntimeRegistry;
  private sessions: Map<string, Session>;
  maxSessions: number;
  maxPersistedSessions: number;

  private lastWaitingEventTimestamps: Map<string, number> = new Map();
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
  /**
   * After a re-offered prompt was reported as still in delivery: how long its
   * outcome may stay out (a little over the direct-send timeout) before the
   * press is answered with the plain failure line anyway.
   */
  reofferLateFallbackMs = 45_000;
  /** Pending re-offers: their fallback timer, and how to answer the press now. */
  private readonly reofferLateFallbacks = new Map<ReturnType<typeof setTimeout>, () => void | Promise<void>>();
  /** Worktree-decision re-offers per session, by generation (see `reofferWorktreeDecision`). */
  private readonly worktreeReoffers = new Map<string, Map<number, { tokens: Set<string>; inFlight: boolean }>>();
  private worktreeReofferGeneration = 0;
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
  private completionWakeRecoveryStarted = false;
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
    this.ready = Promise.resolve();
  }

  /** Called only after the host opens Gateway RPC admission. */
  recoverCompletionWakes(): void {
    if (this.shuttingDown || this.completionWakeRecoveryStarted) return;
    this.completionWakeRecoveryStarted = true;
    this.notifications.recoverAdmittedCompletionWakes(this.store.listPersistedSessions());
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
    // Buttons go out only after their action tokens are on disk.
    const wakeDispatcher = new WakeDispatcher({
      beforeInteractiveSend: () => store.whenPersisted(),
      // Each button's token acts only from the chat it is sent to (N2).
      bindInteractiveButtons: (tokenIds, route) => store.actionTokenStore.bindActionTokensToRoute(tokenIds, {
        provider: route.channel,
        target: route.target,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        ...(route.threadId ? { threadId: route.threadId } : {}),
        ...(route.sessionKey ? { sessionKey: route.sessionKey } : {}),
      }),
    });
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
        confirmCompletionWakeAdmission: (ref, runId, outcomeKey) => store.confirmCompletionWakeAdmission(ref, runId, outcomeKey),
        confirmNotificationInjection: (ref, key, attemptId) => store.confirmNotificationInjection(ref, key, attemptId),
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
      makeDirtyWorktreeButtons: (sessionId) => [[
        manager.makeActionButton(sessionId, "session-resume", "Commit changes", {
          launchPrompt: "Your worktree has uncommitted changes and no commits. Commit the task's real changes with a clear message, and remove temporary files you created.",
        }),
        manager.makeActionButton(sessionId, "view-output", "View output"),
        manager.makeActionButton(sessionId, "worktree-dismiss", "Discard"),
      ]],
      isPrAvailable: async (repoDir) => (await manager.resolveRepoPolicy(repoDir)).prAvailable,
      hasOpenPrForBranch: async (repoDir, branchName, targetRepo, pushRemote) => {
        const status = await syncWorktreePR(repoDir, branchName, targetRepo, undefined, { pushRemote });
        return status.exists && status.state === "open";
      },
      getPrStatusForBranch: (repoDir, branchName, targetRepo, baseBranch, pushRemote) => syncWorktreePR(repoDir, branchName, targetRepo, baseBranch, { pushRemote }),
      getPrStatusForUrl: (repoDir, prUrl, targetRepo, pushRemote) => syncWorktreePRByUrl(repoDir, prUrl, targetRepo, pushRemote),
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
      getCurrentSessionStatus: (session) => (
        manager.get(session.id) ?? manager.getSessionGeneration({ kind: "oca", sessionId: session.id })
      )?.status,
      runAutoPr: async (session, baseBranch, retry) => {
        const { makeAgentPrTool } = await import("./tools/agent-pr");
        const result = await makeAgentPrTool(undefined, { terminalCompletion: !retry }).execute("auto-pr", {
          session: session.id,
          base_branch: baseBranch,
        }) as { content?: Array<{ text?: string }>; meta?: { success?: boolean; outcomeNotified?: boolean; decisionRequested?: boolean } };
        const success = result?.meta?.success === true;
        return {
          success,
          notificationSent: result?.meta?.outcomeNotified === true,
          ...(result?.meta?.decisionRequested === true ? { decisionRequested: true } : {}),
          // The `Reason: …` line under `⚠️ [name] Completed — auto-PR failed`.
          ...(success ? {} : {
            error: result?.content?.[0]?.text?.split("\n")[0]?.replace(/^(?:Error:|❌|⚠️)\s*/u, "").replace(/^Failed to /u, "could not ").trim() || undefined,
          }),
        };
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
        manager.lastTerminalWakeMarkers.delete(sessionId);
      },
      resolveWorktreeRepoDir: (repoDir, worktreePath) => manager.resolveWorktreeRepoDir(repoDir, worktreePath),
      updatePersistedSession: (ref, patch) => manager.updatePersistedSession(ref, patch),
      getMaxPersistedSessions: () => manager.maxPersistedSessions,
    });
    store.onActionTokensChanged(() => {
      manager.syncActionTokenExpiryDeadline();
      manager.pruneWorktreeReoffers();
    });
    const lifecycle = new SessionLifecycleService({
      persistSession: (session) => manager.persistSession(session),
      clearWaitingTimestamp: (sessionId) => { manager.clearWaitingTimestampsForSession(sessionId); },
      handleWorktreeStrategy: (session) => manager.handleWorktreeStrategy(session),
      resolveWorktreeRepoDir: (repoDir, worktreePath) => manager.resolveWorktreeRepoDir(repoDir, worktreePath),
      updatePersistedSession: (ref, patch) => manager.updatePersistedSession(ref, patch),
      dispatchSessionNotification: (session, request) => manager.dispatchSessionNotification(session, request),
      notifySession: (session, text, label, idempotencyKey) => manager.notifySession(session, text, label, idempotencyKey),
      clearRetryTimersForSession: (sessionId) => wakeDispatcher.clearRetryTimersForSession(sessionId),
      shouldEmitTerminalWake: (session) => manager.shouldEmitTerminalWake(session),
      getCurrentSessionStatus: (session) => (
        manager.get(session.id) ?? manager.getSessionGeneration({ kind: "oca", sessionId: session.id })
      )?.status,
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
    this.pruneWorktreeReoffers();
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

  private goalTaskAuthorizer?: (id: string) => void;
  private goalTaskIsActive?: (id: string) => boolean;
  private goalSessionStopHandlers?: GoalSessionStopHandlers;

  /** Internal owner callbacks; session callers cannot provide an authorization snapshot. */
  setGoalTaskAuthorizer(authorizer: (id: string) => void, isActive?: (id: string) => boolean): void {
    this.goalTaskAuthorizer = authorizer;
    this.goalTaskIsActive = isActive;
  }

  /** Internal owner callbacks for stopping a goal through its session (see the two methods below). */
  setGoalSessionStopHandlers(handlers: GoalSessionStopHandlers): void {
    this.goalSessionStopHandlers = handlers;
  }

  /**
   * Tell the goal task that owned a dormant session how the session was
   * closed. The task stops at once with its one `⛔ [task] Goal task stopped`
   * notice (returned in `reply` instead of sent when the command was typed in
   * the task's own chat). Returns the task's name, or undefined when no active
   * task owned the session.
   */
  stopGoalOfClosedSession(goalTaskId: string | undefined, outcome: "completed" | "killed", reply?: GoalStopReply): string | undefined {
    return goalTaskId ? this.goalSessionStopHandlers?.closedWhileDormant(goalTaskId, outcome, reply) : undefined;
  }

  /**
   * Stop the goal task that owns a running session, which also stops the
   * task's sessions: one stop message, the goal's. Returns the task's name,
   * or undefined when no active task owns the session.
   */
  stopGoalOfRunningSession(goalTaskId: string | undefined, reply?: GoalStopReply): string | undefined {
    return goalTaskId ? this.goalSessionStopHandlers?.stopRunning(goalTaskId, reply) : undefined;
  }

  /** A goal that finished or whose record is gone can no longer be driven or succeed. */
  private goalTaskEnded(id: string): boolean {
    return this.goalTaskIsActive ? !this.goalTaskIsActive(id) : false;
  }

  /**
   * Entry-point decision for an explicit continuation (reply, plan decision) of
   * a goal-owned session. An active goal keeps the strict live guard. A goal that
   * had already ended continues as an ordinary session. Work already in flight
   * keeps its strict guard and fails when it discovers a policy change; only a
   * later explicit action detaches. Goal-controller work never detaches.
   */
  continueGoalSession(
    target: { goalTaskId?: string },
    session?: Session,
    options: { fromGoalController?: boolean } = {},
  ): SessionConfig["goalOwnership"] {
    const id = target.goalTaskId;
    if (!id) return undefined;
    if (!options.fromGoalController && this.goalTaskEnded(id)) {
      session?.detachGoal();
      return "detached";
    }
    this.assertGoalTaskAuthorized(id);
    return "attached";
  }

  assertGoalTaskAuthorized(id?: string): void {
    if (!id) return;
    if (!this.goalTaskAuthorizer) throw new Error("Goal controller unavailable; this goal session cannot continue.");
    this.goalTaskAuthorizer(id);
  }

  private goalOwnedLaunch(config: SessionConfig): SessionConfig {
    if (config.forkSession) {
      if (config.sessionIdOverride && (this.sessions.has(config.sessionIdOverride)
        || this.getPersistedSession(config.sessionIdOverride))) {
        throw new Error("An independent fork cannot reuse an existing session identity. Omit sessionIdOverride to create a new session.");
      }
      if (config.goalTaskId) throw new Error("An independent fork cannot claim ownership of an existing goal.");
      return { ...config, goalOwnership: undefined, assertGoalTaskAuthorized: undefined, isGoalTaskEnded: undefined };
    }
    const owners = new Set<string>();
    for (const [ref, identity] of [
      [config.sessionIdOverride, "stable"],
      [config.resumeSessionId, "backend"],
      [config.resumeWorktreeFrom, "either"],
    ] as const) {
      if (!ref) continue;
      // Refresh disk metadata, then prefer canonical identities across ALL rows.
      // A human-facing name alias must never mask an actual goal backend owner.
      const persistedAlias = this.getPersistedSession(ref);
      const active = this.registry.list().filter((candidate) => (
        (identity !== "backend" && candidate.id === ref)
        // A registered deferred resume owns its requested backend before the
        // harness publishes backendRef. Once published, that identity wins.
        || (identity !== "stable" && (getBackendConversationId(candidate) || candidate.resumeSessionId) === ref)
      ));
      const persisted = this.listPersistedSessions().filter((candidate) => (
        (identity !== "backend" && candidate.sessionId === ref)
        || (identity !== "stable" && getBackendConversationId(candidate) === ref)
      ));
      const exact = [...active, ...persisted];
      const candidates = exact.length ? exact : [this.resolve(ref), persistedAlias];
      for (const candidate of candidates) {
        if (candidate?.goalTaskId) owners.add(candidate.goalTaskId);
      }
    }
    if (owners.size > 1) throw new Error("Conflicting canonical goal owners for this resume.");
    const original = [...owners][0];
    if (original && config.goalTaskId && config.goalTaskId !== original) throw new Error("A resumed session cannot change its goal owner.");
    const goalTaskId = original ?? config.goalTaskId;
    // Decided at the first check of a launch: once attached, a later goal end
    // found during preparation fails the launch instead of detaching it.
    if (goalTaskId && config.goalOwnership !== "attached" && this.goalTaskEnded(goalTaskId)) {
      return { ...config, goalTaskId: undefined, goalOwnership: "detached", assertGoalTaskAuthorized: undefined, isGoalTaskEnded: undefined };
    }
    this.assertGoalTaskAuthorized(goalTaskId);
    if (!goalTaskId) return { ...config, goalOwnership: undefined, assertGoalTaskAuthorized: undefined, isGoalTaskEnded: undefined };
    return { ...config, goalTaskId, goalOwnership: "attached",
      assertGoalTaskAuthorized: () => this.assertGoalTaskAuthorized(goalTaskId),
      isGoalTaskEnded: () => this.goalTaskEnded(goalTaskId) };
  }

  /**
   * Spawn and start a new session, wiring lifecycle listeners and launch notification.
   *
   * Launches run one at a time. Preparation (repo policy lookup, worktree
   * creation) is asynchronous, and the next launch's max-session, unique-name,
   * and session-id checks must see the previous launch already registered.
   */
  launchSession(config: SessionConfig, options: LaunchOptions = {}): Promise<Session> {
    try { config = this.goalOwnedLaunch(config); } catch (err) { return Promise.reject(err); }
    const persisted = config.resumeSessionId && config.sessionIdOverride
      ? this.getPersistedSession(config.sessionIdOverride) : undefined;
    const approval = persisted ? buildResumedPlanState(persisted, config.permissionMode ?? pluginConfig.permissionMode) : undefined;
    const expectedApproval = approval?.approvalApplied ? {
      decisionVersion: approval.decisionVersion,
      backendConversationId: getBackendConversationId(persisted!),
    } : undefined;
    const launch = this.spawnTail.then((): Promise<Session> => this.launchSerialized(config, options, expectedApproval));
    this.spawnTail = launch.then((): void => undefined, (): void => undefined);
    return launch;
  }

  private async launchSerialized(
    config: SessionConfig,
    options: LaunchOptions,
    expectedApproval?: { decisionVersion?: number; backendConversationId?: string },
  ): Promise<Session> {
    if (this.shuttingDown) {
      throw new Error("Cannot launch a session: the code-agent service is shutting down.");
    }
    config = this.goalOwnedLaunch(config);
    const activeCount = this.registry.activeSessionCount();
    if (activeCount >= this.maxSessions) {
      throw new Error(`Max sessions reached (${this.maxSessions}). Use agent_sessions to list active sessions and agent_kill to end one.`);
    }

    const assertCurrentApproval = (): void => {
      if (!expectedApproval) return;
      const current = this.getPersistedSession(config.sessionIdOverride!);
      const approval = current ? buildResumedPlanState(current, "bypassPermissions") : undefined;
      if (!approval?.approvalApplied
        || approval.decisionVersion !== expectedApproval.decisionVersion
        || getBackendConversationId(current!) !== expectedApproval.backendConversationId
        || expectedApproval.backendConversationId !== config.resumeSessionId) {
        throw new Error(`Cannot resume approved plan: its plan decision changed during resume preparation.`);
      }
    };
    // Approval may have been superseded while this launch waited in spawnTail.
    assertCurrentApproval();

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

    config = this.goalOwnedLaunch(config);
    const preparedLaunch = await this.restore.prepareSpawn(config, name);
    config = this.goalOwnedLaunch(config);
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

    // Reject/Revise may also arrive during asynchronous repo/worktree preparation.
    assertCurrentApproval();

    // Inject AskUserQuestion intercept for CC sessions. Codex App Server exposes
    // structured pending input natively, so only Claude needs the tool intercept.
    // Use a late-bound wrapper so we can capture session.id after construction.
    const harnessName = config.harness ?? "claude-code";
    const selfRef = this;
    let sessionIdRef: string | undefined;
    const canUseTool = (harnessName === "claude-code" && !config.canUseTool)
      ? async (_toolName: string, input: Record<string, unknown>, context?: AskUserQuestionResolutionContext) => {
          if (!sessionIdRef) throw new Error("canUseTool called before session ID was set");
          return selfRef.handleAskUserQuestion(sessionIdRef, input, context);
        }
      : config.canUseTool;

    const session = new Session({
      ...config,
      workdir: preparedLaunch.actualWorkdir,
      systemPrompt: preparedLaunch.effectiveSystemPrompt,
      // The worktree preamble is added again when a resume prepares its worktree.
      launchSystemPrompt: config.systemPrompt,
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
        userMessage: formatRepoPolicyChoicePrompt(resolution.identity, resolution.prAvailable),
        notifyUser: "always",
        requireDirectUserNotification: true,
        buttons,
        // No success wake: the agent_launch result already tells the orchestrator to wait (N37).
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

  /** False when another writer of the index persisted a consumption of this token first. */
  confirmActionTokenConsumption(tokenId: string, consumptionId: string | undefined): boolean {
    return this.store.confirmActionTokenConsumption(tokenId, consumptionId);
  }

  getActionToken(tokenId: string): SessionActionToken | undefined {
    return this.interactions.getActionToken(tokenId);
  }

  /** True when the token was minted by another writer of the index and adopted from disk. */
  isAdoptedActionToken(tokenId: string): boolean {
    return this.store.actionTokenStore.isAdopted(tokenId);
  }

  /**
   * True when another writer of the session index reports this session as running
   * and it is not live here. Only the owning runtime may act on a live session, so
   * callers must not resume, approve, or answer it from this runtime.
   */
  isSessionOwnedElsewhere(ref: string): boolean {
    if (this.resolve(ref)) return false;
    return this.store.isSessionOwnedElsewhere(ref);
  }

  /** Resolves once no session-index save is deferred behind another writer's lock. */
  whenStorePersisted(): Promise<void> {
    return this.store.whenPersisted();
  }

  /** Runtime and store identity for diagnostics (never token values). */
  getStoreDiagnostics(): ReturnType<SessionStore["getDiagnostics"]> {
    return this.store.getDiagnostics();
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
      wakeDelivery: "next-turn",
      wakeMessageOnNotifyFailed: buildPlanApprovalDeliveryFailureWake({ session, planDecisionVersion }),
      failureWakeConfirmsNotificationDelivery: false,
    });
  }

  private async getWorktreeDecisionButtons(
    sessionId: string,
    options: { allowDelegate?: boolean; newPr?: boolean } = {},
    allowedActions: { merge: boolean; pr: boolean } = { merge: true, pr: true },
  ): Promise<NotificationButton[][] | undefined> {
    const session = this.resolve(sessionId) ?? this.getPersistedSession(sessionId);
    if (!session || (session.worktreeStrategy === "delegate" && options.allowDelegate !== true)) return undefined;
    // A PR found closed without merging is recorded on the row, so the 🔀
    // prompt, the reminders and the re-offer all show New PR.
    const newPr = options.newPr === true || this.getPersistedSession(sessionId)?.worktreePrClosed === true;
    return this.interactions.getWorktreeDecisionButtons(sessionId, session, allowedActions, { newPr });
  }

  private async getPolicyAwareWorktreeDecisionButtons(
    sessionId: string,
    options: { allowDelegate?: boolean; newPr?: boolean } = {},
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
      outcomeSummaryShown?: boolean;
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
    // `delegate` and `approve` leave the decision to the orchestrator, which
    // escalates here; `ask` already sent the user the canonical prompt.
    if (this.resolvePlanApprovalMode(session) === "ask") {
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
        wakeDelivery: "next-turn",
      },
    );

    return [
      `Canonical plan approval prompt queued for session ${session.name} [${sessionId}].`,
      `Wait for the user's Approve, Revise, or Reject response.`,
      `Do not send a separate plain-text approval message.`,
    ].join(" ");
  }

  /**
   * Post the canonical Merge / Open PR / Later / Discard prompt to the user.
   * With `hookWarning` (a branch that changes hook or worktree-setup files, so
   * the orchestrator may not merge it) the prompt names those files and is
   * sent whatever the worktree strategy.
   */
  async requestWorktreeDecisionFromUser(ref: string, summary: string, options: { hookWarning?: string } = {}): Promise<string> {
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) return "Error: summary must not be empty.";

    const activeSession = this.resolve(ref);
    const persistedSession = activeSession
      ? this.getPersistedForActiveGeneration(activeSession)
      : this.getPersistedSession(ref);
    const session = activeSession ?? persistedSession;
    if (!session) return `Error: Session "${ref}" not found.`;
    if (!options.hookWarning && session.worktreeStrategy !== "delegate") {
      return `Error: Session "${ref}" already uses direct user worktree decisions. Do not send a duplicate decision prompt.`;
    }
    const pendingWorktreeDecisionSince = "pendingWorktreeDecisionSince" in session
      ? session.pendingWorktreeDecisionSince
      : undefined;
    const pendingDecision =
      Boolean(pendingWorktreeDecisionSince)
      || session.worktreeState === "pending_decision"
      || session.worktreeLifecycle?.state === "pending_decision";
    if (!options.hookWarning && !pendingDecision) {
      return `Error: Session "${ref}" is not awaiting a delegated worktree decision.`;
    }

    const sessionId = getPrimarySessionLookupRef(activeSession ?? persistedSession ?? { id: ref }) ?? ref;
    const worktreePath = activeSession?.worktreePath ?? persistedSession?.worktreePath;
    const branchName = activeSession?.worktreeBranch ?? persistedSession?.worktreeBranch;
    const selectedWorkdir = activeSession?.originalWorkdir ?? persistedSession?.workdir;
    const legacyBinding = activeSession && persistedSession && !persistedSession.sessionId
      ? persistedGeneration(persistedSession) : undefined;
    const repoDir = await this.resolveWorktreeRepoDir(
      selectedWorkdir,
      worktreePath,
    );
    if (!worktreePath) return `Error: Session "${ref}" has no managed worktree path.`;
    if (!branchName) return `Error: Session "${ref}" has no managed worktree branch.`;
    if (!repoDir) return `Error: Session "${ref}" has no resolvable repository root for worktree ${worktreePath}.`;

    const baseBranch = await resolveLandingBaseBranch(persistedSession ?? activeSession, repoDir);
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

    // Legacy metadata was admitted only by a unique exact active/row pairing.
    // Root/diff/button preparation awaits; prove that same pairing at dispatch.
    if (legacyBinding && activeSession) {
      const currentActive = this.get(activeSession.id);
      const currentRow = currentActive ? this.getPersistedForActiveGeneration(currentActive) : undefined;
      const samePath = (a?: string, b?: string) => a === b || pathsReferToSameLocation(a, b);
      if (!currentRow || !matchesGeneration(currentRow, legacyBinding)
        || !samePath(currentActive?.worktreePath ?? currentRow.worktreePath, worktreePath)
        || (currentActive?.worktreeBranch ?? currentRow.worktreeBranch) !== branchName
        || !samePath(currentActive?.originalWorkdir ?? currentRow.workdir, selectedWorkdir)) {
        return "Error: The selected legacy worktree target changed before the decision could be delivered.";
      }
    }

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
        hookWarning: options.hookWarning,
        buttons,
        // No `backendInfo`: the routing proxy has none, and both footers must agree.
        stats: {
          costUsd: session.costUsd,
          ...(activeSession
            ? { duration: activeSession.duration, harnessName: activeSession.harnessName }
            : { createdAt: persistedSession?.createdAt, completedAt: persistedSession?.completedAt, harness: persistedSession?.harness }),
          model: session.model,
          reasoningEffort: session.reasoningEffort,
        },
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
          // Outcome unknown (for example a send that timed out): a caller that
          // handles it stops waiting; it decides what the user still gets.
          ...(hooks?.onNotifyAmbiguous ? {
            onNotifyAmbiguous: () => {
              hooks.onNotifyAmbiguous?.();
              settle("pending");
            },
          } : {}),
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

  private worktreeDecisionIsOpen(ref: string): boolean {
    const persisted = this.getPersistedSession(ref);
    if (!persisted) return Boolean(this.resolve(ref)?.worktreePath);
    const state = persisted.worktreeLifecycle?.state;
    if (state === "merged" || state === "released" || state === "dismissed" || state === "no_change") return false;
    if (persisted.worktreeMerged || persisted.worktreeDismissedAt) return false;
    return Boolean(persisted.worktreePath || persisted.worktreeBranch);
  }

  /**
   * Forget re-offer entries that can no longer matter: the decision closed,
   * the session is gone, or none of the entry's button tokens exists any more
   * (expired or deleted; a used token still exists until it is deleted).
   * Without this an entry whose delivery outcome never arrives would stay in
   * flight forever.
   */
  private pruneWorktreeReoffers(): void {
    for (const [ref, reoffers] of this.worktreeReoffers) {
      const open = this.worktreeDecisionIsOpen(ref);
      for (const [generation, entry] of reoffers) {
        if (!open || ![...entry.tokens].some((tokenId) => this.getActionToken(tokenId))) reoffers.delete(generation);
      }
      if (reoffers.size === 0) this.worktreeReoffers.delete(ref);
    }
  }

  /**
   * Re-offer an open worktree decision after a button action failed (merge, PR,
   * or discard). A callback consumes its token before acting, so another writer
   * of the index can never run the same button; the controls the user clicked
   * are therefore spent. This sends the decision again with a fresh set of
   * buttons and, once that message is delivered, retires the older decision
   * buttons. If the new message cannot be delivered, its buttons are dropped and
   * the older ones stay usable. Resolves true only when the new controls were
   * delivered, so the caller may clear the spent ones, and `"pending"` when the
   * delivery is still in flight after the bounded wait: the prompt is then the
   * answer, and `onLateResult` reports how it ended (false also when the
   * outcome stays unknown, so the caller never leaves the user without a message). `closedPr` (the PR action
   * found its PR closed without merging) replaces Open PR / Sync PR by a
   * **New PR** button, which opens a fresh pull request.
   */
  async reofferWorktreeDecision(
    ref: string,
    failure: string,
    options: { closedPr?: boolean; onLateResult?: (delivered: boolean) => void | Promise<void> } = {},
  ): Promise<boolean | "pending"> {
    const decisionIsOpen = (): boolean => this.worktreeDecisionIsOpen(ref);
    if (!decisionIsOpen()) return false;
    const active = this.resolve(ref);
    const persisted = this.getPersistedSession(ref);
    const buttons = await this.getPolicyAwareWorktreeDecisionButtons(ref, { allowDelegate: true, newPr: options.closedPr }, active, persisted);
    const fresh = new Set((buttons ?? []).flat().filter((button) => !button.url).map((button) => button.callbackData));
    if (fresh.size === 0) return false;
    // Several re-offers of one decision can overlap (a second failed action
    // while the first retry prompt is still being delivered). A delivered retry
    // retires only older controls: never those of a newer retry or of one still
    // in flight, so every delivered prompt keeps working buttons.
    const reoffers = this.worktreeReoffers.get(ref) ?? new Map<number, { tokens: Set<string>; inFlight: boolean }>();
    this.worktreeReoffers.set(ref, reoffers);
    const generation = ++this.worktreeReofferGeneration;
    const entry = { tokens: fresh, inFlight: true };
    reoffers.set(generation, entry);
    const settleEntry = (): void => {
      entry.inFlight = false;
    };
    const retireOlder = (): void => {
      const keep = new Set<string>();
      for (const [otherGeneration, other] of reoffers) {
        if (otherGeneration >= generation || other.inFlight) {
          for (const tokenId of other.tokens) keep.add(tokenId);
        } else {
          reoffers.delete(otherGeneration);
        }
      }
      this.interactions.clearWorktreeDecisionTokens(ref, keep);
    };
    const dropFresh = (): void => {
      reoffers.delete(generation);
      if (reoffers.size === 0) this.worktreeReoffers.delete(ref);
      for (const tokenId of fresh) this.interactions.deleteActionToken(tokenId);
    };
    const name = active?.name ?? persisted?.name ?? ref;
    const branch = active?.worktreeBranch ?? persisted?.worktreeBranch;
    const target = active ?? this.buildRoutingProxy({
      id: ref,
      name,
      sessionId: persisted?.sessionId,
      harnessSessionId: persisted?.harnessSessionId,
      backendRef: persisted?.backendRef,
      route: persisted?.route,
    });
    // Set once the bounded wait is over: a result after that is a late one.
    let waitEnded = false;
    // The send ended without a known outcome (it timed out): the prompt may or
    // may not have arrived.
    let ambiguous = false;
    // The outcome of a prompt reported as "pending" is passed on exactly once.
    // When none arrives (the plugin stopped mid-send, or the decision closed
    // while the send was in flight), a bounded timer, or the plugin's dispose,
    // reports "not delivered", so the press is never left without a message.
    // The entry stays in flight then: its buttons remain valid, and a newer
    // re-offer cannot retire them, in case the prompt still lands.
    let lateFallback: ReturnType<typeof setTimeout> | undefined;
    let lateReported = false;
    const reportLate = (delivered: boolean): void | Promise<void> => {
      if (lateFallback) {
        clearTimeout(lateFallback);
        this.reofferLateFallbacks.delete(lateFallback);
        lateFallback = undefined;
      }
      if (!waitEnded || lateReported) return;
      lateReported = true;
      return options.onLateResult?.(delivered);
    };
    const delivery = await this.dispatchAndAwaitUserDelivery(target, {
      label: "worktree-decision-retry",
      idempotencyKey: `worktree-decision-retry:${ref}:${Date.now()}`,
      // After a failed button: `❌ [name] Merge failed: <reason>. The decision for `b` is still open.`
      userMessage: `❌ [${name}] ${failure}${failure.endsWith(".") ? " " : "\n"}The decision${branch ? ` for \`${branch}\`` : ""} is still open.${options.closedPr ? " New PR opens a fresh pull request." : ""}`,
      notifyUser: "always",
      requireDirectUserNotification: true,
      buttons,
      shouldDispatch: decisionIsOpen,
      hooks: {
        onNotifySucceeded: () => {
          settleEntry();
          retireOlder();
          void reportLate(true);
        },
        onNotifyFailed: () => {
          settleEntry();
          dropFresh();
          void reportLate(false);
        },
        // Unknown outcome: the fresh buttons stay valid in case the prompt did
        // arrive, the older ones stay too, and the caller sends its plain
        // failure line. A duplicate is acceptable; silence is not.
        onNotifyAmbiguous: () => {
          settleEntry();
          ambiguous = true;
          void reportLate(false);
        },
      },
    });
    waitEnded = true;
    if (ambiguous) return false;
    if (delivery === "failed" || delivery === "skipped") dropFresh();
    if (delivery !== "pending") return delivery === "delivered";
    lateFallback = setTimeout(() => { void reportLate(false); }, this.reofferLateFallbackMs);
    lateFallback.unref?.();
    this.reofferLateFallbacks.set(lateFallback, () => reportLate(false));
    return "pending";
  }

  /**
   * Handle worktree merge-back strategy when a session with a worktree terminates.
   * Called from onSessionTerminal BEFORE worktree cleanup.
   */
  private async handleWorktreeStrategy(session: Session, options?: { retryAfterConflict?: boolean }): Promise<WorktreeStrategyResult> {
    return this.worktreeStrategy.handleWorktreeStrategy(session, options);
  }

  private async onSessionTerminal(session: Session): Promise<void> {
    // The backend that asked is gone; a late button must not "answer" it.
    this.questions.discardAskUserQuestion(session.id);
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
      // The parent's terminal cycle already said `⚠️ … Completed — merge conflict`.
      const retried = await this.handleWorktreeStrategy(parentSession, { retryAfterConflict: true });
      if (!retried.notificationSent) {
        // The user was told the merge is retried: say how it ended when the
        // retry itself sent nothing (already merged, PR up to date, or skipped
        // because the session runs again or its worktree was settled meanwhile).
        const landed = this.getPersistedSession(parentRef);
        const prUrl = landed?.worktreePrUrl ?? parentSession.worktreePrUrl;
        this.dispatchSessionNotification(parentSession, {
          label: "worktree-retry-settled",
          idempotencyKey: `worktree-retry-settled:${parentRef}:${session.id}`,
          userMessage: `ℹ️ [${parentSession.name}] ${
            landed?.worktreeMerged || landed?.worktreeLifecycle?.state === "merged"
              ? "Already merged; nothing left to do."
              : prUrl ? `PR: ${prUrl}` : "Conflict resolved; nothing was merged automatically. The branch is kept."}`,
          notifyUser: "always",
        });
      }
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
          : `Resolver session ${session.name} ${session.status === "failed" ? "failed" : "was stopped"}.`,
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

  /**
   * Queue context for the orchestrator's next turn in the session's origin chat
   * (a system event without a heartbeat; nothing runs now). For example after
   * the user pressed Revise, so their next chat message is forwarded as plan
   * feedback (N35).
   */
  queueOrchestratorContext(ref: string, label: string, text: string, idempotencyKey?: string): boolean {
    const active = this.resolve(ref);
    const persisted = active ? undefined : this.getPersistedSession(ref);
    if (!active && !persisted) return false;
    const target = active ?? this.buildRoutingProxy({
      id: persisted!.sessionId,
      name: persisted!.name,
      sessionId: persisted!.sessionId,
      harnessSessionId: persisted!.harnessSessionId,
      backendRef: persisted!.backendRef,
      route: persisted!.route,
    });
    this.dispatchSessionNotification(target, {
      label,
      idempotencyKey,
      wakeMessage: text,
      wakeDelivery: "next-turn",
      notifyUser: "never",
    });
    return true;
  }

  /** Returns the `▶️ [name] Resumed | …` line; `send: false` leaves it to the caller's reply. */
  async notifyResumedLaunch(session: Session, send = true): Promise<string | undefined> {
    if (!session.resumeSessionId) return undefined;
    const workdirLabel = await this.formatLaunchWorkdirLabel(session);
    const harnessLabel = formatHarnessModelLabel({
      harness: session.harnessName,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
    }) ?? "default";
    const text = formatResumedLaunchMessage({
      sessionName: session.name,
      resumedFromSessionName: session.resumedFromSessionName,
      workdirLabel,
      harnessLabel,
    });
    if (send) this.notifySession(session, text, "resumed-launch", `resumed-launch:${session.id}:${session.startedAt}:${session.resumeSessionId}`);
    return text;
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

  /** Ask the user to confirm the verifier commands of a goal task the orchestrator launched. */
  sendGoalVerifierConfirmation(
    task: Pick<GoalTaskState, "id" | "name" | "route" | "originChannel" | "originThreadId" | "originSessionKey">,
    text: string,
  ): void {
    const routingProxy = this.buildRoutingProxy({ id: task.id, name: task.name, route: task.route }) as Session & {
      originChannel?: string;
      originThreadId?: string | number;
      originSessionKey?: string;
    };
    routingProxy.originChannel = task.originChannel;
    routingProxy.originThreadId = task.originThreadId;
    routingProxy.originSessionKey = task.originSessionKey;
    this.dispatchSessionNotification(routingProxy, {
      label: "goal-verifier-confirmation",
      idempotencyKey: `goal-verifier-confirmation:${task.id}`,
      userMessage: text,
      notifyUser: "always",
      buttons: this.interactions.getGoalVerifierButtons(task.id, task.route),
    });
  }

  emitGoalTaskUpdate(
    task: Pick<
      GoalTaskState,
      "id" | "name" | "sessionId" | "sessionName" | "route" | "originChannel" | "originThreadId" | "originSessionKey" | "harness" | "model" | "reasoningEffort"
    > & Partial<Pick<GoalTaskState, "totalCostUsd" | "createdAt" | "updatedAt" | "lastCostedRun">>,
    text: string,
    label: string = "goal-task",
    /** A chat command shows the returned line as its reply; nothing is sent. */
    replyOnly = false,
  ): string {
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
    // Terminal goal lines carry the footer: the task's total cost and duration
    // (else the session's cost); the dispatcher adds harness, model and reasoning.
    // A task that never ran (declined at confirmation, failed before its
    // launch) has none. A run that was stopped or failed in flight is not in
    // the total yet.
    const inFlightCostUsd = active && task.lastCostedRun !== `${active.id}:${active.startedAt}` && active.costUsd > 0
      ? active.costUsd
      : 0;
    const goalFooter = task.sessionId && (requiresGoalSuccessFollowup || label === "goal-task-failed" || label === "goal-task-stopped")
      ? formatSessionStatsSuffix({
          costUsd: task.totalCostUsd !== undefined ? task.totalCostUsd + inFlightCostUsd : (active ?? saved)?.costUsd,
          createdAt: task.createdAt,
          completedAt: task.updatedAt,
        })
      : "";
    const newline = text.indexOf("\n");
    const userText = goalFooter && !requiresGoalSuccessFollowup
      ? (newline < 0 ? `${text}${goalFooter}` : `${text.slice(0, newline)}${goalFooter}${text.slice(newline)}`)
      : text;
    const goalSuccessUserMessage = [
      `✅ [${task.name}] Completed — goal succeeded${goalFooter}`,
      task.sessionName && task.sessionName !== task.name ? `Session: ${task.sessionName}` : undefined,
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
    const userMessage = requiresGoalSuccessFollowup ? goalSuccessUserMessage : userText;
    if (replyOnly && !requiresGoalSuccessFollowup) {
      // A dispatched notice gets harness, model and reasoning from the
      // dispatcher. A terminal line returned as the command's reply carries
      // the same footer; other replies have no short suffix.
      return label === "goal-task-failed" || label === "goal-task-stopped"
        ? appendStatusMetadata(userMessage, formatReasoningMetadataSuffix({
            harness: routingProxy.harnessName ?? saved?.harness,
            model: routingProxy.model ?? saved?.model,
            reasoningEffort: routingProxy.reasoningEffort ?? saved?.reasoningEffort,
          }))
        : userMessage;
    }
    this.dispatchSessionNotification(routingProxy, {
      label,
      idempotencyKey: `goal:${task.id}:${label}:${requiresGoalSuccessFollowup ? "success" : text}`,
      userMessage,
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
    return userMessage;
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
    // Killing a session with a pending plan rejects the plan, except when the
    // Gateway shuts down: the plan decision survives the restart, and the
    // user's Approve / Revise / Reject resumes the session like an idle-suspended one.
    if (session.pendingPlanApproval && reason !== "shutdown") {
      this.clearPlanDecisionTokens(session.id);
      const patch = pendingPlanRejectedPatch(session);
      session.applyControlPatch(patch);
      Object.assign(session, patch);
      this.updatePersistedSession(session.id, patch);
    }
    session.kill(reason ?? "user");
    return true;
  }

  /**
   * Close a suspended session (stopped by the idle timeout, or recovered after
   * a Gateway restart): nothing is running, so only its record is closed and
   * no user notice is sent. A plan that still waits for a decision is rejected
   * and its buttons are retired, as `kill()` does for a running session, so a
   * goal task that waits for it stops. Question and Resume buttons are left as
   * `kill()` leaves them: a stopped session stays resumable. A session that is
   * still loaded is persisted and unloaded first, as runtime GC does, so the
   * stored row is the one record and a later re-persist cannot reopen it.
   * Returns the status the session was closed with (a session that was never
   * persisted can only be stopped), undefined when it is not suspended, and
   * `"unsaved"` when its row could not be updated (it is still dormant; the
   * call can be repeated).
   */
  closeSuspendedSession(ref: string, completed: boolean): "completed" | "killed" | "unsaved" | undefined {
    const active = this.resolve(ref);
    const target = active ?? this.getPersistedSession(ref);
    // Suspended, or stopped by the idle timeout or a shutdown while its plan
    // waited (that one keeps the lifecycle `awaiting_plan_decision`; a user
    // stop would have rejected the plan).
    const dormant = target?.status === "killed"
      && (target.lifecycle === "suspended" || (target.lifecycle === "awaiting_plan_decision" && target.pendingPlanApproval === true));
    if (!target || !dormant) return undefined;
    const closedPatch = (asCompleted: boolean): Partial<PersistedSessionInfo> => ({
      ...(target.pendingPlanApproval ? pendingPlanRejectedPatch(target) : {}),
      status: asCompleted ? "completed" : "killed",
      lifecycle: "terminal",
      runtimeState: "stopped",
      resumable: false,
      killReason: asCompleted ? "done" : "user",
    });
    // The plan's buttons are retired only once the close is recorded: an
    // unsaved close leaves the dormant plan with working buttons.
    const planRef = active?.id ?? ("sessionId" in target ? target.sessionId : undefined) ?? ref;
    const hadPendingPlan = target.pendingPlanApproval === true;
    const saved = (updateRef: string): "completed" | "killed" | "unsaved" => {
      if (!this.updatePersistedSession(updateRef, closedPatch(completed))) return "unsaved";
      if (hadPendingPlan) this.clearPlanDecisionTokens(planRef);
      return completed ? "completed" : "killed";
    };
    if (!active) return saved(ref);
    this.persistSession(active, { scheduleRuntimeGc: false });
    if (this.store.getPersistedSession(active.id)?.sessionId !== active.id) {
      // Never persisted (no backend conversation yet): there is no row to mark
      // completed, and a loaded session's status cannot change, so it is stopped.
      const controlPatch: Partial<PersistedSessionInfo> = {
        ...(active.pendingPlanApproval ? pendingPlanRejectedPatch(active) : {}),
        lifecycle: "terminal",
        runtimeState: "stopped",
      };
      active.killReason = "user";
      active.applyControlPatch(controlPatch);
      Object.assign(active, controlPatch);
      if (hadPendingPlan) this.clearPlanDecisionTokens(planRef);
      return "killed";
    }
    this.registry.remove(active.id, "closed-while-suspended");
    this.maintenance.cancelRuntimeGc(active.id);
    this.clearWaitingTimestampsForSession(active.id);
    this.lastTerminalWakeMarkers.delete(active.id);
    return saved(active.id);
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

  getSessionGeneration(generation: SessionGeneration): PersistedSessionInfo | undefined {
    return this.store.getSessionGeneration(generation);
  }

  private getPersistedForActiveGeneration(active: Session): PersistedSessionInfo | undefined {
    return persistedForActiveGeneration(active, {
      getSessionGeneration: (generation) => this.getSessionGeneration(generation),
      listPersistedSessions: () => this.listPersistedSessions(),
      listActiveSessions: () => this.list("all"),
    });
  }

  updateSessionGeneration(generation: SessionGeneration, patch: Partial<PersistedSessionInfo>, options: { persisted: boolean }): boolean {
    const existing = options.persisted ? this.store.getSessionGeneration(generation) : undefined;
    if (options.persisted && !existing) return false;
    const updated = this.stateSync.applyGenerationPatch(generation, existing, patch);
    if (updated && existing) this.onPersistedSessionChanged(existing);
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
    context?: AskUserQuestionResolutionContext,
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found for AskUserQuestion intercept`);
    }
    this.assertGoalTaskAuthorized(session.goalTaskId);
    const answer = await this.questions.handleAskUserQuestion(session, input, context);
    this.assertGoalTaskAuthorized(session.goalTaskId);
    return answer;
  }

  /**
   * Resolve a pending AskUserQuestion by option index (from button callback).
   */
  resolveAskUserQuestion(
    sessionId: string,
    optionIndex: number,
    context: AskUserQuestionResolutionContext = {},
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      // The user's answer is an explicit action: an ended goal detaches the session.
      this.continueGoalSession(session, session);
      assertModelAllowedForHarness(session.harnessName, session.model, resolveAllowedModelsForHarness(session.harnessName));
    }
    return this.questions.resolveAskUserQuestion(sessionId, optionIndex, context);
  }

  async resolvePendingInputOption(
    sessionId: string,
    optionIndex: number,
    context: AskUserQuestionResolutionContext = {},
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    // A stopped session cannot take the answer; callers resume it instead.
    if (session && session.status !== "running") return false;
    if (session?.canSubmitPendingInputOption?.()) {
      if (await session.submitPendingInputOption(optionIndex, context)) {
        this.clearWaitingTimestampsForSession(sessionId);
        return true;
      }
      return false;
    }
    return this.resolveAskUserQuestion(sessionId, optionIndex, context);
  }

  /**
   * Whether a question button still targets the live session's open question.
   * `undefined` when the session is not running here (the caller then decides,
   * for example by resuming a suspended session with the answer).
   */
  isQuestionAnswerTokenCurrent(sessionId: string, requestId?: string, questionId?: string): boolean | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") return undefined;
    if (!requestId) return true;
    const state = session.pendingInputState;
    if (!state) {
      // A Claude question the session has not applied yet is still current.
      return this.pendingAskUserQuestions.get(sessionId)?.requestId === requestId;
    }
    if (state.requestId !== requestId) return false;
    if (!questionId) return true;
    const activeIndex = state.activeQuestionIndex ?? 0;
    const activeQuestionId = state.questions?.[activeIndex]?.id
      ?? (state.activeQuestionIndex != null ? `q${state.activeQuestionIndex}` : undefined);
    return !activeQuestionId || activeQuestionId === questionId;
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
    // Normally empty: `shutdown()` answered pending presses first.
    void this.answerPendingReoffers();
    this.disposeMaintenance();
    this.questions.dispose();
    this.notifications.dispose();
    // A save deferred behind another writer's index lock must not be lost.
    this.store.flushPendingSave();
  }

  async drainTaskLifecycle(): Promise<void> {
    await this.ready;
    await this.runtimeBootstrap.drain();
  }

  /**
   * A press whose re-offered prompt is still in delivery gets its plain failure
   * line now: once the plugin stops, no delivery outcome is reported any more.
   * The line is a reply through the host's callback responder (the channel's
   * own send), so it does not depend on this plugin's transports. Waits,
   * bounded, until those replies were handed to the host.
   */
  async answerPendingReoffers(): Promise<void> {
    const answers = [...this.reofferLateFallbacks.values()].map((answerNow) => answerNow());
    this.reofferLateFallbacks.clear();
    const pending = answers.filter((answer): answer is Promise<void> => answer instanceof Promise);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      // First, while the channels are still up: answer presses that still wait.
      await this.answerPendingReoffers();
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
