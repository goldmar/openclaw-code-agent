import type { PersistedSessionInfo } from "../types";
import type { Session } from "../session";

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

export function buildNoChangeDeliverableMessage(
  session: Pick<Session, "name">,
  preview: string,
  cleanupSucceeded: boolean,
  worktreePath: string,
): string {
  const cleanupLine = cleanupSucceeded
    ? "No code changes were made; the worktree was cleaned up."
    : `No code changes were made; worktree cleanup failed. Worktree still exists at ${worktreePath}`;
  return [
    `📋 [${session.name}] Completed with report-only output:`,
    ``,
    preview,
    ``,
    cleanupLine,
  ].join("\n");
}
