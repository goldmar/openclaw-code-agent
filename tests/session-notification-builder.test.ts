import { afterEach, describe, it } from "node:test";
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
import { setOpenClawConfig, setPluginRuntime } from "../src/runtime-store";

afterEach(() => {
  setPluginRuntime(undefined);
  setOpenClawConfig(undefined);
});

describe("session-notification-builder", () => {
  it("builds plugin-owned review summaries for explicit plan approvals", async () => {
    const buttons = [[{ label: "Approve", callback_data: "token-1" }]];
    const payload = await buildWaitingForInputPayload({
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

  it("builds review summaries from structured plan artifacts", async () => {
    const summary = await buildPlanReviewSummary({
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

  it("shows the full finalized plan when it fits the approval prompt budget", async () => {
    const summary = await buildPlanReviewSummary({
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

  it("prefers finalized artifact markdown over preview transcript when structured fields are absent", async () => {
    const summary = await buildPlanReviewSummary({
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

  it("uses the embedded agent to summarize long plans for approval review", async () => {
    const llmCalls: Array<{ prompt: string }> = [];
    setOpenClawConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
          workspace: "/tmp/openclaw",
        },
      },
    });
    setPluginRuntime({
      agent: {
        async runEmbeddedPiAgent(params: any) {
          llmCalls.push({ prompt: params.prompt });
          return {
            payloads: [{
              text: JSON.stringify({
                summary: [
                  "Review summary:",
                  "- Scope: fix the approval prompt so long plans remain reviewable.",
                  "- Planned changes: summarize the finalized plan with balanced coverage of implementation, limitations, and validation.",
                  "- Risks or limitations: summary quality depends on the finalized plan content only.",
                  "- Validation: add focused regression tests for long-plan approval prompts.",
                ].join("\n"),
              }),
            }],
          };
        },
      },
    });

    const longPlanItems = Array.from({ length: 18 }, (_, index) =>
      `${index + 1}. Step ${index + 1}: capture a distinct part of the approval review, keep the wording explicit for users, and preserve enough detail for a usable decision without forcing them back into raw logs.`,
    );
    const summary = await buildPlanReviewSummary({
      preview: [
        "Thinking through the approval flow",
        "Should I proceed?",
      ].join("\n"),
      artifact: {
        markdown: [
          "Proposed plan:",
          ...longPlanItems,
          "",
          "Current limitations:",
          "- Early bullets dominate the current UX",
          "- Tail sections are not visible today",
        ].join("\n"),
        steps: [],
      },
    });

    assert.equal(llmCalls.length, 1);
    assert.match(llmCalls[0]?.prompt ?? "", /FINALIZED_PLAN:/);
    assert.match(llmCalls[0]?.prompt ?? "", /Tail sections are not visible today/);
    assert.doesNotMatch(llmCalls[0]?.prompt ?? "", /Thinking through the approval flow/);
    assert.match(summary, /Review summary:/);
    assert.match(summary, /Scope: fix the approval prompt/);
    assert.match(summary, /Planned changes: summarize the finalized plan/);
    assert.match(summary, /Validation: add focused regression tests/);
  });

  it("falls back to a filtered deterministic summary if embedded generation fails", async () => {
    setPluginRuntime({
      agent: {
        async runEmbeddedPiAgent() {
          throw new Error("provider overloaded");
        },
      },
    });

    const summary = await buildPlanReviewSummary({
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

  it("instructs delegated plan reviews to use structured approval rationale plus orchestrator-owned follow-up", async () => {
    const payload = await buildWaitingForInputPayload({
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

  it("suppresses extra ask-mode plan summaries once a user-visible prompt is proven", async () => {
    const payload = await buildWaitingForInputPayload({
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
