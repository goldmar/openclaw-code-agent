import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Opt-in source compatibility gate. Run with the candidate's tsx preload and
// tsconfig so its workspace packages resolve to that exact source checkout.
const candidate = process.env.OPENCLAW_TASKFLOW_CANDIDATE;
it("persists ordered OCA lifecycle writes and recovery through the candidate SQLite runtime", {
  skip: !candidate,
  timeout: 180_000,
}, async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "oca-taskflow-candidate-"));
  // OPENCLAW_STATE_DIR is the state directory (OPENCLAW_HOME is the home-directory override).
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousSessionsPath = process.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH = join(stateDir, "sessions.json");
  const source = (path: string) => import(pathToFileURL(join(candidate!, path)).href);
  const { createRuntimeAsyncTasks } = await source("src/plugins/runtime/runtime-tasks-async.ts");
  const { drainGlobalSingletonLifecycleState } = await source("src/shared/global-singleton.ts");
  const { Session } = await import("../src/session");
  const { setPluginRuntime } = await import("../src/runtime-store");
  const { resolveSessionTaskLifecycle, reconcilePersistedSessionTaskMirror } = await import("../src/session-task-lifecycle");
  const sessionKey = "agent:main:oca-candidate-test";
  const managed = createRuntimeAsyncTasks().managedFlows;
  const bound = managed.fromToolContext({ sessionKey });
  const calls: Array<{ method: string; revision?: number; status: string }> = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const methods = ["tryCreateManaged", "resume", "setWaiting", "finish", "fail", "requestCancel"] as const;
  const delayed = Object.fromEntries(methods.map((method) => [method, async (params: any) => {
    if (method === "tryCreateManaged") {
      entered.resolve();
      await release.promise;
    }
    const result = await bound[method](params);
    assert.ok(method === "tryCreateManaged" ? result?.flowId : result.applied, `${method} must commit`);
    calls.push({ method, revision: params.expectedRevision, status: (result.flow ?? result).status });
    return result;
  }]));
  // The live mirror also polls `get` to honor host cancels.
  const binding = { ...delayed, get: (flowId: string) => bound.get(flowId) };
  setPluginRuntime({ tasks: { async: { managedFlows: { fromToolContext: () => binding } } } });
  try {
    const session = new Session({ prompt: "Candidate lifecycle", workdir: stateDir, permissionMode: "plan" }, "candidate");
    const sink = resolveSessionTaskLifecycle({ sessionKey });
    const creation = sink.create(session);
    session.transition("running");
    const running = sink.progress(session);
    session.markAwaitingUserInput();
    const waiting = sink.progress(session);
    session.complete("done");
    const terminal = sink.finalize(session);
    await entered.promise;
    assert.deepEqual(calls, []);
    assert.equal(session.taskFlowMirror, undefined);
    release.resolve();
    await Promise.all([creation, running, waiting, terminal]);
    assert.deepEqual(calls, [
      { method: "tryCreateManaged", revision: undefined, status: "running" },
      { method: "resume", revision: 0, status: "running" },
      { method: "setWaiting", revision: 1, status: "blocked" },
      { method: "finish", revision: 2, status: "succeeded" },
    ]);
    const persisted = await bound.get(session.taskFlowMirror!.flowId);
    assert.equal(persisted.revision, 3);
    assert.equal(persisted.stateJson.sessionStatus, "completed");

    // A restarted OCA manager reconciles a persisted non-terminal mirror using
    // its saved revision, then a newly bound reader sees the committed terminal row.
    const orphan = await bound.createManaged({ controllerId: "openclaw-code-agent", goal: "Interrupted session", status: "running", notifyPolicy: "silent" });
    setPluginRuntime({ tasks: { async: { managedFlows: managed } } });
    const recovered = await reconcilePersistedSessionTaskMirror({
      sessionId: "orphan", name: "orphan", prompt: "Interrupted session", workdir: stateDir,
      status: "failed", lifecycle: "terminal", costUsd: 0, originSessionKey: sessionKey,
      taskFlowMirror: orphan,
    });
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.revision, orphan.revision + 1);
    const restarted = createRuntimeAsyncTasks().managedFlows.fromToolContext({ sessionKey });
    assert.equal((await restarted.get(orphan.flowId)).status, "failed");
    assert.equal((await restarted.get(persisted.flowId)).status, "succeeded");

    const { SessionManager } = await import("../src/session-manager");
    t.mock.method(Session.prototype, "start", async function (this: InstanceType<typeof Session>) {
      this.harnessSessionId = "candidate-harness";
      this.transition("running");
    });
    const terminalEntered = Promise.withResolvers<void>();
    const terminalRelease = Promise.withResolvers<void>();
    setPluginRuntime({ tasks: { async: { managedFlows: { fromToolContext: () => ({
      ...bound,
      fail: async (params: any) => {
        terminalEntered.resolve();
        await terminalRelease.promise;
        return bound.fail(params);
      },
    }) } } } });
    const manager = new SessionManager(5);
    await manager.ready;
    t.mock.method((manager as any).notifications, "dispatch", async () => {});
    const active = await manager.launchSession({
      prompt: "Shutdown persistence", workdir: stateDir, permissionMode: "plan",
      worktreeStrategy: "off", route: { provider: "system", target: "system", sessionKey },
      taskLifecycle: resolveSessionTaskLifecycle({ sessionKey }),
    }, { notifyLaunch: false });
    let stopped = false;
    const stop = manager.shutdown().then(() => { stopped = true; });
    try {
      await terminalEntered.promise;
      assert.equal(stopped, false);
      await assert.rejects(async () => manager.launchSession({ prompt: "Late launch", workdir: stateDir, permissionMode: "plan" }), /shutting down/);
      terminalRelease.resolve();
      await stop;
      const saved = manager.getPersistedSession(active.id)!;
      assert.equal(saved.taskFlowMirror?.status, "failed");
      assert.equal((await bound.get(saved.taskFlowMirror!.flowId)).revision, saved.taskFlowMirror!.revision);
      const nextManager = new SessionManager(5);
      try {
        await nextManager.ready;
        assert.deepEqual(nextManager.getPersistedSession(active.id)?.taskFlowMirror, {
          flowId: saved.taskFlowMirror!.flowId, revision: saved.taskFlowMirror!.revision, status: "failed",
        });
      } finally {
        await nextManager.shutdown();
      }
    } finally {
      terminalRelease.resolve();
      await stop;
    }

  } finally {
    release.resolve();
    setPluginRuntime(undefined);
    await drainGlobalSingletonLifecycleState("close");
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    if (previousSessionsPath === undefined) delete process.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH;
    else process.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH = previousSessionsPath;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
