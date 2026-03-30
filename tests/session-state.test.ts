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
    approvalPromptVersion: undefined,
    approvalPromptStatus: "not_sent",
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
