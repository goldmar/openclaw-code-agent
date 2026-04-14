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

    assert.match(summary, /^Full plan:/);
    assert.match(summary, /1\. Update code/);
    assert.match(summary, /2\. Add tests/);
  });

  it("shows the full finalized plan when it fits the approval prompt budget", () => {
    const summary = buildPlanReviewSummary({
      preview: "ignored preview",
      artifact: {
        markdown: [
          "## Proposed plan",
          "1. Trace the current approval path",
          "2. Render the full plan when it is short enough",
          "3. Add focused tests",
        ].join("\n"),
        steps: [],
      },
    });

    assert.match(summary, /^Full plan:/);
    assert.match(summary, /Trace the current approval path/);
    assert.match(summary, /Render the full plan when it is short enough/);
    assert.match(summary, /Add focused tests/);
  });

  it("paginates the full finalized plan across multiple approval messages and keeps buttons for the final chunk", () => {
    const buttons = [[
      { label: "Approve", callback_data: "approve-token" },
      { label: "Revise", callback_data: "revise-token" },
      { label: "Reject", callback_data: "reject-token" },
    ]];
    const mediumPlanItems = Array.from({ length: 32 }, (_, index) =>
      `${index + 1}. Step ${index + 1}: update a specific approval path detail while keeping the final plan explicit enough for human review without leaking transcript chatter.`,
    );

    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-chunked",
        name: "chunked-plan",
        multiTurn: true,
        pendingPlanApproval: true,
        planDecisionVersion: 9,
        actionablePlanDecisionVersion: 9,
      } as any,
      preview: "running progress that should not be used here",
      planArtifact: {
        markdown: ["## Proposed plan", ...mediumPlanItems].join("\n"),
        steps: [],
      },
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "ask",
      planApprovalButtons: buttons as any,
    });

    assert.equal(payload.userMessage, undefined);
    assert.ok(payload.userMessages);
    assert.ok((payload.userMessages?.length ?? 0) > 1);
    assert.match(payload.userMessages?.[0]?.text ?? "", /ready for approval \(1\//);
    assert.match(payload.userMessages?.[0]?.text ?? "", /Full plan:/);
    assert.match(payload.userMessages?.at(-1)?.text ?? "", /Choose Approve, Revise, or Reject below\./);
    assert.equal(payload.userMessages?.[0]?.buttons, undefined);
    assert.deepEqual(payload.userMessages?.at(-1)?.buttons, buttons);
    assert.match(payload.planReviewSummary ?? "", /Review summary:/);
  });

  it("prefers finalized artifact markdown over preview transcript when structured fields are absent", () => {
    const summary = buildPlanReviewSummary({
      preview: [
        "Thinking through the approval flow",
        "Checking whether the last wake already contains the summary",
        "Review summary:",
        "Plan:",
        "1. This is raw running progress, not the final plan",
      ].join("\n"),
      artifact: {
        markdown: [
          "Proposed plan:",
          "1. Trace the approval summary source",
          "2. Use finalized plan text for the review summary fallback",
          "3. Add a focused regression test",
        ].join("\n"),
        steps: [],
      },
    });

    assert.match(summary, /^Full plan:/);
    assert.match(summary, /1\. Trace the approval summary source/);
    assert.match(summary, /2\. Use finalized plan text for the review summary fallback/);
    assert.match(summary, /3\. Add a focused regression test/);
    assert.doesNotMatch(summary, /Thinking through the approval flow/);
    assert.doesNotMatch(summary, /raw running progress/);
  });

  it("keeps delegated approvals on the deterministic fallback summary path", () => {
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-delegate-fast",
        name: "delegate-fast",
        multiTurn: true,
        pendingPlanApproval: true,
      } as any,
      preview: [
        "1. Inspect the current notification flow",
        "2. Skip the LLM for delegate mode wakeups",
        "Should I proceed?",
      ].join("\n"),
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "delegate",
    });

    assert.equal(payload.userMessage, undefined);
    assert.match(payload.planReviewSummary ?? "", /Review summary:/);
    assert.match(payload.planReviewSummary ?? "", /Skip the LLM for delegate mode wakeups/);
  });

  it("falls back to a filtered deterministic summary when no finalized plan exists", () => {
    const summary = buildPlanReviewSummary({
      preview: [
        "Thinking through the notification path",
        "1. Inspect the current notification flow",
        "2. Add a safe fallback summary",
        "Should I proceed?",
      ].join("\n"),
    });

    assert.match(summary, /Review summary:/);
    assert.match(summary, /- Inspect the current notification flow/);
    assert.match(summary, /- Add a safe fallback summary/);
    assert.doesNotMatch(summary, /Thinking through the notification path/);
    assert.doesNotMatch(summary, /Should I proceed\?/);
  });

  it("includes concise recent context for forwarded user questions without echoing the question twice", () => {
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-question-context",
        name: "question-context",
        multiTurn: true,
        pendingPlanApproval: false,
      } as any,
      preview: "What host-version policy should the plan target?",
      questionText: "What host-version policy should the plan target?",
      questionContextPreview: [
        "I traced the existing host-version handling and found two competing conventions.",
        "The repo currently pins Docker hosts to a yearly baseline, but the deployment plan draft switched to exact image tags.",
        "What host-version policy should the plan target?",
      ].join("\n"),
      originThreadLine: "Origin thread: telegram topic 42",
    });

    assert.equal(payload.label, "waiting");
    assert.match(payload.userMessage ?? "", /Question:/);
    assert.match(payload.userMessage ?? "", /What host-version policy should the plan target\?/);
    assert.match(payload.userMessage ?? "", /Recent context:/);
    assert.match(payload.userMessage ?? "", /two competing conventions/);
    assert.match(payload.userMessage ?? "", /deployment plan draft switched to exact image tags/);
    assert.equal((payload.userMessage ?? "").match(/What host-version policy should the plan target\?/g)?.length, 1);
  });

  it("keeps the newest complete lines when question context must be truncated", () => {
    const oldLine = "Older context line ".repeat(28).trimEnd();
    const middleLine = "Middle context line ".repeat(24).trimEnd();
    const recentLine = "The user-visible policy conflict is between annual baselines and exact tags.";
    const latestLine = "The question is asking which policy should govern the plan.";
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-question-context-truncated",
        name: "question-context-truncated",
        multiTurn: true,
        pendingPlanApproval: false,
      } as any,
      preview: "Which policy should we use?",
      questionText: "Which policy should we use?",
      questionContextPreview: [
        oldLine,
        middleLine,
        recentLine,
        latestLine,
        "Which policy should we use?",
      ].join("\n"),
      originThreadLine: "Origin thread: telegram topic 42",
    });

    assert.match(payload.userMessage ?? "", new RegExp(recentLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(payload.userMessage ?? "", new RegExp(latestLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(payload.userMessage ?? "", new RegExp(oldLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("keeps paginating the full finalized plan instead of switching to a semantic summary for very large plans", () => {
    const hugePlanItems = Array.from({ length: 90 }, (_, index) =>
      `${index + 1}. Step ${index + 1}: update a distinct approval-review surface with explicit wording and detailed validation notes so the finalized plan is intentionally larger than the full-plan pagination budget for a single approval prompt flow.`,
    );
    const buttons = [[{ label: "Approve", callback_data: "approve-token" }]];

    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-summary",
        name: "summary-plan",
        multiTurn: true,
        pendingPlanApproval: true,
        planDecisionVersion: 11,
        actionablePlanDecisionVersion: 11,
      } as any,
      preview: "running progress should not be used",
      planArtifact: {
        markdown: ["## Proposed plan", ...hugePlanItems].join("\n"),
        steps: [],
      },
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "ask",
      planApprovalButtons: buttons as any,
    });

    assert.equal(payload.userMessage, undefined);
    assert.ok(payload.userMessages);
    assert.ok((payload.userMessages?.length ?? 0) > 2);
    assert.match(payload.userMessages?.[0]?.text ?? "", /Full plan:/);
    assert.match(payload.userMessages?.at(-1)?.text ?? "", /Choose Approve, Revise, or Reject below\./);
    assert.deepEqual(payload.userMessages?.at(-1)?.buttons, buttons);
  });

  it("rebalances chunk sizes instead of dropping oversized approval messages", () => {
    const buttons = [[{ label: "Approve", callback_data: "approve-token" }]];
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-long-name",
        name: "plan-session-with-an-intentionally-very-long-name-that-would-otherwise-push-chunk-headers-over-the-message-budget-when-combined-with-large-plan-bodies",
        multiTurn: true,
        pendingPlanApproval: true,
        planDecisionVersion: 12,
        actionablePlanDecisionVersion: 12,
      } as any,
      preview: "running progress should not be used",
      planArtifact: {
        markdown: Array.from({ length: 24 }, (_, index) =>
          `${index + 1}. ${"Detailed implementation note ".repeat(12)}${index + 1}`,
        ).join("\n"),
        steps: [],
      },
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "ask",
      planApprovalButtons: buttons as any,
    });

    assert.equal(payload.userMessage, undefined);
    assert.ok(payload.userMessages);
    assert.ok((payload.userMessages?.length ?? 0) > 1);
    for (const [index, message] of (payload.userMessages ?? []).entries()) {
      assert.ok(message.text.length <= 3_000, `chunk ${index + 1} exceeded the message budget`);
      assert.match(message.text, new RegExp(`ready for approval \\(${index + 1}/${payload.userMessages?.length}\\):`));
    }
    assert.match(payload.userMessages?.at(-1)?.text ?? "", /Choose Approve, Revise, or Reject below\./);
    assert.deepEqual(payload.userMessages?.at(-1)?.buttons, buttons);
  });

  it("keeps ask-mode approval prompts deliverable for extreme session names", () => {
    const buttons = [[{ label: "Approve", callback_data: "approve-token" }]];
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-long-name-truncated",
        name: "session-".repeat(80),
        multiTurn: true,
        pendingPlanApproval: true,
        planDecisionVersion: 13,
        actionablePlanDecisionVersion: 13,
      } as any,
      preview: "running progress should not be used",
      planArtifact: {
        markdown: Array.from(
          { length: 48 },
          (_, index) => `${index + 1}. Keep the prompt resilient even when the session name is excessively long.`,
        ).join("\n"),
        steps: [],
      },
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "ask",
      planApprovalButtons: buttons as any,
    });

    assert.equal(payload.userMessage, undefined);
    assert.ok(payload.userMessages);
    assert.match(payload.userMessages?.[0]?.text ?? "", /ready for approval \(1\//);
    assert.match(payload.userMessages?.[0]?.text ?? "", /\.\.\./);
    assert.match(payload.userMessages?.at(-1)?.text ?? "", /Choose Approve, Revise, or Reject below\./);
    assert.deepEqual(payload.userMessages?.at(-1)?.buttons, buttons);
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
    assert.equal(payload.followupContract.requiresShortFactualSummary, true);
    assert.equal(payload.followupContract.appliesToOrdinaryTerminalCompletions, true);
    assert.match(payload.wakeMessageOnNotifySuccess, /Coding agent session completed\./);
    assert.match(payload.wakeMessageOnNotifySuccess, /Requested permission mode: plan/);
    assert.match(payload.wakeMessageOnNotifySuccess, /Effective permission mode: bypassPermissions/);
    assert.match(payload.wakeMessageOnNotifySuccess, /Deterministic approval\/execution state: approved_then_implemented/);
    assert.match(payload.wakeMessageOnNotifySuccess, /Output preview:/);
    assert.match(payload.wakeMessageOnNotifySuccess, /Canonical completion status delivered to user: yes/);
    assert.match(payload.wakeMessageOnNotifySuccess, /Plugin requested short factual follow-up summary: yes/);
    assert.match(payload.wakeMessageOnNotifySuccess, /must send the user a short factual completion summary/i);
    assert.match(payload.wakeMessageOnNotifySuccess, /ordinary terminal\/manual completions too/i);
    assert.match(payload.wakeMessageOnNotifySuccess, /do NOT repeat the plugin's status line/i);
    assert.match(payload.wakeMessageOnNotifyFailed, /Canonical completion status delivered to user: no/);
    assert.match(payload.wakeMessageOnNotifyFailed, /did not confirm delivery of the canonical completion status/i);
    assert.match(payload.wakeMessageOnNotifyFailed, /do NOT assume the plugin already reached the user/i);
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
    assert.match(message, /must send the user a short factual completion summary/i);
    assert.match(message, /ordinary terminal\/manual completions too/i);
    assert.match(message, /do NOT repeat the plugin's status line/i);
  });
});
