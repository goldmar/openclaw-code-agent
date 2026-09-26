import type { Session } from "../session";
import type { NotificationButton } from "../session-interactions";
import type { PlanApprovalMode, PlanArtifact } from "../types";
import { buildPlanApprovalPromptContent, buildPlanReviewSummary, paginatePlanApprovalText } from "../plan-review-summary";
import type { SessionNotificationMessage } from "../wake-dispatcher";
import { fenceAgentOutput } from "../untrusted-output";

type OriginThreadLine = string;
type WaitingForInputPayload = {
  label: "plan-approval" | "waiting";
  userMessage?: string;
  userMessages?: SessionNotificationMessage[];
  wakeMessage: string;
  buttons?: NotificationButton[][];
  planReviewSummary?: string;
};

function normalizeQuestionText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function buildQuestionUserMessage(args: {
  sessionName: string;
  questionText?: string;
  contextSummary?: string;
  hasButtons?: boolean;
}): string {
  const questionText = normalizeQuestionText(args.questionText) ?? "The session is waiting for your reply.";
  const contextSummary = normalizeQuestionText(args.contextSummary);
  if (!contextSummary) {
    return `❓ [${args.sessionName}] Question waiting for reply:\n\n${questionText}`;
  }
  return [
    `❓ [${args.sessionName}] Question waiting for reply:`,
    ``,
    questionText,
    ``,
    `Why: ${contextSummary}`,
  ].join("\n");
}

function hasProvableUserVisiblePrompt(session: Pick<Session, "approvalPromptRequiredVersion" | "approvalPromptStatus">, actionableVersion?: number): boolean {
  return actionableVersion != null
    && session.approvalPromptRequiredVersion === actionableVersion
    && (session.approvalPromptStatus === "delivered" || session.approvalPromptStatus === "fallback_delivered");
}

export function buildPlanApprovalFallbackText(args: {
  session: Pick<Session, "id" | "name" | "planDecisionVersion" | "actionablePlanDecisionVersion">;
  summary: string;
}): string {
  const { session, summary } = args;
  const actionableVersion = session.actionablePlanDecisionVersion ?? session.planDecisionVersion;
  return [
    `📋 [${session.name}] Plan v${actionableVersion ?? "?"} needs your decision.`,
    ``,
    `Interactive Approve / Revise / Reject buttons could not be delivered, so reply here instead:`,
    `- Reply "approve" to approve and start implementation`,
    `- Reply "reject" to reject and stop the session`,
    `- Any other reply will be sent back as revision feedback`,
    ``,
    summary,
  ].join("\n");
}

export function buildPlanApprovalFallbackMessages(
  args: Parameters<typeof buildPlanApprovalFallbackText>[0],
): SessionNotificationMessage[] {
  const parts = paginatePlanApprovalText(buildPlanApprovalFallbackText(args));
  return parts.map((text, index) => ({
    text: parts.length === 1
      ? text
      : `${text}\n\n${index === parts.length - 1 ? "End of decision context." : "Continued in next message."}`,
    requiredForSequenceSuccess: true,
  }));
}

export function buildWaitingForInputPayload(args: {
  session: Pick<Session, "id" | "name" | "multiTurn" | "pendingPlanApproval" | "planDecisionVersion" | "actionablePlanDecisionVersion" | "approvalPromptRequiredVersion" | "approvalPromptStatus">;
  preview: string;
  questionText?: string;
  questionContextPreview?: string;
  questionContextSummary?: string;
  planArtifact?: PlanArtifact;
  originThreadLine: OriginThreadLine;
  planApprovalMode?: PlanApprovalMode;
  planApprovalButtons?: NotificationButton[][];
  questionButtons?: NotificationButton[][];
}): WaitingForInputPayload {
  const {
    session,
    preview,
    questionText,
    questionContextSummary,
    planArtifact,
    originThreadLine,
    planApprovalMode,
    planApprovalButtons,
    questionButtons,
  } = args;
  const isPlanApproval = session.pendingPlanApproval;
  const actionableVersion = session.actionablePlanDecisionVersion ?? session.planDecisionVersion;
  const promptAlreadyProven = hasProvableUserVisiblePrompt(session, actionableVersion);
  const resolvedPlanApprovalMode = planApprovalMode ?? "delegate";
  const planPrompt = isPlanApproval && resolvedPlanApprovalMode === "ask" && !promptAlreadyProven
    ? buildPlanApprovalPromptContent({
        sessionName: session.name,
        actionableVersion,
        preview,
        artifact: planArtifact,
        hasButtons: Boolean(planApprovalButtons),
      })
    : undefined;
  const planReviewSummary = isPlanApproval
    ? planPrompt?.reviewSummary ?? buildPlanReviewSummary({
        preview,
        artifact: planArtifact,
      })
    : undefined;

  const userMessage = isPlanApproval
    ? (
        planPrompt && planPrompt.userMessages.length === 1
          ? planPrompt.userMessages[0]
          : undefined
      )
    : buildQuestionUserMessage({
        sessionName: session.name,
        questionText: questionText ?? preview,
        contextSummary: questionContextSummary,
        hasButtons: Boolean(questionButtons),
      });
  const userMessages = isPlanApproval
    ? (
        planPrompt && planPrompt.userMessages.length > 1
          ? planPrompt.userMessages.map((text, index, all) => ({
              text,
              buttons: index === all.length - 1 ? planApprovalButtons : undefined,
              requiredForSequenceSuccess: true,
            }))
          : undefined
      )
    : undefined;

  if (isPlanApproval) {
    const resolvedMode = resolvedPlanApprovalMode;
    const header = `[${session.name}] Plan v${actionableVersion ?? "?"} ready. ID: ${session.id}`;
    const approveCall = `agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true, approval_rationale='<one line: why it is safe>')`;
    const escalateCall = `agent_escalate(session='${session.id}', kind='plan', summary='<why, what changes, risk>')`;
    if (resolvedMode === "delegate") {
      return {
        label: "plan-approval",
        userMessage,
        userMessages,
        planReviewSummary,
        wakeMessage: [
          `${header} You review it (planApproval: delegate).`,
          ...(originThreadLine ? [originThreadLine] : []),
          `Preview (truncated; read the whole plan first: agent_output(session='${session.id}', full=true)):`,
          fenceAgentOutput(preview, "plan preview"),
          `Then decide:`,
          `- Approve when it matches the task, is low risk and leaves no design question open: ${approveCall}. The user sees your rationale in the approval notice; no other message is needed.`,
          `- Escalate when it deletes data, touches credentials, CI/release or production, grows the scope, or you are unsure: ${escalateCall}, then wait for the user.`,
          `- Ask for changes: agent_respond(session='${session.id}', message='<feedback>').`,
        ].join("\n"),
      };
    }

    if (resolvedMode === "ask") {
      return {
        label: "plan-approval",
        userMessage,
        userMessages,
        planReviewSummary,
        wakeMessage: [
          `${header} It is with the user (planApproval: ask); do not approve it yourself (approve=true is refused).`,
          `If the user answers in chat, forward their words: agent_respond(session='${session.id}', message='<their words>', userInitiated=true).`,
        ].join("\n"),
        buttons: userMessages ? undefined : planApprovalButtons,
      };
    }

    return {
      label: "plan-approval",
      userMessage,
      planReviewSummary,
      wakeMessage: [
        `${header} You may approve it, but only after verifying the plan (planApproval: approve).`,
        ...(originThreadLine ? [originThreadLine] : []),
        `1. Read it: agent_output(session='${session.id}', full=true).`,
        `2. If it deletes or rewrites data or history, touches credentials, secrets, CI/release or production, runs irreversible commands, or goes beyond the task: ${escalateCall}.`,
        `3. Otherwise: ${approveCall}.`,
      ].join("\n"),
    };
  }

  return {
    label: "waiting",
    userMessage,
    wakeMessage: [
      `[${session.name}] The agent is waiting for the user's answer, and the question could not be shown to them. ID: ${session.id}`,
      ...(originThreadLine ? [originThreadLine] : []),
      `Show the user the question below exactly, without answering or commenting on it:`,
      fenceAgentOutput(preview, "last output"),
      `Forward their answer: agent_respond(session='${session.id}', message='<their answer>', userInitiated=true).`,
    ].join("\n"),
    buttons: questionButtons,
  };
}
