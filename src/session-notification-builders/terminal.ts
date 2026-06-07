import { formatDuration } from "../format";
import { formatHarnessModelSuffix } from "../session-display";
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

function describeApprovalInterpretation(
  context: ApprovalExecutionContext,
): string | undefined {
  if (context.requestedPermissionMode !== "plan") return undefined;

  if (context.approvalExecutionState === "approved_then_implemented") {
    if (
      context.planApproval === "ask"
      && context.approvalPromptStatus === "delivered"
      && context.approvalPromptMessageKind === "canonical_buttons"
      && context.approvalPromptDeliveredAt
    ) {
      return "Approval interpretation: canonical Approve/Revise/Reject buttons were delivered, and implementation after approval was expected.";
    }
    if (context.approvalState === "approved") {
      return "Approval interpretation: explicit plan approval was recorded before implementation, so leaving plan-only mode was expected.";
    }
  }

  if (context.approvalExecutionState === "implemented_without_required_approval") {
    return "Approval interpretation: implementation left plan-only mode without a recorded approval.";
  }

  return undefined;
}

export interface CompletionFollowupContract {
  requiresShortFactualSummary: true;
  owner: "agent";
  appliesToOrdinaryTerminalCompletions: true;
}

export interface WorktreeOutcomeFollowupContract {
  requiresShortFactualSummary: true;
  owner: "agent";
  appliesToWorktreeTerminalOutcomes: true;
}

export interface GoalTaskFollowupContract {
  requiresShortFactualSummary: true;
  owner: "agent";
  appliesToGoalTaskCompletions: true;
}

function makeGithubPrUrlRe(): RegExp {
  return /https?:\/\/github\.com\/[^\s)]+\/[^\s)]+\/pull\/(\d+)(?=[\s).,;:]|$)/gi;
}

function makeRawUrlRe(): RegExp {
  return /https?:\/\/\S+/gi;
}

export function formatApprovalExecutionContextLines(
  context: ApprovalExecutionContext,
): string[] {
  const interpretation = describeApprovalInterpretation(context);
  return [
    `Requested permission mode: ${context.requestedPermissionMode ?? "unknown"}`,
    `Effective permission mode: ${context.currentPermissionMode ?? "unknown"}`,
    `Deterministic approval/execution state: ${context.approvalExecutionState ?? "unknown"}`,
    ...(interpretation ? [interpretation] : []),
  ];
}

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

export function buildCompletionFollowupContract(): CompletionFollowupContract {
  return {
    requiresShortFactualSummary: true,
    owner: "agent",
    appliesToOrdinaryTerminalCompletions: true,
  };
}

export function buildWorktreeOutcomeFollowupContract(): WorktreeOutcomeFollowupContract {
  return {
    requiresShortFactualSummary: true,
    owner: "agent",
    appliesToWorktreeTerminalOutcomes: true,
  };
}

export function buildGoalTaskFollowupContract(): GoalTaskFollowupContract {
  return {
    requiresShortFactualSummary: true,
    owner: "agent",
    appliesToGoalTaskCompletions: true,
  };
}

export function buildCompletionFollowupInstructionLines(args: {
  sessionId: string;
  canonicalStatusDetail?: string;
  canonicalStatusDelivered?: boolean;
  hasOriginRouteBlock?: boolean;
}): string[] {
  const {
    sessionId,
    canonicalStatusDetail,
    canonicalStatusDelivered = true,
    hasOriginRouteBlock = false,
  } = args;
  const routeInstruction = hasOriginRouteBlock
    ? [`7. Before sending that follow-up, honor the Session origin route block above. If originRoute differs from the current chat, do NOT use a plain final assistant reply; use a routed send path that preserves provider/target/threadId.`]
    : [];
  const ownerInstructionIndex = hasOriginRouteBlock ? 8 : 7;
  const canonicalStatusInstructionIndex = hasOriginRouteBlock ? 9 : 8;
  return [
    `[ACTION REQUIRED] Follow your autonomy rules for session completion:`,
    `1. Use agent_output(session='${sessionId}', full=true) to read the full result.`,
    `2. If this is part of a multi-phase pipeline, launch the next phase NOW — do not wait for user input.`,
    `3. ${canonicalStatusDetail ?? (canonicalStatusDelivered
      ? "The plugin already sent the canonical completion status to the user."
      : "The plugin did not confirm delivery of the canonical completion status to the user.")}`,
    `4. Treat the completed session output as source material, not visible delivery. A meaningful final summary inside agent_output is not enough to skip, because the user may only have seen the plugin's terse status line.`,
    `5. If the visible result is only the plugin's terse status line, use the full output to send the user one short factual completion summary for this completed session. Do this even when agent_output already contains a good final summary.`,
    `6. This requirement applies to ordinary terminal/manual completions too, not just delegated worktree decisions.`,
    ...routeInstruction,
    `${ownerInstructionIndex}. That follow-up belongs to you alone; keep it brief, concrete, and grounded in reliable result data. Send at most one orchestrator-owned human summary for this terminal/worktree outcome.`,
    ...(canonicalStatusDelivered
      ? [`${canonicalStatusInstructionIndex}. Do NOT repeat the plugin's status line, and do NOT rely on the plugin to summarize the completed work for you.`]
      : [`${canonicalStatusInstructionIndex}. Because canonical status delivery was not confirmed, account for that gap yourself when you follow up; do NOT assume the plugin already reached the user.`]),
    `${canonicalStatusInstructionIndex + 1}. Send a normal concise final response after any routed follow-up is visibly sent. Do not use marker text, do not answer NO_REPLY, and do not ask the user whether they want the summary.`,
  ];
}

function buildCompletionDiagnosticsLines(args: {
  contract: CompletionFollowupContract;
  canonicalStatusDelivered: boolean;
}): string[] {
  const { contract, canonicalStatusDelivered } = args;
  return [
    `Completion diagnostics:`,
    `- Canonical completion status delivered to user: ${canonicalStatusDelivered ? "yes" : "no"}`,
    `- Plugin requested short factual follow-up summary: ${contract.requiresShortFactualSummary ? "yes" : "no"}`,
    `- Contract applies to ordinary terminal/manual completions: ${contract.appliesToOrdinaryTerminalCompletions ? "yes" : "no"}`,
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
  const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
  const duration = formatDuration(session.duration);
  const followupContract = buildCompletionFollowupContract();
  const buildWakeMessage = (canonicalStatusDelivered: boolean): string => [
    `Coding agent session completed.`,
    `Name: ${session.name} | ID: ${session.id}`,
    `Status: ${session.status}`,
    ...(hasOriginRouteBlock ? [originThreadLine] : []),
    ...formatApprovalExecutionContextLines(session),
    ``,
    `Output preview:`,
    preview,
    ``,
    ...buildCompletionDiagnosticsLines({ contract: followupContract, canonicalStatusDelivered }),
    ``,
    ...buildCompletionFollowupInstructionLines({
      sessionId: session.id,
      canonicalStatusDelivered,
      hasOriginRouteBlock,
    }),
  ].join("\n");

  return {
    userMessage: `✅ [${session.name}] Completed | ${costStr} | ${duration}${formatHarnessModelSuffix({
      harness: session.harnessName,
      model: session.model,
    })}`,
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
  const contract = buildWorktreeOutcomeFollowupContract();
  const hasOriginRouteBlock = Boolean(args.originThreadLine.trim());
  const details = (args.detailLines ?? [])
    .map((line) => sanitizeFollowupLine(line).trim())
    .filter((line) => line.length > 0);
  const sanitizedOutcomeLine = sanitizeFollowupLine(args.outcomeLine);

  return [
    `Worktree follow-through outcome recorded.`,
    `Name: ${args.sessionName ?? "unknown"} | ID: ${args.sessionId}`,
    ...(hasOriginRouteBlock ? [args.originThreadLine] : []),
    ``,
    `Canonical outcome status:`,
    sanitizedOutcomeLine,
    ...(details.length > 0 ? [``, `Outcome details:`, ...details.map((line) => `- ${line}`)] : []),
    ``,
    `Completion diagnostics:`,
    `- Canonical worktree status delivered to user: ${args.canonicalStatusDelivered ? "yes" : "no"}`,
    `- Plugin requested short factual follow-up summary: ${contract.requiresShortFactualSummary ? "yes" : "no"}`,
    `- Contract applies to worktree terminal outcomes: ${contract.appliesToWorktreeTerminalOutcomes ? "yes" : "no"}`,
    ``,
    `[ACTION REQUIRED] Follow your autonomy rules for worktree follow-through:`,
    `1. Use agent_output(session='${args.sessionId}', full=true) to read the full result if output is available.`,
    `2. Treat the completed session output as source material, not visible delivery. A meaningful final summary inside agent_output is not enough to skip, because the user may only have seen the plugin's terse status line.`,
    `3. Use the full output plus the canonical outcome facts above to send the user one short factual outcome summary. Do this even when agent_output already contains a good final summary.`,
    `4. If full output is unavailable or not meaningful, say only what is proven by the merge/PR facts above; do not invent task details.`,
    `5. Mention blockers such as push failure when present; do not describe a local-only merge as pushed.`,
    `6. Do not include raw PR URLs in the follow-up summary. The plugin already posted the PR link in the canonical status; refer to PRs by number, repo, and branch instead.`,
    ...(hasOriginRouteBlock
      ? [`7. Before sending that follow-up, honor the Session origin route block above. If originRoute differs from the current chat, do NOT use a plain final assistant reply; use a routed send path that preserves provider/target/threadId.`]
      : []),
    `${hasOriginRouteBlock ? 8 : 7}. Do NOT repeat only the plugin status line; keep the follow-up brief, concrete, and non-duplicative. Send at most one human-visible summary for this terminal/worktree outcome, counting summaries already sent by the foreground assistant turn or routed message tools.`,
    `${hasOriginRouteBlock ? 9 : 8}. Send a normal concise final response after any routed follow-up is visibly sent. Do not use marker text, do not answer NO_REPLY, and do not ask the user whether they want the summary.`,
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
  const contract = buildGoalTaskFollowupContract();
  const hasOriginRouteBlock = Boolean(args.originThreadLine.trim());

  return [
    `Goal task succeeded.`,
    `Task: ${args.taskName}`,
    `Name: ${args.sessionName ?? args.taskName} | ID: ${args.sessionId}`,
    ...(hasOriginRouteBlock ? [args.originThreadLine] : []),
    ``,
    `Canonical goal status:`,
    args.summary,
    ``,
    `Completion diagnostics:`,
    `- Canonical goal success status delivered to user: ${args.canonicalStatusDelivered ? "yes" : "no"}`,
    `- Plugin requested short factual follow-up summary: ${contract.requiresShortFactualSummary ? "yes" : "no"}`,
    `- Contract applies to goal task completions: ${contract.appliesToGoalTaskCompletions ? "yes" : "no"}`,
    ``,
    `[ACTION REQUIRED] Follow your autonomy rules for goal task completion:`,
    `1. Use agent_output(session='${args.sessionId}', full=true) to read the full result if output is available.`,
    `2. Treat the completed session output as source material, not visible delivery. A meaningful final summary inside agent_output is not enough to skip, because the user may only have seen the plugin's terse goal status line.`,
    `3. Send the user one short factual completion summary grounded in the full output plus the canonical goal status above. Do this even when agent_output already contains a good final summary.`,
    `4. If full output is unavailable or not meaningful, say only what is proven by the goal status above; do not invent task details.`,
    ...(hasOriginRouteBlock
      ? [`5. Before sending that follow-up, honor the Session origin route block above. If originRoute differs from the current chat, do NOT use a plain final assistant reply; use a routed send path that preserves provider/target/threadId.`]
      : []),
    `${hasOriginRouteBlock ? 6 : 5}. Do NOT repeat only the plugin status line; keep the follow-up brief, concrete, and non-duplicative. Send at most one human-visible summary for this goal success outcome, counting summaries already sent by the foreground assistant turn or routed message tools.`,
    `${hasOriginRouteBlock ? 7 : 6}. Send a normal concise final response after any routed follow-up is visibly sent. Do not use marker text, do not answer NO_REPLY, and do not ask the user whether they want the summary.`,
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
  > & { harnessSessionId?: string };
  originThreadLine: OriginThreadLine;
  errorSummary: string;
  preview: string;
  worktreeAutoCleaned: boolean;
  failedButtons?: NotificationButton[][];
}): { userMessage: string; wakeMessage: string; buttons?: NotificationButton[][] } {
  const { session, originThreadLine, errorSummary, preview, worktreeAutoCleaned, failedButtons } = args;
  const outputSection = preview.trim() ? ["", "Output preview:", preview] : [];
  const worktreeCleanupNote = worktreeAutoCleaned
    ? [``, `Note: Worktree and branch were auto-removed (zero cost, startup failure).`]
    : [];
  const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
  const duration = formatDuration(session.duration);

  return {
    userMessage: [
      `❌ [${session.name}] Failed | ${costStr} | ${duration}${formatHarnessModelSuffix({
        harness: session.harnessName,
        model: session.model,
      })}`,
      `   ⚠️ ${errorSummary}`,
    ].join("\n"),
    wakeMessage: [
      `Coding agent session failed.`,
      `Name: ${session.name} | ID: ${session.id}`,
      `Status: ${session.status}`,
      originThreadLine,
      ...formatApprovalExecutionContextLines(session),
      ...(session.harnessSessionId ? [`Backend conversation ID: ${session.harnessSessionId}`] : []),
      ``,
      `Failure summary:`,
      errorSummary,
      ...outputSection,
      ...worktreeCleanupNote,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session failure:`,
      `1. Use agent_output(session='${session.id}', full=true) to inspect the full failure context.`,
      `2. Continue the same session with agent_respond(session='${session.id}', message='<next instruction>').`,
      `   If you intentionally want to fork or switch harnesses, launch a new session with agent_launch(resume_session_id='${session.id}', fork_session=true, ...)`,
      `   If the failure is a launch/config issue, relaunch fresh with agent_launch(prompt=...).`,
      `3. Notify the user with the failure cause and the next action you are taking.`,
    ].join("\n"),
    buttons: failedButtons,
  };
}

export function buildTurnCompletePayload(args: {
  session: Pick<Session, "id" | "name" | "status" | "lifecycle" | "costUsd" | "harnessName" | "model"> & { worktreeStrategy?: Session["worktreeStrategy"] };
  originThreadLine: OriginThreadLine;
  preview: string;
}): { userMessage: string; wakeMessage: string } {
  const { session, originThreadLine, preview } = args;
  const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
  return {
    userMessage: `⏸️ [${session.name}] Turn completed | ${costStr}${formatHarnessModelSuffix({
      harness: session.harnessName,
      model: session.model,
    })}`,
    wakeMessage: [
      `Coding agent session turn ended.`,
      `Name: ${session.name}`,
      `ID: ${session.id}`,
      `Status: ${session.status}`,
      `Lifecycle: ${session.lifecycle}`,
      ``,
      `Last output (~20 lines):`,
      preview,
      ...(originThreadLine ? ["", originThreadLine] : []),
    ].join("\n"),
  };
}
