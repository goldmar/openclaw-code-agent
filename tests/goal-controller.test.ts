import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GoalController, goalRunCostUsd, normalizeVerifierCommands } from "../src/goal-controller";
import { GoalTaskStore } from "../src/goal-store";
import type { GoalTaskState } from "../src/types";
import { createStubSession, tick } from "./helpers";

const tempDirs: string[] = [];
const originalBashEnv = process.env.BASH_ENV;
const originalEnv = process.env.ENV;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  if (originalBashEnv == null) {
    delete process.env.BASH_ENV;
  } else {
    process.env.BASH_ENV = originalBashEnv;
  }
  if (originalEnv == null) {
    delete process.env.ENV;
  } else {
    process.env.ENV = originalEnv;
  }
});

function createStore(): GoalTaskStore {
  const dir = mkdtempSync(join(tmpdir(), "goal-controller-test-"));
  tempDirs.push(dir);
  return new GoalTaskStore({
    OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: join(dir, "goal-tasks.json"),
  } as NodeJS.ProcessEnv);
}

function buildTask(overrides: Partial<GoalTaskState> = {}): GoalTaskState {
  return {
    id: "goal-1",
    name: "goal-task",
    goal: "Ship the feature",
    workdir: "/tmp/project",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    iteration: 0,
    maxIterations: 8,
    verifierCommands: [],
    repeatedFailureCount: 0,
    loopMode: "verifier",
    permissionMode: "bypassPermissions",
    ...overrides,
  };
}

describe("GoalController", () => {
  it("waits for recoverable-task restoration before finishing startup", async () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {}, resolve: (): undefined => undefined } as any);
    const store = createStore();
    (controller as any).store = store;

    let resolveRestore: (() => void) | null = null;
    let restoreCalls = 0;
    (controller as any).restoreRecoverableTasks = async () => {
      restoreCalls += 1;
      await new Promise<void>((resolve) => {
        resolveRestore = resolve;
      });
    };

    controller.start();

    assert.equal(restoreCalls, 1);
    assert.ok((controller as any).restorePromise);

    resolveRestore?.();
    await tick(20);

    assert.equal((controller as any).restorePromise, null);
    controller.stop();
  });

  it("fails idle-timeout sessions that were waiting for human input", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
    });
    const session = createStubSession({
      id: "session-1",
      name: "goal-task",
      status: "killed",
      killReason: "idle-timeout",
      pendingInputState: {
        requestId: "req-1",
        kind: "question",
        promptText: "Paste the API key to continue.",
        options: [],
        allowsFreeText: true,
      },
      getOutput: () => ["Paste the API key to continue."],
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(task.status, "failed");
    assert.match(task.failureReason ?? "", /waiting for user input/i);
    assert.match(task.failureReason ?? "", /api key/i);
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-failed"]);
  });

  it("emits a stopped notification when a goal session is killed outside agent_goal_stop", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
    });
    const session = createStubSession({
      id: "session-1",
      name: "goal-task",
      status: "killed",
      killReason: "user",
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(task.status, "stopped");
    assert.equal(task.failureReason, "Stopped by user.");
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-stopped"]);
    assert.match(notifications[0]?.text ?? "", /Stopped by user/i);
  });

  it("fails waiting_for_user tasks during reconcile instead of leaving them recoverable", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const session = createStubSession({
      id: "session-1",
      name: "goal-task",
      status: "running",
      getOutput: () => ["Waiting on a human response."],
    });
    const controller = new GoalController({
      resolve: (id: string) => (id === "session-1" ? session : undefined),
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({
      status: "waiting_for_user",
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
      waitingForUserReason: "Waiting on a human response.",
    });
    store.upsert(task);

    await (controller as any).reconcileTask(task);

    assert.equal(task.status, "failed");
    assert.match(task.failureReason ?? "", /cannot continue autonomously/i);
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-failed"]);
  });

  it("drops attached session observers after the attached session reaches a terminal state", () => {
    const controller = new GoalController({} as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({ status: "running" });
    store.upsert(task);

    const session = Object.assign(new EventEmitter(), {
      id: "session-1",
      name: "goal-task",
      harnessSessionId: "hs-1",
      route: undefined,
      getOutput: (): string[] => [],
    });

    (controller as any).attachSessionObservers(task, session);
    assert.equal((controller as any).observerDisposers.has("session-1"), true);

    session.emit("statusChange", session, "completed", "running");

    assert.equal((controller as any).observerDisposers.has("session-1"), false);
  });

  it("coalesces duplicate turn-end evaluations for the same task", async () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {}, resolve: (): undefined => undefined } as any);
    const store = createStore();
    (controller as any).store = store;
    (controller as any).restoreRecoverableTasks = async () => {};

    const evaluations: Array<{ taskId: string; trigger: string; sessionId?: string }> = [];
    (controller as any).evaluateTask = async (taskId: string, trigger: string, sessionId?: string) => {
      evaluations.push({ taskId, trigger, sessionId });
    };

    const task = buildTask({ status: "running" });
    store.upsert(task);

    const session = Object.assign(new EventEmitter(), {
      id: "session-1",
      name: "goal-task",
      harnessSessionId: "hs-1",
      route: undefined,
      getOutput: (): string[] => [],
    });

    controller.start();
    await tick(20);
    (controller as any).attachSessionObservers(task, session);

    session.emit("turnEnd");
    session.emit("turnEnd");
    await tick(20);

    assert.deepEqual(evaluations, [{ taskId: "goal-1", trigger: "turnEnd", sessionId: "session-1" }]);
    controller.stop();
  });

  it("preserves the first concrete dirty session hint while a task is in flight", async () => {
    const controller = new GoalController({ resolve: (): undefined => undefined } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({ status: "running" });
    store.upsert(task);
    (controller as any).inFlight.add(task.id);

    await (controller as any).reconcileTask(task, "dirty-1");
    assert.equal((controller as any).dirtyEvaluationSessionIds.get(task.id), undefined);

    await (controller as any).reconcileTask(task, "dirty-2", "session-current");
    assert.equal((controller as any).dirtyEvaluationSessionIds.get(task.id), "session-current");

    await (controller as any).reconcileTask(task, "dirty-3", "session-stale");
    assert.equal((controller as any).dirtyEvaluationSessionIds.get(task.id), "session-current");
  });

  it("does not overwrite a terminal task when stopTask is called again", () => {
    const killed: Array<{ id: string; reason: string }> = [];
    const notifications: string[] = [];
    const controller = new GoalController({
      kill: (id: string, reason: string) => {
        killed.push({ id, reason });
      },
      emitGoalTaskUpdate: (_task: GoalTaskState, _text: string, label: string) => {
        notifications.push(label);
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({
      status: "succeeded",
      sessionId: "session-1",
      failureReason: undefined,
      lastVerifierSummary: "PASS verify",
    });
    store.upsert(task);

    const returned = controller.stopTask(task.id);

    assert.equal(returned?.action, "already_terminal");
    assert.equal(returned?.task.status, "succeeded");
    assert.equal(returned?.task.failureReason, undefined);
    assert.equal(returned?.task.lastVerifierSummary, "PASS verify");
    assert.deepEqual(killed, []);
    assert.deepEqual(notifications, []);
  });

  it("edits and persists an active goal without changing session lifecycle fields", () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({
      goal: "Ship the feature",
      status: "running",
      updatedAt: 10,
      iteration: 3,
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
      verifierCommands: [{ label: "test", command: "pnpm test" }],
      loopMode: "verifier",
    });
    store.upsert(task);

    const result = controller.editTask("goal-task", "  Ship the feature and update smoke tests  ");
    const persisted = store.get("goal-1");

    assert.equal(result.action, "updated");
    assert.equal(result.action === "updated" ? result.previousGoal : undefined, "Ship the feature");
    assert.equal(persisted?.goal, "Ship the feature and update smoke tests");
    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.iteration, 3);
    assert.equal(persisted?.sessionId, "session-1");
    assert.equal(persisted?.sessionName, "goal-task");
    assert.equal(persisted?.harnessSessionId, "hs-1");
    assert.deepEqual(persisted?.verifierCommands, [{ label: "test", command: "pnpm test" }]);
    assert.ok((persisted?.updatedAt ?? 0) >= 10);
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-edited"]);
    assert.match(notifications[0]?.text ?? "", /Goal task edited/);
    assert.match(notifications[0]?.text ?? "", /Ship the feature and update smoke tests/);
  });

  it("allows editing a waiting_for_session goal because it is recoverable active state", () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {} } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({ status: "waiting_for_session", goal: "Old goal" });
    store.upsert(task);

    const result = controller.editTask("goal-1", "New goal");

    assert.equal(result.action, "updated");
    assert.equal(store.get("goal-1")?.goal, "New goal");
    assert.equal(store.get("goal-1")?.status, "waiting_for_session");
  });

  it("rejects an empty replacement goal without mutating state", () => {
    const notifications: string[] = [];
    const controller = new GoalController({
      emitGoalTaskUpdate: (_task: GoalTaskState, _text: string, label: string) => {
        notifications.push(label);
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({ goal: "Original goal", updatedAt: 10 });
    store.upsert(task);

    const result = controller.editTask("goal-1", "   ");

    assert.equal(result.action, "invalid_goal");
    assert.equal(store.get("goal-1")?.goal, "Original goal");
    assert.equal(store.get("goal-1")?.updatedAt, 10);
    assert.deepEqual(notifications, []);
  });

  it("rejects non-editable goal states without notifications", () => {
    const statuses: Array<GoalTaskState["status"]> = ["succeeded", "failed", "stopped", "waiting_for_user"];

    for (const status of statuses) {
      const notifications: string[] = [];
      const controller = new GoalController({
        emitGoalTaskUpdate: (_task: GoalTaskState, _text: string, label: string) => {
          notifications.push(label);
        },
      } as any);
      const store = createStore();
      (controller as any).store = store;

      const task = buildTask({ status, goal: "Original goal", updatedAt: 10 });
      store.upsert(task);

      const result = controller.editTask("goal-1", "New goal");

      assert.equal(result.action, "not_editable");
      assert.equal(store.get("goal-1")?.goal, "Original goal");
      assert.equal(store.get("goal-1")?.updatedAt, 10);
      assert.deepEqual(notifications, []);
    }
  });

  it("fast-fails verifier-loop tasks when the underlying session fails", async () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {} } as any);
    const store = createStore();
    (controller as any).store = store;

    let ranVerifiers = false;
    (controller as any).runVerifiers = async () => {
      ranVerifiers = true;
      throw new Error("runVerifiers should not be called");
    };

    const task = buildTask({
      loopMode: "verifier",
      sessionId: "session-1",
      verifierCommands: [{ label: "test", command: "pnpm test" }],
    });
    const session = createStubSession({
      id: "session-1",
      status: "failed",
      error: "Verifier session exploded",
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(task.status, "failed");
    assert.equal(task.failureReason, "Verifier session exploded");
    assert.equal(ranVerifiers, false);
  });

  it("fast-fails Ralph tasks when the underlying session fails", async () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {} } as any);
    const store = createStore();
    (controller as any).store = store;

    let resumed = false;
    (controller as any).resumeTaskSession = async () => {
      resumed = true;
      throw new Error("resumeTaskSession should not be called");
    };

    const task = buildTask({
      loopMode: "ralph",
      completionPromise: "DONE",
      sessionId: "session-1",
    });
    const session = createStubSession({
      id: "session-1",
      status: "failed",
      error: "Ralph session failed hard",
      getOutput: () => ["DONE"],
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(task.status, "failed");
    assert.equal(task.failureReason, "Ralph session failed hard");
    assert.equal(resumed, false);
  });

  it("does not treat agent-internal review passes as controller iterations on first-turn Ralph success", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      resolve: (): undefined => undefined,
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    let resumed = false;
    (controller as any).resumeTaskSession = async () => {
      resumed = true;
      throw new Error("resumeTaskSession should not be called");
    };

    const task = buildTask({
      loopMode: "ralph",
      completionPromise: "DONE",
      maxIterations: 20,
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
    });
    const session = createStubSession({
      id: "session-1",
      status: "completed",
      getOutput: () => [
        "Review/implementation iteration 1: fixed markdown repo checks.",
        "Review/implementation iteration 2: fixed python repo checks.",
        "DONE",
      ],
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(task.status, "succeeded");
    assert.equal(task.iteration, 0);
    assert.equal(resumed, false);
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-succeeded"]);
    assert.match(notifications[0]?.text ?? "", /Goal task succeeded/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Ralph iteration continued/);
  });

  it("emits controller-loop progress only when a Ralph goal actually resumes", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      resolve: (): undefined => undefined,
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const resumedSession = createStubSession({
      id: "session-2",
      name: "goal-task",
      harnessSessionId: "hs-2",
      status: "completed",
      getOutput: () => [
        "Second controller turn finished the requested repo checks.",
        "DONE",
      ],
    });
    let resumeCount = 0;
    (controller as any).resumeTaskSession = async () => {
      resumeCount += 1;
      return resumedSession;
    };

    const task = buildTask({
      loopMode: "ralph",
      completionPromise: "DONE",
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
    });
    const firstTurn = createStubSession({
      id: "session-1",
      status: "completed",
      getOutput: () => [
        "First controller turn found more repo checks to run.",
        "The completion promise is intentionally withheld.",
      ],
    });

    await (controller as any).handleTerminalSession(task, firstTurn);
    await (controller as any).handleTerminalSession(task, resumedSession);

    assert.equal(resumeCount, 1);
    assert.equal(task.iteration, 1);
    assert.equal(task.status, "succeeded");
    assert.deepEqual(notifications.map((note) => note.label), [
      "goal-task-progress",
      "goal-task-succeeded",
    ]);
    assert.match(notifications[0]?.text ?? "", /Continued iteration 1\/8/);
    assert.match(notifications[0]?.text ?? "", /First controller turn found more repo checks to run/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /iteration 2\/8/);
    assert.match(notifications[1]?.text ?? "", /Goal task succeeded/);
    assert.doesNotMatch(notifications[1]?.text ?? "", /Ralph iteration continued/);
  });

  it("includes a concise Ralph iteration summary when continuing without completion", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      resolve: (): undefined => undefined,
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;
    (controller as any).resumeTaskSession = async () => createStubSession({
      id: "session-2",
      name: "goal-task",
      harnessSessionId: "hs-2",
      getOutput: (): never[] => [],
    });

    const task = buildTask({
      loopMode: "ralph",
      completionPromise: "DONE",
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
    });
    const session = createStubSession({
      id: "session-1",
      status: "completed",
      getOutput: () => [
        "Readiness check ran; broker gate is still closed.",
        "No eligible paper intents appeared.",
        "Next iteration will watch for market data readiness.",
      ],
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(task.iteration, 1);
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-progress"]);
    assert.match(notifications[0]?.text ?? "", /Continued iteration 1\/8/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Iteration summary:/);
    assert.match(notifications[0]?.text ?? "", /Readiness check ran; broker gate is still closed/);
    assert.match(notifications[0]?.text ?? "", /No eligible paper intents appeared/);
    assert.match(notifications[0]?.text ?? "", /Next iteration will watch for market data readiness/);
    assert.match(notifications[0]?.text ?? "", /Continued iteration 1\/8\n\nAgent:/);
    assert.match(notifications[0]?.text ?? "", /Agent: Readiness check ran; broker gate is still closed/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Status: running/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Workdir:/);
  });

  it("falls back to metadata-only Ralph continuation notifications without source output", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      resolve: (): undefined => undefined,
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;
    (controller as any).resumeTaskSession = async () => createStubSession({
      id: "session-2",
      name: "goal-task",
      harnessSessionId: "hs-2",
    });

    const task = buildTask({
      loopMode: "ralph",
      completionPromise: "DONE",
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
    });
    const session = createStubSession({
      id: "session-1",
      status: "completed",
      getOutput: (): never[] => [],
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-progress"]);
    assert.match(notifications[0]?.text ?? "", /Continued iteration 1\/8/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Iteration summary:/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Status: running/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Workdir:/);
  });

  it("includes completion-claimed detail when a Ralph completion fails verification", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      resolve: (): undefined => undefined,
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;
    (controller as any).runVerifiers = async () => ({
      status: "fail",
      steps: [] as unknown[],
      summary: "FAIL readiness (exit 1, 25ms)\nbroker gate stayed closed",
      fingerprint: "fingerprint-1",
    });
    (controller as any).resumeTaskSession = async () => createStubSession({
      id: "session-2",
      name: "goal-task",
      harnessSessionId: "hs-2",
    });

    const task = buildTask({
      loopMode: "ralph",
      completionPromise: "DONE",
      verifierCommands: [{ label: "readiness", command: "pnpm readiness" }],
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
    });
    const session = createStubSession({
      id: "session-1",
      status: "completed",
      getOutput: () => [
        "Readiness check ran and submit proof was attempted.",
        "DONE",
      ],
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(task.iteration, 1);
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-progress"]);
    assert.match(notifications[0]?.text ?? "", /Completion claimed but verifiers still failed iteration 1\/8/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Iteration summary:/);
    assert.match(notifications[0]?.text ?? "", /Completion was claimed, but the loop is continuing after verification/);
    assert.match(notifications[0]?.text ?? "", /Verifier: FAIL readiness/);
    assert.match(notifications[0]?.text ?? "", /Verifier: broker gate stayed closed/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Last verifier:/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Status: running/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Workdir:/);
  });

  it("includes verifier failure detail in repair iteration notifications", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const controller = new GoalController({
      resolve: (): undefined => undefined,
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string) => {
        notifications.push({ label, text });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;
    (controller as any).runVerifiers = async () => ({
      status: "fail",
      steps: [] as unknown[],
      summary: "FAIL readiness (exit 1, 25ms)\nbroker gate stayed closed",
      fingerprint: "fingerprint-1",
    });
    (controller as any).resumeTaskSession = async () => createStubSession({
      id: "session-2",
      name: "goal-task",
      harnessSessionId: "hs-2",
    });

    const task = buildTask({
      loopMode: "verifier",
      verifierCommands: [{ label: "readiness", command: "pnpm readiness" }],
      sessionId: "session-1",
      sessionName: "goal-task",
      harnessSessionId: "hs-1",
    });
    const session = createStubSession({
      id: "session-1",
      status: "completed",
    });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(task.iteration, 1);
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-progress"]);
    assert.match(notifications[0]?.text ?? "", /Repair iteration started after verifier failure repair iteration 1\/8/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Iteration summary:/);
    assert.match(notifications[0]?.text ?? "", /Verifier: FAIL readiness/);
    assert.match(notifications[0]?.text ?? "", /Verifier: broker gate stayed closed/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Last verifier:/);
  });

  for (const planApproval of ["ask", "delegate"] as const) {
    it(`leaves the first plan to the normal plan gate (${planApproval}) instead of approving it (D3)`, async () => {
      const messages: string[] = [];
      const permissionModes: string[] = [];
      const session = createStubSession({
        id: "session-1",
        status: "running",
        pendingPlanApproval: true,
        planApproval,
        currentPermissionMode: "plan",
        planDecisionVersion: 1,
        actionablePlanDecisionVersion: 1,
        sendMessage: async (message: string) => { messages.push(message); },
        switchPermissionMode: (mode: string) => { permissionModes.push(mode); },
      });
      const controller = new GoalController({
        resolve: (id: string) => (id === "session-1" ? session : undefined),
        getPersistedSession: (): undefined => undefined,
        notifySession: () => {},
      } as any);
      const store = createStore();
      (controller as any).store = store;
      const task = buildTask({ sessionId: "session-1", permissionMode: "plan" });

      await (controller as any).handleRunningSession(task, session);

      assert.deepEqual(permissionModes, []);
      assert.deepEqual(messages, []);
      assert.equal(task.status, "waiting_for_plan_approval");
    });
  }

  it("continues later iterations within the approved scope (bypassPermissions after the plan was approved)", async () => {
    const configs: any[] = [];
    const controller = new GoalController({
      resolveBackendConversationId: (ref: string) => ref,
      launchAndAwaitRunning: async (config: any) => {
        configs.push(config);
        return createStubSession({ id: "session-2", name: "goal-task", harnessName: "codex", on: (): undefined => undefined });
      },
    } as any);
    const task = buildTask({ permissionMode: "plan" });
    await (controller as any).spawnManagedTaskSession(task, "first");
    task.planApproved = true;
    await (controller as any).spawnManagedTaskSession(task, "repair", "hs-1");
    assert.deepEqual(configs.map((config) => config.permissionMode), ["plan", "bypassPermissions"]);
  });

  it("keeps an idle-suspended goal waiting for its plan decision instead of approving it", async () => {
    let launched = false;
    const session = createStubSession({
      id: "session-1",
      name: "goal-task",
      status: "killed",
      lifecycle: "suspended",
      killReason: "idle-timeout",
      pendingPlanApproval: true,
      currentPermissionMode: "plan",
      harnessSessionId: "hs-1",
      getOutput: () => ["Plan ready for review."],
    });
    const controller = new GoalController({
      resolve: () => session,
      getPersistedSession: (): undefined => undefined,
      launchAndAwaitRunning: async () => { launched = true; return session; },
      emitGoalTaskUpdate: () => {},
    } as any);
    const store = createStore();
    (controller as any).store = store;
    const task = buildTask({ sessionId: "session-1", permissionMode: "plan" });

    await (controller as any).handleTerminalSession(task, session);

    assert.equal(launched, false);
    assert.equal(task.status, "waiting_for_plan_approval");
  });

  it("waits for the user's confirmation before running orchestrator-supplied verifier commands", async () => {
    const confirmations: string[] = [];
    let spawned = 0;
    const controller = new GoalController({
      sendGoalVerifierConfirmation: (_task: GoalTaskState, text: string) => { confirmations.push(text); },
      emitGoalTaskUpdate: () => {},
      resolveBackendConversationId: (ref: string) => ref,
      launchAndAwaitRunning: async () => {
        spawned += 1;
        return createStubSession({ id: "session-1", name: "goal-task", on: (): undefined => undefined });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = await controller.launchTask({
      goal: "Make tests pass",
      workdir: "/tmp/project",
      verifierCommands: [{ label: "check-1", command: "pnpm test" }],
      maxIterations: 100,
      requireVerifierConfirmation: true,
    });

    assert.equal(task.status, "awaiting_verifier_confirmation");
    assert.equal(task.maxIterations, 25, "max_iterations is capped");
    assert.equal(task.permissionMode, "plan", "the first iteration uses the configured mode (default plan)");
    assert.equal(spawned, 0);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0]!, /\$ pnpm test/);

    assert.equal(controller.declineVerifierCommands("missing"), undefined);
    const started = await controller.confirmVerifierCommands(task.id);
    assert.equal(started?.action, "started");
    assert.equal(spawned, 1);
    assert.equal(task.status, "running");
    assert.equal((await controller.confirmVerifierCommands(task.id))?.action, "not_waiting");
  });

  it("stops after three identical verifier failures, counts restarts, and honors maxCostUsd", async () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {} } as any);
    const store = createStore();
    (controller as any).store = store;

    const repeated = buildTask({ id: "g-repeat" });
    assert.equal((controller as any).recordFailureFingerprint(repeated, "fp", "FAIL check"), true);
    assert.equal((controller as any).recordFailureFingerprint(repeated, "fp", "FAIL check"), true);
    assert.equal((controller as any).recordFailureFingerprint(repeated, "fp", "FAIL check"), false);
    assert.equal(repeated.status, "failed");
    assert.match(repeated.failureReason ?? "", /repeated 3 times/);

    const restarting = buildTask({ id: "g-restart", iteration: 7, maxIterations: 8 });
    assert.equal((controller as any).consumeIteration(restarting, "Gateway restarted."), false);
    assert.equal(restarting.status, "failed");

    const costly = buildTask({ id: "g-cost", maxCostUsd: 1, totalCostUsd: 0 });
    const run = { id: "s", startedAt: 1, costUsd: 0.6 };
    assert.equal((controller as any).recordRunCost(costly, run), true);
    assert.equal((controller as any).recordRunCost(costly, run), true, "the same run is counted once");
    assert.equal((controller as any).recordRunCost(costly, { ...run, startedAt: 2 }), false);
    assert.equal(costly.status, "failed");
    assert.match(costly.failureReason ?? "", /cost limit/);
  });

  it("bounds max_cost_usd for runs that bill nothing per token by their API-price estimate", () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {} } as any);
    (controller as any).store = createStore();
    const chatgpt = buildTask({ id: "g-chatgpt", maxCostUsd: 1, totalCostUsd: 0 });
    // Codex with a ChatGPT login: billed $0, estimated $0.70 per run at API prices.
    const run = { id: "cx", startedAt: 1, costUsd: 0, usage: { estimatedCostUsd: 0.7 } };
    assert.equal((controller as any).recordRunCost(chatgpt, run), true);
    assert.equal((controller as any).recordRunCost(chatgpt, { ...run, startedAt: 2 }), false);
    assert.equal(chatgpt.status, "failed");
    assert.match(chatgpt.failureReason ?? "", /cost limit/);
    assert.equal(goalRunCostUsd({ costUsd: 0.2, usage: { estimatedCostUsd: 5 } }), 0.2, "billed cost wins when there is one");
    assert.equal(goalRunCostUsd({ costUsd: 0 }), 0);
  });

  it("fails waiting_for_user tasks during restore", async () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {} } as any);
    const store = createStore();
    (controller as any).store = store;
    (controller as any).started = true;

    const task = buildTask({
      status: "waiting_for_user",
      waitingForUserReason: "Need a human decision.",
      sessionId: "session-1",
    });
    store.upsert(task);

    await (controller as any).restoreRecoverableTasks();

    assert.equal(task.status, "failed");
    assert.equal(
      task.failureReason,
      "Goal task was waiting for user input and cannot continue autonomously",
    );
  });

  it("rejects zero-verifier verifier-mode tasks before creating a session", async () => {
    let spawned = false;
    const controller = new GoalController({
      launchAndAwaitRunning: async () => {
        spawned = true;
        throw new Error("launchAndAwaitRunning should not be called");
      },
    } as any);

    await assert.rejects(
      () => controller.launchTask({
        goal: "Ship it",
        workdir: "/tmp/project",
        loopMode: "verifier",
        verifierCommands: [],
      }),
      /require at least one verifier command/i,
    );
    assert.equal(spawned, false);
  });

  it("rejects whitespace-only verifier commands before creating a session", async () => {
    let spawned = false;
    const controller = new GoalController({
      launchAndAwaitRunning: async () => {
        spawned = true;
        throw new Error("launchAndAwaitRunning should not be called");
      },
    } as any);

    await assert.rejects(
      () => controller.launchTask({
        goal: "Ship it",
        workdir: "/tmp/project",
        loopMode: "verifier",
        verifierCommands: [{ label: "x", command: "   " }],
      }),
      /require at least one verifier command/i,
    );
    assert.equal(spawned, false);
  });

  it("filters whitespace-only verifier commands during normalization", () => {
    const normalized = normalizeVerifierCommands([
      { label: " x ", command: "   " },
      { label: " build ", command: " pnpm verify " },
    ]);

    assert.deepEqual(normalized, [{
      label: "build",
      command: "pnpm verify",
      timeoutMs: 10 * 60 * 1000,
    }]);
  });

  it("returns a synthetic verifier failure when verifier-mode tasks have no verifier commands", async () => {
    const controller = new GoalController({} as any);
    const result = await (controller as any).runVerifiers(buildTask({ verifierCommands: [] }));

    assert.equal(result.status, "fail");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]?.label, "verifier-config");
    assert.match(result.steps[0]?.output ?? "", /require at least one verifier command/i);
  });

  it("fails zero-verifier verifier-mode tasks during restore before reconcile can run", async () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {} } as any);
    const store = createStore();
    (controller as any).store = store;
    (controller as any).started = true;

    const task = buildTask({
      status: "waiting_for_session",
      verifierCommands: [],
    });
    store.upsert(task);

    await (controller as any).restoreRecoverableTasks();

    assert.equal(task.status, "failed");
    assert.equal(task.failureReason, "Verifier-mode goal tasks require at least one verifier command.");
  });

  it("runs verifier commands without inheriting shell bootstrap hooks from BASH_ENV or ENV", async () => {
    const controller = new GoalController({} as any);
    const dir = mkdtempSync(join(tmpdir(), "goal-controller-env-test-"));
    tempDirs.push(dir);
    const shellHookPath = join(dir, "shell-hook.sh");
    writeFileSync(shellHookPath, "export OPENCLAW_TEST_VERIFIER_HOOK=1\n", "utf8");
    process.env.BASH_ENV = shellHookPath;
    process.env.ENV = shellHookPath;

    const result = await (controller as any).runVerifiers(buildTask({
      workdir: dir,
      verifierCommands: [{
        label: "check-clean-shell-env",
        command: "printf '%s' \"${OPENCLAW_TEST_VERIFIER_HOOK:-}\"",
      }],
    }));

    assert.equal(result.status, "pass");
    assert.equal(result.steps[0]?.output, "(no output)");
  });

  it("passes persisted backend refs into resume-session selection for goal recovery", async () => {
    let capturedConfig: any;
    const controller = new GoalController({
      resolveBackendConversationId: (): undefined => undefined,
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        harness: "codex",
        backendRef: { kind: "codex-app-server", conversationId: "thread-app-server" },
      }),
      launchAndAwaitRunning: async (config: any) => {
        capturedConfig = config;
        return createStubSession({
          id: "session-2",
          name: "goal-task",
          harnessSessionId: "thread-app-server",
          route: undefined,
        });
      },
    } as any);

    await (controller as any).spawnManagedTaskSession(buildTask({ harness: "codex" }), "Resume the task", "thread-app-server");

    assert.equal(capturedConfig.resumeSessionId, "thread-app-server");
    assert.equal(capturedConfig.resumeWorktreeFrom, "thread-app-server");
    assert.equal(capturedConfig.worktreeStrategy, "off");
  });

  it("kills sessions restored after stop() races with in-flight recovery", async () => {
    const killed: Array<{ id: string; reason: string }> = [];
    const controller = new GoalController({
      resolve: (): undefined => undefined,
      kill: (id: string, reason: string) => {
        killed.push({ id, reason });
      },
    } as any);
    const store = createStore();
    (controller as any).store = store;

    const task = buildTask({
      status: "waiting_for_session",
      harnessSessionId: "resume-thread-1",
      sessionId: undefined,
      sessionName: undefined,
      verifierCommands: [{ label: "test", command: "pnpm test" }],
    });
    store.upsert(task);

    let resolveSpawn: (() => void) | null = null;
    (controller as any).started = true;
    (controller as any).spawnManagedTaskSession = async () => {
      await new Promise<void>((resolve) => {
        resolveSpawn = resolve;
      });
      return createStubSession({
        id: "session-restored",
        name: "goal-task",
        harnessSessionId: "resume-thread-2",
        route: undefined,
      });
    };

    const restorePromise = (controller as any).restoreRecoverableTasks();
    await tick(0);
    controller.stop();
    resolveSpawn?.();
    await restorePromise;

    assert.deepEqual(killed, [{ id: "session-restored", reason: "shutdown" }]);
    assert.equal(task.status, "waiting_for_session");
    assert.equal(task.harnessSessionId, "resume-thread-2");
    assert.equal(task.sessionId, "session-restored");
  });

  it("logs queued evaluation errors instead of dropping the rejection", async () => {
    const controller = new GoalController({ resolve: (): undefined => undefined } as any);
    const originalWarn = console.warn;
    const warnings: string[] = [];

    (controller as any).restoreRecoverableTasks = async () => {};
    (controller as any).evaluateTask = async () => {
      throw new Error("boom");
    };
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    try {
      controller.start();
      await tick(20);
      (controller as any).scheduleTaskEvaluation("goal-1", "test-trigger");
      await tick(20);

      assert.ok(warnings.some((line) => line.includes("[GoalController] evaluateTask error (test-trigger): boom")));
    } finally {
      controller.stop();
      console.warn = originalWarn;
    }
  });
});
