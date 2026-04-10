import type { Session } from "../session";
import type { NotificationButton } from "../session-interactions";
import type { PlanApprovalMode, PlanArtifact } from "../types";
import { truncateText } from "../format";

type OriginThreadLine = string;
const MAX_PLAN_SUMMARY_ITEMS = 5;
const MAX_PLAN_SUMMARY_ITEM_CHARS = 280;
const MAX_PLAN_SUMMARY_BODY_CHARS = 1400;
const OMITTED_PLAN_SUMMARY_LINE = "- Additional plan details omitted for brevity.";

function normalizeSummaryItem(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^`([^`]+)`$/, "$1")
    .trim();
}

function summarizePlanText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeSummaryItem)
    .filter((line) => line.length > 0)
    .filter((line) => !/^(plan|proposed plan|implementation plan|review summary|summary|why this was escalated)[:]?$/i.test(line))
    .filter((line) => !/^(should|can|could|would|will)\b.*\?$/i.test(line));
}

function formatPlanSummaryItems(items: string[]): string[] {
  const lines: string[] = [];
  let omitted = false;

  for (const item of items) {
    const normalized = item.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const truncated = truncateText(normalized, MAX_PLAN_SUMMARY_ITEM_CHARS);
    if (truncated.length < normalized.length) omitted = true;
    const line = `- ${truncated}`;

    if (lines.length >= MAX_PLAN_SUMMARY_ITEMS || [...lines, line].join("\n").length > MAX_PLAN_SUMMARY_BODY_CHARS) {
      omitted = true;
      break;
    }
    lines.push(line);
  }

  if (lines.length === 0) {
    return ["- Plan details are available in the full session output."];
  }

  if (!omitted) return lines;

  const boundedLines = [...lines];
  while (boundedLines.length > 0 && [...boundedLines, OMITTED_PLAN_SUMMARY_LINE].join("\n").length > MAX_PLAN_SUMMARY_BODY_CHARS) {
    boundedLines.pop();
  }
  return [...boundedLines, OMITTED_PLAN_SUMMARY_LINE];
}

export function formatPlanApprovalSummary(summary: string): string {
  return formatPlanSummaryItems(summarizePlanText(summary)).join("\n");
}

export function buildPlanReviewSummary(args: {
  preview: string;
  artifact?: PlanArtifact;
}): string {
  const { preview, artifact } = args;
  const lines: string[] = ["Review summary:"];
  const summaryItems: string[] = [];

  const explanation = artifact?.explanation?.trim();
  if (explanation) {
    summaryItems.push(explanation);
  }

  const structuredSteps = artifact?.steps
    ?.map((step) => step.step.trim())
    .filter(Boolean) ?? [];
  if (structuredSteps.length > 0) {
    summaryItems.push(...structuredSteps);
  } else {
    const fallbackSource = artifact?.markdown?.trim() || preview;
    summaryItems.push(...summarizePlanText(fallbackSource));
  }

  lines.push(...formatPlanSummaryItems(summaryItems));

  return lines.join("\n");
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
    `Why this was escalated:`,
    ``,
    formatPlanApprovalSummary(summary),
  ].join("\n");
}

export function buildWaitingForInputPayload(args: {
  session: Pick<Session, "id" | "name" | "multiTurn" | "pendingPlanApproval" | "planDecisionVersion" | "actionablePlanDecisionVersion" | "approvalPromptRequiredVersion" | "approvalPromptStatus">;
  preview: string;
  planArtifact?: PlanArtifact;
  originThreadLine: OriginThreadLine;
  planApprovalMode?: PlanApprovalMode;
  planApprovalButtons?: NotificationButton[][];
  questionButtons?: NotificationButton[][];
}): {
  label: "plan-approval" | "waiting";
  userMessage?: string;
  wakeMessage: string;
  buttons?: NotificationButton[][];
  planReviewSummary?: string;
} {
  const { session, preview, planArtifact, originThreadLine, planApprovalMode, planApprovalButtons, questionButtons } = args;
  const isPlanApproval = session.pendingPlanApproval;
  const actionableVersion = session.actionablePlanDecisionVersion ?? session.planDecisionVersion;
  const promptAlreadyProven = hasProvableUserVisiblePrompt(session, actionableVersion);
  const planReviewSummary = isPlanApproval
    ? buildPlanReviewSummary({ preview, artifact: planArtifact })
    : undefined;

  const userMessage = isPlanApproval
    ? (
        planApprovalMode === "ask"
          ? (
              promptAlreadyProven
                ? undefined
                : `📋 [${session.name}] Plan v${actionableVersion ?? "?"} ready for approval:\n\n${planReviewSummary}\n\n${planApprovalButtons ? "Choose Approve, Revise, or Reject below." : "Approval is still pending for this plan version."}`
            )
          : undefined
      )
    : `❓ [${session.name}] Question waiting for reply:\n\n${preview}`;

  if (isPlanApproval) {
    const resolvedMode = planApprovalMode ?? "delegate";
    const permissionModeLine = `Permission mode: plan → will switch to bypassPermissions on approval`;
    if (resolvedMode === "delegate") {
      return {
        label: "plan-approval",
        userMessage,
        planReviewSummary,
        wakeMessage: [
          `[DELEGATED PLAN APPROVAL] Coding agent session has finished its plan and is requesting approval to implement.`,
          `Name: ${session.name} | ID: ${session.id} | Plan v${actionableVersion ?? "?"}`,
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
          `━━━ STEP 2 (MANDATORY): Review privately ━━━`,
          `You are the delegated decision-maker. Review the plan yourself before involving the user.`,
          `If you approve directly, you own the user-facing explanation of what was approved and why.`,
          `Keep it short and user-facing: one sentence is usually enough.`,
          ``,
          `━━━ STEP 3 (ONLY AFTER steps 1 and 2): Decide ━━━`,
          `Choose ONE:`,
          ``,
          `APPROVE the plan directly if ALL of the following are true:`,
          `- You have read the FULL plan (not just the preview)`,
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
          `If approving: call agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true, approval_rationale='<brief reason>').`,
          `That rationale should say why approval was safe: for example scope match, low risk, or no meaningful ambiguity.`,
          `After approving directly, send the user a short plain-text follow-up explaining what was approved and why.`,
          `The plugin's thumbs-up line is only the minimal approval acknowledgment, not the explanation.`,
          `If escalating: call agent_request_plan_approval(session='${session.id}', summary='...') exactly once so the plugin posts the single canonical Approve / Revise / Reject prompt.`,
          `That summary must concisely explain why this was escalated, plus changed files/components, risk level and why, scope match/expansion, and any concerns or assumptions.`,
          `After the canonical prompt exists, WAIT for the user's button click or explicit response and do NOT send a second plain-text recap.`,
          `To request changes without user escalation: call agent_respond(session='${session.id}', message='<your feedback>') and do NOT set approve=true. The agent will revise the plan.`,
        ].join("\n"),
      };
    }

    if (resolvedMode === "ask") {
      return {
        label: "plan-approval",
        userMessage,
        planReviewSummary,
        wakeMessage: [
          `[USER APPROVAL REQUESTED] Coding agent session has finished its plan. The user has been notified via Telegram and must approve directly.`,
          `Name: ${session.name} | ID: ${session.id} | Plan v${actionableVersion ?? "?"}`,
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
      planReviewSummary,
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
    buttons: questionButtons,
  };
}
