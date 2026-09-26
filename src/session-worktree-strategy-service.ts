import type { Session } from "./session";
import { describeHookPathChanges, listHookPathChanges } from "./git-hooks";
import type { NotificationButton } from "./session-interactions";
import type { PersistedSessionInfo } from "./types";
import type { RepoPolicyResolution } from "./repo-policy";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { PRStatus } from "./worktree-pr";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import { SessionWorktreeMessageService } from "./session-worktree-message-service";
import { getPersistedMutationRefs, getPrimarySessionLookupRef } from "./session-backend-ref";
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
  describeMergeType,
  fetchRemoteBranchRef,
  resolveTargetRepo,
  syncWorktreePR,
  syncWorktreePRByUrl,
  worktreeExists,
} from "./worktree";
import { createLogger } from "./logger";

const log = createLogger("session-worktree-strategy-service");

export type WorktreeStrategyResult = {
  notificationSent: boolean;
  worktreeRemoved: boolean;
};

type DiffSummary = NonNullable<Awaited<ReturnType<typeof getDiffSummary>>>;
type SpawnedResolverSession = Pick<Session, "id" | "name">;
type AllowedWorktreeActions = { merge: boolean; pr: boolean };
type Awaitable<T> = T | Promise<T>;

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
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => Awaitable<string | undefined>;
      getWorktreeCompletionState: (
        repoDir: string,
        worktreePath: string,
        branchName: string,
        baseBranch: string,
      ) => WorktreeCompletionState | Promise<WorktreeCompletionState>;
      updatePersistedSession: (ref: string, patch: Partial<PersistedSessionInfo>) => boolean;
      getPersistedSession?: (ref: string) => PersistedSessionInfo | undefined;
      dispatchSessionNotification: (session: Session, request: SessionNotificationRequest) => void;
      getOutputPreview: (session: Session, maxChars?: number) => string;
      originThreadLine: (session: Session) => string;
      getWorktreeDecisionButtons: (sessionId: string) => Awaitable<NotificationButton[][] | undefined>;
      getPolicyAwareWorktreeDecisionButtons?: (
        sessionId: string,
        options: { allowDelegate?: boolean },
        allowedActions: AllowedWorktreeActions,
      ) => Awaitable<NotificationButton[][] | undefined>;
      makeOpenPrButton: (sessionId: string) => NotificationButton;
      /** Commit changes (resume with a commit instruction) / View output / Discard for a dirty worktree (N44). */
      makeDirtyWorktreeButtons?: (sessionId: string) => NotificationButton[][];
      isPrAvailable?: (repoDir: string) => Awaitable<boolean>;
      hasOpenPrForBranch?: (repoDir: string, branchName: string, targetRepo?: string) => Awaitable<boolean>;
      getPrStatusForBranch?: (repoDir: string, branchName: string, targetRepo?: string) => Awaitable<PRStatus>;
      getPrStatusForUrl?: (repoDir: string, prUrl: string, targetRepo?: string) => Awaitable<PRStatus>;
      fetchRemoteBranch?: (repoDir: string, branchName: string) => Awaitable<string | undefined>;
      resolveRepoPolicy?: (repoDir: string) => Awaitable<RepoPolicyResolution>;
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
      /** Changed hook / worktree-setup files on the branch (default: `listHookPathChanges`). */
      listHookPathChanges?: (repoDir: string, branchName: string, baseBranch: string) => Awaitable<string[]>;
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

  private async notifyAutoMergeConflictEscalation(
    session: Session,
    branchName: string,
    reason: string,
    allowedActions: AllowedWorktreeActions,
    warningLines: string[] = [],
  ): Promise<void> {
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
      buttons: await this.getPolicyAwareWorktreeDecisionButtons(
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
      return await this.handleDirtyUncommittedCompletion(
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
      );
    }

    if (action.kind === "merged") {
      const removed = await removeWorktree(action.repoDir, action.worktreePath);
      await deleteBranch(action.repoDir, action.branchName);
      this.markMerged(session);
      return { notificationSent: false, worktreeRemoved: removed };
    }

    if (action.kind === "released") {
      const removed = await removeWorktree(action.repoDir, action.worktreePath);
      await deleteBranch(action.repoDir, action.branchName);
      this.markReleased(session, action.reasons);
      return { notificationSent: false, worktreeRemoved: removed };
    }

    // Hook or worktree-setup changes run code on later git operations: never
    // merge or open a PR for them automatically. The user decides, with the
    // changed files named in the prompt.
    const hookWarning = await this.describeHookChanges(action.repoDir, action.branchName, action.baseBranch);
    if (hookWarning) {
      if (action.strategy === "delegate" && !action.policyBlocked) {
        return this.handleDelegateStrategy(session, action.branchName, action.baseBranch, action.diffSummary, action.allowedActions, action.policyReason, hookWarning);
      }
      return await this.handleAskStrategy(session, action.branchName, action.baseBranch, action.diffSummary, action.allowedActions, action.policyReason, hookWarning);
    }

    if (action.policyBlocked) {
      if (await this.shouldUpdateExistingOpenPr(session, action.repoDir, action.branchName, action.baseBranch)) {
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
        buttons: await this.getPolicyAwareWorktreeDecisionButtons(session.id, action.allowedActions, { allowDelegate: true }),
      });
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (action.strategy === "ask") {
      if (await this.shouldUpdateExistingOpenPr(session, action.repoDir, action.branchName, action.baseBranch)) {
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
  ): Promise<WorktreeStrategyResult> {
    if (await this.hasCurrentlyOpenPrForBranch(session, repoDir, branchName)) {
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
    const removed = await removeWorktree(repoDir, worktreePath);
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

  private async hasCurrentlyOpenPrForBranch(session: Session, repoDir: string, branchName: string): Promise<boolean> {
    return (await this.deps.hasOpenPrForBranch?.(repoDir, branchName, session.worktreePrTargetRepo)) === true;
  }

  private getDeliveredRemoteOutcome(session: Session): "pr-updated" | "pr-opened" | undefined {
    const persistedWithRemoteOutcome = getPersistedMutationRefs(session)
      .map((ref) => this.deps.getPersistedSession?.(ref))
      .find((entry): entry is PersistedSessionInfo & { worktreeRemoteOutcome: "pr-updated" | "pr-opened" } => (
        entry?.worktreeRemoteOutcome === "pr-updated" || entry?.worktreeRemoteOutcome === "pr-opened"
      ));
    return persistedWithRemoteOutcome?.worktreeRemoteOutcome;
  }

  private async resolveExistingTargetPr(session: Session, repoDir: string, branchName: string, baseBranch: string): Promise<PRStatus | undefined> {
    const targetRepo = await resolveTargetRepo(repoDir, session.worktreePrTargetRepo);
    if (session.worktreePrUrl) {
      const recorded = await this.getPrStatusForUrl(repoDir, session.worktreePrUrl, targetRepo);
      if (recorded.exists && recorded.baseRefName === baseBranch) return recorded;
    }

    const parentBranch = session.worktreeParentBranch;
    if (!parentBranch || (await getBranchName(repoDir)) !== parentBranch) return undefined;
    if (parentBranch === branchName || parentBranch === baseBranch) return undefined;
    const discovered = (await this.deps.getPrStatusForBranch?.(repoDir, parentBranch, targetRepo))
      ?? await syncWorktreePR(repoDir, parentBranch, targetRepo);
    return discovered.exists
      && discovered.state === "open"
      && discovered.headRefName === parentBranch
      && (!discovered.baseRefName || discovered.baseRefName === baseBranch)
      ? discovered
      : undefined;
  }

  private async shouldUpdateExistingOpenPr(
    session: Session,
    repoDir: string,
    branchName: string,
    baseBranch: string,
  ): Promise<boolean> {
    return session.worktreeStrategy === "auto-pr"
      && (
        await this.hasCurrentlyOpenPrForBranch(session, repoDir, branchName)
        || (await this.resolveExistingTargetPr(session, repoDir, branchName, baseBranch))?.state === "open"
      );
  }

  /** The hook-change warning for a branch, or undefined when it changes no hook locations. */
  private async describeHookChanges(repoDir: string, branchName: string, baseBranch: string): Promise<string | undefined> {
    try {
      const list = this.deps.listHookPathChanges ?? listHookPathChanges;
      return describeHookPathChanges(await list(repoDir, branchName, baseBranch));
    } catch (err) {
      log.warn(`[worktree] Could not check ${branchName} for hook changes: ${err instanceof Error ? err.message : String(err)}`);
      // Unknown is treated as changed: a person decides.
      return "⚠️ Could not check this branch for git hook or worktree setup changes, so merging or opening a PR needs your confirmation.";
    }
  }

  private async handleAskStrategy(
    session: Session,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
    allowedActions: AllowedWorktreeActions,
    policyReason?: string,
    hookWarning?: string,
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
      hookWarning,
      buttons: await this.getPolicyAwareWorktreeDecisionButtons(session.id, allowedActions),
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
    hookWarning?: string,
  ): WorktreeStrategyResult {
    this.deps.dispatchSessionNotification(session, this.deps.worktreeMessages.buildDelegateNotification({
      session,
      branchName,
      baseBranch,
      diffSummary,
      policyReason,
      hookWarning,
      allowedActions,
      originThreadLine: this.deps.originThreadLine(session),
    }));
    this.markPendingDecision(session);
    return { notificationSent: true, worktreeRemoved: false };
  }

  private async getPolicyAwareWorktreeDecisionButtons(
    sessionId: string,
    allowedActions: AllowedWorktreeActions,
    options: { allowDelegate?: boolean } = {},
    fallbackButtons?: NotificationButton[][],
  ): Promise<NotificationButton[][] | undefined> {
    if (this.deps.getPolicyAwareWorktreeDecisionButtons) {
      return this.deps.getPolicyAwareWorktreeDecisionButtons(sessionId, options, allowedActions);
    }
    if (fallbackButtons && allowedActions.pr) return fallbackButtons;
    if (fallbackButtons && !allowedActions.pr && !allowedActions.merge) return undefined;
    return this.deps.getWorktreeDecisionButtons(sessionId);
  }

  private async handleDirtyUncommittedCompletion(
    session: Session,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<WorktreeStrategyResult> {
    this.markPendingDecision(session, {
      notes: ["dirty_uncommitted_completion"],
    });
    const dirtyEntries = await listDirtyWorktreeEntries(worktreePath);
    const dirtyPreview = dirtyEntries.slice(0, 20).map((entry) => `- ${entry}`);
    const moreLine = dirtyEntries.length > 20 ? [`- ...and ${dirtyEntries.length - 20} more`] : [];
    this.deps.dispatchSessionNotification(session, {
      label: "worktree-dirty-uncommitted",
      idempotencyKey: `worktree-dirty-uncommitted:${session.id}:${branchName}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
      userMessage: [
        `⚠️ [${session.name}] Finished with uncommitted changes and no commits on \`${branchName}\`, so there is nothing to merge yet.`,
        `Worktree: ${worktreePath}`,
        ...(dirtyPreview.length > 0 ? [``, ...dirtyPreview, ...moreLine] : []),
        ``,
        `Commit changes resumes the session to commit its work. Discard deletes the branch and these changes for good.`,
      ].join("\n"),
      notifyUser: "always",
      buttons: this.deps.makeDirtyWorktreeButtons?.(session.id),
    });
    return { notificationSent: true, worktreeRemoved: false };
  }

  private async handleAutoMergeSuccess(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
    mergeResult: Awaited<ReturnType<typeof mergeBranch>>,
  ): Promise<boolean> {
    const removed = !worktreeExists(worktreePath)
      || await removeWorktree(repoDir, worktreePath);
    if (removed) {
      session.worktreePath = undefined;
      this.updatePersistedSessionFor(session, { worktreePath: undefined });
      await deleteBranch(repoDir, branchName);
    }
    this.markMerged(session);

    const outcomeLine = formatWorktreeOutcomeLine({
      kind: "merge",
      sessionName: session.name,
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
      `Merge type: ${describeMergeType(mergeResult)}.`,
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
    mergeResult?: Awaited<ReturnType<typeof mergeBranch>>,
  ): Promise<void> {
    const warningLines = mergeResult ? buildMergeWarningLines(mergeResult) : [];
    const attemptsUsed = session.autoMergeConflictResolutionAttemptCount ?? 0;
    if (attemptsUsed >= 1) {
      this.markPendingDecision(session, {
        notes: ["auto_merge_conflict_retry_exhausted"],
        clearResolverSessionId: true,
      });
      await this.notifyAutoMergeConflictEscalation(
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
        buttons: await this.getPolicyAwareWorktreeDecisionButtons(
          session.id,
          allowedActions,
          {},
          [[this.deps.makeOpenPrButton(session.id)]],
        ),
      });
    }
  }

  private async handleAutoMergeRetryFailure(
    session: Session,
    branchName: string,
    worktreePath: string,
    errorMsg: string,
    allowedActions: AllowedWorktreeActions,
  ): Promise<void> {
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
      buttons: await this.getPolicyAwareWorktreeDecisionButtons(
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

        const mergeResult = await this.deps.mergeBranch(repoDir, branchName, baseBranch, "merge", worktreePath);

        if (mergeResult.success) {
          worktreeRemoved = await this.handleAutoMergeSuccess(
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
          await this.handleAutoMergeRetryFailure(session, branchName, worktreePath, errorMsg, allowedActions);
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
    const representedRelease = await this.releaseIfRepresentedByTargetPrBranch(session, repoDir, worktreePath, branchName, baseBranch);
    if (representedRelease) return representedRelease;

    this.updatePersistedSessionFor(session, {
      lifecycle: "terminal",
      worktreeState: "pr_in_progress",
    });
    const result = await this.deps.runAutoPr(session, baseBranch);
    if (!result.success) {
      const releasedAfterFailure = await this.releaseIfRepresentedByTargetPrBranch(session, repoDir, worktreePath, branchName, baseBranch);
      if (releasedAfterFailure) return releasedAfterFailure;
      this.markPendingDecision(session);
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-auto-pr-failed",
        idempotencyKey: `worktree-auto-pr-failed:${session.id}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
        userMessage: `⚠️ [${session.name}] Auto-PR did not complete. The worktree is preserved for an explicit merge or PR decision.`,
        buttons: await this.getPolicyAwareWorktreeDecisionButtons(session.id, allowedActions),
      });
    }
    return { notificationSent: true, worktreeRemoved: false };
  }

  private async getPrStatusForUrl(repoDir: string, prUrl: string, targetRepo?: string): Promise<PRStatus> {
    return (await this.deps.getPrStatusForUrl?.(repoDir, prUrl, targetRepo))
      ?? await syncWorktreePRByUrl(repoDir, prUrl, targetRepo);
  }

  private async releaseIfRepresentedByTargetPrBranch(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<WorktreeStrategyResult | undefined> {
    if ((await listDirtyWorktreeEntries(worktreePath)).length > 0) return undefined;

    const targetPrStatus = await this.resolveExistingTargetPr(session, repoDir, branchName, baseBranch);
    const targetBranch = targetPrStatus?.headRefName;
    if (!targetBranch || targetBranch === branchName || targetBranch === baseBranch) return undefined;
    const authoritativeTargetRef = this.deps.fetchRemoteBranch
      ? await this.deps.fetchRemoteBranch(repoDir, targetBranch)
      : await fetchRemoteBranchRef(repoDir, targetBranch);
    if (!authoritativeTargetRef) return undefined;
    const representedByTargetPrBranch = Boolean(
      (targetPrStatus?.state === "open" || targetPrStatus?.state === "merged")
      && targetPrStatus?.baseRefName === baseBranch
      && await isBranchAncestorOfBase(repoDir, branchName, authoritativeTargetRef)
    );
    if (!representedByTargetPrBranch) return undefined;

    const removed = await removeWorktree(repoDir, worktreePath);
    if (!removed) {
      this.markPendingDecision(session, {
        notes: [`represented_by_branch:${targetBranch}`, "represented_worktree_cleanup_failed"],
      });
      return { notificationSent: false, worktreeRemoved: false };
    }

    session.worktreePath = undefined;
    session.worktreePrUrl = targetPrStatus.url;
    session.worktreePrNumber = targetPrStatus.number;
    session.worktreePrTargetRepo = await resolveTargetRepo(repoDir, session.worktreePrTargetRepo);
    this.updatePersistedSessionFor(session, {
      worktreePath: undefined,
      worktreePrUrl: targetPrStatus.url,
      worktreePrNumber: targetPrStatus.number,
      worktreePrTargetRepo: session.worktreePrTargetRepo,
      worktreeRemoteOutcome: "pr-updated",
    });
    await deleteBranch(repoDir, branchName);
    this.markReleased(session, [`released_by_branch:${targetBranch}`]);
    return { notificationSent: false, worktreeRemoved: removed };
  }
}
