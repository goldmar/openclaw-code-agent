import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { PersistedSessionInfo } from "./types";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import type { EmbeddedEvalResult } from "./embedded-eval";
import { getPrimarySessionLookupRef, usesNativeBackendWorktree } from "./session-backend-ref";
import { buildDelegateWorktreeWakeMessage, buildNoChangeDeliverableMessage, buildWorktreeDecisionSummary } from "./session-notification-builder";
import {
  removeWorktree,
  getDiffSummary,
  mergeBranch,
  deleteBranch,
  detectDefaultBranch,
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
      enqueueMerge: (
        repoDir: string,
        fn: () => Promise<void>,
        onQueued?: () => void,
      ) => Promise<void>;
      spawnConflictResolver: (session: Session, repoDir: string, prompt: string) => Promise<void>;
      runAutoPr: (session: Session, baseBranch: string) => Promise<{ success: boolean }>;
    },
  ) {}

  private updatePersistedSessionFor(
    session: Pick<Session, "id" | "harnessSessionId">,
    patch: Partial<PersistedSessionInfo>,
  ): void {
    const primaryRef = getPrimarySessionLookupRef(session);
    if (primaryRef) {
      this.deps.updatePersistedSession(primaryRef, patch);
    }
    if (session.harnessSessionId && session.harnessSessionId !== primaryRef) {
      this.deps.updatePersistedSession(session.harnessSessionId, patch);
    }
  }

  async handleWorktreeStrategy(session: Session): Promise<WorktreeStrategyResult> {
    const sessionRef = getPrimarySessionLookupRef(session) ?? session.harnessSessionId;
    if (this.deps.isAlreadyMerged(sessionRef)) {
      console.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" already merged — skipping strategy handling`);
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (session.status !== "completed") return { notificationSent: false, worktreeRemoved: false };
    if (!this.deps.shouldRunWorktreeStrategy(session)) {
      console.info(`[SessionManager] handleWorktreeStrategy: skipping — session "${session.name}" is in phase "${session.phase}"`);
      return { notificationSent: false, worktreeRemoved: false };
    }

    const strategy = session.worktreeStrategy;
    if (!strategy || strategy === "off" || strategy === "manual") {
      return { notificationSent: false, worktreeRemoved: false };
    }

    const worktreePath = session.worktreePath!;
    const repoDir = this.deps.resolveWorktreeRepoDir(session.originalWorkdir, worktreePath);
    const branchName = session.worktreeBranch;
    if (!repoDir) {
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-missing-repo-dir",
        userMessage: `⚠️ [${session.name}] Cannot determine the original repo for worktree ${worktreePath}. Manual inspection is required.`,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (!branchName) {
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-no-branch-name",
        userMessage: `⚠️ [${session.name}] Cannot determine branch name for worktree ${worktreePath}. The worktree may have been removed or is in detached HEAD state. Manual cleanup may be needed.`,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }

    const baseBranch = session.worktreeBaseBranch ?? detectDefaultBranch(repoDir);
    const completionState = this.deps.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch);

    if (completionState === "no-change") {
      return this.handleNoChange(session, repoDir, worktreePath);
    }
    if (completionState === "base-advanced") {
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-no-commits-ahead",
        userMessage: `⚠️ [${session.name}] Auto-merge: branch '${branchName}' has no commits ahead of '${baseBranch}', but '${baseBranch}' has new commits — commits likely landed outside the worktree branch. Verify that commits were not made directly to '${baseBranch}' instead of the worktree branch. Worktree: ${worktreePath}`,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (completionState === "dirty-uncommitted") {
      this.deps.dispatchSessionNotification(session, {
        label: "worktree-dirty-uncommitted",
        userMessage: `⚠️ [${session.name}] Session completed with uncommitted changes. The branch has no commits ahead of '${baseBranch}' but there are modified tracked files in the worktree. Check: ${worktreePath}`,
      });
      return { notificationSent: true, worktreeRemoved: false };
    }

    const diffSummary = getDiffSummary(repoDir, branchName, baseBranch);
    if (!diffSummary) {
      console.warn(`[SessionManager] Failed to get diff summary for ${branchName}, skipping merge-back`);
      return { notificationSent: false, worktreeRemoved: false };
    }

    if (strategy === "ask") {
      return this.handleAskStrategy(session, branchName, baseBranch, diffSummary);
    }
    if (strategy === "delegate") {
      return this.handleDelegateStrategy(session, branchName, baseBranch, diffSummary);
    }
    if (strategy === "auto-merge") {
      await this.handleAutoMergeStrategy(session, repoDir, worktreePath, branchName, baseBranch, diffSummary);
      return { notificationSent: true, worktreeRemoved: false };
    }
    if (strategy === "auto-pr") {
      return this.handleAutoPrStrategy(session, baseBranch);
    }
    return { notificationSent: false, worktreeRemoved: false };
  }

  private async handleNoChange(
    session: Session,
    repoDir: string,
    worktreePath: string,
  ): Promise<WorktreeStrategyResult> {
    const deliverablePreview = await this.classifyNoChangeDeliverable(session);
    const nativeBackendWorktree = usesNativeBackendWorktree(session);
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
      this.deps.dispatchSessionNotification(session, {
        label: deliverablePreview ? "worktree-no-change-deliverable" : "worktree-no-changes",
        userMessage: deliverablePreview
          ? (
              nativeBackendWorktree
                ? [
                    `📋 [${session.name}] Completed with report-only output:`,
                    ``,
                    deliverablePreview,
                    ``,
                    `No code changes were made; the native backend worktree was released for backend cleanup.`,
                  ].join("\n")
                : buildNoChangeDeliverableMessage(session, deliverablePreview, true, worktreePath)
            )
          : nativeBackendWorktree
            ? `ℹ️ [${session.name}] Session completed with no changes — native backend worktree released for backend cleanup`
            : `ℹ️ [${session.name}] Session completed with no changes — worktree cleaned up`,
      });
    } else {
      this.deps.dispatchSessionNotification(session, {
        label: deliverablePreview ? "worktree-no-change-deliverable-cleanup-failed" : "worktree-no-changes-cleanup-failed",
        userMessage: deliverablePreview
          ? buildNoChangeDeliverableMessage(session, deliverablePreview, false, worktreePath)
          : `⚠️ [${session.name}] Session completed with no changes, but worktree cleanup failed. Worktree still exists at ${worktreePath}`,
      });
    }
    return { notificationSent: true, worktreeRemoved: removed };
  }

  private handleAskStrategy(
    session: Session,
    branchName: string,
    baseBranch: string,
    diffSummary: DiffSummary,
  ): WorktreeStrategyResult {
    const askSummaryLines = buildWorktreeDecisionSummary(diffSummary);
    const askCommitLines = diffSummary.commitMessages
      .slice(0, 5)
      .map((c) => `• ${c.hash} ${c.message} (${c.author})`);
    const askMoreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : "";

    const askBranchLine = session.worktreePrTargetRepo
      ? `Branch: \`${branchName}\` → \`${baseBranch}\` | PR target: ${session.worktreePrTargetRepo}`
      : `Branch: \`${branchName}\` → \`${baseBranch}\``;

    const userNotifyMessage = [
      `🔀 Worktree decision required for session \`${session.name}\``,
      ``,
      askBranchLine,
      `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
      ``,
      ...(askSummaryLines.length > 0
        ? [
            `Summary:`,
            ...askSummaryLines.map((line) => `- ${line}`),
            ``,
          ]
        : []),
      `Recent commits:`,
      ...askCommitLines,
      ...(askMoreNote ? [askMoreNote] : []),
      ``,
      `⚠️ Discard will permanently delete branch \`${branchName}\` and all local changes. This cannot be undone.`,
    ].join("\n");

    this.deps.dispatchSessionNotification(session, {
      label: "worktree-merge-ask",
      userMessage: userNotifyMessage,
      notifyUser: "always",
      buttons: this.deps.getWorktreeDecisionButtons(session.id),
      wakeMessageOnNotifySuccess:
        `Worktree strategy buttons delivered to user. Wait for their button callback — do NOT act on this worktree yourself.`,
      wakeMessageOnNotifyFailed: userNotifyMessage,
    });

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
    const delegateCommitLines = diffSummary.commitMessages
      .slice(0, 5)
      .map((c) => `• ${c.hash} ${c.message} (${c.author})`);
    const delegateMoreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : "";
    const promptSnippet = session.prompt ? session.prompt.slice(0, 500) : "(no prompt)";

    this.deps.dispatchSessionNotification(session, {
      label: "worktree-delegate",
      wakeMessage: buildDelegateWorktreeWakeMessage({
        sessionName: session.name,
        sessionId: session.id,
        branchName,
        baseBranch,
        promptSnippet,
        commitLines: delegateCommitLines,
        moreNote: delegateMoreNote || undefined,
        diffSummary,
      }),
      notifyUser: "never",
    });

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
  ): Promise<void> {
    const sessionRef = getPrimarySessionLookupRef(session) ?? session.harnessSessionId;
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

  private async classifyNoChangeDeliverable(
    session: Pick<Session, "harnessName" | "name" | "prompt" | "originAgentId" | "getOutput"> & {
      workdir?: string;
      originalWorkdir?: string;
    },
  ): Promise<string | undefined> {
    if (typeof session.getOutput !== "function") return undefined;
    const preview = session.getOutput()
      .join("\n")
      .slice(-2_500)
      .trim();
    if (!preview) return undefined;
    const outputText = session.getOutput()
      .join("\n")
      .slice(-5_000)
      .trim();
    if (!outputText) return undefined;
    const workspaceDir = session.workdir ?? session.originalWorkdir;
    if (!workspaceDir) return undefined;

    const result = await this.deps.classifyNoChangeDeliverable({
      harnessName: session.harnessName,
      sessionName: session.name,
      prompt: session.prompt,
      workdir: workspaceDir,
      agentId: session.originAgentId,
      outputText,
    });
    return result.classification === "report_worthy_no_change" ? preview : undefined;
  }
}
