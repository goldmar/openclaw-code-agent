import { getDefaultHarnessName } from "./config";
import type { SessionBackendRef } from "./types";

type SessionIdentity = {
  id?: string;
  sessionId?: string;
  name?: string;
  harnessSessionId?: string;
  backendRef?: SessionBackendRef;
};

/**
 * The backend conversation id. A live session sets `harnessSessionId` only from
 * its backend ref, and every loadable persisted row carries a backend ref (4.x
 * Claude Code rows get one synthesized on load), so there is no separate
 * `harnessSessionId` identity to match.
 */
export function getBackendConversationId(session: SessionIdentity): string | undefined {
  return session.backendRef?.conversationId;
}

export function getPrimarySessionLookupRef(session: SessionIdentity): string | undefined {
  return session.id ?? session.sessionId ?? session.name ?? getBackendConversationId(session);
}

export function getPersistedMutationRefs(session: SessionIdentity): string[] {
  const refs = [
    getPrimarySessionLookupRef(session),
    getBackendConversationId(session),
  ].filter((ref): ref is string => Boolean(ref));

  return [...new Set(refs)];
}

export function resolveHarnessName(session: { harnessName?: string; persistedHarness?: string }): string {
  return session.harnessName ?? session.persistedHarness ?? getDefaultHarnessName();
}
