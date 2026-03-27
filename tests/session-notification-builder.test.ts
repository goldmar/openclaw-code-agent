import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompletedPayload,
  buildDelegateWorktreeWakeMessage,
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
    assert.equal(payload.userMessage, "📋 [plan-session] Plan ready for approval:\n\nPlan preview\n\nChoose Approve, Reject, or Revise below.");
    assert.equal(payload.buttons, buttons);
    assert.match(payload.wakeMessage, /USER APPROVAL REQUESTED/);
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
    });

    assert.equal(payload.userMessage, "✅ [done-session] Completed | $1.25 | 1m1s");
    assert.match(payload.wakeMessage, /Coding agent session completed\./);
    assert.match(payload.wakeMessage, /Output preview:/);
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
