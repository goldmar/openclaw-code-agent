import { truncateText } from "./format";
import { getManagedTaskFlowRuntime } from "./runtime-store";
import type { Session } from "./session";
import type { KillReason, PersistedSessionInfo, SessionLifecycle, SessionStatus } from "./types";

const CONTROLLER_ID = "openclaw-code-agent";
const TITLE_MAX_LENGTH = 160;

// Phase 1 intentionally uses only the released managed TaskFlow runtime.
// Current OpenClaw SDKs can create/update/finalize the flow record, but they
// do not expose plugin-owned child task run create/progress/finalize methods.
// When that surface is absent, this adapter degrades to the no-op sink below.

type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";
type ManagedTaskFlowStatus = "queued" | "running" | "waiting" | "blocked" | "succeeded" | "failed" | "cancelled" | "lost";
type TaskLifecycleTerminalStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

type ManagedTaskFlowRecord = {
  flowId: string;
  revision: number;
  status?: ManagedTaskFlowStatus;
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

type BoundTaskFlowRuntime = {
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
  }) => ManagedTaskFlowRecord;
  setWaiting?: (params: {
    flowId: string;
    expectedRevision: number;
    currentStep?: string | null;
    stateJson?: Record<string, unknown> | null;
    waitJson?: Record<string, unknown> | null;
    blockedSummary?: string | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  resume?: (params: {
    flowId: string;
    expectedRevision: number;
    status?: Extract<ManagedTaskFlowStatus, "queued" | "running">;
    currentStep?: string | null;
    stateJson?: Record<string, unknown> | null;
    updatedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  finish?: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: Record<string, unknown> | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
  fail?: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: Record<string, unknown> | null;
    blockedSummary?: string | null;
    updatedAt?: number;
    endedAt?: number;
  }) => ManagedTaskFlowMutationResult;
};

type ToolContextLike = {
  sessionKey?: string;
  deliveryContext?: unknown;
};

export interface SessionTaskLifecycleSink {
  create(session: Session): void;
  progress(session: Session): void;
  finalize(session: Session): void;
}

const NOOP_SESSION_TASK_LIFECYCLE: SessionTaskLifecycleSink = {
  create() {},
  progress() {},
  finalize() {},
};

function warnLifecycleError(action: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[SessionTaskLifecycle] ${action} failed: ${message}`);
}

function warnLifecycleMutationSkipped(action: string, mutation: ManagedTaskFlowMutationResult): void {
  if (mutation.applied === false) {
    const suffix = mutation.code ? ` (${mutation.code})` : "";
    console.warn(`[SessionTaskLifecycle] ${action} mutation was not applied${suffix}`);
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

function buildStateJson(session: Session, phase: "created" | "progress" | "terminal", summary: string): Record<string, unknown> {
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

function isManagedTaskFlowRuntime(value: unknown): value is Required<Pick<BoundTaskFlowRuntime, "createManaged" | "resume" | "setWaiting" | "finish" | "fail">> {
  if (!value || typeof value !== "object") return false;
  const runtime = value as BoundTaskFlowRuntime;
  return typeof runtime.createManaged === "function"
    && typeof runtime.resume === "function"
    && typeof runtime.setWaiting === "function"
    && typeof runtime.finish === "function"
    && typeof runtime.fail === "function";
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

class ManagedTaskFlowSessionTaskLifecycleSink implements SessionTaskLifecycleSink {
  private flow?: ManagedTaskFlowRecord;
  private finalized = false;
  private lastProgressKey?: string;

  constructor(private readonly taskFlow: Required<Pick<BoundTaskFlowRuntime, "createManaged" | "resume" | "setWaiting" | "finish" | "fail">>) {}

  create(session: Session): void {
    if (this.flow || this.finalized) return;
    const summary = "Starting";
    const now = Date.now();
    try {
      this.flow = this.taskFlow.createManaged({
        controllerId: CONTROLLER_ID,
        goal: buildSessionTaskTitle(session),
        status: "running",
        notifyPolicy: "silent",
        currentStep: summary,
        stateJson: buildStateJson(session, "created", summary),
        createdAt: session.startedAt,
        updatedAt: now,
      });
      session.taskFlowMirror = this.flow;
      this.lastProgressKey = this.progressKey(session, summary);
    } catch (err) {
      warnLifecycleError("create", err);
    }
  }

  progress(session: Session): void {
    if (!this.flow || this.finalized) return;
    const summary = mapSessionLifecycleProgress(session);
    if (!summary) return;
    const key = this.progressKey(session, summary);
    if (key === this.lastProgressKey) return;
    try {
      const stateJson = buildStateJson(session, "progress", summary);
      const updatedAt = Date.now();
      const mutation = isWaitingLifecycle(session)
        ? this.taskFlow.setWaiting({
            flowId: this.flow.flowId,
            expectedRevision: this.flow.revision,
            currentStep: summary,
            stateJson,
            waitJson: { reason: summary, sessionId: session.id },
            blockedSummary: summary,
            updatedAt,
          })
        // Current released SDKs use resume as the non-waiting update path too,
        // so this intentionally carries running-state step/state changes.
        : this.taskFlow.resume({
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
    } catch (err) {
      warnLifecycleError("progress", err);
    }
  }

  finalize(session: Session): void {
    if (!this.flow || this.finalized) return;
    const status = mapSessionTaskTerminalStatus(session);
    if (!status) return;
    const summary = status === "succeeded"
      ? "Completed"
      : status === "failed"
        ? "Failed"
        : terminalSummary(session.status, session.killReason);
    try {
      const endedAt = session.completedAt ?? Date.now();
      const stateJson = {
        ...buildStateJson(session, "terminal", summary),
        terminalStatus: status,
        terminalSummary: terminalSummary(session.status, session.killReason),
        ...(session.status === "failed" && session.error ? { error: session.error } : {}),
      };
      const mutation = status === "succeeded"
        ? this.taskFlow.finish({
            flowId: this.flow.flowId,
            expectedRevision: this.flow.revision,
            stateJson,
            updatedAt: endedAt,
            endedAt,
          })
        : this.taskFlow.fail({
            flowId: this.flow.flowId,
            expectedRevision: this.flow.revision,
            stateJson,
            blockedSummary: terminalSummary(session.status, session.killReason),
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

  private progressKey(session: Pick<Session, "status" | "lifecycle">, summary: string): string {
    return `${session.status}:${session.lifecycle}:${summary}`;
  }
}

function isTerminalMirrorStatus(status: ManagedTaskFlowStatus | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost";
}

function bindTaskFlowRuntimeForSessionKey(
  sessionKey: string | undefined,
): Required<Pick<BoundTaskFlowRuntime, "setWaiting" | "finish" | "fail">> | undefined {
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

export function reconcilePersistedSessionTaskMirror(
  session: PersistedSessionInfo,
): ManagedTaskFlowRecord | undefined {
  const flow = session.taskFlowMirror ? { ...session.taskFlowMirror } : undefined;
  if (!flow || isTerminalMirrorStatus(flow.status)) return undefined;
  const taskFlow = bindTaskFlowRuntimeForSessionKey(persistedSessionKey(session));
  if (!taskFlow) return undefined;

  const now = Date.now();
  if (hasActionableWaitState(session)) {
    const summary = mapSessionLifecycleProgress({
      status: session.status,
      lifecycle: persistedWaitLifecycle(session) ?? "suspended",
    }) ?? "Waiting";
    const mutation = taskFlow.setWaiting({
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
    ? taskFlow.finish({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson,
        updatedAt: endedAt,
        endedAt,
      })
    : taskFlow.fail({
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
