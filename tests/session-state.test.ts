import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySessionControlPatch,
  reduceSessionControlState,
  type SessionControlState,
} from "../src/session-state";

function baseState(overrides: Partial<SessionControlState> = {}): SessionControlState {
  return {
    status: "starting",
    lifecycle: "starting",
    approvalState: "not_required",
    approvalExecutionState: "not_plan_gated",
    worktreeState: "none",
    runtimeState: "live",
    deliveryState: "idle",
    requestedPermissionMode: "default",
    currentPermissionMode: "default",
    pendingPlanApproval: false,
    planApprovalContext: undefined,
    planDecisionVersion: 0,
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
    planModeApproved: false,
    ...overrides,
  };
}

describe("session-state reducer", () => {
  it("initializes provisioned worktree state deterministically", () => {
    const next = reduceSessionControlState(baseState(), {
      type: "initialize",
      hasWorktree: true,
    });

    assert.equal(next.worktreeState, "provisioned");
    assert.equal(next.lifecycle, "starting");
  });

  it("marks plan approval as pending with explicit lifecycle", () => {
    const next = reduceSessionControlState(baseState({
      status: "running",
      lifecycle: "active",
      requestedPermissionMode: "plan",
      currentPermissionMode: "plan",
    }), {
      type: "plan.requested",
      context: "plan-mode",
    });

    assert.equal(next.pendingPlanApproval, true);
    assert.equal(next.planApprovalContext, "plan-mode");
    assert.equal(next.approvalState, "pending");
    assert.equal(next.approvalExecutionState, "awaiting_approval");
    assert.equal(next.planDecisionVersion, 1);
    assert.equal(next.actionablePlanDecisionVersion, 1);
    assert.equal(next.lifecycle, "awaiting_plan_decision");
  });

  it("marks approved plan sessions as approved_then_implemented once the approval path is applied", () => {
    const next = reduceSessionControlState(baseState({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      requestedPermissionMode: "plan",
      currentPermissionMode: "bypassPermissions",
      pendingPlanApproval: true,
      approvalState: "pending",
    }), {
      type: "plan.approved",
    });

    assert.equal(next.approvalState, "approved");
    assert.equal(next.approvalExecutionState, "approved_then_implemented");
  });

  it("marks plan-gated sessions that leave plan mode without approval as implemented_without_required_approval", () => {
    const next = reduceSessionControlState(baseState({
      status: "running",
      lifecycle: "active",
      requestedPermissionMode: "plan",
      currentPermissionMode: "plan",
    }), {
      type: "permission.mode_changed",
      currentPermissionMode: "default",
    });

    assert.equal(next.approvalExecutionState, "implemented_without_required_approval");
  });

  it("keeps plan-gated sessions in awaiting_plan_output until a plan review is actually requested", () => {
    const next = reduceSessionControlState(baseState({
      status: "running",
      lifecycle: "active",
      requestedPermissionMode: "plan",
      currentPermissionMode: "plan",
    }), {
      type: "turn.started",
    });

    assert.equal(next.approvalExecutionState, "awaiting_plan_output");
  });

  it("normalizes changes_requested patches into a non-actionable revision state", () => {
    const next = applySessionControlPatch(baseState({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      approvalState: "pending",
      pendingPlanApproval: true,
      planDecisionVersion: 2,
    }), {
      approvalState: "changes_requested",
      planDecisionVersion: 3,
    });

    assert.equal(next.pendingPlanApproval, false);
    assert.equal(next.approvalState, "changes_requested");
    assert.equal(next.planDecisionVersion, 3);
    assert.equal(next.actionablePlanDecisionVersion, undefined);
    assert.equal(next.lifecycle, "awaiting_user_input");
  });

  it("clears optional approval prompt fields when patch explicitly sets undefined", () => {
    const next = applySessionControlPatch(baseState({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      approvalPromptRequiredVersion: 4,
      approvalPromptVersion: 4,
      approvalPromptStatus: "delivered",
      approvalPromptTransport: "direct-message",
      approvalPromptMessageKind: "canonical_buttons",
      approvalPromptLastAttemptAt: "2026-04-10T12:00:00.000Z",
      approvalPromptDeliveredAt: "2026-04-10T12:01:00.000Z",
      approvalPromptFailedAt: "2026-04-10T12:02:00.000Z",
    }), {
      approvalPromptRequiredVersion: undefined,
      approvalPromptVersion: undefined,
      approvalPromptStatus: "not_sent",
      approvalPromptTransport: "none",
      approvalPromptMessageKind: "none",
      approvalPromptLastAttemptAt: undefined,
      approvalPromptDeliveredAt: undefined,
      approvalPromptFailedAt: undefined,
    });

    assert.equal(next.approvalPromptRequiredVersion, undefined);
    assert.equal(next.approvalPromptVersion, undefined);
    assert.equal(next.approvalPromptStatus, "not_sent");
    assert.equal(next.approvalPromptTransport, "none");
    assert.equal(next.approvalPromptMessageKind, "none");
    assert.equal(next.approvalPromptLastAttemptAt, undefined);
    assert.equal(next.approvalPromptDeliveredAt, undefined);
    assert.equal(next.approvalPromptFailedAt, undefined);
  });

  it("keeps optional approval prompt fields when patch omits them", () => {
    const next = applySessionControlPatch(baseState({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      approvalPromptRequiredVersion: 4,
      approvalPromptVersion: 4,
      approvalPromptStatus: "delivered",
      approvalPromptTransport: "direct-message",
      approvalPromptMessageKind: "canonical_buttons",
      approvalPromptDeliveredAt: "2026-04-10T12:01:00.000Z",
    }), {
      deliveryState: "notifying",
    });

    assert.equal(next.deliveryState, "notifying");
    assert.equal(next.approvalPromptRequiredVersion, 4);
    assert.equal(next.approvalPromptVersion, 4);
    assert.equal(next.approvalPromptStatus, "delivered");
    assert.equal(next.approvalPromptTransport, "direct-message");
    assert.equal(next.approvalPromptMessageKind, "canonical_buttons");
    assert.equal(next.approvalPromptDeliveredAt, "2026-04-10T12:01:00.000Z");
  });

  it("treats revised-plan submission as the latest actionable version", () => {
    const next = reduceSessionControlState(baseState({
      status: "running",
      lifecycle: "awaiting_user_input",
      requestedPermissionMode: "plan",
      currentPermissionMode: "plan",
      approvalState: "changes_requested",
      pendingPlanApproval: false,
      planApprovalContext: "plan-mode",
      planDecisionVersion: 2,
    }), {
      type: "plan.requested",
      context: "plan-mode",
    });

    assert.equal(next.pendingPlanApproval, true);
    assert.equal(next.approvalState, "pending");
    assert.equal(next.planDecisionVersion, 2);
    assert.equal(next.actionablePlanDecisionVersion, 2);
    assert.equal(next.lifecycle, "awaiting_plan_decision");
  });

  it("moves into awaiting_user_input without plan approval", () => {
    const next = reduceSessionControlState(baseState({
      status: "running",
      lifecycle: "active",
    }), {
      type: "input.requested",
    });

    assert.equal(next.lifecycle, "awaiting_user_input");
  });

  it("marks idle terminal entry as suspended and stopped", () => {
    const next = reduceSessionControlState(baseState({
      status: "running",
      lifecycle: "active",
      runtimeState: "live",
    }), {
      type: "terminal.entered",
      suspended: true,
    });

    assert.equal(next.lifecycle, "suspended");
    assert.equal(next.runtimeState, "stopped");
  });

  it("normalizes pending worktree decisions through patch application", () => {
    const next = applySessionControlPatch(baseState({
      status: "completed",
      lifecycle: "terminal",
      runtimeState: "stopped",
      worktreeState: "provisioned",
    }), {
      pendingWorktreeDecisionSince: "2026-03-25T00:00:00.000Z",
    });

    assert.equal(next.lifecycle, "awaiting_worktree_decision");
    assert.equal(next.worktreeState, "pending_decision");
  });

  it("normalizes resolved worktree states to terminal lifecycle", () => {
    const next = applySessionControlPatch(baseState({
      status: "completed",
      lifecycle: "awaiting_worktree_decision",
      runtimeState: "stopped",
      worktreeState: "pending_decision",
    }), {
      worktreeState: "pr_open",
    });

    assert.equal(next.lifecycle, "terminal");
    assert.equal(next.worktreeState, "pr_open");
  });
});
