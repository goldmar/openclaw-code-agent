import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompletedPayload,
  buildDelegateWorktreeWakeMessage,
  buildFailedPayload,
  buildNoChangeDeliverableMessage,
  buildWaitingForInputPayload,
} from "../src/session-notification-builder";

describe("session-notification-builder", () => {
  it("preserves waiting payloads for explicit plan approvals", () => {
    const buttons = [[{ label: "Approve", callback_data: "token-1" }]];
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-1",
        name: "plan-session",
        multiTurn: true,
        pendingPlanApproval: true,
      } as any,
      preview: "Plan preview",
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "ask",
      planApprovalButtons: buttons as any,
    });

    assert.equal(payload.label, "plan-approval");
    assert.equal(payload.userMessage, "📋 [plan-session] Plan ready for approval:\n\nPlan preview\n\nChoose Approve, Revise, or Reject below.");
    assert.equal(payload.buttons, buttons);
    assert.match(payload.wakeMessage, /USER APPROVAL REQUESTED/);
  });

  it("instructs delegated plan reviews to use the buttoned approval prompt", () => {
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

    assert.match(payload.wakeMessage, /agent_request_plan_approval\(session='session-delegate'/);
    assert.match(payload.wakeMessage, /Do NOT send a plain-text-only approval request/);
  });

  it("preserves terminal completion payload formatting", () => {
    const payload = buildCompletedPayload({
      session: {
        id: "session-2",
        name: "done-session",
        status: "completed",
        costUsd: 1.25,
        duration: 61_000,
      } as any,
      originThreadLine: "Origin thread: telegram topic 42",
      preview: "Final output",
      compactSummary: "Implemented the requested fix.",
    });

    assert.equal(payload.userMessage, "✅ [done-session] Completed | $1.25 | 1m1s\n   Summary: Implemented the requested fix.");
    assert.match(payload.wakeMessage, /Coding agent session completed\./);
    assert.match(payload.wakeMessage, /Completion summary:/);
    assert.match(payload.wakeMessage, /Output preview:/);
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
      } as any,
      originThreadLine: "Origin thread: telegram topic 42",
      errorSummary: "rate limit exceeded",
      preview: "Last output",
      worktreeAutoCleaned: false,
    });

    assert.match(payload.wakeMessage, /agent_respond\(session='session-2'/);
    assert.match(payload.wakeMessage, /agent_launch\(resume_session_id='session-2', fork_session=true/);
    assert.match(payload.wakeMessage, /Backend conversation ID: backend-thread-1/);
  });

  it("preserves worktree deliverable cleanup messaging", () => {
    const message = buildNoChangeDeliverableMessage(
      { name: "report-session" } as any,
      "Summary preview",
      false,
      "/tmp/worktree",
    );

    assert.equal(message, "📋 [report-session] Completed with report-only output:\n\nSummary preview\n\nNo code changes were made; worktree cleanup failed. Worktree still exists at /tmp/worktree");
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
});
