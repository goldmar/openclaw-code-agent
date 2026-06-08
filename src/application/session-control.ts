import type { SessionManager } from "../session-manager";

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
      const updated = sm.updatePersistedSession(ref, {
        lifecycle: "terminal",
        runtimeState: "stopped",
        resumable: false,
        killReason: "user",
      });
      if (updated) {
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
