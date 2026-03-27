import { formatDuration } from "./format";
import type { NotificationButton } from "./session-interactions";
import type { PlanApprovalMode, PersistedSessionInfo, KillReason } from "./types";
import type { Session } from "./session";

type OriginThreadLine = string;

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

export function buildWaitingForInputPayload(args: {
  session: Pick<Session, "id" | "name" | "multiTurn" | "pendingPlanApproval">;
  preview: string;
  originThreadLine: OriginThreadLine;
  planApprovalMode?: PlanApprovalMode;
  planApprovalButtons?: NotificationButton[][];
}): {
  label: "plan-approval" | "waiting";
  userMessage: string;
  wakeMessage: string;
  buttons?: NotificationButton[][];
} {
  const { session, preview, originThreadLine, planApprovalMode, planApprovalButtons } = args;
  const isPlanApproval = session.pendingPlanApproval;

  const userMessage = isPlanApproval
    ? (
        planApprovalMode === "ask"
          ? `📋 [${session.name}] Plan ready for approval:\n\n${preview}\n\nChoose Approve, Reject, or Revise below.`
          : `📋 [${session.name}] Plan awaiting approval:\n\n${preview}`
      )
    : `❓ [${session.name}] Question waiting for reply:\n\n${preview}`;

  if (isPlanApproval) {
    const resolvedMode = planApprovalMode ?? "delegate";
    const permissionModeLine = `Permission mode: plan → will switch to bypassPermissions on approval`;
    if (resolvedMode === "delegate") {
      return {
        label: "plan-approval",
        userMessage,
        wakeMessage: [
          `[DELEGATED PLAN APPROVAL] Coding agent session has finished its plan and is requesting approval to implement.`,
          `Name: ${session.name} | ID: ${session.id}`,
          originThreadLine,
          permissionModeLine,
          ``,
          `⚠️ YOU MUST COMPLETE THESE STEPS IN ORDER. Do NOT skip any step.`,
          ``,
          `━━━ STEP 1 (MANDATORY): Read the full plan ━━━`,
          `Call agent_output(session='${session.id}', full=true) to read the FULL plan output.`,
          `The preview below is truncated — you MUST read the full output before making any decision.`,
          ``,
          `Preview (truncated):`,
          preview,
          ``,
          `━━━ STEP 2 (MANDATORY): Notify the user ━━━`,
          `After reading the full plan, use the message tool to send the user a summary that includes:`,
          `- What files/components will be changed`,
          `- Risk level (low/medium/high) and why`,
          `- Scope: does this match the original task or has it expanded?`,
          `- Any concerns or assumptions the plan makes`,
          `This message creates accountability — you cannot approve blindly.`,
          ``,
          `━━━ STEP 3 (ONLY AFTER steps 1 and 2): Decide ━━━`,
          `You are the delegated decision-maker. Choose ONE:`,
          ``,
          `APPROVE the plan directly if ALL of the following are true:`,
          `- You have read the FULL plan (not just the preview)`,
          `- You have sent the user the summary message`,
          `- The plan scope matches the original task request`,
          `- The changes are low-risk (no destructive operations, no credential handling, no production deployments)`,
          `- The plan is clear and well-scoped (no ambiguous requirements or open design questions)`,
          `- No architectural decisions that the user should weigh in on`,
          `- The working directory and codebase are correct`,
          ``,
          `ESCALATE to the user and WAIT if ANY of the following are true:`,
          `- The plan involves destructive operations (deleting files, dropping tables, force-pushing)`,
          `- The plan involves credentials, secrets, or production environments`,
          `- The plan requires architectural decisions not covered by the original task`,
          `- The scope has expanded beyond the original request`,
          `- The requirements are ambiguous or the plan makes assumptions the user should confirm`,
          `- You are unsure — when in doubt, always escalate`,
          ``,
          `If approving: agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
          `If escalating: tell the user you need their decision and WAIT for his explicit response.`,
          `To request changes: agent_respond(session='${session.id}', message='<your feedback>') — do NOT set approve=true. The agent will revise the plan.`,
        ].join("\n"),
      };
    }

    if (resolvedMode === "ask") {
      return {
        label: "plan-approval",
        userMessage,
        wakeMessage: [
          `[USER APPROVAL REQUESTED] Coding agent session has finished its plan. The user has been notified via Telegram and must approve directly.`,
          `Name: ${session.name} | ID: ${session.id}`,
          originThreadLine,
          permissionModeLine,
          ``,
          `DO NOT approve this plan yourself. Wait for the user's explicit approval or rejection.`,
          `Once the user responds, forward their decision:`,
          `  To approve: agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
          `  To request changes: agent_respond(session='${session.id}', message='<user feedback>')`,
          ``,
          `Preview (truncated):`,
          preview,
        ].join("\n"),
        buttons: planApprovalButtons,
      };
    }

    return {
      label: "plan-approval",
      userMessage,
      wakeMessage: [
        `[AUTO-APPROVE] Session has a plan ready. Approve it now:`,
        `agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true)`,
      ].join("\n"),
    };
  }

  const sessionType = session.multiTurn ? "Multi-turn session" : "Session";
  return {
    label: "waiting",
    userMessage,
    wakeMessage: [
      `[SYSTEM INSTRUCTION: Follow your auto-respond rules strictly. If this is a permission request or "should I continue?" → auto-respond. For ALL other questions → forward the agent's EXACT question to the user. Do NOT add your own analysis, commentary, or interpretation. Do NOT "nudge" or "poke" the session.]`,
      ``,
      `${sessionType} is waiting for a genuine user reply.`,
      `Name: ${session.name} | ID: ${session.id}`,
      originThreadLine,
      ``,
      `Last output:`,
      preview,
      ``,
      `Use agent_respond(session='${session.id}', message='...') to send a reply, or agent_output(session='${session.id}', full: true) to see full context before deciding.`,
    ].join("\n"),
  };
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
