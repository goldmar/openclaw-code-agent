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
  originThreadLine?: string;
  diffSummary: {
    commits: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  allowedActions?: { merge: boolean; pr: boolean };
  policyReason?: string;
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
  } = args;
  const hasOriginRouteBlock = Boolean(originThreadLine?.trim());

  return [
    `[DELEGATED WORKTREE DECISION] Session "${sessionName}" completed with changes.`,
    ``,
    `Session ID: ${sessionId}`,
    `Branch: ${branchName} → ${baseBranch}`,
    `Commits: ${diffSummary.commits} | Files: ${diffSummary.filesChanged} | +${diffSummary.insertions} / -${diffSummary.deletions}`,
    ...(hasOriginRouteBlock ? [originThreadLine] : []),
    ``,
    ...commitLines,
    ...(moreNote ? [moreNote] : []),
    ``,
    `Original task prompt (first 500 chars):`,
    promptSnippet,
    ``,
    ...(policyReason ? [`Policy constraint: ${policyReason}`, ``] : []),
    `You own the next step for this worktree.`,
    ...(allowedActions?.merge === false
      ? [`- Do not call agent_merge(); repo policy does not allow direct merge for this session.`]
      : [`- Merge immediately with agent_merge(session="${sessionName}", base_branch="${baseBranch}") if the changes are clearly in-scope and low-risk.`]),
    ...(allowedActions?.pr === false
      ? [`- Do not call agent_pr(); PR creation is unavailable or forbidden by repo policy.`]
      : [`- If a PR is safer or human choice is needed, call agent_request_worktree_decision(session="${sessionName}", summary="...") so the user gets the canonical Merge/Open PR/Later/Discard buttons.`]),
    `- If scope or risk is unclear, call agent_request_worktree_decision(session="${sessionName}", summary="...") with a concise risk summary instead of sending a plain-text-only question.`,
    `- Never call agent_pr() autonomously in delegate mode.`,
    `- After deciding, notify the user briefly with what you did and why.`,
    ...(hasOriginRouteBlock
      ? [`- Send any human follow-up to the Session origin route above; if it differs from the current chat, do not use a plain final assistant reply.`]
      : []),
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
  approvalState?: PersistedSessionInfo["approvalState"];
  planApproval?: PersistedSessionInfo["planApproval"];
  approvalPromptStatus?: PersistedSessionInfo["approvalPromptStatus"];
  approvalPromptMessageKind?: PersistedSessionInfo["approvalPromptMessageKind"];
  approvalPromptDeliveredAt?: PersistedSessionInfo["approvalPromptDeliveredAt"];
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
    approvalState,
    planApproval,
    approvalPromptStatus,
    approvalPromptMessageKind,
    approvalPromptDeliveredAt,
  } = args;
  const previewSection = preview.trim()
    ? ["", "Output preview:", preview]
    : [];
  const hasOriginRouteBlock = Boolean(originThreadLine?.trim());

  return [
    `Coding agent session completed with no repository changes.`,
    `Name: ${sessionName} | ID: ${sessionId}`,
    `Worktree outcome: ${cleanupSummary}`,
    ...(hasOriginRouteBlock ? [originThreadLine] : []),
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
    ``,
    ...buildCompletionFollowupInstructionLines({
      sessionId,
      canonicalStatusDetail: "The plugin already sent the canonical completion status to the user, including that no repo changes were kept.",
      hasOriginRouteBlock,
    }),
  ].join("\n");
}
