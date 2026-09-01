import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFailedPlanResumeRollbackState,
  buildResumedPlanState,
  resolveCurrentPlanDecisionVersion,
  tokenMatchesAppliedPlanApproval,
} from "../src/plan-decision-state";

const pending = {
  pendingPlanApproval: true,
  approvalState: "pending" as const,
  planApprovalContext: "plan-mode" as const,
  planDecisionVersion: 1,
  actionablePlanDecisionVersion: 1,
  canonicalPlanPromptVersion: 1,
  approvalPromptRequiredVersion: 1,
  approvalPromptVersion: 1,
  approvalPromptStatus: "delivered" as const,
  approvalPromptTransport: "direct-message" as const,
  approvalPromptMessageKind: "canonical_buttons" as const,
};

describe("resumed plan decision state", () => {
  it("preserves an unresolved plan gate across suspended runtime replacement", () => {
    const result = buildResumedPlanState(pending, "default");
    assert.equal(result.permissionMode, "plan");
    assert.equal(result.approvalApplied, false);
    assert.deepEqual(result.patch, {
      pendingPlanApproval: true,
      approvalState: "pending",
      planApprovalContext: "plan-mode",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      canonicalPlanPromptVersion: 1,
      approvalPromptRequiredVersion: 1,
      approvalPromptVersion: 1,
      approvalPromptStatus: "delivered",
      approvalPromptTransport: "direct-message",
      approvalPromptMessageKind: "canonical_buttons",
      approvalPromptLastAttemptAt: undefined,
      approvalPromptDeliveredAt: undefined,
      approvalPromptFailedAt: undefined,
    });
  });

  it("applies an exact pending version on an explicit bypass resume", () => {
    const result = buildResumedPlanState(pending, "bypassPermissions");
    assert.equal(result.approvalApplied, true);
    assert.equal(result.decisionVersion, 1);
    assert.equal(result.patch.pendingPlanApproval, false);
    assert.equal(result.patch.approvalState, "approved");
    assert.equal(result.patch.planDecisionVersion, 2);
    assert.equal(result.patch.actionablePlanDecisionVersion, undefined);
    assert.equal(result.patch.approvalExecutionState, "awaiting_plan_output");
  });

  it("does not manufacture approval when no actionable version exists", () => {
    const result = buildResumedPlanState({
      ...pending,
      planDecisionVersion: 0,
      actionablePlanDecisionVersion: undefined,
      canonicalPlanPromptVersion: undefined,
      approvalPromptRequiredVersion: undefined,
      approvalPromptVersion: undefined,
    }, "bypassPermissions");
    assert.equal(result.approvalApplied, false);
    assert.equal(result.permissionMode, "plan");
    assert.equal(result.patch.pendingPlanApproval, true);
    assert.equal(result.patch.actionablePlanDecisionVersion, undefined);
  });

  it("does not approve or recreate an actionable version after changes were requested", () => {
    const result = buildResumedPlanState({
      ...pending,
      approvalState: "changes_requested",
      planDecisionVersion: 2,
      actionablePlanDecisionVersion: undefined,
      canonicalPlanPromptVersion: undefined,
      approvalPromptRequiredVersion: undefined,
      approvalPromptVersion: undefined,
    }, "bypassPermissions");
    assert.equal(result.approvalApplied, false);
    assert.equal(result.permissionMode, "plan");
    assert.equal(result.decisionVersion, 2);
    assert.equal(result.patch.pendingPlanApproval, true);
    assert.equal(result.patch.approvalState, "changes_requested");
    assert.equal(result.patch.actionablePlanDecisionVersion, undefined);
  });

  it("keeps terminal worktree cleanup authoritative when a failed approval resume is rolled back", () => {
    const retryablePlan = {
      ...pending,
      sessionId: "stable-plan",
      harnessSessionId: "backend-plan",
      name: "stable-plan",
      prompt: "implement",
      workdir: "/repo",
      worktreePath: "/repo/.worktrees/stable-plan",
      worktreeBranch: "agent/stable-plan",
      status: "killed" as const,
      lifecycle: "suspended" as const,
      costUsd: 0,
    };
    const rollback = buildFailedPlanResumeRollbackState(retryablePlan, {
      ...retryablePlan,
      status: "failed",
      lifecycle: "terminal",
      pendingPlanApproval: false,
      worktreePath: undefined,
      worktreeBranch: undefined,
      worktreeState: "none",
      worktreeDisposition: "no-change-cleaned",
      worktreeLifecycle: {
        state: "no_change",
        baseBranch: "main",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    assert.equal(rollback.pendingPlanApproval, true);
    assert.equal(rollback.lifecycle, "suspended");
    assert.equal(rollback.worktreePath, undefined);
    assert.equal(rollback.worktreeBranch, undefined);
    assert.equal(rollback.worktreeState, "none");
    assert.equal(rollback.worktreeDisposition, "no-change-cleaned");
    assert.equal(rollback.worktreeLifecycle?.state, "no_change");
  });

  it("prefers actionable and delivered versions over stale aggregate state", () => {
    assert.equal(resolveCurrentPlanDecisionVersion({
      ...pending,
      planDecisionVersion: 9,
      actionablePlanDecisionVersion: 3,
    }), 3);
    assert.equal(resolveCurrentPlanDecisionVersion({
      ...pending,
      actionablePlanDecisionVersion: undefined,
      approvalPromptRequiredVersion: 4,
      approvalPromptVersion: 5,
    }), 5);
  });

  it("recognizes only the immediately applied approval version as idempotent", () => {
    const approved = { ...pending, pendingPlanApproval: false, approvalState: "approved" as const, planDecisionVersion: 2 };
    assert.equal(tokenMatchesAppliedPlanApproval({ kind: "plan-approve", planDecisionVersion: 1 }, approved), true);
    assert.equal(tokenMatchesAppliedPlanApproval({ kind: "plan-reject", planDecisionVersion: 1 }, approved), false);
    assert.equal(tokenMatchesAppliedPlanApproval({ kind: "plan-approve", planDecisionVersion: 0 }, approved), false);
    assert.equal(tokenMatchesAppliedPlanApproval({ kind: "plan-approve", planDecisionVersion: 1 }, { ...approved, planDecisionVersion: 3 }), false);
    assert.equal(tokenMatchesAppliedPlanApproval({ kind: "plan-approve", planDecisionVersion: 1 }, { ...approved, approvalState: "rejected" }), false);
  });

  it("never bypasses a rejected plan even if corrupted state still marks it pending", () => {
    const result = buildResumedPlanState({ ...pending, approvalState: "rejected" }, "bypassPermissions");
    assert.equal(result.permissionMode, "plan");
    assert.equal(result.approvalApplied, false);
    assert.equal(result.patch.approvalState, "rejected");
  });
});
