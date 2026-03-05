import type { SessionManager } from "./session-manager";

export let sessionManager: SessionManager | null = null;

/** Replace the shared SessionManager reference used by tools/commands. */
export function setSessionManager(sm: SessionManager | null): void {
  sessionManager = sm;
}
