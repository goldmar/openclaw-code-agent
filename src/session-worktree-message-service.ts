import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import {
  buildDelegateWorktreeWakeMessage,
  buildNoChangeDeliverableMessage,
  buildWorktreeDecisionSummary,
} from "./session-notification-builder";

type DiffSummary = {
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  changedFiles: string[];
  commitMessages: Array<{ hash: string; message: string; author: string }>;
};

/**
 * Builds worktree-related notification payloads so strategy decisions stay separate
 * from message formatting.
 */
export class SessionWorktreeMessageService {
  buildNoChangeNotification(args: {
    session: Pick<Session, "name">;
    deliverablePreview?: string;
    nativeBackendWorktree: boolean;
    cleanupSucceeded: boolean;
    worktreePath: string;
  }): SessionNotificationRequest {
    const {
      session,
      deliverablePreview,
      nativeBackendWorktree,
      cleanupSucceeded,
      worktreePath,
    } = args;

    if (deliverablePreview) {
      return {
        label: cleanupSucceeded
          ? "worktree-no-change-deliverable"
          : "worktree-no-change-deliverable-cleanup-failed",
        userMessage: nativeBackendWorktree
          ? [
              `📋 [${session.name}] Completed with report-only output:`,
              ``,
              deliverablePreview,
              ``,
              `No code changes were made; the native backend worktree was released for backend cleanup.`,
            ].join("\n")
          : buildNoChangeDeliverableMessage(session as Session, deliverablePreview, cleanupSucceeded, worktreePath),
      };
    }

    return {
      label: cleanupSucceeded ? "worktree-no-changes" : "worktree-no-changes-cleanup-failed",
      userMessage: cleanupSucceeded
        ? nativeBackendWorktree
          ? `ℹ️ [${session.name}] Session completed with no changes — native backend worktree released for backend cleanup`
          : `ℹ️ [${session.name}] Session completed with no changes — worktree cleaned up`
        : `⚠️ [${session.name}] Session completed with no changes, but worktree cleanup failed. Worktree still exists at ${worktreePath}`,
    };
  }

  buildAskNotification(args: {
    session: Pick<Session, "id" | "name" | "worktreePrTargetRepo">;
    branchName: string;
    baseBranch: string;
    diffSummary: DiffSummary;
    buttons?: NotificationButton[][];
  }): SessionNotificationRequest {
    const { session, branchName, baseBranch, diffSummary, buttons } = args;
    const summaryLines = buildWorktreeDecisionSummary(diffSummary);
    const commitLines = diffSummary.commitMessages
      .slice(0, 5)
      .map((commit) => `• ${commit.hash} ${commit.message} (${commit.author})`);
    const moreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : "";
    const branchLine = session.worktreePrTargetRepo
      ? `Branch: \`${branchName}\` → \`${baseBranch}\` | PR target: ${session.worktreePrTargetRepo}`
      : `Branch: \`${branchName}\` → \`${baseBranch}\``;

    return {
      label: "worktree-merge-ask",
      userMessage: [
        `🔀 Worktree decision required for session \`${session.name}\``,
        ``,
        branchLine,
        `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
        ``,
        ...(summaryLines.length > 0
          ? ["Summary:", ...summaryLines.map((line) => `- ${line}`), ``]
          : []),
        `Recent commits:`,
        ...commitLines,
        ...(moreNote ? [moreNote] : []),
        ``,
        `⚠️ Discard will permanently delete branch \`${branchName}\` and all local changes. This cannot be undone.`,
      ].join("\n"),
      notifyUser: "always",
      buttons,
      wakeMessageOnNotifySuccess:
        `Worktree strategy buttons delivered to user. Wait for their button callback — do NOT act on this worktree yourself.`,
      wakeMessageOnNotifyFailed: [
        `🔀 Worktree decision required for session \`${session.name}\``,
        ``,
        branchLine,
        `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
      ].join("\n"),
    };
  }

  buildDelegateNotification(args: {
    session: Pick<Session, "id" | "name" | "prompt">;
    branchName: string;
    baseBranch: string;
    diffSummary: DiffSummary;
  }): SessionNotificationRequest {
    const { session, branchName, baseBranch, diffSummary } = args;
    const commitLines = diffSummary.commitMessages
      .slice(0, 5)
      .map((commit) => `• ${commit.hash} ${commit.message} (${commit.author})`);
    const moreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : undefined;
    const promptSnippet = session.prompt ? session.prompt.slice(0, 500) : "(no prompt)";

    return {
      label: "worktree-delegate",
      wakeMessage: buildDelegateWorktreeWakeMessage({
        sessionName: session.name,
        sessionId: session.id,
        branchName,
        baseBranch,
        promptSnippet,
        commitLines,
        moreNote,
        diffSummary,
      }),
      notifyUser: "never",
    };
  }
}
