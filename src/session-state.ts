import type {
  ApprovalExecutionState,
  PermissionMode,
  PlanApprovalContext,
  SessionApprovalState,
  SessionDeliveryState,
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
  canonicalPlanPromptVersion?: number;
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
  canonicalPlanPromptVersion?: number;
  planModeApproved?: boolean;
  pendingWorktreeDecisionSince?: string;
}

const RESOLVED_WORKTREE_STATES = new Set<SessionWorktreeState>([
  "merged",
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
  return "awaiting_approval";
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
        return finalizeState({
          ...state,
          pendingPlanApproval: true,
          planApprovalContext: event.context,
          approvalState: "pending",
          planDecisionVersion: isSamePendingPlan ? state.planDecisionVersion : state.planDecisionVersion + 1,
          lifecycle: "awaiting_plan_decision",
        });
      }

    case "plan.cleared":
      return finalizeState({
        ...state,
        pendingPlanApproval: false,
        planApprovalContext: undefined,
        approvalState: state.approvalState === "pending" ? "not_required" : state.approvalState,
      });

    case "plan.approved":
      return finalizeState({
        ...state,
        pendingPlanApproval: false,
        planApprovalContext: undefined,
        planModeApproved: true,
        approvalState: "approved",
        planDecisionVersion: state.planDecisionVersion + 1,
        lifecycle: state.status === "running" ? "active" : state.lifecycle,
      });

    case "plan.changes_requested":
      return finalizeState({
        ...state,
        pendingPlanApproval: true,
        approvalState: "changes_requested",
        planDecisionVersion: state.planDecisionVersion + 1,
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
    ...(patch.lifecycle !== undefined ? { lifecycle: patch.lifecycle } : {}),
    ...(patch.approvalState !== undefined ? { approvalState: patch.approvalState } : {}),
    ...(patch.approvalExecutionState !== undefined ? { approvalExecutionState: patch.approvalExecutionState } : {}),
    ...(patch.worktreeState !== undefined ? { worktreeState: patch.worktreeState } : {}),
    ...(patch.runtimeState !== undefined ? { runtimeState: patch.runtimeState } : {}),
    ...(patch.deliveryState !== undefined ? { deliveryState: patch.deliveryState } : {}),
    ...(patch.requestedPermissionMode !== undefined ? { requestedPermissionMode: patch.requestedPermissionMode } : {}),
    ...(patch.currentPermissionMode !== undefined ? { currentPermissionMode: patch.currentPermissionMode } : {}),
    ...(patch.pendingPlanApproval !== undefined ? { pendingPlanApproval: patch.pendingPlanApproval } : {}),
    ...(patch.planApprovalContext !== undefined ? { planApprovalContext: patch.planApprovalContext } : {}),
    ...(patch.planDecisionVersion !== undefined ? { planDecisionVersion: patch.planDecisionVersion } : {}),
    ...(patch.canonicalPlanPromptVersion !== undefined ? { canonicalPlanPromptVersion: patch.canonicalPlanPromptVersion } : {}),
    ...(patch.planModeApproved !== undefined ? { planModeApproved: patch.planModeApproved } : {}),
  };

  if (next.pendingPlanApproval) {
    next = {
      ...next,
      approvalState: next.approvalState === "changes_requested" ? "changes_requested" : "pending",
      lifecycle: "awaiting_plan_decision",
    };
  }

  if (patch.pendingWorktreeDecisionSince !== undefined || next.worktreeState === "pending_decision") {
    next = reduceSessionControlState(next, { type: "worktree.decision_requested" });
  } else if (RESOLVED_WORKTREE_STATES.has(next.worktreeState)) {
    next = {
      ...next,
      lifecycle: "terminal",
    };
  }

  return finalizeState(next);
}
