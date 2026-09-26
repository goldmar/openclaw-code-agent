import "./test-env";
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
  buildGoalTaskSucceededFollowupWake,
  buildWorktreeOutcomeFollowupWake,
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
    assert.match(payload.userMessage ?? "", /Decision brief/);
    assert.match(payload.userMessage ?? "", /Inspect the state flow/);
    assert.match(payload.userMessage ?? "", /Update the approval builder/);
    assert.doesNotMatch(payload.userMessage ?? "", /Should I proceed\?/);
    assert.equal(payload.buttons, buttons);
    assert.match(payload.planReviewSummary ?? "", /Objective \/ scope:/);
    assert.match(payload.wakeMessage, /It is with the user \(planApproval: ask\); do not approve it yourself/);
    assert.match(payload.wakeMessage, /userInitiated=true/);
  });

  it("requires verification and escalation rules in approve-mode plan wakes", () => {
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-approve",
        name: "approve-session",
        multiTurn: true,
        pendingPlanApproval: true,
      } as any,
      preview: "1. Update the parser",
      originThreadLine: "Origin thread: telegram topic 42",
      planApprovalMode: "approve",
    });

    assert.equal(payload.label, "plan-approval");
    assert.doesNotMatch(payload.wakeMessage, /AUTO-APPROVE|Approve it now/);
    assert.match(payload.wakeMessage, /only after verifying the plan/);
    assert.match(payload.wakeMessage, /agent_output\(session='session-approve', full=true\)/);
    assert.match(payload.wakeMessage, /agent_escalate\(session='session-approve', kind='plan'/);
    assert.match(payload.wakeMessage, /approval_rationale=/);
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

    assert.match(summary, /^Objective \/ scope:/);
    assert.match(summary, /Keep the scope inside the approval workflow/);
    assert.match(summary, /Implementation approach:/);
    assert.match(summary, /Update the plan-approval prompt/);
    assert.match(summary, /Add focused regression tests/);
  });

  it("builds a structured decision brief from finalized plan markdown", () => {
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

    assert.match(summary, /^Objective \/ scope:/);
    assert.match(summary, /Trace the current approval path/);
    assert.match(summary, /Render the full plan when it is short enough/);
    assert.match(summary, /Add focused tests/);
  });

  it("compacts a medium plan into one decision prompt", () => {
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

    assert.match(payload.userMessage ?? "", /Decision brief/);
    assert.match(payload.userMessage ?? "", /more routine steps? not shown/);
    assert.equal(payload.userMessages, undefined);
    assert.deepEqual(payload.buttons, buttons);
    assert.match(payload.planReviewSummary ?? "", /Implementation approach:/);
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

    assert.match(summary, /^Objective \/ scope:/);
    assert.match(summary, /Trace the approval summary source/);
    assert.match(summary, /Use finalized plan text for the review summary fallback/);
    assert.match(summary, /Add a focused regression test/);
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
    assert.match(payload.planReviewSummary ?? "", /Objective \/ scope:/);
    assert.match(payload.planReviewSummary ?? "", /Skip the LLM for delegate mode wakeups/);
  });

  it("requires a visible completion follow-up even when full output already contains a meaningful summary", () => {
    const payload = buildCompletedPayload({
      session: {
        id: "session-completed-summary",
        name: "completed-summary",
        status: "completed",
        costUsd: 0.12,
        duration: 12_000,
      } as any,
      originThreadLine: "Origin thread: telegram topic 42",
      preview: [
        "Validation finished. Status: blocked, but we got useful signal.",
        "- Do not start tomorrow as-is.",
        "- Follow up on broker credential checks.",
      ].join("\n"),
    });

    assert.match(payload.wakeMessageOnNotifySuccess, /Tell the user in one or two sentences what was done/);
    assert.match(payload.wakeMessageOnNotifySuccess, /The user saw: ✅ \[completed-summary\] Completed/);
    assert.match(payload.wakeMessageOnNotifySuccess, /do not answer NO_REPLY/);
    assert.doesNotMatch(payload.wakeMessageOnNotifySuccess, /already summarized by completed session/);
  });

  it("keeps worktree follow-up wakes useful when only canonical facts are available", () => {
    const wake = buildWorktreeOutcomeFollowupWake({
      sessionId: "session-worktree-status-only",
      sessionName: "worktree-status-only",
      outcomeLine: "✅ Merged: agent/example -> main",
      originThreadLine: "",
      canonicalStatusDelivered: true,
    });

    assert.match(wake, /The user saw: /);
    assert.match(wake, /Tell the user in one or two sentences what changed/);
    assert.match(wake, /if there is no output, state only the facts above/);
    assert.match(wake, /refer to PRs by number, not URL/);
    assert.match(wake, /do not answer NO_REPLY/);
    assert.doesNotMatch(wake, /COMPLETION_FOLLOWUP_/);
    assert.doesNotMatch(wake, /already summarized by completed session/);
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

    assert.match(summary, /Objective \/ scope:/);
    assert.match(summary, /Inspect the current notification flow/);
    assert.match(summary, /Add a safe fallback summary/);
    assert.doesNotMatch(summary, /Thinking through the notification path/);
    assert.doesNotMatch(summary, /Should I proceed\?/);
  });

  it("includes supplied LLM why-summary for forwarded user questions without echoing raw context", () => {
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
      questionContextSummary: "The plan needs one host-version policy before deployment steps can be finalized.",
      originThreadLine: "Origin thread: telegram topic 42",
    });

    assert.equal(payload.label, "waiting");
    assert.match(payload.userMessage ?? "", /What host-version policy should the plan target\?/);
    assert.match(payload.userMessage ?? "", /Why: The plan needs one host-version policy before deployment steps can be finalized\./);
    assert.doesNotMatch(payload.userMessage ?? "", /two competing conventions/);
    assert.doesNotMatch(payload.userMessage ?? "", /exact image tags/);
    assert.equal((payload.userMessage ?? "").match(/What host-version policy should the plan target\?/g)?.length, 1);
  });

  it("omits why-context when no LLM micro-summary is supplied", () => {
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-question-no-summary",
        name: "question-no-summary",
        multiTurn: true,
        pendingPlanApproval: false,
      } as any,
      preview: "What host-version policy should the plan target?",
      questionText: "What host-version policy should the plan target?",
      questionContextPreview: [
        "This raw recent output should not appear.",
        "What host-version policy should the plan target?",
      ].join("\n"),
      originThreadLine: "Origin thread: telegram topic 42",
    });

    assert.match(payload.userMessage ?? "", /What host-version policy should the plan target\?/);
    assert.doesNotMatch(payload.userMessage ?? "", /Why:/);
    assert.doesNotMatch(payload.userMessage ?? "", /raw recent output/);
  });

  it("omits recent context walls from button-backed question prompts", () => {
    const payload = buildWaitingForInputPayload({
      session: {
        id: "session-question-buttons",
        name: "question-buttons",
        multiTurn: true,
        pendingPlanApproval: false,
      } as any,
      preview: "Which environment should I target?",
      questionText: "Question 1 - Environment\nWhich environment should I target?\nOptions:\n  1. Staging\n  2. Production",
      questionContextPreview: [
        "I traced deployment history across a long transcript.",
        "This context line should not appear in the button-backed prompt.",
        "Which environment should I target?",
      ].join("\n"),
      questionContextSummary: "Deployment history narrowed this to the target environment.",
      originThreadLine: "Origin thread: telegram topic 42",
      questionButtons: [[
        { label: "Staging", callbackData: "stage-token" },
        { label: "Production", callbackData: "prod-token" },
      ]],
    });

    assert.equal(payload.label, "waiting");
    assert.match(payload.userMessage ?? "", /Question 1 - Environment/);
    assert.match(payload.userMessage ?? "", /Which environment should I target\?/);
    assert.match(payload.userMessage ?? "", /Options:/);
    assert.match(payload.userMessage ?? "", /Why: Deployment history narrowed this to the target environment\./);
    assert.doesNotMatch(payload.userMessage ?? "", /long transcript/);
    assert.doesNotMatch(payload.userMessage ?? "", /This context line should not appear/);
    assert.deepEqual(payload.buttons?.[0]?.map((button) => button.label), ["Staging", "Production"]);
  });

  it("does not fall back to a raw context wall when no micro-summary is available", () => {
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

    assert.match(payload.userMessage ?? "", /Which policy should we use\?/);
    assert.doesNotMatch(payload.userMessage ?? "", new RegExp(recentLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(payload.userMessage ?? "", new RegExp(latestLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(payload.userMessage ?? "", new RegExp(oldLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("preserves validation details in very large numbered plans", () => {
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
    assert.ok(payload.userMessages!.every((message) => message.text.length <= 3_000));
    assert.match(payload.userMessages!.map((message) => message.text).join("\n"), /Step 90:/);
    assert.equal(payload.userMessages!.filter((message) => message.buttons).length, 1);
    assert.deepEqual(payload.userMessages!.at(-1)!.buttons, buttons);
  });

  it("keeps compact approval prompts within the platform budget", () => {
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

    assert.ok((payload.userMessage ?? "").length <= 3_200);
    assert.match(payload.userMessage ?? "", /more routine steps? not shown/);
    assert.deepEqual(payload.buttons, buttons);
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

    assert.ok((payload.userMessage ?? "").length <= 3_200);
    assert.match(payload.userMessage ?? "", /\.\.\./);
    assert.match(payload.userMessage ?? "", /Choose Approve, Revise, or Reject below\./);
    assert.deepEqual(payload.buttons, buttons);
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
    assert.match(payload.wakeMessage, /You review it \(planApproval: delegate\)/);
    assert.match(payload.wakeMessage, /read the whole plan first: agent_output\(session='session-delegate', full=true\)/);
    assert.match(payload.wakeMessage, /agent_respond\(session='session-delegate', message='Approved\. Go ahead\.', approve=true, approval_rationale='<one line: why it is safe>'\)/);
    // N36: the rationale is shown to the user, so no separate explanation is requested.
    assert.match(payload.wakeMessage, /The user sees your rationale in the approval notice; no other message is needed/);
    assert.match(payload.wakeMessage, /agent_escalate\(session='session-delegate', kind='plan', summary='<why, what changes, risk>'\), then wait for the user/);
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
    assert.doesNotMatch(message, /Decision context:/);
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
    assert.match(payload.wakeMessageOnNotifySuccess, /^\[done-session\] Completed\. ID: session-2/);
    assert.doesNotMatch(payload.wakeMessageOnNotifySuccess, /Requested permission mode|approved_then_implemented/);
    assert.match(payload.wakeMessageOnNotifySuccess, /Output \(end\):/);
    assert.match(payload.wakeMessageOnNotifySuccess, /The user saw: ✅ \[done-session\] Completed/);
    assert.match(payload.wakeMessageOnNotifyFailed, /did NOT reach the user/);
    assert.match(payload.wakeMessageOnNotifySuccess, /Tell the user in one or two sentences what was done/i);
    assert.doesNotMatch(payload.wakeMessageOnNotifySuccess, /already summarized by completed session/);
    assert.match(payload.wakeMessageOnNotifySuccess, /Do not repeat the status line/);
    assert.match(payload.wakeMessageOnNotifyFailed, /The status line did NOT reach the user: .* — include the outcome in your message\./);
  });

  it("includes harness and model in terminal completion status lines", () => {
    const payload = buildCompletedPayload({
      session: {
        id: "session-2",
        name: "done-session",
        status: "completed",
        costUsd: 1.25,
        duration: 61_000,
        harnessName: "codex",
        model: "gpt-5.5",
      } as any,
      originThreadLine: "",
      preview: "Final output",
    });

    assert.equal(payload.userMessage, "✅ [done-session] Completed | $1.25 | 1m1s | codex | gpt-5.5");
  });

  it("omits route-block follow-up guidance when terminal completion has no origin route block", () => {
    const payload = buildCompletedPayload({
      session: {
        id: "session-no-route",
        name: "done-session",
        status: "completed",
        costUsd: 0,
        duration: 1_000,
      } as any,
      originThreadLine: "",
      preview: "Final output",
    });

    assert.match(payload.wakeMessageOnNotifySuccess, /Tell the user in one or two sentences what was done/i);
    assert.doesNotMatch(payload.wakeMessageOnNotifySuccess, /already summarized by completed session/);
    assert.doesNotMatch(payload.wakeMessageOnNotifySuccess, /originRoute/);
  });

  it("builds marker-free goal success follow-up wakes", () => {
    const message = buildGoalTaskSucceededFollowupWake({
      sessionId: "session-goal-summary",
      sessionName: "trading-platform-readiness-gate-fix-restart",
      taskName: "trading-platform-readiness-gate-fix-restart",
      summary: [
        "✅ [trading-platform-readiness-gate-fix-restart] Goal task succeeded",
        "",
        'Completion promise "READINESS_GATE_FIX_RESTART_DONE" detected in agent output.',
      ].join("\n"),
      originThreadLine: [
        "Session origin route (authoritative for human follow-ups):",
        'originRoute: {"provider":"telegram","target":"-1001234567890","threadId":"32947","sessionKey":"agent:x:telegram:channel:-1001234567890:topic:32947"}',
        "Routing rule: Send any human follow-up for this wake to originRoute. If originRoute differs from the current chat, do not use a plain final assistant reply; use a routed send path that preserves provider/target/threadId.",
      ].join("\n"),
      canonicalStatusDelivered: true,
    });

    assert.match(message, /Goal task trading-platform-readiness-gate-fix-restart succeeded\./);
    assert.doesNotMatch(message, /COMPLETION_FOLLOWUP_/);
    assert.match(message, /do not answer NO_REPLY/);
    assert.match(message, /Tell the user in one or two sentences what was achieved/);
    assert.match(message, /"threadId":"32947"/);
    assert.doesNotMatch(message, /already summarized by completed session/);
  });

  it("omits raw PR URLs from worktree follow-up wake content", () => {
    const message = buildWorktreeOutcomeFollowupWake({
      sessionId: "session-pr-summary",
      sessionName: "format-launch-notification-model-separator",
      outcomeLine: "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/185",
      originThreadLine: "",
      detailLines: [
        "PR URL: https://github.com/goldmar/openclaw-code-agent/pull/185.",
        "PR number: #185.",
        "Updated PR for branch agent/format-launch-notification-model-separator into main.",
      ],
      canonicalStatusDelivered: true,
    });

    assert.doesNotMatch(message, /https:\/\/github\.com\/goldmar\/openclaw-code-agent\/pull\/185/);
    assert.match(message, /PR #185/);
    assert.match(message, /refer to PRs by number, not URL/);
    assert.doesNotMatch(message, /COMPLETION_FOLLOWUP_/);
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
    assert.match(payload.wakeMessage, /⚠️ Approval: the session implemented changes without the required plan approval/);
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

    assert.match(message, /Finished on agent\/feature-session → main/);
    assert.match(message, /agent_output\(session='session-3', full=true\)/);
    assert.match(message, /Do not call agent_pr yourself/);
    assert.match(message, /agent_merge\(session='feature-session', summary=/);
    assert.match(message, /agent_escalate\(session='feature-session', kind='worktree'/);
    assert.doesNotMatch(message, /originRoute/);
  });

  it("includes routed follow-up guidance in delegate worktree wakes with an origin route block", () => {
    const message = buildDelegateWorktreeWakeMessage({
      sessionName: "feature-session",
      sessionId: "session-3",
      branchName: "agent/feature-session",
      baseBranch: "main",
      promptSnippet: "Fix the bug",
      commitLines: ["- feat: implement fix"],
      originThreadLine: "Session origin route (authoritative for human follow-ups):\noriginRoute: {\"provider\":\"telegram\",\"target\":\"-1001234567890\",\"threadId\":\"13832\"}",
      diffSummary: {
        commits: 1,
        filesChanged: 2,
        insertions: 10,
        deletions: 3,
      },
    });

    assert.equal((message.match(/originRoute/g) ?? []).length, 1, "the route is stated once (N51)");
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

    assert.match(message, /Completed with no branch changes to merge\. Worktree cleaned up\./);
    assert.doesNotMatch(message, /Requested permission mode|approved_then_implemented/);
    assert.match(message, /Output \(end\):/);
    assert.match(message, /agent_output\(session='session-4', full=true\)/);
    assert.match(message, /Tell the user in one or two sentences what was done/i);
    assert.doesNotMatch(message, /already summarized by completed session/);
    assert.match(message, /Do not repeat the status line/);
  });

  it("omits route-block follow-up guidance when no-change wakes have no origin route block", () => {
    const message = buildNoChangeWakeMessage({
      sessionName: "rust-hello-world",
      sessionId: "session-4",
      cleanupSummary: "worktree cleaned up",
      preview: "Built the project and verified the binary prints hello world.",
    });

    assert.match(message, /Completed with no branch changes to merge/);
    assert.match(message, /Tell the user in one or two sentences what was done/i);
    assert.doesNotMatch(message, /already summarized by completed session/);
    assert.doesNotMatch(message, /originRoute/);
  });
});
