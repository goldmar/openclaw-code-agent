import { getDefaultHarnessName } from "./config";
import type { SessionBackendRef } from "./types";

type SessionIdentity = {
  id?: string;
  sessionId?: string;
  name?: string;
  harnessSessionId?: string;
  backendRef?: SessionBackendRef;
};

export function getBackendConversationId(session: SessionIdentity): string | undefined {
  return session.backendRef?.conversationId ?? session.harnessSessionId;
}

export function getPrimarySessionLookupRef(session: SessionIdentity): string | undefined {
  return session.id ?? session.sessionId ?? session.name ?? getBackendConversationId(session) ?? session.harnessSessionId;
}

export function getCompatibilityHarnessSessionId(session: SessionIdentity): string | undefined {
  return session.harnessSessionId;
}

export function getPersistedMutationRefs(session: SessionIdentity): string[] {
  const refs = [
    getPrimarySessionLookupRef(session),
    getBackendConversationId(session),
    getCompatibilityHarnessSessionId(session),
  ].filter((ref): ref is string => Boolean(ref));

  return [...new Set(refs)];
}

export function resolveHarnessName(session: { harnessName?: string; persistedHarness?: string }): string {
  return session.harnessName ?? session.persistedHarness ?? getDefaultHarnessName();
}
