import type { SessionManager } from "../session-manager";

/** Resolve and close a session, returning user-facing result text. */
export function getKillSessionText(
  sm: SessionManager,
  ref: string,
  reason?: "completed" | "killed",
): string {
  const session = sm.resolve(ref);
  if (!session) return `Error: Session "${ref}" not found.`;

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
