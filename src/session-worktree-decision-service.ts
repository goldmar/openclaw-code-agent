import { existsSync } from "fs";

import type { PersistedSessionInfo } from "./types";
import { SessionReminderService } from "./session-reminder-service";
import type { Session } from "./session";
import { getBackendConversationId, getPersistedMutationRefs, getPrimarySessionLookupRef } from "./session-backend-ref";
import { deleteBranch, removeWorktree } from "./worktree";

type WorktreeDecisionSession = Pick<
  Session,
  "id" | "name" | "status" | "harnessSessionId" | "backendRef" | "route" | "worktreePath" | "worktreeBranch" | "originalWorkdir"
>;

export class SessionWorktreeDecisionService {
  constructor(
    private readonly deps: {
      getPersistedSession: (ref: string) => PersistedSessionInfo | undefined;
      resolveActiveSession: (ref: string) => WorktreeDecisionSession | undefined;
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined | Promise<string | undefined>;
      updatePersistedSession: (ref: string, patch: Partial<PersistedSessionInfo>) => boolean;
      dispatchNotification: (
        session: Session,
        request: { label: string; idempotencyKey?: string; userMessage?: string; notifyUser?: "always" | "never" },
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
    // A resumed session (for example after Commit changes) is working in this worktree.
    if (activeSession && (activeSession.status === "running" || activeSession.status === "starting")) {
      return `Error: [${activeSession.name}] is running in this worktree. Discard it after the session ends, or stop the session first.`;
    }

    const worktreePath = activeSession?.worktreePath ?? persistedSession?.worktreePath;
    const repoDir = await this.deps.resolveWorktreeRepoDir(activeSession?.originalWorkdir ?? persistedSession?.workdir, worktreePath);
    const branchName = activeSession?.worktreeBranch ?? persistedSession?.worktreeBranch;
    const sessionName = activeSession?.name ?? persistedSession?.name ?? ref;

    if (!repoDir) return `Error: No workdir found for session "${ref}".`;

    if (worktreePath && existsSync(worktreePath)) {
      await removeWorktree(repoDir, worktreePath, { destructive: true });
    }

    if (branchName) {
      await deleteBranch(repoDir, branchName);
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

    const msg = `🗑️ [${sessionName}] Branch \`${branchName ?? "unknown"}\` dismissed and permanently deleted.`;
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
        idempotencyKey: `worktree-dismissed:${getPrimarySessionLookupRef(activeSession ?? persistedSession ?? { id: ref }) ?? ref}:${branchName ?? "unknown"}`,
        userMessage: msg,
        notifyUser: "always",
      },
    );

    return msg;
  }

  snoozeWorktreeDecision(ref: string, options: { notifyUser?: boolean } = {}): string {
    const persistedSession = this.deps.getPersistedSession(ref);
    if (!persistedSession) return `Error: Session "${ref}" not found.`;

    const now = Date.now();
    const snoozedUntil = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    for (const mutationRef of getPersistedMutationRefs(persistedSession)) {
      this.deps.updatePersistedSession(mutationRef, {
        worktreeDecisionSnoozedUntil: snoozedUntil,
        lastWorktreeReminderAt: new Date(now).toISOString(),
        // A snooze is not a reminder: keep the count so the backoff continues.
        worktreeReminderCount: persistedSession.lastWorktreeReminderAt ? persistedSession.worktreeReminderCount ?? 1 : 0,
      } as Partial<PersistedSessionInfo>);
    }

    const branchName = persistedSession.worktreeBranch ?? "unknown";
    // After the final reminder no further reminder is scheduled: do not promise one.
    const remindersDone = Boolean(persistedSession.lastWorktreeReminderAt)
      && (persistedSession.worktreeReminderCount ?? 1) >= SessionReminderService.MAX_REMINDERS;
    const msg = remindersDone
      ? `⏭️ Kept for later: \`${branchName}\` (session: ${persistedSession.name}). No more reminders; /agent_status lists it.`
      : `⏭️ Reminder snoozed 24h for \`${branchName}\` (session: ${persistedSession.name})`;

    if (options.notifyUser !== false) {
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
          idempotencyKey: `worktree-snoozed:${getPrimarySessionLookupRef(persistedSession) ?? getBackendConversationId(persistedSession) ?? persistedSession.harnessSessionId}:${snoozedUntil}`,
          userMessage: msg,
          notifyUser: "always",
        },
      );
    }

    return msg;
  }
}
