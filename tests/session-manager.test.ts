import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/session-manager";

// ---------------------------------------------------------------------------
// Helper to create a fake session-like object for injection
// ---------------------------------------------------------------------------
function fakeSession(overrides: Record<string, any> = {}): any {
  return {
    id: "s1",
    name: "session",
    status: "running",
    startedAt: Date.now(),
    completedAt: undefined,
    harnessSessionId: undefined,
    killReason: "unknown",
    workdir: "/tmp",
    model: undefined,
    costUsd: 0,
    prompt: "test",
    originChannel: undefined,
    originThreadId: undefined,
    originAgentId: undefined,
    multiTurn: true,
    pendingPlanApproval: false,
    getOutput: (n?: number) => [],
    kill: () => {},
    on: () => {},
    ...overrides,
  };
}

// =========================================================================
// uniqueName
// =========================================================================

describe("SessionManager.uniqueName", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns baseName when no sessions exist", () => {
    const name = (sm as any).uniqueName("test");
    assert.equal(name, "test");
  });

  it("returns baseName when only terminal sessions have that name", () => {
    const fs = { name: "test", status: "completed" };
    (sm as any).sessions.set("fake-id", fs);
    const name = (sm as any).uniqueName("test");
    assert.equal(name, "test");
  });

  it("appends suffix when an active session has the same name", () => {
    const fs = { name: "test", status: "running" };
    (sm as any).sessions.set("fake-id", fs);
    const name = (sm as any).uniqueName("test");
    assert.equal(name, "test-2");
  });

  it("skips over existing suffixes", () => {
    (sm as any).sessions.set("id1", { name: "test", status: "running" });
    (sm as any).sessions.set("id2", { name: "test-2", status: "running" });
    const name = (sm as any).uniqueName("test");
    assert.equal(name, "test-3");
  });

  it("does not count killed sessions as collisions", () => {
    (sm as any).sessions.set("id1", { name: "test", status: "killed" });
    const name = (sm as any).uniqueName("test");
    assert.equal(name, "test");
  });

  it("does not count failed sessions as collisions", () => {
    (sm as any).sessions.set("id1", { name: "test", status: "failed" });
    const name = (sm as any).uniqueName("test");
    assert.equal(name, "test");
  });
});

// =========================================================================
// resolve / get / list
// =========================================================================

describe("SessionManager.resolve()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns session by ID", () => {
    const s = fakeSession({ id: "abc", name: "my-session" });
    (sm as any).sessions.set("abc", s);
    assert.equal(sm.resolve("abc"), s);
  });

  it("returns session by name", () => {
    const s = fakeSession({ id: "abc", name: "my-session" });
    (sm as any).sessions.set("abc", s);
    assert.equal(sm.resolve("my-session"), s);
  });

  it("returns undefined for unknown ref", () => {
    assert.equal(sm.resolve("nonexistent"), undefined);
  });

  it("prefers ID match over name match", () => {
    const s1 = fakeSession({ id: "xyz", name: "alpha" });
    const s2 = fakeSession({ id: "alpha", name: "beta" });
    (sm as any).sessions.set("xyz", s1);
    (sm as any).sessions.set("alpha", s2);
    // "alpha" matches s2 by ID first
    assert.equal(sm.resolve("alpha"), s2);
  });
});

describe("SessionManager.get()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns session by ID", () => {
    const s = fakeSession({ id: "abc" });
    (sm as any).sessions.set("abc", s);
    assert.equal(sm.get("abc"), s);
  });

  it("returns undefined for unknown ID", () => {
    assert.equal(sm.get("nonexistent"), undefined);
  });
});

describe("SessionManager.list()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns all sessions sorted by startedAt descending", () => {
    const s1 = fakeSession({ id: "s1", startedAt: 1000 });
    const s2 = fakeSession({ id: "s2", startedAt: 3000 });
    const s3 = fakeSession({ id: "s3", startedAt: 2000 });
    (sm as any).sessions.set("s1", s1);
    (sm as any).sessions.set("s2", s2);
    (sm as any).sessions.set("s3", s3);
    const result = sm.list();
    assert.equal(result.length, 3);
    assert.equal(result[0].id, "s2");
    assert.equal(result[1].id, "s3");
    assert.equal(result[2].id, "s1");
  });

  it("filters by status", () => {
    const s1 = fakeSession({ id: "s1", status: "running", startedAt: 1000 });
    const s2 = fakeSession({ id: "s2", status: "completed", startedAt: 2000 });
    (sm as any).sessions.set("s1", s1);
    (sm as any).sessions.set("s2", s2);
    const running = sm.list("running");
    assert.equal(running.length, 1);
    assert.equal(running[0].id, "s1");
  });

  it("returns all when filter is 'all'", () => {
    const s1 = fakeSession({ id: "s1", status: "running", startedAt: 1000 });
    const s2 = fakeSession({ id: "s2", status: "completed", startedAt: 2000 });
    (sm as any).sessions.set("s1", s1);
    (sm as any).sessions.set("s2", s2);
    assert.equal(sm.list("all").length, 2);
  });
});

// =========================================================================
// kill / killAll
// =========================================================================

describe("SessionManager.kill()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("calls session.kill with reason and returns true", () => {
    let killCalled: string | undefined;
    const s = fakeSession({
      id: "s1",
      status: "running",
      kill(reason: string) { killCalled = reason; },
    });
    (sm as any).sessions.set("s1", s);
    const result = sm.kill("s1", "user");
    assert.equal(result, true);
    assert.equal(killCalled, "user");
  });

  it("returns false when session not found", () => {
    assert.equal(sm.kill("nonexistent"), false);
  });

  it("uses 'user' as default reason", () => {
    let killCalled: string | undefined;
    const s = fakeSession({
      id: "s1",
      kill(reason: string) { killCalled = reason; },
    });
    (sm as any).sessions.set("s1", s);
    sm.kill("s1");
    assert.equal(killCalled, "user");
  });
});

describe("SessionManager.killAll()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("kills all active sessions", () => {
    const killed: string[] = [];
    const s1 = fakeSession({ id: "s1", status: "running", kill() { killed.push("s1"); } });
    const s2 = fakeSession({ id: "s2", status: "starting", kill() { killed.push("s2"); } });
    (sm as any).sessions.set("s1", s1);
    (sm as any).sessions.set("s2", s2);
    sm.killAll();
    assert.ok(killed.includes("s1"));
    assert.ok(killed.includes("s2"));
  });

  it("skips already-terminal sessions", () => {
    const killed: string[] = [];
    const s1 = fakeSession({ id: "s1", status: "completed", kill() { killed.push("s1"); } });
    const s2 = fakeSession({ id: "s2", status: "running", kill() { killed.push("s2"); } });
    (sm as any).sessions.set("s1", s1);
    (sm as any).sessions.set("s2", s2);
    sm.killAll();
    assert.ok(!killed.includes("s1"), "completed session should not be killed");
    assert.ok(killed.includes("s2"), "running session should be killed");
  });
});

// =========================================================================
// resolveHarnessSessionId
// =========================================================================

describe("SessionManager.resolveHarnessSessionId()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns harnessSessionId from active session matched by ID", () => {
    const s = fakeSession({ id: "s1", harnessSessionId: "harness-abc" });
    (sm as any).sessions.set("s1", s);
    assert.equal(sm.resolveHarnessSessionId("s1"), "harness-abc");
  });

  it("returns harnessSessionId from active session matched by name", () => {
    const s = fakeSession({ id: "s1", name: "my-session", harnessSessionId: "harness-def" });
    (sm as any).sessions.set("s1", s);
    assert.equal(sm.resolveHarnessSessionId("my-session"), "harness-def");
  });

  it("looks up by idIndex when session is not active", () => {
    (sm as any).idIndex.set("old-id", "harness-ghi");
    (sm as any).persisted.set("harness-ghi", { harnessSessionId: "harness-ghi" });
    assert.equal(sm.resolveHarnessSessionId("old-id"), "harness-ghi");
  });

  it("looks up by nameIndex when session is not active", () => {
    (sm as any).nameIndex.set("old-name", "harness-jkl");
    (sm as any).persisted.set("harness-jkl", { harnessSessionId: "harness-jkl" });
    assert.equal(sm.resolveHarnessSessionId("old-name"), "harness-jkl");
  });

  it("returns ref directly if it exists in persisted map", () => {
    (sm as any).persisted.set("direct-key", { harnessSessionId: "direct-key" });
    assert.equal(sm.resolveHarnessSessionId("direct-key"), "direct-key");
  });

  it("returns UUID ref as-is even when not in any index", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    assert.equal(sm.resolveHarnessSessionId(uuid), uuid);
  });

  it("returns undefined for non-UUID unresolvable ref", () => {
    assert.equal(sm.resolveHarnessSessionId("random-text"), undefined);
  });
});

// =========================================================================
// getPersistedSession / listPersistedSessions
// =========================================================================

describe("SessionManager.getPersistedSession()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns session by direct harnessSessionId", () => {
    const info = { harnessSessionId: "h1", name: "s1" };
    (sm as any).persisted.set("h1", info);
    assert.equal(sm.getPersistedSession("h1"), info);
  });

  it("returns session by internal session ID via idIndex", () => {
    const info = { harnessSessionId: "h2", name: "s2" };
    (sm as any).persisted.set("h2", info);
    (sm as any).idIndex.set("internal-id", "h2");
    assert.equal(sm.getPersistedSession("internal-id"), info);
  });

  it("returns session by name via nameIndex", () => {
    const info = { harnessSessionId: "h3", name: "s3" };
    (sm as any).persisted.set("h3", info);
    (sm as any).nameIndex.set("s3", "h3");
    assert.equal(sm.getPersistedSession("s3"), info);
  });

  it("returns undefined for unknown ref", () => {
    assert.equal(sm.getPersistedSession("nonexistent"), undefined);
  });
});

describe("SessionManager.listPersistedSessions()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns sorted by completedAt descending", () => {
    (sm as any).persisted.set("h1", { harnessSessionId: "h1", completedAt: 1000 });
    (sm as any).persisted.set("h2", { harnessSessionId: "h2", completedAt: 3000 });
    (sm as any).persisted.set("h3", { harnessSessionId: "h3", completedAt: 2000 });
    const list = sm.listPersistedSessions();
    assert.equal(list[0].harnessSessionId, "h2");
    assert.equal(list[1].harnessSessionId, "h3");
    assert.equal(list[2].harnessSessionId, "h1");
  });
});

// =========================================================================
// recordSessionMetrics
// =========================================================================

describe("SessionManager.recordSessionMetrics()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("accumulates totalCostUsd", () => {
    const s1 = fakeSession({ costUsd: 0.5, status: "completed", completedAt: Date.now(), startedAt: Date.now() - 10000 });
    const s2 = fakeSession({ costUsd: 1.2, status: "completed", completedAt: Date.now(), startedAt: Date.now() - 20000 });
    (sm as any).recordSessionMetrics(s1);
    (sm as any).recordSessionMetrics(s2);
    assert.equal(sm.getMetrics().totalCostUsd, 1.7);
  });

  it("tracks costPerDay correctly", () => {
    const now = Date.now();
    const s = fakeSession({ costUsd: 0.3, status: "completed", completedAt: now, startedAt: now - 5000 });
    (sm as any).recordSessionMetrics(s);
    const dateKey = new Date(now).toISOString().slice(0, 10);
    assert.equal(sm.getMetrics().costPerDay.get(dateKey), 0.3);
  });

  it("increments sessionsByStatus counters", () => {
    (sm as any).recordSessionMetrics(fakeSession({ status: "completed", costUsd: 0, startedAt: 1000, completedAt: 2000 }));
    (sm as any).recordSessionMetrics(fakeSession({ status: "failed", costUsd: 0, startedAt: 1000, completedAt: 2000 }));
    (sm as any).recordSessionMetrics(fakeSession({ status: "killed", costUsd: 0, startedAt: 1000, completedAt: 2000 }));
    const metrics = sm.getMetrics();
    assert.equal(metrics.sessionsByStatus.completed, 1);
    assert.equal(metrics.sessionsByStatus.failed, 1);
    assert.equal(metrics.sessionsByStatus.killed, 1);
  });

  it("tracks duration when completedAt is set", () => {
    const s = fakeSession({ costUsd: 0, status: "completed", startedAt: 1000, completedAt: 11000 });
    (sm as any).recordSessionMetrics(s);
    assert.equal(sm.getMetrics().totalDurationMs, 10000);
    assert.equal(sm.getMetrics().sessionsWithDuration, 1);
  });

  it("tracks mostExpensive session", () => {
    const s1 = fakeSession({ id: "cheap", name: "cheap", costUsd: 0.1, status: "completed", prompt: "a", startedAt: 1000, completedAt: 2000 });
    const s2 = fakeSession({ id: "expensive", name: "expensive", costUsd: 5.0, status: "completed", prompt: "b", startedAt: 1000, completedAt: 2000 });
    (sm as any).recordSessionMetrics(s1);
    (sm as any).recordSessionMetrics(s2);
    const most = sm.getMetrics().mostExpensive;
    assert.ok(most);
    assert.equal(most!.name, "expensive");
    assert.equal(most!.costUsd, 5.0);
  });
});

// =========================================================================
// buildDeliverArgs
// =========================================================================

describe("SessionManager.buildDeliverArgs()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns empty array for 'unknown' channel", () => {
    const args = (sm as any).buildDeliverArgs("unknown");
    assert.deepEqual(args, []);
  });

  it("returns empty array for 'gateway' channel", () => {
    const args = (sm as any).buildDeliverArgs("gateway");
    assert.deepEqual(args, []);
  });

  it("returns empty array for undefined channel", () => {
    const args = (sm as any).buildDeliverArgs(undefined);
    assert.deepEqual(args, []);
  });

  it("returns empty array for channel without pipe", () => {
    const args = (sm as any).buildDeliverArgs("nopipe");
    assert.deepEqual(args, []);
  });

  it("builds 2-part channel args correctly", () => {
    const args = (sm as any).buildDeliverArgs("telegram|123456");
    assert.deepEqual(args, ["--deliver", "--reply-channel", "telegram", "--reply-to", "123456"]);
  });

  it("builds 3-part channel args with account", () => {
    const args = (sm as any).buildDeliverArgs("telegram|bot123|chatid");
    assert.deepEqual(args, ["--deliver", "--reply-channel", "telegram", "--reply-account", "bot123", "--reply-to", "chatid"]);
  });

  it("appends :topic: suffix for telegram with threadId", () => {
    const args = (sm as any).buildDeliverArgs("telegram|bot123|chatid", 42);
    assert.deepEqual(args, ["--deliver", "--reply-channel", "telegram", "--reply-account", "bot123", "--reply-to", "chatid:topic:42"]);
  });

  it("does not append :topic: for non-telegram channels", () => {
    const args = (sm as any).buildDeliverArgs("discord|bot123|chatid", 42);
    assert.deepEqual(args, ["--deliver", "--reply-channel", "discord", "--reply-account", "bot123", "--reply-to", "chatid"]);
  });
});

// =========================================================================
// debounceWaitingEvent
// =========================================================================

describe("SessionManager.debounceWaitingEvent()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("allows first event", () => {
    assert.equal((sm as any).debounceWaitingEvent("s1"), true);
  });

  it("blocks event within debounce window", () => {
    (sm as any).debounceWaitingEvent("s1");
    assert.equal((sm as any).debounceWaitingEvent("s1"), false);
  });

  it("allows event after debounce window", () => {
    // Manually set timestamp in the past
    (sm as any).lastWaitingEventTimestamps.set("s1", Date.now() - 10_000);
    assert.equal((sm as any).debounceWaitingEvent("s1"), true);
  });
});

// =========================================================================
// cleanup
// =========================================================================

describe("SessionManager.cleanup()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5, 2); // maxPersistedSessions = 2
  });

  it("removes terminal sessions older than 1 hour from sessions map", () => {
    const oldTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    const s = fakeSession({
      id: "old-s",
      status: "completed",
      completedAt: oldTime,
      harnessSessionId: undefined,
      getOutput: () => [],
    });
    (sm as any).sessions.set("old-s", s);
    sm.cleanup();
    assert.equal((sm as any).sessions.has("old-s"), false);
  });

  it("keeps terminal sessions that are less than 1 hour old", () => {
    const recentTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const s = fakeSession({ id: "new-s", status: "completed", completedAt: recentTime });
    (sm as any).sessions.set("new-s", s);
    sm.cleanup();
    assert.equal((sm as any).sessions.has("new-s"), true);
  });

  it("evicts oldest persisted sessions when exceeding maxPersistedSessions", () => {
    // maxPersistedSessions = 2, add 3
    (sm as any).persisted.set("h1", { harnessSessionId: "h1", completedAt: 1000 });
    (sm as any).persisted.set("h2", { harnessSessionId: "h2", completedAt: 3000 });
    (sm as any).persisted.set("h3", { harnessSessionId: "h3", completedAt: 2000 });
    // Set up indexes for evicted session
    (sm as any).idIndex.set("id-h1", "h1");
    (sm as any).nameIndex.set("name-h1", "h1");

    sm.cleanup();

    // Should keep the 2 most recent (h2: 3000, h3: 2000), evict h1 (1000)
    assert.equal((sm as any).persisted.has("h1"), false, "oldest should be evicted");
    assert.equal((sm as any).persisted.has("h2"), true);
    assert.equal((sm as any).persisted.has("h3"), true);
    // Indexes for evicted session should be cleaned
    assert.equal((sm as any).idIndex.has("id-h1"), false);
    assert.equal((sm as any).nameIndex.has("name-h1"), false);
  });
});

// =========================================================================
// deliverToTelegram
// =========================================================================

describe("SessionManager.deliverToTelegram()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("does nothing when notifications is null", () => {
    const s = fakeSession({ originChannel: "telegram|123" });
    // Should not throw
    sm.deliverToTelegram(s, "test text");
  });

  it("calls emitToChannel with correct arguments when notifications set", () => {
    const calls: any[] = [];
    sm.notifications = {
      emitToChannel(channelId: string, text: string, threadId?: string | number) {
        calls.push({ channelId, text, threadId });
      },
      attachToSession() {},
      stop() {},
    } as any;
    const s = fakeSession({ originChannel: "telegram|bot|123", originThreadId: 42 });
    sm.deliverToTelegram(s, "hello", "test");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channelId, "telegram|bot|123");
    assert.equal(calls[0].text, "hello");
    assert.equal(calls[0].threadId, 42);
  });
});
