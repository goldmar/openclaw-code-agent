import type { Session } from "./session";
import { executionCycle, hasVerifiedTaskOutcome, isTaskOutcomeCurrent } from "./session-task-outcome";
import { describeHookPathChanges, HOOK_CHECK_UNAVAILABLE_WARNING, listHookPathChanges } from "./git-hooks";
import type { NotificationButton } from "./session-interactions";
import type { PersistedSessionInfo, PersistedWorktreeLifecycle, SessionStatus } from "./types";
import type { RepoPolicyResolution } from "./repo-policy";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { PRStatus } from "./worktree-pr";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import { NO_CHANGES_AFTER_RESOLUTION, SessionWorktreeMessageService } from "./session-worktree-message-service";
import { getPersistedMutationRefs, getPrimarySessionLookupRef } from "./session-backend-ref";
import { owningPrLinkPatch, type OwningPrResolution } from "./worktree-owning-pr";
import { SessionWorktreeActionService } from "./session-worktree-action-service";
import {
  buildMergeConflictResolvingPatch,
  buildMergedPatch,
  buildPendingDecisionPatch,
  buildPrOpenPatch,
} from "./worktree-session-patches";
import { buildWorktreeOutcomeFollowupWake } from "./session-notification-builder";
import {
  buildWorktreeDecisionWorkSummary,
  type WorktreeDecisionSummaryProvider,
} from "./worktree-decision-summary";
import {
  removeWorktree,
  getDiffSummary,
  getCommitsNotInPr,
  getCommitsAheadCount,
  resolveLandingBaseBranch,
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
  resolvePrBaseRemote,
  resolveTargetRepo,
  syncWorktreePR,
  syncWorktreePRByUrl,
  worktreeExists,
} from "./worktree";
import { createLogger } from "./logger";
import { appendSessionStatsSuffix, sessionStats } from "./session-notification-stats";

const log = createLogger("session-worktree-strategy-service");

export type WorktreeStrategyResult = {
  notificationSent: boolean;
  worktreeRemoved: boolean;
  /**
   * Compatibility hint for a wake-only strategy outcome; the lifecycle still
   * requires current task evidence before any task success notice.
   */
  userCompletionNoticeOwed?: boolean;
  /** One extra line for the generic `✅ Completed` notice (nobody is prompted, yet something is left to do). */
  completionNote?: string;
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

/** Integration attention is separate from the task's reviewed success notice. */
function completedAttention(session: Session, problem: string, retry = false, detail: Array<string | undefined> = []): string {
  return [
    retry
      ? `⚠️ [${session.name}] ${problem.charAt(0).toUpperCase()}${problem.slice(1)}`
      : appendSessionStatsSuffix(`⚠️ [${session.name}] Integration needs attention — ${problem}`, sessionStats(session)),
    ...detail.filter(Boolean),
  ].join("\n");
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
      resolveOwningPr?: (session: Session, repoDir: string) => Promise<OwningPrResolution>;
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
      hasOpenPrForBranch?: (repoDir: string, branchName: string, targetRepo?: string, pushRemote?: string) => Awaitable<boolean>;
      getPrStatusForBranch?: (repoDir: string, branchName: string, targetRepo?: string, baseBranch?: string, pushRemote?: string) => Awaitable<PRStatus>;
      getPrStatusForUrl?: (repoDir: string, prUrl: string, targetRepo?: string, pushRemote?: string) => Awaitable<PRStatus>;
      fetchRemoteBranch?: (repoDir: string, branchName: string, remote?: string) => Awaitable<string | undefined>;
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
      /** `retry`: after this cycle's conflict resolver, so a PR outcome is a milestone, not the `✅`. */
      runAutoPr: (session: Session, baseBranch: string, retry?: boolean) => Promise<{ success: boolean; notificationSent: boolean; decisionRequested?: boolean; error?: string }>;
      /**
       * Execution status of the session that currently owns this OCA id (the
       * live session first, then its stored row). A merge can wait in the
       * repository queue while the id is resumed; the captured object then
       * stays `completed`. Default: the captured session's status.
       */
      getCurrentSessionStatus?: (session: Session) => SessionStatus | undefined;
      /** Changed hook / worktree-setup files on the branch (default: `listHookPathChanges`). */
      listHookPathChanges?: (repoDir: string, branchName: string, baseBranch: string, remote?: string, preferRemoteBase?: boolean) => Awaitable<string[]>;
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

  private isCurrentTask(session: Session): boolean {
    if (!hasVerifiedTaskOutcome(session)
      || (this.deps.getCurrentSessionStatus?.(session) ?? session.status) !== "completed") return false;
    const current = this.deps.getPersistedSession?.(session.id);
    return !current || (executionCycle(current) === executionCycle(session)
      && hasVerifiedTaskOutcome(current));
  }

  private async isReady(session: Session): Promise<boolean> {
    return this.isCurrentTask(session) && await isTaskOutcomeCurrent(session) && this.isCurrentTask(session);
  }

  private admissionTicket(session: Session): () => boolean {
    const report = session.taskOutcome;
    const cycle = executionCycle(session);
    return () => session.taskOutcome === report && executionCycle(session) === cycle && this.isCurrentTask(session);
  }

  private removalOptions(session: Session, admitted: () => boolean) {
    return { shouldRemove: async () => admitted() && await this.isReady(session) && admitted() };
  }

  private dispatchOutcomeNotification(session: Session, request: SessionNotificationRequest): void {
    const report = session.taskOutcome;
    const shouldDispatch = request.shouldDispatch;
    this.deps.dispatchSessionNotification(session, {
      ...request,
      shouldDispatch: () => session.taskOutcome === report && this.isCurrentTask(session)
        && shouldDispatch?.() !== false,
    });
  }

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
    this.dispatchOutcomeNotification(session, {
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

  /**
   * `retryAfterConflict`: integration follow-through after a reviewed resolver
   * outcome. Task success is reported separately and is never deferred here.
   */
  async handleWorktreeStrategy(
    session: Session,
    options: { retryAfterConflict?: boolean } = {},
  ): Promise<WorktreeStrategyResult> {
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
    const retry = options.retryAfterConflict === true;
    let owningSourceBranch: string | undefined;
    if (session.status === "completed" && this.deps.shouldRunWorktreeStrategy(session) && session.worktreeBranch && session.worktreePath && this.deps.resolveOwningPr) {
      const repoDir = await this.deps.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
      const owner = repoDir ? await this.deps.resolveOwningPr(session, repoDir) : undefined;
      if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
      if (owner?.kind === "blocked") {
        this.dispatchOutcomeNotification(session, {
          label: "worktree-owning-pr-blocked",
          userMessage: completedAttention(session, "owning PR could not be verified", retry, [owner.reason, "The worktree is retained for inspection."]),
        });
        return { notificationSent: true, worktreeRemoved: false };
      }
      if (owner?.kind === "existing" && owner.status.state === "open"
        && (owner.discovered || owner.status.headRefName !== session.worktreeBranch)) {
        this.updatePersistedSessionFor(session, owningPrLinkPatch(owner));
        owningSourceBranch = owner.sourceBranch;
        const compared = await getCommitsNotInPr(repoDir!, owner.sourceBranch, owner.status, owner.pushRemote);
        const dirty = (await listDirtyWorktreeEntries(session.worktreePath)).length > 0;
        if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
        if (dirty) {
          if (!session.worktreeStrategy || session.worktreeStrategy === "manual" || session.worktreeStrategy === "off") {
            return { notificationSent: false, worktreeRemoved: false, completionNote: "⚠️ Uncommitted changes remain in the retained PR worktree." };
          }
          const base = await resolveLandingBaseBranch(session, repoDir!);
          return this.handleDirtyUncommittedCompletion(session, session.worktreePath, session.worktreeBranch, base,
            (await getCommitsAheadCount(repoDir!, session.worktreeBranch, base)) === 0, retry);
        }
        if (compared?.count === 0 && !dirty) {
          this.updatePersistedSessionFor(session, { ...buildPrOpenPatch(session, {
            prUrl: owner.status.url!, prNumber: owner.status.number, baseBranch: owner.status.baseRefName,
          }), deferredCompletionCycle: undefined });
          this.dispatchOutcomeNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
            session, cleanupSucceeded: true, worktreePath: session.worktreePath, worktreeBranch: session.worktreeBranch,
            preview: this.deps.getOutputPreview(session), originThreadLine: this.deps.originThreadLine(session),
            preservedSummary: "existing PR worktree preserved until merge", prUrl: owner.status.url, retry,
          }));
          return { notificationSent: true, worktreeRemoved: false };
        }
        if (!compared) {
          this.dispatchOutcomeNotification(session, {
            label: "worktree-owning-pr-head-unknown",
            userMessage: completedAttention(session, "owning PR head could not be compared", retry, ["The worktree is retained; no landing action was offered."]),
          });
          return { notificationSent: true, worktreeRemoved: false };
        }
        // Let the existing planner count unpushed work and apply ask/delegate/manual/auto-pr policy.
        this.updatePersistedSessionFor(session, { worktreeState: "pr_open" });
      }
    }
    const action = await this.actions.plan(session, { sourceBranch: owningSourceBranch });
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };

    if (action.kind === "skip") {
      return action.result;
    }

    if (action.kind === "notify") {
      this.dispatchOutcomeNotification(session, {
        label: action.label,
        idempotencyKey: [
          "worktree-action",
          session.id,
          action.label,
          session.startedAt,
          session.worktreeBranch ?? "unknown",
          session.worktreePath ?? "unknown",
        ].join(":"),
        userMessage: completedAttention(session, action.problem, retry, action.detail),
      });
      return { notificationSent: true, worktreeRemoved: false };
    }

    if (action.kind === "dirty-uncommitted") {
      return await this.handleDirtyUncommittedCompletion(
        session,
        action.worktreePath,
        action.branchName,
        action.baseBranch,
        action.noCommits,
        retry,
      );
    }

    if (action.kind === "no-change") {
      return this.handleNoChange(
        session,
        action.repoDir,
        action.worktreePath,
        action.branchName,
        retry,
      );
    }

    if (action.kind === "merged" || action.kind === "released") {
      const admitted = this.admissionTicket(session);
      if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
      const removed = await removeWorktree(action.repoDir, action.worktreePath, this.removalOptions(session, admitted));
      if (!admitted()) return { notificationSent: false, worktreeRemoved: removed };
      if (removed) await deleteBranch(action.repoDir, action.branchName, admitted);
      if (!admitted()) return { notificationSent: false, worktreeRemoved: removed };
      if (action.kind === "merged") this.markMerged(session);
      else this.markReleased(session, action.reasons);
      if (!retry) return { notificationSent: false, worktreeRemoved: removed };
      // The user was told the merge "will retry automatically": report how it ended.
      this.dispatchOutcomeNotification(session, {
        label: `worktree-retry-${action.kind}`,
        idempotencyKey: `worktree-retry-${action.kind}:${session.id}:${action.branchName}:${buildWorktreeCycleKey(session)}`,
        userMessage: appendSessionStatsSuffix(
          action.kind === "merged"
            ? formatWorktreeOutcomeLine({ kind: "merge", sessionName: session.name, branch: action.branchName, base: action.baseBranch })
            : `ℹ️ [${session.name}] ${NO_CHANGES_AFTER_RESOLUTION}`,
          sessionStats(session),
        ),
        notifyUser: "always",
      });
      return { notificationSent: true, worktreeRemoved: removed };
    }

    if (action.reopenedFrom === "merged" || action.reopenedFrom === "released") {
      // New commits after the merge: the branch is open again, so the
      // strategies, merge tools and buttons must not answer "already merged".
      // Every "merged" record goes, the lifecycle state included (it alone
      // makes `isAlreadyMerged` true, and auto-merge would return without
      // merging the new commits).
      const reopenedLifecycle: PersistedWorktreeLifecycle = {
        state: "provisioned",
        updatedAt: new Date().toISOString(),
        baseBranch: session.worktreeBaseBranch,
        targetRepo: session.worktreePrTargetRepo,
        pushRemote: session.worktreePushRemote,
        notes: [`reopened_after:${action.reopenedFrom}`],
      };
      const clearMergedDisposition = session.worktreeDisposition === "merged";
      session.worktreeMerged = undefined;
      session.worktreeMergedAt = undefined;
      session.worktreeLifecycle = reopenedLifecycle;
      if (clearMergedDisposition) session.worktreeDisposition = undefined;
      this.updatePersistedSessionFor(session, {
        worktreeMerged: undefined,
        worktreeMergedAt: undefined,
        worktreeState: "provisioned",
        worktreeLifecycle: reopenedLifecycle,
        ...(clearMergedDisposition ? { worktreeDisposition: undefined } : {}),
      });
    }
    const openPrUrl = action.reopenedFrom === "pr_open" ? session.worktreePrUrl : undefined;

    // Hook or worktree-setup changes run code on later git operations: never
    // merge or open a PR for them automatically. The user decides, with the
    // changed files named in the prompt.
    const hookWarning = await this.describeHookChanges(action.repoDir, action.branchName, action.baseBranch,
      action.strategy === "auto-pr" ? session.worktreePushRemote : undefined, action.strategy === "auto-pr" ? await resolveTargetRepo(action.repoDir, session.worktreePrTargetRepo) : undefined);
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
    if (hookWarning) {
      if (action.strategy === "delegate" && !action.policyBlocked) {
        return this.handleDelegateStrategy(session, action.branchName, action.baseBranch, action.diffSummary, action.allowedActions, action.policyReason, hookWarning, openPrUrl);
      }
      return await this.handleAskStrategy(session, action.branchName, action.baseBranch, action.diffSummary, action.allowedActions, action.policyReason, hookWarning, retry, Boolean(openPrUrl));
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
          retry,
        );
      }
      if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
      this.markPendingDecision(session, { notes: action.policyReason ? [action.policyReason] : undefined });
      this.dispatchOutcomeNotification(session, {
        label: "worktree-policy-blocked",
        idempotencyKey: `worktree-policy-blocked:${session.id}:${action.branchName}:${action.baseBranch}:${buildWorktreeCycleKey(session)}`,
        // The reason keeps its own wording on the second line (no case change).
        userMessage: completedAttention(session, "blocked by repo policy", retry, [action.policyReason ?? "Repo policy blocked automatic follow-through."]),
        buttons: await this.getPolicyAwareWorktreeDecisionButtons(session.id, action.allowedActions, { allowDelegate: true }),
      });
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (action.strategy === "ask") {
      // Reachable: the planner downgrades a requested `auto-pr` to `ask` (for
      // example under a `never-pr` policy, where it cannot see an open PR), and
      // `shouldUpdateExistingOpenPr` reads the session's requested strategy.
      if (await this.shouldUpdateExistingOpenPr(session, action.repoDir, action.branchName, action.baseBranch)) {
        return this.handleAutoPrStrategy(
          session,
          action.repoDir,
          action.worktreePath,
          action.branchName,
          action.baseBranch,
          action.allowedActions,
          retry,
        );
      }
      return await this.handleAskStrategy(session, action.branchName, action.baseBranch, action.diffSummary, action.allowedActions, action.policyReason, undefined, retry, Boolean(openPrUrl));
    }
    if (action.strategy === "delegate") {
      return this.handleDelegateStrategy(session, action.branchName, action.baseBranch, action.diffSummary, action.allowedActions, action.policyReason, undefined, openPrUrl);
    }
    if (action.strategy === "auto-merge") {
      return this.handleAutoMergeStrategy(
        session,
        action.repoDir,
        action.worktreePath,
        action.branchName,
        action.baseBranch,
        action.diffSummary,
        action.sessionRef,
        action.allowedActions,
        retry,
      );
    }
    if (action.strategy === "auto-pr") {
      return this.handleAutoPrStrategy(
        session,
        action.repoDir,
        action.worktreePath,
        action.branchName,
        action.baseBranch,
        action.allowedActions,
        retry,
      );
    }
    return { notificationSent: false, worktreeRemoved: false };
  }

  private async handleNoChange(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    retry = false,
  ): Promise<WorktreeStrategyResult> {
    const admitted = this.admissionTicket(session);
    if (await this.hasCurrentlyOpenPrForBranch(session, repoDir, branchName)) {
      if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
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
      this.dispatchOutcomeNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        cleanupSucceeded: true,
        worktreePath,
        worktreeBranch: branchName,
        preview: this.deps.getOutputPreview(session),
        originThreadLine: this.deps.originThreadLine(session),
        preservedSummary: "existing PR worktree preserved until merge",
        prUrl: session.worktreePrUrl,
        retry,
      }));
      return { notificationSent: true, worktreeRemoved: false };
    }

    const remoteOutcome = this.getDeliveredRemoteOutcome(session);
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
    const removed = await removeWorktree(repoDir, worktreePath, this.removalOptions(session, admitted));
    if (!admitted()) return { notificationSent: false, worktreeRemoved: removed };
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
      this.dispatchOutcomeNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        cleanupSucceeded: true,
        worktreePath,
        worktreeBranch: branchName,
        preview: this.deps.getOutputPreview(session),
        originThreadLine: this.deps.originThreadLine(session),
        remoteOutcome,
        retry,
      }));
    } else {
      this.dispatchOutcomeNotification(session, this.deps.worktreeMessages.buildNoChangeNotification({
        session,
        cleanupSucceeded: false,
        worktreePath,
        worktreeBranch: branchName,
        preview: this.deps.getOutputPreview(session),
        originThreadLine: this.deps.originThreadLine(session),
        remoteOutcome,
        retry,
      }));
    }
    return { notificationSent: true, worktreeRemoved: removed };
  }

  private async hasCurrentlyOpenPrForBranch(session: Session, repoDir: string, branchName: string): Promise<boolean> {
    return (await this.deps.hasOpenPrForBranch?.(repoDir, branchName, session.worktreePrTargetRepo, session.worktreePushRemote)) === true;
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
    if (this.deps.resolveOwningPr) {
      const owner = await this.deps.resolveOwningPr(session, repoDir);
      return owner.kind === "existing" ? owner.status : undefined;
    }
    const targetRepo = await resolveTargetRepo(repoDir, session.worktreePrTargetRepo);
    if (session.worktreePrUrl) {
      const recorded = await this.getPrStatusForUrl(repoDir, session.worktreePrUrl, targetRepo, session.worktreePushRemote);
      if (recorded.exists && recorded.ownHead !== false && recorded.baseRefName === baseBranch) return recorded;
    }

    const parentBranch = session.worktreeParentBranch;
    if (!parentBranch || (await getBranchName(repoDir)) !== parentBranch) return undefined;
    if (parentBranch === branchName || parentBranch === baseBranch) return undefined;
    const discovered = (await this.deps.getPrStatusForBranch?.(repoDir, parentBranch, targetRepo, baseBranch, session.worktreePushRemote))
      ?? await syncWorktreePR(repoDir, parentBranch, targetRepo, baseBranch, { pushRemote: session.worktreePushRemote });
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
  private async describeHookChanges(repoDir: string, branchName: string, baseBranch: string, remote?: string, targetRepo?: string): Promise<string | undefined> {
    try {
      const list = this.deps.listHookPathChanges ?? listHookPathChanges;
      const baseRemote = await resolvePrBaseRemote(repoDir, targetRepo, remote);
      if (!baseRemote) return HOOK_CHECK_UNAVAILABLE_WARNING;
      return describeHookPathChanges(await list(repoDir, branchName, baseBranch, baseRemote, targetRepo !== undefined || (remote !== undefined && remote !== "origin")));
    } catch (err) {
      log.warn(`[worktree] Could not check ${branchName} for hook changes: ${err instanceof Error ? err.message : String(err)}`);
      // Unknown is treated as changed: a person decides.
      return HOOK_CHECK_UNAVAILABLE_WARNING;
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
    retry = false,
    /** The counted commits were made after the session's PR was opened. */
    afterOpenPr = false,
  ): Promise<WorktreeStrategyResult> {
    const summary = await buildWorktreeDecisionWorkSummary({
      sessionName: session.name,
      prompt: session.prompt,
      diffSummary,
      outputPreview: this.deps.getOutputPreview(session, 4_000),
      provider: this.deps.worktreeSummaryProvider,
    });
    const buttons = await this.getPolicyAwareWorktreeDecisionButtons(session.id, allowedActions);
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
    this.dispatchOutcomeNotification(session, this.deps.worktreeMessages.buildAskNotification({
      session,
      branchName,
      baseBranch,
      diffSummary,
      summaryLines: summary.lines,
      policyReason,
      hookWarning,
      afterOpenPr,
      buttons,
      stats: sessionStats(session),
    }));
    this.markPendingDecision(session);
    // Task success was already reported; this prompt requests integration only.
    return { notificationSent: true, worktreeRemoved: false };
  }

  private async handleDelegateStrategy(
    session: Session,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
    allowedActions: AllowedWorktreeActions,
    policyReason?: string,
    hookWarning?: string,
    /** The session's open PR, which does not have these commits yet. */
    openPrUrl?: string,
  ): Promise<WorktreeStrategyResult> {
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
    this.dispatchOutcomeNotification(session, this.deps.worktreeMessages.buildDelegateNotification({
      openPrUrl,
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
    noCommits = false,
    retry = false,
  ): Promise<WorktreeStrategyResult> {
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
    this.markPendingDecision(session, {
      notes: ["dirty_uncommitted_completion"],
    });
    const dirtyEntries = await listDirtyWorktreeEntries(worktreePath);
    const dirtyPreview = dirtyEntries.slice(0, 20).map((entry) => `- ${entry}`);
    const moreLine = dirtyEntries.length > 20 ? [`- ...and ${dirtyEntries.length - 20} more`] : [];
    this.dispatchOutcomeNotification(session, {
      label: "worktree-dirty-uncommitted",
      idempotencyKey: `worktree-dirty-uncommitted:${session.id}:${branchName}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
      userMessage: [
        completedAttention(session, `uncommitted changes on \`${branchName}\``, retry, [
          noCommits
            ? "The branch has no commits, so there is nothing to merge yet."
            : "Commit or discard them before the branch is merged.",
        ]),
        `Worktree: ${worktreePath}`,
        ...(dirtyPreview.length > 0 ? [``, ...dirtyPreview, ...moreLine] : []),
        ``,
        `Commit changes resumes the session to commit its work. Discard deletes the branch and these changes for good.`,
      ].join("\n"),
      notifyUser: "always",
      buttons: this.deps.makeDirtyWorktreeButtons?.(session.id),
      // The buttons could not be shown: the orchestrator asks the user instead.
      wakeMessageOnNotifyFailed: [
        `[${session.name}] Finished with uncommitted changes${noCommits ? " and no commits" : ""} on \`${branchName}\`; the Commit changes / Discard buttons could not be shown. ID: ${session.id}`,
        ...(this.deps.originThreadLine(session) ? [this.deps.originThreadLine(session)] : []),
        `Ask the user whether to commit the changes (agent_respond(ocaSessionId='${session.id}', message='Commit the task's real changes with a clear message.', userInitiated=true)) or discard them (agent_worktree_cleanup(ocaSessionId='${session.name}', dismiss_session=true)).`,
      ].join("\n"),
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
    // A merge retried after this cycle's conflict follows its
    // Integration attention was already reported, so this remains a milestone.
    retriedAfterConflict = false,
  ): Promise<boolean> {
    const admitted = this.admissionTicket(session);
    if (!admitted()) return false;
    const removed = !worktreeExists(worktreePath)
      || await removeWorktree(repoDir, worktreePath, this.removalOptions(session, admitted));
    if (!admitted()) return removed;
    if (removed) {
      session.worktreePath = undefined;
      this.updatePersistedSessionFor(session, { worktreePath: undefined });
      await deleteBranch(repoDir, branchName, admitted);
    }
    if (!admitted()) return removed;
    this.markMerged(session);

    // Same footer as manual outcomes and the generic completion notice.
    const outcomeLine = appendSessionStatsSuffix(formatWorktreeOutcomeLine({
      kind: "merge",
      sessionName: session.name,
      branch: branchName,
      base: baseBranch,
      filesChanged: diffSummary.filesChanged,
      insertions: diffSummary.insertions,
      deletions: diffSummary.deletions,
    }), sessionStats(session));
    let successMsg = outcomeLine;
    if (mergeResult.stashPopConflict) {
      successMsg += `\n⚠️ Pre-merge stash pop conflicted — run \`git stash show ${mergeResult.stashRef ?? "stash@{0}"}\` in ${repoDir} to review stashed changes.`;
    } else if (mergeResult.stashed) {
      successMsg += `\n(Pre-existing changes on \`${baseBranch}\` were auto-stashed and restored.)`;
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

    this.dispatchOutcomeNotification(session, {
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
    retry = false,
  ): Promise<void> {
    const warningLines = mergeResult ? buildMergeWarningLines(mergeResult) : [];
    const attemptsUsed = session.autoMergeConflictResolutionAttemptCount ?? 0;
    if (attemptsUsed >= 1) {
      this.markPendingDecision(session, {
        notes: ["auto_merge_conflict_retry_exhausted"],
        clearResolverSessionId: true,
      });
      const reason = allowedActions.pr
        ? `The rebased branch still conflicts with \`${baseBranch}\`. Open a PR or resolve manually in ${worktreePath}.`
        : `The rebased branch still conflicts with \`${baseBranch}\`. Resolve manually in ${worktreePath}.`;
      if (retry) {
        await this.notifyAutoMergeConflictEscalation(session, branchName, reason, allowedActions, warningLines);
        return;
      }
      // The attempt count survives resumes: a resumed session that completes and
      // conflicts again starts a new terminal cycle, whose first line this is.
      this.dispatchOutcomeNotification(session, {
        label: "worktree-merge-conflict-escalated",
        idempotencyKey: `worktree-merge-conflict-escalated:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
        userMessage: [
          completedAttention(session, "merge conflict", false, [
            "The automatic conflict resolution was already used for this branch.",
            reason,
          ]),
          ...warningLines.map((line) => `⚠️ ${line}`),
        ].join("\n"),
        buttons: await this.getPolicyAwareWorktreeDecisionButtons(
          session.id,
          allowedActions,
          {},
          [[this.deps.makeOpenPrButton(session.id)]],
        ),
      });
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
      if (!this.isCurrentTask(session)) return;
      const resolverSession = await this.deps.spawnConflictResolver({
        session,
        repoDir,
        worktreePath,
        branchName,
        baseBranch,
        prompt: conflictPrompt,
      });
      this.markAutoMergeConflictResolving(session, resolverSession.id, attemptsUsed + 1);
      this.dispatchOutcomeNotification(session, {
        label: "worktree-merge-conflict-resolving",
        idempotencyKey: `worktree-merge-conflict-resolving:${session.id}:${branchName}:${resolverSession.id}`,
        userMessage: [
          completedAttention(session, "merge conflict", false, [
            `Resolver session ${resolverSession.name} is fixing it; the merge is retried automatically when it succeeds.`,
          ]),
          ...warningLines.map((line) => `⚠️ ${line}`),
        ].join("\n"),
      });
    } catch (err) {
      this.markPendingDecision(session, {
        notes: ["auto_merge_conflict_resolver_spawn_failed"],
      });
      this.dispatchOutcomeNotification(session, {
        label: "worktree-merge-conflict-spawn-failed",
        idempotencyKey: `worktree-merge-conflict-spawn-failed:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
        userMessage: [
          completedAttention(session, "merge conflict; the resolver failed to start", false, [err instanceof Error ? err.message : String(err)]),
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
    this.dispatchOutcomeNotification(session, {
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
    retry = false,
  ): Promise<WorktreeStrategyResult> {
    // Nothing is sent on these paths, so the caller's terminal notice must still fire.
    if (this.deps.isAlreadyMerged(sessionRef)) return { notificationSent: false, worktreeRemoved: false };
    if (session.autoMergeResolverSessionId) return { notificationSent: false, worktreeRemoved: false };

    const admitted = this.admissionTicket(session);
    let worktreeRemoved = false;
    // True once a merge outcome (success, conflict, or error) was sent. The
    // "Merge queued" note is not an outcome.
    let notificationSent = false;

    await this.deps.enqueueMerge(
      repoDir,
      async () => {
        if (this.deps.isAlreadyMerged(sessionRef) || !(await this.isReady(session))) return;

        const mergeResult = await this.deps.mergeBranch(repoDir, branchName, baseBranch, "merge", worktreePath, {
          refresh: () => this.isReady(session), isCurrent: admitted,
        });
        if ((!admitted() || mergeResult.code === "task_not_ready") && (mergeResult.success || mergeResult.localMerged)) {
          notificationSent = true;
          this.deps.dispatchSessionNotification(session, {
            label: "worktree-merge-applied",
            idempotencyKey: `worktree-merge-applied:${session.id}:${executionCycle(session)}:${branchName}:${baseBranch}`,
            userMessage: appendMergeWarnings(`ℹ️ [${session.name}] Merged \`${branchName}\` → \`${baseBranch}\` for execution cycle ${executionCycle(session)}. Further integration and cleanup were skipped; the current execution's task status is unchanged.`, mergeResult),
            notifyUser: "always",
          });
          return;
        }
        if (!admitted() || mergeResult.code === "task_not_ready") return;
        // Every branch below sends exactly one outcome notice.
        notificationSent = true;

        if (mergeResult.success) {
          worktreeRemoved = await this.handleAutoMergeSuccess(
            session,
            repoDir,
            worktreePath,
            branchName,
            baseBranch,
            diffSummary,
            mergeResult,
            retry,
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
            retry,
          );
          return;
        }

        // The session completed; its merge needs attention (not a failed session:
        // no ❌). After a conflict resolver it is a follow-up of that cycle.
        const errorMsg = appendMergeWarnings(completedAttention(
          session,
          mergeResult.dirtyError ? "merge blocked" : "merge failed",
          retry,
          [mergeResult.error ?? "unknown error"],
        ), mergeResult);
        if (retry) {
          await this.handleAutoMergeRetryFailure(session, branchName, worktreePath, errorMsg, allowedActions);
          return;
        }
        // The branch is kept and waits for a decision, as after a failed retry.
        // No `✅` is deferred: a merge or PR made afterwards is an `ℹ️` milestone.
        this.markPendingDecision(session, { notes: ["auto_merge_failed"] });
        this.dispatchOutcomeNotification(session, {
          label: "worktree-merge-error",
          idempotencyKey: `worktree-merge-error:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
          userMessage: `${errorMsg}\nBranch \`${branchName}\` is kept; choose below.`,
          buttons: await this.getPolicyAwareWorktreeDecisionButtons(
            session.id,
            allowedActions,
            {},
            [[this.deps.makeOpenPrButton(session.id)]],
          ),
        });
      },
      () => {
        this.dispatchOutcomeNotification(session, {
          label: "worktree-merge-queued",
          idempotencyKey: `worktree-merge-queued:${session.id}:${branchName}:${buildWorktreeCycleKey(session)}`,
          userMessage: `🕐 [${session.name}] Merge queued — another merge for this repo is in progress. Will notify when complete.`,
        });
      },
    );
    return { notificationSent, worktreeRemoved };
  }

  private async handleAutoPrStrategy(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
    allowedActions: AllowedWorktreeActions = { merge: true, pr: true },
    retry = false,
  ): Promise<WorktreeStrategyResult> {
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
    const representedRelease = await this.releaseIfRepresentedByTargetPrBranch(session, repoDir, worktreePath, branchName, baseBranch);
    if (representedRelease) return representedRelease;

    this.updatePersistedSessionFor(session, {
      lifecycle: "terminal",
      worktreeState: "pr_in_progress",
    });
    if (!(await this.isReady(session))) return { notificationSent: false, worktreeRemoved: false };
    const result = await this.deps.runAutoPr(session, baseBranch, retry);
    // agent_pr can discover a different PR base and already send the deferred
    // decision prompt. That prompt owns this cycle; do not also complete it as a failure.
    if (result.decisionRequested) {
      this.markPendingDecision(session);
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (!result.success) {
      const releasedAfterFailure = await this.releaseIfRepresentedByTargetPrBranch(session, repoDir, worktreePath, branchName, baseBranch);
      if (releasedAfterFailure) return releasedAfterFailure;
      this.markPendingDecision(session);
      const reason = result.error?.replace(/[.\s]+$/u, "");
      this.dispatchOutcomeNotification(session, {
        label: "worktree-auto-pr-failed",
        idempotencyKey: `worktree-auto-pr-failed:${session.id}:${baseBranch}:${buildWorktreeCycleKey(session)}`,
        // A reason that ends in a URL keeps it clean: no period, next sentence on its own line.
        userMessage: completedAttention(session, "auto-PR failed", retry, [
          `${reason ? `Reason: ${reason}${/https?:\/\/\S+$/u.test(reason) ? "\n" : ". "}` : ""}The worktree is kept; choose below.`,
        ]),
        buttons: await this.getPolicyAwareWorktreeDecisionButtons(session.id, allowedActions),
      });
    }
    return { notificationSent: result.success ? result.notificationSent : true, worktreeRemoved: false };
  }

  private async getPrStatusForUrl(repoDir: string, prUrl: string, targetRepo?: string, pushRemote?: string): Promise<PRStatus> {
    return (await this.deps.getPrStatusForUrl?.(repoDir, prUrl, targetRepo, pushRemote))
      ?? await syncWorktreePRByUrl(repoDir, prUrl, targetRepo, pushRemote);
  }

  private async releaseIfRepresentedByTargetPrBranch(
    session: Session,
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<WorktreeStrategyResult | undefined> {
    const admitted = this.admissionTicket(session);
    if ((await listDirtyWorktreeEntries(worktreePath)).length > 0) return undefined;

    const targetPrStatus = await this.resolveExistingTargetPr(session, repoDir, branchName, baseBranch);
    // Validated open owners retain their managed worktree. In particular, the
    // helper can already be represented while its checked-out PR parent still
    // has commits to push; releasing the helper here would skip that sync.
    if (this.deps.resolveOwningPr && targetPrStatus?.state === "open") return undefined;
    const targetBranch = targetPrStatus?.headRefName;
    if (!targetBranch || targetBranch === branchName || targetBranch === baseBranch) return undefined;
    const authoritativeTargetRef = this.deps.fetchRemoteBranch
      ? await this.deps.fetchRemoteBranch(repoDir, targetBranch, session.worktreePushRemote)
      : await fetchRemoteBranchRef(repoDir, targetBranch, session.worktreePushRemote);
    if (!authoritativeTargetRef) return undefined;
    const representedByTargetPrBranch = Boolean(
      (targetPrStatus?.state === "open" || targetPrStatus?.state === "merged")
      && targetPrStatus?.baseRefName === baseBranch
      && await isBranchAncestorOfBase(repoDir, branchName, authoritativeTargetRef)
    );
    if (!representedByTargetPrBranch || !(await this.isReady(session))) return undefined;
    const targetRepo = await resolveTargetRepo(repoDir, session.worktreePrTargetRepo);
    if (!admitted()) return { notificationSent: false, worktreeRemoved: false };
    const removed = await removeWorktree(repoDir, worktreePath, this.removalOptions(session, admitted));
    if (!admitted()) return { notificationSent: false, worktreeRemoved: removed };
    if (!removed) {
      this.markPendingDecision(session, {
        notes: [`represented_by_branch:${targetBranch}`, "represented_worktree_cleanup_failed"],
      });
      return { notificationSent: false, worktreeRemoved: false };
    }

    session.worktreePath = undefined;
    session.worktreePrUrl = targetPrStatus.url;
    session.worktreePrNumber = targetPrStatus.number;
    session.worktreePrTargetRepo = targetRepo;
    this.updatePersistedSessionFor(session, {
      worktreePath: undefined,
      worktreePrUrl: targetPrStatus.url,
      worktreePrNumber: targetPrStatus.number,
      worktreePrBaseBranch: targetPrStatus.baseRefName,
      worktreePrTargetRepo: session.worktreePrTargetRepo,
      worktreeRemoteOutcome: "pr-updated",
    });
    await deleteBranch(repoDir, branchName, admitted);
    if (!admitted()) return { notificationSent: false, worktreeRemoved: removed };
    this.markReleased(session, [`released_by_branch:${targetBranch}`]);
    return { notificationSent: false, worktreeRemoved: removed };
  }
}
