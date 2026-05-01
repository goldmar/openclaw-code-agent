import { truncateText } from "./format";
import { getPluginRuntime } from "./runtime-store";
import type { Session } from "./session";
import type { KillReason, SessionStatus } from "./types";

const TASK_KIND = "openclaw-code-agent.session";
const SOURCE_ID = "openclaw-code-agent";
const TITLE_MAX_LENGTH = 160;

type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";
type TaskLifecycleCreateStatus = "queued" | "running";
type TaskLifecycleTerminalStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

type TaskLifecycleCreateParams = {
  taskKind: string;
  runId: string;
  title: string;
  sourceId?: string;
  label?: string;
  status?: TaskLifecycleCreateStatus;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  notifyPolicy?: TaskNotifyPolicy;
};

type TaskLifecycleProgressParams = {
  taskKind: string;
  runId: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
};

type TaskLifecycleFinalizeParams = {
  taskKind: string;
  runId: string;
  status: TaskLifecycleTerminalStatus;
  endedAt: number;
  startedAt?: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
};

type TaskLifecycleRuntime = {
  create?: (params: TaskLifecycleCreateParams) => unknown;
  progress?: (params: TaskLifecycleProgressParams) => unknown;
  finalize?: (params: TaskLifecycleFinalizeParams) => unknown;
};

type TaskRunsRuntime = {
  lifecycle?: TaskLifecycleRuntime;
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

class RuntimeSessionTaskLifecycleSink implements SessionTaskLifecycleSink {
  private created = false;
  private finalized = false;
  private lastProgressKey?: string;

  constructor(private readonly lifecycle: Required<TaskLifecycleRuntime>) {}

  create(session: Session): void {
    if (this.created || this.finalized) return;
    try {
      this.lifecycle.create({
        taskKind: TASK_KIND,
        sourceId: SOURCE_ID,
        runId: session.id,
        title: buildSessionTaskTitle(session),
        label: session.name,
        status: "running",
        startedAt: session.startedAt,
        lastEventAt: Date.now(),
        progressSummary: "Starting",
        notifyPolicy: "silent",
      });
      this.created = true;
      this.lastProgressKey = this.progressKey(session, "Starting");
    } catch (err) {
      warnLifecycleError("create", err);
    }
  }

  progress(session: Session): void {
    if (!this.created || this.finalized) return;
    const progressSummary = mapSessionLifecycleProgress(session);
    if (!progressSummary) return;
    const key = this.progressKey(session, progressSummary);
    if (key === this.lastProgressKey) return;
    try {
      this.lifecycle.progress({
        taskKind: TASK_KIND,
        runId: session.id,
        lastEventAt: Date.now(),
        progressSummary,
        eventSummary: progressSummary,
      });
      this.lastProgressKey = key;
    } catch (err) {
      warnLifecycleError("progress", err);
    }
  }

  finalize(session: Session): void {
    if (!this.created || this.finalized) return;
    const status = mapSessionTaskTerminalStatus(session);
    if (!status) return;
    try {
      const progressSummary = status === "succeeded"
        ? "Completed"
        : status === "failed"
          ? "Failed"
          : terminalSummary(session.status, session.killReason);
      this.lifecycle.finalize({
        taskKind: TASK_KIND,
        runId: session.id,
        status,
        startedAt: session.startedAt,
        endedAt: session.completedAt ?? Date.now(),
        lastEventAt: session.completedAt ?? Date.now(),
        progressSummary,
        terminalSummary: terminalSummary(session.status, session.killReason),
        ...(session.status === "failed" && session.error ? { error: session.error } : {}),
      });
      this.finalized = true;
    } catch (err) {
      warnLifecycleError("finalize", err);
    }
  }

  private progressKey(session: Pick<Session, "status" | "lifecycle">, summary: string): string {
    return `${session.status}:${session.lifecycle}:${summary}`;
  }
}

function isTaskLifecycleRuntime(value: TaskLifecycleRuntime | undefined): value is Required<TaskLifecycleRuntime> {
  return typeof value?.create === "function"
    && typeof value.progress === "function"
    && typeof value.finalize === "function";
}

export function resolveSessionTaskLifecycle(ctx: ToolContextLike): SessionTaskLifecycleSink {
  if (!ctx.sessionKey?.trim()) return NOOP_SESSION_TASK_LIFECYCLE;
  try {
    const fromToolContext = getPluginRuntime()?.tasks?.runs?.fromToolContext;
    if (typeof fromToolContext !== "function") return NOOP_SESSION_TASK_LIFECYCLE;
    const runs = fromToolContext(ctx) as TaskRunsRuntime | undefined;
    if (!isTaskLifecycleRuntime(runs?.lifecycle)) return NOOP_SESSION_TASK_LIFECYCLE;
    return new RuntimeSessionTaskLifecycleSink(runs.lifecycle);
  } catch (err) {
    warnLifecycleError("resolve", err);
    return NOOP_SESSION_TASK_LIFECYCLE;
  }
}
