import { formatDuration } from "../format";
import type { NotificationButton } from "../session-interactions";
import type { ApprovalExecutionState, KillReason, PermissionMode } from "../types";
import type { Session } from "../session";

type OriginThreadLine = string;

type ApprovalExecutionContext = {
  requestedPermissionMode?: PermissionMode;
  currentPermissionMode?: PermissionMode;
  approvalExecutionState?: ApprovalExecutionState;
};

export function formatApprovalExecutionContextLines(
  context: ApprovalExecutionContext,
): string[] {
  return [
    `Requested permission mode: ${context.requestedPermissionMode ?? "unknown"}`,
    `Effective permission mode: ${context.currentPermissionMode ?? "unknown"}`,
    `Deterministic approval/execution state: ${context.approvalExecutionState ?? "unknown"}`,
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

export function buildCompletedPayload(args: {
  session: Pick<
    Session,
    "id" | "name" | "status" | "costUsd" | "duration" | "requestedPermissionMode" | "currentPermissionMode" | "approvalExecutionState"
  >;
  originThreadLine: OriginThreadLine;
  preview: string;
}): { userMessage: string; wakeMessage: string } {
  const { session, originThreadLine, preview } = args;
  const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
  const duration = formatDuration(session.duration);
  return {
    userMessage: `✅ [${session.name}] Completed | ${costStr} | ${duration}`,
    wakeMessage: [
      `Coding agent session completed.`,
      `Name: ${session.name} | ID: ${session.id}`,
      `Status: ${session.status}`,
      originThreadLine,
      ...formatApprovalExecutionContextLines(session),
      ``,
      `Output preview:`,
      preview,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session completion:`,
      `1. Use agent_output(session='${session.id}', full=true) to read the full result.`,
      `2. If this is part of a multi-phase pipeline, launch the next phase NOW — do not wait for user input.`,
      `3. The plugin already sent the canonical completion notification to the user.`,
      `4. Do NOT repeat the plugin's completion status line, but you should usually send a short plain-text summary of what was done or the outcome after reading the full result.`,
      `5. Keep that summary concise; one sentence is often enough. Extra synthesis, risk framing, or next steps are optional when they add value.`,
      `6. Skip the summary only when you are not sending any user-facing follow-up at all because you are silently continuing an internal pipeline, or when reliable result data is still too incomplete to support a factual summary.`,
    ].join("\n"),
  };
}

export function buildFailedPayload(args: {
  session: Pick<
    Session,
    "id" | "name" | "status" | "costUsd" | "duration" | "requestedPermissionMode" | "currentPermissionMode" | "approvalExecutionState"
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
      `❌ [${session.name}] Failed | ${costStr} | ${duration}`,
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
  session: Pick<Session, "id" | "name" | "status" | "lifecycle" | "costUsd"> & { worktreeStrategy?: Session["worktreeStrategy"] };
  originThreadLine: OriginThreadLine;
  preview: string;
}): { userMessage: string; wakeMessage: string } {
  const { session, originThreadLine, preview } = args;
  const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
  return {
    userMessage: `⏸️ [${session.name}] Turn completed | ${costStr}`,
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
