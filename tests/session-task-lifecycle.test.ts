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

describe("session task lifecycle adapter", () => {
  it("creates, progresses, and finalizes through the host lifecycle API", () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const lifecycle = {
      create(params: Record<string, unknown>) {
        calls.push({ method: "create", params });
        return { id: "task-1" };
      },
      progress(params: Record<string, unknown>) {
        calls.push({ method: "progress", params });
        return { id: "task-1" };
      },
      finalize(params: Record<string, unknown>) {
        calls.push({ method: "finalize", params });
        return { id: "task-1" };
      },
    };
    const ctx = {
      sessionKey: "agent:main:telegram:group:123",
      deliveryContext: { channel: "telegram", to: "123" },
    };
    let receivedCtx: unknown;
    setPluginRuntime({
      tasks: {
        runs: {
          fromToolContext(input: unknown) {
            receivedCtx = input;
            return { lifecycle };
          },
        },
      },
    });

    const sink = resolveSessionTaskLifecycle(ctx);
    const session = createSession();
    session.startedAt = 100;
    sink.create(session);
    session.transition("running");
    sink.progress(session);
    session.complete("done");
    sink.finalize(session);

    assert.equal(receivedCtx, ctx);
    assert.deepEqual(calls.map((call) => call.method), ["create", "progress", "finalize"]);
    assert.deepEqual(calls[0].params, {
      taskKind: "openclaw-code-agent.session",
      sourceId: "openclaw-code-agent",
      runId: session.id,
      title: "Implement task lifecycle integration",
      label: "task-lifecycle",
      status: "running",
      startedAt: 100,
      lastEventAt: calls[0].params.lastEventAt,
      progressSummary: "Starting",
      notifyPolicy: "silent",
    });
    assert.deepEqual(calls[1].params, {
      taskKind: "openclaw-code-agent.session",
      runId: session.id,
      lastEventAt: calls[1].params.lastEventAt,
      progressSummary: "Running",
      eventSummary: "Running",
    });
    assert.deepEqual(calls[2].params, {
      taskKind: "openclaw-code-agent.session",
      runId: session.id,
      status: "succeeded",
      startedAt: 100,
      endedAt: session.completedAt,
      lastEventAt: session.completedAt,
      progressSummary: "Completed",
      terminalSummary: "Completed",
    });
  });

  it("no-ops safely when the host lifecycle API is absent", () => {
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

  it("does not call the host API without a bound session key", () => {
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

    const sink = resolveSessionTaskLifecycle({});
    sink.create(createSession());

    assert.equal(fromToolContextCalled, false);
  });

  it("de-dupes repeated progress for the same status and lifecycle state", () => {
    const progressCalls: Record<string, unknown>[] = [];
    setPluginRuntime({
      tasks: {
        runs: {
          fromToolContext() {
            return {
              lifecycle: {
                create() { return { id: "task-1" }; },
                progress(params: Record<string, unknown>) {
                  progressCalls.push(params);
                  return { id: "task-1" };
                },
                finalize() { return { id: "task-1" }; },
              },
            };
          },
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

    assert.equal(progressCalls.length, 1);
    assert.equal(progressCalls[0].progressSummary, "Running");
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
