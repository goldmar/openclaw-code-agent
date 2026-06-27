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

  it("redacts backend identifiers from runtime add and remove diagnostics", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const registry = new SessionRuntimeRegistry();
      registry.add(fakeSession({
        id: "secret-session",
        harnessName: "codex",
        harnessSessionId: "harness-session-secret-123",
        backendRef: {
          kind: "codex-app-server",
          conversationId: "conv-secret-456",
          worktreeId: "worktree-secret-789",
          worktreePath: "/private/backend/worktree",
        },
      }));
      registry.remove("secret-session", "test");

      const joined = warnings.join("\n");
      assert.doesNotMatch(joined, /harness-session-secret-123/);
      assert.doesNotMatch(joined, /conv-secret-456/);
      assert.doesNotMatch(joined, /worktree-secret-789/);
      assert.doesNotMatch(joined, /private\/backend\/worktree/);
      assert.doesNotMatch(joined, /"backendRef"/);
      assert.doesNotMatch(joined, /"harnessSessionId"/);

      const entries = warnings.map((warning) => JSON.parse(warning) as Record<string, unknown>);
      const added = entries.find((entry) => entry.event === "runtime.add");
      assert.equal(added?.hasHarnessSessionId, true);
      assert.equal(added?.backendRefKind, "codex-app-server");
      assert.equal(added?.hasBackendConversationId, true);
      assert.equal(added?.hasBackendWorktreeId, true);
      assert.equal(added?.hasBackendWorktreePath, true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
