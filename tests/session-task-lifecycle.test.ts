import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session";
import {
  buildSessionTaskTitle,
  mapSessionTaskTerminalStatus,
  reconcilePersistedSessionTaskMirror,
  resolveSessionTaskLifecycle,
  TASK_FLOW_CANCEL_POLL_INTERVAL_MS,
} from "../src/session-task-lifecycle";
import { setPluginRuntime } from "../src/runtime-store";
import type { PersistedSessionInfo, SessionConfig } from "../src/types";

const BASE_CONFIG: SessionConfig = {
  prompt: "Implement task lifecycle integration",
  workdir: "/tmp",
  permissionMode: "plan",
};

afterEach(() => {
  setPluginRuntime(undefined);
});

function createSession(overrides: Partial<SessionConfig> = {}): Session {
  return new Session({ ...BASE_CONFIG, ...overrides }, "task-lifecycle");
}

function setManagedTaskFlow(taskFlow: unknown): void {
  setPluginRuntime({ tasks: { async: { managedFlows: { fromToolContext: () => taskFlow } } } });
}

function createTaskFlowRecorder() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let revision = 1;
  const taskFlow = {
    async createManaged(params: Record<string, unknown>) {
      calls.push({ method: "createManaged", params });
      return { flowId: "flow-1", revision };
    },
    async resume(params: Record<string, unknown>) {
      calls.push({ method: "resume", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision } };
    },
    async setWaiting(params: Record<string, unknown>) {
      calls.push({ method: "setWaiting", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision } };
    },
    async finish(params: Record<string, unknown>) {
      calls.push({ method: "finish", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision } };
    },
    async fail(params: Record<string, unknown>) {
      calls.push({ method: "fail", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision } };
    },
    async requestCancel(params: Record<string, unknown>) {
      calls.push({ method: "requestCancel", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision, cancelRequestedAt: params.cancelRequestedAt } };
    },
  };
  return { calls, taskFlow };
}

describe("session task lifecycle async adapter", () => {
  it("creates, updates, and finalizes a managed TaskFlow through the current SDK runtime", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    const ctx = {
      sessionKey: "agent:main:telegram:group:123",
      deliveryContext: { channel: "telegram", to: "123" },
    };
    let receivedCtx: unknown;
    setPluginRuntime({
      tasks: {
        async: {
          managedFlows: {
            fromToolContext(input: unknown) {
              receivedCtx = input;
              return taskFlow;
            },
          },
        },
      },
    });

    const sink = resolveSessionTaskLifecycle(ctx);
    const session = createSession();
    session.startedAt = 100;
    await sink.create(session);
    assert.deepEqual(session.taskFlowMirror, { flowId: "flow-1", revision: 1 });
    session.transition("running");
    await sink.progress(session);
    session.markAwaitingUserInput();
    await sink.progress(session);
    session.complete("done");
    await sink.finalize(session);
    assert.deepEqual(session.taskFlowMirror, { flowId: "flow-1", revision: 4 });

    assert.equal(receivedCtx, ctx);
    assert.deepEqual(calls.map((call) => call.method), [
      "createManaged",
      "resume",
      "setWaiting",
      "finish",
    ]);
    assert.deepEqual(calls[0].params, {
      controllerId: "openclaw-code-agent",
      goal: "Implement task lifecycle integration",
      status: "running",
      notifyPolicy: "silent",
      currentStep: "Starting",
      stateJson: {
        phase: "created",
        integration: "phase-1-managed-task-flow",
        sessionId: session.id,
        sessionName: "task-lifecycle",
        sessionStatus: "starting",
        sessionLifecycle: "starting",
        summary: "Starting",
      },
      createdAt: 100,
      updatedAt: calls[0].params.updatedAt,
    });
    assert.equal(calls[1].params.flowId, "flow-1");
    assert.equal(calls[1].params.expectedRevision, 1);
    assert.equal(calls[1].params.currentStep, "Running");
    assert.equal(calls[2].params.expectedRevision, 2);
    assert.equal(calls[2].params.currentStep, "Waiting for input");
    assert.deepEqual(calls[2].params.waitJson, {
      reason: "Waiting for input",
      sessionId: session.id,
    });
    assert.equal(calls[3].params.expectedRevision, 3);
    assert.equal((calls[3].params.stateJson as Record<string, unknown>).terminalStatus, "succeeded");
  });

  it("serializes delayed lifecycle writes with event snapshots and committed revisions", async (t) => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    const methods = ["createManaged", "resume", "setWaiting", "finish"] as const;
    const entered = methods.map(() => Promise.withResolvers<void>());
    const releases = methods.map(() => Promise.withResolvers<void>());
    setManagedTaskFlow({
      ...taskFlow,
      ...Object.fromEntries(methods.map((method, index) => [
        method,
        async (params: Record<string, unknown>) => {
          entered[index].resolve();
          await releases[index].promise;
          return taskFlow[method](params);
        },
      ])),
    });
    let now = 100;
    t.mock.method(Date, "now", () => now);
    const session = createSession();
    const sink = resolveSessionTaskLifecycle({ sessionKey: "agent:main:telegram:group:123" });
    const completed: string[] = [];
    const creation = Promise.resolve(sink.create(session)).then(() => { completed.push("create"); });
    now = 200;
    session.transition("running");
    const running = Promise.resolve(sink.progress(session)).then(() => { completed.push("running"); });
    now = 300;
    session.markAwaitingUserInput();
    const waiting = Promise.resolve(sink.progress(session)).then(() => { completed.push("waiting"); });
    now = 400;
    session.complete("done");
    const terminal = Promise.resolve(sink.finalize(session)).then(() => { completed.push("terminal"); });
    now = 999;

    await entered[0].promise;
    assert.equal(session.taskFlowMirror, undefined);
    assert.deepEqual(completed, []);
    const completions = [creation, running, waiting, terminal];
    for (let index = 0; index < methods.length; index += 1) {
      await entered[index].promise;
      assert.equal(calls.length, index);
      assert.equal(completed.length, index);
      releases[index].resolve();
      await completions[index];
      assert.deepEqual(session.taskFlowMirror, { flowId: "flow-1", revision: index + 1 });
    }

    assert.deepEqual(completed, ["create", "running", "waiting", "terminal"]);
    assert.deepEqual(calls.map(({ method }) => method), methods);
    assert.deepEqual(calls.slice(1).map(({ params }) => params.expectedRevision), [1, 2, 3]);
    assert.deepEqual(calls.map(({ params }) => params.updatedAt), [100, 200, 300, 400]);
    assert.deepEqual(calls.map(({ params }) => {
      const state = params.stateJson as Record<string, unknown>;
      return [state.sessionStatus, state.sessionLifecycle, state.summary];
    }), [
      ["starting", "starting", "Starting"],
      ["running", "active", "Running"],
      ["running", "awaiting_user_input", "Waiting for input"],
      ["completed", "terminal", "Completed"],
    ]);
    assert.equal(calls[3].params.endedAt, 400);
  });

  for (const method of ["createManaged", "resume", "finish"] as const) {
    it(`keeps ${method} rejection optional and retries only on a later lifecycle call`, async (t) => {
      const { calls, taskFlow } = createTaskFlowRecorder();
      let attempts = 0;
      setManagedTaskFlow({
        ...taskFlow,
        async [method](params: Record<string, unknown>) {
          attempts += 1;
          if (attempts === 1) throw new Error("mirror unavailable");
          return taskFlow[method](params);
        },
      });
      const sink = resolveSessionTaskLifecycle({ sessionKey: "agent:main:telegram:group:123" });
      const session = createSession();
      if (method !== "createManaged") await sink.create(session);
      session.transition("running");
      if (method === "finish") session.complete("done");
      const invoke = () => method === "createManaged"
        ? sink.create(session)
        : method === "resume" ? sink.progress(session) : sink.finalize(session);
      const previousMirror = session.taskFlowMirror;
      const warnings: string[] = [];
      t.mock.method(console, "warn", (message: unknown) => { warnings.push(String(message)); });

      await assert.doesNotReject(async () => { await invoke(); });
      assert.equal(attempts, 1);
      assert.deepEqual(session.taskFlowMirror, previousMirror);
      assert.deepEqual(warnings, [
        `[SessionTaskLifecycle] ${method === "createManaged" ? "create" : method === "resume" ? "progress" : "finalize"} failed: mirror unavailable`,
      ]);

      await invoke();
      assert.equal(attempts, 2);
      assert.equal(calls.at(-1)?.method, method);
      assert.deepEqual(session.taskFlowMirror, {
        flowId: "flow-1",
        revision: method === "createManaged" ? 1 : 2,
      });
      if (method !== "createManaged") assert.equal(calls.at(-1)?.params.expectedRevision, 1);
    });
  }

  it("no-ops instead of falling back to synchronous or legacy managed flows", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    const legacy = { fromToolContext: () => taskFlow };
    setPluginRuntime({ tasks: { managedFlows: legacy }, taskFlow: legacy });

    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    const session = createSession();
    await sink.create(session);
    session.transition("running");
    await sink.progress(session);
    session.complete("done");
    await sink.finalize(session);

    assert.deepEqual(calls, []);
    assert.equal(session.taskFlowMirror, undefined);
  });

  it("uses async managed flows when synchronous and legacy surfaces also exist", async () => {
    const current = createTaskFlowRecorder();
    const legacy = createTaskFlowRecorder();
    setPluginRuntime({
      tasks: {
        async: {
          managedFlows: { fromToolContext: () => current.taskFlow },
        },
        managedFlows: { fromToolContext: () => legacy.taskFlow },
      },
      taskFlow: {
        fromToolContext() {
          return legacy.taskFlow;
        },
      },
    });

    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    await sink.create(createSession());

    assert.deepEqual(current.calls.map((call) => call.method), ["createManaged"]);
    assert.deepEqual(legacy.calls, []);
  });

  it("fails the managed TaskFlow for sessions cancelled by shutdown", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setManagedTaskFlow(taskFlow);

    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    const session = createSession();
    await sink.create(session);
    session.kill("shutdown");
    await sink.finalize(session);

    assert.deepEqual(calls.map((call) => call.method), ["createManaged", "fail"]);
    assert.equal((calls[1].params.stateJson as Record<string, unknown>).terminalStatus, "cancelled");
    assert.equal(calls[1].params.blockedSummary, "Cancelled during shutdown");
  });

  it("does not mirror onto a partial runtime without requestCancel", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    const { requestCancel: _omitted, ...partial } = taskFlow;
    setManagedTaskFlow(partial);

    const sink = resolveSessionTaskLifecycle({ sessionKey: "agent:main:telegram:group:123" });
    const session = createSession();
    await sink.create(session);
    session.kill("user");
    await sink.finalize(session);

    assert.deepEqual(calls, []);
  });

  it("warns once when terminal TaskFlow mutation is not applied and does not retry", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const taskFlow = {
        async createManaged(params: Record<string, unknown>) {
          calls.push({ method: "createManaged", params });
          return { flowId: "flow-1", revision: 1 };
        },
        async resume(params: Record<string, unknown>) {
          calls.push({ method: "resume", params });
          return { applied: true, flow: { flowId: "flow-1", revision: 2 } };
        },
        async setWaiting(params: Record<string, unknown>) {
          calls.push({ method: "setWaiting", params });
          return { applied: true, flow: { flowId: "flow-1", revision: 2 } };
        },
        async finish(params: Record<string, unknown>) {
          calls.push({ method: "finish", params });
          return {
            applied: false,
            code: "revision_conflict",
            current: { flowId: "flow-1", revision: 2, status: "running" },
          };
        },
        async fail(params: Record<string, unknown>) {
          calls.push({ method: "fail", params });
          return { applied: true, flow: { flowId: "flow-1", revision: 2 } };
        },
        async requestCancel(params: Record<string, unknown>) {
          calls.push({ method: "requestCancel", params });
          return { applied: true, flow: { flowId: "flow-1", revision: 2 } };
        },
      };
      setManagedTaskFlow(taskFlow);

      const sink = resolveSessionTaskLifecycle({
        sessionKey: "agent:main:telegram:group:123",
      });
      const session = createSession();
      await sink.create(session);
      session.transition("running");
      session.complete("done");
      await sink.finalize(session);
      await sink.finalize(session);

      assert.deepEqual(calls.map((call) => call.method), ["createManaged", "finish"]);
      assert.deepEqual(warnings.filter((warning) => warning.startsWith("[SessionTaskLifecycle]")), [
        "[SessionTaskLifecycle] finalize mutation was not applied (revision_conflict)",
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("no-ops safely when the current TaskFlow runtime is absent", async () => {
    setPluginRuntime({});
    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    const session = createSession();

    await assert.doesNotReject(async () => {
      await sink.create(session);
      session.transition("running");
      await sink.progress(session);
      session.kill("user");
      await sink.finalize(session);
    });
  });

  it("does not use task-run lifecycle methods as a managed-flow fallback", async () => {
    let fromToolContextCalled = false;
    setPluginRuntime({
      tasks: {
        async: {
          managedFlows: undefined,
          runs: {
            fromToolContext() {
              fromToolContextCalled = true;
              return {
                lifecycle: {
                  create() {},
                  progress() {},
                  finalize() {},
                },
              };
            },
          },
        },
      },
    });

    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    await sink.create(createSession());

    assert.equal(fromToolContextCalled, false);
  });

  it("does not call the host API without a bound session key", async () => {
    let fromToolContextCalled = false;
    setPluginRuntime({
      tasks: {
        async: {
          managedFlows: {
            fromToolContext() {
              fromToolContextCalled = true;
              return createTaskFlowRecorder().taskFlow;
            },
          },
        },
      },
    });

    const sink = resolveSessionTaskLifecycle({});
    await sink.create(createSession());

    assert.equal(fromToolContextCalled, false);
  });

  it("de-dupes repeated progress for the same status and lifecycle state", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setManagedTaskFlow(taskFlow);

    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    const session = createSession();
    await sink.create(session);
    await sink.progress(session);
    await sink.progress(session);
    session.transition("running");
    await sink.progress(session);
    await sink.progress(session);

    assert.deepEqual(calls.map((call) => call.method), ["createManaged", "resume"]);
  });

  it("maps terminal statuses precisely", () => {
    assert.equal(mapSessionTaskTerminalStatus({ status: "completed", killReason: "done" }), "succeeded");
    assert.equal(mapSessionTaskTerminalStatus({ status: "failed", killReason: "unknown" }), "failed");
    assert.equal(mapSessionTaskTerminalStatus({ status: "killed", killReason: "user" }), "cancelled");
    assert.equal(mapSessionTaskTerminalStatus({ status: "killed", killReason: "shutdown" }), "cancelled");
    assert.equal(mapSessionTaskTerminalStatus({ status: "killed", killReason: "idle-timeout" }), "timed_out");
    assert.equal(mapSessionTaskTerminalStatus({ status: "killed", killReason: "startup-timeout" }), "timed_out");
  });

  it("builds a safe bounded task title from prompt with session name fallback", () => {
    assert.equal(
      buildSessionTaskTitle({ prompt: "  Fix\n\n auth   race  ", name: "fallback" } as Session),
      "Fix auth race",
    );
    assert.equal(
      buildSessionTaskTitle({ prompt: "   ", name: "fallback-name" } as Session),
      "fallback-name",
    );
    assert.ok(
      buildSessionTaskTitle({ prompt: "x".repeat(400), name: "fallback" } as Session).length <= 160,
    );
  });

  it("reconciles terminal persisted sessions to terminal managed TaskFlow mirrors", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setManagedTaskFlow(taskFlow);
    const session = {
      sessionId: "session-terminal",
      harnessSessionId: "h-terminal",
      backendRef: { kind: "codex-app-server", conversationId: "h-terminal" },
      name: "terminal",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      killReason: "done",
      costUsd: 0,
      route: { provider: "telegram", target: "123", sessionKey: "agent:main:telegram:group:123" },
      taskFlowMirror: { flowId: "flow-1", revision: 7, status: "running" },
    } satisfies PersistedSessionInfo;

    const reconciled = await reconcilePersistedSessionTaskMirror(session);

    assert.equal(reconciled?.revision, 2);
    assert.deepEqual(calls.map((call) => call.method), ["finish"]);
    assert.equal(calls[0].params.flowId, "flow-1");
    assert.equal(calls[0].params.expectedRevision, 7);
    assert.equal((calls[0].params.stateJson as Record<string, unknown>).terminalStatus, "succeeded");
  });

  it("fails recovered non-live persisted mirrors with no actionable wait state", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setManagedTaskFlow(taskFlow);
    const session = {
      sessionId: "session-lost",
      harnessSessionId: "h-lost",
      backendRef: { kind: "codex-app-server", conversationId: "h-lost" },
      name: "lost",
      prompt: "p",
      workdir: "/tmp",
      status: "killed",
      lifecycle: "terminal",
      killReason: "unknown",
      runtimeState: "stopped",
      runtimeRecovery: {
        recoveredAt: "2026-07-01T00:00:00.000Z",
        reason: "persisted-running-without-runtime",
        rawStatus: "running",
        normalizedStatus: "killed",
        normalizedLifecycle: "suspended",
        normalizedRuntimeState: "stopped",
      },
      costUsd: 0,
      route: { provider: "telegram", target: "123", sessionKey: "agent:main:telegram:group:123" },
      taskFlowMirror: { flowId: "flow-1", revision: 3, status: "running" },
    } satisfies PersistedSessionInfo;

    await reconcilePersistedSessionTaskMirror(session);

    assert.deepEqual(calls.map((call) => call.method), ["fail"]);
    assert.equal(calls[0].params.expectedRevision, 3);
    assert.equal(calls[0].params.blockedSummary, "Lost after OpenClaw Code Agent restart without live process");
    assert.equal((calls[0].params.stateJson as Record<string, unknown>).terminalStatus, "lost");
  });

  it("keeps legitimate waiting persisted mirrors waiting during reconciliation", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setManagedTaskFlow(taskFlow);
    const session = {
      sessionId: "session-waiting",
      harnessSessionId: "h-waiting",
      backendRef: { kind: "codex-app-server", conversationId: "h-waiting" },
      name: "waiting",
      prompt: "p",
      workdir: "/tmp",
      status: "killed",
      lifecycle: "awaiting_plan_decision",
      runtimeState: "stopped",
      pendingPlanApproval: true,
      costUsd: 0,
      route: { provider: "telegram", target: "123", sessionKey: "agent:main:telegram:group:123" },
      taskFlowMirror: { flowId: "flow-1", revision: 5, status: "running" },
    } satisfies PersistedSessionInfo;

    await reconcilePersistedSessionTaskMirror(session);

    assert.deepEqual(calls.map((call) => call.method), ["setWaiting"]);
    assert.equal(calls[0].params.expectedRevision, 5);
    assert.equal(calls[0].params.currentStep, "Waiting for plan approval");
    assert.deepEqual(calls[0].params.waitJson, {
      reason: "Waiting for plan approval",
      sessionId: "session-waiting",
    });
  });

  it("prefers tryCreateManaged and skips mirroring when the host cannot persist the flow", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    const created: unknown[] = [];
    setManagedTaskFlow({
      ...taskFlow,
      async tryCreateManaged(params: Record<string, unknown>) {
        created.push(params);
        return null;
      },
    });
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      const sink = resolveSessionTaskLifecycle({ sessionKey: "agent:main:telegram:group:123" });
      const session = createSession();
      await sink.create(session);
      session.transition("running");
      await sink.progress(session);

      assert.equal(created.length, 1);
      assert.deepEqual(calls, []);
      assert.equal(session.taskFlowMirror, undefined);
      assert.ok(warnings.some((line) => line.includes("TaskFlow persistence is unavailable")));
    } finally {
      console.warn = originalWarn;
    }
  });

  it("records a user stop as a host cancel intent instead of a failed flow", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setManagedTaskFlow({
      ...taskFlow,
      async requestCancel(params: Record<string, unknown>) {
        calls.push({ method: "requestCancel", params });
        return { applied: true, flow: { flowId: "flow-1", revision: 2, status: "running", cancelRequestedAt: params.cancelRequestedAt } };
      },
    });

    const sink = resolveSessionTaskLifecycle({ sessionKey: "agent:main:telegram:group:123" });
    const session = createSession();
    await sink.create(session);
    session.kill("user");
    await sink.finalize(session);

    assert.deepEqual(calls.map((call) => call.method), ["createManaged", "requestCancel"]);
    assert.equal(calls[1].params.expectedRevision, 1);
    assert.equal(typeof calls[1].params.cancelRequestedAt, "number");
    assert.equal((session.taskFlowMirror as { cancelRequestedAt?: number }).cancelRequestedAt, calls[1].params.cancelRequestedAt);
  });

  it("stops the session when `openclaw tasks flow cancel` cancels the mirrored flow", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { calls, taskFlow } = createTaskFlowRecorder();
    let hostFlow: Record<string, unknown> = { flowId: "flow-1", revision: 1, status: "running" };
    const reads: string[] = [];
    setManagedTaskFlow({
      ...taskFlow,
      async get(flowId: string) {
        reads.push(flowId);
        return hostFlow;
      },
    });
    let cancelRequests = 0;

    const sink = resolveSessionTaskLifecycle({ sessionKey: "agent:main:telegram:group:123" });
    const session = createSession();
    await sink.create(session, { onCancelRequested: () => { cancelRequests += 1; } });
    session.transition("running");

    t.mock.timers.tick(TASK_FLOW_CANCEL_POLL_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reads, ["flow-1"]);
    assert.equal(cancelRequests, 0);

    hostFlow = { flowId: "flow-1", revision: 2, status: "cancelled", cancelRequestedAt: 1234 };
    t.mock.timers.tick(TASK_FLOW_CANCEL_POLL_INTERVAL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelRequests, 1);
    assert.equal(session.taskFlowMirror?.status, "cancelled");

    // Later lifecycle events and the terminal transition leave the host-owned flow alone.
    await sink.progress(session);
    session.kill("user");
    await sink.finalize(session);
    t.mock.timers.tick(TASK_FLOW_CANCEL_POLL_INTERVAL_MS * 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((call) => call.method), ["createManaged"]);
    assert.equal(reads.length, 2);
    assert.equal(cancelRequests, 1);
  });

  it("honors a cancel intent returned by a rejected progress mutation", async () => {
    let cancelRequests = 0;
    const { calls, taskFlow } = createTaskFlowRecorder();
    setManagedTaskFlow({
      ...taskFlow,
      async resume(params: Record<string, unknown>) {
        calls.push({ method: "resume", params });
        return {
          applied: false,
          code: "revision_conflict",
          current: { flowId: "flow-1", revision: 3, status: "running", cancelRequestedAt: 99 },
        };
      },
    });

    const sink = resolveSessionTaskLifecycle({ sessionKey: "agent:main:telegram:group:123" });
    const session = createSession();
    await sink.create(session, { onCancelRequested: () => { cancelRequests += 1; } });
    session.transition("running");
    await sink.progress(session);

    assert.equal(cancelRequests, 1);
    assert.equal(session.taskFlowMirror?.revision, 3);
  });

  it("leaves cancel-requested persisted mirrors to the host during reconciliation", async () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setManagedTaskFlow(taskFlow);
    const session = {
      sessionId: "session-cancel-requested",
      harnessSessionId: "h-cancel",
      backendRef: { kind: "codex-app-server", conversationId: "h-cancel" },
      name: "cancel",
      prompt: "p",
      workdir: "/tmp",
      status: "killed",
      killReason: "user",
      lifecycle: "terminal",
      runtimeState: "stopped",
      costUsd: 0,
      route: { provider: "telegram", target: "123", sessionKey: "agent:main:telegram:group:123" },
      taskFlowMirror: { flowId: "flow-1", revision: 5, status: "running", cancelRequestedAt: 42 },
    } satisfies PersistedSessionInfo;

    assert.equal(await reconcilePersistedSessionTaskMirror(session), undefined);
    assert.deepEqual(calls, []);
  });
});
