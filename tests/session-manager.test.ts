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
    originSessionKey: undefined,
    route: {
      provider: "telegram",
      accountId: "bot",
      target: "12345",
      threadId: "42",
      sessionKey: "agent:main:telegram:group:12345:topic:42",
    },
    multiTurn: true,
    pendingPlanApproval: false,
    planDecisionVersion: 0,
    actionablePlanDecisionVersion: undefined,
    approvalPromptRequiredVersion: undefined,
    approvalPromptStatus: "not_sent",
    approvalPromptVersion: undefined,
    approvalPromptTransport: "none",
    approvalPromptMessageKind: "none",
    approvalPromptLastAttemptAt: undefined,
    approvalPromptDeliveredAt: undefined,
    approvalPromptFailedAt: undefined,
    latestPlanArtifact: undefined,
    latestPlanArtifactVersion: undefined,
    getOutput: (n?: number) => [],
    kill: () => {},
    on: () => {},
    ...overrides,
  };
}

function stubDispatch(sm: SessionManager): void {
  (sm as any).__dispatchCalls = [];
  (sm as any).notifications = {
    dispatch: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    notifyWorktreeOutcome: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    dispose: () => {},
  };
  (sm as any).wakeDispatcher = {
    clearRetryTimersForSession: () => {},
    dispose: () => {},
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
    const s = fakeSession({
      id: "s1",
      harnessSessionId: "harness-abc",
      backendRef: { kind: "claude-code", conversationId: "backend-abc" },
    });
    (sm as any).sessions.set("s1", s);
    assert.equal(sm.resolveHarnessSessionId("s1"), "backend-abc");
  });

  it("returns harnessSessionId from active session matched by name", () => {
    const s = fakeSession({
      id: "s1",
      name: "my-session",
      harnessSessionId: "harness-def",
      backendRef: { kind: "claude-code", conversationId: "backend-def" },
    });
    (sm as any).sessions.set("s1", s);
    assert.equal(sm.resolveHarnessSessionId("my-session"), "backend-def");
  });

  it("looks up by idIndex when session is not active", () => {
    (sm as any).idIndex.set("old-id", "harness-ghi");
    (sm as any).persisted.set("harness-ghi", {
      harnessSessionId: "harness-ghi",
      backendRef: { kind: "claude-code", conversationId: "backend-ghi" },
    });
    assert.equal(sm.resolveHarnessSessionId("old-id"), "backend-ghi");
  });

  it("looks up latest persisted entry by name when session is not active", () => {
    (sm as any).persisted.set("harness-jkl-old", {
      harnessSessionId: "harness-jkl-old",
      backendRef: { kind: "claude-code", conversationId: "backend-jkl-old" },
      name: "old-name",
      createdAt: 100,
    });
    (sm as any).persisted.set("harness-jkl-new", {
      harnessSessionId: "harness-jkl-new",
      backendRef: { kind: "claude-code", conversationId: "backend-jkl-new" },
      name: "old-name",
      createdAt: 200,
    });
    assert.equal(sm.resolveHarnessSessionId("old-name"), "backend-jkl-new");
  });

  it("returns ref directly if it exists in persisted map", () => {
    (sm as any).persisted.set("direct-key", {
      harnessSessionId: "direct-key",
      backendRef: { kind: "claude-code", conversationId: "backend-direct" },
    });
    assert.equal(sm.resolveHarnessSessionId("direct-key"), "backend-direct");
  });

  it("resolves active sessions by backend conversation id before legacy harness id", () => {
    const s = fakeSession({
      id: "s2",
      harnessSessionId: "legacy-id",
      backendRef: { kind: "claude-code", conversationId: "backend-live" },
    });
    (sm as any).sessions.set("s2", s);
    assert.equal(sm.resolve("backend-live"), s);
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

  it("returns session by backend conversation id before legacy harness id", () => {
    const info = {
      harnessSessionId: "legacy-h3",
      backendRef: { kind: "claude-code", conversationId: "backend-h3" },
      name: "s3",
    };
    (sm as any).persisted.set("legacy-h3", info);
    (sm as any).store.backendIdIndex.set("backend-h3", "legacy-h3");
    assert.equal(sm.getPersistedSession("backend-h3"), info);
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

describe("SessionManager.updatePersistedSession()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("syncs explicit lifecycle/worktree patches onto the live session", () => {
    const session = fakeSession({
      id: "live-1",
      harnessSessionId: "h-live-1",
      lifecycle: "terminal",
      worktreeState: "provisioned",
      worktreePrUrl: undefined,
      worktreePrNumber: undefined,
      worktreeMerged: false,
    });
    (sm as any).sessions.set(session.id, session);
    (sm as any).store.persisted.set("h-live-1", {
      harnessSessionId: "h-live-1",
      backendRef: { kind: "claude-code", conversationId: "h-live-1" },
      sessionId: "live-1",
      name: "session",
      prompt: "test",
      workdir: "/tmp",
      route: {
        provider: "telegram",
        target: "12345",
        sessionKey: "agent:main:telegram:group:12345",
      },
      status: "completed",
      lifecycle: "terminal",
      worktreeState: "provisioned",
      costUsd: 0,
    });

    const changed = sm.updatePersistedSession("live-1", {
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
      pendingWorktreeDecisionSince: "2026-03-25T00:00:00.000Z",
    });

    assert.equal(changed, true);
    assert.equal(session.lifecycle, "awaiting_worktree_decision");
    assert.equal(session.worktreeState, "pending_decision");
  });

  it("syncs resolved PR state onto the live session", () => {
    const session = fakeSession({
      id: "live-2",
      harnessSessionId: "h-live-2",
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
      worktreePrUrl: undefined,
      worktreePrNumber: undefined,
      worktreeMerged: false,
      worktreeMergedAt: undefined,
    });
    (sm as any).sessions.set(session.id, session);
    (sm as any).store.persisted.set("h-live-2", {
      harnessSessionId: "h-live-2",
      backendRef: { kind: "claude-code", conversationId: "h-live-2" },
      sessionId: "live-2",
      name: "session",
      prompt: "test",
      workdir: "/tmp",
      route: {
        provider: "telegram",
        target: "12345",
        sessionKey: "agent:main:telegram:group:12345",
      },
      status: "completed",
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
      costUsd: 0,
    });

    const changed = sm.updatePersistedSession("live-2", {
      lifecycle: "terminal",
      worktreeState: "pr_open",
      worktreePrUrl: "https://github.com/example/repo/pull/7",
      worktreePrNumber: 7,
    });

    assert.equal(changed, true);
    assert.equal(session.lifecycle, "terminal");
    assert.equal(session.worktreeState, "pr_open");
    assert.equal(session.worktreePrUrl, "https://github.com/example/repo/pull/7");
    assert.equal(session.worktreePrNumber, 7);
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

describe("SessionManager.bootstrapMaintenanceSchedules()", () => {
  it("seeds persisted reminder, retention, token-expiry deadlines, and tmp-output cleanup", () => {
    const sm = new SessionManager(5, 5);
    const now = Date.now();
    const scheduledKeys: string[] = [];
    const cleanupTimes: number[] = [];

    (sm as any).store.cleanupOrphanOutputFiles = () => {};
    (sm as any).store.cleanupTmpOutputFiles = (cleanupNow: number) => {
      cleanupTimes.push(cleanupNow);
    };
    (sm as any).store.getNextTmpOutputCleanupAt = () => now + 30_000;
    (sm as any).maintenance.schedule = ((key: string) => {
      scheduledKeys.push(key);
    }) as any;

    const pending = {
      sessionId: "pending-session",
      harnessSessionId: "pending-thread",
      backendRef: { kind: "claude-code", conversationId: "pending-thread" },
      name: "pending-session",
      prompt: "test",
      workdir: "/tmp",
      createdAt: now,
      completedAt: now,
      status: "completed",
      lifecycle: "awaiting_worktree_decision",
      approvalState: "not_required",
      worktreeState: "pending_decision",
      runtimeState: "stopped",
      deliveryState: "idle",
      costUsd: 0,
      pendingWorktreeDecisionSince: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
    };
    const resolved = {
      sessionId: "resolved-session",
      harnessSessionId: "resolved-thread",
      backendRef: { kind: "claude-code", conversationId: "resolved-thread" },
      name: "resolved-session",
      prompt: "test",
      workdir: "/tmp",
      createdAt: now,
      completedAt: now,
      status: "completed",
      lifecycle: "terminal",
      approvalState: "not_required",
      worktreeState: "merged",
      runtimeState: "stopped",
      deliveryState: "idle",
      costUsd: 0,
      worktreeLifecycle: {
        state: "merged",
        updatedAt: new Date(now).toISOString(),
        resolvedAt: new Date(now).toISOString(),
      },
    };

    (sm as any).persisted.set(pending.harnessSessionId, pending);
    (sm as any).persisted.set(resolved.harnessSessionId, resolved);
    (sm as any).idIndex.set(pending.sessionId, pending.harnessSessionId);
    (sm as any).idIndex.set(resolved.sessionId, resolved.harnessSessionId);
    (sm as any).store.actionTokens.set("token-1", {
      id: "token-1",
      sessionId: "pending-session",
      kind: "view-output",
      createdAt: now,
      expiresAt: now + 60_000,
    });

    sm.bootstrapMaintenanceSchedules();

    assert.ok(scheduledKeys.includes("persisted:pending-session:worktree-reminder"));
    assert.ok(scheduledKeys.includes("persisted:resolved-session:worktree-retention"));
    assert.ok(scheduledKeys.includes("tokens:expiry"));
    assert.ok(scheduledKeys.includes("tmp-output:cleanup"));
    assert.equal(cleanupTimes.length, 1);
    assert.equal(typeof cleanupTimes[0], "number");
  });

  it("re-arms tmp-output cleanup from the next actual expiry after each cleanup run", () => {
    const sm = new SessionManager(5, 5);
    const originalDateNow = Date.now;
    const now = 1_700_000_000_000;
    let currentNow = now;
    const scheduled: Array<{ key: string; at: number; cb: () => void }> = [];
    const cleanupTimes: number[] = [];
    const nextDeadlines = [now + 60_000, now + 120_000, undefined];

    Date.now = () => currentNow;

    try {
      (sm as any).store.getNextTmpOutputCleanupAt = () => nextDeadlines.shift();
      (sm as any).store.cleanupTmpOutputFiles = (cleanupNow: number) => {
        cleanupTimes.push(cleanupNow);
      };
      (sm as any).maintenance.cancel = (() => {}) as any;
      (sm as any).maintenance.schedule = ((key: string, at: number, cb: () => void) => {
        scheduled.push({ key, at, cb });
      }) as any;

      (sm as any).syncTmpOutputCleanupDeadline(now);
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].key, "tmp-output:cleanup");
      assert.equal(scheduled[0].at, now + 60_000);

      currentNow = now + 60_000;
      scheduled[0].cb();

      assert.deepEqual(cleanupTimes, [now + 60_000]);
      assert.equal(scheduled.length, 2);
      assert.equal(scheduled[1].key, "tmp-output:cleanup");
      assert.equal(scheduled[1].at, now + 120_000);

      currentNow = now + 120_000;
      scheduled[1].cb();

      assert.deepEqual(cleanupTimes, [now + 60_000, now + 120_000]);
      assert.equal(scheduled.length, 2);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("seeds retention for legacy merged sessions without worktreeLifecycle metadata", () => {
    const sm = new SessionManager(5, 5);
    const now = Date.now();
    const scheduledKeys: string[] = [];

    (sm as any).store.cleanupOrphanOutputFiles = () => {};
    (sm as any).store.cleanupTmpOutputFiles = () => {};
    (sm as any).maintenance.schedule = ((key: string) => {
      scheduledKeys.push(key);
    }) as any;

    const legacyResolved = {
      sessionId: "legacy-resolved-session",
      harnessSessionId: "legacy-resolved-thread",
      backendRef: { kind: "claude-code", conversationId: "legacy-resolved-thread" },
      name: "legacy-resolved-session",
      prompt: "test",
      workdir: "/tmp",
      createdAt: now - 60_000,
      completedAt: now - 30_000,
      status: "completed",
      lifecycle: "terminal",
      approvalState: "not_required",
      worktreeState: "merged",
      runtimeState: "stopped",
      deliveryState: "idle",
      costUsd: 0,
      worktreeBranch: "feature/legacy-resolved",
      worktreeMergedAt: new Date(now - 10_000).toISOString(),
    };

    (sm as any).persisted.set(legacyResolved.harnessSessionId, legacyResolved);
    (sm as any).idIndex.set(legacyResolved.sessionId, legacyResolved.harnessSessionId);

    sm.bootstrapMaintenanceSchedules();

    assert.ok(scheduledKeys.includes("persisted:legacy-resolved-session:worktree-retention"));
  });

  it("does not arm another runtime GC deadline while evicting a session from the GC callback", () => {
    const sm = new SessionManager(5, 5);
    const now = Date.now();
    const scheduledKeys: string[] = [];
    let runtimeGcCallback: (() => void) | undefined;

    (sm as any).store.getNextTmpOutputCleanupAt = () => undefined;
    (sm as any).maintenance.schedule = ((key: string, _at: number, cb: () => void) => {
      scheduledKeys.push(key);
      runtimeGcCallback = cb;
    }) as any;
    (sm as any).store.shouldGcActiveSession = () => true;
    (sm as any).store.hasRecordedSession = () => true;
    (sm as any).store.persistTerminal = () => {};
    (sm as any).store.getPersistedSession = () => undefined;
    (sm as any).registry.remove = () => {};

    const session = fakeSession({ id: "gc-session", status: "completed", completedAt: now });
    (sm as any).sessions.set(session.id, session);

    (sm as any).syncRuntimeGcDeadline(session);
    assert.deepEqual(scheduledKeys, ["runtime-gc:gc-session"]);

    runtimeGcCallback?.();
    assert.deepEqual(scheduledKeys, ["runtime-gc:gc-session"]);
  });

  it("cancels runtime GC deadlines for persisted sessions evicted by retention", () => {
    const sm = new SessionManager(5, 1);
    const cancelledKeys: string[] = [];

    (sm as any).maintenance.cancel = ((key: string) => {
      cancelledKeys.push(key);
    }) as any;
    (sm as any).maintenance.cancelPrefix = (() => {}) as any;
    (sm as any).store.evictOldestPersisted = () => [{
      sessionId: "evicted-session",
      harnessSessionId: "evicted-thread",
      backendRef: { kind: "claude-code", conversationId: "evicted-thread" },
      outputPath: undefined,
    }];

    (sm as any).enforcePersistedRetention();

    assert.ok(cancelledKeys.includes("runtime-gc:evicted-session"));
  });

  it("re-arms runtime GC when the configured max age increases after scheduling", () => {
    setPluginConfig({ sessionGcAgeMinutes: 1 });
    const sm = new SessionManager(5, 5);
    const now = 1_700_000_000_000;
    const originalDateNow = Date.now;
    const scheduled: Array<{ key: string; at: number; cb: () => void }> = [];

    Date.now = () => now + 60_000;

    try {
      (sm as any).maintenance.schedule = ((key: string, at: number, cb: () => void) => {
        scheduled.push({ key, at, cb });
      }) as any;
      (sm as any).store.shouldGcActiveSession = ((_session: any, currentNow: number, cleanupMaxAgeMs: number) => (
        currentNow - now > cleanupMaxAgeMs
      )) as any;
      (sm as any).registry.remove = () => {
        throw new Error("runtime GC should not evict while config was extended");
      };

      const session = fakeSession({ id: "gc-session", status: "completed", completedAt: now });
      (sm as any).sessions.set(session.id, session);

      (sm as any).syncRuntimeGcDeadline(session);
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0].at, now + 60_000);

      setPluginConfig({ sessionGcAgeMinutes: 2 });
      scheduled[0].cb();

      assert.equal(scheduled.length, 2);
      assert.equal(scheduled[1].key, "runtime-gc:gc-session");
      assert.equal(scheduled[1].at, now + 120_000);
    } finally {
      Date.now = originalDateNow;
      setPluginConfig({});
    }
  });

  it("does not re-arm the token-expiry deadline after purge already triggered a resync", () => {
    const sm = new SessionManager(5, 5);
    const scheduledKeys: string[] = [];
    let tokenExpiryCallback: (() => void) | undefined;

    (sm as any).maintenance.schedule = ((key: string, _at: number, cb: () => void) => {
      scheduledKeys.push(key);
      tokenExpiryCallback = cb;
    }) as any;
    (sm as any).store.getNextActionTokenExpiry = () => Date.now() + 60_000;
    (sm as any).store.purgeExpiredActionTokens = () => {
      (sm as any).syncActionTokenExpiryDeadline();
    };

    (sm as any).syncActionTokenExpiryDeadline();
    assert.deepEqual(scheduledKeys, ["tokens:expiry"]);

    tokenExpiryCallback?.();
    assert.deepEqual(scheduledKeys, ["tokens:expiry", "tokens:expiry"]);
  });

  it("backs off reminder retries after a delivery failure instead of rescheduling immediately", () => {
    const sm = new SessionManager(5, 5);
    const originalDateNow = Date.now;
    const now = 1_700_000_000_000;
    Date.now = () => now;

    try {
      const scheduled: Array<{ key: string; at: number; cb: () => void }> = [];
      const pending = {
        sessionId: "pending-session",
        harnessSessionId: "pending-thread",
        backendRef: { kind: "claude-code", conversationId: "pending-thread" },
        name: "pending-session",
        prompt: "test",
        workdir: "/tmp",
        createdAt: now,
        completedAt: now,
        status: "completed",
        lifecycle: "awaiting_worktree_decision",
        approvalState: "not_required",
        worktreeState: "pending_decision",
        runtimeState: "stopped",
        deliveryState: "idle",
        costUsd: 0,
        pendingWorktreeDecisionSince: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
      };

      (sm as any).persisted.set(pending.harnessSessionId, pending);
      (sm as any).idIndex.set(pending.sessionId, pending.harnessSessionId);
      (sm as any).maintenance.cancel = (() => {}) as any;
      (sm as any).maintenance.schedule = ((key: string, at: number, cb: () => void) => {
        scheduled.push({ key, at, cb });
      }) as any;
      (sm as any).reminders.sendReminderIfDue = (() => false) as any;

      (sm as any).syncPersistedSessionMaintenance(pending);
      assert.equal(scheduled.length, 1);

      scheduled[0].cb();

      assert.equal(scheduled.length, 2);
      assert.equal(scheduled[1].key, "persisted:pending-session:worktree-reminder");
      assert.equal(scheduled[1].at, now + 5 * 60 * 1000);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

// =========================================================================
// notifySession
// =========================================================================

describe("SessionManager.notifySession()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    setPluginConfig({});
    sm = new SessionManager(5);
    stubDispatch(sm);
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
    stubDispatch(sm);
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
    assert.match(request.wakeMessage, /Last output/);
    assert.match(request.userMessage, /⏸️ \[deterministic\] Turn completed/);
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
    assert.equal(request.buttons, undefined);
    assert.equal(request.notifyUser, "always");
    assert.match(request.userMessage, /❓ \[waiter\] Question waiting for reply/);
    assert.equal(request.wakeMessage, undefined);
    assert.match(request.wakeMessageOnNotifyFailed, /genuine user reply/i);
  });

  it("uses session planApproval override for plan approval buttons", () => {
    setPluginConfig({ planApproval: "delegate" });

    const s = fakeSession({
      id: "s-plan-ask",
      name: "planner",
      status: "running",
      pendingPlanApproval: true,
      planDecisionVersion: 7,
      planApproval: "ask",
      getOutput: () => ["Plan preview"],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.match(request.userMessage, /Plan v7 ready for approval/);
    assert.match(request.userMessage, /Review summary:/);
    assert.match(request.userMessage, /- Plan preview/);
    assert.equal(request.buttons[0][0].label, "Approve");
    assert.equal(request.buttons[0][1].label, "Revise");
    assert.equal(request.buttons[0][2].label, "Reject");
    assert.match(request.wakeMessageOnNotifySuccess, /Session: planner \| ID: s-plan-ask/);

    const approveTokenId = request.buttons[0][0].callbackData;
    const approveToken = (sm as any).interactions.consumeActionToken(approveTokenId);
    assert.equal(approveToken.planDecisionVersion, 7);
  });

  it("shows approval buttons for Codex plan sessions when planApproval=ask", () => {
    const s = fakeSession({
      id: "s-codex-plan-ask",
      name: "codex-plan-ask",
      status: "running",
      harnessName: "codex",
      pendingPlanApproval: true,
      planApproval: "ask",
      getOutput: () => ["Codex plan preview"],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.equal(request.buttons[0][0].label, "Approve");
    assert.equal(request.buttons[0][1].label, "Revise");
    assert.equal(request.buttons[0][2].label, "Reject");
  });

  it("routes delegated plan reviews through a wake-only approval stop", () => {
    setPluginConfig({ planApproval: "ask" });

    const s = fakeSession({
      id: "s-plan-delegate",
      name: "planner-delegate",
      status: "running",
      pendingPlanApproval: true,
      planApproval: "delegate",
      getOutput: () => ["Plan preview"],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.equal(request.notifyUser, "never");
    assert.equal(request.userMessage, undefined);
    assert.equal(request.buttons, undefined);
    assert.match(request.wakeMessage, /DELEGATED PLAN APPROVAL/);
    assert.match(request.wakeMessage, /Review privately/);
  });

  it("does not show approval buttons for Codex plan sessions when planApproval=delegate", () => {
    const s = fakeSession({
      id: "s-codex-plan-delegate",
      name: "codex-plan-delegate",
      status: "running",
      harnessName: "codex",
      pendingPlanApproval: true,
      planApproval: "delegate",
      getOutput: () => ["Codex plan preview"],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.equal(request.buttons, undefined);
  });

  it("shows approval buttons for explicit plan approval sessions when planApproval=ask", () => {
    const s = fakeSession({
      id: "s-plan-ask",
      name: "plan-ask",
      status: "running",
      pendingPlanApproval: true,
      planApproval: "ask",
      getOutput: () => ["Proposed plan:\n- Inspect state flow\n- Add buttons"],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.equal(request.buttons[0][0].label, "Approve");
    assert.equal(request.buttons[0][1].label, "Revise");
    assert.equal(request.buttons[0][2].label, "Reject");
  });

  it("uses matching structured artifacts to build ask-mode plan review summaries", () => {
    const s = fakeSession({
      id: "s-plan-structured",
      name: "plan-structured",
      status: "running",
      pendingPlanApproval: true,
      planDecisionVersion: 4,
      actionablePlanDecisionVersion: 4,
      planApproval: "ask",
      latestPlanArtifactVersion: 4,
      latestPlanArtifact: {
        explanation: "Keep the scope inside the approval flow.",
        markdown: "1. Update prompt\n2. Add tests",
        steps: [
          { step: "Update the prompt copy", status: "pending" },
          { step: "Add focused regression tests", status: "pending" },
        ],
      },
      getOutput: () => ["Plan preview that should not be used when structured data matches."],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.match(request.userMessage, /Review summary:/);
    assert.match(request.userMessage, /Keep the scope inside the approval flow\./);
    assert.match(request.userMessage, /- Update the prompt copy/);
    assert.match(request.userMessage, /- Add focused regression tests/);
  });

  it("ignores stale structured artifacts and falls back to preview-derived summaries", () => {
    const s = fakeSession({
      id: "s-plan-stale",
      name: "plan-stale",
      status: "running",
      pendingPlanApproval: true,
      planDecisionVersion: 5,
      actionablePlanDecisionVersion: 5,
      planApproval: "ask",
      latestPlanArtifactVersion: 4,
      latestPlanArtifact: {
        explanation: "Stale explanation",
        markdown: "1. stale",
        steps: [{ step: "Stale step", status: "pending" }],
      },
      getOutput: () => [
        "Proposed plan:",
        "1. Inspect the current notification flow",
        "2. Add a safe fallback summary",
        "Should I proceed?",
      ],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.match(request.userMessage, /Review summary:/);
    assert.match(request.userMessage, /- Inspect the current notification flow/);
    assert.match(request.userMessage, /- Add a safe fallback summary/);
    assert.doesNotMatch(request.userMessage, /Stale explanation/);
    assert.doesNotMatch(request.userMessage, /Stale step/);
    assert.doesNotMatch(request.userMessage, /Should I proceed\?/);
  });

  it("reuses plan approval buttons when delegated review escalates back to the user", () => {
    const s = fakeSession({
      id: "s-plan-escalate",
      name: "plan-escalate",
      status: "running",
      pendingPlanApproval: true,
      planDecisionVersion: 9,
      planApproval: "delegate",
    });
    (sm as any).sessions.set(s.id, s);
    stubDispatch(sm);

    const result = sm.requestPlanApprovalFromUser(
      s.id,
      "Summary:\n- Touches `src/session-manager.ts`\n- Risk: medium because approval routing changes\n- Scope matches original task",
    );

    assert.match(result, /Canonical plan approval prompt sent/);
    assert.match(result, /Do not send a separate plain-text approval message/);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.match(request.userMessage, /Plan v9 needs your decision/);
    assert.match(request.userMessage, /Why this was escalated:/);
    assert.match(request.userMessage, /Risk: medium/);
    assert.deepEqual(
      request.buttons.map((row: Array<{ label: string }>) => row.map((button) => button.label)),
      [["Approve", "Revise", "Reject"]],
    );

    const approveToken = (sm as any).interactions.consumeActionToken(request.buttons[0][0].callbackData);
    assert.equal(approveToken?.planDecisionVersion, 9);
  });

  it("suppresses duplicate delegated escalations for the same plan decision version", () => {
    const s = fakeSession({
      id: "s-plan-escalate-once",
      name: "plan-escalate-once",
      status: "running",
      pendingPlanApproval: true,
      planDecisionVersion: 11,
      planApproval: "delegate",
      deliveryState: "idle",
    });
    (sm as any).sessions.set(s.id, s);
    stubDispatch(sm);

    const first = sm.requestPlanApprovalFromUser(
      s.id,
      "Summary:\n- Touches `src/session-manager.ts`\n- Risk: medium\n- Scope matches original task",
    );
    assert.match(first, /Canonical plan approval prompt sent/);

    const [_sessionArg, request] = (sm as any).__dispatchCalls[0];
    request.hooks.onNotifySucceeded();

    const second = sm.requestPlanApprovalFromUser(
      s.id,
      "Summary:\n- Touches `src/session-manager.ts`\n- Risk: medium\n- Scope matches original task",
    );
    assert.match(second, /already exists/);
    assert.match(second, /Do not send a separate plain-text approval message/);
    assert.equal((sm as any).__dispatchCalls.length, 1);
  });

  it("dispatches an explicit fallback prompt when delegated interactive delivery fails", () => {
    const s = fakeSession({
      id: "s-plan-escalate-fallback",
      name: "plan-escalate-fallback",
      status: "running",
      pendingPlanApproval: true,
      planDecisionVersion: 12,
      actionablePlanDecisionVersion: 12,
      planApproval: "delegate",
      originThreadId: "42",
    });
    (sm as any).sessions.set(s.id, s);
    stubDispatch(sm);

    sm.requestPlanApprovalFromUser(
      s.id,
      "Summary:\n- Touches `src/session-manager.ts`\n- Risk: medium\n- Scope matches original task",
    );

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    request.onUserNotifyFailed();

    assert.equal(calls.length, 2);
    const [_fallbackSession, fallbackRequest] = calls[1];
    assert.equal(fallbackRequest.label, "plan-approval-fallback");
    assert.equal(fallbackRequest.buttons, undefined);
    assert.match(fallbackRequest.userMessage, /buttons could not be delivered/i);
    fallbackRequest.hooks.onNotifySucceeded();
    assert.equal(s.approvalPromptStatus, "fallback_delivered");
    assert.equal(s.approvalPromptMessageKind, "explicit_fallback_text");
  });

  it("treats a delivered fallback prompt as an existing actionable review prompt", () => {
    const s = fakeSession({
      id: "s-plan-fallback-present",
      name: "plan-fallback-present",
      status: "running",
      pendingPlanApproval: true,
      planDecisionVersion: 13,
      actionablePlanDecisionVersion: 13,
      planApproval: "delegate",
      approvalPromptRequiredVersion: 13,
      approvalPromptStatus: "fallback_delivered",
    });
    (sm as any).sessions.set(s.id, s);
    stubDispatch(sm);

    const result = sm.requestPlanApprovalFromUser(
      s.id,
      "Summary:\n- Touches `src/session-manager.ts`\n- Risk: low\n- Scope matches original task",
    );

    assert.match(result, /already exists/);
    assert.equal((sm as any).__dispatchCalls.length, 0);
  });

  it("rejects duplicate summary approval prompts for ask-mode plan reviews", () => {
    const s = fakeSession({
      id: "s-plan-ask-duplicate",
      name: "plan-ask-duplicate",
      status: "running",
      pendingPlanApproval: true,
      planDecisionVersion: 3,
      planApproval: "ask",
    });
    (sm as any).sessions.set(s.id, s);
    stubDispatch(sm);

    const result = sm.requestPlanApprovalFromUser(
      s.id,
      "Summary:\\n- Touches `src/session-manager.ts`\\n- Risk: low\\n- Scope matches original task",
    );

    assert.match(result, /already uses direct user plan approval/i);
    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 0);
  });

  it("routes bypass-permissions 'should I continue?' prompts through generic waiting only", () => {
    const s = fakeSession({
      id: "s-continue",
      name: "continue-session",
      status: "running",
      currentPermissionMode: "bypassPermissions",
      pendingPlanApproval: false,
      getOutput: () => ["Should I continue and apply the migration?"],
    });

    (sm as any).onTurnEnd(s, true);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "waiting");
    assert.equal(request.buttons, undefined);
    assert.equal(request.wakeMessage, undefined);
    assert.match(request.wakeMessageOnNotifyFailed, /Follow your auto-respond rules strictly/);
    assert.doesNotMatch(request.userMessage, /Plan ready for approval/);
  });

  it("sends waiting questions as a single user notification with wake fallback only", () => {
    const s = fakeSession({
      id: "s-pending-input",
      name: "pending-input-session",
      status: "running",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-1",
        kind: "approval",
        promptText: "Do you want to allow read-only workspace inspection so I can gather the files needed for the investigation memo?",
        options: ["Allow", "Deny"],
      },
      getOutput: () => ["Do you want to allow read-only workspace inspection so I can gather the files needed for the investigation memo?"],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "waiting");
    assert.equal(request.wakeMessage, undefined);
    assert.match(request.userMessage, /allow read-only workspace inspection/);
    assert.match(request.wakeMessageOnNotifyFailed, /allow read-only workspace inspection/);
  });

  it("emits two separate waiting notifications for back-to-back native pending-input requests in one Codex session", async () => {
    const s = fakeSession({
      id: "s-codex-pending-input",
      name: "codex-pending-input-session",
      status: "running",
      harnessName: "codex",
      pendingPlanApproval: false,
      pendingInputState: {
        requestId: "req-1",
        kind: "selection",
        promptText: "Choose the first environment",
        options: ["Staging", "Production"],
      },
      submitPendingInputOption: async (optionIndex: number) => optionIndex === 1,
      getOutput: () => [],
    });
    (sm as any).sessions.set(s.id, s);

    (sm as any).triggerWaitingForInputEvent(s);
    const firstRequest = (sm as any).__dispatchCalls[0][1];
    assert.equal(firstRequest.label, "waiting");
    assert.deepEqual(
      firstRequest.buttons.map((row: Array<{ label: string }>) => row.map((button) => button.label)),
      [["Staging", "Production"]],
    );

    const resolved = await sm.resolvePendingInputOption(s.id, 1);
    assert.equal(resolved, true);

    s.pendingInputState = {
      requestId: "req-2",
      kind: "selection",
      promptText: "Choose the second environment",
      options: ["Preview", "Prod"],
    };

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 2);
    const secondRequest = calls[1][1];
    assert.equal(secondRequest.label, "waiting");
    assert.match(secondRequest.userMessage, /Choose the second environment/);
    assert.deepEqual(
      secondRequest.buttons.map((row: Array<{ label: string }>) => row.map((button) => button.label)),
      [["Preview", "Prod"]],
    );
  });

  it("keeps plan approval routing ahead of worktree delegate suppression", () => {
    const s = fakeSession({
      id: "s-plan-worktree",
      name: "planner-worktree",
      status: "running",
      pendingPlanApproval: true,
      planApproval: "ask",
      worktreeStrategy: "delegate",
      getOutput: () => ["Plan preview"],
    });

    (sm as any).onTurnEnd(s, true);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.equal(request.buttons[0][0].label, "Approve");
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

  it("preserves plan approvals as normal ask-mode buttons", () => {
    const s = fakeSession({
      id: "s-plan-mode",
      name: "plan-mode",
      status: "running",
      harnessName: "codex",
      pendingPlanApproval: true,
      planApprovalContext: "plan-mode",
      planApproval: "ask",
      getOutput: () => ["Codex first-turn plan preview"],
    });

    (sm as any).triggerWaitingForInputEvent(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval");
    assert.deepEqual(
      request.buttons.map((row: Array<{ label: string }>) => row.map((button) => button.label)),
      [["Approve", "Revise", "Reject"]],
    );
  });

  it("keeps ordinary terminal completions deterministic even when output looks like a report", async () => {
    const reviewSummary = [
      "Findings:",
      "- Race condition still exists in the retry path.",
      "- Missing regression coverage for the failed-restore branch.",
    ].join("\n");
    const s = fakeSession({
      id: "s-review-complete",
      name: "review-session",
      status: "completed",
      prompt: "Review the current implementation and report the main findings.",
      duration: 12_000,
      completedAt: Date.now(),
      getOutput: (n?: number) => {
        const lines = reviewSummary.split("\n");
        return n === undefined ? lines : lines.slice(-n);
      },
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "completed");
    assert.equal(request.userMessage, "✅ [review-session] Completed | $0.00 | 12s");
    assert.match(request.wakeMessageOnNotifySuccess, /Output preview:/);
    assert.doesNotMatch(request.wakeMessageOnNotifySuccess, /Completion summary:/);
  });

  it("keeps normal completion notifications deterministic", async () => {
    const s = fakeSession({
      id: "s-normal-complete",
      name: "normal-session",
      status: "completed",
      prompt: "Implement the approved fix.",
      duration: 8_000,
      completedAt: Date.now(),
      getOutput: (n?: number) => {
        const lines = ["Implemented the fix and updated tests."];
        return n === undefined ? lines : lines.slice(-n);
      },
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "completed");
    assert.equal(request.userMessage, "✅ [normal-session] Completed | $0.00 | 8s");
    assert.match(request.wakeMessageOnNotifySuccess, /plugin already sent the canonical completion status/i);
    assert.match(request.wakeMessageOnNotifySuccess, /must send the user a short factual completion summary/i);
    assert.match(request.wakeMessageOnNotifySuccess, /ordinary terminal\/manual completions too/i);
    assert.match(request.wakeMessageOnNotifySuccess, /do NOT repeat the plugin's status line/i);
    assert.match(request.wakeMessageOnNotifyFailed, /did not confirm delivery of the canonical completion status/i);
  });

  it("does not derive completion summaries from terminal transcript lines", async () => {
    const lines = [
      "Setting up the repository context.",
      "Checking the existing tests.",
      "Implemented the cleanup guard and updated the regression coverage.",
    ];
    const s = fakeSession({
      id: "s-tail-summary",
      name: "tail-summary-session",
      status: "completed",
      prompt: "Implement the cleanup fix.",
      duration: 9_000,
      completedAt: Date.now(),
      getOutput: (n?: number) => n === undefined ? lines : lines.slice(-n),
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "completed");
    assert.equal(request.userMessage, "✅ [tail-summary-session] Completed | $0.00 | 9s");
    assert.doesNotMatch(request.wakeMessageOnNotifySuccess, /Completion summary:/);
  });

  it("suppresses turn-complete when the session is already terminal and relies on the final completed notification", async () => {
    const s = fakeSession({
      id: "s-terminal-race",
      name: "terminal-race",
      status: "completed",
      killReason: "done",
      duration: 5_000,
      completedAt: Date.now(),
      result: {
        session_id: "thread-race",
        num_turns: 2,
        duration_ms: 5_000,
      },
      getOutput: () => ["Applied the completion fix and added tests."],
    });
    (sm as any).onTurnEnd(s, false);
    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "completed");
    assert.doesNotMatch(request.userMessage, /⏸️/);
    assert.equal(request.userMessage, "✅ [terminal-race] Completed | $0.00 | 5s");
  });
});

describe("SessionManager restored button parity", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  function buttonLabels(rows: Array<Array<{ label: string }>> | undefined): string[][] {
    return (rows ?? []).map((row) => row.map((button) => button.label));
  }

  it("renders the same restored worktree action set for Telegram and Discord sessions", () => {
    const telegramId = "h-telegram-worktree";
    const discordId = "h-discord-worktree";

    sm.persisted.set(telegramId, {
      harnessSessionId: telegramId,
      name: "telegram-worktree",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      route: { provider: "telegram", target: "12345", threadId: "42" },
      worktreeState: "pending_decision",
      lifecycle: "awaiting_worktree_decision",
      worktreeStrategy: "ask",
      worktreePath: "/tmp/repo/.worktrees/telegram-worktree",
      worktreeBranch: "agent/telegram-worktree",
    } as any);
    sm.persisted.set(discordId, {
      harnessSessionId: discordId,
      name: "discord-worktree",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      route: { provider: "discord", target: "channel:999" },
      worktreeState: "pending_decision",
      lifecycle: "awaiting_worktree_decision",
      worktreeStrategy: "ask",
      worktreePath: "/tmp/repo/.worktrees/discord-worktree",
      worktreeBranch: "agent/discord-worktree",
    } as any);

    const telegramButtons = (sm as any).getWorktreeDecisionButtons(telegramId);
    const discordButtons = (sm as any).getWorktreeDecisionButtons(discordId);

    assert.deepEqual(buttonLabels(telegramButtons), buttonLabels(discordButtons));
    assert.deepEqual(buttonLabels(telegramButtons), [["Merge", "Open PR"], ["Later", "Discard"]]);
  });

  it("uses the same plan approval button set for restored plan decisions", () => {
    const buttons = (sm as any).interactions.getPlanApprovalButtons("restored-plan", {
      planDecisionVersion: 4,
    });

    assert.deepEqual(buttonLabels(buttons), [["Approve", "Revise", "Reject"]]);
    const approveToken = (sm as any).interactions.consumeActionToken(buttons[0][0].callbackData);
    assert.equal(approveToken?.planDecisionVersion, 4);
  });

  it("uses the same resume action set for restored failed or suspended sessions", () => {
    const resumableButtons = (sm as any).interactions.getResumeButtons("restored-resume", {
      isExplicitlyResumable: true,
    });
    const nonResumableButtons = (sm as any).interactions.getResumeButtons("restored-output-only", {
      isExplicitlyResumable: false,
    });

    assert.deepEqual(buttonLabels(resumableButtons), [["Resume", "View output"]]);
    assert.deepEqual(buttonLabels(nonResumableButtons), [["View output"]]);
  });
});

describe("SessionManager terminal wakes", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
    stubDispatch(sm);
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
    assert.match(request.wakeMessageOnNotifySuccess, /Coding agent session completed/);
    assert.match(request.wakeMessageOnNotifyFailed, /Coding agent session completed/);
  });
});

describe("SessionManager terminal wake behavior", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
    stubDispatch(sm);
  });

  it("de-dupes duplicate completion wake for the same terminal marker", async () => {
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
    await (sm as any).onSessionTerminal(s);
    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "completed");
  });

  it("wakes the originating agent when a session fails", async () => {
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

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [sessionArg, request] = calls[0];
    assert.equal(sessionArg.id, "s-failed");
    assert.equal(request.label, "failed");
    assert.equal(request.notifyUser, "always");
    assert.match(request.wakeMessage, /Coding agent session failed/);
    assert.match(request.wakeMessage, /Failure summary:/);
    assert.match(request.wakeMessage, /not supported when using Codex with a ChatGPT account/);
    assert.match(request.wakeMessage, /relaunch fresh with agent_launch/);
    assert.match(request.userMessage, /❌ \[broken-launch\] Failed/);
  });

  it("uses the final substantive block for terminal completion wake previews", async () => {
    const prefix = "Plan:\n" + "review requirements\n".repeat(120);
    const suffix = [
      "Implementation complete:",
      "- Built rust-hello-world successfully",
      "- Verified the binary prints hello world",
      "- No follow-up action needed",
    ].join("\n");
    const s = fakeSession({
      id: "s-final-block",
      name: "final-block",
      status: "completed",
      completedAt: 1700000001500,
      getOutput: () => [`${prefix}\n\n${suffix}`],
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.wakeMessageOnNotifySuccess, /Implementation complete:/);
    assert.doesNotMatch(request.wakeMessageOnNotifySuccess, /review requirements/);
  });

  it("prefers post-approval execution output over earlier plan text in completion wakes", async () => {
    const planBlock = "Plan draft:\n" + "collect requirements\n".repeat(140);
    const finalBlock = [
      "Completed work after approval:",
      "- Added the missing build step",
      "- Ran the hello world binary",
      "- Confirmed the output is stable",
    ].join("\n");
    const s = fakeSession({
      id: "s-approved-complete",
      name: "approved-complete",
      status: "completed",
      approvalState: "approved",
      planDecisionVersion: 2,
      completedAt: 1700000001750,
      getOutput: () => [`${planBlock}\n\n${finalBlock}`],
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.wakeMessageOnNotifySuccess, /Completed work after approval:/);
    assert.doesNotMatch(request.wakeMessageOnNotifySuccess, /collect requirements/);
  });

  it("includes deterministic approval/execution context in terminal completion wakes", async () => {
    const s = fakeSession({
      id: "s-approval-context",
      name: "approval-context",
      status: "completed",
      requestedPermissionMode: "plan",
      currentPermissionMode: "bypassPermissions",
      approvalExecutionState: "approved_then_implemented",
      completedAt: 1700000001900,
      getOutput: () => ["Implementation finished."],
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.wakeMessageOnNotifySuccess, /Requested permission mode: plan/);
    assert.match(request.wakeMessageOnNotifySuccess, /Effective permission mode: bypassPermissions/);
    assert.match(request.wakeMessageOnNotifySuccess, /Deterministic approval\/execution state: approved_then_implemented/);
  });

  it("de-dupes duplicate failed wake for the same terminal marker", async () => {
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

    await (sm as any).onSessionTerminal(s);
    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "failed");
  });

  it("uses a dedicated idle-timeout notification", async () => {
    const s = fakeSession({
      id: "s-idle-timeout",
      name: "idle-run",
      status: "killed",
      killReason: "idle-timeout",
      costUsd: 0.25,
      startedAt: Date.now() - 2_000,
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "suspended");
    assert.match(request.userMessage, /💤 \[idle-run\] Suspended after idle timeout/);
  });

  it("keeps timed-out pending plans in the plan-decision UX", async () => {
    const s = fakeSession({
      id: "s-plan-timeout",
      name: "spellcast-release-readiness-plan",
      status: "killed",
      killReason: "idle-timeout",
      pendingPlanApproval: true,
      planDecisionVersion: 7,
      planApproval: "ask",
      isExplicitlyResumable: true,
      costUsd: 0,
      startedAt: Date.now() - 2_000,
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval-timeout");
    assert.match(request.userMessage, /Plan v7 still awaiting approval after idle timeout/);
    assert.match(request.userMessage, /Approve resumes the session and starts implementation/);
    assert.match(request.userMessage, /Revise resumes it in plan mode/);
    assert.match(request.userMessage, /Reject keeps the session stopped/);
    assert.deepEqual(
      (request.buttons ?? []).map((row: Array<{ label: string }>) => row.map((button) => button.label)),
      [["Approve", "Revise", "Reject"]],
    );
  });

  it("suppresses duplicate timed-out ask-mode summaries once a provable review prompt exists", async () => {
    const s = fakeSession({
      id: "s-plan-timeout-known-prompt",
      name: "known-prompt-plan",
      status: "killed",
      killReason: "idle-timeout",
      pendingPlanApproval: true,
      planDecisionVersion: 9,
      actionablePlanDecisionVersion: 9,
      planApproval: "ask",
      approvalPromptRequiredVersion: 9,
      approvalPromptStatus: "fallback_delivered",
      startedAt: Date.now() - 2_000,
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.notifyUser, "never");
    assert.equal(request.userMessage, undefined);
    assert.match(request.wakeMessage, /already has an actionable plan review prompt/i);
  });

  it("keeps delegated timed-out pending plans wake-only", async () => {
    const s = fakeSession({
      id: "s-plan-timeout-delegate",
      name: "delegate-timeout-plan",
      status: "killed",
      killReason: "idle-timeout",
      pendingPlanApproval: true,
      planDecisionVersion: 8,
      planApproval: "delegate",
      isExplicitlyResumable: true,
      costUsd: 0,
      startedAt: Date.now() - 2_000,
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "plan-approval-timeout");
    assert.equal(request.notifyUser, "never");
    assert.equal(request.userMessage, undefined);
    assert.equal(request.buttons, undefined);
    assert.match(request.wakeMessage, /DELEGATED PLAN APPROVAL REMINDER/);
    assert.match(request.wakeMessage, /agent_request_plan_approval/);
  });

  it("uses explicit stopped wording for user-terminated sessions", async () => {
    const s = fakeSession({
      id: "s-user-stop",
      name: "manual-stop",
      status: "killed",
      killReason: "user",
      startedAt: Date.now() - 2_000,
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.userMessage, /⛔ \[manual-stop\] Stopped by user/);
  });

  it("uses explicit stopped wording for startup timeouts", async () => {
    const s = fakeSession({
      id: "s-startup-timeout",
      name: "startup-stop",
      status: "killed",
      killReason: "startup-timeout",
      startedAt: Date.now() - 2_000,
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.userMessage, /⛔ \[startup-stop\] Stopped by startup timeout/);
  });

  it("uses explicit stopped wording for shutdown stops", async () => {
    const s = fakeSession({
      id: "s-shutdown-stop",
      name: "shutdown-stop",
      status: "killed",
      killReason: "shutdown",
      startedAt: Date.now() - 2_000,
    });

    await (sm as any).onSessionTerminal(s);

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.match(request.userMessage, /⛔ \[shutdown-stop\] Stopped by shutdown/);
  });
});

// =========================================================================
// shouldRunWorktreeStrategy
// =========================================================================

describe("SessionManager.shouldRunWorktreeStrategy", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  it("returns false when session lifecycle is 'starting'", () => {
    const session = fakeSession({ lifecycle: "starting", pendingPlanApproval: false });
    Object.defineProperty(session, "lifecycle", { get: () => "starting" });
    const result = (sm as any).shouldRunWorktreeStrategy(session);
    assert.equal(result, false);
  });

  it("returns false when session lifecycle is 'awaiting_plan_decision'", () => {
    const session = fakeSession({ pendingPlanApproval: true });
    Object.defineProperty(session, "lifecycle", { get: () => "awaiting_plan_decision" });
    const result = (sm as any).shouldRunWorktreeStrategy(session);
    assert.equal(result, false);
  });

  it("returns false when pendingPlanApproval is true", () => {
    const session = fakeSession({ pendingPlanApproval: true });
    Object.defineProperty(session, "lifecycle", { get: () => "active" });
    const result = (sm as any).shouldRunWorktreeStrategy(session);
    assert.equal(result, false);
  });

  it("returns true when session lifecycle is 'active' and no pending plan approval", () => {
    const session = fakeSession({ pendingPlanApproval: false });
    Object.defineProperty(session, "lifecycle", { get: () => "active" });
    const result = (sm as any).shouldRunWorktreeStrategy(session);
    assert.equal(result, true);
  });
});

describe("SessionManager.handleAskUserQuestion()", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
    stubDispatch(sm);
  });

  it("renders explicit question options as buttons without bypassing them", async () => {
    const session = fakeSession({
      id: "s-cc-worktree",
      name: "cc-worktree",
      worktreeStrategy: "ask",
    });
    (sm as any).sessions.set(session.id, session);

    const pending = sm.handleAskUserQuestion(session.id, {
      questions: [{
        question: "Should I merge this branch or open a PR?",
        options: [
          { label: "Merge" },
          { label: "Open PR" },
          { label: "Decide later" },
        ],
      }],
    });

    assert.equal((sm as any).__dispatchCalls.length, 1);
    const [_sessionArg, request] = (sm as any).__dispatchCalls[0];
    assert.equal(request.label, "ask-user-question");
    assert.equal(request.buttons[0][0].label, "Merge");
    assert.equal(request.buttons[0][1].label, "Open PR");
    assert.equal(request.buttons[0][2].label, "Decide later");
    assert.match(request.wakeMessageOnNotifySuccess, /Session: cc-worktree \| ID: s-cc-worktree/);
    assert.match(request.wakeMessageOnNotifySuccess, /Should I merge this branch or open a PR\?/);

    const pendingQuestion = (sm as any).pendingAskUserQuestions.get(session.id);
    clearTimeout(pendingQuestion.timeoutHandle);
    pendingQuestion.reject(new Error("test cleanup"));
    await assert.rejects(pending, /test cleanup/);
  });

  it("still delivers genuine questions to the user with reply buttons", async () => {
    const session = fakeSession({
      id: "s-cc-question",
      name: "cc-question",
      worktreeStrategy: "ask",
    });
    (sm as any).sessions.set(session.id, session);

    const pending = sm.handleAskUserQuestion(session.id, {
      questions: [{
        question: "Which environment should I target?",
        options: [
          { label: "Staging" },
          { label: "Production" },
        ],
      }],
    });

    const calls = (sm as any).__dispatchCalls;
    assert.equal(calls.length, 1);
    const [_sessionArg, request] = calls[0];
    assert.equal(request.label, "ask-user-question");
    assert.equal(request.buttons[0][0].label, "Staging");
    assert.equal(request.buttons[0][1].label, "Production");
    assert.match(request.wakeMessageOnNotifySuccess, /Session: cc-question \| ID: s-cc-question/);
    assert.match(request.wakeMessageOnNotifySuccess, /Which environment should I target\?/);

    sm.resolveAskUserQuestion(session.id, 0);
    await pending;
  });
});
