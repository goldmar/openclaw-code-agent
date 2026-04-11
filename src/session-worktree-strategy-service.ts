import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { PersistedSessionInfo } from "./types";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import { SessionWorktreeMessageService } from "./session-worktree-message-service";
import { getPersistedMutationRefs, getPrimarySessionLookupRef, usesNativeBackendWorktree } from "./session-backend-ref";
import { SessionWorktreeActionService } from "./session-worktree-action-service";
import {
  buildMergeConflictResolvingPatch,
  buildMergedPatch,
  buildPendingDecisionPatch,
} from "./worktree-session-patches";
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
type SpawnedResolverSession = Pick<Session, "id" | "name">;

/**
 * Worktree decision/messaging orchestration layer.
 * Low-level git/worktree state checks stay in SessionWorktreeController.
 */
export class SessionWorktreeStrategyService {
  constructor(
    private readonly deps: {
      shouldRunWorktreeStrategy: (session: Session) => boolean;
      isAlreadyMerged: (ref: string | undefined) => boolean;
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined;
      getWorktreeCompletionState: (
        repoDir: string,
        worktreePath: string,
        branchName: string,
        baseBranch: string,
      ) => WorktreeCompletionState;
      updatePersistedSession: (ref: string, patch: Partial<PersistedSessionInfo>) => boolean;
      dispatchSessionNotification: (session: Session, request: SessionNotificationRequest) => void;
      getOutputPreview: (session: Session, maxChars?: number) => string;
      originThreadLine: (session: Session) => string;
      getWorktreeDecisionButtons: (sessionId: string) => NotificationButton[][] | undefined;
      makeOpenPrButton: (sessionId: string) => NotificationButton;
      worktreeMessages: SessionWorktreeMessageService;
      enqueueMerge: (
        repoDir: string,
        fn: () => Promise<void>,
        onQueued?: () => void,
      ) => Promise<void>;
      mergeBranch: typeof mergeBranch;
      spawnConflictResolver: (args: {
        session: Session;
        repoDir: string;
        worktreePath: string;
        branchName: string;
        baseBranch: string;
        prompt: string;
      }) => Promise<SpawnedResolverSession>;
      runAutoPr: (session: Session, baseBranch: string) => Promise<{ success: boolean }>;
    },
  ) {
    this.actions = new SessionWorktreeActionService({
      shouldRunWorktreeStrategy: deps.shouldRunWorktreeStrategy,
      isAlreadyMerged: deps.isAlreadyMerged,
      resolveWorktreeRepoDir: deps.resolveWorktreeRepoDir,
      getWorktreeCompletionState: deps.getWorktreeCompletionState,
    });
  }

  private readonly actions: SessionWorktreeActionService;

  private buildConflictResolverPrompt(args: {
    session: Session;
    repoDir: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    mergeError?: string;
  }): string {
    return [
      `Resolve the git rebase conflict for the auto-merge worktree and finish the rebase cleanly.`,
      ``,
      `Original session: ${args.session.name} [${args.session.id}]`,
      `Repository root: ${args.repoDir}`,
      `Conflicted worktree: ${args.worktreePath}`,
      `Branch: ${args.branchName}`,
      `Base branch: ${args.baseBranch}`,
      ``,
      `Requirements:`,
      `- Work only inside the conflicted worktree.`,
      `- Inspect the current rebase state and resolve only the necessary conflict hunks.`,
      `- Make only minimal follow-up edits needed to keep the rebased branch correct.`,
      `- Continue the rebase until it completes successfully.`,
      `- Run relevant local verification before you finish.`,
      `- Do not broaden scope or start unrelated refactors.`,
      `- Stop only when the branch is cleanly rebased onto ${args.baseBranch}.`,
      args.mergeError ? "" : undefined,
      args.mergeError ? `Rebase failure details:` : undefined,
      args.mergeError,
    ].filter((line): line is string => typeof line === "string").join("\n");
  }

  private notifyAutoMergeConflictEscalation(
    session: Session,
    branchName: string,
    reason: string,
  ): void {
    this.deps.dispatchSessionNotification(session, {
      label: "worktree-merge-conflict-escalated",
      userMessage: [
        `⚠️ [${session.name}] Auto-merge could not finish after one conflict-resolution attempt.`,
        `Branch \`${branchName}\` was preserved for manual follow-up.`,
        ``,
        reason,
      ].join("\n"),
      buttons: [[this.deps.makeOpenPrButton(session.id)]],
    });
  }

  private updatePersistedSessionFor(
    session: Pick<Session, "id" | "harnessSessionId" | "backendRef">,
    patch: Partial<PersistedSessionInfo>,
  ): void {
    for (const mutationRef of getPersistedMutationRefs(session)) {
      this.deps.updatePersistedSession(mutationRef, patch);
    }
  }

  private markPendingDecision(
    session: Session,
    options: {
      notes?: string[];
      clearResolverSessionId?: boolean;
    } = {},
  ): void {
    this.updatePersistedSessionFor(session, buildPendingDecisionPatch(session, options));
  }

  private markAutoMergeConflictResolving(
    session: Session,
    resolverSessionId: string,
    attemptsUsed: number,
  ): void {
    this.updatePersistedSessionFor(
      session,
      buildMergeConflictResolvingPatch(session, resolverSessionId, attemptsUsed, {
        notes: [`resolver_session:${resolverSessionId}`],
      }),
    );
  }

  private markMerged(session: Session): void {
    this.updatePersistedSessionFor(session, buildMergedPatch(session, {
      clearResolverSessionId: true,
    }));
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
        worktreeLifecycle: {
          state: "no_change",
          updatedAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
          resolutionSource: "strategy_no_change",
          baseBranch: session.worktreeBaseBranch,
          targetRepo: session.worktreePrTargetRepo,
          pushRemote: session.worktreePushRemote,
        },
      });
      this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        nativeBackendWorktree,
        cleanupSucceeded: true,
        worktreePath,
        preview: this.deps.getOutputPreview(session),
        originThreadLine: this.deps.originThreadLine(session),
      }));
    } else {
      this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        nativeBackendWorktree,
        cleanupSucceeded: false,
        worktreePath,
        preview: this.deps.getOutputPreview(session),
        originThreadLine: this.deps.originThreadLine(session),
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
    this.markPendingDecision(session);
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
    this.markPendingDecision(session);
    return { notificationSent: true, worktreeRemoved: false };
  }

  private handleAutoMergeSuccess(
    session: Session,
    repoDir: string,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
    mergeResult: ReturnType<typeof mergeBranch>,
  ): void {
    deleteBranch(repoDir, branchName);
    this.markMerged(session);

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
  }

  private async handleInitialAutoMergeConflict(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    mergeError?: string,
  ): Promise<void> {
    const attemptsUsed = session.autoMergeConflictResolutionAttemptCount ?? 0;
    if (attemptsUsed >= 1) {
      this.markPendingDecision(session, {
        notes: ["auto_merge_conflict_retry_exhausted"],
        clearResolverSessionId: true,
      });
      this.notifyAutoMergeConflictEscalation(
        session,
        branchName,
        `The rebased branch still conflicts with \`${baseBranch}\`. Open a PR or resolve manually in ${worktreePath}.`,
      );
      return;
    }

    const conflictPrompt = this.buildConflictResolverPrompt({
      session,
      repoDir,
      worktreePath,
      branchName,
      baseBranch,
      mergeError,
    });

    try {
      const resolverSession = await this.deps.spawnConflictResolver({
        session,
        repoDir,
        worktreePath,
        branchName,
        baseBranch,
        prompt: conflictPrompt,
      });
      this.markAutoMergeConflictResolving(session, resolverSession.id, attemptsUsed + 1);
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-merge-conflict-resolving",
        userMessage: `⚠️ [${session.name}] Auto-merge hit a rebase conflict. Started resolver session ${resolverSession.name} and will retry automatically if it succeeds.`,
      });
    } catch (err) {
      this.markPendingDecision(session, {
        notes: ["auto_merge_conflict_resolver_spawn_failed"],
      });
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-merge-conflict-spawn-failed",
        userMessage: `❌ [${session.name}] Auto-merge hit a rebase conflict and failed to start the resolver: ${err instanceof Error ? err.message : String(err)}`,
        buttons: [[this.deps.makeOpenPrButton(session.id)]],
      });
    }
  }

  private handleAutoMergeRetryFailure(
    session: Session,
    branchName: string,
    worktreePath: string,
    errorMsg: string,
  ): void {
    this.markPendingDecision(session, {
      notes: ["auto_merge_conflict_retry_failed"],
      clearResolverSessionId: true,
    });
    this.deps.dispatchSessionNotification(session, {
      label: "worktree-merge-error",
      userMessage: [
        errorMsg,
        "",
        `Auto-merge retry did not complete after conflict resolution.`,
        `Branch \`${branchName}\` was preserved for manual follow-up in ${worktreePath}.`,
      ].join("\n"),
      buttons: [[this.deps.makeOpenPrButton(session.id)]],
    });
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
    if (session.autoMergeResolverSessionId) return;

    await this.deps.enqueueMerge(
      repoDir,
      async () => {
        if (this.deps.isAlreadyMerged(sessionRef)) return;

        const mergeResult = this.deps.mergeBranch(repoDir, branchName, baseBranch, "merge", worktreePath);

        if (mergeResult.success) {
          this.handleAutoMergeSuccess(session, repoDir, branchName, baseBranch, diffSummary, mergeResult);
          return;
        }

        if (mergeResult.rebaseConflict) {
          await this.handleInitialAutoMergeConflict(
            session,
            repoDir,
            worktreePath,
            branchName,
            baseBranch,
            mergeResult.error,
          );
          return;
        }

        const errorMsg = mergeResult.dirtyError
          ? `❌ [${session.name}] Merge blocked: ${mergeResult.error}`
          : `❌ [${session.name}] Merge failed: ${mergeResult.error ?? "unknown error"}`;
        const retryFailedAfterConflictResolution =
          session.worktreeState === "merge_conflict_resolving"
          || session.worktreeLifecycle?.state === "merge_conflict_resolving";
        if (retryFailedAfterConflictResolution) {
          this.handleAutoMergeRetryFailure(session, branchName, worktreePath, errorMsg);
          return;
        }
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
      this.markPendingDecision(session);
    }
    return { notificationSent: true, worktreeRemoved: false };
  }
}
