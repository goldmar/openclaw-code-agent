import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import {
  buildDelegateWorktreeWakeMessage,
  buildNoChangeWakeMessage,
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
    session: Pick<
      Session,
      | "id"
      | "name"
      | "requestedPermissionMode"
      | "currentPermissionMode"
      | "approvalExecutionState"
      | "approvalState"
      | "planApproval"
      | "approvalPromptStatus"
      | "approvalPromptMessageKind"
      | "approvalPromptDeliveredAt"
      | "completedAt"
    >;
    nativeBackendWorktree: boolean;
    cleanupSucceeded: boolean;
    worktreePath: string;
    worktreeBranch?: string;
    preview: string;
    originThreadLine?: string;
    preservedSummary?: string;
  }): SessionNotificationRequest {
    const {
      session,
      nativeBackendWorktree,
      cleanupSucceeded,
      worktreePath,
      worktreeBranch,
      preview,
      originThreadLine,
      preservedSummary,
    } = args;
    const cleanupState = preservedSummary ? "preserved" : cleanupSucceeded ? "cleaned" : "cleanup-failed";
    const terminalCycleKey = [
      worktreeBranch?.trim() || "unknown-branch",
      worktreePath.trim() || "unknown-worktree",
      session.completedAt ?? "unknown-completed-at",
    ].join(":");
    const cleanupSummary = preservedSummary ?? (cleanupSucceeded
      ? nativeBackendWorktree
        ? "native backend worktree released for backend cleanup"
        : "worktree cleaned up"
      : `cleanup failed; worktree still exists at ${worktreePath}`);

    return {
      label: preservedSummary
        ? "worktree-no-changes-preserved"
        : cleanupSucceeded ? "worktree-no-changes" : "worktree-no-changes-cleanup-failed",
      idempotencyKey: `worktree-no-change:${session.id}:${cleanupState}:${terminalCycleKey}`,
      userMessage: preservedSummary
        ? `ℹ️ [${session.name}] Session completed with no worktree changes to merge — ${preservedSummary}`
        : cleanupSucceeded
        ? nativeBackendWorktree
          ? `ℹ️ [${session.name}] Session completed with no worktree changes to merge — native backend worktree released for backend cleanup`
          : `ℹ️ [${session.name}] Session completed with no worktree changes to merge — worktree cleaned up`
        : `⚠️ [${session.name}] Session completed with no worktree changes to merge, but worktree cleanup failed. Worktree still exists at ${worktreePath}`,
      wakeMessage: buildNoChangeWakeMessage({
        sessionName: session.name,
        sessionId: session.id,
        cleanupSummary,
        preview,
        originThreadLine,
        requestedPermissionMode: session.requestedPermissionMode,
        currentPermissionMode: session.currentPermissionMode,
        approvalExecutionState: session.approvalExecutionState,
        approvalState: session.approvalState,
        planApproval: session.planApproval,
        approvalPromptStatus: session.approvalPromptStatus,
        approvalPromptMessageKind: session.approvalPromptMessageKind,
        approvalPromptDeliveredAt: session.approvalPromptDeliveredAt,
      }),
      notifyUser: "always",
    };
  }

  buildAskNotification(args: {
    session: Pick<Session, "id" | "name" | "worktreePrTargetRepo">;
    branchName: string;
    baseBranch: string;
    diffSummary: DiffSummary;
    buttons?: NotificationButton[][];
    summaryLines?: string[];
    policyReason?: string;
  }): SessionNotificationRequest {
    const { session, branchName, baseBranch, diffSummary, buttons, summaryLines = [], policyReason } = args;
    const commitLines = diffSummary.commitMessages
      .slice(0, 5)
      .map((commit) => `• ${commit.hash} ${commit.message} (${commit.author})`);
    const moreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : "";
    const branchLine = session.worktreePrTargetRepo
      ? `Branch: \`${branchName}\` → \`${baseBranch}\` | PR target: ${session.worktreePrTargetRepo}`
      : `Branch: \`${branchName}\` → \`${baseBranch}\``;

    return {
      label: "worktree-merge-ask",
      idempotencyKey: [
        "worktree-decision",
        session.id,
        branchName,
        baseBranch,
        diffSummary.commits,
        diffSummary.commitMessages.map((commit) => commit.hash).join(","),
      ].join(":"),
      userMessage: [
        `🔀 Worktree decision required for session \`${session.name}\``,
        ``,
        branchLine,
        `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
        ``,
        ...(summaryLines.length > 0
          ? ["Summary:", ...summaryLines.map((line) => `- ${line}`), ``]
          : []),
        ...(policyReason ? [`Policy: ${policyReason}`, ``] : []),
        `Recent commits:`,
        ...commitLines,
        ...(moreNote ? [moreNote] : []),
        ``,
        `⚠️ Discard will permanently delete branch \`${branchName}\` and all local changes. This cannot be undone.`,
      ].join("\n"),
      notifyUser: "always",
      buttons,
      wakeMessageOnNotifySuccess: [
        `Worktree decision buttons delivered to the user.`,
        `Session: ${session.name} | ID: ${session.id}`,
        branchLine,
        `Wait for their button callback — do NOT act on this worktree yourself.`,
      ].join("\n"),
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
    policyReason?: string;
    allowedActions?: { merge: boolean; pr: boolean };
    originThreadLine?: string;
  }): SessionNotificationRequest {
    const { session, branchName, baseBranch, diffSummary, policyReason, allowedActions, originThreadLine } = args;
    const commitLines = diffSummary.commitMessages
      .slice(0, 5)
      .map((commit) => `• ${commit.hash} ${commit.message} (${commit.author})`);
    const moreNote = diffSummary.commits > 5 ? `...and ${diffSummary.commits - 5} more` : undefined;
    const promptSnippet = session.prompt ? session.prompt.slice(0, 500) : "(no prompt)";

    return {
      label: "worktree-delegate",
      idempotencyKey: [
        "worktree-delegate",
        session.id,
        branchName,
        baseBranch,
        diffSummary.commits,
        diffSummary.commitMessages.map((commit) => commit.hash).join(","),
      ].join(":"),
      wakeMessage: buildDelegateWorktreeWakeMessage({
        sessionName: session.name,
        sessionId: session.id,
        branchName,
        baseBranch,
        promptSnippet,
        commitLines,
        moreNote,
        originThreadLine,
        diffSummary,
        allowedActions,
        policyReason,
      }),
      notifyUser: "never",
    };
  }
}
