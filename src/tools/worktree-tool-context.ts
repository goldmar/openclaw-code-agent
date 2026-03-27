import type { PersistedSessionInfo } from "../types";
import type { Session } from "../session";
import { getBackendConversationId, getPersistedMutationRefs, getPrimarySessionLookupRef } from "../session-backend-ref";
import type { SessionManager } from "../session-manager";

export interface ResolvedWorktreeToolTarget {
  activeSession?: Session;
  persistedSession?: PersistedSessionInfo;
  persistedRef?: string;
  sessionName: string;
  worktreePath?: string;
  originalWorkdir?: string;
  branchName?: string;
  notificationTarget?: {
    id: string;
    harnessSessionId?: string;
    backendRef?: Session["backendRef"] | PersistedSessionInfo["backendRef"];
    route?: PersistedSessionInfo["route"];
  };
}

export function resolveWorktreeToolTarget(sessionManager: SessionManager, ref: string): ResolvedWorktreeToolTarget {
  const activeSession = sessionManager.resolve(ref);
  const persistedSession = sessionManager.getPersistedSession(ref);
  const persistedRef = activeSession
    ? getPrimarySessionLookupRef(activeSession)
    : (persistedSession ? getPrimarySessionLookupRef(persistedSession) : undefined);

  return {
    activeSession,
    persistedSession,
    persistedRef,
    sessionName: activeSession?.name ?? persistedSession?.name ?? ref,
    worktreePath: activeSession?.worktreePath ?? persistedSession?.worktreePath,
    originalWorkdir: activeSession?.originalWorkdir ?? persistedSession?.workdir,
    branchName: activeSession?.worktreeBranch ?? persistedSession?.worktreeBranch,
    notificationTarget: activeSession ?? (persistedSession
      ? {
          id: persistedRef ?? ref,
          harnessSessionId: persistedSession.harnessSessionId,
          backendRef: persistedSession.backendRef,
          route: persistedSession.route,
        }
      : undefined),
  };
}

export function getPersistedTargetMutationRefs(target: ResolvedWorktreeToolTarget): string[] {
  return target.persistedSession ? getPersistedMutationRefs(target.persistedSession) : [];
}

export interface WorktreeToolListingTarget {
  id: string;
  name: string;
  worktreePath: string;
  worktreeBranch?: string;
  worktreeStrategy?: string;
  workdir: string;
  worktreeMerged?: boolean;
  worktreeMergedAt?: string;
  worktreePrUrl?: string;
  backendConversationId?: string;
  harnessSessionId?: string;
}

export function listWorktreeToolTargets(sessionManager: SessionManager): WorktreeToolListingTarget[] {
  const activeSessions = sessionManager.list("all").filter((s) => s.worktreePath);
  const persistedSessions = sessionManager.listPersistedSessions().filter((p) => p.worktreePath);

  const sessionMap = new Map<string, WorktreeToolListingTarget>();

  for (const p of persistedSessions) {
    if (!p.worktreePath) continue;
    const backendConversationId = getBackendConversationId(p);
    const key = p.sessionId ?? backendConversationId ?? p.harnessSessionId;
    if (!key) continue;
    sessionMap.set(key, {
      id: p.sessionId ?? backendConversationId ?? p.harnessSessionId,
      name: p.name,
      worktreePath: p.worktreePath,
      worktreeBranch: p.worktreeBranch,
      worktreeStrategy: p.worktreeStrategy,
      workdir: p.workdir,
      worktreeMerged: p.worktreeMerged,
      worktreeMergedAt: p.worktreeMergedAt,
      worktreePrUrl: p.worktreePrUrl,
      backendConversationId,
      harnessSessionId: p.harnessSessionId,
    });
  }

  for (const s of activeSessions) {
    if (!s.worktreePath) continue;
    sessionMap.set(s.id, {
      id: s.id,
      name: s.name,
      worktreePath: s.worktreePath,
      worktreeBranch: s.worktreeBranch,
      worktreeStrategy: s.worktreeStrategy,
      workdir: s.originalWorkdir ?? s.workdir,
      worktreeMerged: undefined,
      worktreeMergedAt: undefined,
      worktreePrUrl: undefined,
      backendConversationId: getBackendConversationId(s),
      harnessSessionId: s.harnessSessionId,
    });
  }

  return Array.from(sessionMap.values());
}

export function matchesWorktreeToolRef(
  target: Pick<WorktreeToolListingTarget, "id" | "name" | "backendConversationId" | "harnessSessionId">,
  ref: string,
): boolean {
  return target.id === ref
    || target.name === ref
    || target.backendConversationId === ref
    || target.harnessSessionId === ref;
}
