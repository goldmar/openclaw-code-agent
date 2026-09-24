import { truncateText } from "./format";
import { getManagedTaskFlowRuntime } from "./runtime-store";
import { KeyedOperationQueue } from "./keyed-operation-queue";
import type { Session } from "./session";
import type { KillReason, PersistedSessionInfo, SessionLifecycle, SessionStatus } from "./types";
import { createLogger } from "./logger";

const log = createLogger("session-task-lifecycle");

const CONTROLLER_ID = "openclaw-code-agent";
const TITLE_MAX_LENGTH = 160;
/** How often a live mirror re-reads its flow to honor `openclaw tasks flow cancel`. */
export const TASK_FLOW_CANCEL_POLL_INTERVAL_MS = 15_000;
const USER_CANCEL_MAX_ATTEMPTS = 3;

// Mirroring remains optional when the host has no async managed-flow surface.

type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";
type ManagedTaskFlowStatus = "queued" | "running" | "waiting" | "blocked" | "succeeded" | "failed" | "cancelled" | "lost";
type TaskLifecycleTerminalStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

type ManagedTaskFlowRecord = {
  flowId: string;
  revision: number;
  status?: ManagedTaskFlowStatus;
  cancelRequestedAt?: number | null;
  [key: string]: unknown;
};

type ManagedTaskFlowMutationResult = {
  applied: true;
  flow: ManagedTaskFlowRecord;
  current?: never;
} | {
  applied: false;
  code?: string;
  current?: ManagedTaskFlowRecord;
};

type ManagedTaskFlowCreateParams = {
  controllerId: string;
  goal: string;
  status?: ManagedTaskFlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  currentStep?: string | null;
  stateJson?: Record<string, unknown> | null;
  waitJson?: Record<string, unknown> | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
};

// Structural subset of the host's `BoundAsyncManagedTaskFlowsRuntime`
// (`api.runtime.tasks.async.managedFlows.fromToolContext(...)`); partial hosts and
// tests may omit methods, so every call is guarded.
// `getTaskSummary` is intentionally unused: OCA flows never start child tasks
// (`runTask`), so the host's task summary for them is always empty.
type BoundTaskFlowRuntime = {
  tryCreateManaged?: (params: ManagedTaskFlowCreateParams) => Promise<ManagedTaskFlowRecord | null>;
  get?: (flowId: string) => Promise<ManagedTaskFlowRecord | undefined>;
  requestCancel?: (params: {
    flowId: string;
    expectedRevision: number;
    cancelRequestedAt?: number;
  }) => Promise<ManagedTaskFlowMutationResult>;
  createManaged?: (params: {
    controllerId: string;
    goal: string;
    status?: ManagedTaskFlowStatus;
    notifyPolicy?: TaskNotifyPolicy;
    currentStep?: string | null;
    stateJson?: Record<string, unknown> | null;
    waitJson?: Record<string, unknown> | null;
    createdAt?: number;
    updatedAt?: number;
    endedAt?: number | null;
  }) => Promise<ManagedTaskFlowRecord>;
  setWaiting?: (params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: Record<string, unknown> | null;
    waitJson?: Record<string, unknown> | null;
    blockedSummary?: string | null;
    updatedAt?: number;
  }) => Promise<ManagedTaskFlowMutationResult>;
  resume?: (params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<ManagedTaskFlowStatus, "queued" | "running">;
    currentStep?: string | null;
    stateJson?: Record<string, unknown> | null;
    updatedAt?: number;
  }) => Promise<ManagedTaskFlowMutationResult>;
  finish?: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: Record<string, unknown> | null;
    updatedAt?: number;
    endedAt?: number;
  }) => Promise<ManagedTaskFlowMutationResult>;
  fail?: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: Record<string, unknown> | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
  }) => Promise<ManagedTaskFlowMutationResult>;
};

type ToolContextLike = {
  sessionKey?: string;
  deliveryContext?: unknown;
};

export interface SessionTaskLifecycleHooks {
  /** The host flow was cancelled (for example `openclaw tasks flow cancel`); stop the session. */
  onCancelRequested?: () => void;
}

export interface SessionTaskLifecycleSink {
  create(session: Session, hooks?: SessionTaskLifecycleHooks): void | Promise<void>;
  progress(session: Session): void | Promise<void>;
  finalize(session: Session): void | Promise<void>;
}

type SessionTaskEvent = Pick<Session,
  "id" | "name" | "prompt" | "status" | "lifecycle" | "startedAt" | "completedAt" | "killReason" | "error"
> & { occurredAt: number };

function captureSessionTaskEvent(session: Session): SessionTaskEvent {
  return {
    id: session.id,
    name: session.name,
    prompt: session.prompt,
    status: session.status,
    lifecycle: session.lifecycle,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    killReason: session.killReason,
    error: session.error,
    occurredAt: Date.now(),
  };
}

const NOOP_SESSION_TASK_LIFECYCLE: SessionTaskLifecycleSink = {
  create() {},
  progress() {},
  finalize() {},
};

function warnLifecycleError(action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.warn(`[SessionTaskLifecycle] ${action} failed: ${message}`);
}

function warnLifecycleMutationSkipped(action: string, mutation: ManagedTaskFlowMutationResult): void {
  if (mutation.applied === false) {
    const suffix = mutation.code ? ` (${mutation.code})` : "";
    log.warn(`[SessionTaskLifecycle] ${action} mutation was not applied${suffix}`);
  }
}

export function buildSessionTaskTitle(session: Pick<Session, "prompt" | "name">): string {
  const collapsed = session.prompt.trim().replace(/\s+/g, " ");
  return truncateText(collapsed || session.name, TITLE_MAX_LENGTH);
}

export function mapSessionLifecycleProgress(
  session: Pick<Session, "status" | "lifecycle">,
): string | undefined {
  if (session.status === "starting" || session.lifecycle === "starting") return "Starting";
  if (session.lifecycle === "active") return "Running";
  if (session.lifecycle === "awaiting_plan_decision") return "Waiting for plan approval";
  if (session.lifecycle === "awaiting_user_input") return "Waiting for input";
  if (session.lifecycle === "awaiting_worktree_decision") return "Waiting for worktree decision";
  if (session.lifecycle === "suspended") return "Suspended after idle timeout";
  return undefined;
}

export function mapSessionTaskTerminalStatus(
  session: Pick<Session, "status" | "killReason">,
): TaskLifecycleTerminalStatus | undefined {
  if (session.status === "completed") return "succeeded";
  if (session.status === "failed") return "failed";
  if (session.status !== "killed") return undefined;
  return session.killReason === "idle-timeout" || session.killReason === "startup-timeout"
    ? "timed_out"
    : "cancelled";
}

function terminalSummary(status: SessionStatus, killReason: KillReason): string {
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (killReason === "idle-timeout") return "Timed out after idle timeout";
  if (killReason === "startup-timeout") return "Timed out during startup";
  if (killReason === "shutdown") return "Cancelled during shutdown";
  if (killReason === "user") return "Cancelled by user";
  return "Cancelled";
}

function isWaitingLifecycle(session: Pick<Session, "lifecycle">): boolean {
  return isActionableWaitLifecycle(session.lifecycle);
}

function isActionableWaitLifecycle(lifecycle: SessionLifecycle | undefined): boolean {
  return lifecycle === "awaiting_plan_decision"
    || lifecycle === "awaiting_user_input"
    || lifecycle === "awaiting_worktree_decision"
    || lifecycle === "suspended";
}

function hasActionableWaitState(
  session: Pick<PersistedSessionInfo, "lifecycle" | "pendingPlanApproval" | "pendingWorktreeDecisionSince" | "resumable" | "runtimeRecovery">,
): boolean {
  if (session.pendingPlanApproval) return true;
  if (session.pendingWorktreeDecisionSince) return true;
  if (session.runtimeRecovery?.reason === "persisted-running-without-runtime") {
    const rawLifecycle = session.runtimeRecovery.rawLifecycle as SessionLifecycle | undefined;
    if (rawLifecycle === "suspended") return session.runtimeRecovery.rawResumable === true || session.resumable === true;
    return isActionableWaitLifecycle(rawLifecycle);
  }
  if (session.lifecycle === "suspended") return session.resumable === true;
  return isActionableWaitLifecycle(session.lifecycle);
}

function persistedWaitLifecycle(session: PersistedSessionInfo): SessionLifecycle | undefined {
  if (session.runtimeRecovery?.reason === "persisted-running-without-runtime") {
    const rawLifecycle = session.runtimeRecovery.rawLifecycle as SessionLifecycle | undefined;
    if (isActionableWaitLifecycle(rawLifecycle)) return rawLifecycle;
  }
  return session.lifecycle;
}

function buildStateJson(session: SessionTaskEvent, phase: "created" | "progress" | "terminal", summary: string): Record<string, unknown> {
  return {
    phase,
    integration: "phase-1-managed-task-flow",
    sessionId: session.id,
    sessionName: session.name,
    sessionStatus: session.status,
    sessionLifecycle: session.lifecycle,
    summary,
  };
}

// `requestCancel` ships with every host that has the async managed-flow binding;
// requiring it keeps user stops recorded as cancellations, never as failures.
type MirrorTaskFlowRuntime = Required<Pick<BoundTaskFlowRuntime, "createManaged" | "resume" | "setWaiting" | "finish" | "fail" | "requestCancel">>
  & Pick<BoundTaskFlowRuntime, "tryCreateManaged" | "get">;

function isManagedTaskFlowRuntime(value: unknown): value is MirrorTaskFlowRuntime {
  if (!value || typeof value !== "object") return false;
  const runtime = value as BoundTaskFlowRuntime;
  return typeof runtime.createManaged === "function"
    && typeof runtime.resume === "function"
    && typeof runtime.setWaiting === "function"
    && typeof runtime.finish === "function"
    && typeof runtime.fail === "function"
    && typeof runtime.requestCancel === "function";
}

function applyMutation(
  current: ManagedTaskFlowRecord | undefined,
  mutation: ManagedTaskFlowMutationResult,
): ManagedTaskFlowRecord | undefined {
  if (mutation.applied) return mutation.flow;
  const currentFlow = mutation.current;
  if (currentFlow?.flowId && typeof currentFlow.revision === "number") return currentFlow;
  return current;
}

/** The host recorded a cancel intent (or already cancelled the flow). */
export function isTaskFlowCancelRequested(flow: Pick<ManagedTaskFlowRecord, "status" | "cancelRequestedAt"> | undefined): boolean {
  return Boolean(flow && (flow.cancelRequestedAt != null || flow.status === "cancelled"));
}

class ManagedTaskFlowSessionTaskLifecycleSink implements SessionTaskLifecycleSink {
  private readonly operations = new KeyedOperationQueue();
  private flow?: ManagedTaskFlowRecord;
  private finalized = false;
  private cancelRequested = false;
  private lastProgressKey?: string;
  private hooks: SessionTaskLifecycleHooks = {};
  private cancelPoll?: ReturnType<typeof setInterval>;

  constructor(private readonly taskFlow: MirrorTaskFlowRuntime) {}

  create(session: Session, hooks: SessionTaskLifecycleHooks = {}): Promise<void> {
    this.hooks = hooks;
    const event = captureSessionTaskEvent(session);
    return this.operations.enqueue(session.id, () => this.createEvent(session, event));
  }

  private async createEvent(session: Session, event: SessionTaskEvent): Promise<void> {
    if (this.flow || this.finalized) return;
    const summary = "Starting";
    const now = event.occurredAt;
    const params: ManagedTaskFlowCreateParams = {
      controllerId: CONTROLLER_ID,
      goal: buildSessionTaskTitle(event),
      status: "running",
      notifyPolicy: "silent",
      currentStep: summary,
      stateJson: buildStateJson(event, "created", summary),
      createdAt: event.startedAt,
      updatedAt: now,
    };
    try {
      // `tryCreateManaged` reports a persistence failure as `null` instead of throwing.
      const created = typeof this.taskFlow.tryCreateManaged === "function"
        ? await this.taskFlow.tryCreateManaged(params)
        : await this.taskFlow.createManaged(params);
      if (!created) {
        log.warn("[SessionTaskLifecycle] create skipped: TaskFlow persistence is unavailable");
        return;
      }
      this.flow = created;
      session.taskFlowMirror = this.flow;
      this.lastProgressKey = this.progressKey(event, summary);
      this.startCancelPoll(session);
    } catch (err) {
      warnLifecycleError("create", err);
    }
  }

  progress(session: Session): Promise<void> {
    const event = captureSessionTaskEvent(session);
    return this.operations.enqueue(session.id, () => this.progressEvent(session, event));
  }

  private async progressEvent(session: Session, event: SessionTaskEvent): Promise<void> {
    if (!this.flow || this.finalized || this.cancelRequested) return;
    const summary = mapSessionLifecycleProgress(event);
    if (!summary) return;
    const key = this.progressKey(event, summary);
    if (key === this.lastProgressKey) return;
    try {
      const stateJson = buildStateJson(event, "progress", summary);
      const updatedAt = event.occurredAt;
      const mutation = isWaitingLifecycle(event)
        ? await this.taskFlow.setWaiting({
            flowId: this.flow.flowId,
            expectedRevision: this.flow.revision,
            currentStep: summary,
            stateJson,
            waitJson: { reason: summary, sessionId: session.id },
            blockedSummary: summary,
            updatedAt,
          })
        // Resume also carries non-waiting step/state changes.
        : await this.taskFlow.resume({
            flowId: this.flow.flowId,
            expectedRevision: this.flow.revision,
            status: "running",
            currentStep: summary,
            stateJson,
            updatedAt,
          });
      this.flow = applyMutation(this.flow, mutation);
      if (this.flow) session.taskFlowMirror = this.flow;
      this.lastProgressKey = key;
      this.observeCancel(session);
    } catch (err) {
      warnLifecycleError("progress", err);
    }
  }

  finalize(session: Session): Promise<void> {
    this.stopCancelPoll();
    const event = captureSessionTaskEvent(session);
    return this.operations.enqueue(session.id, () => this.finalizeEvent(session, event));
  }

  private async finalizeEvent(session: Session, event: SessionTaskEvent): Promise<void> {
    if (!this.flow || this.finalized) return;
    const status = mapSessionTaskTerminalStatus(event);
    if (!status) return;
    if (this.cancelRequested) {
      // The host owns a cancelled flow: its maintenance sweep records `cancelled`.
      this.finalized = true;
      return;
    }
    const summary = status === "succeeded"
      ? "Completed"
      : status === "failed"
        ? "Failed"
        : terminalSummary(event.status, event.killReason);
    try {
      const endedAt = event.completedAt ?? event.occurredAt;
      if (event.status === "killed" && event.killReason === "user") {
        // A user stop is a cancellation, not a failure: record the cancel intent and
        // let the host sweep settle the flow as `cancelled`.
        this.finalized = await this.recordUserCancel(session, endedAt);
        return;
      }
      const stateJson = {
        ...buildStateJson(event, "terminal", summary),
        terminalStatus: status,
        terminalSummary: terminalSummary(event.status, event.killReason),
        ...(event.status === "failed" && event.error ? { error: event.error } : {}),
      };
      const mutation = status === "succeeded"
        ? await this.taskFlow.finish({
            flowId: this.flow.flowId,
            expectedRevision: this.flow.revision,
            stateJson,
            updatedAt: endedAt,
            endedAt,
          })
        : await this.taskFlow.fail({
            flowId: this.flow.flowId,
            expectedRevision: this.flow.revision,
            stateJson,
            blockedSummary: terminalSummary(event.status, event.killReason),
            updatedAt: endedAt,
            endedAt,
          });
      warnLifecycleMutationSkipped("finalize", mutation);
      this.flow = applyMutation(this.flow, mutation);
      if (this.flow) session.taskFlowMirror = this.flow;
      this.finalized = true;
    } catch (err) {
      warnLifecycleError("finalize", err);
    }
  }

  /**
   * Record the cancel intent, retrying against the host's current revision when a
   * concurrent host update rejected the first attempt. Returns true once the flow
   * carries a cancel intent or is already terminal; otherwise the mirror stays
   * unfinalized so a later finalize can retry.
   */
  private async recordUserCancel(session: Session, cancelRequestedAt: number): Promise<boolean> {
    for (let attempt = 0; attempt < USER_CANCEL_MAX_ATTEMPTS && this.flow; attempt += 1) {
      const mutation = await this.taskFlow.requestCancel({
        flowId: this.flow.flowId,
        expectedRevision: this.flow.revision,
        cancelRequestedAt,
      });
      this.flow = applyMutation(this.flow, mutation);
      if (this.flow) session.taskFlowMirror = this.flow;
      if (mutation.applied || isTaskFlowCancelRequested(this.flow) || isTerminalMirrorStatus(this.flow?.status)) {
        return true;
      }
      // Only a revision conflict with a newer current record is worth retrying.
      if (mutation.applied === true) return true;
      if (mutation.code !== "revision_conflict" || !mutation.current) {
        warnLifecycleMutationSkipped("finalize-cancel", mutation);
        return false;
      }
    }
    log.warn("[SessionTaskLifecycle] finalize-cancel mutation was not applied after retries");
    return false;
  }

  private startCancelPoll(session: Session): void {
    if (typeof this.taskFlow.get !== "function" || this.cancelPoll) return;
    this.cancelPoll = setInterval(() => {
      void this.operations.enqueue(session.id, () => this.pollCancel(session));
    }, TASK_FLOW_CANCEL_POLL_INTERVAL_MS);
    this.cancelPoll.unref?.();
  }

  private stopCancelPoll(): void {
    if (!this.cancelPoll) return;
    clearInterval(this.cancelPoll);
    this.cancelPoll = undefined;
  }

  private async pollCancel(session: Session): Promise<void> {
    if (!this.flow || this.finalized || this.cancelRequested || typeof this.taskFlow.get !== "function") return;
    try {
      const current = await this.taskFlow.get(this.flow.flowId);
      if (!isTaskFlowCancelRequested(current)) return;
      this.flow = current;
      session.taskFlowMirror = current;
      this.observeCancel(session);
    } catch (err) {
      warnLifecycleError("cancel-poll", err);
    }
  }

  private observeCancel(session: Session): void {
    if (this.cancelRequested || this.finalized || !isTaskFlowCancelRequested(this.flow)) return;
    this.cancelRequested = true;
    this.stopCancelPoll();
    log.warn(`[SessionTaskLifecycle] TaskFlow ${this.flow?.flowId} was cancelled by the host; stopping session ${session.id}`);
    try {
      this.hooks.onCancelRequested?.();
    } catch (err) {
      warnLifecycleError("cancel", err);
    }
  }

  private progressKey(session: Pick<Session, "status" | "lifecycle">, summary: string): string {
    return `${session.status}:${session.lifecycle}:${summary}`;
  }
}

function isTerminalMirrorStatus(status: ManagedTaskFlowStatus | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost";
}

function bindTaskFlowRuntimeForSessionKey(
  sessionKey: string | undefined,
): (Required<Pick<BoundTaskFlowRuntime, "setWaiting" | "finish" | "fail">> & Pick<BoundTaskFlowRuntime, "requestCancel">) | undefined {
  if (!sessionKey?.trim()) return undefined;
  const fromToolContext = getManagedTaskFlowRuntime()?.fromToolContext;
  if (typeof fromToolContext !== "function") return undefined;
  const value = fromToolContext({ sessionKey });
  if (!value || typeof value !== "object") return undefined;
  const runtime = value as BoundTaskFlowRuntime;
  if (
    typeof runtime.setWaiting !== "function"
    || typeof runtime.finish !== "function"
    || typeof runtime.fail !== "function"
  ) {
    return undefined;
  }
  return {
    setWaiting: runtime.setWaiting,
    finish: runtime.finish,
    fail: runtime.fail,
    ...(typeof runtime.requestCancel === "function" ? { requestCancel: runtime.requestCancel } : {}),
  };
}

function persistedSessionKey(session: Pick<PersistedSessionInfo, "originSessionKey" | "route">): string | undefined {
  return session.originSessionKey ?? session.route?.sessionKey;
}

function persistedTerminalSummary(session: Pick<PersistedSessionInfo, "status" | "killReason" | "runtimeRecovery">): string {
  if (session.runtimeRecovery?.reason === "persisted-running-without-runtime") {
    return "Lost after OpenClaw Code Agent restart without live process";
  }
  return terminalSummary(session.status, session.killReason ?? "unknown");
}

export async function reconcilePersistedSessionTaskMirror(
  session: PersistedSessionInfo,
): Promise<ManagedTaskFlowRecord | undefined> {
  const flow = session.taskFlowMirror ? { ...session.taskFlowMirror } : undefined;
  // A cancel intent belongs to the host; its maintenance sweep settles the flow.
  if (!flow || isTerminalMirrorStatus(flow.status) || isTaskFlowCancelRequested(flow)) return undefined;
  const taskFlow = bindTaskFlowRuntimeForSessionKey(persistedSessionKey(session));
  if (!taskFlow) return undefined;

  const now = Date.now();
  if (hasActionableWaitState(session)) {
    const summary = mapSessionLifecycleProgress({
      status: session.status,
      lifecycle: persistedWaitLifecycle(session) ?? "suspended",
    }) ?? "Waiting";
    const mutation = await taskFlow.setWaiting({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: summary,
      stateJson: {
        phase: "progress",
        integration: "phase-1-managed-task-flow",
        sessionId: session.sessionId,
        sessionName: session.name,
        sessionStatus: session.status,
        sessionLifecycle: session.lifecycle,
        summary,
        reconciled: true,
      },
      waitJson: { reason: summary, sessionId: session.sessionId },
      blockedSummary: summary,
      updatedAt: now,
    });
    warnLifecycleMutationSkipped("reconcile-waiting", mutation);
    return applyMutation(flow, mutation);
  }

  const endedAtForCancel = session.completedAt ?? now;
  if (
    session.status === "killed"
    && session.killReason === "user"
    && session.runtimeRecovery?.reason !== "persisted-running-without-runtime"
    && typeof taskFlow.requestCancel === "function"
  ) {
    // A user stop whose live cancel intent was not recorded is still a cancellation.
    const mutation = await taskFlow.requestCancel({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      cancelRequestedAt: endedAtForCancel,
    });
    warnLifecycleMutationSkipped("reconcile-cancel", mutation);
    return applyMutation(flow, mutation);
  }

  const terminalStatus = mapSessionTaskTerminalStatus({
    status: session.status,
    killReason: session.killReason ?? "unknown",
  }) ?? "failed";
  const summary = persistedTerminalSummary(session);
  const endedAt = session.completedAt ?? now;
  const stateJson = {
    phase: "terminal",
    integration: "phase-1-managed-task-flow",
    sessionId: session.sessionId,
    sessionName: session.name,
    sessionStatus: session.status,
    sessionLifecycle: session.lifecycle,
    summary,
    terminalStatus: session.runtimeRecovery?.reason === "persisted-running-without-runtime"
      ? "lost"
      : terminalStatus,
    terminalSummary: summary,
    reconciled: true,
    runtimeRecovery: session.runtimeRecovery,
  };
  const mutation = terminalStatus === "succeeded"
    ? await taskFlow.finish({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson,
        updatedAt: endedAt,
        endedAt,
      })
    : await taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson,
        blockedSummary: summary,
        updatedAt: endedAt,
        endedAt,
      });
  warnLifecycleMutationSkipped("reconcile-terminal", mutation);
  return applyMutation(flow, mutation);
}

export function resolveSessionTaskLifecycle(ctx: ToolContextLike): SessionTaskLifecycleSink {
  if (!ctx.sessionKey?.trim()) return NOOP_SESSION_TASK_LIFECYCLE;
  try {
    const fromToolContext = getManagedTaskFlowRuntime()?.fromToolContext;
    if (typeof fromToolContext !== "function") return NOOP_SESSION_TASK_LIFECYCLE;
    const taskFlow = fromToolContext(ctx);
    if (!isManagedTaskFlowRuntime(taskFlow)) return NOOP_SESSION_TASK_LIFECYCLE;
    return new ManagedTaskFlowSessionTaskLifecycleSink(taskFlow);
  } catch (err) {
    warnLifecycleError("resolve", err);
    return NOOP_SESSION_TASK_LIFECYCLE;
  }
}
