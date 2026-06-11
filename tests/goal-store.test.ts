import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { GoalTaskStore, goalStoreInternals } from "../src/goal-store";
import type { GoalTaskState } from "../src/types";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function createGoalTasksPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "goal-store-"));
  tempDirs.push(dir);
  return { dir, path: join(dir, "goal-tasks.json") };
}

function createStore(path: string): GoalTaskStore {
  return new GoalTaskStore({
    OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: path,
  } as NodeJS.ProcessEnv);
}

function validTask(overrides: Partial<GoalTaskState> = {}): GoalTaskState {
  return {
    id: "goal-1",
    name: "fix-auth",
    goal: "Fix auth",
    workdir: "/tmp/project",
    status: "waiting_for_session",
    createdAt: 100,
    updatedAt: 200,
    iteration: 2,
    maxIterations: 8,
    loopMode: "verifier",
    verifierCommands: [{ label: "check-1", command: "npm test" }],
    repeatedFailureCount: 1,
    ...overrides,
  };
}

describe("GoalTaskStore", () => {
  it("normalizes running tasks to waiting_for_session on load", () => {
    const { path } = createGoalTasksPath();

    writeFileSync(path, JSON.stringify([validTask({ status: "running" })]), "utf8");

    const store = createStore(path);
    const task = store.get("goal-1");

    assert.ok(task);
    assert.equal(task?.status, "waiting_for_session");
    assert.equal(task?.iteration, 2);
    assert.equal(task?.verifierCommands[0]?.command, "npm test");

    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved[0].status, "waiting_for_session");
  });

  it("archives corrupt JSON and writes a clean replacement", () => {
    const { dir, path } = createGoalTasksPath();
    const corruptPayload = "{not-json";
    writeFileSync(path, corruptPayload, "utf8");

    const store = createStore(path);

    assert.deepEqual(store.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);

    const archived = readdirSync(dir).filter((name) => name.startsWith("goal-tasks.json.invalid-"));
    assert.equal(archived.length, 1);
    assert.equal(readFileSync(join(dir, archived[0]!), "utf8"), corruptPayload);
  });

  it("keeps missing file first-run behavior quiet", () => {
    const { dir, path } = createGoalTasksPath();

    const store = createStore(path);

    assert.deepEqual(store.list(), []);
    assert.equal(existsSync(path), false);
    assert.equal(readdirSync(dir).some((name) => name.startsWith("goal-tasks.json.invalid-")), false);
  });

  it("archives invalid wrong-shaped files and writes a clean replacement", () => {
    const { dir, path } = createGoalTasksPath();
    const invalidPayload = JSON.stringify({ tasks: [validTask()] });
    writeFileSync(path, invalidPayload, "utf8");

    const store = createStore(path);

    assert.deepEqual(store.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);

    const archived = readdirSync(dir).filter((name) => name.startsWith("goal-tasks.json.invalid-"));
    assert.equal(archived.length, 1);
    assert.equal(readFileSync(join(dir, archived[0]!), "utf8"), invalidPayload);
  });

  it("does not keep partial state when an entry is invalid", () => {
    const { dir, path } = createGoalTasksPath();
    const invalidPayload = JSON.stringify([
      validTask({ id: "goal-valid" }),
      { id: "goal-invalid", name: "bad-shape" },
    ]);
    writeFileSync(path, invalidPayload, "utf8");

    const store = createStore(path);

    assert.equal(store.get("goal-valid"), undefined);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);

    const archived = readdirSync(dir).filter((name) => name.startsWith("goal-tasks.json.invalid-"));
    assert.equal(archived.length, 1);
    assert.equal(readFileSync(join(dir, archived[0]!), "utf8"), invalidPayload);
  });

  it("preserves an invalid file when archiving fails", (t) => {
    const { dir, path } = createGoalTasksPath();
    const invalidPayload = JSON.stringify({ tasks: [validTask()] });
    const now = 1700000000000;
    mkdirSync(`${path}.invalid-${now}.json`);
    t.mock.method(Date, "now", () => now);
    writeFileSync(path, invalidPayload, "utf8");

    const store = createStore(path);

    assert.deepEqual(store.list(), []);
    assert.equal(readFileSync(path, "utf8"), invalidPayload);

    const archived = readdirSync(dir).filter((name) => name.startsWith("goal-tasks.json.invalid-"));
    assert.equal(archived.length, 1);
  });

  it("does not treat a missing archive target as archived", () => {
    const { dir, path } = createGoalTasksPath();

    assert.equal(goalStoreInternals.archiveGoalTasksFile(path, "missing"), false);
    assert.equal(existsSync(path), false);
    assert.equal(readdirSync(dir).some((name) => name.startsWith("goal-tasks.json.invalid-")), false);
  });
});
