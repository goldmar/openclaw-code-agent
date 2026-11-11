import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createTaskOutcomeReport } from "../src/session-task-outcome";

import { GoalController } from "../src/goal-controller";
import { GoalTaskStore } from "../src/goal-store";
import { registerHarness } from "../src/harness";
import { Session } from "../src/session";
import type { GoalAuthorizationTicket, GoalTaskState } from "../src/types";
import { bindGoalTask } from "./goal-policy-fixtures";
import { createFakeHarness, createStubSession, tick } from "./helpers";

// A freshness check and the action it guards must be one synchronous step. The
// tests below queue a stop (or kill) as a microtask from inside the check that
// passes last, so it runs at the first await after that check. When the check
// sits in a helper that returns its ticket, the stop runs before the caller
// resumes and the caller then acts on a stopped task or killed session.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setup(): { controller: GoalController; notifications: string[]; stopInGap: (task: GoalTaskState) => () => void; stops: string[] } {
  const notifications: string[] = [];
  const controller = new GoalController({
    resolve: (): undefined => undefined,
    kill: () => {},
    list: (): unknown[] => [],
    emitGoalTaskUpdate: (_task: GoalTaskState, _text: string, label: string) => { notifications.push(label); },
  } as any);
  (controller as any).store = new GoalTaskStore({
    OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: join(tempDir("goal-atomic-"), "goal-tasks.json"),
  } as NodeJS.ProcessEnv);
  const stops: string[] = [];
  let armed = false;
  let target: GoalTaskState | undefined;
  const ticketFor = (controller as any).authorizationTicket.bind(controller);
  (controller as any).authorizationTicket = (...args: unknown[]): GoalAuthorizationTicket => {
    const ticket: GoalAuthorizationTicket = ticketFor(...args);
    return {
      isCurrent: () => {
        const current = ticket.isCurrent();
        if (current && armed && target) {
          armed = false;
          const task = target;
          queueMicrotask(() => { stops.push(controller.stopTask(task.id)!.action); });
        }
        return current;
      },
    };
  };
  // Arms one stop, queued from the next check that passes.
  const stopInGap = (task: GoalTaskState) => () => { target = task; armed = true; };
  return { controller, notifications, stopInGap, stops };
}

async function goalTask(overrides: Partial<GoalTaskState> = {}): Promise<GoalTaskState> {
  const workdir = overrides.workdir ?? tempDir("goal-atomic-repo-");
  if (!overrides.workdir) {
    execFileSync("git", ["init", "-q", "-b", "main", workdir]);
    execFileSync("git", ["-C", workdir, "-c", "user.name=Tester", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "initial"]);
  }
  return bindGoalTask({
    id: "goal-1",
    name: "goal-task",
    goal: "Ship the feature",
    workdir,
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    iteration: 0,
    maxIterations: 8,
    verifierCommands: [],
    repeatedFailureCount: 0,
    loopMode: "ralph",
    completionPromise: "DONE",
    permissionMode: "bypassPermissions",
    sessionId: "session-1",
    sessionName: "goal-task",
    harnessSessionId: "hs-1",
    ...overrides,
  });
}

describe("goal authorization freshness is atomic with the guarded action", () => {
  it("a stop queued right after the success check cannot be overwritten by success", async () => {
    const { controller, notifications, stopInGap, stops } = setup();
    const task = await goalTask({ verifierCommands: [{ label: "check", command: "true" }] });
    (controller as any).store.upsert(task);
    const arm = stopInGap(task);
    const session = createStubSession({ id: "session-1", status: "completed", startedAt: 1, workdir: task.workdir });
    (controller as any).sessionManager.resolve = () => session;
    (controller as any).sessionManager.reportTaskOutcome = async (_ref: string, input: Parameters<typeof createTaskOutcomeReport>[0], reviewer: Parameters<typeof createTaskOutcomeReport>[1]) => {
      session.taskOutcome = createTaskOutcomeReport(input, reviewer);
      // Arm at the last authorization boundary, after the new report await.
      arm();
      return "Task outcome recorded.";
    };
    await (controller as any).markTaskSucceeded(task, "Verified checks passed", {
      status: "pass", sessionId: session.id, executionCycle: session.startedAt,
      repositories: [], steps: [{ label: "check", command: "true", ok: true, exitCode: 0, durationMs: 1, output: "" }],
      summary: "Verified checks passed", fingerprint: "passed",
    });
    await tick(5);

    // The success happened first; the stop then finds a finished task.
    assert.deepEqual(stops, ["already_terminal"]);
    assert.equal(task.status, "succeeded");
    assert.deepEqual(notifications, ["goal-task-succeeded"]);
  });

  it("a stop queued right after the running check is not overwritten by running", async () => {
    const { controller, stopInGap, stops } = setup();
    const task = await goalTask({ status: "waiting_for_session" });
    (controller as any).store.upsert(task);
    stopInGap(task)();

    const assigned = await (controller as any).setTaskRunningWithSession(task, createStubSession({ id: "session-2", name: "goal-task", harnessSessionId: "hs-2" }));
    await tick(5);

    assert.deepEqual(stops, ["stopped"]);
    assert.equal(task.status, "stopped", "the stop is the last word");
    assert.equal(assigned?.isCurrent(), false);
  });
});

describe("session model and goal checks are atomic with the guarded action", () => {
  it("a kill queued right after the last check of a thread action does not precede its message", async () => {
    const harness = createFakeHarness("goal-atomic-thread-action");
    (harness.capabilities as any).threadActions = ["compact"];
    (harness as any).buildThreadActionMessage = (action: { kind: string }) => ({ type: "thread-action", action: action.kind });
    registerHarness(harness);
    const events: string[] = [];
    let checks = 0;
    let killAt = 0;
    const session = new Session({
      prompt: "Work",
      workdir: tempDir("goal-atomic-session-"),
      harness: harness.name,
      multiTurn: true,
      goalTaskId: "goal",
      assertGoalTaskAuthorized: async (): Promise<GoalAuthorizationTicket> => ({
        isCurrent: () => {
          checks += 1;
          if (checks === killAt) queueMicrotask(() => { events.push("kill"); session.kill("user"); });
          return true;
        },
      }),
    }, "atomic");
    try {
      await session.start();
      session.transition("running");
      await tick(5);
      const stream = (session as any).messageStream;
      const push = stream.push.bind(stream);
      stream.push = (message: unknown) => { events.push("push"); return push(message); };
      // requestThreadAction checks twice; the kill is queued from the second.
      killAt = checks + 2;

      await session.requestThreadAction({ kind: "compact" } as any);
      await tick(5);

      assert.deepEqual(events, ["push", "kill"]);
    } finally {
      if (session.status === "running") session.kill("user");
      harness.endMessages();
    }
  });
});
