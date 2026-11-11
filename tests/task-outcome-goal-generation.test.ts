import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalController } from "../src/goal-controller";
import { GoalTaskStore } from "../src/goal-store";
import type { SessionManager } from "../src/session-manager";
import type { GoalAuthorizationTicket, GoalTaskState, GoalVerifierRunResult } from "../src/types";
import { createTaskOutcomeReport, type TaskOutcomeInput } from "../src/session-task-outcome";
import { createStubSession } from "./helpers";

type Proof = GoalVerifierRunResult & {
  repositories?: TaskOutcomeInput["repositories"];
  sessionId?: string;
  executionCycle?: number;
};

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "oca-goal-generation-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Fixture User", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "goal change");
  const session = createStubSession({ id: "goal-session", status: "completed", startedAt: 100, workdir: dir });
  const notices: string[] = [];
  let reports = 0;
  let afterReport: (() => void) | undefined;
  const manager = {
    resolve: (ref: string) => ref === session.id ? session : undefined,
    reportTaskOutcome: async (_ref: string, input: TaskOutcomeInput) => {
      reports++;
      session.taskOutcome = createTaskOutcomeReport(input, { source: "goal_controller" });
      afterReport?.();
      return "Task outcome recorded: completed; verification passed.";
    },
    emitGoalTaskUpdate: (_task: unknown, text: string, label: string) => { notices.push(label); return text; },
  };
  // Authorization is a separate, already-covered subsystem. This fixture
  // grants an unchanged ticket so only execution-proof freshness is under test.
  const controller = new GoalController(manager as unknown as SessionManager);
  const internals = controller as unknown as {
    store: GoalTaskStore;
    checkTaskAuthorized: (task: GoalTaskState) => Promise<GoalAuthorizationTicket>;
    runVerifiers: (task: GoalTaskState) => Promise<Proof | undefined>;
    markTaskSucceeded: (task: GoalTaskState, summary: string, proof: Proof) => Promise<void>;
  };
  internals.store = new GoalTaskStore({ OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: join(dir, ".git", "goals.json") });
  internals.checkTaskAuthorized = async () => ({ isCurrent: () => true });
  const task: GoalTaskState = {
    id: "goal-task", name: "goal-task", goal: "Complete the requested goal and verifier suite.",
    workdir: dir, status: "running", createdAt: 1, updatedAt: 1,
    iteration: 0, maxIterations: 3, sessionId: session.id, repeatedFailureCount: 0, loopMode: "verifier",
    verifierCommands: [{ label: "required-check", command: "node -e 'setTimeout(() => process.stdout.write(\"PASS\"), 20)'" }],
  };
  internals.store.upsert(task);
  cleanup.push(() => { controller.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { session, task, internals, notices, reports: () => reports,
    afterReport: (callback: () => void) => { afterReport = callback; } };
}

describe("goal verifier evidence belongs to its execution cycle", () => {
  it("does not attribute a slow old verifier to a newer ended cycle with the same Git head", async () => {
    const f = fixture();
    let authorizations = 0;
    f.internals.checkTaskAuthorized = async () => {
      authorizations++;
      // The third authorization consumes the finished command's result. A
      // same-ID resume has ended by then without changing Git content.
      if (authorizations === 3) f.session.startedAt = 200;
      return { isCurrent: () => true };
    };
    const proof = await f.internals.runVerifiers(f.task);
    assert.ok(proof);
    assert.equal(proof.status, "pass");
    assert.equal(proof.sessionId, f.session.id);
    assert.equal(proof.executionCycle, 100);
    await f.internals.markTaskSucceeded(f.task, proof.summary, proof);
    assert.equal(f.session.startedAt, 200);
    assert.equal(f.reports(), 0);
    assert.equal(f.task.status, "running", "the stale proof must not fail or finish the newer task");
    assert.equal(f.notices.includes("goal-task-succeeded"), false);
  });

  it("does not announce goal success if the session resumes during report acceptance", async () => {
    const f = fixture();
    const proof = await f.internals.runVerifiers(f.task);
    assert.ok(proof);
    f.afterReport(() => { f.session.startedAt = 200; });
    await f.internals.markTaskSucceeded(f.task, proof.summary, proof);
    assert.equal(f.reports(), 1);
    assert.equal(f.task.status, "running");
    assert.equal(f.notices.includes("goal-task-succeeded"), false);
  });

  it("rechecks the proof after the final authorization await", async () => {
    const f = fixture();
    const proof = await f.internals.runVerifiers(f.task);
    assert.ok(proof);
    let authorizations = 0;
    f.internals.checkTaskAuthorized = async () => {
      authorizations++;
      if (authorizations === 2) f.session.startedAt = 200;
      return { isCurrent: () => true };
    };
    await f.internals.markTaskSucceeded(f.task, proof.summary, proof);
    assert.equal(f.reports(), 1);
    assert.equal(f.task.status, "running");
    assert.equal(f.notices.includes("goal-task-succeeded"), false);
  });
});
