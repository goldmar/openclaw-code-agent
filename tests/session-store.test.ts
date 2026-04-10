import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session-store";
import { STORE_SCHEMA_VERSION } from "../src/session-store-normalization";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

const DEFAULT_ROUTE = {
  provider: "telegram",
  accountId: "bot",
  target: "12345",
  threadId: "42",
  sessionKey: "agent:main:telegram:group:12345:topic:42",
};

function writeStore(
  indexPath: string,
  sessions: Record<string, unknown>[],
  actionTokens: Record<string, unknown>[] = [],
): void {
  writeFileSync(indexPath, JSON.stringify({
    schemaVersion: STORE_SCHEMA_VERSION,
    sessions: sessions.map((session) => ({
      route: DEFAULT_ROUTE,
      ...session,
    })),
    actionTokens,
  }), "utf-8");
}

describe("SessionStore getLatestPersistedByName", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
    store.persisted.clear();
    store.idIndex.clear();
    store.nameIndex.clear();
    (store as any).backendIdIndex?.clear();
  });

  it("returns latest created entry when sessions share same name", () => {
    store.persisted.set("h-old", {
      harnessSessionId: "h-old",
      backendRef: { kind: "claude-code", conversationId: "thread-old" },
      name: "dup",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      createdAt: 100,
      completedAt: 120,
    } as any);
    store.persisted.set("h-new", {
      harnessSessionId: "h-new",
      backendRef: { kind: "claude-code", conversationId: "thread-new" },
      name: "dup",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      createdAt: 200,
      completedAt: 220,
    } as any);

    const resolved = store.resolveHarnessSessionId("dup");
    const persisted = store.getPersistedSession("dup");

    assert.equal(resolved, "thread-new");
    assert.equal(persisted?.harnessSessionId, "h-new");
  });

  it("legacy entries without createdAt fall back to completedAt", () => {
    store.persisted.set("h-older", {
      harnessSessionId: "h-older",
      backendRef: { kind: "claude-code", conversationId: "thread-older" },
      name: "legacy",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      completedAt: 100,
    } as any);
    store.persisted.set("h-latest", {
      harnessSessionId: "h-latest",
      backendRef: { kind: "claude-code", conversationId: "thread-latest" },
      name: "legacy",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      completedAt: 300,
    } as any);

    const resolved = store.resolveHarnessSessionId("legacy");
    const persisted = store.getPersistedSession("legacy");

    assert.equal(resolved, "thread-latest");
    assert.equal(persisted?.harnessSessionId, "h-latest");
  });
});

describe("SessionStore path resolution", () => {
  function markRunningAt(store: SessionStore, sessionId: string): void {
    store.markRunning({
      id: sessionId,
      name: "test",
      harnessSessionId: `h-${sessionId}`,
      prompt: "p",
      workdir: "/tmp",
      model: undefined,
      startedAt: Date.now(),
      originAgentId: undefined,
      originChannel: undefined,
      originThreadId: undefined,
      originSessionKey: undefined,
      route: DEFAULT_ROUTE,
      harnessName: "codex",
    } as any);
  }

  it("prefers OPENCLAW_CODE_AGENT_SESSIONS_PATH over OPENCLAW_HOME", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-path-"));
    const explicit = join(dir, "explicit-sessions.json");
    const openclawHome = join(dir, "ignored-openclaw-home");
    const homeIndex = join(openclawHome, "code-agent-sessions.json");
    mkdirSync(openclawHome, { recursive: true });
    writeStore(explicit, []);
    writeStore(homeIndex, []);

    const store = new SessionStore({
      env: {
        OPENCLAW_CODE_AGENT_SESSIONS_PATH: explicit,
        OPENCLAW_HOME: openclawHome,
      },
    });
    markRunningAt(store, "explicit");

    assert.equal(existsSync(explicit), true);
    assert.equal(existsSync(homeIndex), true);
    const explicitJson = JSON.parse(readFileSync(explicit, "utf-8"));
    const homeJson = JSON.parse(readFileSync(homeIndex, "utf-8"));
    assert.equal(explicitJson.schemaVersion, STORE_SCHEMA_VERSION);
    assert.equal(explicitJson.sessions.length, 1);
    assert.equal(homeJson.schemaVersion, STORE_SCHEMA_VERSION);
    assert.equal(homeJson.sessions.length, 0);
  });

  it("uses OPENCLAW_HOME when explicit sessions path is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-home-"));
    const sessionsPath = join(dir, "code-agent-sessions.json");
    writeStore(sessionsPath, []);

    const store = new SessionStore({
      env: { OPENCLAW_HOME: dir },
    });
    markRunningAt(store, "home");

    const persisted = JSON.parse(readFileSync(sessionsPath, "utf-8"));
    assert.equal(persisted.schemaVersion, STORE_SCHEMA_VERSION);
    assert.equal(persisted.sessions.length, 1);
    assert.equal(persisted.sessions[0].sessionId, "home");
  });

  it("allows constructor indexPath override for deterministic callers", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-override-"));
    const indexPath = join(dir, "custom-index.json");
    writeStore(indexPath, []);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    assert.deepEqual([...store.persisted.keys()], []);
  });

  it("rebuilds short session ID lookup from persisted index after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-restart-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, []);

    const original = new SessionStore({
      indexPath,
      env: {},
    });
    markRunningAt(original, "GccpSIqJ");

    const reloaded = new SessionStore({
      indexPath,
      env: {},
    });

    const persisted = reloaded.getPersistedSession("GccpSIqJ");
    assert.equal(reloaded.resolveHarnessSessionId("GccpSIqJ"), "h-GccpSIqJ");
    assert.equal(persisted?.harnessSessionId, "h-GccpSIqJ");
    assert.equal(persisted?.sessionId, "GccpSIqJ");
    assert.equal(persisted?.status, "killed");
  });

  it("resolves persisted sessions by backend conversation id before legacy harness id", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-backend-ref-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, [{
      sessionId: "backend-ref",
      harnessSessionId: "legacy-thread",
      backendRef: {
        kind: "claude-code",
        conversationId: "backend-thread",
      },
      name: "backend-ref",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
    }]);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    assert.equal(store.resolveHarnessSessionId("backend-ref"), "backend-thread");
    assert.equal(store.resolveHarnessSessionId("backend-thread"), "backend-thread");
    assert.equal(store.getPersistedSession("backend-thread")?.harnessSessionId, "legacy-thread");
    assert.equal(store.getPersistedSession("legacy-thread")?.sessionId, "backend-ref");
  });

  it("preserves shutdown kill reason when reloading persisted sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-shutdown-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, [{
      sessionId: "lWi_9aoa",
      harnessSessionId: "h-shutdown",
      name: "codex-morning-report-telegram-400",
      prompt: "p",
      workdir: "/tmp",
      status: "killed",
      lifecycle: "terminal",
      runtimeState: "stopped",
      killReason: "shutdown",
      completedAt: 200,
      costUsd: 0,
    }]);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    const persisted = store.getPersistedSession("lWi_9aoa");
    assert.equal(persisted?.killReason, "shutdown");
  });

  it("repairs degraded system routes from origin session metadata on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-route-repair-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, [{
      sessionId: "route-repair",
      harnessSessionId: "h-route-repair",
      name: "route-repair",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      originChannel: "telegram",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      route: {
        provider: "system",
        target: "system",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      },
    }]);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    const persisted = store.getPersistedSession("route-repair");
    assert.deepEqual(persisted?.route, {
      provider: "telegram",
      target: "-1003863755361",
      threadId: "13832",
      sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
    });
  });

  it("repairs persisted Telegram routes whose target drifted to a DM", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-telegram-dm-repair-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, [{
      sessionId: "telegram-dm-repair",
      harnessSessionId: "h-telegram-dm-repair",
      name: "telegram-dm-repair",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      originChannel: "telegram",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      route: {
        provider: "telegram",
        target: "5551234",
        threadId: "13832",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      },
    }]);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    const persisted = store.getPersistedSession("telegram-dm-repair");
    assert.deepEqual(persisted?.route, {
      provider: "telegram",
      accountId: undefined,
      target: "-1003863755361",
      threadId: "13832",
      sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
    });
  });

  it("normalizes legacy plan-context values to plan-mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-plan-context-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, [{
      sessionId: "plan-context",
      harnessSessionId: "h-plan-context",
      name: "plan-context",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      planApprovalContext: "soft-plan",
      costUsd: 0,
    }]);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    const persisted = store.getPersistedSession("plan-context");
    assert.equal(persisted?.planApprovalContext, "plan-mode");
  });

  it("normalizes legacy Codex on-request approval policy to never", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-codex-approval-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, [{
      sessionId: "codex-approval",
      harnessSessionId: "h-codex-approval",
      name: "codex-approval",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      codexApprovalPolicy: "on-request",
      costUsd: 0,
    }]);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    const persisted = store.getPersistedSession("codex-approval");
    assert.equal(persisted?.codexApprovalPolicy, "never");
  });

  it("preserves persisted waiting lifecycles across reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-waiting-lifecycle-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, [
      {
        sessionId: "awaiting-plan",
        harnessSessionId: "h-awaiting-plan",
        name: "awaiting-plan",
        prompt: "p",
        workdir: "/tmp",
        status: "completed",
        lifecycle: "awaiting_plan_decision",
        pendingPlanApproval: true,
        planApprovalContext: "codex-first-turn-plan",
        costUsd: 0,
      },
      {
        sessionId: "awaiting-input",
        harnessSessionId: "h-awaiting-input",
        name: "awaiting-input",
        prompt: "p",
        workdir: "/tmp",
        status: "completed",
        lifecycle: "awaiting_user_input",
        costUsd: 0,
      },
      {
        sessionId: "awaiting-worktree",
        harnessSessionId: "h-awaiting-worktree",
        name: "awaiting-worktree",
        prompt: "p",
        workdir: "/tmp",
        status: "completed",
        lifecycle: "awaiting_worktree_decision",
        worktreeState: "pending_decision",
        worktreePath: "/tmp/repo/.worktrees/awaiting-worktree",
        worktreeBranch: "agent/awaiting-worktree",
        costUsd: 0,
      },
    ]);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    assert.equal(store.getPersistedSession("awaiting-plan")?.lifecycle, "awaiting_plan_decision");
    assert.equal(store.getPersistedSession("awaiting-plan")?.planApprovalContext, "plan-mode");
    assert.equal(store.getPersistedSession("awaiting-input")?.lifecycle, "awaiting_user_input");
    assert.equal(store.getPersistedSession("awaiting-worktree")?.lifecycle, "awaiting_worktree_decision");
    assert.equal(store.getPersistedSession("awaiting-worktree")?.worktreeState, "pending_decision");
  });

  it("archives legacy array stores and starts fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-legacy-"));
    const indexPath = join(dir, "sessions.json");
    writeFileSync(indexPath, JSON.stringify([{
      sessionId: "legacy-session",
      harnessSessionId: "h-legacy",
      name: "legacy",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
    }]), "utf-8");

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    assert.equal(store.listPersistedSessions().length, 0);

    const saved = JSON.parse(readFileSync(indexPath, "utf-8"));
    assert.equal(saved.schemaVersion, STORE_SCHEMA_VERSION);
    assert.deepEqual(saved.sessions, []);
    assert.deepEqual(saved.actionTokens, []);

    const archived = readdirSync(dir).filter((name) => name.startsWith("sessions.json.legacy-"));
    assert.equal(archived.length, 1);
  });

  it("archives legacy Codex SDK session rows and keeps only App Server-backed sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-codex-upgrade-"));
    const indexPath = join(dir, "sessions.json");
    writeStore(indexPath, [
      {
        sessionId: "legacy-codex",
        harnessSessionId: "h-legacy-codex",
        name: "legacy-codex",
        prompt: "p",
        workdir: "/tmp",
        status: "completed",
        costUsd: 0,
        harness: "codex",
      },
      {
        sessionId: "current-codex",
        harnessSessionId: "h-current-codex",
        backendRef: {
          kind: "codex-app-server",
          conversationId: "h-current-codex",
        },
        name: "current-codex",
        prompt: "p",
        workdir: "/tmp",
        status: "completed",
        lifecycle: "terminal",
        runtimeState: "stopped",
        costUsd: 0,
        harness: "codex",
      },
    ]);

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    assert.equal(store.getPersistedSession("legacy-codex"), undefined);
    assert.equal(store.getPersistedSession("current-codex")?.backendRef?.kind, "codex-app-server");

    const archivedLegacyFiles = readdirSync(dir).filter((name) => name.includes(".codex-sdk-legacy-"));
    assert.equal(archivedLegacyFiles.length, 1);
    const archivedPayload = JSON.parse(readFileSync(join(dir, archivedLegacyFiles[0]), "utf-8"));
    assert.equal(Array.isArray(archivedPayload), true);
    assert.equal(archivedPayload[0].harnessSessionId, "h-legacy-codex");
  });

  it("archives current-schema stores whose sessions are missing route metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-legacy-route-"));
    const indexPath = join(dir, "sessions.json");
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION,
      sessions: [{
      sessionId: "legacy-route",
      harnessSessionId: "h-legacy-route",
      name: "legacy-route",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      }],
      actionTokens: [],
    }), "utf-8");

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    assert.equal(store.listPersistedSessions().length, 0);
    const archived = readdirSync(dir).filter((name) => name.startsWith("sessions.json.legacy-"));
    assert.equal(archived.length, 1);
  });

  it("archives current-schema stores whose worktree sessions are missing worktreeBranch metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-legacy-branch-"));
    const indexPath = join(dir, "sessions.json");
    writeFileSync(indexPath, JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION,
      sessions: [{
      sessionId: "legacy-branch",
      harnessSessionId: "h-legacy-branch",
      name: "legacy-branch",
      prompt: "p",
      workdir: "/tmp/repo",
      status: "completed",
      costUsd: 0,
      route: DEFAULT_ROUTE,
      worktreePath: "/tmp/repo/.worktrees/legacy-branch",
      }],
      actionTokens: [],
    }), "utf-8");

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    assert.equal(store.listPersistedSessions().length, 0);
    const archived = readdirSync(dir).filter((name) => name.startsWith("sessions.json.legacy-"));
    assert.equal(archived.length, 1);
  });
});

// =========================================================================
// New worktree fields persistence
// =========================================================================

describe("SessionStore new worktree lifecycle fields", () => {
  let indexPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-test-"));
    indexPath = join(tmpDir, "sessions.json");
  });

  it("persists and reloads 'delegate' worktree strategy", () => {
    writeStore(indexPath, [{
      harnessSessionId: "h-delegate",
      name: "delegate-session",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      worktreeStrategy: "delegate",
    }]);

    const store = new SessionStore({ indexPath, env: {} });
    const persisted = store.getPersistedSession("h-delegate");
    assert.equal(persisted?.worktreeStrategy, "delegate");
  });

  it("persists and reloads worktreeBaseBranch", () => {
    writeStore(indexPath, [{
      harnessSessionId: "h-base",
      name: "base-session",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      worktreeBaseBranch: "develop",
    }]);

    const store = new SessionStore({ indexPath, env: {} });
    const persisted = store.getPersistedSession("h-base");
    assert.equal(persisted?.worktreeBaseBranch, "develop");
  });

  it("persists and reloads pendingWorktreeDecisionSince", () => {
    const ts = new Date().toISOString();
    writeStore(indexPath, [{
      harnessSessionId: "h-pending",
      name: "pending-session",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
      costUsd: 0,
      pendingWorktreeDecisionSince: ts,
    }]);

    const store = new SessionStore({ indexPath, env: {} });
    const persisted = store.getPersistedSession("h-pending");
    assert.equal(persisted?.pendingWorktreeDecisionSince, ts);
    assert.equal(persisted?.worktreeLifecycle?.state, "pending_decision");
  });

  it("persists and reloads planApproval", () => {
    writeStore(indexPath, [{
      harnessSessionId: "h-plan-approval",
      name: "plan-approval-session",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      planApproval: "approve",
    }]);

    const store = new SessionStore({ indexPath, env: {} });
    const persisted = store.getPersistedSession("h-plan-approval");
    assert.equal(persisted?.planApproval, "approve");
  });

  it("persists and reloads deterministic approval/execution context separately from effective mode", () => {
    writeStore(indexPath, [{
      harnessSessionId: "h-approval-state",
      name: "approval-state-session",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      requestedPermissionMode: "plan",
      currentPermissionMode: "bypassPermissions",
      approvalExecutionState: "approved_then_implemented",
      planModeApproved: true,
    }]);

    const store = new SessionStore({ indexPath, env: {} });
    const persisted = store.getPersistedSession("h-approval-state");
    assert.equal(persisted?.requestedPermissionMode, "plan");
    assert.equal(persisted?.currentPermissionMode, "bypassPermissions");
    assert.equal(persisted?.approvalExecutionState, "approved_then_implemented");
    assert.equal(persisted?.planModeApproved, true);
  });

  it("persists and reloads worktreeDisposition", () => {
    writeStore(indexPath, [{
      harnessSessionId: "h-disp",
      name: "disp-session",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      worktreeDisposition: "pr-opened",
    }]);

    const store = new SessionStore({ indexPath, env: {} });
    const persisted = store.getPersistedSession("h-disp");
    assert.equal(persisted?.worktreeDisposition, "pr-opened");
    assert.equal(persisted?.worktreeLifecycle?.state, "pr_open");
  });

  it("normalizes persisted worktreeLifecycle objects", () => {
    const updatedAt = new Date().toISOString();
    writeStore(indexPath, [{
      harnessSessionId: "h-lifecycle",
      name: "lifecycle-session",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      worktreeLifecycle: {
        state: "released",
        updatedAt,
        resolvedAt: updatedAt,
        resolutionSource: "lifecycle_resolver",
        baseBranch: "main",
      },
    }]);

    const store = new SessionStore({ indexPath, env: {} });
    const persisted = store.getPersistedSession("h-lifecycle");
    assert.equal(persisted?.worktreeLifecycle?.state, "released");
    assert.equal(persisted?.worktreeLifecycle?.resolutionSource, "lifecycle_resolver");
    assert.equal(persisted?.worktreeLifecycle?.baseBranch, "main");
  });

  it("normalizes unknown worktreeDisposition to undefined", () => {
    writeStore(indexPath, [{
      harnessSessionId: "h-bad-disp",
      name: "bad-disp-session",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      lifecycle: "terminal",
      costUsd: 0,
      worktreeDisposition: "unknown-value",
    }]);

    const store = new SessionStore({ indexPath, env: {} });
    const persisted = store.getPersistedSession("h-bad-disp");
    assert.equal(persisted?.worktreeDisposition, undefined);
  });
});
