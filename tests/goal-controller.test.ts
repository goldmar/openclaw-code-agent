import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GoalController } from "../src/goal-controller";
import { GoalTaskStore } from "../src/goal-store";
import type { GoalTaskState } from "../src/types";
import { createStubSession, tick } from "./helpers";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
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
  it("waits for recoverable-task restoration before arming the reconcile timer", async () => {
    const controller = new GoalController({} as any);
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
    assert.equal((controller as any).reconcileTimer, null);

    resolveRestore?.();
    await tick(20);

    assert.notEqual((controller as any).reconcileTimer, null);
    controller.stop();
  });

  it("treats idle-timeout while waiting for human input as waiting_for_user instead of a hard failure", async () => {
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

    assert.equal(task.status, "waiting_for_user");
    assert.equal(task.failureReason, undefined);
    assert.match(task.waitingForUserReason ?? "", /api key/i);
    assert.deepEqual(notifications.map((note) => note.label), ["goal-task-waiting"]);
  });

  it("emits a stopped notification when a goal session is killed outside goal_stop", async () => {
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

  it("does not keep reprocessing terminal waiting_for_user tasks on every reconcile tick", async () => {
    const notifications: Array<{ label: string; text: string }> = [];
    const session = createStubSession({
      id: "session-1",
      name: "goal-task",
      status: "killed",
      killReason: "idle-timeout",
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

    await controller.reconcileAll();

    assert.equal(notifications.length, 0);
    assert.equal(task.status, "waiting_for_user");
    assert.equal(task.failureReason, undefined);
  });

  it("drops observed session ids after the attached session reaches a terminal state", () => {
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
    });

    (controller as any).attachSessionObservers(task, session);
    assert.equal((controller as any).observedSessions.has("session-1"), true);

    session.emit("statusChange", session, "completed", "running");

    assert.equal((controller as any).observedSessions.has("session-1"), false);
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

    assert.equal(returned?.status, "succeeded");
    assert.equal(returned?.failureReason, undefined);
    assert.equal(returned?.lastVerifierSummary, "PASS verify");
    assert.deepEqual(killed, []);
    assert.deepEqual(notifications, []);
  });

  it("passes persisted backend refs into resume-session selection for goal recovery", async () => {
    let capturedConfig: any;
    const controller = new GoalController({
      resolveHarnessSessionId: () => undefined,
      resolve: () => undefined,
      getPersistedSession: () => ({
        harness: "codex",
        backendRef: { kind: "codex-app-server", conversationId: "thread-app-server" },
      }),
      spawnAndAwaitRunning: async (config: any) => {
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
      resolve: () => undefined,
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

  it("logs reconcile loop errors instead of dropping the rejection from the interval callback", async () => {
    const controller = new GoalController({} as any);
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalWarn = console.warn;

    let scheduled: (() => void) | null = null;
    const warnings: string[] = [];

    (controller as any).restoreRecoverableTasks = async () => {};
    (controller as any).reconcileAll = async () => {
      throw new Error("boom");
    };

    global.setInterval = (((fn: () => void) => {
      scheduled = fn;
      return { fake: true } as any;
    }) as typeof setInterval);
    global.clearInterval = ((() => {}) as typeof clearInterval);
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    try {
      controller.start();
      await tick(20);
      assert.ok(scheduled, "expected reconcile interval to be scheduled");

      scheduled?.();
      await tick(20);

      assert.ok(warnings.some((line) => line.includes("[GoalController] reconcileAll error: boom")));
    } finally {
      controller.stop();
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      console.warn = originalWarn;
    }
  });
});
