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

/** `agent_kill(forget=true)`: remove a finished session's stored record. */
export async function getForgetSessionText(
  sm: SessionManager,
  ref: string,
  goals?: { listTasks(): GoalTaskState[] } | null,
): Promise<string> {
  const target = sm.resolve(ref) ?? sm.getPersistedSession(ref);
  const targetId = target ? ("id" in target ? target.id : target.sessionId) : undefined;
  // A live goal loop resumes its session between iterations.
  const goal = targetId
    ? goals?.listTasks().find((task) => task.sessionId === targetId && !TERMINAL_GOAL_STATUSES.has(task.status))
    : undefined;
  if (target && goal) return `Session ${target.name} is owned by goal ${goal.name} (${goal.status}); stop the goal first.`;

  const outcome = await sm.forgetSession(ref);
  const label = outcome.name ? `Session ${outcome.name}${outcome.id ? ` [${outcome.id}]` : ""}` : `Session "${ref}"`;
  if (outcome.ok) return `${label} forgotten.`;
  const { reason, detail } = outcome as Extract<ForgetSessionResult, { ok: false }>;
  if (reason === "not_found") return `Error: Session "${ref}" not found.`;
  const why = {
    running: "is still running or not yet stored; stop it first",
    suspended: `is not finished (${detail}); resume or kill it first`,
    worktree: `has unsettled worktree work (${detail}); merge, dismiss, or clean it up first`,
    delivery: `is still delivering its notification (${detail}); retry shortly`,
  }[reason];
  return `Cannot forget: ${label} ${why}.`;
}
