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
      getOutputPreview: () => "",
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
    };
    assert.equal(request.wakeMessage, undefined);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /Plugin requested short factual follow-up summary: yes/);
    assert.match(request.wakeMessageOnNotifySuccess ?? "", /must send the user a short factual completion summary/i);
    assert.match(request.wakeMessageOnNotifyFailed ?? "", /Canonical completion status delivered to user: no/);
    assert.ok(infoLogs.some((line) => line.includes("\"event\":\"completion_notify_succeeded\"") && line.includes("\"requestedShortFactualSummary\":true")));
    assert.ok(infoLogs.some((line) => line.includes("\"event\":\"completion_wake_succeeded\"") && line.includes("\"canonicalStatusDelivered\":true")));
  });
});
