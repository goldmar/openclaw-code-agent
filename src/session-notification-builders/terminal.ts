import { formatSessionStatsSuffix } from "../session-notification-stats";
import { fenceAgentOutput } from "../untrusted-output";
import type { NotificationButton } from "../session-interactions";
import type { ApprovalExecutionState, KillReason, PermissionMode } from "../types";
import type { Session } from "../session";

type OriginThreadLine = string;

type ApprovalExecutionContext = {
  requestedPermissionMode?: PermissionMode;
  currentPermissionMode?: PermissionMode;
  approvalExecutionState?: ApprovalExecutionState;
  approvalState?: Session["approvalState"];
  planApproval?: Session["planApproval"];
  approvalPromptStatus?: Session["approvalPromptStatus"];
  approvalPromptMessageKind?: Session["approvalPromptMessageKind"];
  approvalPromptDeliveredAt?: Session["approvalPromptDeliveredAt"];
};

export interface CompletionFollowupContract {
  requiresShortFactualSummary: true;
  owner: "agent";
  appliesToOrdinaryTerminalCompletions: true;
}

function makeGithubPrUrlRe(): RegExp {
  return /https?:\/\/github\.com\/[^\s)]+\/[^\s)]+\/pull\/(\d+)(?=[\s).,;:]|$)/gi;
}

function makeRawUrlRe(): RegExp {
  return /https?:\/\/\S+/gi;
}

/**
 * Approval facts worth an orchestrator's attention in a terminal wake. Only an
 * anomaly is reported: a normal approved or ungated run adds no lines.
 */
export function formatApprovalExecutionContextLines(
  context: ApprovalExecutionContext,
): string[] {
  if (context.approvalExecutionState !== "implemented_without_required_approval") return [];
  return [`⚠️ Approval: the session implemented changes without the required plan approval (requested mode ${context.requestedPermissionMode ?? "unknown"}, effective ${context.currentPermissionMode ?? "unknown"}).`];
}

/** One line telling the orchestrator whether the user saw the plugin's status line. */
function statusDeliveryLine(statusLine: string, delivered: boolean): string {
  return delivered
    ? `The user saw: ${statusLine.split("\n")[0]}`
    : `The status line did NOT reach the user: ${statusLine.split("\n")[0]} — include the outcome in your message.`;
}

const FINAL_REPLY_RULE = "Your reply is sent to the user; do not answer NO_REPLY.";

export function getStoppedStatusLabel(killReason?: KillReason): string {
  switch (killReason) {
    case "user":
      return "Stopped by user";
    case "shutdown":
      return "Stopped by shutdown";
    case "startup-timeout":
      return "Stopped by startup timeout";
    case "unknown":
    case undefined:
      return "Stopped unexpectedly";
    default:
      return "Stopped";
  }
}

function buildCompletionFollowupContract(): CompletionFollowupContract {
  return {
    requiresShortFactualSummary: true,
    owner: "agent",
    appliesToOrdinaryTerminalCompletions: true,
  };
}

export function buildCompletionFollowupInstructionLines(args: {
  sessionId: string;
  /** Accepted for compatibility with older callers; the compact wake no longer repeats it. */
  canonicalStatusDetail?: string;
  canonicalStatusDelivered?: boolean;
  hasOriginRouteBlock?: boolean;
}): string[] {
  return [
    `Tell the user in one or two sentences what was done (read agent_output(session='${args.sessionId}', full=true) if the output above is not enough). Do not repeat the status line.`,
    `If this finished one phase of a larger job, start the next phase now instead.`,
    FINAL_REPLY_RULE,
  ];
}

export function buildCompletedPayload(args: {
  session: Pick<
    Session,
    | "id"
    | "name"
    | "status"
    | "costUsd"
    | "duration"
    | "requestedPermissionMode"
    | "currentPermissionMode"
    | "approvalExecutionState"
    | "approvalState"
    | "planApproval"
    | "approvalPromptStatus"
    | "approvalPromptMessageKind"
    | "approvalPromptDeliveredAt"
    | "harnessName"
    | "model"
    | "reasoningEffort"
  >;
  originThreadLine: OriginThreadLine;
  preview: string;
}): {
  userMessage: string;
  wakeMessageOnNotifySuccess: string;
  wakeMessageOnNotifyFailed: string;
  followupContract: CompletionFollowupContract;
} {
  const { session, originThreadLine, preview } = args;
  const hasOriginRouteBlock = Boolean(originThreadLine.trim());
  const followupContract = buildCompletionFollowupContract();
  const userMessage = `✅ [${session.name}] Completed${formatSessionStatsSuffix(session)}`;
  const buildWakeMessage = (canonicalStatusDelivered: boolean): string => [
    `[${session.name}] Completed. ID: ${session.id}`,
    statusDeliveryLine(userMessage, canonicalStatusDelivered),
    ...(hasOriginRouteBlock ? [originThreadLine] : []),
    ...formatApprovalExecutionContextLines(session),
    `Output (end):`,
    fenceAgentOutput(preview, "output preview"),
    ...buildCompletionFollowupInstructionLines({ sessionId: session.id, canonicalStatusDelivered, hasOriginRouteBlock }),
  ].join("\n");

  return {
    userMessage,
    wakeMessageOnNotifySuccess: buildWakeMessage(true),
    wakeMessageOnNotifyFailed: buildWakeMessage(false),
    followupContract,
  };
}

export function buildWorktreeOutcomeFollowupWake(args: {
  sessionId: string;
  sessionName?: string;
  outcomeLine: string;
  originThreadLine: OriginThreadLine;
  detailLines?: string[];
  canonicalStatusDelivered: boolean;
}): string {
  const hasOriginRouteBlock = Boolean(args.originThreadLine.trim());
  const details = (args.detailLines ?? [])
    .map((line) => sanitizeFollowupLine(line).trim())
    .filter((line) => line.length > 0);
  const sanitizedOutcomeLine = sanitizeFollowupLine(args.outcomeLine);

  return [
    `[${args.sessionName ?? "unknown"}] Worktree outcome. ID: ${args.sessionId}`,
    statusDeliveryLine(sanitizedOutcomeLine, args.canonicalStatusDelivered),
    ...(details.length > 0 ? details.map((line) => `- ${line}`) : []),
    ...(hasOriginRouteBlock ? [args.originThreadLine] : []),
    `Tell the user in one or two sentences what changed (agent_output(session='${args.sessionId}', full=true) if you need the details; if there is no output, state only the facts above). Mention a failed push; refer to PRs by number, not URL. Do not repeat the outcome line.`,
    FINAL_REPLY_RULE,
  ].join("\n");
}

export function buildGoalTaskSucceededFollowupWake(args: {
  sessionId: string;
  sessionName?: string;
  taskName: string;
  summary: string;
  originThreadLine: OriginThreadLine;
  canonicalStatusDelivered: boolean;
}): string {
  const hasOriginRouteBlock = Boolean(args.originThreadLine.trim());
  return [
    `[${args.sessionName ?? args.taskName}] Goal task ${args.taskName} succeeded. ID: ${args.sessionId}`,
    statusDeliveryLine(args.summary, args.canonicalStatusDelivered),
    ...(hasOriginRouteBlock ? [args.originThreadLine] : []),
    `Tell the user in one or two sentences what was achieved (agent_output(session='${args.sessionId}', full=true) if needed; otherwise state only the goal status). Do not repeat the status line.`,
    FINAL_REPLY_RULE,
  ].join("\n");
}

function sanitizeFollowupLine(line: string): string {
  return line
    .replace(makeGithubPrUrlRe(), "PR #$1")
    .replace(makeRawUrlRe(), "[link omitted]");
}

export function buildFailedPayload(args: {
  session: Pick<
    Session,
    | "id"
    | "name"
    | "status"
    | "costUsd"
    | "duration"
    | "requestedPermissionMode"
    | "currentPermissionMode"
    | "approvalExecutionState"
    | "approvalState"
    | "planApproval"
    | "approvalPromptStatus"
    | "approvalPromptMessageKind"
    | "approvalPromptDeliveredAt"
    | "harnessName"
    | "model"
    | "reasoningEffort"
  > & { harnessSessionId?: string };
  originThreadLine: OriginThreadLine;
  errorSummary: string;
  preview: string;
  worktreeAutoCleaned: boolean;
  failedButtons?: NotificationButton[][];
}): { userMessage: string; wakeMessage: string; buttons?: NotificationButton[][] } {
  const { session, originThreadLine, errorSummary, preview, worktreeAutoCleaned, failedButtons } = args;
  const outputSection = preview.trim() ? ["Output (end):", fenceAgentOutput(preview, "output preview")] : [];
  const worktreeCleanupNote = worktreeAutoCleaned
    ? [`The worktree and branch were removed (the session failed at startup at zero cost).`]
    : [];
  return {
    userMessage: [
      `❌ [${session.name}] Failed${formatSessionStatsSuffix(session)}`,
      `   ⚠️ ${errorSummary}`,
    ].join("\n"),
    wakeMessage: [
      `[${session.name}] Failed. ID: ${session.id}`,
      ...(originThreadLine ? [originThreadLine] : []),
      ...formatApprovalExecutionContextLines(session),
      `Error:`,
      fenceAgentOutput(errorSummary, "failure summary"),
      ...outputSection,
      ...worktreeCleanupNote,
      `Tell the user the cause in one line and your next step. Continue the same session with agent_respond(session='${session.id}', message='...'), fork it with agent_launch(resume_session_id='${session.id}', fork_session=true, prompt='...'), or fix a launch/config error and relaunch.`,
    ].join("\n"),
    buttons: failedButtons,
  };
}

export function buildTurnCompletePayload(args: {
  session: Pick<Session, "id" | "name" | "status" | "lifecycle" | "costUsd" | "harnessName" | "model" | "reasoningEffort"> & { worktreeStrategy?: Session["worktreeStrategy"] };
  originThreadLine: OriginThreadLine;
  preview: string;
}): { userMessage: string; wakeMessage: string } {
  const { session, originThreadLine, preview } = args;
  return {
    userMessage: `⏸️ [${session.name}] Turn completed${formatSessionStatsSuffix(session)}`,
    wakeMessage: [
      `Coding agent session turn ended.`,
      `Name: ${session.name}`,
      `ID: ${session.id}`,
      `Status: ${session.status}`,
      `Lifecycle: ${session.lifecycle}`,
      ``,
      `Last output (~20 lines):`,
      fenceAgentOutput(preview, "last output"),
      ...(originThreadLine ? ["", originThreadLine] : []),
    ].join("\n"),
  };
}
