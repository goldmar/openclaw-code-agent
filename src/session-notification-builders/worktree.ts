import type { PersistedSessionInfo } from "../types";
import { buildCompletionFollowupInstructionLines, formatApprovalExecutionContextLines } from "./terminal";

export function buildDelegateWorktreeWakeMessage(args: {
  sessionName: string;
  sessionId: string;
  branchName: string;
  baseBranch: string;
  promptSnippet: string;
  commitLines: string[];
  moreNote?: string;
  diffSummary: {
    commits: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}): string {
  const {
    sessionName,
    sessionId,
    branchName,
    baseBranch,
    promptSnippet,
    commitLines,
    moreNote,
    diffSummary,
  } = args;

  return [
    `[DELEGATED WORKTREE DECISION] Session "${sessionName}" completed with changes.`,
    ``,
    `Session ID: ${sessionId}`,
    `Branch: ${branchName} → ${baseBranch}`,
    `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
    ``,
    ...commitLines,
    ...(moreNote ? [moreNote] : []),
    ``,
    `Original task prompt (first 500 chars):`,
    promptSnippet,
    ``,
    `You own the next step for this worktree.`,
    `- Merge immediately with agent_merge(session="${sessionName}", base_branch="${baseBranch}") if the changes are clearly in-scope and low-risk.`,
    `- If a PR is safer, message the user with the summary and ask for confirmation before calling agent_pr().`,
    `- If scope or risk is unclear, message the user and ask for guidance.`,
    `- Never call agent_pr() autonomously in delegate mode.`,
    `- After deciding, notify the user briefly with what you did and why.`,
  ].join("\n");
}

export function buildDelegateReminderWakeMessage(
  session: Pick<PersistedSessionInfo, "name" | "sessionId" | "harnessSessionId" | "worktreeBranch">,
  pendingHours: number,
): string {
  return [
    `[DELEGATED WORKTREE DECISION REMINDER] Session "${session.name}" still has an unresolved worktree decision.`,
    ``,
    `Session ID: ${session.sessionId ?? session.harnessSessionId}`,
    `Branch: ${session.worktreeBranch ?? "unknown"}`,
    `Pending: ${pendingHours}h`,
    ``,
    `Resolve it now:`,
    `- agent_merge(session="${session.name}") if the diff is clearly safe and in scope`,
    `- If a PR is safer, ask the user before agent_pr()`,
    `- If scope or risk is unclear, ask the user for guidance`,
    `- Never call agent_pr() autonomously in delegate mode`,
  ].join("\n");
}

export function buildNoChangeWakeMessage(args: {
  sessionName: string;
  sessionId: string;
  cleanupSummary: string;
  preview: string;
  originThreadLine?: string;
  requestedPermissionMode?: PersistedSessionInfo["requestedPermissionMode"];
  currentPermissionMode?: PersistedSessionInfo["currentPermissionMode"];
  approvalExecutionState?: PersistedSessionInfo["approvalExecutionState"];
}): string {
  const {
    sessionName,
    sessionId,
    cleanupSummary,
    preview,
    originThreadLine,
    requestedPermissionMode,
    currentPermissionMode,
    approvalExecutionState,
  } = args;
  const previewSection = preview.trim()
    ? ["", "Output preview:", preview]
    : [];

  return [
    `Coding agent session completed with no repository changes.`,
    `Name: ${sessionName} | ID: ${sessionId}`,
    `Worktree outcome: ${cleanupSummary}`,
    ...(originThreadLine ? [originThreadLine] : []),
    ...formatApprovalExecutionContextLines({
      requestedPermissionMode,
      currentPermissionMode,
      approvalExecutionState,
    }),
    ...previewSection,
    ``,
    ...buildCompletionFollowupInstructionLines({
      sessionId,
      canonicalStatusDetail: "The plugin already sent the canonical completion status to the user, including that no repo changes were kept.",
    }),
  ].join("\n");
}

export function buildWorktreeDecisionSummary(diffSummary: {
  changedFiles: string[];
  commitMessages: Array<{ message: string }>;
}): string[] {
  const summaryLines: string[] = [];
  const topFiles = diffSummary.changedFiles.slice(0, 3).map((file) => `\`${file}\``);
  if (topFiles.length > 0) {
    const remainingFiles = diffSummary.changedFiles.length - topFiles.length;
    summaryLines.push(
      remainingFiles > 0
        ? `Touches ${topFiles.join(", ")} and ${remainingFiles} more file${remainingFiles === 1 ? "" : "s"}`
        : `Touches ${topFiles.join(", ")}`,
    );
  }

  const recentSubjects = [...new Set(
    diffSummary.commitMessages
      .map((commit) => commit.message.trim())
      .filter(Boolean),
  )].slice(0, 2);
  if (recentSubjects.length > 0) {
    summaryLines.push(`Recent work: ${recentSubjects.join("; ")}`);
  }

  return summaryLines;
}
