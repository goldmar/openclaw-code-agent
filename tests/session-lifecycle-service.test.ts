import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionLifecycleService } from "../src/session-lifecycle-service";
import { createStubSession } from "./helpers";

describe("SessionLifecycleService", () => {
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
});
