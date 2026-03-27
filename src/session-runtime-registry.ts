import type { Session } from "./session";
import type { SessionStatus } from "./types";

const ACTIVE_NAME_STATUSES = new Set<SessionStatus>(["starting", "running"]);

/**
 * Owns the in-memory runtime session map plus common active-session queries.
 */
export class SessionRuntimeRegistry {
  readonly sessions: Map<string, Session> = new Map();

  activeSessionCount(): number {
    return [...this.sessions.values()].filter((session) => ACTIVE_NAME_STATUSES.has(session.status)).length;
  }

  uniqueName(baseName: string): string {
    const activeNames = new Set(
      [...this.sessions.values()]
        .filter((session) => ACTIVE_NAME_STATUSES.has(session.status))
        .map((session) => session.name),
    );
    if (!activeNames.has(baseName)) return baseName;
    let index = 2;
    while (activeNames.has(`${baseName}-${index}`)) index += 1;
    return `${baseName}-${index}`;
  }

  add(session: Session): void {
    this.sessions.set(session.id, session);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }
}
