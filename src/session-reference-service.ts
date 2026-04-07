import type { Session } from "./session";
import { getBackendConversationId } from "./session-backend-ref";
import type { PersistedSessionInfo, SessionStatus } from "./types";

const ACTIVE_STATUSES = new Set<SessionStatus>(["starting", "running"]);

type SessionStoreLike = Pick<
  import("./session-store").SessionStore,
  "getPersistedSession" | "resolveBackendConversationId"
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

    return this.findPreferredMatch(ref, (session) => session.name === ref)
      ?? this.findPreferredMatch(ref, (session) => getBackendConversationId(session) === ref)
      ?? this.findPreferredMatch(ref, (session) => session.harnessSessionId === ref);
  }

  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    return this.store.getPersistedSession(ref);
  }

  resolveBackendConversationId(ref: string): string | undefined {
    const active = this.resolveActive(ref);
    return this.store.resolveBackendConversationId(
      ref,
      active ? (getBackendConversationId(active) ?? active.harnessSessionId) : undefined,
    );
  }

  private findPreferredMatch(ref: string, predicate: (session: Session, ref: string) => boolean): Session | undefined {
    let preferredActive: Session | undefined;
    let preferredAny: Session | undefined;

    for (const session of this.sessions.values()) {
      if (!predicate(session, ref)) continue;
      if (!preferredAny || session.startedAt > preferredAny.startedAt) {
        preferredAny = session;
      }
      if (ACTIVE_STATUSES.has(session.status) && (!preferredActive || session.startedAt > preferredActive.startedAt)) {
        preferredActive = session;
      }
    }

    return preferredActive ?? preferredAny;
  }
}
