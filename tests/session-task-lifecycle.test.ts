import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session";
import {
  buildSessionTaskTitle,
  mapSessionTaskTerminalStatus,
  resolveSessionTaskLifecycle,
} from "../src/session-task-lifecycle";
import { setPluginRuntime } from "../src/runtime-store";
import type { SessionConfig } from "../src/types";

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

function createTaskFlowRecorder() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let revision = 1;
  const taskFlow = {
    createManaged(params: Record<string, unknown>) {
      calls.push({ method: "createManaged", params });
      return { flowId: "flow-1", revision };
    },
    resume(params: Record<string, unknown>) {
      calls.push({ method: "resume", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision } };
    },
    setWaiting(params: Record<string, unknown>) {
      calls.push({ method: "setWaiting", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision } };
    },
    finish(params: Record<string, unknown>) {
      calls.push({ method: "finish", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision } };
    },
    fail(params: Record<string, unknown>) {
      calls.push({ method: "fail", params });
      revision += 1;
      return { applied: true, flow: { flowId: "flow-1", revision } };
    },
  };
  return { calls, taskFlow };
}

describe("session task lifecycle phase-1 adapter", () => {
  it("creates, updates, and finalizes a managed TaskFlow through the current SDK runtime", () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    const ctx = {
      sessionKey: "agent:main:telegram:group:123",
      deliveryContext: { channel: "telegram", to: "123" },
    };
    let receivedCtx: unknown;
    setPluginRuntime({
      taskFlow: {
        fromToolContext(input: unknown) {
          receivedCtx = input;
          return taskFlow;
        },
      },
    });

    const sink = resolveSessionTaskLifecycle(ctx);
    const session = createSession();
    session.startedAt = 100;
    sink.create(session);
    session.transition("running");
    sink.progress(session);
    session.markAwaitingUserInput();
    sink.progress(session);
    session.complete("done");
    sink.finalize(session);

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

  it("fails the managed TaskFlow for failed or cancelled terminal sessions", () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setPluginRuntime({
      taskFlow: {
        fromToolContext() {
          return taskFlow;
        },
      },
    });

    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    const session = createSession();
    sink.create(session);
    session.kill("user");
    sink.finalize(session);

    assert.deepEqual(calls.map((call) => call.method), ["createManaged", "fail"]);
    assert.equal((calls[1].params.stateJson as Record<string, unknown>).terminalStatus, "cancelled");
    assert.equal(calls[1].params.blockedSummary, "Cancelled by user");
  });

  it("warns once when terminal TaskFlow mutation is not applied and does not retry", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const taskFlow = {
        createManaged(params: Record<string, unknown>) {
          calls.push({ method: "createManaged", params });
          return { flowId: "flow-1", revision: 1 };
        },
        resume(params: Record<string, unknown>) {
          calls.push({ method: "resume", params });
          return { applied: true, flow: { flowId: "flow-1", revision: 2 } };
        },
        setWaiting(params: Record<string, unknown>) {
          calls.push({ method: "setWaiting", params });
          return { applied: true, flow: { flowId: "flow-1", revision: 2 } };
        },
        finish(params: Record<string, unknown>) {
          calls.push({ method: "finish", params });
          return {
            applied: false,
            code: "revision_conflict",
            current: { flowId: "flow-1", revision: 2, status: "running" },
          };
        },
        fail(params: Record<string, unknown>) {
          calls.push({ method: "fail", params });
          return { applied: true, flow: { flowId: "flow-1", revision: 2 } };
        },
      };
      setPluginRuntime({
        taskFlow: {
          fromToolContext() {
            return taskFlow;
          },
        },
      });

      const sink = resolveSessionTaskLifecycle({
        sessionKey: "agent:main:telegram:group:123",
      });
      const session = createSession();
      sink.create(session);
      session.transition("running");
      session.complete("done");
      sink.finalize(session);
      sink.finalize(session);

      assert.deepEqual(calls.map((call) => call.method), ["createManaged", "finish"]);
      assert.deepEqual(warnings, [
        "[SessionTaskLifecycle] finalize mutation was not applied (revision_conflict)",
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("no-ops safely when the current TaskFlow runtime is absent", () => {
    setPluginRuntime({});
    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    const session = createSession();

    assert.doesNotThrow(() => {
      sink.create(session);
      session.transition("running");
      sink.progress(session);
      session.kill("user");
      sink.finalize(session);
    });
  });

  it("ignores unreleased task run lifecycle shapes instead of depending on them", () => {
    let fromToolContextCalled = false;
    setPluginRuntime({
      tasks: {
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
    });

    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    sink.create(createSession());

    assert.equal(fromToolContextCalled, false);
  });

  it("does not call the host API without a bound session key", () => {
    let fromToolContextCalled = false;
    setPluginRuntime({
      taskFlow: {
        fromToolContext() {
          fromToolContextCalled = true;
          return createTaskFlowRecorder().taskFlow;
        },
      },
    });

    const sink = resolveSessionTaskLifecycle({});
    sink.create(createSession());

    assert.equal(fromToolContextCalled, false);
  });

  it("de-dupes repeated progress for the same status and lifecycle state", () => {
    const { calls, taskFlow } = createTaskFlowRecorder();
    setPluginRuntime({
      taskFlow: {
        fromToolContext() {
          return taskFlow;
        },
      },
    });

    const sink = resolveSessionTaskLifecycle({
      sessionKey: "agent:main:telegram:group:123",
    });
    const session = createSession();
    sink.create(session);
    sink.progress(session);
    sink.progress(session);
    session.transition("running");
    sink.progress(session);
    sink.progress(session);

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
});
