import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionLifecycleService } from "../src/session-lifecycle-service";
import { createStubSession } from "./helpers";

describe("SessionLifecycleService", () => {
  const originalConsoleInfo = console.info;

  afterEach(() => {
    console.info = originalConsoleInfo;
  });

  it("skips worktree terminal handling for goal-owned sessions", async () => {
    const clearedRetryTimers: string[] = [];
    let worktreeCalls = 0;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => {
        worktreeCalls += 1;
        return {
          notificationSent: false,
          worktreeRemoved: false,
        };
      },
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: () => {},
      notifySession: () => {},
      clearRetryTimersForSession: (sessionId: string) => {
        clearedRetryTimers.push(sessionId);
      },
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Codex reached the policy selection step after reading the plugin configuration.",
      originThreadLine: () => "",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    const session = createStubSession({
      id: "session-1",
      name: "goal-task",
      status: "completed",
      goalTaskId: "goal-1",
      worktreePath: "/tmp/worktree",
      originalWorkdir: "/tmp/repo",
    });

    await service.handleSessionTerminal(session);

    assert.equal(worktreeCalls, 0);
    assert.deepEqual(clearedRetryTimers, ["session-1"]);
  });

  it("emits completion wakes with an explicit follow-up contract and success diagnostics", () => {
    const requests: Array<Record<string, unknown>> = [];
    const infoLogs: string[] = [];
    console.info = (message?: unknown, ...rest: unknown[]) => {
      infoLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeSucceeded?.();
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Final output",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    service.emitCompleted(createStubSession({
      id: "session-complete",
      name: "complete-session",
      status: "completed",
      duration: 15_000,
      costUsd: 0.25,
      requestedPermissionMode: "plan",
      currentPermissionMode: "bypassPermissions",
      approvalExecutionState: "approved_then_implemented",
    }));

    assert.equal(requests.length, 1);
    const request = requests[0] as {
      wakeMessage?: string;
      wakeMessageOnNotifySuccess?: string;
      wakeMessageOnNotifyFailed?: string;
      requireDirectUserNotification?: boolean;
    };
    assert.equal(request.wakeMessage, undefined);
    assert.equal(request.requireDirectUserNotification, true);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /Plugin requested short factual follow-up summary: yes/);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /send the user one short factual completion summary/i);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /Do this even when agent_output already contains a good final summary/);
    assert.doesNotMatch(request.wakeMessageOnNotifySuccess ?? "", /already summarized by completed session/);
    assert.match(request.wakeMessageOnNotifyFailed ?? "", /Canonical completion status delivered to user: no/);
    assert.ok(infoLogs.some((line) => line.includes("\"event\":\"completion_notify_succeeded\"") && line.includes("\"requestedShortFactualSummary\":true")));
    assert.ok(infoLogs.some((line) => line.includes("\"event\":\"completion_wake_succeeded\"") && line.includes("\"canonicalStatusDelivered\":true")));
  });

  it("does not emit a second completion follow-up after a worktree outcome notification", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let terminalWakeChecks = 0;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => {
        requests.push({
          label: "worktree-merge-success",
          userMessage: "✅ Merged: agent/example → main (4 files, +531/-0)",
          completionWakeSummaryRequired: true,
          wakeMessageOnNotifySuccess: "Worktree follow-through outcome recorded.",
        });
        return {
          notificationSent: true,
          worktreeRemoved: true,
        };
      },
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => {
        terminalWakeChecks += 1;
        return true;
      },
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Implementation summary already in agent output.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    await service.handleSessionTerminal(createStubSession({
      id: "session-worktree-merge",
      name: "portfolio-move-summary",
      status: "completed",
      duration: 12_000,
      worktreePath: "/tmp/worktree",
      originalWorkdir: "/tmp/repo",
      worktreeStrategy: "auto-merge",
    }));

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.label, "worktree-merge-success");
    assert.equal(requests[0]?.completionWakeSummaryRequired, true);
    assert.equal(terminalWakeChecks, 0);
  });

  it("keeps completion follow-up summaries for degraded routes that still recover to a direct user route", () => {
    const requests: Array<Record<string, unknown>> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Final output",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    service.emitCompleted(createStubSession({
      id: "session-recoverable-route",
      name: "recoverable-route",
      status: "completed",
      duration: 8_000,
      route: {
        provider: "system",
        target: "system",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
      },
      originChannel: "telegram",
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
    }));

    assert.equal(requests.length, 1);
    const request = requests[0] as {
      completionWakeSummaryRequired?: boolean;
      wakeMessageOnNotifySuccess?: string;
      wakeMessageOnNotifyFailed?: string;
    };
    assert.equal(request.completionWakeSummaryRequired, true);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /send the user one short factual completion summary/i);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /Do this even when agent_output already contains a good final summary/);
    assert.doesNotMatch(request.wakeMessageOnNotifySuccess ?? "", /already summarized by completed session/);
    assert.match(request.wakeMessageOnNotifyFailed ?? "", /Canonical completion status delivered to user: no/i);
  });

  it("does not re-enter ask-mode prompt delivery once the current plan prompt is already proven", () => {
    const requests: Array<Record<string, unknown>> = [];
    const persistedUpdates: Array<Record<string, unknown>> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: (_sessionId, patch) => {
        persistedUpdates.push(patch as Record<string, unknown>);
        return true;
      },
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [[{ label: "Approve", callbackData: "approve-token" }]],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Plan preview",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    service.emitWaitingForInput(createStubSession({
      id: "session-proven-prompt",
      name: "proven-prompt",
      pendingPlanApproval: true,
      planDecisionVersion: 5,
      actionablePlanDecisionVersion: 5,
      approvalPromptRequiredVersion: 5,
      approvalPromptStatus: "delivered",
      latestPlanArtifactVersion: 5,
      latestPlanArtifact: {
        markdown: "1. Keep using the existing prompt",
        steps: [],
      },
    }));

    assert.equal(requests.length, 1);
    const request = requests[0] as {
      notifyUser?: string;
      wakeMessage?: string;
      wakeMessageOnNotifySuccess?: string;
      onUserNotifyFailed?: () => void;
      hooks?: Record<string, unknown>;
      userMessage?: string;
      userMessages?: unknown[];
    };
    assert.equal(request.notifyUser, "never");
    assert.match(request.wakeMessage ?? "", /USER APPROVAL REQUESTED/);
    assert.equal(request.wakeMessageOnNotifySuccess, undefined);
    assert.equal(request.onUserNotifyFailed, undefined);
    assert.equal(request.userMessage, undefined);
    assert.equal(request.userMessages, undefined);
    assert.equal(request.hooks, undefined);
    assert.deepEqual(persistedUpdates, []);
  });

  it("adds a plan-decision delivery guard that closes when the pending plan is rejected", () => {
    const requests: Array<Record<string, unknown>> = [];
    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [[{ label: "Reject", callbackData: "reject-token" }]],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Plan v2 preview",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });
    const session = createStubSession({
      id: "session-plan-v2",
      name: "plan-v2",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 2,
      actionablePlanDecisionVersion: 2,
      latestPlanArtifactVersion: 2,
      latestPlanArtifact: {
        markdown: "1. Revised Plan v2 step",
        steps: [],
      },
    });

    service.emitWaitingForInput(session);

    assert.equal(requests.length, 1);
    const request = requests[0] as { shouldDispatch?: () => boolean };
    assert.equal(request.shouldDispatch?.(), true);

    session.pendingPlanApproval = false;
    session.approvalState = "rejected";
    session.lifecycle = "terminal";
    session.planDecisionVersion = 3;
    session.actionablePlanDecisionVersion = undefined;

    assert.equal(request.shouldDispatch?.(), false);
  });

  it("adds a pending-input question delivery guard that closes when the request is cleared", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Codex needs one answer before it can continue.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });
    const session = createStubSession({
      id: "session-question-guard",
      name: "question-guard",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-question-guard",
        kind: "question",
        promptText: "Which environment should I target?",
        options: ["Staging", "Production"],
      },
    });

    await service.emitWaitingForInput(session);

    assert.equal(requests.length, 1);
    const request = requests[0] as { shouldDispatch?: () => boolean };
    assert.equal(request.shouldDispatch?.(), true);

    session.pendingInputState = undefined;

    assert.equal(request.shouldDispatch?.(), false);
  });

  it("blocks stale structured question notifications when the active question changes before dispatch", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let summaryStarted!: () => void;
    let releaseSummary!: (value: { summary: string }) => void;
    const summaryStartedPromise = new Promise<void>((resolve) => {
      summaryStarted = resolve;
    });
    const summaryPromise = new Promise<{ summary: string }>((resolve) => {
      releaseSummary = resolve;
    });
    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Codex is collecting deployment inputs.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary() {
          summaryStarted();
          return summaryPromise;
        },
      },
    });
    const session = createStubSession({
      id: "session-stale-structured-question",
      name: "stale-structured-question",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-stale-structured-question",
        kind: "question",
        promptText: "Answer the deployment questions.",
        options: [],
        activeQuestionIndex: 0,
        questions: [
          {
            id: "environment",
            question: "Which environment should I target?",
            options: [
              { label: "Staging" },
              { label: "Production" },
            ],
          },
          {
            id: "scope",
            question: "How broad should the rollout be?",
            options: [
              { label: "Canary" },
              { label: "Everyone" },
            ],
          },
        ],
      },
    });

    const emitPromise = service.emitWaitingForInput(session);
    await summaryStartedPromise;

    session.pendingInputState = {
      ...session.pendingInputState,
      activeQuestionIndex: 1,
    };
    releaseSummary({ summary: "Codex needs the target environment before it can continue." });
    await emitPromise;

    assert.equal(requests.length, 1);
    const request = requests[0] as { shouldDispatch?: () => boolean };
    assert.equal(request.shouldDispatch?.(), false);
  });

  it("reuses the question context preview when promptText is unavailable", () => {
    const requests: Array<Record<string, unknown>> = [];
    let previewCalls = 0;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => {
        previewCalls += 1;
        return "Fallback preview";
      },
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    service.emitWaitingForInput(createStubSession({
      id: "session-fallback-preview",
      name: "fallback-preview",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-fallback-preview",
        kind: "question",
        promptText: "",
        options: [],
      },
    }));

    assert.equal(previewCalls, 1);
    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), /Fallback preview/);
  });

  it("renders queued multi-question pending input one step at a time with buttons", () => {
    const requests: Array<Record<string, unknown>> = [];
    const questionButtonCalls: Array<{
      options: Array<{ label: string }>;
      context?: { requestId?: string; questionId?: string };
    }> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options, context) => {
        questionButtonCalls.push({ options, context });
        return [options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` }))];
      },
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Fallback preview",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    const session = createStubSession({
      id: "session-multi-question",
      name: "multi-question",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-multi-question",
        kind: "question",
        promptText: [
          "Question 1 - Environment",
          "Which environment should I target?",
          "Options:",
          "  1. Staging - Use staging credentials.",
          "  2. Production - Use production credentials.",
        ].join("\n"),
        options: ["Staging", "Production"],
        activeQuestionIndex: 0,
        questions: [{
          id: "environment",
          header: "Environment",
          question: "Which environment should I target?",
          options: [
            { label: "Staging", description: "Use staging credentials." },
            { label: "Production", description: "Use production credentials." },
          ],
        }, {
          id: "scope",
          header: "Scope",
          question: "How broad should the rollout be?",
          options: [
            { label: "Canary", description: "Start with a small cohort." },
            { label: "Everyone", description: "Roll out to all users." },
          ],
        }],
      },
    });

    service.emitWaitingForInput(session);

    assert.equal(questionButtonCalls.length, 1);
    assert.deepEqual(questionButtonCalls[0].options.map((option) => option.label), ["Staging", "Production"]);
    assert.deepEqual(questionButtonCalls[0].context, {
      requestId: "req-multi-question",
      questionId: "environment",
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Staging", "Production"]],
    );
    assert.match(String(requests[0]?.userMessage ?? ""), /Question 1 - Environment/);
    assert.match(String(requests[0]?.userMessage ?? ""), /Staging - Use staging credentials\./);
    assert.match(String(requests[0]?.userMessage ?? ""), /Production - Use production credentials\./);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Question 2 - Scope/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Fallback preview/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Why this is asked:/);

    session.pendingInputState = {
      ...session.pendingInputState,
      promptText: [
        "Question 2 - Scope",
        "How broad should the rollout be?",
        "Options:",
        "  1. Canary - Start with a small cohort.",
        "  2. Everyone - Roll out to all users.",
      ].join("\n"),
      options: ["Canary", "Everyone"],
      activeQuestionIndex: 1,
      answers: {
        environment: { answers: ["Production"] },
      },
    };

    service.emitWaitingForInput(session);

    assert.equal(questionButtonCalls.length, 2);
    assert.deepEqual(questionButtonCalls[1].options.map((option) => option.label), ["Canary", "Everyone"]);
    assert.deepEqual(questionButtonCalls[1].context, {
      requestId: "req-multi-question",
      questionId: "scope",
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(
      (requests[1]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Canary", "Everyone"]],
    );
    assert.match(String(requests[1]?.userMessage ?? ""), /Question 2 - Scope/);
    assert.match(String(requests[1]?.userMessage ?? ""), /Canary - Start with a small cohort\./);
    assert.match(String(requests[1]?.userMessage ?? ""), /Everyone - Roll out to all users\./);
    assert.doesNotMatch(String(requests[1]?.userMessage ?? ""), /Fallback preview/);
    assert.doesNotMatch(String(requests[1]?.userMessage ?? ""), /Why this is asked:/);
  });

  it("renders fallback option buttons when a single structured question has no inline options", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const questionButtonCalls: Array<{
      options: Array<{ label: string }>;
      context?: { requestId?: string; questionId?: string };
    }> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options, context) => {
        questionButtonCalls.push({ options, context });
        return [options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` }))];
      },
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Fallback preview",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-structured-fallback-options",
      name: "structured-fallback-options",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-structured-fallback-options",
        kind: "question",
        promptText: "Question 1 - Confirm\nYes or no?",
        options: ["Yes", "No"],
        activeQuestionIndex: 0,
        questions: [{
          id: "confirm",
          question: "Yes or no?",
          options: [],
        }],
      },
    }));

    assert.equal(questionButtonCalls.length, 1);
    assert.deepEqual(questionButtonCalls[0].options.map((option) => option.label), ["Yes", "No"]);
    assert.deepEqual(questionButtonCalls[0].context, {
      requestId: "req-structured-fallback-options",
      questionId: "confirm",
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Yes", "No"]],
    );
  });

  it("preserves provided option descriptions verbatim without calling the LLM", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const providedDescription = [
      "Use the plugin store as the canonical source because the shared policy is controlled by plugin configuration,",
      "is inherited by every launched agent session, and should not be overridden inside a single Codex answer.",
    ].join(" ");
    let contextSummaryCalls = 0;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "Codex reached the policy selection step after reading the plugin configuration.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary(evidence) {
          contextSummaryCalls += 1;
          assert.match(evidence.question, /Which policy source should I use\?/);
          return { summary: "Codex needs the policy source before it can continue." };
        },
        async generateQuestionOptionDescriptions() {
          throw new Error("option descriptions must not be sent to the LLM");
        },
      },
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-described-options",
      name: "described-options",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-described-options",
        kind: "question",
        promptText: "Which policy source should I use?",
        options: ["Plugin store", "Local override"],
        activeQuestionIndex: 0,
        questions: [{
          id: "policy_source",
          question: "Which policy source should I use?",
          options: [
            { label: "Plugin store", description: providedDescription },
            { label: "Local override" },
          ],
        }],
      },
    }));

    assert.equal(requests.length, 1);
    assert.equal(contextSummaryCalls, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), new RegExp(`Plugin store - ${providedDescription.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(String(requests[0]?.userMessage ?? ""), /Why: Codex needs the policy source before it can continue\./);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Local override -/);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Plugin store", "Local override"]],
    );
  });

  it("omits oversized option descriptions without calling the LLM", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const oversizedDescription = `${"This long provided option description is intentionally repeated. ".repeat(8)}Do not rewrite it.`;

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary() {
          return undefined;
        },
        async generateQuestionOptionDescriptions() {
          throw new Error("option descriptions must not be sent to the LLM");
        },
      },
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-description-failure",
      name: "description-failure",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-description-failure",
        kind: "question",
        promptText: "Which policy source should I use?",
        options: ["Plugin store", "Local override"],
        activeQuestionIndex: 0,
        questions: [{
          id: "policy_source",
          question: "Which policy source should I use?",
          options: [
            {
              label: "Plugin store",
              description: oversizedDescription,
            },
            { label: "Local override" },
          ],
        }],
      },
    }));

    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), /Which policy source should I use\?/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Plugin store -/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Do not rewrite it/);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Plugin store", "Local override"]],
    );
  });

  it("adds an LLM micro-summary to compact question prompts without changing options", async () => {
    const requests: Array<Record<string, unknown>> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => [
        "The long deployment transcript should not be pasted into Telegram.",
        "Codex needs the environment before it can continue.",
      ].join("\n"),
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary(evidence) {
          assert.match(evidence.context, /long deployment transcript/);
          return { summary: "Codex needs the target environment before it can continue." };
        },
      },
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-summary-question",
      name: "summary-question",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-summary-question",
        kind: "question",
        promptText: "Which environment should I target?",
        options: ["Staging", "Production"],
      },
    }));

    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), /Which environment should I target\?/);
    assert.match(String(requests[0]?.userMessage ?? ""), /Why: Codex needs the target environment before it can continue\./);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Staging -/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Production -/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /long deployment transcript/);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Staging", "Production"]],
    );
  });

  it("omits question context when LLM micro-summary generation fails", async () => {
    const requests: Array<Record<string, unknown>> = [];

    const service = new SessionLifecycleService({
      persistSession: () => {},
      clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({
        notificationSent: false,
        worktreeRemoved: false,
      }),
      resolveWorktreeRepoDir: () => undefined,
      updatePersistedSession: () => false,
      dispatchSessionNotification: (_session, request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
      notifySession: () => {},
      clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false,
      shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true,
      resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => [],
      getResumeButtons: () => [],
      getQuestionButtons: (_sessionId, options) => [
        options.map((option) => ({ label: option.label, callbackData: `token:${option.label}` })),
      ],
      extractLastOutputLine: () => undefined,
      getOutputPreview: () => "This raw context must not appear if summarization fails.",
      originThreadLine: () => "Origin thread: telegram topic 42",
      debounceWaitingEvent: () => true,
      isAlreadyMerged: () => false,
      questionContextSummaryProvider: {
        async generateQuestionContextSummary() {
          return { summary: "This invalid summary is intentionally far too long to fit inside the strict one-sentence micro-summary budget for question prompts, so it must be omitted from the user-facing notification instead of being truncated or shown." };
        },
      },
    });

    await service.emitWaitingForInput(createStubSession({
      id: "session-summary-failure",
      name: "summary-failure",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-summary-failure",
        kind: "question",
        promptText: "Which environment should I target?",
        options: ["Staging", "Production"],
      },
    }));

    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.userMessage ?? ""), /Which environment should I target\?/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /Why:/);
    assert.doesNotMatch(String(requests[0]?.userMessage ?? ""), /raw context/);
    assert.deepEqual(
      (requests[0]?.buttons as Array<Array<{ label: string }>>).map((row) => row.map((button) => button.label)),
      [["Staging", "Production"]],
    );
  });
});
