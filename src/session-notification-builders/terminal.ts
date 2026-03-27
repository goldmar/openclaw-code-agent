import { formatDuration } from "../format";
import type { NotificationButton } from "../session-interactions";
import type { KillReason } from "../types";
import type { Session } from "../session";

type OriginThreadLine = string;

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
  session: Pick<Session, "id" | "name" | "status" | "costUsd" | "duration">;
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
      ``,
      `(Note: a turn-complete wake may have already been sent for this session. If you already acted on it, treat this as confirmation — do not repeat actions.)`,
      ``,
      `Output preview:`,
      preview,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session completion:`,
      `1. Use agent_output(session='${session.id}', full=true) to read the full result.`,
      `2. If this is part of a multi-phase pipeline, launch the next phase NOW — do not wait for user input.`,
      `3. Notify the user with a summary of what was done.`,
    ].join("\n"),
  };
}

export function buildFailedPayload(args: {
  session: Pick<Session, "id" | "name" | "status" | "costUsd" | "duration"> & { harnessSessionId?: string };
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
      `Harness session ID: ${session.harnessSessionId ?? "unknown"}`,
      ``,
      `Failure summary:`,
      errorSummary,
      ...outputSection,
      ...worktreeCleanupNote,
      ``,
      `[ACTION REQUIRED] Follow your autonomy rules for session failure:`,
      `1. Use agent_output(session='${session.id}', full=true) to inspect the full failure context.`,
      `2. If the failure is a runtime error (usage limit, API error, crash), resume with a different harness:`,
      `   agent_launch(resume_session_id='${session.harnessSessionId ?? "unknown"}', harness='claude-code', ...)`,
      `   Note: agent_respond also resumes, but uses the same harness (may hit the same error).`,
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
