import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { PersistedSessionInfo } from "./types";
import type { RepoPolicyResolution } from "./repo-policy";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { PRStatus } from "./worktree-pr";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import { SessionWorktreeMessageService } from "./session-worktree-message-service";
import { getPersistedMutationRefs, getPrimarySessionLookupRef, usesNativeBackendWorktree } from "./session-backend-ref";
import { SessionWorktreeActionService } from "./session-worktree-action-service";
import {
  buildMergeConflictResolvingPatch,
  buildMergedPatch,
  buildPendingDecisionPatch,
} from "./worktree-session-patches";
import { buildWorktreeOutcomeFollowupWake } from "./session-notification-builder";
import {
  buildWorktreeDecisionWorkSummary,
  type WorktreeDecisionSummaryProvider,
} from "./worktree-decision-summary";
import {
  removeWorktree,
  getDiffSummary,
  getBranchName,
  isBranchAncestorOfBase,
  listDirtyWorktreeEntries,
  mergeBranch,
  deleteBranch,
  formatWorktreeOutcomeLine,
  buildMergeWarningLines,
  appendMergeWarnings,
  fetchRemoteBranchRef,
  resolveTargetRepo,
  syncWorktreePR,
  syncWorktreePRByUrl,
  worktreeExists,
} from "./worktree";

export type WorktreeStrategyResult = {
  notificationSent: boolean;
  worktreeRemoved: boolean;
};

type DiffSummary = NonNullable<ReturnType<typeof getDiffSummary>>;
type SpawnedResolverSession = Pick<Session, "id" | "name">;
type AllowedWorktreeActions = { merge: boolean; pr: boolean };

function buildWorktreeCycleKey(session: Pick<Session, "startedAt" | "worktreeBranch" | "worktreePath">): string {
  return [
    session.startedAt,
    session.worktreeBranch ?? "unknown-branch",
    session.worktreePath ?? "unknown-worktree",
  ].join(":");
}

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
      getPersistedSession?: (ref: string) => PersistedSessionInfo | undefined;
      dispatchSessionNotification: (session: Session, request: SessionNotificationRequest) => void;
      getOutputPreview: (session: Session, maxChars?: number) => string;
      originThreadLine: (session: Session) => string;
      getWorktreeDecisionButtons: (sessionId: string) => NotificationButton[][] | undefined;
      getPolicyAwareWorktreeDecisionButtons?: (
        sessionId: string,
        options: { allowDelegate?: boolean },
        allowedActions: AllowedWorktreeActions,
      ) => NotificationButton[][] | undefined;
      makeOpenPrButton: (sessionId: string) => NotificationButton;
      isPrAvailable?: (repoDir: string) => boolean;
      hasOpenPrForBranch?: (repoDir: string, branchName: string, targetRepo?: string) => boolean;
      getPrStatusForBranch?: (repoDir: string, branchName: string, targetRepo?: string) => PRStatus;
      getPrStatusForUrl?: (repoDir: string, prUrl: string, targetRepo?: string) => PRStatus;
      resolveRepoPolicy?: (repoDir: string) => RepoPolicyResolution;
      worktreeSummaryProvider?: WorktreeDecisionSummaryProvider;
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
      isPrAvailable: deps.isPrAvailable ?? (() => true),
      resolveRepoPolicy: deps.resolveRepoPolicy,
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
    allowedActions: AllowedWorktreeActions,
    warningLines: string[] = [],
  ): void {
    this.deps.dispatchSessionNotification(session, {
      label: "worktree-merge-conflict-escalated",
      idempotencyKey: `worktree-merge-conflict-escalated:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
      userMessage: [
        `⚠️ [${session.name}] Auto-merge could not finish after one conflict-resolution attempt.`,
        `Branch \`${branchName}\` was preserved for manual follow-up.`,
        ``,
        reason,
        ...warningLines.map((line) => `⚠️ ${line}`),
      ].join("\n"),
      buttons: this.getPolicyAwareWorktreeDecisionButtons(
        session.id,
        allowedActions,
        {},
        [[this.deps.makeOpenPrButton(session.id)]],
      ),
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

  private markReleased(session: Session, notes: string[] = []): void {
    const updatedAt = new Date().toISOString();
    this.updatePersistedSessionFor(session, {
      lifecycle: "terminal",
      worktreeState: "released",
      pendingWorktreeDecisionSince: undefined,
      lastWorktreeReminderAt: undefined,
      worktreeDecisionSnoozedUntil: undefined,
      worktreeLifecycle: {
        state: "released",
        updatedAt,
        resolvedAt: updatedAt,
        resolutionSource: "lifecycle_resolver",
        baseBranch: session.worktreeBaseBranch,
        targetRepo: session.worktreePrTargetRepo,
        pushRemote: session.worktreePushRemote,
        notes,
      },
    });
  }

  async handleWorktreeStrategy(session: Session): Promise<WorktreeStrategyResult> {
    const action = await this.actions.plan(session);

    if (action.kind === "skip") {
      return action.result;
    }

    if (action.kind === "notify") {
      this.deps.dispatchSessionNotification(session, {
        label: action.label,
        idempotencyKey: [
          "worktree-action",
          session.id,
          action.label,
          session.startedAt,
          session.worktreeBranch ?? "unknown",
          session.worktreePath ?? "unknown",
        ].join(":"),
        userMessage: action.message,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }

    if (action.kind === "dirty-uncommitted") {
      return this.handleDirtyUncommittedCompletion(
        session,
        action.worktreePath,
        action.branchName,
        action.baseBranch,
      );
    }

    if (action.kind === "no-change") {
      return this.handleNoChange(
        session,
        action.repoDir,
        action.worktreePath,
        action.branchName,
        action.nativeBackendWorktree,
      );
    }

    if (action.kind === "merged") {
      const removed = action.nativeBackendWorktree
        ? true
        : removeWorktree(action.repoDir, action.worktreePath);
      deleteBranch(action.repoDir, action.branchName);
      this.markMerged(session);
      return { notificationSent: false, worktreeRemoved: removed };
    }

    if (action.kind === "released") {
      const removed = action.nativeBackendWorktree
        ? true
        : removeWorktree(action.repoDir, action.worktreePath);
      deleteBranch(action.repoDir, action.branchName);
      this.markReleased(session, action.reasons);
      return { notificationSent: false, worktreeRemoved: removed };
    }

    if (action.policyBlocked) {
      if (this.shouldUpdateExistingOpenPr(session, action.repoDir, action.branchName, action.baseBranch)) {
        return this.handleAutoPrStrategy(
          session,
          action.repoDir,
          action.worktreePath,
          action.branchName,
          action.baseBranch,
          { merge: false, pr: true },
        );
      }
      this.markPendingDecision(session, { notes: action.policyReason ? [action.policyReason] : undefined });
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-policy-blocked",
        idempotencyKey: `worktree-policy-blocked:${session.id}:${action.branchName}:${action.baseBranch}:${buildWorktreeCycleKey(session)}`,
        userMessage: `⚠️ [${session.name}] ${action.policyReason ?? "Repo policy blocked automatic follow-through."}`,
        buttons: this.getPolicyAwareWorktreeDecisionButtons(session.id, action.allowedActions, { allowDelegate: true }),
      });
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (action.strategy === "ask") {
      if (this.shouldUpdateExistingOpenPr(session, action.repoDir, action.branchName, action.baseBranch)) {
        return this.handleAutoPrStrategy(
          session,
          action.repoDir,
          action.worktreePath,
          action.branchName,
          action.baseBranch,
          action.allowedActions,
        );
      }
      return await this.handleAskStrategy(session, action.branchName, action.baseBranch, action.diffSummary, action.allowedActions, action.policyReason);
    }
    if (action.strategy === "delegate") {
      return this.handleDelegateStrategy(session, action.branchName, action.baseBranch, action.diffSummary, action.allowedActions, action.policyReason);
    }
    if (action.strategy === "auto-merge") {
      const worktreeRemoved = await this.handleAutoMergeStrategy(
        session,
        action.repoDir,
        action.worktreePath,
        action.branchName,
        action.baseBranch,
        action.diffSummary,
        action.sessionRef,
        action.allowedActions,
      );
      return { notificationSent: true, worktreeRemoved };
    }
    if (action.strategy === "auto-pr") {
      return this.handleAutoPrStrategy(
        session,
        action.repoDir,
        action.worktreePath,
        action.branchName,
        action.baseBranch,
        action.allowedActions,
      );
    }
    return { notificationSent: false, worktreeRemoved: false };
  }

  private async handleNoChange(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    nativeBackendWorktree: boolean = usesNativeBackendWorktree(session),
  ): Promise<WorktreeStrategyResult> {
    if (this.hasCurrentlyOpenPrForBranch(session, repoDir, branchName)) {
      const updatedAt = new Date().toISOString();
      this.updatePersistedSessionFor(session, {
        lifecycle: "terminal",
        worktreeState: "pr_open",
        pendingWorktreeDecisionSince: undefined,
        lastWorktreeReminderAt: undefined,
        worktreeDecisionSnoozedUntil: undefined,
        worktreeLifecycle: {
          state: "pr_open",
          updatedAt,
          resolutionSource: session.worktreeLifecycle?.resolutionSource ?? "agent_pr",
          baseBranch: session.worktreeBaseBranch,
          targetRepo: session.worktreePrTargetRepo,
          pushRemote: session.worktreePushRemote,
          notes: ["no_new_worktree_commits_preserved_open_pr"],
        },
      });
      this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        nativeBackendWorktree,
        cleanupSucceeded: true,
        worktreePath,
        worktreeBranch: branchName,
        preview: this.deps.getOutputPreview(session),
        originThreadLine: this.deps.originThreadLine(session),
        preservedSummary: "existing PR worktree preserved until merge",
      }));
      return { notificationSent: true, worktreeRemoved: false };
    }

    const remoteOutcome = this.getDeliveredRemoteOutcome(session);
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
        worktreeBranch: branchName,
        preview: this.deps.getOutputPreview(session),
        originThreadLine: this.deps.originThreadLine(session),
        remoteOutcome,
      }));
    } else {
      this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        nativeBackendWorktree,
        cleanupSucceeded: false,
        worktreePath,
        worktreeBranch: branchName,
        preview: this.deps.getOutputPreview(session),
        originThreadLine: this.deps.originThreadLine(session),
        remoteOutcome,
      }));
    }
    return { notificationSent: true, worktreeRemoved: removed };
  }

  private hasCurrentlyOpenPrForBranch(session: Session, repoDir: string, branchName: string): boolean {
    return this.deps.hasOpenPrForBranch?.(repoDir, branchName, session.worktreePrTargetRepo) === true;
  }

  private getDeliveredRemoteOutcome(session: Session): "pr-updated" | "pr-opened" | undefined {
    const persistedWithRemoteOutcome = getPersistedMutationRefs(session)
      .map((ref) => this.deps.getPersistedSession?.(ref))
      .find((entry): entry is PersistedSessionInfo & { worktreeRemoteOutcome: "pr-updated" | "pr-opened" } => (
        entry?.worktreeRemoteOutcome === "pr-updated" || entry?.worktreeRemoteOutcome === "pr-opened"
      ));
    return persistedWithRemoteOutcome?.worktreeRemoteOutcome;
  }

  private resolveExistingTargetPr(session: Session, repoDir: string, branchName: string, baseBranch: string): PRStatus | undefined {
    const targetRepo = resolveTargetRepo(repoDir, session.worktreePrTargetRepo);
    if (session.worktreePrUrl) {
      const recorded = this.getPrStatusForUrl(repoDir, session.worktreePrUrl, targetRepo);
      if (recorded.exists) return recorded;
    }

    const parentBranch = getBranchName(repoDir);
    if (!parentBranch || parentBranch === branchName || parentBranch === baseBranch) return undefined;
    const discovered = this.deps.getPrStatusForBranch?.(repoDir, parentBranch, targetRepo)
      ?? syncWorktreePR(repoDir, parentBranch, targetRepo);
    return discovered.exists
      && discovered.state === "open"
      && discovered.headRefName === parentBranch
      && (!discovered.baseRefName || discovered.baseRefName === baseBranch)
      ? discovered
      : undefined;
  }

  private shouldUpdateExistingOpenPr(
    session: Session,
    repoDir: string,
    branchName: string,
    baseBranch: string,
  ): boolean {
    return session.worktreeStrategy === "auto-pr"
      && (
        this.hasCurrentlyOpenPrForBranch(session, repoDir, branchName)
        || this.resolveExistingTargetPr(session, repoDir, branchName, baseBranch)?.state === "open"
      );
  }

  private async handleAskStrategy(
    session: Session,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
    allowedActions: AllowedWorktreeActions,
    policyReason?: string,
  ): Promise<WorktreeStrategyResult> {
    const summary = await buildWorktreeDecisionWorkSummary({
      sessionName: session.name,
      prompt: session.prompt,
      diffSummary,
      outputPreview: this.deps.getOutputPreview(session, 4_000),
      provider: this.deps.worktreeSummaryProvider,
    });
    this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildAskNotification({
      session,
      branchName,
      baseBranch,
      diffSummary,
      summaryLines: summary.lines,
      policyReason,
      buttons: this.getPolicyAwareWorktreeDecisionButtons(session.id, allowedActions),
    }));
    this.markPendingDecision(session);
    return { notificationSent: true, worktreeRemoved: false };
  }

  private handleDelegateStrategy(
    session: Session,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
    allowedActions: AllowedWorktreeActions,
    policyReason?: string,
  ): WorktreeStrategyResult {
    this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildDelegateNotification({
      session,
      branchName,
      baseBranch,
      diffSummary,
      policyReason,
      allowedActions,
      originThreadLine: this.deps.originThreadLine(session),
    }));
    this.markPendingDecision(session);
    return { notificationSent: true, worktreeRemoved: false };
  }

  private getPolicyAwareWorktreeDecisionButtons(
    sessionId: string,
    allowedActions: AllowedWorktreeActions,
    options: { allowDelegate?: boolean } = {},
    fallbackButtons?: NotificationButton[][],
  ): NotificationButton[][] | undefined {
    if (this.deps.getPolicyAwareWorktreeDecisionButtons) {
      return this.deps.getPolicyAwareWorktreeDecisionButtons(sessionId, options, allowedActions);
    }
    if (fallbackButtons && allowedActions.pr) return fallbackButtons;
    if (fallbackButtons && !allowedActions.pr && !allowedActions.merge) return undefined;
    return this.deps.getWorktreeDecisionButtons(sessionId);
  }

  private handleDirtyUncommittedCompletion(
    session: Session,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): WorktreeStrategyResult {
    this.markPendingDecision(session, {
      notes: ["dirty_uncommitted_completion"],
    });
    const dirtyEntries = listDirtyWorktreeEntries(worktreePath);
    const dirtyPreview = dirtyEntries.slice(0, 20).map((entry) => `- ${entry}`);
    const moreLine = dirtyEntries.length > 20 ? [`- ...and ${dirtyEntries.length - 20} more`] : [];
    this.deps.dispatchSessionNotification(session, {
      label: "worktree-dirty-uncommitted",
      idempotencyKey: `worktree-dirty-uncommitted:${session.id}:${branchName}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
      userMessage: [
        `⚠️ [${session.name}] Session completed with uncommitted worktree changes.`,
        ``,
        `Branch \`${branchName}\` has no commits ahead of \`${baseBranch}\`, so merge/PR follow-through is blocked until the worktree is fixed.`,
        `Worktree: ${worktreePath}`,
        ``,
        ...(dirtyPreview.length > 0
          ? [`Dirty entries:`, ...dirtyPreview, ...moreLine, ``]
          : []),
        `Resume the session or inspect the worktree, then commit real task changes or clean temporary files. Discard only if these local changes should be permanently removed.`,
      ].join("\n"),
    });
    return { notificationSent: true, worktreeRemoved: false };
  }

  private handleAutoMergeSuccess(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
    mergeResult: ReturnType<typeof mergeBranch>,
  ): boolean {
    const nativeBackendWorktree = usesNativeBackendWorktree(session);
    const removed = nativeBackendWorktree
      || !worktreeExists(worktreePath)
      || removeWorktree(repoDir, worktreePath);
    if (removed) {
      session.worktreePath = undefined;
      this.updatePersistedSessionFor(session, { worktreePath: undefined });
      if (!nativeBackendWorktree) deleteBranch(repoDir, branchName);
    }
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
    successMsg = appendMergeWarnings(successMsg, mergeResult);
    const warningDetailLines = buildMergeWarningLines(mergeResult);
    const outcomeDetailLines = [
      mergeResult.fastForward ? "Merge type: fast-forward." : "Merge type: merge commit.",
      `Auto-merge landed ${branchName} into ${baseBranch}.`,
      "Local worktree branch cleanup was requested.",
      ...(mergeResult.stashPopConflict
        ? [`Pre-merge stash pop conflicted; run git stash show ${mergeResult.stashRef ?? "stash@{0}"} in ${repoDir} to review stashed changes.`]
        : []),
      ...(!mergeResult.stashPopConflict && mergeResult.stashed
        ? [`Pre-existing changes on ${baseBranch} were auto-stashed and restored.`]
        : []),
      ...warningDetailLines,
    ];

    this.deps.dispatchSessionNotification(session, {
      label: "worktree-merge-success",
      idempotencyKey: `worktree-merge-success:${session.id}:${branchName}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
      userMessage: successMsg,
      notifyUser: "always",
      completionSummary: {
        required: true,
        producer: "worktree",
        outcomeKey: `worktree-merge:${session.id}:${branchName}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: `worktree-merge:${session.id}:${branchName}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
      deferConditionalWakeUntilNextTick: true,
      wakeMessageOnNotifySuccess: buildWorktreeOutcomeFollowupWake({
        sessionId: session.id,
        sessionName: session.name,
        outcomeLine,
        originThreadLine: this.deps.originThreadLine(session),
        detailLines: outcomeDetailLines,
        canonicalStatusDelivered: true,
      }),
      wakeMessageOnNotifyFailed: buildWorktreeOutcomeFollowupWake({
        sessionId: session.id,
        sessionName: session.name,
        outcomeLine,
        originThreadLine: this.deps.originThreadLine(session),
        detailLines: outcomeDetailLines,
        canonicalStatusDelivered: false,
      }),
    });
    return removed;
  }

  private async handleInitialAutoMergeConflict(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    allowedActions: AllowedWorktreeActions,
    mergeError?: string,
    mergeResult?: ReturnType<typeof mergeBranch>,
  ): Promise<void> {
    const warningLines = mergeResult ? buildMergeWarningLines(mergeResult) : [];
    const attemptsUsed = session.autoMergeConflictResolutionAttemptCount ?? 0;
    if (attemptsUsed >= 1) {
      this.markPendingDecision(session, {
        notes: ["auto_merge_conflict_retry_exhausted"],
        clearResolverSessionId: true,
      });
      this.notifyAutoMergeConflictEscalation(
        session,
        branchName,
        allowedActions.pr
          ? `The rebased branch still conflicts with \`${baseBranch}\`. Open a PR or resolve manually in ${worktreePath}.`
          : `The rebased branch still conflicts with \`${baseBranch}\`. Resolve manually in ${worktreePath}.`,
        allowedActions,
        warningLines,
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
        idempotencyKey: `worktree-merge-conflict-resolving:${session.id}:${branchName}:${resolverSession.id}`,
        userMessage: [
          `⚠️ [${session.name}] Auto-merge hit a rebase conflict. Started resolver session ${resolverSession.name} and will retry automatically if it succeeds.`,
          ...warningLines.map((line) => `⚠️ ${line}`),
        ].join("\n"),
      });
    } catch (err) {
      this.markPendingDecision(session, {
        notes: ["auto_merge_conflict_resolver_spawn_failed"],
      });
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-merge-conflict-spawn-failed",
        idempotencyKey: `worktree-merge-conflict-spawn-failed:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
        userMessage: [
          `❌ [${session.name}] Auto-merge hit a rebase conflict and failed to start the resolver: ${err instanceof Error ? err.message : String(err)}`,
          ...warningLines.map((line) => `⚠️ ${line}`),
        ].join("\n"),
        buttons: this.getPolicyAwareWorktreeDecisionButtons(
          session.id,
          allowedActions,
          {},
          [[this.deps.makeOpenPrButton(session.id)]],
        ),
      });
    }
  }

  private handleAutoMergeRetryFailure(
    session: Session,
    branchName: string,
    worktreePath: string,
    errorMsg: string,
    allowedActions: AllowedWorktreeActions,
  ): void {
    this.markPendingDecision(session, {
      notes: ["auto_merge_conflict_retry_failed"],
      clearResolverSessionId: true,
    });
    this.deps.dispatchSessionNotification(session, {
      label: "worktree-merge-error",
      idempotencyKey: `worktree-merge-error:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
      userMessage: [
        errorMsg,
        "",
        `Auto-merge retry did not complete after conflict resolution.`,
        `Branch \`${branchName}\` was preserved for manual follow-up in ${worktreePath}.`,
      ].join("\n"),
      buttons: this.getPolicyAwareWorktreeDecisionButtons(
        session.id,
        allowedActions,
        {},
        [[this.deps.makeOpenPrButton(session.id)]],
      ),
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
    allowedActions: AllowedWorktreeActions = { merge: true, pr: true },
  ): Promise<boolean> {
    if (this.deps.isAlreadyMerged(sessionRef)) return false;
    if (session.autoMergeResolverSessionId) return false;

    let worktreeRemoved = false;

    await this.deps.enqueueMerge(
      repoDir,
      async () => {
        if (this.deps.isAlreadyMerged(sessionRef)) return;

        const mergeResult = this.deps.mergeBranch(repoDir, branchName, baseBranch, "merge", worktreePath);

        if (mergeResult.success) {
          worktreeRemoved = this.handleAutoMergeSuccess(
            session,
            repoDir,
            worktreePath,
            branchName,
            baseBranch,
            diffSummary,
            mergeResult,
          );
          return;
        }

        if (mergeResult.rebaseConflict) {
          await this.handleInitialAutoMergeConflict(
            session,
            repoDir,
            worktreePath,
            branchName,
            baseBranch,
            allowedActions,
            mergeResult.error,
            mergeResult,
          );
          return;
        }

        const errorMsg = appendMergeWarnings(mergeResult.dirtyError
          ? `❌ [${session.name}] Merge blocked: ${mergeResult.error}`
          : `❌ [${session.name}] Merge failed: ${mergeResult.error ?? "unknown error"}`, mergeResult);
        const retryFailedAfterConflictResolution =
          session.worktreeState === "merge_conflict_resolving"
          || session.worktreeLifecycle?.state === "merge_conflict_resolving";
        if (retryFailedAfterConflictResolution) {
          this.handleAutoMergeRetryFailure(session, branchName, worktreePath, errorMsg, allowedActions);
          return;
        }
        this.deps.dispatchSessionNotification(session, {
          label: "worktree-merge-error",
          idempotencyKey: `worktree-merge-error:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
          userMessage: errorMsg,
        });
      },
      () => {
        this.deps.dispatchSessionNotification(session, {
          label: "worktree-merge-queued",
          idempotencyKey: `worktree-merge-queued:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
          userMessage: `🕐 [${session.name}] Merge queued — another merge for this repo is in progress. Will notify when complete.`,
        });
      },
    );
    return worktreeRemoved;
  }

  private async handleAutoPrStrategy(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    allowedActions: AllowedWorktreeActions = { merge: true, pr: true },
  ): Promise<WorktreeStrategyResult> {
    const representedRelease = this.releaseIfRepresentedByTargetPrBranch(session, repoDir, worktreePath, branchName, baseBranch);
    if (representedRelease) return representedRelease;

    this.updatePersistedSessionFor(session, {
      lifecycle: "terminal",
      worktreeState: "pr_in_progress",
    });
    const result = await this.deps.runAutoPr(session, baseBranch);
    if (!result.success) {
      const releasedAfterFailure = this.releaseIfRepresentedByTargetPrBranch(session, repoDir, worktreePath, branchName, baseBranch);
      if (releasedAfterFailure) return releasedAfterFailure;
      this.markPendingDecision(session);
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-auto-pr-failed",
        idempotencyKey: `worktree-auto-pr-failed:${session.id}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
        userMessage: `⚠️ [${session.name}] Auto-PR did not complete. The worktree is preserved for an explicit merge or PR decision.`,
        buttons: this.getPolicyAwareWorktreeDecisionButtons(session.id, allowedActions),
      });
    }
    return { notificationSent: true, worktreeRemoved: false };
  }

  private getPrStatusForUrl(repoDir: string, prUrl: string, targetRepo?: string): PRStatus {
    return this.deps.getPrStatusForUrl?.(repoDir, prUrl, targetRepo)
      ?? syncWorktreePRByUrl(repoDir, prUrl, targetRepo);
  }

  private releaseIfRepresentedByTargetPrBranch(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): WorktreeStrategyResult | undefined {
    if (listDirtyWorktreeEntries(worktreePath).length > 0) return undefined;

    const targetPrStatus = this.resolveExistingTargetPr(session, repoDir, branchName, baseBranch);
    const targetBranch = targetPrStatus?.headRefName;
    if (!targetBranch || targetBranch === branchName || targetBranch === baseBranch) return undefined;
    const authoritativeTargetRef = fetchRemoteBranchRef(repoDir, targetBranch) ?? targetBranch;
    const representedByTargetPrBranch = Boolean(
      (targetPrStatus?.state === "open" || targetPrStatus?.state === "merged")
      && targetPrStatus?.baseRefName === baseBranch
      && isBranchAncestorOfBase(repoDir, branchName, authoritativeTargetRef)
    );
    if (!representedByTargetPrBranch) return undefined;

    const removed = usesNativeBackendWorktree(session)
      ? true
      : removeWorktree(repoDir, worktreePath);
    if (!removed) {
      this.markPendingDecision(session, {
        notes: [`represented_by_branch:${targetBranch}`, "represented_worktree_cleanup_failed"],
      });
      return { notificationSent: false, worktreeRemoved: false };
    }

    session.worktreePath = undefined;
    session.worktreePrUrl = targetPrStatus.url;
    session.worktreePrNumber = targetPrStatus.number;
    session.worktreePrTargetRepo = resolveTargetRepo(repoDir, session.worktreePrTargetRepo);
    this.updatePersistedSessionFor(session, {
      worktreePath: undefined,
      worktreePrUrl: targetPrStatus.url,
      worktreePrNumber: targetPrStatus.number,
      worktreePrTargetRepo: session.worktreePrTargetRepo,
      worktreeRemoteOutcome: "pr-updated",
    });
    deleteBranch(repoDir, branchName);
    this.markReleased(session, [`released_by_branch:${targetBranch}`]);
    return { notificationSent: false, worktreeRemoved: removed };
  }
}
