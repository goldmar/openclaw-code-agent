import { EventEmitter } from "events";
import { appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nanoid } from "nanoid";
import { getDefaultHarness, getHarness } from "./harness";
import type { AgentHarness, HarnessSession, HarnessMessage } from "./harness";
import type { SessionConfig, SessionStatus, PermissionMode, KillReason, ReasoningEffort, CodexApprovalPolicy, WorktreeStrategy, CanUseToolCallback } from "./types";
import {
  getGlobalMcpServers,
  pluginConfig,
  resolveApprovalPolicyForHarness,
  resolveDefaultModelForHarness,
  resolveReasoningEffortForHarness,
} from "./config";

const STAGE3_TRACE_LOG = "/tmp/stage3-trace.log";

function stage3Trace(fn: string, detail: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [session.ts] ${fn}: ${detail}\n`;
  try { appendFileSync(STAGE3_TRACE_LOG, line); } catch {}
}

const OUTPUT_BUFFER_MAX = 2000;
const STARTUP_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  starting: ["running", "failed", "killed"],
  running: ["completed", "failed", "killed"],
  completed: [],
  failed: [],
  killed: [],
};

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

  // Output mode
  readonly outputMode?: "deliverable";

  // Multi-turn
  readonly multiTurn: boolean;
  private messageStream?: MessageStream;

  // Pipeline notification control
  readonly notificationsEnabled: boolean;

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

  // Flags
  pendingPlanApproval: boolean = false;
  planFilePath?: string;
  killReason: KillReason = "unknown";
  private waitingForInputFired: boolean = false;
  private lastTurnHadQuestion: boolean = false;
  private planModeApproved: boolean = false;
  private turnInProgress: boolean = true;

  // AskUserQuestion intercept
  private readonly canUseTool?: CanUseToolCallback;

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
    this.codexApprovalPolicy = this.harness.name === "codex"
      ? (config.codexApprovalPolicy ?? resolveApprovalPolicyForHarness(this.harness.name) ?? pluginConfig.codexApprovalPolicy)
      : undefined;
    this.currentPermissionMode =
      this.harness.name === "codex" && this.permissionMode === "plan" ? "default" : this.permissionMode;
    this.originChannel = config.originChannel;
    this.originThreadId = config.originThreadId;
    this.originAgentId = config.originAgentId;
    this.originSessionKey = config.originSessionKey;
    this.resumeSessionId = config.resumeSessionId;
    this.forkSession = config.forkSession;
    this.multiTurn = config.multiTurn ?? true;
    this.worktreeStrategy = config.worktreeStrategy;
    this.worktreeBaseBranch = config.worktreeBaseBranch;
    this.outputMode = config.outputMode;
    this.canUseTool = config.canUseTool;
    this.notificationsEnabled = config.notificationsEnabled ?? true;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
  }

  get status(): SessionStatus { return this._status; }

  get harnessName(): string { return this.harness.name; }

  get duration(): number {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }

  get phase(): string {
    if (this._status !== "running") return this._status;
    if (this.harness.name === "codex") return "implementing";
    if (this.pendingPlanApproval) return "awaiting-plan-approval";
    if (this.currentPermissionMode === "plan") return "planning";
    return "implementing";
  }

  // -- State machine --

  transition(newStatus: SessionStatus): void {
    if (!TRANSITIONS[this._status].includes(newStatus)) {
      throw new Error(`Session state error: cannot transition from ${this._status} to ${newStatus}. This is an internal error — please report it.`);
    }
    const prev = this._status;
    this._status = newStatus;
    this.emit("statusChange", this, newStatus, prev);
  }

  // -- Timer management --

  private setTimer(name: string, ms: number, cb: () => void): void {
    this.clearTimer(name);
    this.timers.set(name, setTimeout(cb, ms));
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

  // -- Lifecycle --

  /** Launch the configured harness and start consuming harness messages. */
  async start(): Promise<void> {
    stage3Trace("Session.start", `entry — id=${this.id} name=${this.name} harness=${this.harnessName} multiTurn=${this.multiTurn} status=${this._status}`);
    try {
      let prompt: string | AsyncIterable<unknown>;
      if (this.multiTurn) {
        this.messageStream = new MessageStream();
        this.messageStream.push(
          this.harness.buildUserMessage(this.prompt, ""),
        );
        prompt = this.messageStream;
        stage3Trace("Session.start", "prompt set to messageStream (multi-turn)");
      } else {
        prompt = this.prompt;
        stage3Trace("Session.start", `prompt set to string (single-turn), len=${this.prompt.length}`);
      }

      stage3Trace("Session.start", "calling harness.launch()...");
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
      stage3Trace("Session.start", "harness.launch() returned — setting startup timer");
      this.setTimer("startup", STARTUP_TIMEOUT_MS, () => {
        stage3Trace("Session.start", `STARTUP TIMER FIRED — status=${this._status}, killing with startup-timeout`);
        if (this._status === "starting") this.kill("startup-timeout");
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      stage3Trace("Session.start", `CATCH in launch — ${message}`);
      this.transitionToTerminal("failed", { error: message });
      return;
    }

    stage3Trace("Session.start", "starting consumeMessages loop");
    this.consumeMessages(this.harnessHandle!.messages).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      stage3Trace("Session.start", `consumeMessages CATCH — ${message}`);
      console.error(`[Session ${this.id}] consumeMessages error: ${message}`, stack);
      if (this.isActive) {
        this.transitionToTerminal("failed", { error: message });
      }
    });
  }

  /**
   * Wait until the session has definitively started (`running`) or failed during startup.
   *
   * This closes the detached async gap between `spawn()` returning and the first
   * harness event arriving. Callers that orchestrate sequential stages should
   * await this before assuming the harness is alive.
   */
  waitForStartup(timeoutMs: number = STARTUP_TIMEOUT_MS): Promise<void> {
    if (this._status === "running") {
      return Promise.resolve();
    }

    if (this._status === "completed" || this._status === "failed" || this._status === "killed") {
      return Promise.reject(new Error(
        `Session ${this.id} ended during startup with status: ${this._status}${this.error ? ` — ${this.error}` : ""}`,
      ));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        this.removeListener("statusChange", onStatusChange);
        clearTimeout(timer);
      };

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onStatusChange = (_s: Session, newStatus: SessionStatus): void => {
        if (newStatus === "running") {
          settle(resolve);
          return;
        }

        if (newStatus === "completed" || newStatus === "failed" || newStatus === "killed") {
          settle(() => reject(new Error(
            `Session ${this.id} ended during startup with status: ${newStatus}${this.error ? ` — ${this.error}` : ""}`,
          )));
        }
      };

      const timer = setTimeout(() => {
        if (this._status === "starting") {
          this.kill("startup-timeout");
        }
        settle(() => reject(new Error(`Session ${this.id} did not reach running state within ${timeoutMs}ms`)));
      }, timeoutMs);

      this.on("statusChange", onStatusChange);
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
          this.pendingPlanApproval = true;
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
        this.pendingPlanApproval = false;
        if (newMode !== "plan") {
          this.planModeApproved = true;
        }
      }

      if (shouldInjectPrefix) {
        effectiveText = `[SYSTEM: The user has approved your plan. Exit plan mode immediately and implement the changes with full permissions. Do not ask for further confirmation.]\n\n${text}`;
      }
    } else if (this.pendingPlanApproval && !this.planModeApproved) {
      const toolNames = this.harness.planApprovalToolNames;
      const toolRef = toolNames.length > 0 ? ` then call ${toolNames.join(" or ")} again to re-submit for approval.` : " then re-submit your revised plan for approval.";
      effectiveText = `[SYSTEM: The user wants changes to your plan. Revise the plan based on their feedback below,${toolRef} Do NOT start implementing yet.]\n\n${text}`;

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
        this.kill("idle-timeout");
      }
    });
  }

  private teardown(): void {
    this.clearAllTimers();
    if (!this.completedAt) this.completedAt = Date.now();
    if (this.messageStream) this.messageStream.end();
    // Abort the controller — this signals the SDK to stop cleanly.
    // Do NOT call harnessHandle.interrupt() here: the Claude Code SDK writes
    // to a socket synchronously inside interrupt(), and if the socket is already
    // closed (e.g. single-turn completion), it emits an uncaught 'error' event
    // on the socket that crashes the entire gateway process.
    // The abort signal achieves the same cleanup without the dangerous socket write.
    this.abortController.abort();
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
    this.transition(status);
    this.teardown();
  }

  private async consumeMessages(messages: AsyncIterable<HarnessMessage>): Promise<void> {
    let sawInit = false;
    let sawResult = false;
    let msgCount = 0;

    stage3Trace("consumeMessages", `entry — id=${this.id} status=${this._status}`);

    for await (const msg of messages) {
      msgCount++;
      if (msgCount === 1) {
        stage3Trace("consumeMessages", `first message received — type=${msg.type} status=${this._status} elapsed=${Date.now() - this.startedAt}ms`);
      }

      // After terminal transition we intentionally ignore late harness events.
      // This avoids spurious turnEnd/output processing from in-flight subprocess
      // shutdown messages after kill/complete/fail.
      if (!this.isActive) {
        stage3Trace("consumeMessages", `session no longer active (status=${this._status}), breaking`);
        break;
      }

      this.resetIdleTimer();

      if (msg.type === "init") {
        sawInit = true;
        this.clearTimer("startup");
        this.harnessSessionId = msg.session_id;
        stage3Trace("consumeMessages", `init received — session_id=${msg.session_id}, transitioning starting→running`);
        if (this._status === "starting") {
          this.transition("running");
        }
      } else if (msg.type === "text") {
        this.waitingForInputFired = false;
        // Don't reset lastTurnHadQuestion if we already detected a plan
        // approval tool — pendingPlanApproval is the authoritative flag.
        if (!this.pendingPlanApproval) {
          this.lastTurnHadQuestion = false;
        }
        this.outputBuffer.push(msg.text);
        if (this.outputBuffer.length > OUTPUT_BUFFER_MAX) {
          this.outputBuffer.splice(0, this.outputBuffer.length - OUTPUT_BUFFER_MAX);
        }
        try {
          appendFileSync(join(tmpdir(), `openclaw-agent-${this.id}.txt`), msg.text + "\n", "utf-8");
        } catch {
          // best-effort; don't let disk errors interrupt the session
        }
        this.emit("output", this, msg.text);
      } else if (msg.type === "tool_use") {
        // Track plan file writes so agent_output can surface the plan content.
        if (msg.name === "Write") {
          const input = msg.input as Record<string, unknown>;
          if (typeof input?.file_path === "string" && input.file_path.includes("/.claude/plans/")) {
            this.planFilePath = input.file_path;
          }
        }
        if (this.harness.questionToolNames.includes(msg.name)) {
          this.lastTurnHadQuestion = true;
          // Defensive: CC normally uses ExitPlanMode in plan mode, but if it
          // uses AskUserQuestion instead, treat it as a plan approval signal.
          if (this.currentPermissionMode === "plan" && !this.planModeApproved) {
            this.pendingPlanApproval = true;
          }
        } else if (this.harness.planApprovalToolNames.includes(msg.name) && !this.planModeApproved) {
          this.lastTurnHadQuestion = true;
          this.pendingPlanApproval = true;
        }
        this.emit("toolUse", this, msg.name, msg.input);
      } else if (msg.type === "permission_mode_change") {
        // Defensive: SDK does not currently emit this event (see docs/internal/PLAN-MODE-INVESTIGATION.md).
        // Kept for forward-compatibility if future SDK versions emit system/status permissionMode changes.
        const oldMode = this.currentPermissionMode;
        this.currentPermissionMode = msg.mode as PermissionMode;
        if (msg.mode !== "plan" && oldMode === "plan" && !this.planModeApproved) {
          this.pendingPlanApproval = true;
          this.lastTurnHadQuestion = true;
        }
      } else if (msg.type === "result") {
        stage3Trace("consumeMessages", `result received — success=${msg.data.success} status=${this._status} multiTurn=${this.multiTurn}`);
        sawResult = true;
        if (!this.harnessSessionId && msg.data.session_id) {
          this.harnessSessionId = msg.data.session_id;
        }
        this.result = {
          subtype: msg.data.success ? "success" : "error",
          duration_ms: msg.data.duration_ms,
          total_cost_usd: msg.data.total_cost_usd,
          num_turns: msg.data.num_turns,
          result: msg.data.result,
          is_error: !msg.data.success,
          session_id: msg.data.session_id,
        };
        this.costUsd = msg.data.total_cost_usd;

        const isMultiTurnEndOfTurn = this.multiTurn && this.messageStream && msg.data.success;

        if (isMultiTurnEndOfTurn) {
          this.resetIdleTimer();

          // If the session is in plan mode and the turn completed, CC finished presenting
          // its plan and is waiting for approval. The SDK does NOT fire a system/status
          // permissionMode change event — it just stops streaming. So we set
          // pendingPlanApproval here based on currentPermissionMode.
          if (
            this.currentPermissionMode === "plan" &&
            !this.pendingPlanApproval &&
            !this.planModeApproved
          ) {
            this.pendingPlanApproval = true;
          }

          // Use pendingPlanApproval OR lastTurnHadQuestion — pendingPlanApproval
          // is authoritative for the plan approval path (it survives text resets).
          const needsInput = this.pendingPlanApproval || this.lastTurnHadQuestion;
          const hasPending = this.messageStream?.hasPending() === true;
          this.turnInProgress = hasPending;
          if (needsInput && !this.waitingForInputFired) {
            this.waitingForInputFired = true;
            this.emit("turnEnd", this, true);
          } else if (hasPending) {
            // Follow-up user messages were queued during this turn; keep the
            // session alive so the harness can consume them on the next turn.
          } else if (!needsInput) {
            this.emit("turnEnd", this, false);
            // `complete("done")` means "natural turn completion with no user
            // input needed". This is intentionally different from `kill("done")`:
            // completion emits the success lifecycle path and avoids killed/failure
            // terminal handling noise.
            this.complete("done");
          }
        } else {
          this.turnInProgress = false;
          this.transitionToTerminal(msg.data.success ? "completed" : "failed");
        }
        this.lastTurnHadQuestion = false;
      } else if (msg.type === "activity") {
        // Keepalive ping for long-running subprocesses with no output.
      }
    }

    // After the for-await loop (the stream has closed)
    stage3Trace("consumeMessages", `loop ended — totalMessages=${msgCount} sawInit=${sawInit} sawResult=${sawResult} status=${this._status}`);
    // If we're still active, the harness closed without a terminal result — force fail
    if (this.isActive) {
      stage3Trace("consumeMessages", "still active after stream closed — forcing failed");
      console.warn(`[Session ${this.id}] Harness stream closed without terminal result. Forcing failed.`);
      this.transitionToTerminal("failed", {
        error: "Harness stream closed without terminal result",
      });
    }
  }
}
