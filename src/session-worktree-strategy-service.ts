import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { PersistedSessionInfo } from "./types";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import type { EmbeddedEvalResult } from "./embedded-eval";
import { SessionWorktreeMessageService } from "./session-worktree-message-service";
import { getPersistedMutationRefs, getPrimarySessionLookupRef, usesNativeBackendWorktree } from "./session-backend-ref";
import { SessionWorktreeActionService } from "./session-worktree-action-service";
import {
  removeWorktree,
  getDiffSummary,
  mergeBranch,
  deleteBranch,
  formatWorktreeOutcomeLine,
} from "./worktree";

export type WorktreeStrategyResult = {
  notificationSent: boolean;
  worktreeRemoved: boolean;
};

type DiffSummary = NonNullable<ReturnType<typeof getDiffSummary>>;

/**
 * Worktree decision/messaging orchestration layer.
 * Low-level git/worktree state checks stay in SessionWorktreeController.
 */
export class SessionWorktreeStrategyService {
  constructor(
    private readonly deps: {
      shouldRunWorktreeStrategy: (session: Session) => boolean;
      isAlreadyMerged: (harnessSessionId: string | undefined) => boolean;
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined;
      getWorktreeCompletionState: (
        repoDir: string,
        worktreePath: string,
        branchName: string,
        baseBranch: string,
      ) => WorktreeCompletionState;
      classifyNoChangeDeliverable: (context: {
        harnessName: string;
        sessionName: string;
        prompt: string;
        workdir: string;
        agentId?: string;
        outputText: string;
      }) => Promise<EmbeddedEvalResult>;
      updatePersistedSession: (ref: string, patch: Partial<PersistedSessionInfo>) => boolean;
      dispatchSessionNotification: (session: Session, request: SessionNotificationRequest) => void;
      getWorktreeDecisionButtons: (sessionId: string) => NotificationButton[][] | undefined;
      makeOpenPrButton: (sessionId: string) => NotificationButton;
      worktreeMessages: SessionWorktreeMessageService;
      enqueueMerge: (
        repoDir: string,
        fn: () => Promise<void>,
        onQueued?: () => void,
      ) => Promise<void>;
      spawnConflictResolver: (session: Session, repoDir: string, prompt: string) => Promise<void>;
      runAutoPr: (session: Session, baseBranch: string) => Promise<{ success: boolean }>;
    },
  ) {
    this.actions = new SessionWorktreeActionService({
      shouldRunWorktreeStrategy: deps.shouldRunWorktreeStrategy,
      isAlreadyMerged: deps.isAlreadyMerged,
      resolveWorktreeRepoDir: deps.resolveWorktreeRepoDir,
      getWorktreeCompletionState: deps.getWorktreeCompletionState,
      classifyNoChangeDeliverable: deps.classifyNoChangeDeliverable,
    });
  }

  private readonly actions: SessionWorktreeActionService;

  private updatePersistedSessionFor(
    session: Pick<Session, "id" | "harnessSessionId" | "backendRef">,
    patch: Partial<PersistedSessionInfo>,
  ): void {
    for (const mutationRef of getPersistedMutationRefs(session)) {
      this.deps.updatePersistedSession(mutationRef, patch);
    }
  }

  async handleWorktreeStrategy(session: Session): Promise<WorktreeStrategyResult> {
    const action = await this.actions.plan(session);

    if (action.kind === "skip") {
      return action.result;
    }

    if (action.kind === "notify") {
      this.deps.dispatchSessionNotification(session, {
        label: action.label,
        userMessage: action.message,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }

    if (action.kind === "no-change") {
      return this.handleNoChange(
        session,
        action.repoDir,
        action.worktreePath,
        action.deliverablePreview,
        action.nativeBackendWorktree,
      );
    }

    if (action.strategy === "ask") {
      return this.handleAskStrategy(session, action.branchName, action.baseBranch, action.diffSummary);
    }
    if (action.strategy === "delegate") {
      return this.handleDelegateStrategy(session, action.branchName, action.baseBranch, action.diffSummary);
    }
    if (action.strategy === "auto-merge") {
      await this.handleAutoMergeStrategy(
        session,
        action.repoDir,
        action.worktreePath,
        action.branchName,
        action.baseBranch,
        action.diffSummary,
        action.sessionRef,
      );
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (action.strategy === "auto-pr") {
      return this.handleAutoPrStrategy(session, action.baseBranch);
    }
    return { notificationSent: false, worktreeRemoved: false };
  }

  private async handleNoChange(
    session: Session,
    repoDir: string,
    worktreePath: string,
    deliverablePreview?: string,
    nativeBackendWorktree: boolean = usesNativeBackendWorktree(session),
  ): Promise<WorktreeStrategyResult> {
    const removed = nativeBackendWorktree
      ? true
      : removeWorktree(repoDir, worktreePath);
    if (removed) {
      session.worktreePath = undefined;
      this.updatePersistedSessionFor(session, {
        worktreePath: undefined,
        worktreeDisposition: "no-change-cleaned",
        worktreeState: "none",
      });
      this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        deliverablePreview,
        nativeBackendWorktree,
        cleanupSucceeded: true,
        worktreePath,
      }));
    } else {
      this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        deliverablePreview,
        nativeBackendWorktree,
        cleanupSucceeded: false,
        worktreePath,
      }));
    }
    return { notificationSent: true, worktreeRemoved: removed };
  }

  private handleAskStrategy(
    session: Session,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
  ): WorktreeStrategyResult {
    this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildAskNotification({
      session,
      branchName,
      baseBranch,
      diffSummary,
      buttons: this.deps.getWorktreeDecisionButtons(session.id),
    }));

    this.updatePersistedSessionFor(session, {
      pendingWorktreeDecisionSince: new Date().toISOString(),
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
    });
    return { notificationSent: true, worktreeRemoved: false };
  }

  private handleDelegateStrategy(
    session: Session,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
  ): WorktreeStrategyResult {
    this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildDelegateNotification({
      session,
      branchName,
      baseBranch,
      diffSummary,
    }));

    this.updatePersistedSessionFor(session, {
      pendingWorktreeDecisionSince: new Date().toISOString(),
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
    });
    return { notificationSent: true, worktreeRemoved: false };
  }

  private async handleAutoMergeStrategy(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
    sessionRef = getPrimarySessionLookupRef(session) ?? session.harnessSessionId,
  ): Promise<void> {
    if (this.deps.isAlreadyMerged(sessionRef)) return;

    await this.deps.enqueueMerge(
      repoDir,
      async () => {
        if (this.deps.isAlreadyMerged(sessionRef)) return;

        const mergeResult = mergeBranch(repoDir, branchName, baseBranch, "merge", worktreePath);

        if (mergeResult.success) {
          deleteBranch(repoDir, branchName);

          this.updatePersistedSessionFor(session, {
            worktreeMerged: true,
            worktreeMergedAt: new Date().toISOString(),
            lifecycle: "terminal",
            worktreeState: "merged",
            pendingWorktreeDecisionSince: undefined,
            lastWorktreeReminderAt: undefined,
          });

          const outcomeLine = formatWorktreeOutcomeLine({
            kind: "merge",
            branch: branchName,
            base: baseBranch,
            filesChanged: diffSummary.filesChanged,
            insertions: diffSummary.insertions,
            deletions: diffSummary.deletions,
          });
          let successMsg = outcomeLine;
          if (mergeResult.stashPopConflict) {
            successMsg += `\n⚠️ Pre-merge stash pop conflicted — run \`git stash show ${mergeResult.stashRef ?? "stash@{0}"}\` in ${repoDir} to review stashed changes.`;
          } else if (mergeResult.stashed) {
            successMsg += `\n(Pre-existing changes on ${baseBranch} were auto-stashed and restored.)`;
          }

          this.deps.dispatchSessionNotification(session, {
            label: "worktree-merge-success",
            userMessage: successMsg,
          });
          return;
        }

        if (mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0) {
          const conflictPrompt = [
            `Resolve merge conflicts in the following files and commit the resolution:`,
            ``,
            ...mergeResult.conflictFiles.map((f) => `- ${f}`),
            ``,
            `After resolving, commit with message: "Resolve merge conflicts from ${branchName}"`,
          ].join("\n");

          try {
            await this.deps.spawnConflictResolver(session, repoDir, conflictPrompt);
            this.deps.dispatchSessionNotification(session, {
              label: "worktree-merge-conflict",
              userMessage: `⚠️ [${session.name}] Merge conflicts in ${mergeResult.conflictFiles.length} file(s) — spawned conflict resolver session`,
              buttons: [[this.deps.makeOpenPrButton(session.id)]],
            });
          } catch (err) {
            this.deps.dispatchSessionNotification(session, {
              label: "worktree-merge-conflict-spawn-failed",
              userMessage: `❌ [${session.name}] Merge conflicts detected, but failed to spawn resolver: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          return;
        }

        const errorMsg = mergeResult.dirtyError
          ? `❌ [${session.name}] Merge blocked: ${mergeResult.error}`
          : `❌ [${session.name}] Merge failed: ${mergeResult.error ?? "unknown error"}`;
        this.deps.dispatchSessionNotification(session, {
          label: "worktree-merge-error",
          userMessage: errorMsg,
        });
      },
      () => {
        this.deps.dispatchSessionNotification(session, {
          label: "worktree-merge-queued",
          userMessage: `🕐 [${session.name}] Merge queued — another merge for this repo is in progress. Will notify when complete.`,
        });
      },
    );
  }

  private async handleAutoPrStrategy(
    session: Session,
    baseBranch: string,
  ): Promise<WorktreeStrategyResult> {
    this.updatePersistedSessionFor(session, {
      lifecycle: "terminal",
      worktreeState: "pr_in_progress",
    });
    const result = await this.deps.runAutoPr(session, baseBranch);
    if (!result.success) {
      this.updatePersistedSessionFor(session, {
        pendingWorktreeDecisionSince: new Date().toISOString(),
        lifecycle: "awaiting_worktree_decision",
        worktreeState: "pending_decision",
      });
    }
    return { notificationSent: true, worktreeRemoved: false };
  }
}
