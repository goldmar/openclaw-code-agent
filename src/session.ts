import { EventEmitter } from "events";
import { shortId } from "./short-id";
import { getDefaultHarness, getHarness } from "./harness";
import type {
  AgentHarness,
  HarnessBackendInfo,
  HarnessMessage,
  HarnessSession,
  HarnessUsage,
} from "./harness";
import type {
  ApprovalExecutionState,
  PendingInputState,
  PlanArtifact,
  SessionConfig,
  SessionStatus,
  PermissionMode,
  KillReason,
  ReasoningEffort,
  WorktreeStrategy,
  CanUseToolCallback,
  PlanApprovalMode,
  PlanApprovalContext,
  SessionLifecycle,
  SessionApprovalState,
  SessionApprovalPromptMessageKind,
  SessionApprovalPromptTransport,
  PersistedWorktreeLifecycle,
  SessionApprovalPromptStatus,
  SessionWorktreeState,
  SessionRuntimeState,
  SessionDeliveryState,
  SessionRoute,
  SessionBackendRef,
  RepoIntegrationPolicy,
  RepoProviderKind,
  PersistedTaskFlowMirror,
  ThreadAction,
} from "./types";
import {
  pluginConfig,
  resolveDefaultModelForHarness,
  resolveFastModeForHarness,
  resolveReasoningEffortForHarness,
} from "./config";
import { getBackendConversationId } from "./session-backend-ref";
import { canonicalizeModelForHarness } from "./harness-models";
import {
  reduceSessionControlState,
  SESSION_STATUS_TRANSITIONS,
  type SessionControlEvent,
  type SessionControlPatch,
  type SessionControlState,
  applySessionControlPatch,
} from "./session-state";
import { MessageStream } from "./session-message-stream";
import { appendSessionOutput } from "./session-output";
import { SessionTimerRegistry } from "./session-timer-registry";
import { SessionTurnRuntime } from "./session-turn-runtime";
import { SessionHarnessEventApplier } from "./session-harness-event-applier";
import { listDirtyWorktreeEntries } from "./worktree";
import { isHarnessStartupFailureOutput, summarizeHarnessStartupFailure } from "./harness-startup-failure";
import { createLogger } from "./logger";

const log = createLogger("session");

const STARTUP_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
/**
 * A turn in progress is not idle, but one that has sent nothing at all for this
 * long is treated as stalled so the idle timeout can still suspend it.
 */
const MAX_SILENT_TURN_MS = 2 * 60 * 60 * 1000;
/** Grace period after background tasks finish for Claude Code to start its report turn. */
const BACKGROUND_TASK_SETTLE_MS = 5_000;

/** Approval phrases that carry no instructions beyond the approval itself. */
const BARE_APPROVAL_MESSAGES = new Set([
  "approve",
  "approved",
  "approved. go ahead",
  "approved. implement the plan",
  "go ahead",
  "lgtm",
]);

function isBareApprovalMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!\s]+$/g, "").replace(/\s+/g, " ");
  return !normalized || BARE_APPROVAL_MESSAGES.has(normalized);
}

const PLAN_APPROVED_PROMPT_PREFIX =
  "[SYSTEM: The user has approved your plan. Exit plan mode immediately and implement the changes with full permissions. Do not ask for further confirmation.]\n\n";
const PLAN_REVISION_PROMPT_PREFIX =
  "[SYSTEM: The user wants changes to your plan. Revise the plan based on their feedback below, then re-submit your revised plan for approval. Do NOT start implementing yet.]\n\n";
export { getSessionOutputFilePath } from "./session-output";

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || /\babort(?:ed)?\b/i.test(err.message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logSessionDiagnostic(event: string, fields: Record<string, unknown>): void {
  // Routine lifecycle diagnostics log at info; failure events stay at warn.
  const level = /(?:error|fail)/i.test(event) ? "warn" : "info";
  log[level](JSON.stringify({
    component: "Session",
    event,
    at: new Date().toISOString(),
    ...fields,
  }));
}

/** Append a structured backend error code (e.g. Claude `authentication_failed`) to failure text. */
function withErrorCode(text: string | undefined, code: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!code) return trimmed || undefined;
  if (!trimmed) return `Backend error: ${code}`;
  return trimmed.includes(code) ? trimmed : `${trimmed} (error code: ${code})`;
}

function backendRefDiagnosticFields(backendRef: SessionBackendRef | undefined): Record<string, unknown> {
  if (!backendRef) return {};
  return {
    backendRefKind: backendRef.kind,
    hasBackendConversationId: Boolean(backendRef.conversationId),
    hasBackendRunId: Boolean(backendRef.runId),
  };
}

/**
 * Runtime session wrapper around a single harness lifecycle.
 *
 * Owns state-machine transitions, output buffering, prompt streaming, timers,
 * and lifecycle events consumed by SessionManager.
 */
export class Session extends EventEmitter {
  readonly id: string;
  name: string;
  harnessSessionId?: string;
  backendRef?: SessionBackendRef;

  // Harness
  private readonly harness: AgentHarness;
  private harnessHandle?: HarnessSession;

  // Config
  readonly prompt: string;
  readonly workdir: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly fastMode?: boolean;
  private readonly systemPrompt?: string;
  /** The launch system prompt without the worktree preamble (persisted for resume). */
  readonly launchSystemPrompt?: string;
  private readonly allowedTools?: string[];
  private readonly permissionMode: PermissionMode;
  readonly requestedPermissionMode: PermissionMode;
  readonly planApproval: PlanApprovalMode;
  currentPermissionMode: PermissionMode;
  private pendingModeSwitch?: PermissionMode;

  // Resume/fork
  readonly resumeSessionId?: string;
  /**
   * True when this launch neither resumed a conversation nor reused a
   * persisted worktree, so any worktree it has was created for it.
   */
  readonly launchedFresh: boolean;
  readonly resumedFromSessionName?: string;
  readonly forkSession?: boolean;
  private readonly forkBaselineUsage?: SessionConfig["forkBaselineUsage"];
  private readonly rewindTurns?: number;

  // Worktree
  worktreePath?: string;
  originalWorkdir?: string;
  worktreeBranch?: string; // Cached at creation to avoid live lookups after worktree removal.
  worktreeParentBranch?: string;
  readonly worktreeStrategy?: WorktreeStrategy;
  readonly repoIntegrationPolicy?: RepoIntegrationPolicy;
  readonly repoIntegrationPolicySource?: "stored" | "seeded" | "unknown";
  readonly repoProvider?: RepoProviderKind;
  readonly worktreeBaseBranch?: string;
  worktreePrTargetRepo?: string;
  autoMergeParentSessionId?: string;
  autoMergeConflictResolutionAttemptCount?: number;
  autoMergeResolverSessionId?: string;
  worktreePushRemote?: string;
  worktreeDisposition?: string;
  worktreePrUrl?: string;
  worktreePrNumber?: number;
  worktreeMerged?: boolean;
  worktreeMergedAt?: string;
  worktreeLifecycle?: PersistedWorktreeLifecycle;
  worktreeState: SessionWorktreeState = "none";

  // Multi-turn
  readonly multiTurn: boolean;
  readonly goalTaskId?: string;
  private messageStream?: MessageStream;
  /** A finished turn kept open only because a pulled prompt had not started its turn yet. */
  private turnHeldForOutstandingPrompt = false;
  /** `run_started` and `prompt_settled` events seen since launch (paired with prompt-stream pulls). */
  private runsStarted = 0;
  /** Separate the next output from earlier text (new turn, or text after a tool call). */
  private separateNextOutput = false;
  /** A finished turn is held open because backend background tasks are still live. */
  private awaitingBackgroundTasks = false;

  // State
  private _status: SessionStatus = "starting";
  error?: string;
  startedAt: number;
  completedAt?: number;

  // Abort
  private abortController: AbortController;
  private teardownPromise?: Promise<void>;

  // Output
  outputBuffer: string[] = [];

  // Result
  result?: {
    subtype: string;
    duration_ms: number;
    total_cost_usd: number;
    num_turns: number;
    result?: string;
    is_error: boolean;
    session_id: string;
  };

  // Cost
  costUsd: number = 0;
  /** Latest backend usage snapshot (per-model cost, context, background tasks). */
  usage?: HarnessUsage;
  /** Model/effort the backend reports it actually runs. */
  backendInfo?: HarnessBackendInfo;

  // Origin
  originChannel?: string;
  originThreadId?: string | number;
  readonly originAgentId?: string;
  readonly originSessionKey?: string;
  route?: SessionRoute;
  pendingInputState?: PendingInputState;
  private lastPendingInputSubmissionRequiresMore = false;

  // Flags
  pendingPlanApproval: boolean = false;
  planApprovalContext?: PlanApprovalContext;
  planDecisionVersion: number = 0;
  actionablePlanDecisionVersion?: number;
  canonicalPlanPromptVersion?: number;
  approvalPromptRequiredVersion?: number;
  approvalPromptVersion?: number;
  approvalPromptStatus: SessionApprovalPromptStatus = "not_sent";
  approvalPromptTransport: SessionApprovalPromptTransport = "none";
  approvalPromptMessageKind: SessionApprovalPromptMessageKind = "none";
  approvalPromptLastAttemptAt?: string;
  approvalPromptDeliveredAt?: string;
  approvalPromptFailedAt?: string;
  planFilePath?: string;
  killReason: KillReason = "unknown";
  private planModeApproved: boolean = false;
  private readonly turnRuntime: SessionTurnRuntime;
  private readonly harnessEvents: SessionHarnessEventApplier;
  private worktreeFinalizationPromptIssued = false;
  private dirtyWorktreeEntriesAtTurnEnd: string[] | undefined;
  lifecycle: SessionLifecycle = "starting";
  approvalState: SessionApprovalState = "not_required";
  approvalExecutionState: ApprovalExecutionState = "not_plan_gated";
  approvalRationale?: string;
  latestPlanArtifact?: PlanArtifact;
  latestPlanArtifactVersion?: number;
  runtimeState: SessionRuntimeState = "live";
  taskFlowMirror?: PersistedTaskFlowMirror;
  deliveryState: SessionDeliveryState = "idle";

  // AskUserQuestion intercept
  private readonly canUseTool?: CanUseToolCallback;

  // Auto-respond counter
  autoRespondCount: number = 0;

  // Centralized timer management
  private readonly timers = new SessionTimerRegistry();

  constructor(config: SessionConfig, name: string) {
    super();
    this.id = config.sessionIdOverride ?? shortId(8);
    this.name = name;
    this.harness = config.harness ? getHarness(config.harness) : getDefaultHarness();
    this.prompt = config.prompt;
    this.workdir = config.workdir;
    // Internal launches can construct sessions without passing through a tool
    // resolver, so canonicalize provider-qualified spellings here as well.
    this.model = canonicalizeModelForHarness(
      this.harness.name,
      config.model ?? resolveDefaultModelForHarness(this.harness.name),
    );
    this.reasoningEffort = config.reasoningEffort ?? resolveReasoningEffortForHarness(this.harness.name);
    this.fastMode = this.harness.name === "codex"
      ? (config.fastMode ?? resolveFastModeForHarness(this.harness.name))
      : undefined;
    this.systemPrompt = config.systemPrompt;
    this.launchSystemPrompt = config.launchSystemPrompt ?? config.systemPrompt;
    this.allowedTools = config.allowedTools;
    this.permissionMode = config.permissionMode ?? pluginConfig.permissionMode;
    this.requestedPermissionMode = config.requestedPermissionMode ?? this.permissionMode;
    this.planApproval = config.planApproval ?? pluginConfig.planApproval;
    // Keep currentPermissionMode in sync with permissionMode for all harnesses.
    // The structured backend contract still uses plugin-owned plan state so
    // Approve/Revise/Reject buttons fire consistently across backends.
    this.currentPermissionMode = this.permissionMode;
    this.originChannel = config.originChannel;
    this.originThreadId = config.originThreadId;
    this.originAgentId = config.originAgentId;
    this.originSessionKey = config.originSessionKey;
    this.route = config.route ? { ...config.route } : undefined;
    this.backendRef = config.backendRef ? { ...config.backendRef } : undefined;
    this.resumeSessionId = config.resumeSessionId;
    this.launchedFresh = !config.resumeSessionId && !config.resumeWorktreeFrom;
    this.resumedFromSessionName = config.resumedFromSessionName;
    this.forkSession = config.forkSession;
    this.forkBaselineUsage = config.forkBaselineUsage;
    this.rewindTurns = config.rewindTurns;
    this.multiTurn = config.multiTurn ?? true;
    this.goalTaskId = config.goalTaskId;
    this.worktreeStrategy = config.worktreeStrategy;
    this.repoIntegrationPolicy = config.repoIntegrationPolicy;
    this.repoIntegrationPolicySource = config.repoIntegrationPolicySource;
    this.repoProvider = config.repoProvider;
    this.worktreeBaseBranch = config.worktreeBaseBranch;
    this.worktreeParentBranch = config.worktreeParentBranch;
    if (config.worktreePrTargetRepo) {
      this.worktreePrTargetRepo = config.worktreePrTargetRepo;
    }
    if (config.autoMergeParentSessionId) {
      this.autoMergeParentSessionId = config.autoMergeParentSessionId;
    }
    if (config.autoMergeConflictResolutionAttemptCount !== undefined) {
      this.autoMergeConflictResolutionAttemptCount = config.autoMergeConflictResolutionAttemptCount;
    }
    if (config.autoMergeResolverSessionId) {
      this.autoMergeResolverSessionId = config.autoMergeResolverSessionId;
    }
    this.canUseTool = config.canUseTool;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
    this.turnRuntime = new SessionTurnRuntime({
      appendOutput: (text) => this.appendOutput(text),
      emitOutput: (text) => this.emit("output", this, text),
      emitToolUse: (name, input) => this.emit("toolUse", this, name, input),
      emitTurnEnd: (hadQuestion) => this.emit("turnEnd", this, hadQuestion),
      markPendingPlanApproval: (context) => this.markPendingPlanApproval(context),
      markAwaitingUserInput: () => this.markAwaitingUserInput(),
      applyInputRequested: () => this.applyControlEvent({ type: "input.requested" }),
      completeTurn: () => {
        this.applyControlEvent({ type: "terminal.entered" });
        this.complete("done");
      },
      queueWorktreeFinalizationPrompt: () => this.queueWorktreeFinalizationPrompt(),
      setPlanFilePath: (path) => { this.planFilePath = path; },
      setLatestPlanArtifact: (artifact) => {
        this.latestPlanArtifact = artifact;
        const version = this.pendingPlanApproval
          ? (this.actionablePlanDecisionVersion ?? this.planDecisionVersion)
          : undefined;
        this.latestPlanArtifactVersion = version && version > 0 ? version : undefined;
      },
    });
    this.harnessEvents = new SessionHarnessEventApplier({
      clearStartupTimer: () => this.clearTimer("startup"),
      assignBackendRef: (ref) => {
        this.backendRef = ref;
        this.harnessSessionId = ref.conversationId;
      },
      notePromptSettled: () => {
        this.runsStarted += 1;
        this.finishTurnHeldForSettledPrompt();
      },
      noteRunStarted: (runId) => {
        this.runsStarted += 1;
        this.turnHeldForOutstandingPrompt = false;
        if (runId && this.backendRef) {
          this.backendRef = { ...this.backendRef, runId };
        }
      },
      transitionRunning: () => {
        if (this._status === "starting") {
          this.transition("running");
        }
      },
      noteTextDelta: (text, pendingPlanApproval) => this.turnRuntime.noteTextDelta(text, pendingPlanApproval),
      noteToolCall: (args) => {
        this.separateNextOutput = true;
        this.turnRuntime.noteToolCall(args);
      },
      notePlanApprovalRequest: (request, planModeApproved) => this.turnRuntime.notePlanApprovalRequest({
        artifact: request.artifact,
        planFilePath: request.planFilePath,
        planModeApproved,
      }),
      noteBackendInfo: (info) => {
        this.backendInfo = { ...this.backendInfo, ...info };
        if (info.reasoningEffortSupported === false && this.reasoningEffort) {
          this.logDiagnostic("backend.effort_unsupported", {
            requestedEffort: this.reasoningEffort,
            backendModel: info.model,
          });
        }
      },
      noteUsage: (usage) => {
        this.mergeUsage(usage);
        this.maybeFinishAfterBackgroundTasks();
      },
      setPendingInputState: (state) => this.setPendingInputState(state),
      notePendingInput: (state) => this.turnRuntime.notePendingInput(state),
      clearResolvedPendingInput: (requestId, currentState) => (
        this.turnRuntime.clearResolvedPendingInput(requestId, currentState)
      ),
      notePlanArtifact: (msg) => this.turnRuntime.notePlanArtifact(msg.artifact, msg.finalized),
      noteSettingsChanged: (args) => this.turnRuntime.noteSettingsChanged(args),
      setCurrentPermissionMode: (mode) => {
        this.currentPermissionMode = mode;
        this.applyControlEvent({ type: "permission.mode_changed", currentPermissionMode: mode });
      },
      handleRunCompleted: (data) => {
        this.separateNextOutput = true;
        const reportedOutcome = data.outcome ?? (data.success ? "completed" : "failed");
        // Backends with structured failure reporting classify outcomes
        // themselves; the text heuristic only covers the others.
        const startupFailureText = data.num_turns === 0 && !data.outcomeAuthoritative
          ? [
              data.result,
              ...this.outputBuffer.slice(-5),
            ].filter((line): line is string => typeof line === "string").join("\n")
          : "";
        const forcedStartupFailure = reportedOutcome === "completed"
          && isHarnessStartupFailureOutput(startupFailureText);
        const outcome = forcedStartupFailure ? "failed" : reportedOutcome;
        const resultText = forcedStartupFailure
          ? (summarizeHarnessStartupFailure(startupFailureText) ?? data.result)
          : data.result;
        this.result = {
          subtype: outcome === "interrupted" ? "interrupted" : (outcome === "completed" ? "success" : "error"),
          duration_ms: data.duration_ms,
          total_cost_usd: data.total_cost_usd,
          num_turns: data.num_turns,
          result: resultText,
          is_error: outcome === "failed",
          session_id: data.session_id,
        };
        if (data.usage) this.mergeUsage(data.usage);
        // The turn total is authoritative over any running cost reported mid-turn.
        this.costUsd = data.total_cost_usd;

        const isInterruptedTurn = this.multiTurn && this.messageStream && outcome === "interrupted";
        const isMultiTurnEndOfTurn = this.multiTurn && this.messageStream && outcome === "completed";
        const hasPendingMessages = this.hasOutstandingPrompts();
        // Claude Code keeps background tasks (for example background shells)
        // alive after a turn; the session is not done until they finish.
        const backgroundTasksLive = isMultiTurnEndOfTurn && (this.usage?.backgroundTasks ?? 0) > 0;
        this.awaitingBackgroundTasks = backgroundTasksLive && !hasPendingMessages;

        if (isInterruptedTurn) {
          this.resetIdleTimer();
          this.turnRuntime.finishInterruptedTurn(hasPendingMessages);
        } else if (isMultiTurnEndOfTurn) {
          this.resetIdleTimer();
          this.turnRuntime.finishSuccessfulTurn({
            currentPermissionMode: this.currentPermissionMode,
            permissionMode: this.permissionMode,
            pendingPlanApproval: this.pendingPlanApproval,
            planModeApproved: this.planModeApproved,
            pendingInputState: this.pendingInputState,
            hasPendingMessages: hasPendingMessages || backgroundTasksLive,
          });
          this.turnHeldForOutstandingPrompt = hasPendingMessages && !backgroundTasksLive;
        } else {
          this.turnRuntime.finishTerminalTurn();
          const failureText = outcome === "failed" ? withErrorCode(resultText, data.errorCode) : undefined;
          this.transitionToTerminal(outcome === "completed" ? "completed" : "failed", {
            ...(failureText ? { error: failureText } : {}),
          });
        }
        this.turnRuntime.resetAfterRun();
        this.setPendingInputState(undefined);
      },
    });
    this.applyControlEvent({ type: "initialize", hasWorktree: !!(this.worktreeStrategy && this.worktreeStrategy !== "off") });
    if (
      config.planModeApproved !== undefined
      || config.approvalState !== undefined
      || config.approvalExecutionState !== undefined
      || config.approvalRationale !== undefined
      || config.pendingPlanApproval !== undefined
      || config.planApprovalContext !== undefined
      || config.planDecisionVersion !== undefined
      || config.actionablePlanDecisionVersion !== undefined
      || config.canonicalPlanPromptVersion !== undefined
      || config.approvalPromptRequiredVersion !== undefined
      || config.approvalPromptVersion !== undefined
      || config.approvalPromptStatus !== undefined
      || config.approvalPromptTransport !== undefined
      || config.approvalPromptMessageKind !== undefined
      || config.approvalPromptLastAttemptAt !== undefined
      || config.approvalPromptDeliveredAt !== undefined
      || config.approvalPromptFailedAt !== undefined
    ) {
      this.applyControlPatch({
        ...(config.planModeApproved !== undefined ? { planModeApproved: config.planModeApproved } : {}),
        ...(config.approvalState !== undefined ? { approvalState: config.approvalState } : {}),
        ...(config.approvalExecutionState !== undefined ? { approvalExecutionState: config.approvalExecutionState } : {}),
        ...(config.pendingPlanApproval !== undefined ? { pendingPlanApproval: config.pendingPlanApproval } : {}),
        ...(config.planApprovalContext !== undefined ? { planApprovalContext: config.planApprovalContext } : {}),
        ...(config.planDecisionVersion !== undefined ? { planDecisionVersion: config.planDecisionVersion } : {}),
        ...(config.actionablePlanDecisionVersion !== undefined ? { actionablePlanDecisionVersion: config.actionablePlanDecisionVersion } : {}),
        ...(config.canonicalPlanPromptVersion !== undefined ? { canonicalPlanPromptVersion: config.canonicalPlanPromptVersion } : {}),
        ...(config.approvalPromptRequiredVersion !== undefined ? { approvalPromptRequiredVersion: config.approvalPromptRequiredVersion } : {}),
        ...(config.approvalPromptVersion !== undefined ? { approvalPromptVersion: config.approvalPromptVersion } : {}),
        ...(config.approvalPromptStatus !== undefined ? { approvalPromptStatus: config.approvalPromptStatus } : {}),
        ...(config.approvalPromptTransport !== undefined ? { approvalPromptTransport: config.approvalPromptTransport } : {}),
        ...(config.approvalPromptMessageKind !== undefined ? { approvalPromptMessageKind: config.approvalPromptMessageKind } : {}),
        ...(config.approvalPromptLastAttemptAt !== undefined ? { approvalPromptLastAttemptAt: config.approvalPromptLastAttemptAt } : {}),
        ...(config.approvalPromptDeliveredAt !== undefined ? { approvalPromptDeliveredAt: config.approvalPromptDeliveredAt } : {}),
        ...(config.approvalPromptFailedAt !== undefined ? { approvalPromptFailedAt: config.approvalPromptFailedAt } : {}),
      });
    }
    this.approvalRationale = config.approvalRationale;
  }

  get status(): SessionStatus { return this._status; }

  get harnessName(): string { return this.harness.name; }

  get backendKind(): SessionBackendRef["kind"] {
    return this.harness.backendKind;
  }

  get backendCapabilities() {
    return this.harness.capabilities;
  }

  get backendConversationId(): string | undefined {
    return getBackendConversationId(this);
  }

  approvalSnapshot(): Pick<
    Session,
    | "requestedPermissionMode"
    | "currentPermissionMode"
    | "approvalExecutionState"
    | "approvalRationale"
    | "pendingPlanApproval"
    | "planApprovalContext"
    | "planDecisionVersion"
    | "actionablePlanDecisionVersion"
    | "canonicalPlanPromptVersion"
    | "approvalPromptRequiredVersion"
    | "approvalPromptVersion"
    | "approvalPromptStatus"
    | "approvalPromptTransport"
    | "approvalPromptMessageKind"
    | "approvalPromptLastAttemptAt"
    | "approvalPromptDeliveredAt"
    | "approvalPromptFailedAt"
    | "planApproval"
  > & { planModeApproved: boolean } {
    return {
      requestedPermissionMode: this.requestedPermissionMode,
      currentPermissionMode: this.currentPermissionMode,
      approvalExecutionState: this.approvalExecutionState,
      approvalRationale: this.approvalRationale,
      planModeApproved: this.controlStateSnapshot().planModeApproved,
      pendingPlanApproval: this.pendingPlanApproval,
      planApprovalContext: this.planApprovalContext,
      planDecisionVersion: this.planDecisionVersion,
      actionablePlanDecisionVersion: this.actionablePlanDecisionVersion,
      canonicalPlanPromptVersion: this.canonicalPlanPromptVersion,
      approvalPromptRequiredVersion: this.approvalPromptRequiredVersion,
      approvalPromptVersion: this.approvalPromptVersion,
      approvalPromptStatus: this.approvalPromptStatus,
      approvalPromptTransport: this.approvalPromptTransport,
      approvalPromptMessageKind: this.approvalPromptMessageKind,
      approvalPromptLastAttemptAt: this.approvalPromptLastAttemptAt,
      approvalPromptDeliveredAt: this.approvalPromptDeliveredAt,
      approvalPromptFailedAt: this.approvalPromptFailedAt,
      planApproval: this.planApproval,
    };
  }

  worktreeSnapshot(): Pick<
    Session,
    | "worktreePath"
    | "worktreeBranch"
    | "worktreeStrategy"
    | "repoIntegrationPolicy"
    | "repoIntegrationPolicySource"
    | "repoProvider"
    | "worktreeBaseBranch"
    | "worktreeParentBranch"
    | "worktreePrTargetRepo"
    | "autoMergeParentSessionId"
    | "autoMergeConflictResolutionAttemptCount"
    | "autoMergeResolverSessionId"
    | "worktreeLifecycle"
  > {
    return {
      worktreePath: this.worktreePath,
      worktreeBranch: this.worktreeBranch,
      worktreeStrategy: this.worktreeStrategy,
      repoIntegrationPolicy: this.repoIntegrationPolicy,
      repoIntegrationPolicySource: this.repoIntegrationPolicySource,
      repoProvider: this.repoProvider,
      worktreeBaseBranch: this.worktreeBaseBranch,
      worktreeParentBranch: this.worktreeParentBranch,
      worktreePrTargetRepo: this.worktreePrTargetRepo,
      autoMergeParentSessionId: this.autoMergeParentSessionId,
      autoMergeConflictResolutionAttemptCount: this.autoMergeConflictResolutionAttemptCount,
      autoMergeResolverSessionId: this.autoMergeResolverSessionId,
      worktreeLifecycle: this.worktreeLifecycle,
    };
  }

  backendSnapshot(): Pick<Session, "harnessSessionId" | "backendRef"> & {
    harness: string;
    backendKind: SessionBackendRef["kind"];
    backendConversationId?: string;
  } {
    return {
      harnessSessionId: this.harnessSessionId,
      backendRef: this.backendRef,
      harness: this.harnessName,
      backendKind: this.backendKind,
      backendConversationId: this.backendConversationId,
    };
  }

  routingSnapshot(): Pick<
    Session,
    "route" | "originAgentId" | "originChannel" | "originThreadId" | "originSessionKey"
  > {
    return {
      route: this.route,
      originAgentId: this.originAgentId,
      originChannel: this.originChannel,
      originThreadId: this.originThreadId,
      originSessionKey: this.originSessionKey,
    };
  }

  private get waitingForInputFired(): boolean {
    return this.turnRuntime.waitingForInputFired;
  }

  private set waitingForInputFired(value: boolean) {
    this.turnRuntime.waitingForInputFired = value;
  }

  private get turnInProgress(): boolean {
    return this.turnRuntime.turnInProgress;
  }

  private set turnInProgress(value: boolean) {
    this.turnRuntime.turnInProgress = value;
  }

  private get currentTurnPlanArtifact(): PlanArtifact | undefined {
    return this.turnRuntime.currentTurnPlanArtifact;
  }

  private set currentTurnPlanArtifact(value: PlanArtifact | undefined) {
    this.turnRuntime.currentTurnPlanArtifact = value;
  }

  get duration(): number {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }

  get phase(): string {
    return this.lifecycle;
  }

  get isExplicitlyResumable(): boolean {
    return this.status !== "running"
      && this.status !== "completed"
      && this.killReason !== "done"
      && !!this.backendConversationId;
  }

  // -- State machine --

  transition(newStatus: SessionStatus): void {
    if (!SESSION_STATUS_TRANSITIONS[this._status].includes(newStatus)) {
      throw new Error(`Session state error: cannot transition from ${this._status} to ${newStatus}. This is an internal error — please report it.`);
    }
    const prev = this._status;
    this._status = newStatus;
    this.applyControlEvent({ type: "status.transition", status: newStatus });
    this.emit("statusChange", this, newStatus, prev);
  }

  // -- Timer management --

  private setTimer(name: string, ms: number, cb: () => void): void {
    this.timers.set(name, ms, cb);
  }

  private clearTimer(name: string): void {
    this.timers.clear(name);
  }

  private clearAllTimers(): void {
    this.timers.clearAll();
  }

  private markPendingPlanApproval(context: PlanApprovalContext): void {
    const previousCachedVersion = this.latestPlanArtifactVersion;
    this.approvalRationale = undefined;
    this.applyControlEvent({ type: "plan.requested", context });
    const nextVersion = this.actionablePlanDecisionVersion ?? this.planDecisionVersion;
    if (this.currentTurnPlanArtifact && nextVersion > 0) {
      this.latestPlanArtifact = this.currentTurnPlanArtifact;
      this.latestPlanArtifactVersion = nextVersion;
    } else if (previousCachedVersion !== nextVersion) {
      this.latestPlanArtifact = undefined;
      this.latestPlanArtifactVersion = undefined;
    }
  }

  private clearPendingPlanApproval(): void {
    this.applyControlEvent({ type: "plan.cleared" });
  }

  markAwaitingUserInput(): void {
    this.applyControlEvent({ type: "input.requested" });
  }

  /**
   * Whether a follow-up prompt or thread action is still waiting for its turn.
   *
   * The queue covers prompts the harness has not pulled yet. Codex and OpenCode
   * run one turn per pulled prompt and emit `run_started` for it, but they can
   * pull the next prompt before this session applies the previous turn's
   * `run_completed`; a pulled prompt without its `run_started` is therefore
   * still outstanding. Claude Code's SDK pulls the stream eagerly and itself
   * defers results while queued turns remain (`queued_turn_count`), so only the
   * queue counts there.
   */
  /**
   * The prompt a finished turn was waiting for settled without a turn (for
   * example it answered pending input): finish the held turn now instead of
   * waiting for an idle timeout.
   */
  private finishTurnHeldForSettledPrompt(): void {
    if (!this.turnHeldForOutstandingPrompt || this.hasOutstandingPrompts()) return;
    this.turnHeldForOutstandingPrompt = false;
    if (this._status !== "running" || !this.turnInProgress) return;
    this.turnRuntime.finishSuccessfulTurn({
      currentPermissionMode: this.currentPermissionMode,
      permissionMode: this.permissionMode,
      pendingPlanApproval: this.pendingPlanApproval,
      planModeApproved: this.planModeApproved,
      pendingInputState: this.pendingInputState,
      hasPendingMessages: false,
    });
  }

  private hasOutstandingPrompts(): boolean {
    const stream = this.messageStream;
    if (!stream) return false;
    if (stream.hasPending()) return true;
    if (this.harness.backendKind === "claude-code") return false;
    return stream.consumedCount > this.runsStarted;
  }

  private appendOutput(text: string): void {
    if (!text) return;
    let chunk = text;
    if (this.separateNextOutput) {
      this.separateNextOutput = false;
      const last = this.outputBuffer.at(-1);
      if (last !== undefined && last.trim() && !/^\s/.test(chunk)) chunk = `\n\n${chunk}`;
    }
    appendSessionOutput(this.outputBuffer, this.id, chunk);
  }

  private needsWorktreeFinalizationCheck(): boolean {
    if (!this.multiTurn || !this.messageStream) return false;
    if (!this.worktreePath || !this.worktreeStrategy || this.worktreeStrategy === "off") return false;
    return !this.worktreeFinalizationPromptIssued;
  }

  /**
   * Read the worktree's dirty entries before a run-completed event is applied,
   * so the synchronous turn state machine can decide on the finalization prompt.
   */
  private async prepareWorktreeFinalizationCheck(): Promise<void> {
    this.dirtyWorktreeEntriesAtTurnEnd = this.needsWorktreeFinalizationCheck()
      ? await listDirtyWorktreeEntries(this.worktreePath!)
      : undefined;
  }

  private queueWorktreeFinalizationPrompt(): boolean {
    if (!this.needsWorktreeFinalizationCheck()) return false;

    const dirtyEntries = this.dirtyWorktreeEntriesAtTurnEnd ?? [];
    this.dirtyWorktreeEntriesAtTurnEnd = undefined;
    if (dirtyEntries.length === 0) return false;

    this.worktreeFinalizationPromptIssued = true;
    const dirtyPreview = dirtyEntries.slice(0, 20).map((entry) => `- ${entry}`).join("\n");
    const moreLine = dirtyEntries.length > 20 ? `\n- ...and ${dirtyEntries.length - 20} more` : "";
    const prompt = [
      `Your worktree still has uncommitted changes, so this session cannot finish yet.`,
      ``,
      `Worktree: ${this.worktreePath}`,
      `Branch: ${this.worktreeBranch ?? "(unknown)"}`,
      ``,
      `Dirty entries:`,
      `${dirtyPreview}${moreLine}`,
      ``,
      `Before finishing, run \`git status --short\` in the worktree and do exactly one of these:`,
      `1. If these are real task changes, commit them on the worktree branch with \`git add\` and \`git commit\`.`,
      `2. If these are temporary or unrelated artifacts, remove or restore them so the worktree is clean.`,
      `3. If no repository changes were intended, leave the worktree clean and say that no changes were needed.`,
      ``,
      `Do not finish again until \`git status --short\` is clean or all real task changes are committed.`,
    ].join("\n");
    this.messageStream.push(
      this.harness.buildUserMessage(prompt, this.backendConversationId ?? ""),
    );
    return true;
  }

  // -- Lifecycle --

  /** Launch the configured harness and start consuming harness messages. */
  async start(): Promise<void> {
    this.logDiagnostic("harness.launch.start", {
      model: this.model,
      hasWorkdir: Boolean(this.workdir),
      hasResumeSessionId: Boolean(this.resumeSessionId),
      forkSessionRequested: this.forkSession === true,
      hasBackendRef: Boolean(this.backendRef),
    });
    try {
      let prompt: string | AsyncIterable<unknown>;
      if (this.multiTurn) {
        this.messageStream = new MessageStream();
        this.messageStream.push(
          this.harness.buildUserMessage(this.prompt, ""),
        );
        prompt = this.messageStream;
      } else {
        prompt = this.prompt;
      }

      const handle = this.harness.launch({
        prompt,
        cwd: this.workdir,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        fastMode: this.fastMode,
        permissionMode: this.permissionMode,
        systemPrompt: this.systemPrompt,
        allowedTools: this.allowedTools,
        resumeSessionId: this.resumeSessionId,
        forkSession: this.forkSession,
        ...(this.forkSession && this.forkBaselineUsage ? { forkBaselineUsage: this.forkBaselineUsage } : {}),
        rewindTurns: this.rewindTurns,
        worktreeStrategy: this.worktreeStrategy,
        originalWorkdir: this.originalWorkdir ?? this.workdir,
        abortController: this.abortController,
        canUseTool: this.canUseTool,
      });
      this.harnessHandle = handle;
      this.logDiagnostic("harness.launch.created", {
        hasStreamInput: Boolean(handle.streamInput),
        hasInterrupt: Boolean(handle.interrupt),
        hasClose: Boolean(handle.close),
        hasPermissionModeSwitch: Boolean(handle.setPermissionMode),
      });
      this.setTimer("startup", STARTUP_TIMEOUT_MS, () => {
        if (this._status === "starting") this.kill("startup-timeout");
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logDiagnostic("harness.launch.error", { error: message });
      this.transitionToTerminal("failed", { error: message });
      return;
    }

    this.consumeMessages(this.harnessHandle!.messages).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logDiagnostic("harness.stream.error", { error: message });
      log.error(`[Session ${this.id}] consumeMessages error: ${message}`, stack);
      if (this.isActive) {
        this.transitionToTerminal("failed", { error: message });
      }
    });
  }

  /**
   * Send a follow-up user message to a running multi-turn session.
   *
   * While a turn is running on a harness that supports steering (Codex), the
   * message is injected into that turn (`"steered"`). Otherwise it is queued
   * as the next turn (`"queued"`).
   */
  async sendMessage(text: string): Promise<"steered" | "queued"> {
    if (this._status !== "running") {
      throw new Error(`Session is not running (status: ${this._status})`);
    }

    this.resetIdleTimer();
    const planDecisionPending = !!this.pendingModeSwitch
      || ((this.pendingPlanApproval || this.approvalState === "changes_requested") && !this.planModeApproved);
    if (this.turnInProgress && !planDecisionPending && this.harnessHandle?.steer) {
      if (await this.harnessHandle.steer(text)) {
        this.logDiagnostic("turn.steered", { chars: text.length });
        return "steered";
      }
    }

    this.turnRuntime.beginUserTurn();
    this.applyControlEvent({ type: "turn.started" });

    const nativePlanDecisions = this.harness.capabilities.nativePlanDecisions === true;
    let effectiveText = text;
    if (this.pendingModeSwitch) {
      const newMode = this.pendingModeSwitch;
      if (await this.resolveNativePlanDecision({ kind: "approve", permissionMode: newMode })) {
        // The backend received the approval as the native permission result
        // (Claude: ExitPlanMode allow + setMode). Forward only extra words.
        this.pendingModeSwitch = undefined;
        this.applyApprovedPermissionMode(newMode);
        if (isBareApprovalMessage(text)) return "queued";
      } else if (this.harnessHandle?.setPermissionMode) {
        try {
          await this.harnessHandle.setPermissionMode(newMode);
        } catch (err: unknown) {
          log.error(`[Session ${this.id}] setPermissionMode(${newMode}) FAILED: ${errorMessage(err)}`);
          // Preserve the pending approval state so callers can retry cleanly.
          this.markPendingPlanApproval(this.planApprovalContext ?? "plan-mode");
          throw new Error(`Failed to switch permission mode to ${newMode}: ${errorMessage(err)}`);
        }
        this.pendingModeSwitch = undefined;
        this.applyApprovedPermissionMode(newMode);
        if (!nativePlanDecisions) effectiveText = `${PLAN_APPROVED_PROMPT_PREFIX}${text}`;
      } else {
        // Harness doesn't support setPermissionMode — inject text prefix as best-effort fallback
        this.pendingModeSwitch = undefined;
        this.clearPendingPlanApproval();
        if (newMode !== "plan") {
          this.applyControlEvent({ type: "plan.approved" });
        }
        if (!nativePlanDecisions) effectiveText = `${PLAN_APPROVED_PROMPT_PREFIX}${text}`;
        log.warn(`[Session ${this.id}] Cannot call setPermissionMode — falling back to text prefix only (currentPermissionMode remains ${this.currentPermissionMode})`);
      }
    } else if ((this.pendingPlanApproval || this.approvalState === "changes_requested") && !this.planModeApproved) {
      if (this.approvalState !== "changes_requested") {
        this.applyControlEvent({ type: "plan.changes_requested" });
      }
      // Native backends receive the feedback as the plan request's denial
      // (Claude: ExitPlanMode deny message) and keep planning in the same turn.
      if (await this.resolveNativePlanDecision({ kind: "revise", feedback: text })) return "queued";
      if (!nativePlanDecisions) effectiveText = `${PLAN_REVISION_PROMPT_PREFIX}${text}`;

      // Re-assert plan mode at the backend level so revision stays read-only.
      if (this.harnessHandle?.setPermissionMode) {
        try {
          await this.harnessHandle.setPermissionMode("plan");
          this.currentPermissionMode = "plan";
          this.applyControlEvent({ type: "permission.mode_changed", currentPermissionMode: "plan" });
        } catch (err: unknown) {
          log.warn(`[Session ${this.id}] Failed to re-assert plan mode: ${errorMessage(err)}`);
        }
      }
    }

    if (this.multiTurn && this.messageStream) {
        this.messageStream.push(
          this.harness.buildUserMessage(effectiveText, this.backendConversationId ?? ""),
        );
    } else if (this.harnessHandle?.streamInput) {
      const msg = this.harness.buildUserMessage(effectiveText, this.backendConversationId ?? "");
      async function* oneMessage() { yield msg; }
      await this.harnessHandle.streamInput(oneMessage());
    } else {
      throw new Error("Session does not support follow-up messages (launched in single-turn mode).");
    }
    return "queued";
  }

  /**
   * Queue a backend thread action (compact, review) behind any running turn.
   * Only harnesses that list the action in `capabilities.threadActions` and
   * build control messages support it.
   */
  requestThreadAction(action: ThreadAction): void {
    if (this._status !== "running") {
      throw new Error(`Session is not running (status: ${this._status})`);
    }
    const supported = this.harness.capabilities.threadActions ?? [];
    if (!supported.includes(action.kind) || !this.harness.buildThreadActionMessage) {
      throw new Error(`The ${this.harness.name} harness does not support the "${action.kind}" thread action.`);
    }
    if (!this.multiTurn || !this.messageStream) {
      throw new Error("Session does not support follow-up actions (launched in single-turn mode).");
    }
    this.resetIdleTimer();
    this.turnRuntime.beginUserTurn();
    this.applyControlEvent({ type: "turn.started" });
    this.messageStream.push(this.harness.buildThreadActionMessage(action));
  }

  private async resolveNativePlanDecision(
    decision: Parameters<NonNullable<HarnessSession["resolvePlanDecision"]>>[0],
  ): Promise<boolean> {
    if (!this.harnessHandle?.resolvePlanDecision) return false;
    try {
      return await this.harnessHandle.resolvePlanDecision(decision);
    } catch (err: unknown) {
      log.warn(`[Session ${this.id}] native plan decision (${decision.kind}) failed: ${errorMessage(err)}`);
      return false;
    }
  }

  private applyApprovedPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    this.applyControlEvent({ type: "permission.mode_changed", currentPermissionMode: mode });
    this.clearPendingPlanApproval();
    if (mode !== "plan") {
      this.applyControlEvent({ type: "plan.approved" });
    }
  }

  /**
   * Background tasks that outlived their turn have finished. Claude Code usually
   * reports their results in a new turn, which ends the session normally; if no
   * turn starts within the grace period, finish the held turn here.
   */
  private maybeFinishAfterBackgroundTasks(): void {
    if (!this.awaitingBackgroundTasks || (this.usage?.backgroundTasks ?? 0) > 0) return;
    this.awaitingBackgroundTasks = false;
    const runsAtIdle = this.runsStarted;
    this.setTimer("background-tasks", BACKGROUND_TASK_SETTLE_MS, () => {
      if (this._status !== "running" || this.runsStarted !== runsAtIdle || !this.turnInProgress) return;
      this.turnRuntime.finishSuccessfulTurn({
        currentPermissionMode: this.currentPermissionMode,
        permissionMode: this.permissionMode,
        pendingPlanApproval: this.pendingPlanApproval,
        planModeApproved: this.planModeApproved,
        pendingInputState: this.pendingInputState,
        hasPendingMessages: this.hasOutstandingPrompts(),
      });
    });
  }

  private mergeUsage(usage: HarnessUsage): void {
    const { costUsd, ...rest } = usage;
    if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) this.costUsd = costUsd;
    this.usage = {
      ...this.usage,
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    };
  }

  /** Interrupt the currently running turn, if the harness supports it. */
  async interrupt(): Promise<boolean> {
    if (!this.turnInProgress || !this.harnessHandle?.interrupt) {
      return false;
    }

    await this.harnessHandle.interrupt();
    return true;
  }

  async submitPendingInputOption(
    optionIndex: number,
    context?: { requestId?: string; questionId?: string },
  ): Promise<boolean> {
    // A stopped session's backend is gone: an answer must not be reported as delivered.
    if (this._status !== "running" || !this.pendingInputState || !this.harnessHandle?.submitPendingInputOption) {
      return false;
    }
    const activeQuestionIndex = this.pendingInputState.activeQuestionIndex;
    const questionCount = this.pendingInputState.questions?.length;
    const requestId = this.pendingInputState.requestId;
    const submitted = await this.harnessHandle.submitPendingInputOption(optionIndex, context);
    if (submitted) this.notePendingInputSubmitted(requestId, activeQuestionIndex, questionCount);
    return submitted;
  }

  canSubmitPendingInputOption(): boolean {
    return Boolean(this._status === "running" && this.pendingInputState && this.harnessHandle?.submitPendingInputOption);
  }

  private setPendingInputState(state: PendingInputState | undefined): void {
    this.pendingInputState = state;
    if (!state) {
      this.lastPendingInputSubmissionRequiresMore = false;
    }
  }

  pendingInputSubmissionRequiresMore(): boolean {
    return this.lastPendingInputSubmissionRequiresMore;
  }

  async submitPendingInputText(text: string): Promise<boolean> {
    if (this._status !== "running" || !this.pendingInputState || !this.harnessHandle?.submitPendingInputText) {
      return false;
    }
    const activeQuestionIndex = this.pendingInputState.activeQuestionIndex;
    const questionCount = this.pendingInputState.questions?.length;
    const requestId = this.pendingInputState.requestId;
    const submitted = await this.harnessHandle.submitPendingInputText(text);
    if (submitted) this.notePendingInputSubmitted(requestId, activeQuestionIndex, questionCount);
    return submitted;
  }

  private notePendingInputSubmitted(
    requestId: string | undefined,
    activeQuestionIndex: number | undefined,
    questionCount: number | undefined,
  ): void {
    this.lastPendingInputSubmissionRequiresMore = activeQuestionIndex != null
      && questionCount != null
      && activeQuestionIndex + 1 < questionCount;
    this.waitingForInputFired = false;
    if (!this.lastPendingInputSubmissionRequiresMore) {
      this.emit("pendingInputAnswered", this, requestId);
    }
  }

  /** Queue a permission mode switch to apply on the next user message. */
  switchPermissionMode(mode: PermissionMode): void {
    this.pendingModeSwitch = mode;
  }

  private get isActive(): boolean {
    return this._status === "starting" || this._status === "running";
  }

  /** Kill the session and transition to `killed` when still active. */
  kill(reason?: KillReason): void {
    this.transitionToTerminal("killed", { reason });
  }

  /** Wait until the harness transport owned by this session has released its backend writer. */
  async waitForTeardown(): Promise<void> {
    await (this.teardownPromise ?? Promise.resolve());
  }

  /** Mark the session completed and transition to `completed` when still active. */
  complete(reason: KillReason = "done"): void {
    this.transitionToTerminal("completed", { reason });
  }

  incrementAutoRespond(): void { this.autoRespondCount++; }
  resetAutoRespond(): void { this.autoRespondCount = 0; }

  /** Return full output or the last N lines from the in-memory output buffer. */
  getOutput(lines?: number): string[] {
    if (lines === undefined) return this.outputBuffer.slice();
    return this.outputBuffer.slice(-lines);
  }

  // -- Internal --

  /** When the harness last sent anything; a turn silent for longer than MAX_SILENT_TURN_MS is treated as stalled. */
  private lastHarnessMessageAt = Date.now();

  private resetIdleTimer(): void {
    if (!this.multiTurn) return;
    const idleTimeoutMs = (pluginConfig.idleTimeoutMinutes ?? 15) * 60 * 1000;
    this.setTimer("idle", idleTimeoutMs, () => {
      if (this._status === "running") {
        // A turn that is still working is not idle, even when its backend
        // reports no progress (for example one long, silent shell command).
        // Waiting for the user (a question or a plan decision) is idle.
        if (
          this.turnInProgress
          && !this.pendingInputState
          && !this.pendingPlanApproval
          && Date.now() - this.lastHarnessMessageAt < MAX_SILENT_TURN_MS
        ) {
          this.logDiagnostic("idle_timeout.deferred_active_turn", {
            idleTimeoutMinutes: pluginConfig.idleTimeoutMinutes ?? 15,
          });
          this.resetIdleTimer();
          return;
        }
        this.logDiagnostic("idle_timeout.fire", {
          idleTimeoutMinutes: pluginConfig.idleTimeoutMinutes ?? 15,
        });
        this.applyControlEvent({ type: "terminal.entered", suspended: true });
        this.kill("idle-timeout");
      }
    });
  }

  private teardown(): void {
    if (this.teardownPromise) return;
    this.clearAllTimers();
    if (!this.completedAt) this.completedAt = Date.now();
    if (this.messageStream) this.messageStream.end();
    if (this.harnessHandle?.interrupt) {
      void this.harnessHandle.interrupt().catch((err: unknown) => {
        // Teardown aborts the backend, so an aborted interrupt is expected.
        if (isAbortError(err)) {
          log.debug(`[Session ${this.id}] interrupt during teardown aborted: ${errorMessage(err)}`);
          return;
        }
        log.warn(`[Session ${this.id}] interrupt during teardown failed: ${errorMessage(err)}`);
      });
    }
    const closePromise = this.harnessHandle?.close
      ? this.harnessHandle.close().catch((err: unknown) => {
        log.warn(`[Session ${this.id}] harness close during teardown failed: ${errorMessage(err)}`);
      })
      : Promise.resolve();
    this.teardownPromise = closePromise;
    this.abortController.abort();
    this.applyControlEvent({ type: "terminal.entered", suspended: this.lifecycle === "suspended" });
  }

  /**
   * Enter a terminal state in strict order so listeners persist consistent data:
   * 1) set terminal metadata (`killReason` / `error` / `completedAt`)
   * 2) begin teardown so replacement sessions can await backend writer release
   * 3) emit the state transition
   */
  private transitionToTerminal(
    status: Extract<SessionStatus, "completed" | "failed" | "killed">,
    options: { reason?: KillReason; error?: string } = {},
  ): void {
    if (!this.isActive) return;
    this.logDiagnostic("terminal.transition", {
      nextStatus: status,
      reason: options.reason,
      error: options.error,
      currentStatus: this._status,
      lifecycle: this.lifecycle,
      runtimeState: this.runtimeState,
    });
    this.turnInProgress = false;
    if (options.reason) this.killReason = options.reason;
    if (options.error !== undefined) this.error = options.error;
    this.completedAt = Date.now();
    this.applyControlEvent({
      type: "terminal.entered",
      suspended: status === "killed" && options.reason === "idle-timeout",
    });
    this.teardown();
    this.transition(status);
  }

  private async consumeMessages(messages: AsyncIterable<HarnessMessage>): Promise<void> {
    let count = 0;
    for await (const msg of messages) {
      // After terminal transition we intentionally ignore late harness events.
      // This avoids spurious turnEnd/output processing from in-flight subprocess
      // shutdown messages after kill/complete/fail.
      if (!this.isActive) {
        break;
      }

      this.lastHarnessMessageAt = Date.now();
      this.resetIdleTimer();
      count += 1;
      if (msg.type === "run_completed") {
        await this.prepareWorktreeFinalizationCheck();
        if (!this.isActive) break;
      }
      this.harnessEvents.applyMessage(msg, {
        pendingPlanApproval: this.pendingPlanApproval,
        currentPermissionMode: this.currentPermissionMode,
        permissionMode: this.permissionMode,
        planModeApproved: this.planModeApproved,
        pendingInputState: this.pendingInputState,
      });
    }
    this.logDiagnostic("harness.stream.end", {
      messageCount: count,
      activeAtEnd: this.isActive,
      status: this._status,
      lifecycle: this.lifecycle,
      runtimeState: this.runtimeState,
    });
    if (this.isActive) {
      // The backend is gone (its process exited or its stream closed) without
      // reporting a result. A session that stayed "running" here could never
      // receive another message; fail it so it can be resumed instead.
      this.transitionToTerminal("failed", {
        error: `The ${this.harnessName ?? "agent"} backend stopped without finishing${this.turnInProgress ? " the current turn" : ""} (its process exited or its event stream closed). Send a message to resume the session.`,
      });
    }
  }

  controlStateSnapshot(): SessionControlState {
    return {
      status: this._status,
      lifecycle: this.lifecycle,
      approvalState: this.approvalState,
      approvalExecutionState: this.approvalExecutionState,
      worktreeState: this.worktreeState,
      runtimeState: this.runtimeState,
      deliveryState: this.deliveryState,
      requestedPermissionMode: this.requestedPermissionMode,
      currentPermissionMode: this.currentPermissionMode,
      pendingPlanApproval: this.pendingPlanApproval,
      planApprovalContext: this.planApprovalContext,
      planDecisionVersion: this.planDecisionVersion,
      actionablePlanDecisionVersion: this.actionablePlanDecisionVersion,
      canonicalPlanPromptVersion: this.canonicalPlanPromptVersion,
      approvalPromptRequiredVersion: this.approvalPromptRequiredVersion,
      approvalPromptVersion: this.approvalPromptVersion,
      approvalPromptStatus: this.approvalPromptStatus,
      approvalPromptTransport: this.approvalPromptTransport,
      approvalPromptMessageKind: this.approvalPromptMessageKind,
      approvalPromptLastAttemptAt: this.approvalPromptLastAttemptAt,
      approvalPromptDeliveredAt: this.approvalPromptDeliveredAt,
      approvalPromptFailedAt: this.approvalPromptFailedAt,
      planModeApproved: this.planModeApproved,
    };
  }

  private applyControlEvent(event: SessionControlEvent): void {
    const next = reduceSessionControlState(this.controlStateSnapshot(), event);
    this.applyControlState(next);
  }

  applyControlPatch(patch: SessionControlPatch): void {
    const next = applySessionControlPatch(this.controlStateSnapshot(), patch);
    this.applyControlState(next);
  }

  setControlField<K extends keyof SessionControlPatch>(key: K, value: SessionControlPatch[K]): void {
    this.applyControlPatch({ [key]: value } as Pick<SessionControlPatch, K>);
  }

  private applyControlState(next: SessionControlState): void {
    const previousLifecycle = this.lifecycle;
    this.lifecycle = next.lifecycle;
    this.approvalState = next.approvalState;
    this.approvalExecutionState = next.approvalExecutionState;
    this.worktreeState = next.worktreeState;
    this.runtimeState = next.runtimeState;
    this.deliveryState = next.deliveryState;
    this.pendingPlanApproval = next.pendingPlanApproval;
    this.planApprovalContext = next.planApprovalContext;
    this.planDecisionVersion = next.planDecisionVersion;
    this.actionablePlanDecisionVersion = next.actionablePlanDecisionVersion;
    this.canonicalPlanPromptVersion = next.canonicalPlanPromptVersion;
    this.approvalPromptRequiredVersion = next.approvalPromptRequiredVersion;
    this.approvalPromptVersion = next.approvalPromptVersion;
    this.approvalPromptStatus = next.approvalPromptStatus;
    this.approvalPromptTransport = next.approvalPromptTransport;
    this.approvalPromptMessageKind = next.approvalPromptMessageKind;
    this.approvalPromptLastAttemptAt = next.approvalPromptLastAttemptAt;
    this.approvalPromptDeliveredAt = next.approvalPromptDeliveredAt;
    this.approvalPromptFailedAt = next.approvalPromptFailedAt;
    this.planModeApproved = next.planModeApproved;
    if (previousLifecycle !== this.lifecycle) {
      this.emit("lifecycleChange", this, this.lifecycle, previousLifecycle);
    }
  }

  private logDiagnostic(event: string, fields: Record<string, unknown> = {}): void {
    const { backendRef: _backendRef, harnessSessionId: _harnessSessionId, ...safeFields } = fields;
    logSessionDiagnostic(event, {
      sessionId: this.id,
      name: this.name,
      status: this._status,
      lifecycle: this.lifecycle,
      runtimeState: this.runtimeState,
      harness: this.harnessName,
      hasHarnessSessionId: Boolean(this.harnessSessionId),
      ...backendRefDiagnosticFields(this.backendRef),
      ...safeFields,
    });
  }
}
