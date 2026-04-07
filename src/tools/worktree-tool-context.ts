import type { PersistedSessionInfo } from "../types";
import type { ResolvedWorktreeLifecycle } from "../types";
import type { Session } from "../session";
import { getBackendConversationId, getPersistedMutationRefs, getPrimarySessionLookupRef } from "../session-backend-ref";
import type { SessionManager } from "../session-manager";
import { resolveWorktreeLifecycle } from "../worktree-lifecycle-resolver";

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

export function resolveWorktreeToolSessions(
  sessionManager: SessionManager,
  target: Pick<WorktreeToolListingTarget, "id" | "name" | "backendConversationId" | "harnessSessionId">,
): {
  activeSession?: Session;
  persistedSession?: PersistedSessionInfo;
} {
  const refs = [
    target.id,
    target.backendConversationId,
    target.harnessSessionId,
    target.name,
  ];

  let activeSession: Session | undefined;
  let persistedSession: PersistedSessionInfo | undefined;
  for (const ref of refs) {
    if (!ref) continue;
    activeSession ??= sessionManager.resolve(ref);
    persistedSession ??= sessionManager.getPersistedSession(ref);
    if (activeSession && persistedSession) break;
  }

  return { activeSession, persistedSession };
}

export function resolveWorktreeToolLifecycle(
  sessionManager: SessionManager,
  target: WorktreeToolListingTarget,
  options: {
    baseBranch?: string;
  } = {},
): {
  activeSession?: Session;
  persistedSession?: PersistedSessionInfo;
  resolvedLifecycle: ResolvedWorktreeLifecycle;
} {
  const { activeSession, persistedSession } = resolveWorktreeToolSessions(sessionManager, target);
  const resolvedLifecycle = resolveWorktreeLifecycle({
    workdir: target.workdir,
    worktreePath: target.worktreePath,
    worktreeBranch: target.worktreeBranch,
    worktreeBaseBranch: options.baseBranch ?? persistedSession?.worktreeBaseBranch,
    worktreePrTargetRepo: persistedSession?.worktreePrTargetRepo,
    worktreePushRemote: persistedSession?.worktreePushRemote,
    worktreePrUrl: persistedSession?.worktreePrUrl,
    worktreePrNumber: persistedSession?.worktreePrNumber,
    worktreeLifecycle: persistedSession?.worktreeLifecycle,
  }, {
    activeSession: Boolean(activeSession && (activeSession.status === "starting" || activeSession.status === "running")),
    includePrSync: Boolean(persistedSession?.worktreeLifecycle?.state === "pr_open" || persistedSession?.worktreePrUrl),
  });

  return {
    activeSession,
    persistedSession,
    resolvedLifecycle,
  };
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

export function formatWorktreeLifecycleState(state: string): string {
  switch (state) {
    case "none":
      return "none";
    case "provisioned":
      return "active";
    case "pending_decision":
      return "needs decision";
    case "pr_open":
      return "pr open";
    case "merged":
      return "merged";
    case "released":
      return "released";
    case "dismissed":
      return "dismissed";
    case "no_change":
      return "no change";
    case "cleanup_failed":
      return "cleanup failed";
    default:
      return state;
  }
}

export function formatWorktreePreserveReason(reason: string): string {
  switch (reason) {
    case "active_session":
      return "active session";
    case "pending_decision":
      return "pending decision";
    case "dirty_tracked_changes":
      return "dirty worktree";
    case "unique_content":
      return "still has unique content";
    case "topology_merged":
      return "merged by ancestry";
    case "merge_noop_content_already_on_base":
      return "content already on base";
    case "pr_open":
      return "PR open";
    case "pr_merged_not_reflected_locally":
      return "merged PR not reflected locally";
    case "repo_missing":
      return "repo missing";
    case "branch_missing":
      return "branch missing";
    case "worktree_missing":
      return "worktree missing";
    case "base_branch_missing":
      return "base branch missing";
    default:
      return reason.replaceAll("_", " ");
  }
}
