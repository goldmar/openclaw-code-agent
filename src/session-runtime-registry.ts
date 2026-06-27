import type { Session } from "./session";
import type { SessionStatus } from "./types";

const ACTIVE_NAME_STATUSES = new Set<SessionStatus>(["starting", "running"]);

function logRegistryDiagnostic(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    component: "SessionRuntimeRegistry",
    event,
    at: new Date().toISOString(),
    ...fields,
  }));
}

function sessionFields(session: Session): Record<string, unknown> {
  return {
    sessionId: session.id,
    name: session.name,
    status: session.status,
    lifecycle: session.lifecycle,
    runtimeState: session.runtimeState,
    harness: session.harnessName,
    hasHarnessSessionId: Boolean(session.harnessSessionId),
    backendRefKind: session.backendRef?.kind,
    hasBackendConversationId: Boolean(session.backendRef?.conversationId),
    hasBackendRunId: Boolean(session.backendRef?.runId),
    hasBackendWorktreeId: Boolean(session.backendRef?.worktreeId),
    hasBackendWorktreePath: Boolean(session.backendRef?.worktreePath),
  };
}

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

  add(session: Session, reason = "spawn"): void {
    logRegistryDiagnostic("runtime.add", {
      reason,
      ...sessionFields(session),
      activeCountBefore: this.activeSessionCount(),
    });
    this.sessions.set(session.id, session);
  }

  remove(id: string, reason = "unknown"): void {
    const existing = this.sessions.get(id);
    logRegistryDiagnostic("runtime.remove", {
      reason,
      sessionId: id,
      existed: Boolean(existing),
      ...(existing ? sessionFields(existing) : {}),
      activeCountBefore: this.activeSessionCount(),
    });
    this.sessions.delete(id);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }
}
