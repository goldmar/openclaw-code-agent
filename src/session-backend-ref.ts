import { getDefaultHarnessName } from "./config";
import { getHarness } from "./harness";
import type {
  BackendWorktreeCapability,
  PersistedSessionInfo,
  SessionBackendRef,
} from "./types";

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

export function resolveHarnessName(session: { harnessName?: string; persistedHarness?: string }): string {
  return session.harnessName ?? session.persistedHarness ?? getDefaultHarnessName();
}

export function getBackendWorktreeCapability(
  session: { harnessName?: string; persistedHarness?: string; backendRef?: SessionBackendRef },
): BackendWorktreeCapability {
  if (session.backendRef?.kind === "codex-app-server") return "native-restore";
  try {
    return getHarness(resolveHarnessName(session)).capabilities.worktrees;
  } catch {
    return "plugin-managed";
  }
}

export function supportsNativeBackendWorktreeExecution(capability: BackendWorktreeCapability): boolean {
  return capability === "native-execution" || capability === "native-restore";
}

export function supportsNativeBackendWorktreeRestore(capability: BackendWorktreeCapability): boolean {
  return capability === "native-restore";
}

export function hasNativeBackendWorktreeRef(
  session: Pick<PersistedSessionInfo, "backendRef"> | Pick<SessionIdentity, "backendRef">,
): boolean {
  return Boolean(session.backendRef?.worktreePath || session.backendRef?.worktreeId);
}

export function usesNativeBackendWorktree(
  session: { harnessName?: string; persistedHarness?: string; backendRef?: SessionBackendRef },
): boolean {
  return supportsNativeBackendWorktreeExecution(getBackendWorktreeCapability(session))
    && hasNativeBackendWorktreeRef(session);
}
