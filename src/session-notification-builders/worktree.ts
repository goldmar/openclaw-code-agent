import type { PersistedSessionInfo } from "../types";
import { fenceAgentOutput } from "../untrusted-output";
import { buildCompletionFollowupInstructionLines, formatApprovalExecutionContextLines } from "./terminal";

export function buildDelegateWorktreeWakeMessage(args: {
  sessionName: string;
  sessionId: string;
  branchName: string;
  baseBranch: string;
  promptSnippet: string;
  commitLines: string[];
  moreNote?: string;
  originThreadLine?: string;
  diffSummary: {
    commits: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  allowedActions?: { merge: boolean; pr: boolean };
  policyReason?: string;
  hookWarning?: string;
}): string {
  const {
    sessionName,
    sessionId,
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
  } = args;
  const hasOriginRouteBlock = Boolean(originThreadLine?.trim());
  const mergeAllowed = allowedActions?.merge !== false && !hookWarning;

  const escalateCall = `agent_escalate(session='${sessionName}', kind='worktree', summary='<why>')`;
  return [
    `[${sessionName}] Finished on ${branchName} → ${baseBranch}: ${diffSummary.commits} commits, ${diffSummary.filesChanged} files, +${diffSummary.insertions}/-${diffSummary.deletions}. You decide what happens to the branch (worktree: delegate). ID: ${sessionId}`,
    ...(hasOriginRouteBlock ? [originThreadLine] : []),
    `Task (start): ${promptSnippet}`,
    ...(commitLines.length > 0 ? [fenceAgentOutput([...commitLines, ...(moreNote ? [moreNote] : [])].join("\n"), "commit messages")] : []),
    ...(policyReason ? [`Policy: ${policyReason}`] : []),
    ...(hookWarning ? [`Hook changes: ${hookWarning.replace(/^⚠️\s*/u, "")} Only the user can merge or open a PR for this branch.`] : []),
    `Check the result (agent_output(session='${sessionId}', full=true)), then:`,
    ...(mergeAllowed
      ? [`- In scope and low risk: agent_merge(session='${sessionName}', summary='<one or two lines for the user on what changed>'). The summary is shown with the merge notice; send no other message.`]
      : [`- Do not merge: ${hookWarning ? "the branch changes hook files" : "repo policy does not allow a direct merge"}.`]),
    `- A PR${allowedActions?.pr === false ? " (not available here)" : ""}, a risky change, or unclear scope: ${escalateCall}, then wait for the user. Do not call agent_pr yourself.`,
  ].join("\n");
}

export function buildDelegateReminderWakeMessage(
  session: Pick<PersistedSessionInfo, "name" | "sessionId" | "harnessSessionId" | "worktreeBranch">,
  pendingHours: number,
): string {
  return `[${session.name}] Reminder: branch ${session.worktreeBranch ?? "unknown"} has waited ${pendingHours}h for your decision. agent_merge(session='${session.name}', summary='...') if it is safe, otherwise agent_escalate(session='${session.name}', kind='worktree', summary='...').`;
}

export function buildNoChangeWakeMessage(args: {
  sessionName: string;
  sessionId: string;
  headline?: string;
  cleanupSummary: string;
  preview: string;
  originThreadLine?: string;
  requestedPermissionMode?: PersistedSessionInfo["requestedPermissionMode"];
  currentPermissionMode?: PersistedSessionInfo["currentPermissionMode"];
  approvalExecutionState?: PersistedSessionInfo["approvalExecutionState"];
  approvalState?: PersistedSessionInfo["approvalState"];
  planApproval?: PersistedSessionInfo["planApproval"];
  approvalPromptStatus?: PersistedSessionInfo["approvalPromptStatus"];
  approvalPromptMessageKind?: PersistedSessionInfo["approvalPromptMessageKind"];
  approvalPromptDeliveredAt?: PersistedSessionInfo["approvalPromptDeliveredAt"];
}): string {
  const {
    sessionName,
    sessionId,
    headline,
    cleanupSummary,
    preview,
    originThreadLine,
    requestedPermissionMode,
    currentPermissionMode,
    approvalExecutionState,
    approvalState,
    planApproval,
    approvalPromptStatus,
    approvalPromptMessageKind,
    approvalPromptDeliveredAt,
  } = args;
  const previewSection = preview.trim()
    ? ["Output (end):", fenceAgentOutput(preview, "output preview")]
    : [];
  const hasOriginRouteBlock = Boolean(originThreadLine?.trim());

  return [
    `[${sessionName}] ${headline ?? "Completed with no branch changes to merge."} ${cleanupSummary.charAt(0).toUpperCase()}${cleanupSummary.slice(1)}. ID: ${sessionId}`,
    ...(hasOriginRouteBlock ? [originThreadLine!] : []),
    ...formatApprovalExecutionContextLines({
      requestedPermissionMode,
      currentPermissionMode,
      approvalExecutionState,
      approvalState,
      planApproval,
      approvalPromptStatus,
      approvalPromptMessageKind,
      approvalPromptDeliveredAt,
    }),
    ...previewSection,
    ...buildCompletionFollowupInstructionLines({ sessionId, hasOriginRouteBlock, originThreadLine }),
  ].join("\n");
}
