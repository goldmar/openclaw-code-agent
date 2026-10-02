import type { PersistedSessionInfo } from "./types";
import { getBackendConversationId } from "./session-backend-ref";
import type { Session } from "./session";

/** Captured store identity, never a name or a backend alias for an OCA row. */
export type SessionGeneration =
  | { kind: "oca"; sessionId: string }
  | { kind: "legacy"; storageKey: string; backendConversationId?: string; pinnedLiveSessionId?: string };

export function persistedGeneration(row: PersistedSessionInfo): SessionGeneration {
  return row.sessionId
    ? { kind: "oca", sessionId: row.sessionId }
    : { kind: "legacy", storageKey: row.harnessSessionId, backendConversationId: getBackendConversationId(row) };
}

export function matchesGeneration(row: PersistedSessionInfo, generation: SessionGeneration): boolean {
  return generation.kind === "oca"
    ? row.sessionId === generation.sessionId
    : !row.sessionId && row.harnessSessionId === generation.storageKey
      && getBackendConversationId(row) === generation.backendConversationId;
}

/** Metadata pairing shared by worktree tools and the user-decision boundary. */
export function persistedForActiveGeneration(active: Session, deps: {
  getSessionGeneration: (generation: SessionGeneration) => PersistedSessionInfo | undefined;
  listPersistedSessions: () => PersistedSessionInfo[];
  listActiveSessions: () => Session[];
}): PersistedSessionInfo | undefined {
  const exact = deps.getSessionGeneration({ kind: "oca", sessionId: active.id });
  if (exact) return exact;
  const backend = getBackendConversationId(active);
  if (!backend) return undefined;
  const rows = deps.listPersistedSessions().filter((row) => getBackendConversationId(row) === backend);
  const live = deps.listActiveSessions().filter((session) => getBackendConversationId(session) === backend);
  return rows.length === 1 && !rows[0].sessionId && live.length === 1 && live[0].id === active.id ? rows[0] : undefined;
}
