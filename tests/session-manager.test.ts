import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/session-manager";
import { setPluginConfig } from "../src/config";

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

  it("prefers active session when multiple sessions share the same name", () => {
    const killed = fakeSession({ id: "s1", name: "dup", status: "killed", startedAt: 1000 });
    const running = fakeSession({ id: "s2", name: "dup", status: "running", startedAt: 2000 });
    (sm as any).sessions.set("s1", killed);
    (sm as any).sessions.set("s2", running);
    assert.equal(sm.resolve("dup"), running);
  });

  it("falls back to most recent terminal session when no active match exists", () => {
    const oldKilled = fakeSession({ id: "s1", name: "dup", status: "killed", startedAt: 1000 });
    const newFailed = fakeSession({ id: "s2", name: "dup", status: "failed", startedAt: 3000 });
    (sm as any).sessions.set("s1", oldKilled);
    (sm as any).sessions.set("s2", newFailed);
    assert.equal(sm.resolve("dup"), newFailed);
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

  it("forwards a custom shutdown reason to active sessions", () => {
    const reasons: string[] = [];
    const s1 = fakeSession({ id: "s1", status: "running", kill(reason: string) { reasons.push(`s1:${reason}`); } });
    const s2 = fakeSession({ id: "s2", status: "starting", kill(reason: string) { reasons.push(`s2:${reason}`); } });
    (sm as any).sessions.set("s1", s1);
    (sm as any).sessions.set("s2", s2);

    sm.killAll("shutdown");

    assert.deepEqual(reasons.sort(), ["s1:shutdown", "s2:shutdown"]);
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

  it("looks up latest persisted entry by name when session is not active", () => {
    (sm as any).persisted.set("harness-jkl-old", { harnessSessionId: "harness-jkl-old", name: "old-name", createdAt: 100 });
    (sm as any).persisted.set("harness-jkl-new", { harnessSessionId: "harness-jkl-new", name: "old-name", createdAt: 200 });
    assert.equal(sm.resolveHarnessSessionId("old-name"), "harness-jkl-new");
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

  it("returns latest session by name from persisted records", () => {
    const infoOld = { harnessSessionId: "h3-old", name: "s3", createdAt: 100 };
    const infoNew = { harnessSessionId: "h3-new", name: "s3", createdAt: 200 };
    (sm as any).persisted.set("h3-old", infoOld);
    (sm as any).persisted.set("h3-new", infoNew);
    assert.equal(sm.getPersistedSession("s3"), infoNew);
  });

  it("returns undefined for unknown ref", () => {
    assert.equal(sm.getPersistedSession("nonexistent"), undefined);
  });
});

describe("SessionManager.listPersistedSessions()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
    (sm as any).persisted.clear();
    (sm as any).idIndex.clear();
    (sm as any).nameIndex.clear();
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

  it("returns a defensive copy from getMetrics()", () => {
    const s = fakeSession({ costUsd: 1.0, status: "completed", startedAt: 1000, completedAt: 2000 });
    (sm as any).recordSessionMetrics(s);

    const snapshot = sm.getMetrics();
    snapshot.totalCostUsd = 999;
    snapshot.costPerDay.set("2099-01-01", 50);
    snapshot.sessionsByStatus.completed = 999;

    const fresh = sm.getMetrics();
    assert.equal(fresh.totalCostUsd, 1.0);
    assert.equal(fresh.costPerDay.has("2099-01-01"), false);
    assert.equal(fresh.sessionsByStatus.completed, 1);
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
    setPluginConfig({ sessionGcAgeMinutes: 60 });
    sm = new SessionManager(5, 2); // maxPersistedSessions = 2
    (sm as any).persisted.clear();
    (sm as any).idIndex.clear();
    (sm as any).nameIndex.clear();
  });

  it("removes terminal sessions older than configured TTL from sessions map", () => {
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

  it("keeps terminal sessions that are less than configured TTL", () => {
    const recentTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const s = fakeSession({ id: "new-s", status: "completed", completedAt: recentTime });
    (sm as any).sessions.set("new-s", s);
    sm.cleanup();
    assert.equal((sm as any).sessions.has("new-s"), true);
  });

  it("uses sessionGcAgeMinutes from plugin config", () => {
    setPluginConfig({ sessionGcAgeMinutes: 5 });
    const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const s = fakeSession({ id: "old-short-ttl", status: "completed", completedAt: oldTime });
    (sm as any).sessions.set("old-short-ttl", s);
    sm.cleanup();
    assert.equal((sm as any).sessions.has("old-short-ttl"), false);
  });

  it("keeps sessions exactly on the TTL boundary", () => {
    setPluginConfig({ sessionGcAgeMinutes: 5 });
    const originalDateNow = Date.now;
    const now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      const boundaryTime = now - 5 * 60 * 1000;
      const s = fakeSession({ id: "ttl-boundary", status: "completed", completedAt: boundaryTime });
      (sm as any).sessions.set("ttl-boundary", s);
      sm.cleanup();
      assert.equal((sm as any).sessions.has("ttl-boundary"), true);
    } finally {
      Date.now = originalDateNow;
    }
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
// notifySession
// =========================================================================

describe("SessionManager.notifySession()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
    (sm as any).wakeDispatcher = {
      dispatchSessionNotification: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    };
    (sm as any).__dispatchCalls = [];
  });

  it("delegates direct session notifications to the unified dispatcher", () => {
    const s = fakeSession({ originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239" });
    sm.notifySession(s, "hello", "launch");
    assert.deepEqual((sm as any).__dispatchCalls, [[s, {
      label: "launch",
      userMessage: "hello",
      notifyUser: "always",
    }]]);
  });
});

// =========================================================================
// turn-end wake behavior
// =========================================================================

describe("SessionManager turn-end wake", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
    (sm as any).wakeDispatcher = {
      dispatchSessionNotification: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
      clearPendingRetries: () => {},
    };
    (sm as any).__dispatchCalls = [];
  });

  it("fires wake deterministically on turn end", () => {
    const s = fakeSession({
      id: "s-turn",
      name: "deterministic",
      status: "running",
      originChannel: "telegram|bot|123",
      originThreadId: 26,
      getOutput: () => ["I completed the patch.", "Should I continue and apply tests?"],
    });

    (sm as any).onTurnEnd(s, false);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [sessionArg, request] = calls[0];
    assert.equal(sessionArg.id, "s-turn");
    assert.equal(request.label, "turn-complete");
    assert.equal(request.notifyUser, "always");
    assert.match(request.wakeMessage, /Name: deterministic/);
    assert.match(request.wakeMessage, /Status: running/);
    assert.match(request.wakeMessage, /Looks like waiting for user input: yes/);
    assert.match(request.userMessage, /⏸️ \[deterministic\] Paused after turn \| Auto-resumable/);
  });

  it("routes explicit question turns to waiting wake path", () => {
    const s = fakeSession({
      id: "s-wait",
      name: "waiter",
      status: "running",
      pendingPlanApproval: false,
      getOutput: () => ["Need your decision."],
    });

    (sm as any).onTurnEnd(s, true);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "waiting");
    assert.equal(request.notifyUser, "on-wake-fallback");
    assert.match(request.userMessage, /❓ \[waiter\] Waiting for input/);
    assert.match(request.wakeMessage, /waiting for input/i);
  });

  it("de-dupes duplicate turn-end wake for the same turn marker", () => {
    const s = fakeSession({
      id: "s-dup-turn",
      name: "dup-turn",
      status: "running",
      originChannel: "telegram|bot|123",
      result: {
        session_id: "thread-1",
        num_turns: 3,
        duration_ms: 1200,
      },
      getOutput: () => ["Turn output."],
    });

    (sm as any).onTurnEnd(s, false);
    (sm as any).onTurnEnd(s, false);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "turn-complete");
  });
});

describe("SessionManager terminal wakes", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
    (sm as any).wakeDispatcher = {
      dispatchSessionNotification: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    };
    (sm as any).__dispatchCalls = [];
  });

  it("dispatches completed notifications through the unified pipeline", () => {
    const s = fakeSession({
      id: "s-complete",
      name: "done",
      status: "completed",
      costUsd: 1.23,
      startedAt: Date.now() - 1_500,
    });

    (sm as any).triggerAgentEvent(s);

    assert.equal((sm as any).__dispatchCalls.length, 1);
    const [_sessionArg, request] = (sm as any).__dispatchCalls[0];
    assert.equal(request.label, "completed");
    assert.equal(request.notifyUser, "always");
    assert.match(request.userMessage, /✅ \[done\] Completed/);
    assert.match(request.wakeMessage, /Coding agent session completed/);
  });
});

describe("SessionManager terminal wake behavior", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
    (sm as any).wakeDispatcher = {
      dispatchSessionNotification: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
      clearPendingRetries: () => {},
    };
    (sm as any).__dispatchCalls = [];
  });

  it("de-dupes duplicate completion wake for the same terminal marker", () => {
    const s = fakeSession({
      id: "s-dup-complete",
      name: "dup-complete",
      status: "completed",
      killReason: "user",
      completedAt: 1700000000000,
      result: {
        session_id: "thread-2",
        num_turns: 4,
      },
      getOutput: () => ["done"],
    });

    (sm as any).onSessionTerminal(s);
    (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "completed");
  });

  it("wakes the originating agent when a session fails", () => {
    const s = fakeSession({
      id: "s-failed",
      name: "broken-launch",
      status: "failed",
      completedAt: 1700000001000,
      error: "The 'codex' model is not supported when using Codex with a ChatGPT account.",
      result: {
        session_id: "",
        num_turns: 0,
      },
      getOutput: () => [],
    });

    (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [sessionArg, request] = calls[0];
    assert.equal(sessionArg.id, "s-failed");
    assert.equal(request.label, "failed");
    assert.equal(request.notifyUser, "always");
    assert.match(request.wakeMessage, /Coding agent session failed/);
    assert.match(request.wakeMessage, /Failure summary:/);
    assert.match(request.wakeMessage, /not supported when using Codex with a ChatGPT account/);
    assert.match(request.wakeMessage, /relaunch the task now or continue it yourself/);
    assert.match(request.userMessage, /❌ \[broken-launch\] Failed/);
  });

  it("de-dupes duplicate failed wake for the same terminal marker", () => {
    const s = fakeSession({
      id: "s-dup-failed",
      name: "dup-failed",
      status: "failed",
      completedAt: 1700000002000,
      error: "launch failed",
      result: {
        session_id: "",
        num_turns: 0,
      },
      getOutput: () => [],
    });

    (sm as any).onSessionTerminal(s);
    (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "failed");
  });

  it("uses a dedicated idle-timeout notification", () => {
    const s = fakeSession({
      id: "s-idle-timeout",
      name: "idle-run",
      status: "killed",
      killReason: "idle-timeout",
      costUsd: 0.25,
      startedAt: Date.now() - 2_000,
    });

    (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "notification");
    assert.match(request.userMessage, /💤 \[idle-run\] Idle timeout/);
  });

  it("uses explicit stopped wording for user-terminated sessions", () => {
    const s = fakeSession({
      id: "s-user-stop",
      name: "manual-stop",
      status: "killed",
      killReason: "user",
      startedAt: Date.now() - 2_000,
    });

    (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.userMessage, /⛔ \[manual-stop\] Stopped by user/);
  });

  it("uses explicit stopped wording for startup timeouts", () => {
    const s = fakeSession({
      id: "s-startup-timeout",
      name: "startup-stop",
      status: "killed",
      killReason: "startup-timeout",
      startedAt: Date.now() - 2_000,
    });

    (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.userMessage, /⛔ \[startup-stop\] Stopped by startup timeout/);
  });

  it("uses explicit stopped wording for shutdown stops", () => {
    const s = fakeSession({
      id: "s-shutdown-stop",
      name: "shutdown-stop",
      status: "killed",
      killReason: "shutdown",
      startedAt: Date.now() - 2_000,
    });

    (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.userMessage, /⛔ \[shutdown-stop\] Stopped by shutdown/);
  });
});
