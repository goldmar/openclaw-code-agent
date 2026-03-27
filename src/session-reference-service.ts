import type { Session } from "./session";
import { getBackendConversationId } from "./session-backend-ref";
import type { PersistedSessionInfo, SessionStatus } from "./types";

const ACTIVE_STATUSES = new Set<SessionStatus>(["starting", "running"]);

type SessionStoreLike = Pick<
  import("./session-store").SessionStore,
  "getPersistedSession" | "resolveHarnessSessionId"
>;

/**
 * Centralizes active/persisted/backend-ref resolution so lookup policy stays
 * consistent across launch, restore, tool targeting, and wake flows.
 */
export class SessionReferenceService {
  constructor(
    private readonly sessions: Map<string, Session>,
    private readonly store: SessionStoreLike,
  ) {}

  resolveActive(ref: string): Session | undefined {
    const byId = this.sessions.get(ref);
    if (byId) return byId;

    const sessions = [...this.sessions.values()];
    const byName = sessions.filter((session) => session.name === ref);
    if (byName.length > 0) return this.pickPreferredSession(byName);

    const byBackendConversation = sessions.filter((session) => getBackendConversationId(session) === ref);
    if (byBackendConversation.length > 0) return this.pickPreferredSession(byBackendConversation);

    const byLegacyHarnessId = sessions.filter((session) => session.harnessSessionId === ref);
    if (byLegacyHarnessId.length > 0) return this.pickPreferredSession(byLegacyHarnessId);

    return undefined;
  }

  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.store.getPersistedSession(ref);
  }

  resolveBackendConversationId(ref: string): string | undefined {
    const active = this.resolveActive(ref);
    return this.store.resolveHarnessSessionId(
      ref,
      active ? (getBackendConversationId(active) ?? active.harnessSessionId) : undefined,
    );
  }

  private pickPreferredSession(matches: Session[]): Session | undefined {
    const activeMatches = matches.filter((session) => ACTIVE_STATUSES.has(session.status));
    const candidates = activeMatches.length > 0 ? activeMatches : matches;
    return candidates.sort((a, b) => b.startedAt - a.startedAt)[0];
  }
}
