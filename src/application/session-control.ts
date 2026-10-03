import type { SessionManager } from "../session-manager";
import type { SessionRoute } from "../types";
import { formatSessionStatsSuffix, sessionStats } from "../session-notification-stats";

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
  const already = (status: string): string => status === "killed" ? "stopped" : status;
  const session = sm.resolve(ref);
  if (!session) {
    const persisted = sm.getPersistedSession(ref);
    if (!persisted) return `❌ Session "${ref}" not found.`;
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
        // No live process and no user notice: the row is only closed.
        return completed
          ? `ℹ️ [${persisted.name}] Marked as completed (it was not running).`
          : `⛔ [${persisted.name}] Stopped (it was not running).`;
      }
    }
    return `ℹ️ [${persisted.name}] Already ${already(persisted.status)}; nothing to stop.`;
  }

  if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
    return `ℹ️ [${session.name}] Already ${already(session.status)}; nothing to stop.`;
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
