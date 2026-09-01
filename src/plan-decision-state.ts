import type { PersistedSessionInfo, PermissionMode, SessionConfig, SessionActionToken } from "./types";

export type PlanDecisionTarget = Pick<
  PersistedSessionInfo,
  | "approvalState"
  | "pendingPlanApproval"
  | "planApprovalContext"
  | "planDecisionVersion"
  | "actionablePlanDecisionVersion"
  | "canonicalPlanPromptVersion"
  | "approvalPromptRequiredVersion"
  | "approvalPromptVersion"
  | "approvalPromptStatus"
  | "approvalPromptTransport"
  | "approvalPromptMessageKind"
  | "approvalPromptLastAttemptAt"
  | "approvalPromptDeliveredAt"
  | "approvalPromptFailedAt"
>;

type PlanDecisionVersionTarget = Pick<
  PlanDecisionTarget,
  | "planDecisionVersion"
  | "actionablePlanDecisionVersion"
  | "canonicalPlanPromptVersion"
  | "approvalPromptRequiredVersion"
  | "approvalPromptVersion"
>;

function latestDefinedVersion(...versions: Array<number | undefined>): number | undefined {
  let latest: number | undefined;
  for (const version of versions) {
    if (version == null) continue;
    latest = latest == null ? version : Math.max(latest, version);
  }
  return latest;
}

export function resolveCurrentPlanDecisionVersion(session: PlanDecisionVersionTarget): number | undefined {
  if (session.actionablePlanDecisionVersion != null) return session.actionablePlanDecisionVersion;
  const deliveryVersion = latestDefinedVersion(
    session.approvalPromptRequiredVersion,
    session.approvalPromptVersion,
  );
  if (deliveryVersion != null) return deliveryVersion;
  return session.canonicalPlanPromptVersion ?? session.planDecisionVersion;
}

export function tokenMatchesAppliedPlanApproval(
  token: Pick<SessionActionToken, "kind" | "planDecisionVersion">,
  session: PlanDecisionVersionTarget & Pick<PlanDecisionTarget, "approvalState" | "pendingPlanApproval">,
): boolean {
  return token.kind === "plan-approve"
    && token.planDecisionVersion != null
    && session.approvalState === "approved"
    && !session.pendingPlanApproval
    && session.planDecisionVersion === token.planDecisionVersion + 1;
}

export type ResumedPlanState = {
  permissionMode: PermissionMode;
  approvalApplied: boolean;
  decisionVersion?: number;
  patch: Partial<SessionConfig>;
};

export function buildFailedPlanResumeRollbackState(
  retryablePlan: PersistedSessionInfo,
  postTerminal: PersistedSessionInfo | undefined,
): PersistedSessionInfo {
  if (retryablePlan.worktreePath && postTerminal && !postTerminal.worktreePath) {
    return {
      ...retryablePlan,
      worktreePath: undefined,
      worktreeBranch: undefined,
      worktreeState: postTerminal.worktreeState,
      worktreeDisposition: postTerminal.worktreeDisposition,
      worktreeLifecycle: postTerminal.worktreeLifecycle,
      pendingWorktreeDecisionSince: postTerminal.pendingWorktreeDecisionSince,
      lastWorktreeReminderAt: postTerminal.lastWorktreeReminderAt,
      worktreeDecisionSnoozedUntil: postTerminal.worktreeDecisionSnoozedUntil,
      worktreeMerged: postTerminal.worktreeMerged,
      worktreeMergedAt: postTerminal.worktreeMergedAt,
      worktreeDismissedAt: postTerminal.worktreeDismissedAt,
      worktreeRemoteOutcome: postTerminal.worktreeRemoteOutcome,
    };
  }
  return retryablePlan;
}

/**
 * Carry a stable session's unresolved plan gate across runtime replacement.
 * A bypassPermissions resume is an explicit approval only when an exact,
 * actionable pending version exists; every other resume remains plan-gated.
 */
export function buildResumedPlanState(
  session: PlanDecisionTarget,
  requestedPermissionMode: PermissionMode,
): ResumedPlanState {
  const decisionVersion = resolveCurrentPlanDecisionVersion(session);
  if (!session.pendingPlanApproval) {
    return { permissionMode: requestedPermissionMode, approvalApplied: false, patch: {} };
  }

  const common: Partial<SessionConfig> = {
    planApprovalContext: session.planApprovalContext,
    canonicalPlanPromptVersion: session.canonicalPlanPromptVersion,
    approvalPromptRequiredVersion: session.approvalPromptRequiredVersion,
    approvalPromptVersion: session.approvalPromptVersion,
    approvalPromptStatus: session.approvalPromptStatus,
    approvalPromptTransport: session.approvalPromptTransport,
    approvalPromptMessageKind: session.approvalPromptMessageKind,
    approvalPromptLastAttemptAt: session.approvalPromptLastAttemptAt,
    approvalPromptDeliveredAt: session.approvalPromptDeliveredAt,
    approvalPromptFailedAt: session.approvalPromptFailedAt,
  };

  if (
    requestedPermissionMode === "bypassPermissions"
    && session.actionablePlanDecisionVersion != null
    && session.actionablePlanDecisionVersion > 0
    && decisionVersion === session.actionablePlanDecisionVersion
    && session.approvalState !== "rejected"
  ) {
    return {
      permissionMode: "bypassPermissions",
      approvalApplied: true,
      decisionVersion,
      patch: {
        ...common,
        pendingPlanApproval: false,
        approvalState: "approved",
        approvalExecutionState: "awaiting_plan_output",
        planModeApproved: true,
        planDecisionVersion: decisionVersion + 1,
        actionablePlanDecisionVersion: undefined,
      },
    };
  }

  return {
    // A stable-ID replacement must not turn a pending plan into executable
    // default mode merely because the caller omitted the original mode.
    permissionMode: "plan",
    approvalApplied: false,
    decisionVersion,
    patch: {
      ...common,
      pendingPlanApproval: true,
      approvalState: session.approvalState ?? "pending",
      planDecisionVersion: decisionVersion ?? session.planDecisionVersion,
      actionablePlanDecisionVersion: session.actionablePlanDecisionVersion,
    },
  };
}
