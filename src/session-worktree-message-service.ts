import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import {
  buildDelegateWorktreeWakeMessage,
  buildNoChangeWakeMessage,
} from "./session-notification-builder";
import { formatSessionStatsSuffix } from "./session-notification-stats";

type DiffSummary = {
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  changedFiles: string[];
  commitMessages: Array<{ hash: string; message: string; author: string }>;
};

type RemoteWorktreeOutcome = "pr-updated" | "pr-opened";

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
      | "startedAt"
      | "completedAt"
      | "costUsd"
      | "harnessName"
      | "model"
      | "reasoningEffort"
    >;
    cleanupSucceeded: boolean;
    worktreePath: string;
    worktreeBranch?: string;
    preview: string;
    originThreadLine?: string;
    preservedSummary?: string;
    remoteOutcome?: RemoteWorktreeOutcome;
  }): SessionNotificationRequest {
    const {
      session,
      cleanupSucceeded,
      worktreePath,
      worktreeBranch,
      preview,
      originThreadLine,
      preservedSummary,
      remoteOutcome,
    } = args;
    const cleanupState = preservedSummary ? "preserved" : cleanupSucceeded ? "cleaned" : "cleanup-failed";
    const terminalCycleKey = [
      worktreeBranch?.trim() || "unknown-branch",
      worktreePath.trim() || "unknown-worktree",
      session.startedAt,
    ].join(":");
    const cleanupSummary = preservedSummary ?? (cleanupSucceeded
      ? "worktree cleaned up"
      : `cleanup failed; worktree still exists at ${worktreePath}`);
    const statSuffix = formatSessionStatsSuffix({
      costUsd: session.costUsd,
      duration: typeof session.completedAt === "number" ? session.completedAt - session.startedAt : undefined,
      harnessName: session.harnessName,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
    });
    const completedSummary = remoteOutcome === "pr-updated"
      ? "PR updated; no local worktree changes remained to merge"
      : remoteOutcome === "pr-opened"
      ? "PR opened; no local worktree changes remained to merge"
      : "Session completed with no worktree changes to merge";
    const failedSummary = remoteOutcome === "pr-updated"
      ? "PR updated; no local worktree changes remained to merge"
      : remoteOutcome === "pr-opened"
      ? "PR opened; no local worktree changes remained to merge"
      : "Session completed with no worktree changes to merge";
    const wakeHeadline = remoteOutcome === "pr-updated"
      ? "Updated a PR; no local branch changes remained to merge."
      : remoteOutcome === "pr-opened"
      ? "Opened a PR; no local branch changes remained to merge."
      : undefined;

    return {
      label: preservedSummary
        ? "worktree-no-changes-preserved"
        : cleanupSucceeded ? "worktree-no-changes" : "worktree-no-changes-cleanup-failed",
      idempotencyKey: `worktree-no-change:${session.id}:${cleanupState}:${terminalCycleKey}`,
      userMessage: preservedSummary
        ? `ℹ️ [${session.name}] ${completedSummary} — ${preservedSummary}${statSuffix}`
        : cleanupSucceeded
        ? `ℹ️ [${session.name}] ${completedSummary} — worktree cleaned up${statSuffix}`
        : `⚠️ [${session.name}] ${failedSummary}, but worktree cleanup failed. Worktree still exists at ${worktreePath}${statSuffix}`,
      wakeMessage: buildNoChangeWakeMessage({
        sessionName: session.name,
        sessionId: session.id,
        headline: wakeHeadline,
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
    /** Names changed hook / worktree-setup files; such a branch never merges automatically. */
    hookWarning?: string;
  }): SessionNotificationRequest {
    const { session, branchName, baseBranch, diffSummary, buttons, summaryLines = [], policyReason, hookWarning } = args;
    const commitLines = diffSummary.commitMessages
      .slice(0, 5)
      .map((commit) => `• ${commit.hash} ${commit.message}`);
    const moreNote = diffSummary.commits > 5 ? `…and ${diffSummary.commits - 5} more` : "";
    const branchLine = session.worktreePrTargetRepo
      ? `\`${branchName}\` → \`${baseBranch}\` (PR target: ${session.worktreePrTargetRepo})`
      : `\`${branchName}\` → \`${baseBranch}\``;
    // Name only the buttons the user actually got (no Open PR without a PR provider).
    const buttonLabels = (buttons ?? []).flat().map((button) => button.label.trim()).filter(Boolean);
    // An actionable PR choice (Open PR / Sync PR); a `View PR` link is not one.
    const prOffered = buttons
      ? buttons.flat().some((button) => Boolean(button.callbackData) && !button.url && /\bPR\b/.test(button.label))
      : true;
    const choicesLine = buttonLabels.length > 0 ? `${buttonLabels.join(" / ")} buttons` : "the decision buttons";

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
        `🔀 [${session.name}] Finished on ${branchLine}: ${diffSummary.commits} commit${diffSummary.commits === 1 ? "" : "s"}, ${diffSummary.filesChanged} file${diffSummary.filesChanged === 1 ? "" : "s"}, +${diffSummary.insertions}/-${diffSummary.deletions}`,
        ...(summaryLines.length > 0 ? ["", ...summaryLines.map((line) => `- ${line}`)] : []),
        ...(policyReason ? ["", `Policy: ${policyReason}`] : []),
        ...(hookWarning ? ["", hookWarning] : []),
        ...(commitLines.length > 0 ? ["", ...commitLines, ...(moreNote ? [moreNote] : [])] : []),
        ``,
        `Discard deletes the branch and its changes for good.`,
      ].join("\n"),
      notifyUser: "always",
      buttons,
      // Context for the orchestrator's next turn; nothing to do now (N37).
      wakeMessageOnNotifySuccess: [
        `[${session.name}] The user has ${choicesLine} for ${branchLine}. Do not ${prOffered ? "merge or open a PR" : "merge"} yourself unless they ask. ID: ${session.id}`,
      ].join("\n"),
      wakeDelivery: "next-turn",
      wakeMessageOnNotifyFailed: [
        `[${session.name}] Finished on ${branchLine} (${diffSummary.commits} commits, ${diffSummary.filesChanged} files, +${diffSummary.insertions}/-${diffSummary.deletions}); the merge decision buttons could not be shown. ID: ${session.id}`,
        prOffered
          ? `Ask the user: merge, open a PR, keep it for later, or discard. Then call agent_merge, agent_pr, or agent_worktree_cleanup(session='${session.name}', dismiss_session=true).`
          : `Ask the user: merge, keep it for later, or discard. Then call agent_merge or agent_worktree_cleanup(session='${session.name}', dismiss_session=true).`,
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
    hookWarning?: string;
  }): SessionNotificationRequest {
    const { session, branchName, baseBranch, diffSummary, policyReason, allowedActions, originThreadLine, hookWarning } = args;
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
        hookWarning,
      }),
      notifyUser: "never",
    };
  }
}
