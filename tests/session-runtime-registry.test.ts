import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionRuntimeRegistry } from "../src/session-runtime-registry";

function fakeSession(overrides: Record<string, unknown> = {}): any {
  return {
    id: "s1",
    name: "session",
    status: "running",
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("SessionRuntimeRegistry", () => {
  it("counts only starting/running sessions as active", () => {
    const registry = new SessionRuntimeRegistry();
    registry.add(fakeSession({ id: "a", status: "starting" }));
    registry.add(fakeSession({ id: "b", status: "running" }));
    registry.add(fakeSession({ id: "c", status: "completed" }));

    assert.equal(registry.activeSessionCount(), 2);
  });

  it("generates unique names from active sessions only", () => {
    const registry = new SessionRuntimeRegistry();
    registry.add(fakeSession({ id: "a", name: "dup", status: "running" }));
    registry.add(fakeSession({ id: "b", name: "dup-2", status: "starting" }));
    registry.add(fakeSession({ id: "c", name: "dup-3", status: "completed" }));

    assert.equal(registry.uniqueName("dup"), "dup-3");
  });
});
