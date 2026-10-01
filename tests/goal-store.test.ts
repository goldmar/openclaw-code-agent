import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { GoalTaskStore, goalStoreInternals } from "../src/goal-store";
import { GoalController } from "../src/goal-controller";
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
  for (const status of ["succeeded", "failed", "stopped"] as const) {
    it(`preserves the complete organic ${status} record across reload and later active writes`, () => {
      const { path } = createGoalTasksPath();
      const store = createStore(path);
      const terminal = Object.assign(validTask({ status, fastMode: false, planApproved: false }), {
        route: { provider: "telegram", target: "fixture", historicalRoute: { keep: true } },
        historicalEvidence: { result: null, nested: [false, "", { extra: 1 }] },
      });
      store.upsert(terminal);
      const original = JSON.parse(readFileSync(path, "utf8"))[0];
      assert.equal(original.fastMode, false);
      assert.equal(original.planApproved, false);
      terminal.status = "running";
      terminal.historicalEvidence.nested.push("late external mutation");
      assert.equal(store.get(terminal.id)?.status, status);
      store.save();
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8"))[0], original);

      const restored = createStore(path);
      restored.upsert(validTask({ id: "active", status: "running" }));
      restored.save();
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).find((row: any) => row.id === terminal.id), original);
      assert.equal(createStore(path).get("active")?.status, "waiting_for_session");
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).find((row: any) => row.id === terminal.id), original);
    });
  }

  it("keeps malformed terminal evidence and absent fields without serializing compatibility defaults", () => {
    const { path } = createGoalTasksPath();
    const original = {
      id: "history", name: "history", goal: "Ship", workdir: "/tmp/project", status: "failed",
      verifierCommands: [null, { command: "", unrecognized: false }, "raw"],
      requiredVerifierCommands: null, historicalEvidence: { unknown: [] },
      route: { provider: "telegram", target: "fixture", extension: "raw" },
    };
    writeFileSync(path, JSON.stringify([original]), "utf8");
    const store = createStore(path);
    const view = store.get("history")!;
    assert.equal(view.maxIterations, 8);
    view.status = "running";
    view.verifierCommands.length = 0;
    store.list()[0]!.name = "mutated list view";
    assert.equal(store.get("history")?.status, "failed");
    assert.equal(store.get("history")?.name, "history");
    store.upsert(validTask({ id: "active" }));
    store.upsert(validTask({ id: "history", status: "succeeded" }));
    assert.throws(() => store.upsert(validTask({ id: "history", status: "running" })), /terminal.*identity/i);
    store.save();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).find((row: any) => row.id === "history"), original);
    assert.equal(store.get("history")?.status, "failed");
  });

  for (const statuses of [
    ["succeeded", "failed"], ["failed", "succeeded"],
    ["succeeded", "running"], ["running", "succeeded"],
  ] as const) {
    it(`archives duplicate authoritative IDs before normalization (${statuses.join(" / ")}) and restores no work`, async () => {
      const { dir, path } = createGoalTasksPath();
      const original = JSON.stringify(statuses.map((status) => validTask({ status, harnessSessionId: "real-saved-thread" })), null, 3);
      writeFileSync(path, original, "utf8");
      const store = createStore(path);
      assert.deepEqual(store.list(), []);
      assert.equal(store.get("goal-1"), undefined);
      const archives = readdirSync(dir).filter((name) => name.startsWith("goal-tasks.json.invalid-"));
      assert.equal(archives.length, 1);
      assert.equal(readFileSync(join(dir, archives[0]!), "utf8"), original);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
      let backendEffects = 0;
      const controller = new GoalController({
        resolveBackendConversationId: () => { backendEffects += 1; return "saved-thread"; },
        launchAndAwaitRunning: () => { backendEffects += 1; throw new Error("must not launch"); },
      } as any);
      (controller as any).store = store;
      controller.start();
      await (controller as any).restorePromise;
      controller.stop();
      assert.equal(backendEffects, 0);
      assert.equal(readFileSync(join(dir, archives[0]!), "utf8"), original);
    });
  }

  it("retains distinct authoritative IDs with duplicate human names", () => {
    const { path } = createGoalTasksPath();
    writeFileSync(path, JSON.stringify([validTask(), validTask({ id: "goal-2" })]), "utf8");
    const store = createStore(path);
    assert.equal(store.list().length, 2);
    assert.equal(store.get("goal-1")?.id, "goal-1");
    assert.equal(store.get("goal-2")?.id, "goal-2");
    assert.equal(store.get("fix-auth")?.id, "goal-1");
  });

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

  it("uses a suffixed archive path after a timestamp collision", (t) => {
    const { dir, path } = createGoalTasksPath();
    const invalidPayload = JSON.stringify({ tasks: [validTask()] });
    const now = 1700000000000;
    mkdirSync(`${path}.invalid-${now}.json`);
    t.mock.method(Date, "now", () => now);
    writeFileSync(path, invalidPayload, "utf8");

    const store = createStore(path);

    assert.deepEqual(store.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
    assert.equal(readFileSync(`${path}.invalid-${now}-1.json`, "utf8"), invalidPayload);

    const archived = readdirSync(dir).filter((name) => name.startsWith("goal-tasks.json.invalid-"));
    assert.equal(archived.length, 2);
  });

  it("does not treat a missing archive target as archived", (t) => {
    const { dir, path } = createGoalTasksPath();
    const warn = t.mock.method(console, "warn", () => {});

    assert.equal(goalStoreInternals.archiveGoalTasksFile(path, "missing"), false);
    assert.equal(existsSync(path), false);
    assert.equal(readdirSync(dir).some((name) => name.startsWith("goal-tasks.json.invalid-")), false);
    assert.equal(warn.mock.callCount(), 0);
  });

  it("preserves an invalid file and blocks writes and launch when archive suffixes are exhausted", async (t) => {
    const { dir, path } = createGoalTasksPath();
    const invalidPayload = JSON.stringify([validTask({ status: "succeeded" }), validTask({ status: "running" })], null, 2);
    const now = 1700000000000;
    t.mock.method(Date, "now", () => now);
    const warn = t.mock.method(console, "warn", () => {});

    mkdirSync(`${path}.invalid-${now}.json`);
    for (let suffix = 1; suffix <= goalStoreInternals.GOAL_TASK_ARCHIVE_COLLISION_SUFFIX_LIMIT; suffix += 1) {
      mkdirSync(`${path}.invalid-${now}-${suffix}.json`);
    }
    writeFileSync(path, invalidPayload, "utf8");

    const store = createStore(path);

    assert.deepEqual(store.list(), []);
    assert.equal(readFileSync(path, "utf8"), invalidPayload);

    const archived = readdirSync(dir).filter((name) => name.startsWith("goal-tasks.json.invalid-"));
    assert.equal(archived.length, goalStoreInternals.GOAL_TASK_ARCHIVE_COLLISION_SUFFIX_LIMIT + 1);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /no available archive path/);
    assert.throws(() => store.upsert(validTask()), /store is unavailable/);
    assert.throws(() => store.save(), /store is unavailable/);
    assert.deepEqual(store.list(), []);
    assert.equal(readFileSync(path, "utf8"), invalidPayload);
    let launches = 0;
    let confirmations = 0;
    const controller = new GoalController({
      launchAndAwaitRunning: () => { launches += 1; throw new Error("must not launch"); },
      sendGoalVerifierConfirmation: () => { confirmations += 1; },
    } as any);
    (controller as any).store = store;
    controller.start();
    await (controller as any).restorePromise;
    for (const requireVerifierConfirmation of [false, true]) {
      await assert.rejects(controller.launchTask({
        goal: "New goal", workdir: "/tmp/project", requireVerifierConfirmation,
        verifierCommands: [{ label: "CI", command: "true" }],
      }), /store is unavailable/);
    }
    assert.throws(() => controller.stop(), /store is unavailable/);
    assert.equal(launches, 0);
    assert.equal(confirmations, 0);
    assert.deepEqual(controller.listTasks(), []);
    assert.equal(readFileSync(path, "utf8"), invalidPayload);
  });
});
