import "./test-env";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGoalVerifierPolicyRevision, pluginConfig, setPluginConfig } from "../src/config";
import { GoalController, runVerifierCommand } from "../src/goal-controller";
import { GoalTaskStore } from "../src/goal-store";
import { resolveGoalLaunchRequest } from "../src/goal-launch-resolution";
import { SessionManager } from "../src/session-manager";
import { Session } from "../src/session";
import { SessionRuntimeBootstrapService } from "../src/session-runtime-bootstrap-service";
import { makeAgentGoalTool } from "../src/tools/agent-goal";
import { registerGoalCommand } from "../src/commands/goal";
import { executeRespond, requestPlanDecisionChanges, rejectPlanDecision } from "../src/actions/respond";
import { registerHarness } from "../src/harness";
import { createCallbackHandler } from "../src/callback-handler";
import { setGoalController, setSessionManager } from "../src/singletons";
import { createFakeHarness, createStubSession, tick } from "./helpers";
import type { GoalTaskState, GoalVerifierSpec } from "../src/types";

const dirs: string[] = [];
const ctx = { workspaceDir: "/tmp", oneShotCliRun: true };
const specs = (commands: string[]): GoalVerifierSpec[] => commands.map((command, index) => ({ label: `check-${index + 1}`, command }));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "goal-policy-"));
  dirs.push(dir);
  const store = new GoalTaskStore({ OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: join(dir, "goals.json") });
  let launches = 0;
  let confirmations = 0;
  let authorizer: ((id: string) => void) | undefined;
  const manager = {
    emitGoalTaskUpdate: () => {},
    sendGoalVerifierConfirmation: () => { confirmations += 1; },
    setGoalTaskAuthorizer: (callback: (id: string) => void) => { authorizer = callback; },
    kill: () => {},
    resolve: (): undefined => undefined,
    resolveBackendConversationId: (ref: string) => ref,
    launchAndAwaitRunning: async () => { launches += 1; return Object.assign(new EventEmitter(), createStubSession({ id: "session", name: "session", status: "running" })); },
  };
  const controller = new GoalController(manager as any);
  (controller as any).store = store;
  return { controller, store, dir, manager, counters: () => ({ launches, confirmations }), authorize: (id: string) => authorizer!(id) };
}
function task(commands: string[], overrides: Partial<GoalTaskState> = {}): GoalTaskState {
  return { id: "goal", name: "goal", goal: "Ship", workdir: "/tmp", status: "running", createdAt: 1,
    updatedAt: 2, iteration: 0, maxIterations: 1, loopMode: "verifier", verifierCommands: specs(commands), repeatedFailureCount: 0, ...overrides };
}
async function waitForFile(path: string) {
  for (let count = 0; count < 200; count += 1) {
    if (existsSync(path)) return;
    await tick(5);
  }
  assert.fail(`Shell fixture did not reach ${path}`);
}

beforeEach(() => setPluginConfig({}));
afterEach(() => { setPluginConfig({}); setGoalController(null); setSessionManager(null); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("operator-required goal suite admission", () => {
  it("injects the full ordered suite for omission and explicit Ralph, preserving duplicate steps", () => {
    setPluginConfig({ requiredGoalVerifierCommands: ["  bash ci.sh  ", "bash lint.sh", "bash ci.sh"] });
    for (const goalMode of [undefined, "ralph"] as const) {
      const result = resolveGoalLaunchRequest({ goal: "Ship", goalMode }, ctx);
      assert.equal(result.kind, "resolved");
      if (result.kind !== "resolved") return;
      assert.deepEqual(result.verifierCommands, specs(["bash ci.sh", "bash lint.sh", "bash ci.sh"]));
      assert.equal(result.loopMode, goalMode ?? "verifier");
    }
  });

  it("copies config arrays and tracks meaningful policy changes including A -> B -> A", () => {
    const commands = [" true "];
    setPluginConfig({ requiredGoalVerifierCommands: commands });
    const revision = getGoalVerifierPolicyRevision();
    commands[0] = "false";
    assert.deepEqual(pluginConfig.requiredGoalVerifierCommands, [" true "]);
    setPluginConfig({ requiredGoalVerifierCommands: ["true"], idleTimeoutMinutes: 2 });
    assert.equal(getGoalVerifierPolicyRevision(), revision);
    setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    assert.equal(getGoalVerifierPolicyRevision(), revision + 2);
  });

  it("fails closed for malformed runtime config before storing or launching anything", async () => {
    const f = fixture();
    for (const requiredGoalVerifierCommands of [null, "true", [], [""], [" \n "], ["true", 5], {}]) {
      setPluginConfig({ requiredGoalVerifierCommands } as any);
      const result = resolveGoalLaunchRequest({ goal: "Ship" }, ctx);
      assert.equal(result.kind, "error");
      await assert.rejects(f.controller.launchTask({ goal: "Ship", workdir: f.dir }), /requiredGoalVerifierCommands/);
      assert.deepEqual(f.store.list(), []);
      assert.deepEqual(f.counters(), { launches: 0, confirmations: 0 });
    }
  });

  it("rejects weaker, reordered, blank, malformed and shell-expanded selection atomically", async () => {
    const f = fixture();
    setPluginConfig({ requiredGoalVerifierCommands: ["bash ci.sh", "bash lint.sh", "bash ci.sh"] });
    const selections: unknown[] = [[], ["true"], ["bash ci.sh"], ["bash lint.sh", "bash ci.sh", "bash ci.sh"],
      ["bash ci.sh", "bash lint.sh"], ["bash ci.sh", "bash lint.sh", ""], ["bash ci.sh", "bash lint.sh", "bash ci.sh", "true"],
      ["bash ci.sh", "bash lint.sh", "bash ci.sh || true"], ["bash ci.sh", "bash lint.sh", "bash ci.sh\ntrue"],
      ["bash ci.sh", "bash lint.sh", "bash  ci.sh"], ["bash ci.sh", "bash lint.sh", "BASH ci.sh"],
      ["bash ci.sh", "bash lint.sh", "bash ./ci.sh"], ["bash ci.sh", "bash lint.sh", null], "true"];
    for (const selection of selections) {
      assert.equal(resolveGoalLaunchRequest({ goal: "Ship", verifierCommands: selection as any }, ctx).kind, "error");
      const raw = Array.isArray(selection) ? selection.map((command) => ({ label: "check", command })) : selection;
      await assert.rejects(f.controller.launchTask({ goal: "Ship", workdir: f.dir, verifierCommands: raw as any,
        loopMode: "ralph", requireVerifierConfirmation: false, permissionMode: "bypassPermissions" }));
      assert.deepEqual(f.store.list(), []);
      assert.deepEqual(f.counters(), { launches: 0, confirmations: 0 });
    }
    await assert.rejects(f.controller.launchTask({ goal: "Ship", workdir: f.dir, verifierCommands: [{ command: "bash ci.sh" }] as any }));
  });

  it("enforces tool, slash and direct launch while leaving no-policy weak checks available", async () => {
    const f = fixture();
    setGoalController(f.controller);
    const tool = makeAgentGoalTool(ctx);
    let handler!: (ctx: any) => Promise<{ text: string }>;
    registerGoalCommand({ registerCommand(command) { handler = command.handler; } });
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    const denied = await tool.execute("tool", { action: "launch", goal: "Ship", verifier_commands: ["false"] });
    assert.equal(denied.isError, true);
    assert.match((await handler({ ...ctx, args: '--verify "false" Ship' })).text, /complete ordered/);
    assert.deepEqual(f.counters(), { launches: 0, confirmations: 0 });
    const launched = await tool.execute("tool", { action: "launch", goal: "Ship", goal_mode: "ralph" });
    assert.equal(launched.isError, false);
    assert.match(launched.content[0].text, /Operator-required verifiers:/);
    await handler({ ...ctx, args: "Ship" });
    const direct = await f.controller.launchTask({ goal: "Direct", workdir: f.dir });
    assert.deepEqual(direct.requiredVerifierCommands, ["true"]);
    assert.deepEqual(f.counters(), { launches: 3, confirmations: 0 });
    setPluginConfig({});
    await f.controller.launchTask({ goal: "Legacy", workdir: f.dir, verifierCommands: specs(["false"]) });
    assert.equal(f.counters().launches, 4, "negative control: compatibility admits caller checks");
  });

  it("rejects attempted verifier edits and stale confirmation without changing selection", async () => {
    const f = fixture();
    setGoalController(f.controller);
    const waiting = await f.controller.launchTask({ goal: "Ship", workdir: f.dir, verifierCommands: specs(["true"]), requireVerifierConfirmation: true });
    const original = structuredClone(waiting.verifierCommands);
    for (const fields of [{ verifier_commands: ["false"] }, { goal_mode: "ralph" }, { completion_promise: "DONE" }]) {
      const result = await makeAgentGoalTool(ctx).execute("edit", { action: "edit", task: waiting.id, goal: "New", ...fields });
      assert.equal(result.isError, true);
    }
    setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
    await assert.rejects(f.controller.confirmVerifierCommands(waiting.id), /policy changed|stored suite/);
    assert.equal(waiting.status, "failed");
    assert.deepEqual(waiting.verifierCommands, original);
    assert.equal(f.counters().launches, 0);
    assert.equal((await f.controller.confirmVerifierCommands(waiting.id))?.action, "not_waiting");
    assert.equal(f.controller.stopTask(waiting.id)?.action, "already_terminal");
  });
});

describe("required suite execution and recovery", () => {
  it("executes the complete ordered suite including duplicates; a later failure cannot succeed", async () => {
    const f = fixture();
    const commands = ["printf A >> trace", "printf A >> trace", "printf B >> trace; exit 3"];
    setPluginConfig({ requiredGoalVerifierCommands: commands });
    const current = task(commands, { workdir: f.dir });
    f.store.upsert(current);
    await (f.controller as any).handleTerminalSession(current, createStubSession({ status: "completed" }));
    assert.equal(readFileSync(join(f.dir, "trace"), "utf8"), "AAB");
    assert.equal(current.status, "failed");
    assert.match(current.lastVerifierSummary ?? current.failureReason ?? "", /FAIL check-3/);
    assert.deepEqual(current.requiredVerifierCommands, commands, "matching legacy selection bound without replacement");
  });

  it("Ralph needs both its promise and every operator check, even after config removal", async () => {
    for (const command of ["false", "true"]) {
      const f = fixture();
      setPluginConfig({ requiredGoalVerifierCommands: [command] });
      const current = await f.controller.launchTask({ goal: "Ralph", workdir: f.dir, loopMode: "ralph", maxIterations: 1 });
      setPluginConfig({});
      await (f.controller as any).handleTerminalSession(current, createStubSession({ status: "completed", getOutput: () => ["<promise>DONE</promise>"] }));
      assert.equal(current.status, command === "true" ? "succeeded" : "failed");
      assert.deepEqual(current.requiredVerifierCommands, [command]);
    }
  });

  it("Ralph promise-only is denied under required policy and remains compatible when absent", async () => {
    const f = fixture();
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    const blocked = task([], { loopMode: "ralph", completionPromise: "DONE" });
    await (f.controller as any).handleTerminalSession(blocked, createStubSession({ status: "completed", getOutput: () => ["DONE"] }));
    assert.equal(blocked.status, "failed");
    setPluginConfig({});
    const legacy = task([], { id: "legacy", loopMode: "ralph", completionPromise: "DONE" });
    await (f.controller as any).handleTerminalSession(legacy, createStubSession({ status: "completed", getOutput: () => ["DONE"] }));
    assert.equal(legacy.status, "succeeded");
  });

  for (const transition of ["changed", "roundtrip", "equivalent"] as const) {
    it(`revalidates policy after an awaited process (${transition}) before another spawn or success`, async () => {
      const f = fixture();
      const first = "touch started; while [ ! -f release ]; do sleep 0.01; done; printf A >> trace";
      const commands = [first, "printf B >> trace"];
      setPluginConfig({ requiredGoalVerifierCommands: commands });
      const current = task(commands, { workdir: f.dir, maxIterations: 8 });
      f.store.upsert(current);
      const evaluation = (f.controller as any).handleTerminalSession(current, createStubSession({ status: "completed" }));
      await waitForFile(join(f.dir, "started"));
      if (transition === "equivalent") setPluginConfig({ requiredGoalVerifierCommands: commands.map((c) => ` ${c} `), idleTimeoutMinutes: 1 });
      else {
        setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
        if (transition === "roundtrip") setPluginConfig({ requiredGoalVerifierCommands: commands });
      }
      writeFileSync(join(f.dir, "release"), "");
      await evaluation;
      assert.equal(readFileSync(join(f.dir, "trace"), "utf8"), transition === "equivalent" ? "AB" : "A");
      assert.equal(current.status, transition === "equivalent" ? "succeeded" : "failed");
      assert.equal(f.counters().launches, 0, "no repair starts for a policy failure");
    });
  }

  it("blocks all controller continuation paths before launch or automatic reply", async () => {
    for (const phase of ["restore", "idle", "ralph", "repair", "reply", "edit"] as const) {
      const f = fixture();
      const current = task(["true"], { workdir: f.dir, maxIterations: 8, harnessSessionId: "thread", sessionId: "session", loopMode: phase === "ralph" ? "ralph" : "verifier" });
      f.store.upsert(current);
      setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
      const session = createStubSession({ status: phase === "reply" ? "running" : "completed", harnessSessionId: "thread", getOutput: () => ["Should I continue?"], pendingInputState: phase === "reply" ? { kind: "question" } : undefined });
      if (phase === "restore") { (f.controller as any).started = true; await (f.controller as any).restoreRecoverableTasks(); }
      else if (phase === "idle") await (f.controller as any).resumeAfterIdleTimeout(current, session, "Continue");
      else if (phase === "reply") await (f.controller as any).handleRunningSession(current, session);
      else if (phase === "edit") assert.throws(() => f.controller.editTask(current.id, "New"), /policy changed/);
      else await (f.controller as any).handleTerminalSession(current, session);
      assert.equal(current.status, "failed", phase);
      assert.equal(f.counters().launches, 0, phase);
      assert.deepEqual(current.verifierCommands, specs(["true"]));
    }
  });

  it("preserves malformed persisted evidence and terminal historical rows without grandfathering active state", () => {
    const f = fixture();
    const historical = task(["true"], { status: "succeeded", lastVerifierSummary: "old proof", lastVerifierFingerprint: "old hash" });
    (historical.verifierCommands as any[]).push({ command: "false" });
    const active = task(["true"], { id: "active" });
    (active.verifierCommands as any[]).push({ label: "bad", command: " " });
    const invalidBinding = task(["true"], { id: "invalid-binding", requiredVerifierCommands: null as any });
    const path = join(f.dir, "roundtrip.json");
    writeFileSync(path, JSON.stringify([historical, active, invalidBinding]));
    const store = new GoalTaskStore({ OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: path });
    (f.controller as any).store = store;
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    assert.throws(() => f.authorize("active"));
    assert.throws(() => f.authorize("invalid-binding"), /binding/);
    assert.deepEqual(JSON.parse(JSON.stringify(store.get("goal"))), historical);
    assert.deepEqual(store.get("active")?.verifierCommands, active.verifierCommands);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8"))[0], historical);
  });

  it("late turn events cannot resurrect a failed task", () => {
    const f = fixture();
    const current = task(["true"]);
    f.store.upsert(current);
    const session = Object.assign(new EventEmitter(), createStubSession({ status: "running" }));
    (f.controller as any).attachSessionObservers(current, session);
    setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
    assert.throws(() => f.authorize(current.id));
    session.emit("turnEnd");
    assert.equal(current.status, "failed");
  });

  it("honestly pins selection, while editing the selected script changes its result", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "ci.sh"), "exit 9\n");
    const spec = { label: "gate", command: "bash ci.sh" };
    assert.equal((await runVerifierCommand(f.dir, spec)).ok, false);
    writeFileSync(join(f.dir, "ci.sh"), "exit 0\n");
    assert.equal((await runVerifierCommand(f.dir, spec)).ok, true);
  });
});

describe("goal-owned session execution boundaries", () => {
  it("inherits canonical goal ownership for active and persisted nonfork resumes; conflicts cannot detach it", async () => {
    const f = fixture();
    const current = task(["true"]);
    f.store.upsert(current);
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    const manager = new SessionManager(5);
    manager.setGoalTaskAuthorizer((id) => f.authorize(id));
    const owner = createStubSession({ id: "owner", harnessSessionId: "thread", backendRef: { kind: "claude-code", conversationId: "thread" }, goalTaskId: current.id });
    (manager as any).sessions.set("owner", owner);
    const launch = { prompt: "Continue", workdir: f.dir, resumeSessionId: "thread" };
    assert.equal((manager as any).goalOwnedLaunch(launch).goalTaskId, "goal");
    assert.throws(() => (manager as any).goalOwnedLaunch({ ...launch, goalTaskId: "other" }), /change its goal owner/);
    assert.equal((manager as any).goalOwnedLaunch({ ...launch, forkSession: true }).goalTaskId, undefined);
    assert.throws(() => (manager as any).goalOwnedLaunch({ ...launch, forkSession: true, goalTaskId: "goal" }), /fork/);
    (manager as any).sessions.clear();
    const originalGet = manager.getPersistedSession.bind(manager);
    manager.getPersistedSession = (ref) => ref === "thread" ? { sessionId: "owner", goalTaskId: "goal" } as any : originalGet(ref);
    assert.equal((manager as any).goalOwnedLaunch(launch).goalTaskId, "goal");
    let preparation = 0;
    (manager as any).restore.prepareSpawn = () => { preparation += 1; throw new Error("must not prepare"); };
    setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
    await assert.rejects(manager.launchSession(launch), /policy changed/);
    assert.equal(preparation, 0);
    assert.equal(current.status, "failed");
    assert.throws(() => manager.assertGoalTaskAuthorized("missing"), /missing/);
    assert.throws(() => manager.assertGoalTaskAuthorized("goal"), /already failed/);
    assert.doesNotThrow(() => manager.assertGoalTaskAuthorized());
    (manager as any).sessions.clear();
  });

  it("generic response denies stale approval and resume before mutating permissions or launching", async () => {
    const f = fixture();
    const current = task(["true"]);
    f.store.upsert(current);
    setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
    const manager = new SessionManager(5);
    manager.setGoalTaskAuthorizer((id) => f.authorize(id));
    for (const status of ["running", "killed"] as const) {
      let releases = 0;
      const owner = createStubSession({ status, goalTaskId: "goal", pendingPlanApproval: true,
        harnessSessionId: "thread", switchPermissionMode: () => { releases += 1; }, sendMessage: async () => { releases += 1; } });
      (manager as any).sessions.set(owner.id, owner);
      manager.launchAndAwaitRunning = async () => { releases += 1; throw new Error("must not resume"); };
      const result = await executeRespond(manager, { session: owner.id, message: "Approved", approve: true, userInitiated: true, userApproval: "button" });
      assert.equal(result.isError, true);
      assert.equal(releases, 0);
    }
    (manager as any).sessions.clear();
  });

  it("actual harness startup after a deferred teardown rechecks the live goal", async () => {
    const f = fixture();
    const current = task(["true"]);
    f.store.upsert(current);
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    const harness = createFakeHarness("goal-delayed-start");
    registerHarness(harness);
    const session = new Session({ prompt: "Work", workdir: f.dir, harness: harness.name, goalTaskId: "goal", assertGoalTaskAuthorized: () => f.authorize("goal") }, "delayed");
    const barrier = Promise.withResolvers<void>();
    const bootstrap = new SessionRuntimeBootstrapService({ hydrateSpawnedSession: () => {}, markRunning: () => {}, handleTerminal: async () => {}, handleTurnEnd: async () => {}, formatLaunchWorkdirLabel: () => f.dir, notifySession: () => {} });
    await bootstrap.initializeSession(session, {} as any, {} as any, { startAfter: barrier.promise, notifyLaunch: false });
    setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
    barrier.resolve();
    await barrier.promise;
    await tick(10);
    assert.equal(harness.lastLaunchOptions, undefined);
    assert.equal(session.status, "failed");
    assert.equal(current.status, "failed");
  });

  it("actual Session input, thread action and native plan release revalidate before backend work", async () => {
    const f = fixture();
    const current = task(["true"]);
    f.store.upsert(current);
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    const harness = createFakeHarness("goal-input-guard", { nativePlanDecisions: true });
    registerHarness(harness);
    const session = new Session({ prompt: "Work", workdir: f.dir, harness: harness.name, goalTaskId: "goal", assertGoalTaskAuthorized: () => f.authorize("goal") }, "input");
    await session.start();
    session.transition("running");
    let submissions = 0;
    const handle = (session as any).harnessHandle;
    handle.submitPendingInputText = async () => { submissions += 1; return true; };
    handle.submitPendingInputOption = async () => { submissions += 1; return true; };
    session.pendingInputState = { requestId: "request", kind: "question", promptText: "Continue?", options: [], allowsFreeText: true };
    session.pendingPlanApproval = true;
    setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
    await assert.rejects(session.sendMessage("approve"));
    await assert.rejects(session.submitPendingInputText("yes"));
    await assert.rejects(session.submitPendingInputOption(0));
    assert.throws(() => session.requestThreadAction({ kind: "compact" }));
    assert.equal(submissions, 0);
    assert.deepEqual(harness.planDecisions, []);
    assert.equal(harness.lastSetPermissionMode, undefined);
    session.kill("user"); harness.endMessages();
  });

  for (const boundary of ["steer", "native-plan", "permission-mode"] as const) {
    it(`does not queue follow-up work after policy changes during ${boundary}`, async () => {
      const f = fixture();
      const current = task(["true"]);
      f.store.upsert(current);
      setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
      const harness = createFakeHarness(`goal-await-${boundary}`);
      registerHarness(harness);
      const session = new Session({ prompt: "Work", workdir: f.dir, harness: harness.name, multiTurn: true,
        goalTaskId: "goal", assertGoalTaskAuthorized: () => f.authorize("goal") }, boundary);
      await session.start(); session.transition("running"); await tick(5);
      const before = harness.consumedPrompts.length;
      const pending = Promise.withResolvers<boolean>();
      const entered = Promise.withResolvers<void>();
      const handle = (session as any).harnessHandle;
      if (boundary === "steer") {
        (session as any).turnInProgress = true;
        handle.steer = () => { entered.resolve(); return pending.promise; };
      } else {
        (session as any).pendingModeSwitch = "bypassPermissions";
        if (boundary === "native-plan") handle.resolvePlanDecision = () => { entered.resolve(); return pending.promise; };
        else handle.setPermissionMode = () => { entered.resolve(); return pending.promise; };
      }
      const sending = session.sendMessage("approve and do more");
      await entered.promise;
      setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
      pending.resolve(boundary === "native-plan");
      await assert.rejects(sending);
      await tick(5);
      assert.equal(harness.consumedPrompts.length, before, "no queued follow-up after an invalidated await");
      assert.equal(current.status, "failed");
      session.kill("user"); harness.endMessages();
    });
  }
});


describe("independent M1 review regressions", () => {
  for (const loopMode of ["verifier", "ralph"] as const) {
    for (const exit of ["true", "false"]) {
      it(`rejects A -> B -> A in final proof await before ${loopMode} ${exit === "true" ? "success" : "repair"}`, async () => {
        const f = fixture();
        const command = `printf X >> proof; ${exit}`;
        setPluginConfig({ requiredGoalVerifierCommands: [command] });
        const current = task([command], { workdir: f.dir, maxIterations: 8, loopMode, completionPromise: "DONE" });
        f.store.upsert(current);
        const run = (f.controller as any).runVerifiers.bind(f.controller);
        (f.controller as any).runVerifiers = (target: GoalTaskState) => {
          const pending = run(target);
          pending.then(() => {
            setPluginConfig({ requiredGoalVerifierCommands: ["different-policy"] });
            setPluginConfig({ requiredGoalVerifierCommands: [command] });
          });
          return pending;
        };
        await (f.controller as any).handleTerminalSession(current, createStubSession({ status: "completed", getOutput: () => ["DONE"] }));
        assert.equal(readFileSync(join(f.dir, "proof"), "utf8"), "X", "real shell batch executed");
        assert.equal(current.status, "failed");
        assert.match(current.failureReason ?? "", /before the check result was consumed/);
        assert.equal(f.counters().launches, 0, "stale failure proof cannot initiate repair either");
      });
    }
  }

  it("missing canonical goal IDs cannot authorize through a different task's name", async () => {
    const f = fixture();
    const unrelated = task(["true"], { id: "actual", name: "missing-id" });
    f.store.upsert(unrelated);
    const evidence = JSON.stringify(unrelated);
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    assert.equal(f.controller.getTask("missing-id"), unrelated, "human-facing name lookup remains available");
    assert.throws(() => f.authorize("missing-id"), /owner is missing/);
    const manager = new SessionManager(5);
    manager.setGoalTaskAuthorizer((id) => f.authorize(id));
    const original = createStubSession({ id: "original", status: "killed", goalTaskId: "missing-id", backendRef: { kind: "claude-code", conversationId: "original-thread" } });
    (manager as any).sessions.set(original.id, original);
    let preparation = 0;
    (manager as any).restore.prepareSpawn = () => { preparation += 1; throw new Error("must not prepare"); };
    await assert.rejects(manager.launchSession({ prompt: "Continue", workdir: f.dir, resumeSessionId: "original-thread" }), /owner is missing/);
    assert.equal(preparation, 0);
    assert.equal(manager.get(original.id), original);
    assert.equal(JSON.stringify(unrelated), evidence, "no binding or failure mutation of unrelated task");
    (manager as any).sessions.clear();
  });

  for (const persistedOnly of [false, true]) {
    it(`fork cannot replace a ${persistedOnly ? "persisted-only" : "live"} goal stable identity; legitimate fork remains independent`, async () => {
      const f = fixture();
      const current = task(["true"], { sessionId: "original" });
      f.store.upsert(current);
      setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
      const manager = new SessionManager(5);
      manager.setGoalTaskAuthorizer((id) => f.authorize(id));
      const original = createStubSession({ id: "original", name: "original", status: "killed", goalTaskId: "goal", backendRef: { kind: "claude-code", conversationId: "original-thread" } });
      if (!persistedOnly) (manager as any).sessions.set(original.id, original);
      const saved = { sessionId: "original", name: "original", status: "killed", goalTaskId: "goal", backendRef: original.backendRef };
      manager.getPersistedSession = (ref: string) => ["original", "original-thread"].includes(ref) ? saved as any : undefined;
      let preparation = 0;
      let persistedWrites = 0;
      manager.updatePersistedSession = () => { persistedWrites += 1; return true; };
      (manager as any).checkRepoPolicyForLaunch = async () => ({ ok: true, resolution: { source: "none", provider: "unsupported", prAvailable: false } });
      (manager as any).restore.prepareSpawn = async () => { preparation += 1; return { actualWorkdir: f.dir, originalWorkdir: f.dir }; };
      (manager as any).runtimeBootstrap.initializeSession = async (session: Session) => session;
      const base = { prompt: "Fork", workdir: f.dir, harness: "claude-code", resumeSessionId: "original-thread", forkSession: true, worktreeStrategy: "off" as const, route: { provider: "system", target: "system" } };
      for (const resumeSessionId of ["original-thread", "different-thread"]) {
        await assert.rejects(manager.launchSession({ ...base, resumeSessionId, sessionIdOverride: "original" }), /cannot reuse an existing session identity/);
      }
      assert.equal(preparation, 0);
      assert.equal(persistedWrites, 0);
      assert.equal((manager as any).sessions.get("original"), persistedOnly ? undefined : original);
      assert.equal(saved.goalTaskId, "goal");
      const independent = await manager.launchSession(base);
      assert.notEqual(independent.id, "original");
      assert.equal(independent.goalTaskId, undefined);
      assert.equal(preparation, 1);
      assert.equal(saved.goalTaskId, "goal");
      assert.equal(current.status, "running");
      assert.equal(current.sessionId, "original");
      independent.emit("turnEnd");
      assert.equal(current.status, "running", "independent fork cannot complete the original goal");
      (manager as any).sessions.clear();
    });
  }

  for (const persistedOnly of [false, true]) {
    it(`direct Revise callback action denies ${persistedOnly ? "persisted-only" : "active"} goal workflow before side effects, while Reject stays available`, () => {
      const f = fixture();
      const current = task(["true"]);
      f.store.upsert(current);
      setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
      const manager = new SessionManager(5);
      manager.setGoalTaskAuthorizer((id) => f.authorize(id));
      const original = createStubSession({ id: "original", name: "original", status: "running", goalTaskId: "goal", pendingPlanApproval: true, approvalState: "pending", planDecisionVersion: 1 });
      if (!persistedOnly) (manager as any).sessions.set(original.id, original);
      const saved = { sessionId: "original", name: "original", status: "killed", goalTaskId: "goal", pendingPlanApproval: true, approvalState: "pending", planDecisionVersion: 1 };
      manager.getPersistedSession = () => saved as any;
      const effects: string[] = [];
      manager.clearPlanDecisionTokens = () => { effects.push("tokens"); };
      manager.updatePersistedSession = () => { effects.push("persist"); return true; };
      manager.queueOrchestratorContext = () => { effects.push("context"); return true; };
      manager.kill = () => { effects.push("kill"); return true; };
      const blocked = requestPlanDecisionChanges(manager, "original");
      assert.equal(blocked.isError, true);
      assert.match(blocked.text, /policy changed/);
      assert.deepEqual(effects, []);
      assert.equal(original.approvalState, "pending");
      assert.equal(saved.approvalState, "pending");
      assert.equal(current.status, "failed");
      setPluginConfig({ requiredGoalVerifierCommands: [] });
      assert.equal(rejectPlanDecision(manager, "original").isError, undefined);
      assert.ok(effects.includes("tokens"));
      assert.ok(effects.includes("persist"));
      assert.ok(!effects.includes("context"));
      (manager as any).sessions.clear();
    });
  }
});


describe("sparse runtime input admission (R5)", () => {
  it("rejects every sparse explicit command/spec position before insertion or execution", async () => {
    const f = fixture();
    for (const missing of [0, 1, 2]) {
      const strings = ["true", "true", "true"];
      delete strings[missing];
      setPluginConfig({ requiredGoalVerifierCommands: ["true", "true", "true"] });
      assert.equal(resolveGoalLaunchRequest({ goal: "Malformed", verifierCommands: strings }, ctx).kind, "error");
      const entries = specs(["true", "true", "true"]);
      delete entries[missing];
      for (const verifierCommands of [entries, Array(3)]) {
        await assert.rejects(f.controller.launchTask({ goal: "Malformed", workdir: f.dir, loopMode: "ralph", verifierCommands, requireVerifierConfirmation: true }));
        assert.deepEqual(f.store.list(), []);
        assert.deepEqual(f.counters(), { launches: 0, confirmations: 0 });
      }
    }
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    assert.equal(resolveGoalLaunchRequest({ goal: "Malformed", verifierCommands: Array(1) }, ctx).kind, "error");
    await assert.rejects(f.controller.launchTask({ goal: "Malformed", workdir: f.dir, loopMode: "ralph", verifierCommands: Array(1) }));
    assert.deepEqual(f.store.list(), []);
    const dense = await f.controller.launchTask({ goal: "Dense", workdir: f.dir, verifierCommands: specs(["true"]) });
    assert.deepEqual(dense.requiredVerifierCommands, ["true"], "dense matching suite still admits");
    assert.equal(f.counters().launches, 1);
  });

  it("fails closed for sparse operator config even when injected without config copying", async () => {
    const f = fixture();
    for (const inject of [false, true]) {
      setPluginConfig({ requiredGoalVerifierCommands: Array(1) });
      if (inject) pluginConfig.requiredGoalVerifierCommands = Array(1);
      assert.equal(resolveGoalLaunchRequest({ goal: "Malformed" }, ctx).kind, "error");
      await assert.rejects(f.controller.launchTask({ goal: "Malformed", workdir: f.dir, loopMode: "ralph" }), /requiredGoalVerifierCommands/);
      assert.deepEqual(f.store.list(), []);
      assert.deepEqual(f.counters(), { launches: 0, confirmations: 0 });
    }
  });

  it("preserves sparse serialized binding evidence as null and denies active use without changing history", () => {
    const f = fixture();
    const active = task(["true"], { id: "active-sparse", requiredVerifierCommands: Array(1) });
    const historical = task(["true"], { id: "terminal-sparse", status: "succeeded", requiredVerifierCommands: Array(1), lastVerifierSummary: "original evidence" });
    const path = join(f.dir, "sparse-binding.json");
    writeFileSync(path, JSON.stringify([active, historical]));
    const store = new GoalTaskStore({ OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: path });
    (f.controller as any).store = store;
    assert.throws(() => f.authorize("active-sparse"), /binding/);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved[0].requiredVerifierCommands, [null]);
    assert.equal(saved[0].status, "failed");
    assert.deepEqual(saved[1], JSON.parse(JSON.stringify(historical)));
  });
});


describe("canonical session identity precedes human aliases (R6)", () => {
  for (const persistedOnly of [false, true]) {
    for (const permitted of [false, true]) {
      it(`${persistedOnly ? "persisted" : "active"} backend owner hidden by a name alias is ${permitted ? "inherited" : "denied before launch"}`, async () => {
        const f = fixture();
        const current = task(["true"]);
        f.store.upsert(current);
        setPluginConfig({ requiredGoalVerifierCommands: [permitted ? "true" : "false"] });
        const manager = new SessionManager(5, 100, { store: { indexPath: join(f.dir, "sessions.json") } });
        manager.setGoalTaskAuthorizer((id) => f.authorize(id));
        const source = createStubSession({ id: "original-session", name: "original", status: "killed", goalTaskId: "goal", backendRef: { kind: "claude-code", conversationId: "original-thread" } });
        const mask = createStubSession({ id: "unrelated-session", name: "original-thread", status: "killed", backendRef: { kind: "claude-code", conversationId: "unrelated-thread" } });
        if (!persistedOnly) {
          (manager as any).sessions.set(source.id, source);
          (manager as any).sessions.set(mask.id, mask);
          assert.equal(manager.resolve("original-thread"), mask, "human-facing alias lookup is unchanged");
        } else {
          const sourceRow = { sessionId: source.id, name: source.name, status: "killed", goalTaskId: "goal", backendRef: source.backendRef, harnessSessionId: "original-thread", route: { provider: "system", target: "system" }, createdAt: 1 };
          const maskRow = { sessionId: mask.id, name: mask.name, status: "killed", backendRef: mask.backendRef, harnessSessionId: "unrelated-thread", route: { provider: "system", target: "system" }, createdAt: 2 };
          (manager as any).store.replacePersistedSession(sourceRow);
          (manager as any).store.replacePersistedSession(maskRow);
          assert.equal(manager.getPersistedSession("original-thread")?.sessionId, mask.id);
        }
        const originalDisk = existsSync(join(f.dir, "sessions.json")) ? readFileSync(join(f.dir, "sessions.json"), "utf8") : undefined;
        let preparation = 0;
        let initialization = 0;
        (manager as any).checkRepoPolicyForLaunch = async () => ({ ok: true, resolution: { source: "none", provider: "unsupported", prAvailable: false } });
        (manager as any).restore.prepareSpawn = async () => { preparation += 1; return { actualWorkdir: f.dir, originalWorkdir: f.dir }; };
        (manager as any).runtimeBootstrap.initializeSession = async (session: Session) => { initialization += 1; return session; };
        const launch = { prompt: "Continue original", workdir: f.dir, resumeSessionId: "original-thread", harness: "claude-code", worktreeStrategy: "off" as const, route: { provider: "system", target: "system" } };
        const beforeCount = (manager as any).sessions.size;
        if (permitted) {
          const resumed = await manager.launchSession(launch);
          assert.equal(resumed.goalTaskId, "goal");
          assert.equal(resumed.resumeSessionId, "original-thread");
          assert.equal(preparation, 1);
          assert.equal(initialization, 1);
        } else {
          await assert.rejects(manager.launchSession(launch), /policy changed/);
          assert.equal(preparation, 0);
          assert.equal(initialization, 0);
          assert.equal((manager as any).sessions.size, beforeCount, "no registration or replacement");
          assert.equal(current.status, "failed");
          assert.equal(existsSync(join(f.dir, "sessions.json")) ? readFileSync(join(f.dir, "sessions.json"), "utf8") : undefined, originalDisk, "session evidence was not rewritten");
        }
        (manager as any).sessions.clear();
      });
    }
  }

  for (const persistedOnly of [false, true]) {
    it(`rejects conflicting ${persistedOnly ? "persisted" : "active"} stable/backend goal owners before preparation`, async () => {
      const f = fixture();
      const first = task(["true"], { id: "first" });
      const second = task(["true"], { id: "second" });
      f.store.upsert(first); f.store.upsert(second);
      setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
      const manager = new SessionManager(5, 100, { store: { indexPath: join(f.dir, "conflicts.json") } });
      manager.setGoalTaskAuthorizer((id) => f.authorize(id));
      const sourceA = createStubSession({ id: "stable-a", name: "first", status: "killed", goalTaskId: "first", backendRef: { kind: "claude-code", conversationId: "backend-a" } });
      const sourceB = createStubSession({ id: "stable-b", name: "second", status: "killed", goalTaskId: "second", backendRef: { kind: "claude-code", conversationId: "backend-b" } });
      for (const source of [sourceA, sourceB]) {
        if (!persistedOnly) (manager as any).sessions.set(source.id, source);
        else (manager as any).store.replacePersistedSession({ sessionId: source.id, name: source.name, status: "killed", goalTaskId: source.goalTaskId, backendRef: source.backendRef, harnessSessionId: source.backendRef!.conversationId, route: { provider: "system", target: "system" } });
      }
      let preparation = 0;
      (manager as any).restore.prepareSpawn = () => { preparation += 1; throw new Error("must not prepare"); };
      await assert.rejects(manager.launchSession({ prompt: "Continue", workdir: f.dir, sessionIdOverride: "stable-a", resumeSessionId: "backend-b" }), /Conflicting canonical goal owners/);
      assert.equal(preparation, 0);
      assert.equal(first.requiredVerifierCommands, undefined);
      assert.equal(second.requiredVerifierCommands, undefined);
      assert.equal(first.status, "running");
      assert.equal(second.status, "running");
      (manager as any).sessions.clear();
    });
  }
});

describe("pending resume ownership before backend initialization (R7)", () => {
  async function deferredOwner() {
    const f = fixture();
    const current = task(["true"]);
    f.store.upsert(current);
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    const manager = new SessionManager(5, 100, { store: { indexPath: join(f.dir, "pending-sessions.json") } });
    manager.setGoalTaskAuthorizer((id) => f.authorize(id));
    const harness = createFakeHarness(`goal-pending-${f.dir}`);
    registerHarness(harness);
    const barrier = Promise.withResolvers<void>();
    const effects = { repo: 0, preparation: 0, initialization: 0, writes: 0 };
    (manager as any).checkRepoPolicyForLaunch = async () => {
      effects.repo += 1;
      return { ok: true, resolution: { source: "none", provider: "unsupported", prAvailable: false } };
    };
    (manager as any).restore.prepareSpawn = async () => {
      effects.preparation += 1;
      return { actualWorkdir: f.dir, originalWorkdir: f.dir };
    };
    const bootstrap = new SessionRuntimeBootstrapService({ hydrateSpawnedSession: () => {},
      markRunning: () => { effects.writes += 1; }, handleTerminal: async () => { effects.writes += 1; },
      handleTurnEnd: async () => {}, formatLaunchWorkdirLabel: () => f.dir, notifySession: () => {} });
    (manager as any).runtimeBootstrap.initializeSession = async (session: Session, prepared: any, config: any) => {
      effects.initialization += 1;
      return bootstrap.initializeSession(session, prepared, config, { startAfter: barrier.promise, notifyLaunch: false });
    };
    const launch = { prompt: "Continue", workdir: f.dir, harness: harness.name, resumeSessionId: "original-thread",
      worktreeStrategy: "off" as const, route: { provider: "system", target: "system" } };
    const source = await manager.launchSession({ ...launch, goalTaskId: "goal" });
    assert.equal(source.status, "starting");
    assert.equal(source.resumeSessionId, "original-thread");
    assert.equal(source.backendRef, undefined);
    assert.equal(harness.lastLaunchOptions, undefined, "real bootstrap awaits teardown before harness launch");
    const cleanup = async () => {
      for (const session of (manager as any).sessions.values() as Iterable<Session>) {
        if (session.status === "starting") session.transition("killed");
      }
      barrier.resolve();
      await tick(10);
      (manager as any).sessions.clear();
    };
    return { f, current, manager, harness, barrier, effects, launch, source, cleanup };
  }

  for (const permitted of [false, true]) {
    it(`a real deferred public launch owner is ${permitted ? "inherited with a live startup guard" : "denied with zero launch effects"}`, async () => {
      const d = await deferredOwner();
      try {
        const before = { ...d.effects };
        const beforeCount = (d.manager as any).sessions.size;
        const diskPath = join(d.f.dir, "pending-sessions.json");
        const diskBefore = existsSync(diskPath) ? readFileSync(diskPath, "utf8") : undefined;
        if (!permitted) setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
        if (permitted) {
          const resumed = await d.manager.launchSession(d.launch);
          assert.equal(resumed.goalTaskId, "goal");
          assert.equal(resumed.resumeSessionId, "original-thread");
          assert.equal(resumed.status, "starting");
          setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
          d.barrier.resolve();
          await tick(10);
          assert.equal(resumed.status, "failed", "inherited live owner rejects policy revoked during deferred startup");
          assert.equal(d.source.status, "failed");
          assert.equal(d.harness.lastLaunchOptions, undefined, "neither backend starts after revocation");
        } else {
          await assert.rejects(d.manager.launchSession(d.launch), /policy changed/);
          assert.deepEqual(d.effects, before, "no repo lookup, worktree preparation, bootstrap or session writes");
          assert.equal((d.manager as any).sessions.size, beforeCount);
          assert.equal((d.manager as any).sessions.get(d.source.id), d.source);
          assert.equal(d.harness.lastLaunchOptions, undefined);
          assert.equal(existsSync(diskPath) ? readFileSync(diskPath, "utf8") : undefined, diskBefore);
          assert.equal(d.current.status, "failed");
        }
      } finally { await d.cleanup(); }
    });
  }

  it("rejects conflicting pending and finalized owners before launch or goal mutation", async () => {
    const d = await deferredOwner();
    try {
      const second = task(["true"], { id: "second", name: "second" });
      d.f.store.upsert(second);
      const finalized = new Session({ ...d.launch, resumeSessionId: "previous-thread", goalTaskId: second.id,
        backendRef: { kind: "claude-code", conversationId: "original-thread" } }, "finalized-owner");
      (d.manager as any).sessions.set(finalized.id, finalized);
      const before = { ...d.effects };
      const count = (d.manager as any).sessions.size;
      await assert.rejects(d.manager.launchSession(d.launch), /Conflicting canonical goal owners/);
      assert.deepEqual(d.effects, before);
      assert.equal((d.manager as any).sessions.size, count);
      assert.equal(d.current.status, "running");
      assert.equal(second.status, "running");
      assert.equal(second.requiredVerifierCommands, undefined, "conflict does not bind another goal");
      assert.equal(d.harness.lastLaunchOptions, undefined);
    } finally { await d.cleanup(); }
  });

  it("uses finalized backend identity ahead of the old requested resume identity", async () => {
    const d = await deferredOwner();
    try {
      d.source.backendRef = { kind: "claude-code", conversationId: "final-thread" };
      setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
      const ordinary = await d.manager.launchSession(d.launch);
      assert.equal(ordinary.goalTaskId, undefined, "old request identity no longer claims the original goal");
      assert.equal(d.current.status, "running");
      assert.equal(d.harness.lastLaunchOptions, undefined);
    } finally { await d.cleanup(); }
  });
});

// Composed policy boundaries. Native handles are fake; controller, persistence,
// Session authorization and opaque-token callback routing are production code.
describe("relocated feature boundary coverage", () => {
  for (const decision of ["run", "cancel"] as const) {
    it(`routes an original opaque ${decision} callback under changed policy and makes replay inert`, async () => {
      const f = fixture();
      const sm = new SessionManager(2, 5, { store: { indexPath: join(f.dir, "sessions.json") } });
      setSessionManager(sm); setGoalController(f.controller);
      let buttons: any[][] = [];
      (sm as any).dispatchSessionNotification = (_session: unknown, request: any) => { buttons = request.buttons; };
      (f.manager as any).sendGoalVerifierConfirmation = sm.sendGoalVerifierConfirmation.bind(sm);
      const current = await f.controller.launchTask({ goal: "Confirm", workdir: f.dir, verifierCommands: specs(["true"]),
        requireVerifierConfirmation: true, route: { provider: "telegram", target: "12345" } });
      assert.equal(current.status, "awaiting_verifier_confirmation");
      const payload = buttons[0][decision === "run" ? 0 : 1].callbackData.replace(/^code-agent:/, "");
      assert.match(payload, /^[0-9a-f-]{36}$/);
      const replies: string[] = [];
      const context = { channel: "telegram", accountId: "default", conversationId: "12345", senderId: "12345",
        auth: { isAuthorizedSender: true }, callback: { payload, data: `code-agent:${payload}`, chatId: "12345", messageId: 1 },
        respond: { acknowledge: async () => {}, clearButtons: async () => {}, editButtons: async () => {},
          reply: async ({ text }: { text: string }) => { replies.push(text); } } };
      setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
      await createCallbackHandler().handler(context as any);
      assert.equal(current.status, decision === "run" ? "failed" : "stopped");
      assert.match(replies.join("\n"), decision === "run" ? /policy changed|stored suite/i : /cancelled/i);
      assert.equal(f.counters().launches, 0);
      const terminal = JSON.parse(JSON.stringify(current));
      await createCallbackHandler().handler(context as any);
      assert.deepEqual(JSON.parse(JSON.stringify(current)), terminal);
      assert.equal(f.counters().launches, 0);
      assert.match(replies.at(-1)!, /expired|used|no longer|stale/i);
    });
  }

  it("refuses an organically launched, saved A-bound goal in a fresh B controller before resume", async () => {
    const f = fixture();
    setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
    const launched = await f.controller.launchTask({ goal: "Organic", workdir: f.dir, loopMode: "ralph", maxIterations: 3 });
    launched.harnessSessionId = "organic-native-thread";
    f.controller.stop();
    const original = JSON.parse(readFileSync(join(f.dir, "goals.json"), "utf8"))[0];
    assert.deepEqual(original.requiredVerifierCommands, ["true"]);
    const fresh = fixture();
    (fresh.controller as any).store = new GoalTaskStore({ OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: join(f.dir, "goals.json") });
    setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
    fresh.controller.start(); await (fresh.controller as any).restorePromise;
    const rejected = fresh.controller.getTask(launched.id)!;
    assert.equal(rejected.status, "failed");
    assert.match(rejected.failureReason!, /policy changed|stored suite/i);
    assert.equal(rejected.iteration, original.iteration);
    assert.equal(rejected.harnessSessionId, original.harnessSessionId);
    assert.deepEqual(rejected.requiredVerifierCommands, original.requiredVerifierCommands);
    assert.deepEqual(rejected.verifierCommands, original.verifierCommands);
    assert.deepEqual(fresh.counters(), { launches: 0, confirmations: 0 });
    fresh.controller.stop();
  });

  for (const outcome of ["succeeded", "failed", "stopped"] as const) {
    it(`preserves a complete controller-produced ${outcome} row after awaited late events and later writes`, async () => {
      const f = fixture();
      setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
      const current = await f.controller.launchTask({ goal: "Terminal", workdir: f.dir, maxIterations: 1 });
      const session = Object.assign(new EventEmitter(), createStubSession({ id: current.sessionId, status: "completed" }));
      (f.controller as any).attachSessionObservers(current, session);
      if (outcome === "stopped") f.controller.stopTask(current.id);
      else {
        if (outcome === "failed") setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
        await (f.controller as any).handleTerminalSession(current, session);
      }
      assert.equal(current.status, outcome);
      f.store.save();
      const before = JSON.parse(readFileSync(join(f.dir, "goals.json"), "utf8")).find((row: any) => row.id === current.id);
      f.controller.start(); await (f.controller as any).restorePromise;
      session.emit("turnEnd", session); session.emit("statusChange", session, "completed");
      await tick(30);
      await (f.controller as any).reconcileTask(current, "late", current.sessionId);
      f.store.upsert(task(["true"], { id: "unrelated", name: "unrelated" })); f.store.save();
      const after = JSON.parse(readFileSync(join(f.dir, "goals.json"), "utf8")).find((row: any) => row.id === current.id);
      assert.deepEqual(after, before);
      assert.equal(f.counters().launches, 1, "late events did not spawn repair or resume");
      f.controller.stop();
    });
  }

  for (const operation of ["compact", "review", "question-text", "question-option", "steer"] as const) {
    for (const allowed of [true, false]) {
      it(`${operation} independently ${allowed ? "admits current policy" : "denies changed policy before effects"}`, async () => {
        const f = fixture(); setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
        const current = await f.controller.launchTask({ goal: operation, workdir: f.dir });
        const harness = createFakeHarness(`fresh-${operation}-${allowed}`); harness.steerResult = true;
        harness.capabilities.threadActions = ["compact", "review"];
        harness.buildThreadActionMessage = (action) => ({ role: "user", content: `Action:${action.kind}` });
        registerHarness(harness);
        const session = new Session({ prompt: "Work", workdir: f.dir, harness: harness.name, multiTurn: true,
          goalTaskId: current.id, assertGoalTaskAuthorized: () => f.authorize(current.id) }, operation);
        await session.start(); session.transition("running"); await tick(5);
        let submissions = 0;
        const handle = (session as any).harnessHandle;
        handle.submitPendingInputText = handle.submitPendingInputOption = async () => { submissions++; return true; };
        session.pendingInputState = { requestId: "question", kind: "question", promptText: "Continue?",
          options: [{ label: "Yes", value: "yes" }], allowsFreeText: true } as any;
        if (operation === "steer") (session as any).turnInProgress = true;
        const before = harness.consumedPrompts.length;
        const perform = async () => {
          if (operation === "compact" || operation === "review") session.requestThreadAction({ kind: operation } as any);
          else if (operation === "question-text") assert.equal(await session.submitPendingInputText("yes"), true);
          else if (operation === "question-option") assert.equal(await session.submitPendingInputOption(0), true);
          else await session.sendMessage("Additional work");
        };
        if (!allowed) setPluginConfig({ requiredGoalVerifierCommands: ["false"] });
        try {
          if (allowed) await perform();
          else await assert.rejects(perform(), /policy changed|stored suite/i);
          await tick(5);
          if (allowed) {
            if (operation.startsWith("question")) assert.equal(submissions, 1);
            else if (operation === "steer") assert.deepEqual(harness.steerCalls, ["Additional work"]);
            else assert.equal(harness.consumedPrompts.length, before + 1);
            assert.equal(current.status, "running");
          } else {
            assert.equal(submissions, 0); assert.deepEqual(harness.steerCalls, []);
            assert.equal(harness.consumedPrompts.length, before); assert.equal(current.status, "failed");
          }
        } finally { session.kill("user"); harness.endMessages(); await session.waitForTeardown(); }
      });
    }
  }

  for (const option of [false, true]) {
    it(`revalidates question ${option ? "option" : "text"} after its native submission await`, async () => {
      const f = fixture(); setPluginConfig({ requiredGoalVerifierCommands: ["true"] });
      const current = await f.controller.launchTask({ goal: "Pending", workdir: f.dir });
      const harness = createFakeHarness(`question-await-${option}`); registerHarness(harness);
      const session = new Session({ prompt: "Work", workdir: f.dir, harness: harness.name, multiTurn: true,
        goalTaskId: current.id, assertGoalTaskAuthorized: () => f.authorize(current.id) }, "pending");
      await session.start(); session.transition("running");
      session.pendingInputState = { requestId: "question", kind: "question", promptText: "Continue?", options: [], allowsFreeText: true };
      const original = structuredClone(session.pendingInputState);
      const entered = Promise.withResolvers<void>(), pending = Promise.withResolvers<boolean>();
      const handle = (session as any).harnessHandle;
      handle[option ? "submitPendingInputOption" : "submitPendingInputText"] = () => { entered.resolve(); return pending.promise; };
      let answered = 0; session.on("pendingInputAnswered", () => { answered++; });
      const submitting = option ? session.submitPendingInputOption(0) : session.submitPendingInputText("yes");
      await entered.promise; setPluginConfig({ requiredGoalVerifierCommands: ["false"] }); pending.resolve(true);
      await assert.rejects(submitting, /policy changed|stored suite/i);
      assert.equal(answered, 0); assert.deepEqual(session.pendingInputState, original);
      assert.equal(current.status, "failed");
      session.kill("user"); harness.endMessages(); await session.waitForTeardown();
    });
  }
});
