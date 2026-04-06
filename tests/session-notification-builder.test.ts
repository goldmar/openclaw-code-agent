import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanReviewSummary,
  buildPlanApprovalFallbackText,
  buildCompletedPayload,
  buildDelegateWorktreeWakeMessage,
  buildNoChangeWakeMessage,
  buildFailedPayload,
  buildWaitingForInputPayload,
} from "../src/session-notification-builder";

describe("session-notification-builder", () => {
  it("builds plugin-owned review summaries for explicit plan approvals", () => {
    const buttons = [[{ label: "Approve", callback_data: "token-1" }]];
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-1",
        name: "plan-session",
        multiTurn: true,
        pendingPlanApproval: true,
      } as any,
      preview: "1. Inspect the state flow\n2. Update the approval builder\n\nShould I proceed?",
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "ask",
      planApprovalButtons: buttons as any,
    });

    assert.equal(payload.label, "plan-approval");
    assert.match(payload.userMessage ?? "", /Review summary:/);
    assert.match(payload.userMessage ?? "", /- Inspect the state flow/);
    assert.match(payload.userMessage ?? "", /- Update the approval builder/);
    assert.doesNotMatch(payload.userMessage ?? "", /Should I proceed\?/);
    assert.equal(payload.buttons, buttons);
    assert.match(payload.planReviewSummary ?? "", /Review summary:/);
    assert.match(payload.wakeMessage, /USER APPROVAL REQUESTED/);
  });

  it("builds review summaries from structured plan artifacts", () => {
    const summary = buildPlanReviewSummary({
      preview: "ignored preview",
      artifact: {
        explanation: "Keep the scope inside the approval workflow.",
        markdown: "1. Update code\n2. Add tests",
        steps: [
          { step: "Update the plan-approval prompt", status: "pending" },
          { step: "Add focused regression tests", status: "pending" },
        ],
      },
    });

    assert.match(summary, /Review summary:/);
    assert.match(summary, /Keep the scope inside the approval workflow\./);
    assert.match(summary, /- Update the plan-approval prompt/);
    assert.match(summary, /- Add focused regression tests/);
  });

  it("instructs delegated plan reviews to use structured approval rationale plus orchestrator-owned follow-up", () => {
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-delegate",
        name: "delegate-session",
        multiTurn: true,
        pendingPlanApproval: true,
      } as any,
      preview: "Plan preview",
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "delegate",
    });

    assert.equal(payload.userMessage, undefined);
    assert.match(payload.wakeMessage, /Review privately/);
    assert.match(payload.wakeMessage, /you own the user-facing explanation of what was approved and why/i);
    assert.match(payload.wakeMessage, /agent_respond\(session='session-delegate', message='Approved\. Go ahead\.', approve=true, approval_rationale='<brief reason>'\)/);
    assert.match(payload.wakeMessage, /minimal approval acknowledgment, not the explanation/i);
    assert.match(payload.wakeMessage, /agent_request_plan_approval\(session='session-delegate'/);
    assert.match(payload.wakeMessage, /must concisely explain why this was escalated/i);
    assert.match(payload.wakeMessage, /do NOT send a second plain-text recap/i);
  });

  it("suppresses extra ask-mode plan summaries once a user-visible prompt is proven", () => {
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-ask",
        name: "ask-session",
        multiTurn: true,
        pendingPlanApproval: true,
        planDecisionVersion: 4,
        actionablePlanDecisionVersion: 4,
        approvalPromptRequiredVersion: 4,
        approvalPromptStatus: "fallback_delivered",
      } as any,
      preview: "Plan preview",
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "ask",
      planApprovalButtons: undefined,
    });

    assert.equal(payload.userMessage, undefined);
  });

  it("builds explicit plugin-owned fallback text for plan review", () => {
    const message = buildPlanApprovalFallbackText({
      session: {
        id: "session-fallback",
        name: "fallback-session",
        planDecisionVersion: 7,
      } as any,
      summary: "Summary of the plan",
    });

    assert.match(message, /Interactive Approve \/ Revise \/ Reject buttons could not be delivered/);
    assert.match(message, /Reply "approve"/);
    assert.match(message, /Why this was escalated:/);
    assert.match(message, /Summary of the plan/);
  });

  it("preserves terminal completion payload formatting", () => {
    const payload = buildCompletedPayload({
      session: {
        id: "session-2",
        name: "done-session",
        status: "completed",
        costUsd: 1.25,
        duration: 61_000,
        requestedPermissionMode: "plan",
        currentPermissionMode: "bypassPermissions",
        approvalExecutionState: "approved_then_implemented",
      } as any,
      originThreadLine: "Origin thread: telegram topic 42",
      preview: "Final output",
    });

    assert.equal(payload.userMessage, "✅ [done-session] Completed | $1.25 | 1m1s");
    assert.match(payload.wakeMessage, /Coding agent session completed\./);
    assert.match(payload.wakeMessage, /Requested permission mode: plan/);
    assert.match(payload.wakeMessage, /Effective permission mode: bypassPermissions/);
    assert.match(payload.wakeMessage, /Deterministic approval\/execution state: approved_then_implemented/);
    assert.match(payload.wakeMessage, /Output preview:/);
    assert.match(payload.wakeMessage, /plugin already sent the canonical completion status/i);
    assert.match(payload.wakeMessage, /should usually send the user a short factual completion summary/i);
    assert.match(payload.wakeMessage, /ordinary terminal\/manual completions too/i);
    assert.match(payload.wakeMessage, /do NOT repeat the plugin's status line/i);
  });

  it("uses agent_respond as the primary continuation path in failure wakes", () => {
    const payload = buildFailedPayload({
      session: {
        id: "session-2",
        name: "failed-session",
        status: "failed",
        costUsd: 0,
        duration: 10_000,
        harnessSessionId: "backend-thread-1",
        requestedPermissionMode: "plan",
        currentPermissionMode: "default",
        approvalExecutionState: "implemented_without_required_approval",
      } as any,
      originThreadLine: "Origin thread: telegram topic 42",
      errorSummary: "rate limit exceeded",
      preview: "Last output",
      worktreeAutoCleaned: false,
    });

    assert.match(payload.wakeMessage, /agent_respond\(session='session-2'/);
    assert.match(payload.wakeMessage, /agent_launch\(resume_session_id='session-2', fork_session=true/);
    assert.match(payload.wakeMessage, /Backend conversation ID: backend-thread-1/);
    assert.match(payload.wakeMessage, /Deterministic approval\/execution state: implemented_without_required_approval/);
  });

  it("preserves delegate worktree wake instructions", () => {
    const message = buildDelegateWorktreeWakeMessage({
      sessionName: "feature-session",
      sessionId: "session-3",
      branchName: "agent/feature-session",
      baseBranch: "main",
      promptSnippet: "Fix the bug",
      commitLines: ["- feat: implement fix"],
      diffSummary: {
        commits: 1,
        filesChanged: 2,
        insertions: 10,
        deletions: 3,
      },
    });

    assert.match(message, /Branch: agent\/feature-session → main/);
    assert.match(message, /Never call agent_pr\(\) autonomously in delegate mode/);
  });

  it("builds deterministic no-change worktree wakes with preview context", () => {
    const message = buildNoChangeWakeMessage({
      sessionName: "rust-hello-world",
      sessionId: "session-4",
      cleanupSummary: "worktree cleaned up",
      preview: "Built the project and verified the binary prints hello world.",
      originThreadLine: "Origin thread: telegram topic 42",
      requestedPermissionMode: "plan",
      currentPermissionMode: "bypassPermissions",
      approvalExecutionState: "approved_then_implemented",
    });

    assert.match(message, /completed with no repository changes/);
    assert.match(message, /Worktree outcome: worktree cleaned up/);
    assert.match(message, /Requested permission mode: plan/);
    assert.match(message, /Deterministic approval\/execution state: approved_then_implemented/);
    assert.match(message, /Output preview:/);
    assert.match(message, /agent_output\(session='session-4', full=true\)/);
    assert.match(message, /plugin already sent the canonical completion status/i);
    assert.match(message, /should usually send the user a short factual completion summary/i);
    assert.match(message, /ordinary terminal\/manual completions too/i);
    assert.match(message, /do NOT repeat the plugin's status line/i);
  });
});
