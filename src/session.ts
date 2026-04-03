import { EventEmitter } from "events";
import { nanoid } from "nanoid";
import { getDefaultHarness, getHarness } from "./harness";
import type { AgentHarness, HarnessSession, HarnessMessage } from "./harness";
import type {
  ApprovalExecutionState,
  PendingInputState,
  PlanArtifact,
  SessionConfig,
  SessionStatus,
  PermissionMode,
  KillReason,
  ReasoningEffort,
  CodexApprovalPolicy,
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
} from "./types";
import {
  getGlobalMcpServers,
  pluginConfig,
  resolveDefaultModelForHarness,
  resolveReasoningEffortForHarness,
} from "./config";
import { getBackendConversationId } from "./session-backend-ref";
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
import { getBranchName } from "./worktree";

const STARTUP_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
export { getSessionOutputFilePath } from "./session-output";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  private readonly systemPrompt?: string;
  private readonly allowedTools?: string[];
  private readonly permissionMode: PermissionMode;
  readonly requestedPermissionMode: PermissionMode;
  readonly planApproval: PlanApprovalMode;
  readonly codexApprovalPolicy?: CodexApprovalPolicy;
  currentPermissionMode: PermissionMode;
  private pendingModeSwitch?: PermissionMode;

  // Resume/fork
  readonly resumeSessionId?: string;
  readonly forkSession?: boolean;

  // Worktree
  worktreePath?: string;
  originalWorkdir?: string;
  worktreeBranch?: string; // Fix 2-B: cached at creation to avoid live lookups after worktree removal
  readonly worktreeStrategy?: WorktreeStrategy;
  readonly worktreeBaseBranch?: string;
  worktreePrTargetRepo?: string;
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

  // State
  private _status: SessionStatus = "starting";
  error?: string;
  startedAt: number;
  completedAt?: number;

  // Abort
  private abortController: AbortController;

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

  // Origin
  originChannel?: string;
  originThreadId?: string | number;
  readonly originAgentId?: string;
  readonly originSessionKey?: string;
  route?: SessionRoute;
  pendingInputState?: PendingInputState;

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
  lifecycle: SessionLifecycle = "starting";
  approvalState: SessionApprovalState = "not_required";
  approvalExecutionState: ApprovalExecutionState = "not_plan_gated";
  runtimeState: SessionRuntimeState = "live";
  deliveryState: SessionDeliveryState = "idle";

  // AskUserQuestion intercept
  private readonly canUseTool?: CanUseToolCallback;

  // Auto-respond counter
  autoRespondCount: number = 0;

  // Centralized timer management
  private readonly timers = new SessionTimerRegistry();

  constructor(config: SessionConfig, name: string) {
    super();
    this.id = config.sessionIdOverride ?? nanoid(8);
    this.name = name;
    this.harness = config.harness ? getHarness(config.harness) : getDefaultHarness();
    this.prompt = config.prompt;
    this.workdir = config.workdir;
    this.model = config.model ?? resolveDefaultModelForHarness(this.harness.name);
    this.reasoningEffort = config.reasoningEffort ?? resolveReasoningEffortForHarness(this.harness.name);
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools;
    this.permissionMode = config.permissionMode ?? pluginConfig.permissionMode;
    this.requestedPermissionMode = config.requestedPermissionMode ?? this.permissionMode;
    this.planApproval = config.planApproval ?? pluginConfig.planApproval;
    this.codexApprovalPolicy = this.harness.name === "codex"
      ? "never"
      : undefined;
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
    this.forkSession = config.forkSession;
    this.multiTurn = config.multiTurn ?? true;
    this.goalTaskId = config.goalTaskId;
    this.worktreeStrategy = config.worktreeStrategy;
    this.worktreeBaseBranch = config.worktreeBaseBranch;
    if (config.worktreePrTargetRepo) {
      this.worktreePrTargetRepo = config.worktreePrTargetRepo;
    }
    this.canUseTool = config.canUseTool;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
    this.turnRuntime = new SessionTurnRuntime({
      appendOutput: (text) => appendSessionOutput(this.outputBuffer, this.id, text),
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
      setPlanFilePath: (path) => { this.planFilePath = path; },
    });
    this.harnessEvents = new SessionHarnessEventApplier({
      clearStartupTimer: () => this.clearTimer("startup"),
      assignBackendRef: (ref) => {
        this.backendRef = ref;
        this.harnessSessionId = ref.conversationId;
        if (ref.worktreePath) {
          this.worktreePath = ref.worktreePath;
          this.originalWorkdir ??= this.workdir;
          this.worktreeBranch ??= getBranchName(ref.worktreePath);
          if (this.worktreeStrategy && this.worktreeStrategy !== "off") {
            this.applyControlEvent({ type: "worktree.state_set", worktreeState: "provisioned" });
          }
        }
      },
      noteRunStarted: (runId) => {
        if (this.backendRef) {
          this.backendRef = { ...this.backendRef, runId };
        }
      },
      transitionRunning: () => {
        if (this._status === "starting") {
          this.transition("running");
        }
      },
      noteTextDelta: (text, pendingPlanApproval) => this.turnRuntime.noteTextDelta(text, pendingPlanApproval),
      noteToolCall: (args) => this.turnRuntime.noteToolCall(args),
      setPendingInputState: (state) => { this.pendingInputState = state; },
      notePendingInput: () => this.turnRuntime.notePendingInput(),
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
        this.result = {
          subtype: data.success ? "success" : "error",
          duration_ms: data.duration_ms,
          total_cost_usd: data.total_cost_usd,
          num_turns: data.num_turns,
          result: data.result,
          is_error: !data.success,
          session_id: data.session_id,
        };
        this.costUsd = data.total_cost_usd;

        const isMultiTurnEndOfTurn = this.multiTurn && this.messageStream && data.success;

        if (isMultiTurnEndOfTurn) {
          this.resetIdleTimer();
          this.turnRuntime.finishSuccessfulTurn({
            currentPermissionMode: this.currentPermissionMode,
            permissionMode: this.permissionMode,
            pendingPlanApproval: this.pendingPlanApproval,
            planModeApproved: this.planModeApproved,
            pendingInputState: this.pendingInputState,
            hasPendingMessages: this.messageStream?.hasPending() === true,
          });
        } else {
          this.turnRuntime.finishTerminalTurn();
          this.transitionToTerminal(data.success ? "completed" : "failed");
        }
        this.turnRuntime.resetAfterRun();
        this.pendingInputState = undefined;
      },
    });
    this.applyControlEvent({ type: "initialize", hasWorktree: !!(this.worktreeStrategy && this.worktreeStrategy !== "off") });
    if (
      config.planModeApproved !== undefined
      || config.approvalState !== undefined
      || config.approvalExecutionState !== undefined
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

  private get waitingForInputFired(): boolean {
    return this.turnRuntime.waitingForInputFired;
  }

  private set waitingForInputFired(value: boolean) {
    this.turnRuntime.waitingForInputFired = value;
  }

  private get lastTurnHadQuestion(): boolean {
    return this.turnRuntime.lastTurnHadQuestion;
  }

  private set lastTurnHadQuestion(value: boolean) {
    this.turnRuntime.lastTurnHadQuestion = value;
  }

  private get turnInProgress(): boolean {
    return this.turnRuntime.turnInProgress;
  }

  private set turnInProgress(value: boolean) {
    this.turnRuntime.turnInProgress = value;
  }

  private get currentTurnText(): string {
    return this.turnRuntime.currentTurnText;
  }

  private set currentTurnText(value: string) {
    this.turnRuntime.currentTurnText = value;
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
    this.applyControlEvent({ type: "plan.requested", context });
  }

  private clearPendingPlanApproval(): void {
    this.applyControlEvent({ type: "plan.cleared" });
  }

  markAwaitingUserInput(): void {
    this.applyControlEvent({ type: "input.requested" });
  }

  // -- Lifecycle --

  /** Launch the configured harness and start consuming harness messages. */
  async start(): Promise<void> {
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
        permissionMode: this.permissionMode,
        codexApprovalPolicy: this.codexApprovalPolicy,
        systemPrompt: this.systemPrompt,
        allowedTools: this.allowedTools,
        resumeSessionId: this.resumeSessionId,
        forkSession: this.forkSession,
        backendRef: this.backendRef,
        worktreeStrategy: this.worktreeStrategy,
        originalWorkdir: this.originalWorkdir ?? this.workdir,
        abortController: this.abortController,
        mcpServers: getGlobalMcpServers(),
        canUseTool: this.canUseTool,
      });
      this.harnessHandle = handle;
      this.setTimer("startup", STARTUP_TIMEOUT_MS, () => {
        if (this._status === "starting") this.kill("startup-timeout");
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.transitionToTerminal("failed", { error: message });
      return;
    }

    this.consumeMessages(this.harnessHandle!.messages).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(`[Session ${this.id}] consumeMessages error: ${message}`, stack);
      if (this.isActive) {
        this.transitionToTerminal("failed", { error: message });
      }
    });
  }

  /** Send a follow-up user message to a running multi-turn session. */
  async sendMessage(text: string): Promise<void> {
    if (this._status !== "running") {
      throw new Error(`Session is not running (status: ${this._status})`);
    }

    this.resetIdleTimer();
    this.turnRuntime.beginUserTurn();
    this.applyControlEvent({ type: "turn.started" });

    let effectiveText = text;
    if (this.pendingModeSwitch) {
      const newMode = this.pendingModeSwitch;
      let shouldInjectPrefix = false;
      let appliedApprovalPath = false;
      if (this.harnessHandle?.setPermissionMode) {
        try {
          await this.harnessHandle.setPermissionMode(newMode);
          this.currentPermissionMode = newMode;
          this.applyControlEvent({ type: "permission.mode_changed", currentPermissionMode: newMode });
          this.pendingModeSwitch = undefined;
          appliedApprovalPath = true;
          shouldInjectPrefix = true;
        } catch (err: unknown) {
          console.error(`[Session ${this.id}] setPermissionMode(${newMode}) FAILED: ${errorMessage(err)}`);
          // Preserve the pending approval state so callers can retry cleanly.
          this.markPendingPlanApproval(this.planApprovalContext ?? "plan-mode");
          throw new Error(`Failed to switch permission mode to ${newMode}: ${errorMessage(err)}`);
        }
      } else {
        // Harness doesn't support setPermissionMode — inject text prefix as best-effort fallback
        this.pendingModeSwitch = undefined;
        appliedApprovalPath = true;
        shouldInjectPrefix = true;
        console.warn(`[Session ${this.id}] Cannot call setPermissionMode — falling back to text prefix only (currentPermissionMode remains ${this.currentPermissionMode})`);
      }

        if (appliedApprovalPath) {
          // Only clear pendingPlanApproval when the approval path is actually applied.
          this.clearPendingPlanApproval();
          if (newMode !== "plan") {
            this.applyControlEvent({ type: "plan.approved" });
          }
        }

      if (shouldInjectPrefix) {
        effectiveText = `[SYSTEM: The user has approved your plan. Exit plan mode immediately and implement the changes with full permissions. Do not ask for further confirmation.]\n\n${text}`;
      }
    } else if ((this.pendingPlanApproval || this.approvalState === "changes_requested") && !this.planModeApproved) {
      if (this.approvalState !== "changes_requested") {
        this.applyControlEvent({ type: "plan.changes_requested" });
      }
      effectiveText = `[SYSTEM: The user wants changes to your plan. Revise the plan based on their feedback below, then re-submit your revised plan for approval. Do NOT start implementing yet.]\n\n${text}`;

      // Re-assert plan mode at the SDK level. CC's previous ExitPlanMode call
      // may have changed its internal permissions — force it back to plan mode
      // so it can only use read-only tools during revision.
      if (this.harnessHandle?.setPermissionMode) {
        try {
          await this.harnessHandle.setPermissionMode("plan");
          this.currentPermissionMode = "plan";
          this.applyControlEvent({ type: "permission.mode_changed", currentPermissionMode: "plan" });
        } catch (err: unknown) {
          console.warn(`[Session ${this.id}] Failed to re-assert plan mode: ${errorMessage(err)}`);
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
  }

  /** Interrupt the currently running turn, if the harness supports it. */
  async interrupt(): Promise<boolean> {
    if (!this.turnInProgress || !this.harnessHandle?.interrupt) {
      return false;
    }

    await this.harnessHandle.interrupt();
    return true;
  }

  async submitPendingInputOption(optionIndex: number): Promise<boolean> {
    if (!this.pendingInputState || !this.harnessHandle?.submitPendingInputOption) {
      return false;
    }
    const submitted = await this.harnessHandle.submitPendingInputOption(optionIndex);
    if (submitted) {
      this.waitingForInputFired = false;
    }
    return submitted;
  }

  async submitPendingInputText(text: string): Promise<boolean> {
    if (!this.pendingInputState || !this.harnessHandle?.submitPendingInputText) {
      return false;
    }
    const submitted = await this.harnessHandle.submitPendingInputText(text);
    if (submitted) {
      this.waitingForInputFired = false;
    }
    return submitted;
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

  private resetIdleTimer(): void {
    if (!this.multiTurn) return;
    const idleTimeoutMs = (pluginConfig.idleTimeoutMinutes ?? 15) * 60 * 1000;
    this.setTimer("idle", idleTimeoutMs, () => {
      if (this._status === "running") {
        this.applyControlEvent({ type: "terminal.entered", suspended: true });
        this.kill("idle-timeout");
      }
    });
  }

  private teardown(): void {
    this.clearAllTimers();
    if (!this.completedAt) this.completedAt = Date.now();
    if (this.messageStream) this.messageStream.end();
    if (this.harnessHandle?.interrupt) {
      void this.harnessHandle.interrupt().catch((err: unknown) => {
        console.warn(`[Session ${this.id}] interrupt during teardown failed: ${errorMessage(err)}`);
      });
    }
    this.abortController.abort();
    this.applyControlEvent({ type: "terminal.entered", suspended: this.lifecycle === "suspended" });
  }

  /**
   * Enter a terminal state in strict order so listeners persist consistent data:
   * 1) set terminal metadata (`killReason` / `error` / `completedAt`)
   * 2) emit the state transition
   * 3) teardown timers/streams/process signal
   */
  private transitionToTerminal(
    status: Extract<SessionStatus, "completed" | "failed" | "killed">,
    options: { reason?: KillReason; error?: string } = {},
  ): void {
    if (!this.isActive) return;
    this.turnInProgress = false;
    if (options.reason) this.killReason = options.reason;
    if (options.error !== undefined) this.error = options.error;
    this.completedAt = Date.now();
    this.applyControlEvent({
      type: "terminal.entered",
      suspended: status === "killed" && options.reason === "idle-timeout",
    });
    this.transition(status);
    this.teardown();
  }

  private async consumeMessages(messages: AsyncIterable<HarnessMessage>): Promise<void> {
    for await (const msg of messages) {
      // After terminal transition we intentionally ignore late harness events.
      // This avoids spurious turnEnd/output processing from in-flight subprocess
      // shutdown messages after kill/complete/fail.
      if (!this.isActive) {
        break;
      }

      this.resetIdleTimer();
      this.harnessEvents.applyMessage(msg, {
        pendingPlanApproval: this.pendingPlanApproval,
        currentPermissionMode: this.currentPermissionMode,
        permissionMode: this.permissionMode,
        planModeApproved: this.planModeApproved,
        pendingInputState: this.pendingInputState,
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

  private applyControlState(next: SessionControlState): void {
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
  }
}
