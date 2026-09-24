import type { ForgetSessionResult, SessionManager } from "../session-manager";
import type { GoalTaskState } from "../types";

const TERMINAL_GOAL_STATUSES = new Set<GoalTaskState["status"]>(["succeeded", "failed", "stopped"]);

/** Resolve and close a session, returning user-facing result text. */
export function getKillSessionText(
  sm: SessionManager,
  ref: string,
  reason?: "completed" | "killed",
): string {
  const session = sm.resolve(ref);
  if (!session) {
    const persisted = sm.getPersistedSession(ref);
    if (!persisted) return `Error: Session "${ref}" not found.`;
    if (persisted.status === "killed" && persisted.lifecycle === "suspended") {
      const completed = reason === "completed";
      const updated = sm.updatePersistedSession(ref, {
        status: completed ? "completed" : "killed",
        lifecycle: "terminal",
        runtimeState: "stopped",
        resumable: false,
        killReason: completed ? "done" : "user",
      });
      if (updated) {
        if (completed) {
          return `Recovered session ${persisted.name} [${persisted.sessionId ?? persisted.harnessSessionId}] marked as completed. No live process was running.`;
        }
        return `Recovered session ${persisted.name} [${persisted.sessionId ?? persisted.harnessSessionId}] dismissed. No live process was running.`;
      }
    }
    return `Session ${persisted.name} [${persisted.sessionId ?? persisted.harnessSessionId}] is a persisted ${persisted.status} record with no live process to kill.`;
  }

  if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
    return `Session ${session.name} [${session.id}] is already ${session.status}. No action needed.`;
  }

  if (reason === "completed") {
    session.complete();
    return `Session ${session.name} [${session.id}] marked as completed.`;
  }

  sm.kill(session.id);
  return `Session ${session.name} [${session.id}] has been terminated.`;
}

/**
 * Remove a finished session's stored record (`agent_kill(forget=true)`).
 * Sessions a live goal loop still owns are kept: the loop resumes them
 * between iterations.
 */
export function getForgetSessionText(
  sm: SessionManager,
  ref: string,
  goals?: { listTasks(): GoalTaskState[] } | null,
): string {
  const target = sm.resolve(ref) ?? sm.getPersistedSession(ref);
  const targetId = target ? ("id" in target ? target.id : target.sessionId) : undefined;
  const owningGoal = targetId
    ? goals?.listTasks().find((task) => task.sessionId === targetId && !TERMINAL_GOAL_STATUSES.has(task.status))
    : undefined;
  if (target && owningGoal) {
    return `Session ${target.name} is owned by goal task ${owningGoal.name} (${owningGoal.status}); stop the goal first with agent_goal_stop.`;
  }

  const outcome = sm.forgetSession(ref);
  if (outcome.ok) {
    return `Session ${outcome.name}${outcome.id ? ` [${outcome.id}]` : ""} forgotten: its stored record and output were removed.`;
  }
  const result = outcome as Extract<ForgetSessionResult, { ok: false }>;
  const label = result.name ? `Session ${result.name}${result.id ? ` [${result.id}]` : ""}` : `Session "${ref}"`;
  switch (result.reason) {
    case "not_found":
      return `Error: Session "${ref}" not found.`;
    case "running":
      return `${label} is still running. Stop it with agent_kill first, then forget it.`;
    case "not_persisted":
      return `${label} has no stored record yet. Try again once it has finished.`;
    case "suspended":
      return `${label} is not finished (${result.detail ?? "suspended"}). Resume it with agent_respond, or dismiss it with agent_kill first.`;
    case "worktree":
      return `${label} still has an unsettled worktree (${result.detail ?? "unknown"}). Merge it, open a PR, dismiss it, or remove it with agent_worktree_cleanup first.`;
    case "delivery":
      return `${label} is still delivering its final notification (${result.detail ?? "in progress"}). Try again shortly.`;
  }
}
