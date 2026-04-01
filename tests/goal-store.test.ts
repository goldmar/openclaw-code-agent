import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { GoalTaskStore } from "../src/goal-store";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GoalTaskStore", () => {
  it("normalizes running tasks to waiting_for_session on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-store-"));
    tempDirs.push(dir);
    const path = join(dir, "goal-tasks.json");

    writeFileSync(path, JSON.stringify([{
      id: "goal-1",
      name: "fix-auth",
      goal: "Fix auth",
      workdir: "/tmp/project",
      status: "running",
      createdAt: 100,
      updatedAt: 200,
      iteration: 2,
      maxIterations: 8,
      verifierCommands: [{ label: "check-1", command: "npm test" }],
      repeatedFailureCount: 1,
    }]), "utf8");

    const store = new GoalTaskStore({
      OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: path,
    } as NodeJS.ProcessEnv);
    const task = store.get("goal-1");

    assert.ok(task);
    assert.equal(task?.status, "waiting_for_session");
    assert.equal(task?.iteration, 2);
    assert.equal(task?.verifierCommands[0]?.command, "npm test");
  });
});
