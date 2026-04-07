import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionReferenceService } from "../src/session-reference-service";
import type { Session } from "../src/session";

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "session-id",
    name: "session-name",
    prompt: "test prompt",
    harness: "codex",
    status: "completed",
    startedAt: 0,
    originChannel: "telegram|123",
    ...overrides,
  } as Session;
}

describe("SessionReferenceService", () => {
  it("prefers the newest active session when multiple names match", () => {
    const sessions = new Map<string, Session>([
      ["older-completed", makeSession({ id: "older-completed", name: "shared", status: "completed", startedAt: 10 })],
      ["newer-running", makeSession({ id: "newer-running", name: "shared", status: "running", startedAt: 20 })],
      ["older-running", makeSession({ id: "older-running", name: "shared", status: "running", startedAt: 15 })],
    ]);
    const store = {
      getPersistedSession: () => undefined,
      resolveBackendConversationId: () => undefined,
    };

    const service = new SessionReferenceService(sessions, store);

    assert.equal(service.resolveActive("shared")?.id, "newer-running");
  });

  it("falls back to the newest matching session when no active sessions match", () => {
    const sessions = new Map<string, Session>([
      ["older", makeSession({ id: "older", harnessSessionId: "legacy-1", startedAt: 10 })],
      ["newer", makeSession({ id: "newer", harnessSessionId: "legacy-1", startedAt: 20 })],
    ]);
    const store = {
      getPersistedSession: () => undefined,
      resolveBackendConversationId: () => undefined,
    };

    const service = new SessionReferenceService(sessions, store);

    assert.equal(service.resolveActive("legacy-1")?.id, "newer");
  });

  it("prefers the newest active session when backend and legacy refs share a value", () => {
    const sessions = new Map<string, Session>([
      ["backend", makeSession({
        id: "backend",
        status: "running",
        startedAt: 10,
        backendRef: { kind: "codex-app-server", conversationId: "conv-1" },
      })],
      ["legacy", makeSession({ id: "legacy", startedAt: 20, harnessSessionId: "conv-1" })],
    ]);
    const store = {
      getPersistedSession: () => undefined,
      resolveBackendConversationId: () => undefined,
    };

    const service = new SessionReferenceService(sessions, store);

    assert.equal(service.resolveActive("conv-1")?.id, "backend");
  });
});
