import { EventEmitter } from "events";
import { appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nanoid } from "nanoid";
import { getDefaultHarness, getHarness } from "./harness";
import type { AgentHarness, HarnessSession, HarnessMessage } from "./harness";
import type {
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
  SessionWorktreeState,
  SessionRuntimeState,
  SessionDeliveryState,
  SessionRoute,
  SessionBackendRef,
  TurnBoundaryDecision,
  TurnBoundaryDecisionCallback,
} from "./types";
import {
  getGlobalMcpServers,
  pluginConfig,
  resolveApprovalPolicyForHarness,
  resolveDefaultModelForHarness,
  resolveReasoningEffortForHarness,
} from "./config";
import {
  reduceSessionControlState,
  SESSION_STATUS_TRANSITIONS,
  type SessionControlEvent,
  type SessionControlPatch,
  type SessionControlState,
  applySessionControlPatch,
} from "./session-state";

const OUTPUT_BUFFER_MAX = 2000;
const STARTUP_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export function getSessionOutputFilePath(sessionId: string): string {
  return join(tmpdir(), `openclaw-agent-${sessionId}.txt`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Async queue used as the prompt stream for multi-turn harnesses.
 *
 * `Session.sendMessage()` pushes follow-up user messages into this queue and
 * the harness consumes it with `for await`.
 *
 * `hasPending()` is critical at turn boundaries: if follow-up prompts were
 * queued during an active turn, we keep the session alive so the queue can be
 * drained on the next turn instead of killing with reason `done`.
 */
class MessageStream {
  private queue: unknown[] = [];
  private resolve: (() => void) | null = null;
  private done: boolean = false;

  /** Return true when follow-up prompts are queued but not consumed yet. */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  push(msg: unknown): void {
    this.queue.push(msg);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  end(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, undefined> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => { this.resolve = r; });
    }
  }
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
  worktreeState: SessionWorktreeState = "none";

  // Multi-turn
  readonly multiTurn: boolean;
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
  planFilePath?: string;
  killReason: KillReason = "unknown";
  private waitingForInputFired: boolean = false;
  private lastTurnHadQuestion: boolean = false;
  private planModeApproved: boolean = false;
  private turnInProgress: boolean = true;
  private currentTurnText: string = "";
  private currentTurnPlanArtifact?: PlanArtifact;
  lifecycle: SessionLifecycle = "starting";
  approvalState: SessionApprovalState = "not_required";
  runtimeState: SessionRuntimeState = "live";
  deliveryState: SessionDeliveryState = "idle";

  // AskUserQuestion intercept
  private readonly canUseTool?: CanUseToolCallback;
  private readonly turnBoundaryDecision?: TurnBoundaryDecisionCallback;

  // Auto-respond counter
  autoRespondCount: number = 0;

  // Centralized timer management
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: SessionConfig, name: string) {
    super();
    this.id = nanoid(8);
    this.name = name;
    this.harness = config.harness ? getHarness(config.harness) : getDefaultHarness();
    this.prompt = config.prompt;
    this.workdir = config.workdir;
    this.model = config.model ?? resolveDefaultModelForHarness(this.harness.name);
    this.reasoningEffort = config.reasoningEffort ?? resolveReasoningEffortForHarness(this.harness.name);
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools;
    this.permissionMode = config.permissionMode ?? pluginConfig.permissionMode;
    this.planApproval = config.planApproval ?? pluginConfig.planApproval;
    this.codexApprovalPolicy = this.harness.name === "codex"
      ? (config.codexApprovalPolicy ?? resolveApprovalPolicyForHarness(this.harness.name) ?? pluginConfig.codexApprovalPolicy)
      : undefined;
    // Keep currentPermissionMode in sync with permissionMode for all harnesses.
    // Codex uses a first-turn planning prompt wrapper rather than a native SDK
    // plan mode, but the session still needs to track explicit plan state so
    // pendingPlanApproval is set at the end of the first turn and the
    // Approve/Reject/Revise buttons fire via triggerWaitingForInputEvent.
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
    this.worktreeStrategy = config.worktreeStrategy;
    this.worktreeBaseBranch = config.worktreeBaseBranch;
    if (config.worktreePrTargetRepo) {
      this.worktreePrTargetRepo = config.worktreePrTargetRepo;
    }
    this.canUseTool = config.canUseTool;
    this.turnBoundaryDecision = config.turnBoundaryDecision;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
    this.applyControlEvent({ type: "initialize", hasWorktree: !!(this.worktreeStrategy && this.worktreeStrategy !== "off") });
  }

  get status(): SessionStatus { return this._status; }

  get harnessName(): string { return this.harness.name; }

  get duration(): number {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }

  get phase(): string {
    return this.lifecycle;
  }

  get isExplicitlyResumable(): boolean {
    return this.lifecycle === "suspended";
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
    this.clearTimer(name);
    const timer = setTimeout(cb, ms);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  private clearTimer(name: string): void {
    const t = this.timers.get(name);
    if (t) {
      clearTimeout(t);
      this.timers.delete(name);
    }
  }

  private clearAllTimers(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
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

  markPendingPlanApprovalFromClassifier(context: PlanApprovalContext): void {
    this.markPendingPlanApproval(context);
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
    this.waitingForInputFired = false;
    this.turnInProgress = true;
    this.currentTurnText = "";
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
    } else if (this.pendingPlanApproval && !this.planModeApproved) {
      this.applyControlEvent({ type: "plan.changes_requested" });
      effectiveText = `[SYSTEM: The user wants changes to your plan. Revise the plan based on their feedback below, then re-submit your revised plan for approval. Do NOT start implementing yet.]\n\n${text}`;

      // Re-assert plan mode at the SDK level. CC's previous ExitPlanMode call
      // may have changed its internal permissions — force it back to plan mode
      // so it can only use read-only tools during revision.
      if (this.harnessHandle?.setPermissionMode) {
        try {
          await this.harnessHandle.setPermissionMode("plan");
          this.currentPermissionMode = "plan";
        } catch (err: unknown) {
          console.warn(`[Session ${this.id}] Failed to re-assert plan mode: ${errorMessage(err)}`);
        }
      }
    }

    if (this.multiTurn && this.messageStream) {
      this.messageStream.push(
        this.harness.buildUserMessage(effectiveText, this.harnessSessionId ?? ""),
      );
    } else if (this.harnessHandle?.streamInput) {
      const msg = this.harness.buildUserMessage(effectiveText, this.harnessSessionId ?? "");
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

      if (msg.type === "backend_ref" || msg.type === "init") {
        this.clearTimer("startup");
        if (msg.type === "backend_ref") {
          this.backendRef = { ...msg.ref };
          this.harnessSessionId = msg.ref.conversationId;
        } else {
          this.harnessSessionId = msg.session_id;
          this.backendRef = this.backendRef ?? {
            kind: this.harnessName === "codex" ? "codex-app-server" : "claude-code",
            conversationId: msg.session_id,
          };
        }
        if (this._status === "starting") {
          this.transition("running");
        }
      } else if (msg.type === "run_started") {
        if (msg.runId && this.backendRef) {
          this.backendRef = { ...this.backendRef, runId: msg.runId };
        }
      } else if (msg.type === "text_delta" || msg.type === "text") {
        const text = msg.type === "text_delta" ? msg.text : msg.text;
        this.waitingForInputFired = false;
        // Don't reset lastTurnHadQuestion if we already detected a plan
        // approval tool — pendingPlanApproval is the authoritative flag.
        if (!this.pendingPlanApproval) {
          this.lastTurnHadQuestion = false;
        }
        this.outputBuffer.push(text);
        if (this.outputBuffer.length > OUTPUT_BUFFER_MAX) {
          this.outputBuffer.splice(0, this.outputBuffer.length - OUTPUT_BUFFER_MAX);
        }
        this.currentTurnText += this.currentTurnText ? `\n${text}` : text;
        try {
          appendFileSync(getSessionOutputFilePath(this.id), text + "\n", "utf-8");
        } catch {
          // best-effort; don't let disk errors interrupt the session
        }
        this.emit("output", this, text);
      } else if (msg.type === "tool_call" || msg.type === "tool_use") {
        const name = msg.type === "tool_call" ? msg.name : msg.name;
        const input = msg.type === "tool_call" ? msg.input : msg.input;
        // Track plan file writes so agent_output can surface the plan content.
        if (name === "Write") {
          const writeInput = input as Record<string, unknown>;
          if (typeof writeInput?.file_path === "string" && writeInput.file_path.includes("/.claude/plans/")) {
            this.planFilePath = writeInput.file_path;
          }
        }
        if (msg.type === "tool_use") {
          if (name === "AskUserQuestion") {
            this.lastTurnHadQuestion = true;
            this.applyControlEvent({ type: "input.requested" });
            if ((this.currentPermissionMode === "plan" || this.permissionMode === "plan") && !this.planModeApproved) {
              this.markPendingPlanApproval("plan-mode");
            }
          } else if ((name === "ExitPlanMode" || name === "set_permission_mode") && !this.planModeApproved) {
            this.lastTurnHadQuestion = true;
            this.markPendingPlanApproval("plan-mode");
          }
        }
        this.emit("toolUse", this, name, input);
      } else if (msg.type === "pending_input") {
        this.pendingInputState = msg.state;
        this.lastTurnHadQuestion = true;
        this.applyControlEvent({ type: "input.requested" });
        if (!this.waitingForInputFired) {
          this.waitingForInputFired = true;
          this.emit("turnEnd", this, true);
        }
      } else if (msg.type === "pending_input_resolved") {
        if (!msg.requestId || this.pendingInputState?.requestId === msg.requestId) {
          this.pendingInputState = undefined;
        }
      } else if (msg.type === "plan_artifact") {
        this.currentTurnPlanArtifact = msg.artifact;
        if (msg.finalized) {
          const markdown = msg.artifact.markdown.trim();
          if (markdown && this.currentTurnText.trim() !== markdown) {
            this.outputBuffer.push(markdown);
            if (this.outputBuffer.length > OUTPUT_BUFFER_MAX) {
              this.outputBuffer.splice(0, this.outputBuffer.length - OUTPUT_BUFFER_MAX);
            }
            this.currentTurnText = markdown;
            try {
              appendFileSync(getSessionOutputFilePath(this.id), markdown + "\n", "utf-8");
            } catch {
              // best-effort
            }
            this.emit("output", this, markdown);
          }
        }
      } else if (msg.type === "settings_changed" || msg.type === "permission_mode_change") {
        // Defensive: SDK does not currently emit this event (see docs/internal/PLAN-MODE-INVESTIGATION.md).
        // Kept for forward-compatibility if future SDK versions emit system/status permissionMode changes.
        const oldMode = this.currentPermissionMode;
        const permissionMode = msg.type === "settings_changed" ? msg.permissionMode : msg.mode;
        if (permissionMode) {
          this.currentPermissionMode = permissionMode as PermissionMode;
        }
        if (permissionMode && permissionMode !== "plan" && oldMode === "plan" && !this.planModeApproved) {
          this.markPendingPlanApproval("plan-mode");
          this.lastTurnHadQuestion = true;
        }
      } else if (msg.type === "run_completed" || msg.type === "result") {
        const data = msg.data;
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

          // If the session is in plan mode and the turn completed, CC finished presenting
          // its plan and is waiting for approval. The SDK does NOT fire a system/status
          // permissionMode change event — it just stops streaming. So we set
          // pendingPlanApproval here based on currentPermissionMode.
          if (
            (this.currentPermissionMode === "plan" || this.permissionMode === "plan") &&
            !this.pendingPlanApproval &&
            !this.planModeApproved
          ) {
            this.markPendingPlanApproval("plan-mode");
          }

          // Use pendingPlanApproval OR lastTurnHadQuestion — pendingPlanApproval
          // is authoritative for the plan approval path (it survives text resets).
          const needsInput = this.pendingPlanApproval || this.lastTurnHadQuestion || !!this.pendingInputState;
          const hasPending = this.messageStream?.hasPending() === true;
          this.turnInProgress = hasPending;
          if (needsInput && !this.waitingForInputFired) {
            this.waitingForInputFired = true;
            if (!this.pendingPlanApproval) {
              this.applyControlEvent({ type: "input.requested" });
            }
            this.emit("turnEnd", this, true);
          } else if (hasPending) {
            // Follow-up user messages were queued during this turn; keep the
            // session alive so the harness can consume them on the next turn.
          } else if (!needsInput) {
            const semanticDecision = await this.resolveTurnBoundaryDecision(this.currentTurnText);
            if (semanticDecision === "awaiting_plan_decision") {
              const planContext: PlanApprovalContext =
                this.currentPermissionMode === "plan" || this.permissionMode === "plan"
                  ? "plan-mode"
                  : "codex-first-turn-plan";
              this.markPendingPlanApproval(planContext);
              this.lastTurnHadQuestion = true;
              this.waitingForInputFired = true;
              this.emit("turnEnd", this, true);
            } else if (semanticDecision === "awaiting_user_input") {
              this.lastTurnHadQuestion = true;
              this.waitingForInputFired = true;
              this.applyControlEvent({ type: "input.requested" });
              this.emit("turnEnd", this, true);
            } else {
              this.applyControlEvent({ type: "terminal.entered" });
              this.emit("turnEnd", this, false);
              // `complete("done")` means "natural turn completion with no user
              // input needed". This is intentionally different from `kill("done")`:
              // completion emits the success lifecycle path and avoids killed/failure
              // terminal handling noise.
              this.complete("done");
            }
          }
        } else {
          this.turnInProgress = false;
          this.transitionToTerminal(data.success ? "completed" : "failed");
        }
        this.lastTurnHadQuestion = false;
        this.currentTurnText = "";
        this.currentTurnPlanArtifact = undefined;
        this.pendingInputState = undefined;
      } else if (msg.type === "activity") {
        // Keepalive ping for long-running subprocesses with no output.
      }
    }
  }

  private async resolveTurnBoundaryDecision(turnText: string): Promise<TurnBoundaryDecision> {
    if (!this.turnBoundaryDecision) return "complete";
    try {
      return await this.turnBoundaryDecision({
        sessionId: this.id,
        sessionName: this.name,
        prompt: this.prompt,
        workdir: this.workdir,
        harnessName: this.harnessName,
        permissionMode: this.permissionMode,
        currentPermissionMode: this.currentPermissionMode,
        originAgentId: this.originAgentId,
        turnText,
      });
    } catch (err) {
      console.warn(`[Session ${this.id}] turnBoundaryDecision failed: ${errorMessage(err)}`);
      return "complete";
    }
  }

  controlStateSnapshot(): SessionControlState {
    return {
      status: this._status,
      lifecycle: this.lifecycle,
      approvalState: this.approvalState,
      worktreeState: this.worktreeState,
      runtimeState: this.runtimeState,
      deliveryState: this.deliveryState,
      pendingPlanApproval: this.pendingPlanApproval,
      planApprovalContext: this.planApprovalContext,
      planDecisionVersion: this.planDecisionVersion,
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
    this.worktreeState = next.worktreeState;
    this.runtimeState = next.runtimeState;
    this.deliveryState = next.deliveryState;
    this.pendingPlanApproval = next.pendingPlanApproval;
    this.planApprovalContext = next.planApprovalContext;
    this.planDecisionVersion = next.planDecisionVersion;
    this.planModeApproved = next.planModeApproved;
  }
}
