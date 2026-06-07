import type {
  ApprovalExecutionState,
  PermissionMode,
  PlanApprovalContext,
  SessionApprovalState,
  SessionApprovalPromptMessageKind,
  SessionDeliveryState,
  SessionApprovalPromptTransport,
  SessionApprovalPromptStatus,
  SessionLifecycle,
  SessionRuntimeState,
  SessionStatus,
  SessionWorktreeState,
} from "./types";

export interface SessionControlState {
  status: SessionStatus;
  lifecycle: SessionLifecycle;
  approvalState: SessionApprovalState;
  approvalExecutionState: ApprovalExecutionState;
  worktreeState: SessionWorktreeState;
  runtimeState: SessionRuntimeState;
  deliveryState: SessionDeliveryState;
  requestedPermissionMode: PermissionMode;
  currentPermissionMode: PermissionMode;
  pendingPlanApproval: boolean;
  planApprovalContext?: PlanApprovalContext;
  planDecisionVersion: number;
  actionablePlanDecisionVersion?: number;
  canonicalPlanPromptVersion?: number;
  approvalPromptRequiredVersion?: number;
  approvalPromptVersion?: number;
  approvalPromptStatus: SessionApprovalPromptStatus;
  approvalPromptTransport: SessionApprovalPromptTransport;
  approvalPromptMessageKind: SessionApprovalPromptMessageKind;
  approvalPromptLastAttemptAt?: string;
  approvalPromptDeliveredAt?: string;
  approvalPromptFailedAt?: string;
  planModeApproved: boolean;
}

export const SESSION_STATUS_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  starting: ["running", "failed", "killed"],
  running: ["completed", "failed", "killed"],
  completed: [],
  failed: [],
  killed: [],
};

export type SessionControlEvent =
  | { type: "initialize"; hasWorktree: boolean }
  | { type: "status.transition"; status: SessionStatus }
  | { type: "permission.mode_changed"; currentPermissionMode: PermissionMode }
  | { type: "turn.started" }
  | { type: "input.requested" }
  | { type: "plan.requested"; context: PlanApprovalContext }
  | { type: "plan.cleared" }
  | { type: "plan.approved" }
  | { type: "plan.changes_requested" }
  | { type: "terminal.entered"; suspended?: boolean }
  | { type: "worktree.decision_requested" }
  | { type: "worktree.state_set"; worktreeState: SessionWorktreeState }
  | { type: "delivery.state_set"; deliveryState: SessionDeliveryState };

export interface SessionControlPatch {
  lifecycle?: SessionLifecycle;
  approvalState?: SessionApprovalState;
  approvalExecutionState?: ApprovalExecutionState;
  worktreeState?: SessionWorktreeState;
  runtimeState?: SessionRuntimeState;
  deliveryState?: SessionDeliveryState;
  requestedPermissionMode?: PermissionMode;
  currentPermissionMode?: PermissionMode;
  pendingPlanApproval?: boolean;
  planApprovalContext?: PlanApprovalContext;
  planDecisionVersion?: number;
  actionablePlanDecisionVersion?: number;
  canonicalPlanPromptVersion?: number;
  approvalPromptRequiredVersion?: number;
  approvalPromptVersion?: number;
  approvalPromptStatus?: SessionApprovalPromptStatus;
  approvalPromptTransport?: SessionApprovalPromptTransport;
  approvalPromptMessageKind?: SessionApprovalPromptMessageKind;
  approvalPromptLastAttemptAt?: string;
  approvalPromptDeliveredAt?: string;
  approvalPromptFailedAt?: string;
  planModeApproved?: boolean;
  pendingWorktreeDecisionSince?: string;
}

function hasPatchField<K extends keyof SessionControlPatch>(
  patch: SessionControlPatch,
  key: K,
): patch is SessionControlPatch & Record<K, SessionControlPatch[K]> {
  return Object.hasOwn(patch, key);
}

const RESOLVED_WORKTREE_STATES = new Set<SessionWorktreeState>([
  "merged",
  "released",
  "pr_open",
  "dismissed",
  "cleanup_failed",
]);

function deriveApprovalExecutionState(state: SessionControlState): ApprovalExecutionState {
  if (state.requestedPermissionMode !== "plan") {
    return "not_plan_gated";
  }
  if (state.pendingPlanApproval) {
    return "awaiting_approval";
  }
  if (state.planModeApproved) {
    return "approved_then_implemented";
  }
  if (state.currentPermissionMode !== "plan") {
    return "implemented_without_required_approval";
  }
  return "awaiting_plan_output";
}

function finalizeState(next: SessionControlState): SessionControlState {
  return {
    ...next,
    approvalExecutionState: deriveApprovalExecutionState(next),
  };
}

export function reduceSessionControlState(
  state: SessionControlState,
  event: SessionControlEvent,
): SessionControlState {
  switch (event.type) {
    case "initialize":
      return finalizeState({
        ...state,
        worktreeState: event.hasWorktree && state.worktreeState === "none" ? "provisioned" : state.worktreeState,
        lifecycle: state.status === "starting" ? "starting" : state.lifecycle,
        runtimeState: state.status === "starting" ? "live" : state.runtimeState,
      });

    case "status.transition":
      if (event.status === "starting") {
        return finalizeState({ ...state, status: event.status, lifecycle: "starting", runtimeState: "live" });
      }
      if (event.status === "running") {
        return finalizeState({
          ...state,
          status: event.status,
          lifecycle: state.lifecycle === "starting" || state.lifecycle === "suspended" ? "active" : state.lifecycle,
          runtimeState: "live",
        });
      }
      return finalizeState({
        ...state,
        status: event.status,
        runtimeState: "stopped",
        lifecycle: state.lifecycle === "suspended" ? "suspended" : "terminal",
      });

    case "permission.mode_changed":
      return finalizeState({
        ...state,
        currentPermissionMode: event.currentPermissionMode,
      });

    case "turn.started":
      return finalizeState({
        ...state,
        lifecycle: "active",
        runtimeState: "live",
      });

    case "input.requested":
      return finalizeState({
        ...state,
        lifecycle: state.pendingPlanApproval ? "awaiting_plan_decision" : "awaiting_user_input",
      });

    case "plan.requested":
      if (state.planModeApproved) return state;
      {
        const isSamePendingPlan =
          state.pendingPlanApproval
          && state.approvalState === "pending"
          && state.planApprovalContext === event.context;
        const isInFlightRevision =
          state.pendingPlanApproval
          && state.approvalState === "changes_requested"
          && state.planApprovalContext === event.context
          && state.planDecisionVersion > 0;
        const isRevisedPlanSubmission =
          !state.pendingPlanApproval
          && state.approvalState === "changes_requested"
          && state.planApprovalContext === event.context
          && state.planDecisionVersion > 0;
        const nextVersion = isSamePendingPlan || isInFlightRevision || isRevisedPlanSubmission
          ? state.planDecisionVersion
          : state.planDecisionVersion + 1;
        return finalizeState({
          ...state,
          pendingPlanApproval: true,
          planApprovalContext: event.context,
          approvalState: "pending",
          planDecisionVersion: nextVersion,
          actionablePlanDecisionVersion: nextVersion,
          canonicalPlanPromptVersion: isSamePendingPlan ? state.canonicalPlanPromptVersion : undefined,
          approvalPromptRequiredVersion: isSamePendingPlan ? state.approvalPromptRequiredVersion : undefined,
          approvalPromptVersion: isSamePendingPlan ? state.approvalPromptVersion : undefined,
          approvalPromptStatus: isSamePendingPlan ? state.approvalPromptStatus : "not_sent",
          approvalPromptTransport: isSamePendingPlan ? state.approvalPromptTransport : "none",
          approvalPromptMessageKind: isSamePendingPlan ? state.approvalPromptMessageKind : "none",
          approvalPromptLastAttemptAt: isSamePendingPlan ? state.approvalPromptLastAttemptAt : undefined,
          approvalPromptDeliveredAt: isSamePendingPlan ? state.approvalPromptDeliveredAt : undefined,
          approvalPromptFailedAt: isSamePendingPlan ? state.approvalPromptFailedAt : undefined,
          lifecycle: "awaiting_plan_decision",
        });
      }

    case "plan.cleared":
      return finalizeState({
        ...state,
        pendingPlanApproval: false,
        planApprovalContext: undefined,
        actionablePlanDecisionVersion: undefined,
        approvalState: state.approvalState === "pending" ? "not_required" : state.approvalState,
      });

    case "plan.approved":
      return finalizeState({
        ...state,
        pendingPlanApproval: false,
        planApprovalContext: undefined,
        actionablePlanDecisionVersion: undefined,
        planModeApproved: true,
        approvalState: "approved",
        planDecisionVersion: state.planDecisionVersion + 1,
        approvalPromptVersion: undefined,
        approvalPromptStatus: "not_sent",
        lifecycle: state.status === "running" ? "active" : state.lifecycle,
      });

    case "plan.changes_requested":
      return finalizeState({
        ...state,
        pendingPlanApproval: true,
        approvalState: "changes_requested",
        planDecisionVersion: state.planDecisionVersion + 1,
        actionablePlanDecisionVersion: undefined,
        canonicalPlanPromptVersion: undefined,
        approvalPromptRequiredVersion: undefined,
        approvalPromptVersion: undefined,
        approvalPromptStatus: "not_sent",
        approvalPromptTransport: "none",
        approvalPromptMessageKind: "none",
        approvalPromptLastAttemptAt: undefined,
        approvalPromptDeliveredAt: undefined,
        approvalPromptFailedAt: undefined,
        lifecycle: "awaiting_plan_decision",
      });

    case "terminal.entered":
      return finalizeState({
        ...state,
        lifecycle: event.suspended ? "suspended" : "terminal",
        runtimeState: "stopped",
      });

    case "worktree.decision_requested":
      return finalizeState({
        ...state,
        lifecycle: "awaiting_worktree_decision",
        worktreeState: "pending_decision",
      });

    case "worktree.state_set":
      return finalizeState({
        ...state,
        worktreeState: event.worktreeState,
        lifecycle: event.worktreeState === "pending_decision"
          ? "awaiting_worktree_decision"
          : (RESOLVED_WORKTREE_STATES.has(event.worktreeState) ? "terminal" : state.lifecycle),
      });

    case "delivery.state_set":
      return finalizeState({
        ...state,
        deliveryState: event.deliveryState,
      });
  }
}

export function applySessionControlPatch(
  state: SessionControlState,
  patch: SessionControlPatch,
): SessionControlState {
  let next: SessionControlState = {
    ...state,
    ...(hasPatchField(patch, "lifecycle") ? { lifecycle: patch.lifecycle } : {}),
    ...(hasPatchField(patch, "approvalState") ? { approvalState: patch.approvalState } : {}),
    ...(hasPatchField(patch, "approvalExecutionState") ? { approvalExecutionState: patch.approvalExecutionState } : {}),
    ...(hasPatchField(patch, "worktreeState") ? { worktreeState: patch.worktreeState } : {}),
    ...(hasPatchField(patch, "runtimeState") ? { runtimeState: patch.runtimeState } : {}),
    ...(hasPatchField(patch, "deliveryState") ? { deliveryState: patch.deliveryState } : {}),
    ...(hasPatchField(patch, "requestedPermissionMode") ? { requestedPermissionMode: patch.requestedPermissionMode } : {}),
    ...(hasPatchField(patch, "currentPermissionMode") ? { currentPermissionMode: patch.currentPermissionMode } : {}),
    ...(hasPatchField(patch, "pendingPlanApproval") ? { pendingPlanApproval: patch.pendingPlanApproval } : {}),
    ...(hasPatchField(patch, "planApprovalContext") ? { planApprovalContext: patch.planApprovalContext } : {}),
    ...(hasPatchField(patch, "planDecisionVersion") ? { planDecisionVersion: patch.planDecisionVersion } : {}),
    ...(hasPatchField(patch, "actionablePlanDecisionVersion") ? { actionablePlanDecisionVersion: patch.actionablePlanDecisionVersion } : {}),
    ...(hasPatchField(patch, "canonicalPlanPromptVersion") ? { canonicalPlanPromptVersion: patch.canonicalPlanPromptVersion } : {}),
    ...(hasPatchField(patch, "approvalPromptRequiredVersion") ? { approvalPromptRequiredVersion: patch.approvalPromptRequiredVersion } : {}),
    ...(hasPatchField(patch, "approvalPromptVersion") ? { approvalPromptVersion: patch.approvalPromptVersion } : {}),
    ...(hasPatchField(patch, "approvalPromptStatus") ? { approvalPromptStatus: patch.approvalPromptStatus } : {}),
    ...(hasPatchField(patch, "approvalPromptTransport") ? { approvalPromptTransport: patch.approvalPromptTransport } : {}),
    ...(hasPatchField(patch, "approvalPromptMessageKind") ? { approvalPromptMessageKind: patch.approvalPromptMessageKind } : {}),
    ...(hasPatchField(patch, "approvalPromptLastAttemptAt") ? { approvalPromptLastAttemptAt: patch.approvalPromptLastAttemptAt } : {}),
    ...(hasPatchField(patch, "approvalPromptDeliveredAt") ? { approvalPromptDeliveredAt: patch.approvalPromptDeliveredAt } : {}),
    ...(hasPatchField(patch, "approvalPromptFailedAt") ? { approvalPromptFailedAt: patch.approvalPromptFailedAt } : {}),
    ...(hasPatchField(patch, "planModeApproved") ? { planModeApproved: patch.planModeApproved } : {}),
  };

  if (patch.approvalState === "changes_requested" && patch.pendingPlanApproval === undefined) {
    next = {
      ...next,
      pendingPlanApproval: false,
    };
  }

  if (next.pendingPlanApproval) {
    next = {
      ...next,
      approvalState: "pending",
      actionablePlanDecisionVersion: next.actionablePlanDecisionVersion ?? next.planDecisionVersion,
      lifecycle: "awaiting_plan_decision",
    };
  } else if (next.approvalState === "changes_requested") {
    next = {
      ...next,
      actionablePlanDecisionVersion: undefined,
      lifecycle: "awaiting_user_input",
    };
  }

  if (
    (hasPatchField(patch, "pendingWorktreeDecisionSince") && patch.pendingWorktreeDecisionSince !== undefined)
    || next.worktreeState === "pending_decision"
  ) {
    next = reduceSessionControlState(next, { type: "worktree.decision_requested" });
  } else if (RESOLVED_WORKTREE_STATES.has(next.worktreeState)) {
    next = {
      ...next,
      lifecycle: "terminal",
    };
  }

  return finalizeState(next);
}
