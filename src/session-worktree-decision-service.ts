import { existsSync } from "fs";

import type { PersistedSessionInfo } from "./types";
import type { Session } from "./session";
import { getBackendConversationId, getPersistedMutationRefs, getPrimarySessionLookupRef, usesNativeBackendWorktree } from "./session-backend-ref";
import { deleteBranch, removeWorktree } from "./worktree";

type WorktreeDecisionSession = Pick<
  Session,
  "id" | "name" | "harnessSessionId" | "backendRef" | "route" | "worktreePath" | "worktreeBranch" | "originalWorkdir"
>;

type PersistedLike = Pick<
  PersistedSessionInfo,
  "sessionId" | "name" | "harnessSessionId" | "backendRef" | "route" | "worktreePath" | "worktreeBranch" | "workdir"
>;

export class SessionWorktreeDecisionService {
  constructor(
    private readonly deps: {
      getPersistedSession: (ref: string) => PersistedSessionInfo | undefined;
      resolveActiveSession: (ref: string) => WorktreeDecisionSession | undefined;
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined;
      updatePersistedSession: (ref: string, patch: Partial<PersistedSessionInfo>) => boolean;
      dispatchNotification: (
        session: Session,
        request: { label: string; userMessage?: string; notifyUser?: "always" | "never" },
      ) => void;
      buildRoutingProxy: (session: {
        id?: string;
        sessionId?: string;
        harnessSessionId?: string;
        backendRef?: PersistedSessionInfo["backendRef"];
        route?: PersistedSessionInfo["route"];
      }) => Session;
    },
  ) {}

  async dismissWorktree(ref: string): Promise<string> {
    const persistedSession = this.deps.getPersistedSession(ref);
    const activeSession = this.deps.resolveActiveSession(ref);
    const session = activeSession ?? persistedSession;
    if (!session) return `Error: Session "${ref}" not found.`;

    const worktreePath = activeSession?.worktreePath ?? persistedSession?.worktreePath;
    const repoDir = this.deps.resolveWorktreeRepoDir(activeSession?.originalWorkdir ?? persistedSession?.workdir, worktreePath);
    const branchName = activeSession?.worktreeBranch ?? persistedSession?.worktreeBranch;
    const sessionName = activeSession?.name ?? persistedSession?.name ?? ref;

    if (!repoDir) return `Error: No workdir found for session "${ref}".`;

    const nativeBackendWorktree = usesNativeBackendWorktree(session);
    if (!nativeBackendWorktree && worktreePath && existsSync(worktreePath)) {
      removeWorktree(repoDir, worktreePath, { destructive: true });
    }

    if (branchName) {
      deleteBranch(repoDir, branchName);
    }

    for (const mutationRef of getPersistedMutationRefs(activeSession ?? persistedSession)) {
      this.deps.updatePersistedSession(mutationRef, {
        worktreeDisposition: "dismissed",
        worktreeDismissedAt: new Date().toISOString(),
        pendingWorktreeDecisionSince: undefined,
        worktreeState: "dismissed",
        lifecycle: "terminal",
        worktreePath: undefined,
        worktreeBranch: undefined,
        worktreeLifecycle: {
          state: "dismissed",
          updatedAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
          resolutionSource: "dismiss",
          baseBranch: persistedSession?.worktreeLifecycle?.baseBranch,
          targetRepo: persistedSession?.worktreePrTargetRepo,
          pushRemote: persistedSession?.worktreePushRemote,
        },
      } as Partial<PersistedSessionInfo>);
    }

    const msg = nativeBackendWorktree
      ? `🗑️ [${sessionName}] Branch \`${branchName ?? "unknown"}\` dismissed. Native backend worktree released for backend cleanup.`
      : `🗑️ [${sessionName}] Branch \`${branchName ?? "unknown"}\` dismissed and permanently deleted.`;
    this.deps.dispatchNotification(
      this.deps.buildRoutingProxy({
        id: getPrimarySessionLookupRef(activeSession ?? persistedSession ?? { id: ref }) ?? ref,
        sessionId: persistedSession?.sessionId,
        harnessSessionId: activeSession?.harnessSessionId ?? persistedSession?.harnessSessionId,
        backendRef: activeSession?.backendRef ?? persistedSession?.backendRef,
        route: activeSession?.route ?? persistedSession?.route,
      }),
      {
        label: "worktree-dismissed",
        userMessage: msg,
        notifyUser: "always",
      },
    );

    return msg;
  }

  snoozeWorktreeDecision(ref: string): string {
    const persistedSession = this.deps.getPersistedSession(ref);
    if (!persistedSession) return `Error: Session "${ref}" not found.`;

    const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    for (const mutationRef of getPersistedMutationRefs(persistedSession)) {
      this.deps.updatePersistedSession(mutationRef, {
        worktreeDecisionSnoozedUntil: snoozedUntil,
        lastWorktreeReminderAt: new Date().toISOString(),
      } as Partial<PersistedSessionInfo>);
    }

    const branchName = persistedSession.worktreeBranch ?? "unknown";
    const msg = `⏭️ Reminder snoozed 24h for \`${branchName}\` (session: ${persistedSession.name})`;

    this.deps.dispatchNotification(
      this.deps.buildRoutingProxy({
        id: getPrimarySessionLookupRef(persistedSession) ?? getBackendConversationId(persistedSession) ?? persistedSession.harnessSessionId,
        sessionId: persistedSession.sessionId,
        harnessSessionId: persistedSession.harnessSessionId,
        backendRef: persistedSession.backendRef,
        route: persistedSession.route,
      }),
      {
        label: "worktree-snoozed",
        userMessage: msg,
        notifyUser: "always",
      },
    );

    return msg;
  }
}
