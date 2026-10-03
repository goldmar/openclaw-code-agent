import type { SessionManager } from "../session-manager";
import type { GoalTaskStatus, SessionRoute } from "../types";
import { formatSessionStatsSuffix, sessionStats } from "../session-notification-stats";

/** A session status in the user's words: a killed session is "stopped". */
export function userStatusWord(status: string): string {
  return status === "killed" ? "stopped" : status;
}

const GOAL_STATUS_WORDS: Record<GoalTaskStatus, string> = {
  awaiting_verifier_confirmation: "waiting for your confirmation",
  running: "running",
  waiting_for_session: "waiting for the session",
  waiting_for_plan_approval: "waiting for plan approval",
  waiting_for_user: "waiting for your input",
  succeeded: "succeeded",
  failed: "failed",
  stopped: "stopped",
};

/** A goal task status in the user's words; tool results keep the raw value. */
export function userGoalStatusWord(status: GoalTaskStatus): string {
  return GOAL_STATUS_WORDS[status] ?? String(status).replace(/_/gu, " ");
}

const PHASE_WORDS: Record<string, string> = {
  starting: "starting",
  active: "working",
  awaiting_plan_decision: "waiting for a plan decision",
  awaiting_user_input: "waiting for input",
  awaiting_worktree_decision: "waiting for a merge / PR decision",
  suspended: "suspended",
  terminal: "ended",
};

/** A session phase (its lifecycle) in the user's words. */
export function userPhaseWord(phase: string): string {
  return PHASE_WORDS[phase] ?? phase.replace(/_/gu, " ");
}

/** The branch of a worktree session that was neither merged, released nor discarded. */
function openWorktreeBranch(target: {
  worktreeBranch?: string;
  worktreeStrategy?: string;
  worktreeMerged?: boolean;
  worktreeLifecycle?: { state?: string };
}): string | undefined {
  if (!target.worktreeBranch || !target.worktreeStrategy || target.worktreeStrategy === "off" || target.worktreeMerged) return undefined;
  const state = target.worktreeLifecycle?.state;
  if (state === "merged" || state === "released" || state === "dismissed" || state === "no_change" || state === "pr_open") return undefined;
  return target.worktreeBranch;
}

/**
 * Resolve and close a session, returning the result text.
 * `replyIsStopNotice` (the `/agent_kill` command typed in the session's own
 * chat): the returned text is the user's one `⛔ [name] Stopped by user |
 * <footer>` line, so the lifecycle notice is not sent a second time. The
 * predicate gets the resolved session; from another chat the notice stays in
 * the session's chat and the reply is `⛔ [name] Stopped.`
 */
export function getKillSessionText(
  sm: SessionManager,
  ref: string,
  reason?: "completed" | "killed",
  options: { replyIsStopNotice?: (session: { route?: SessionRoute; originSessionKey?: string }) => boolean } = {},
): string {
  const already = userStatusWord;
  const session = sm.resolve(ref);
  const target = session ?? sm.getPersistedSession(ref);
  if (!target) return `❌ Session "${ref}" not found.`;

  // A suspended session (idle timeout, or recovered after a restart) has no
  // live process: closing it only closes the row, loaded or not, and sends no
  // user notice.
  // (Also one stopped by the idle timeout while its plan waited: see `closeSuspendedSession`.)
  if (target.status === "killed") {
    const closed = sm.closeSuspendedSession(ref, reason === "completed");
    if (closed === "completed") {
      // Only the orchestrator's tool can ask for this. No completion handling
      // runs for a session that was not running, so an open branch is named.
      const branch = openWorktreeBranch(target);
      return `ℹ️ [${target.name}] Marked as completed (it was not running).${branch
        ? ` Its branch \`${branch}\` is left as it is: no merge, PR or decision prompt follows. Land it with agent_merge or agent_pr, or discard it with agent_worktree_cleanup(session, dismiss_session=true).`
        : ""}`;
    }
    if (closed) return `⛔ [${target.name}] Stopped (it was not running).`;
  }

  if (!session || session.status === "completed" || session.status === "failed" || session.status === "killed") {
    return `ℹ️ [${target.name}] Already ${already(target.status)}; nothing to stop.`;
  }

  if (reason === "completed") {
    // A real completion: the lifecycle sends the user `✅ [name] Completed`.
    session.complete();
    return `ℹ️ [${session.name}] Marked as completed; the user gets the completion notice (✅ Completed, or the worktree prompt or outcome).`;
  }

  const replyIsStopNotice = options.replyIsStopNotice?.(session) === true;
  if (replyIsStopNotice) session.stopNoticeReplaced = true;
  sm.kill(session.id);
  return replyIsStopNotice
    ? `⛔ [${session.name}] Stopped by user${formatSessionStatsSuffix(sessionStats(session))}`
    : `⛔ [${session.name}] Stopped.`;
}
