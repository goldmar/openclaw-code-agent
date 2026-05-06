import type {
  PersistedSessionInfo,
  SessionApprovalPromptStatus,
  SessionApprovalState,
  SessionLifecycle,
} from "./types";

export function hasProvablePlanReviewPrompt(
  session: Pick<PersistedSessionInfo, "approvalPromptRequiredVersion" | "approvalPromptStatus">,
  planDecisionVersion?: number,
): boolean {
  return planDecisionVersion != null
    && session.approvalPromptRequiredVersion === planDecisionVersion
    && isDeliveredApprovalPromptStatus(session.approvalPromptStatus);
}

export function isDeliveredApprovalPromptStatus(status?: SessionApprovalPromptStatus): boolean {
  return status === "delivered" || status === "fallback_delivered";
}

export function isCurrentPendingPlanDecision(
  session: {
    pendingPlanApproval?: boolean;
    approvalState?: SessionApprovalState;
    lifecycle?: SessionLifecycle;
    planDecisionVersion?: number;
    actionablePlanDecisionVersion?: number;
  } | undefined,
  planDecisionVersion?: number,
): boolean {
  if (!session || planDecisionVersion == null) return false;
  return Boolean(
    session.pendingPlanApproval
    && session.approvalState === "pending"
    && session.lifecycle === "awaiting_plan_decision"
    && ((session.actionablePlanDecisionVersion ?? session.planDecisionVersion) === planDecisionVersion),
  );
}

export function buildPlanApprovalWakeText(
  session: Pick<PersistedSessionInfo, "sessionId" | "name"> | { id: string; name?: string },
  planDecisionVersion: number | undefined,
  explicitFallback: boolean = false,
): string {
  const sessionId = "id" in session ? session.id : session.sessionId ?? "unknown-session";
  return [
    explicitFallback
      ? `Plan review fallback text delivered to the user because interactive buttons could not be delivered.`
      : `Plan approval buttons delivered to the user.`,
    `Session: ${session.name ?? "unknown"} | ID: ${sessionId} | Plan v${planDecisionVersion ?? "?"}`,
    `Wait for their ${explicitFallback ? "explicit reply" : "button callback"} — do NOT approve or reject this plan yourself.`,
  ].join("\n");
}

export function buildPlanApprovalDeliveryFailureWake(args: {
  session: Pick<PersistedSessionInfo, "sessionId" | "name" | "originThreadId"> | { id: string; name?: string; originThreadId?: string | number };
  planDecisionVersion: number | undefined;
  originThreadLine?: string;
}): string {
  const sessionId = "id" in args.session ? args.session.id : args.session.sessionId ?? "unknown-session";
  const originThreadLine = args.originThreadLine
    ?? (args.session.originThreadId != null ? `Origin thread: ${args.session.originThreadId}` : "");

  return [
    `[PLAN APPROVAL DELIVERY FAILED] The plugin could not deliver the canonical plan review buttons or the explicit fallback text to the user.`,
    `Name: ${args.session.name ?? "unknown"} | ID: ${sessionId} | Plan v${args.planDecisionVersion ?? "?"}`,
    originThreadLine,
    ``,
    `No user-visible actionable review prompt is confirmed for this plan version.`,
    `Intervene manually before assuming the user saw the plan review request.`,
  ].filter(Boolean).join("\n");
}
