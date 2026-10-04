import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GoalController, goalRunCostUsd, normalizeVerifierCommands } from "../src/goal-controller";
import { GoalTaskStore } from "../src/goal-store";
import { estimateCodexApiCostUsd } from "../src/harness/codex-cost";
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

  it("ends a task whose session is no longer loaded by what the stored row says", async () => {
    const reconcile = async (stored: Record<string, unknown> | undefined) => {
      const notifications: string[] = [];
      const controller = new GoalController({
        resolve: (): undefined => undefined,
        getPersistedSession: () => stored,
        emitGoalTaskUpdate: (_task: GoalTaskState, _text: string, label: string) => { notifications.push(label); },
      } as any);
      const store = createStore();
      (controller as any).store = store;
      const task = buildTask({ sessionId: "session-1", sessionName: "goal-task", verifierCommands: [{ label: "check-1", command: "true" }] });
      store.upsert(task);
      await (controller as any).reconcileTask(task);
      return { status: task.status, reason: task.failureReason, notifications };
    };

    // A dormant session whose plan was rejected, or that the user stopped.
    assert.deepEqual(await reconcile({ status: "killed", killReason: "idle-timeout", approvalState: "rejected" }),
      { status: "stopped", reason: "The plan was rejected.", notifications: ["goal-task-stopped"] });
    assert.deepEqual(await reconcile({ status: "killed", killReason: "user" }),
      { status: "stopped", reason: "Stopped by user.", notifications: ["goal-task-stopped"] });
    // A session that completed normally and was unloaded afterwards is not a
    // "closed without running" session: its completion was handled when it
    // happened, so finding it gone is the failure it always was.
    for (const stored of [{ status: "completed", killReason: "done" }, { status: "completed", killReason: "done", approvalState: "rejected" }, undefined]) {
      assert.deepEqual(await reconcile(stored),
        { status: "failed", reason: "Underlying session could not be found.", notifications: ["goal-task-failed"] });
    }
  });

  it("stops a task at once, with one notice, when its dormant session is closed", () => {
    for (const [outcome, reason] of [["completed", "The session was closed as completed without running."], ["killed", "Stopped by user."]] as const) {
      const notifications: string[] = [];
      const controller = new GoalController({
        resolve: (): undefined => undefined,
        emitGoalTaskUpdate: (_task: GoalTaskState, text: string, label: string, replyOnly?: boolean) => { notifications.push(`${label}:${replyOnly === true}`); return text; },
      } as any);
      const store = createStore();
      (controller as any).store = store;
      const task = buildTask({ status: "waiting_for_plan_approval", sessionId: "session-1", sessionName: "goal-task" });
      store.upsert(task);

      // Typed in the task's own chat: the notice is returned as the reply, not sent.
      const reply: { sameChat: () => boolean; text?: string; posted?: boolean } = { sameChat: () => true };
      assert.equal(controller.sessionClosedWhileDormant(task.id, outcome, reply), "goal-task");
      assert.equal(task.status, "stopped");
      assert.equal(task.failureReason, reason);
      assert.deepEqual(notifications, ["goal-task-stopped:true"]);
      assert.equal(reply.posted, false);
      assert.match(reply.text ?? "", /Goal task stopped/);
      // A second close, or a finished task, does nothing more.
      assert.equal(controller.sessionClosedWhileDormant(task.id, outcome), undefined);
      assert.deepEqual(notifications, ["goal-task-stopped:true"]);
    }
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

  it("suppresses the session's stop notice for every goal stop: the goal notice is the one stop message", () => {
    for (const sameChat of [true, false, undefined]) {
      const session = createStubSession({ id: "session-1", name: "goal-task" });
      const killed: string[] = [];
      const controller = new GoalController({
        resolve: (id: string) => (id === "session-1" ? session : undefined),
        // The flag must be set before the kill lands.
        kill: (id: string) => { killed.push(`${id}:${session.stopNoticeReplaced === true}`); },
        emitGoalTaskUpdate: (_task: GoalTaskState, text: string) => text,
      } as any);
      const store = createStore();
      (controller as any).store = store;
      const task = buildTask({ sessionId: "session-1", sessionName: "goal-task" });
      store.upsert(task);

      // `undefined`: the agent_goal tool, which passes no reply.
      const reply: { sameChat: () => boolean; text?: string; posted?: boolean; taskName?: string } | undefined =
        sameChat === undefined ? undefined : { sameChat: () => sameChat };
      assert.equal(controller.stopTask(task.id, reply)?.action, "stopped");

      // In the task's chat the reply is the stop message; from another chat
      // (or the tool) the goal notice in the task's chat is. Never both lines.
      assert.deepEqual(killed, ["session-1:true"]);
      assert.equal(session.stopNoticeReplaced, true);
      if (reply) {
        assert.match(reply.text ?? "", /Goal task stopped\n\nStopped by user\./);
        assert.equal(reply.posted, !sameChat);
        assert.equal(reply.taskName, task.name);
      }
    }
  });

  it("stops the task's newest session too when it is still starting and not yet recorded on the task", () => {
    // Every iteration is a new session; `task.sessionId` is updated only once it runs.
    const previous = createStubSession({ id: "session-1", name: "goal-task", status: "killed", goalTaskId: "goal-1" });
    const starting = createStubSession({ id: "session-2", name: "goal-task", status: "starting", goalTaskId: "goal-1" });
    const foreign = createStubSession({ id: "session-3", name: "other", status: "running", goalTaskId: "goal-other" });
    const killed: string[] = [];
    const controller = new GoalController({
      resolve: (id: string) => [previous, starting, foreign].find((session) => session.id === id),
      list: () => [previous, starting, foreign],
      kill: (id: string) => { killed.push(id); },
      emitGoalTaskUpdate: (_task: GoalTaskState, text: string) => text,
    } as any);
    const store = createStore();
    (controller as any).store = store;
    const task = buildTask({ sessionId: "session-1", sessionName: "goal-task" });
    store.upsert(task);

    assert.equal(controller.stopTask(task.id)?.action, "stopped");

    assert.deepEqual(killed, ["session-1", "session-2"], "the recorded session and the one that is starting; never another task's");
    assert.equal(starting.stopNoticeReplaced, true, "one stop message: the goal's");
    assert.equal(foreign.stopNoticeReplaced, undefined);
    assert.equal(task.status, "stopped");
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
    assert.match(notifications[0]?.text ?? "", /Completed — goal succeeded/);
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
    assert.match(notifications[0]?.text ?? "", /Continued \(iteration 1\/8\)/);
    assert.match(notifications[0]?.text ?? "", /First controller turn found more repo checks to run/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /iteration 2\/8/);
    assert.match(notifications[1]?.text ?? "", /Completed — goal succeeded/);
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
    assert.match(notifications[0]?.text ?? "", /Continued \(iteration 1\/8\)/);
    assert.doesNotMatch(notifications[0]?.text ?? "", /Iteration summary:/);
    assert.match(notifications[0]?.text ?? "", /Readiness check ran; broker gate is still closed/);
    assert.match(notifications[0]?.text ?? "", /No eligible paper intents appeared/);
    assert.match(notifications[0]?.text ?? "", /Next iteration will watch for market data readiness/);
    assert.match(notifications[0]?.text ?? "", /Continued \(iteration 1\/8\)\n\nAgent:/);
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
    assert.match(notifications[0]?.text ?? "", /Continued \(iteration 1\/8\)/);
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
    assert.match(notifications[0]?.text ?? "", /Completion claimed but verifiers still failed \(iteration 1\/8\)/);
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
    assert.match(notifications[0]?.text ?? "", /^🔁 \[[^\]]+\] Repair started after verifier failure \(iteration 1\/8\)/);
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

  it("uses GPT-6.1 Sol API estimates to stop subscription goals at the cost limit once per run", () => {
    const controller = new GoalController({ emitGoalTaskUpdate: () => {} } as any);
    (controller as any).store = createStore();
    const task = buildTask({ id: "g-sol61", model: "gpt-6.1-sol", maxCostUsd: 0.5, totalCostUsd: 0 });
    const estimate = estimateCodexApiCostUsd({
      model: task.model,
      usage: {
        inputTokens: 100_000, cachedInputTokens: 20_000, cacheWriteInputTokens: 0,
        outputTokens: 10_000, reasoningOutputTokens: 5_000,
      },
    });
    assert.equal(estimate, 0.262);
    const run = { id: "cx-sol61", startedAt: 1, costUsd: 0, usage: { estimatedCostUsd: estimate } };
    assert.equal((controller as any).recordRunCost(task, run), true);
    assert.equal((controller as any).recordRunCost(task, run), true);
    assert.equal(task.totalCostUsd, 0.262, "duplicate run receipts do not consume budget twice");
    assert.equal((controller as any).recordRunCost(task, { ...run, startedAt: 2 }), false);
    assert.equal(task.totalCostUsd, 0.524);
    assert.equal(task.status, "failed");
    assert.match(task.failureReason ?? "", /cost limit/);
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

  it("kills late owned restore children without replacing the captured resumable row", async () => {
    const killed: Array<{ id: string; reason: string }> = [];
    let resolveSpawn!: () => void;
    const late = createStubSession({ id: "session-restored", name: "goal-task", harnessSessionId: "late-thread" });
    const controller = new GoalController({
      resolve: (id: string) => id === late.id ? late : undefined,
      resolveBackendConversationId: (id: string) => id,
      emitGoalTaskUpdate: () => {},
      kill: (id: string, reason: string) => { killed.push({ id, reason }); },
      launchAndAwaitRunning: async () => { await new Promise<void>((resolve) => { resolveSpawn = resolve; }); return late; },
    } as any);
    const store = createStore(); (controller as any).store = store;
    const task = buildTask({ status: "waiting_for_session", harnessSessionId: "resume-thread-1", sessionId: undefined, sessionName: undefined,
      verifierCommands: [{ label: "test", command: "true" }] }); store.upsert(task);
    controller.start(); const restoration = (controller as any).restorePromise;
    await tick(0); controller.stop(); const captured = structuredClone(store.get(task.id)); resolveSpawn(); await restoration;
    assert.deepEqual(killed, [{ id: late.id, reason: "shutdown" }]); assert.deepEqual(store.get(task.id), captured);
    assert.equal(task.harnessSessionId, "resume-thread-1"); assert.equal(task.sessionId, undefined);
  });

  for (const operation of ["launch", "confirmation", "idle", "repair", "ralph"] as const) {
    for (const rejects of [false, true]) {
    it(`discards retired ${operation} ${rejects ? "error" : "preparation"} without stale failure or foreign-child kill`, async () => {
      const store = createStore(), killed: string[] = [], notifications: string[] = [];
      const late = createStubSession({ id: "late", name: "late", harnessSessionId: "late-thread" });
      let owner = late, release!: () => void;
      const controller = new GoalController({ resolve: (id: string) => id === "late" ? owner : undefined,
        resolveBackendConversationId: (id: string) => id,
        emitGoalTaskUpdate: (_task: GoalTaskState, _text: string, label: string) => { notifications.push(label); },
        sendGoalVerifierConfirmation: () => {}, kill: (id: string) => { killed.push(id); },
        launchAndAwaitRunning: async () => { await new Promise<void>((resolve) => { release = resolve; }); if (rejects) throw new Error("late launch failure"); return late; },
      } as any); (controller as any).store = store;
      const task = buildTask({ sessionId: "original", harnessSessionId: "original-thread", verifierCommands: [{ label: "fail", command: "false" }],
        ...(operation === "ralph" ? { loopMode: "ralph", completionPromise: "DONE" } : {}) }); store.upsert(task);
      let pending: Promise<unknown>;
      if (operation === "launch") pending = controller.launchTask({ goal: "New", workdir: "/tmp", verifierCommands: [{ label: "pass", command: "true" }] });
      else if (operation === "confirmation") { task.status = "awaiting_verifier_confirmation"; pending = controller.confirmVerifierCommands(task.id); }
      else { const session = createStubSession({ id: "original", harnessSessionId: "original-thread", status: "completed", getOutput: () => ["Keep working"] });
        pending = operation === "idle" ? (controller as any).resumeAfterIdleTimeout(task, session, "Continue") : (controller as any).handleTerminalSession(task, session); }
      const outcome = pending.then((): null => null, (error: Error): Error => error);
      while (!release) await tick(1);
      controller.stop(); const captured = JSON.stringify(store.list()), notices = [...notifications];
      if (operation === "repair") owner = createStubSession({ id: "late", name: "replacement" });
      release(); const result = await outcome;
      if (operation === "launch" || operation === "confirmation") assert.match((result as Error).message, rejects ? /late launch failure/ : /controller retired/);
      assert.equal(JSON.stringify(store.list()), captured); assert.deepEqual(notifications, notices);
      assert.deepEqual(killed, rejects || operation === "repair" ? [] : ["late"]);
    });
    }
  }

  for (const rejects of [false, true]) {
    it(`discards retired automatic input ${rejects ? "error" : "completion"} without task writes`, async () => {
      let release!: () => void;
      const session = createStubSession({ id: "original", name: "goal-task", harnessSessionId: "thread", goalTaskId: "goal-1", status: "running",
        pendingInputState: { kind: "question" }, getOutput: () => ["Should I continue?"],
        sendMessage: async () => { await new Promise<void>(resolve => { release = resolve; }); if (rejects) throw new Error("late input failure"); return { disposition: "sent" }; },
      });
      const controller = new GoalController({ resolve: () => session, assertGoalTaskAuthorized: (id: string) => controller.assertTaskAuthorized(id),
        continueGoalSession: (target: { goalTaskId?: string }) => { controller.assertTaskAuthorized(target.goalTaskId!); return "attached"; } } as any);
      const store = createStore(); (controller as any).store = store;
      const task = buildTask({ sessionId: session.id, harnessSessionId: "thread", verifierCommands: [{ label: "pass", command: "true" }] }); store.upsert(task);
      const pending: Promise<void> = (controller as any).reconcileTask(task);
      for (let count = 0; !release && count < 20; count += 1) await tick(1);
      assert.equal(typeof release, "function"); controller.stop(); const captured = JSON.stringify(store.list());
      release(); await pending; assert.equal(JSON.stringify(store.list()), captured);
    });
  }

  for (const reassigned of ["goal", "current-session"] as const) {
    it(`cannot kill a late returned Session reassigned to another ${reassigned}`, async () => {
      const store = createStore(), killed: string[] = []; let release!: () => void;
      const late = createStubSession({ id: "late", goalTaskId: "goal-1", harnessSessionId: "thread" });
      const controller = new GoalController({ resolve: () => late, kill: (id: string) => { killed.push(id); },
        launchAndAwaitRunning: async () => { await new Promise<void>(resolve => { release = resolve; }); return late; },
      } as any); (controller as any).store = store;
      const task = buildTask({ verifierCommands: [{ label: "pass", command: "true" }] }); store.upsert(task);
      const pending: Promise<unknown> = (controller as any).spawnManagedTaskSession(task, "Launch");
      const outcome = pending.then((): null => null, (error: Error): Error => error);
      controller.stop();
      if (reassigned === "goal") late.goalTaskId = "foreign";
      else { (controller as any).restoreRecoverableTasks = async (): Promise<void> => {}; controller.start(); task.sessionId = late.id; store.upsert(task); }
      const captured = JSON.stringify(store.list()); release(); assert.match((await outcome as Error).message, /controller retired/);
      assert.deepEqual(killed, []); assert.equal(JSON.stringify(store.list()), captured); controller.stop();
    });
  }

  it("ignores evaluation waiting on a retired restore rather than touching a newer task", async () => {
    const controller = new GoalController({ resolve: (): undefined => undefined } as any), store = createStore(); (controller as any).store = store;
    let release!: () => void; (controller as any).restorePromise = new Promise<void>(resolve => { release = resolve; });
    const pending: Promise<void> = (controller as any).evaluateTask("goal-1", "old-restore"); controller.stop();
    (controller as any).restoreRecoverableTasks = async (): Promise<void> => {}; controller.start();
    const current = buildTask({ verifierCommands: [{ label: "pass", command: "true" }] }); store.upsert(current);
    const captured = JSON.stringify(store.list()); release(); await pending; assert.equal(JSON.stringify(store.list()), captured); controller.stop();
  });

  it("cannot clear a new restoration promise when an old generation settles", async () => {
    const controller = new GoalController({ resolve: (): undefined => undefined } as any);
    const store = createStore(); (controller as any).store = store;
    const releases: Array<() => void> = [];
    (controller as any).restoreRecoverableTasks = () => new Promise<void>(resolve => releases.push(resolve));
    controller.start(); const old = (controller as any).restorePromise; controller.stop(); controller.start();
    const current = (controller as any).restorePromise; assert.notEqual(current, old);
    releases[0](); await old; assert.equal((controller as any).restorePromise, current);
    releases[1](); await current; assert.equal((controller as any).restorePromise, null); controller.stop();
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
