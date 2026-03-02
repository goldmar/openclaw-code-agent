import { EventEmitter } from "events";
import { nanoid } from "nanoid";
import { getDefaultHarness, getHarness } from "./harness";
import type { AgentHarness, HarnessSession, HarnessMessage } from "./harness";
import type { SessionConfig, SessionStatus, PermissionMode, KillReason } from "./types";
import { pluginConfig, getGlobalMcpServers } from "./config";

const OUTPUT_BUFFER_MAX = 200;
const SAFETY_NET_TIMER_MS = 45_000;

const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  starting: ["running", "failed", "killed"],
  running: ["completed", "failed", "killed"],
  completed: [],
  failed: [],
  killed: [],
};

/**
 * AsyncIterable controller for multi-turn conversations.
 */
class MessageStream {
  private queue: any[] = [];
  private resolve: (() => void) | null = null;
  private done: boolean = false;

  push(msg: any): void {
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

  async *[Symbol.asyncIterator](): AsyncGenerator<any, void, undefined> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => { this.resolve = r; });
    }
  }
}

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
  private readonly systemPrompt?: string;
  private readonly allowedTools?: string[];
  private readonly permissionMode: PermissionMode;
  currentPermissionMode: PermissionMode;
  private pendingModeSwitch?: PermissionMode;

  // Resume/fork
  readonly resumeSessionId?: string;
  readonly forkSession?: boolean;

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

  // Flags
  pendingPlanApproval: boolean = false;
  lobsterResumeToken?: string;
  killReason: KillReason = "unknown";
  private waitingForInputFired: boolean = false;
  private lastTurnHadQuestion: boolean = false;

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
    this.model = config.model;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools;
    this.permissionMode = config.permissionMode ?? pluginConfig.permissionMode;
    this.currentPermissionMode = this.permissionMode;
    this.originChannel = config.originChannel;
    this.originThreadId = config.originThreadId;
    this.originAgentId = config.originAgentId;
    this.originSessionKey = config.originSessionKey;
    this.resumeSessionId = config.resumeSessionId;
    this.forkSession = config.forkSession;
    this.multiTurn = config.multiTurn ?? true;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
  }

  get status(): SessionStatus { return this._status; }

  get duration(): number {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }

  get phase(): string {
    if (this._status !== "running") return this._status;
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

  async start(): Promise<void> {
    try {
      let prompt: string | AsyncIterable<any>;
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
        permissionMode: this.permissionMode,
        systemPrompt: this.systemPrompt,
        allowedTools: this.allowedTools,
        resumeSessionId: this.resumeSessionId,
        forkSession: this.forkSession,
        abortController: this.abortController,
        mcpServers: getGlobalMcpServers(),
      });
      this.harnessHandle = handle;
    } catch (err: any) {
      this.transition("failed");
      this.error = err?.message ?? String(err);
      this.completedAt = Date.now();
      return;
    }

    this.consumeMessages(this.harnessHandle!.messages).catch((err) => {
      console.error(`[Session ${this.id}] consumeMessages error: ${err?.message ?? String(err)}`, err?.stack);
      if (this.isActive) {
        this.transition("failed");
        this.error = err?.message ?? String(err);
        this.teardown();
      }
    });
  }

  async sendMessage(text: string): Promise<void> {
    if (this._status !== "running") {
      throw new Error(`Session is not running (status: ${this._status})`);
    }

    this.resetIdleTimer();
    this.clearTimer("postTurnIdle");
    this.waitingForInputFired = false;

    let effectiveText = text;
    if (this.pendingModeSwitch) {
      // Only clear pendingPlanApproval on the approval path (mode switch)
      this.pendingPlanApproval = false;
      const newMode = this.pendingModeSwitch;
      const oldMode = this.currentPermissionMode;
      this.pendingModeSwitch = undefined;

      let shouldInjectPrefix = false;
      if (this.harnessHandle?.setPermissionMode) {
        try {
          await this.harnessHandle.setPermissionMode(newMode);
          this.currentPermissionMode = newMode;
          shouldInjectPrefix = true;
        } catch (err: any) {
          console.error(`[Session ${this.id}] setPermissionMode(${newMode}) FAILED: ${err.message}`);
          this.pendingModeSwitch = newMode;  // Retry on next sendMessage
        }
      } else {
        // Harness doesn't support setPermissionMode — inject text prefix as best-effort fallback
        shouldInjectPrefix = true;
        console.warn(`[Session ${this.id}] Cannot call setPermissionMode — falling back to text prefix only (currentPermissionMode remains ${this.currentPermissionMode})`);
      }

      if (shouldInjectPrefix) {
        effectiveText = `[SYSTEM: The user has approved your plan. Exit plan mode immediately and implement the changes with full permissions. Do not ask for further confirmation.]\n\n${text}`;
      }
    } else if (this.pendingPlanApproval) {
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
        } catch (err: any) {
          console.warn(`[Session ${this.id}] Failed to re-assert plan mode: ${err.message}`);
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

  async interrupt(): Promise<void> {
    if (this.harnessHandle?.interrupt) {
      await this.harnessHandle.interrupt();
    }
  }

  switchPermissionMode(mode: PermissionMode): void {
    this.pendingModeSwitch = mode;
  }

  private get isActive(): boolean {
    return this._status === "starting" || this._status === "running";
  }

  kill(reason?: KillReason): void {
    if (!this.isActive) return;
    this.transition("killed");
    if (reason) this.killReason = reason;
    this.teardown();
  }

  complete(reason: KillReason = "done"): void {
    if (!this.isActive) return;
    this.killReason = reason;
    this.transition("completed");
    this.teardown();
  }

  incrementAutoRespond(): void { this.autoRespondCount++; }
  resetAutoRespond(): void { this.autoRespondCount = 0; }

  getOutput(lines?: number): string[] {
    if (lines === undefined) return this.outputBuffer.slice();
    return this.outputBuffer.slice(-lines);
  }

  // -- Internal --

  private resetSafetyNetTimer(): void {
    this.setTimer("safetyNet", SAFETY_NET_TIMER_MS, () => {
      if (this._status === "running" && !this.waitingForInputFired && this.lastTurnHadQuestion) {
        this.waitingForInputFired = true;
        this.emit("turnEnd", this, true);
      }
    });
  }

  private resetIdleTimer(): void {
    if (!this.multiTurn) return;
    const idleTimeoutMs = (pluginConfig.idleTimeoutMinutes ?? 30) * 60 * 1000;
    this.setTimer("idle", idleTimeoutMs, () => {
      if (this._status === "running") {
        this.kill("idle-timeout");
      }
    });
  }

  private startPostTurnIdleTimer(): void {
    if (!this.multiTurn) return;
    const postTurnIdleMs = (pluginConfig.postTurnIdleMinutes ?? 5) * 60 * 1000;
    this.setTimer("postTurnIdle", postTurnIdleMs, () => {
      if (this._status === "running") {
        this.complete("post-turn-idle");
      }
    });
  }

  private teardown(): void {
    this.clearAllTimers();
    this.completedAt = Date.now();
    if (this.messageStream) this.messageStream.end();
    this.abortController.abort();
  }

  private async consumeMessages(messages: AsyncIterable<HarnessMessage>): Promise<void> {
    for await (const msg of messages) {
      this.resetSafetyNetTimer();
      this.resetIdleTimer();

      if (msg.type === "init") {
        this.harnessSessionId = msg.session_id;
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
        this.emit("output", this, msg.text);
      } else if (msg.type === "tool_use") {
        if (this.harness.questionToolNames.includes(msg.name)) {
          this.lastTurnHadQuestion = true;
          // Defensive: CC normally uses ExitPlanMode in plan mode, but if it
          // uses AskUserQuestion instead, treat it as a plan approval signal.
          if (this.currentPermissionMode === "plan") {
            this.pendingPlanApproval = true;
          }
        } else if (this.harness.planApprovalToolNames.includes(msg.name)) {
          this.lastTurnHadQuestion = true;
          this.pendingPlanApproval = true;
        }
        this.emit("toolUse", this, msg.name, msg.input);
      } else if (msg.type === "permission_mode_change") {
        // Defensive: SDK does not currently emit this event (see docs/internal/PLAN-MODE-INVESTIGATION.md).
        // Kept for forward-compatibility if future SDK versions emit system/status permissionMode changes.
        const oldMode = this.currentPermissionMode;
        this.currentPermissionMode = msg.mode as PermissionMode;
        if (msg.mode !== "plan" && oldMode === "plan") {
          this.pendingPlanApproval = true;
          this.lastTurnHadQuestion = true;
        }
      } else if (msg.type === "result") {
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
          this.clearTimer("safetyNet");
          this.resetIdleTimer();

          // If the session is in plan mode and the turn completed, CC finished presenting
          // its plan and is waiting for approval. The SDK does NOT fire a system/status
          // permissionMode change event — it just stops streaming. So we set
          // pendingPlanApproval here based on currentPermissionMode.
          if (this.currentPermissionMode === "plan" && !this.pendingPlanApproval) {
            this.pendingPlanApproval = true;
          }

          // Use pendingPlanApproval OR lastTurnHadQuestion — pendingPlanApproval
          // is authoritative for the plan approval path (it survives text resets).
          const needsInput = this.pendingPlanApproval || this.lastTurnHadQuestion;
          if (needsInput && !this.waitingForInputFired) {
            this.waitingForInputFired = true;
            this.emit("turnEnd", this, true);
          } else if (!needsInput) {
            this.emit("turnEnd", this, false);
            this.startPostTurnIdleTimer();
          }
        } else {
          this.transition(msg.data.success ? "completed" : "failed");
          this.teardown();
        }
        this.lastTurnHadQuestion = false;
      }
    }
  }
}
