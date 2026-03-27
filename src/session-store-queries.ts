import { getBackendConversationId } from "./session-backend-ref";
import type { PersistedSessionInfo } from "./types";

type SessionStoreIndexes = {
  persisted: Map<string, PersistedSessionInfo>;
  idIndex: Map<string, string>;
  nameIndex: Map<string, string>;
  backendIdIndex: Map<string, string>;
};

/**
 * Read/query layer for persisted sessions.
 * Keeps lookup semantics out of SessionStore's storage/mutation code.
 */
export class SessionStoreQueries {
  constructor(private readonly indexes: SessionStoreIndexes) {}

  hasRecordedSession(sessionId: string): boolean {
    return this.indexes.idIndex.has(sessionId);
  }

  getLatestPersistedByName(name: string): PersistedSessionInfo | undefined {
    let winner: PersistedSessionInfo | undefined;
    let winnerCreatedAt = Number.NEGATIVE_INFINITY;
    let winnerCompletedAt = Number.NEGATIVE_INFINITY;
    let winnerOrder = Number.NEGATIVE_INFINITY;
    let order = 0;

    for (const info of this.indexes.persisted.values()) {
      if (info.name !== name) {
        order++;
        continue;
      }

      const createdAt = info.createdAt ?? Number.NEGATIVE_INFINITY;
      const completedAt = info.completedAt ?? Number.NEGATIVE_INFINITY;
      const isBetter = createdAt > winnerCreatedAt
        || (createdAt === winnerCreatedAt && completedAt > winnerCompletedAt)
        || (createdAt === winnerCreatedAt && completedAt === winnerCompletedAt && order > winnerOrder);

      if (isBetter) {
        winner = info;
        winnerCreatedAt = createdAt;
        winnerCompletedAt = completedAt;
        winnerOrder = order;
      }

      order++;
    }

    return winner;
  }

  resolveBackendConversationId(ref: string, activeBackendConversationId?: string): string | undefined {
    if (activeBackendConversationId) return activeBackendConversationId;

    const byId = this.indexes.idIndex.get(ref);
    if (byId) {
      const entry = this.indexes.persisted.get(byId);
      const backendConversationId = entry ? getBackendConversationId(entry) : undefined;
      return backendConversationId ?? byId;
    }

    const byName = this.getLatestPersistedByName(ref);
    if (byName) return getBackendConversationId(byName) ?? byName.harnessSessionId;

    const byBackendId = this.indexes.backendIdIndex.get(ref);
    if (byBackendId) {
      const entry = this.indexes.persisted.get(byBackendId);
      const backendConversationId = entry ? getBackendConversationId(entry) : undefined;
      return backendConversationId ?? byBackendId;
    }

    if (this.indexes.persisted.has(ref)) {
      const entry = this.indexes.persisted.get(ref);
      return entry ? (getBackendConversationId(entry) ?? ref) : ref;
    }

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
    return undefined;
  }

  resolveHarnessSessionId(ref: string, activeHarnessSessionId?: string): string | undefined {
    return this.resolveBackendConversationId(ref, activeHarnessSessionId);
  }

  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    const byId = this.indexes.idIndex.get(ref);
    if (byId) return this.indexes.persisted.get(byId);
    const byName = this.getLatestPersistedByName(ref);
    if (byName) return byName;
    const byBackendId = this.indexes.backendIdIndex.get(ref);
    if (byBackendId) return this.indexes.persisted.get(byBackendId);
    return this.indexes.persisted.get(ref);
  }

  listPersistedSessions(): PersistedSessionInfo[] {
    return [...this.indexes.persisted.values()].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }
}
