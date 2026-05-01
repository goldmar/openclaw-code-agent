import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PersistedSessionInfo } from "../src/types";
import { SessionStateSyncService } from "../src/session-state-sync-service";

const ROUTE = {
  provider: "telegram",
  accountId: "bot",
  target: "12345",
  threadId: "42",
  sessionKey: "agent:main:telegram:group:12345:topic:42",
};

describe("SessionStateSyncService", () => {
  it("applies persisted patches to both stored and live sessions", () => {
    const persisted = new Map<string, PersistedSessionInfo>();
    const entry: PersistedSessionInfo = {
      harnessSessionId: "h-session",
      sessionId: "session-1",
      name: "session-1",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      route: ROUTE,
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
      worktreePath: "/tmp/.worktrees/session-1",
      worktreeBranch: "agent/session-1",
    };
    persisted.set(entry.harnessSessionId, entry);

    let saveCount = 0;
    const liveSession = {
      id: "session-1",
      harnessSessionId: "h-session",
      name: "session-1",
      applyControlPatch(patch: Record<string, unknown>) {
        Object.assign(this, patch);
      },
      worktreePath: entry.worktreePath,
      worktreeBranch: entry.worktreeBranch,
      worktreePrUrl: undefined,
      worktreePrNumber: undefined,
      worktreeMerged: undefined,
      worktreeMergedAt: undefined,
      worktreeDisposition: undefined,
      worktreePrTargetRepo: undefined,
      worktreePushRemote: undefined,
      autoMergeParentSessionId: "parent-session",
      autoMergeConflictResolutionAttemptCount: 1,
      autoMergeResolverSessionId: "resolver-session",
    } as any;

    const sessions = new Map<string, any>([[liveSession.id, liveSession]]);
    const service = new SessionStateSyncService({
      store: {
        getPersistedSession: (ref: string) => persisted.get(ref) ?? persisted.get("h-session"),
        assertPersistedEntry: () => {},
        saveIndex: () => { saveCount++; },
      } as any,
      sessions,
      resolveSession: (ref: string) => sessions.get(ref),
    });

    const updated = service.applySessionPatch("h-session", {
      lifecycle: "terminal",
      worktreeState: "merged",
      worktreeMerged: true,
      worktreeMergedAt: "2026-03-26T12:00:00.000Z",
      worktreePrUrl: "https://github.com/openclaw/openclaw/pull/1",
      worktreePath: undefined,
      worktreeBranch: undefined,
    });

    assert.equal(updated, true);
    assert.equal(saveCount, 1);
    assert.equal(entry.lifecycle, "terminal");
    assert.equal(entry.worktreeState, "merged");
    assert.equal(entry.worktreeMerged, true);
    assert.equal(liveSession.lifecycle, "terminal");
    assert.equal(liveSession.worktreeState, "merged");
    assert.equal(liveSession.worktreeMerged, true);
    assert.equal(liveSession.worktreePrUrl, "https://github.com/openclaw/openclaw/pull/1");
    assert.equal(liveSession.worktreePath, "/tmp/.worktrees/session-1");
    assert.equal(liveSession.worktreeBranch, "agent/session-1");
  });

  it("applies explicit undefined clears for auto-merge sync fields onto the live session", () => {
    const liveSession = {
      id: "session-1",
      harnessSessionId: "h-session",
      name: "session-1",
      autoMergeParentSessionId: "parent-session",
      autoMergeConflictResolutionAttemptCount: 1,
      autoMergeResolverSessionId: "resolver-session",
    } as any;

    const service = new SessionStateSyncService({
      store: {
        getPersistedSession: () => undefined,
        assertPersistedEntry: () => {},
        saveIndex: () => {},
      } as any,
      sessions: new Map(),
      resolveSession: () => liveSession,
    });

    const updated = service.applySessionPatch("session-1", {
      autoMergeParentSessionId: undefined,
      autoMergeConflictResolutionAttemptCount: undefined,
      autoMergeResolverSessionId: undefined,
    });

    assert.equal(updated, true);
    assert.equal(liveSession.autoMergeParentSessionId, undefined);
    assert.equal(liveSession.autoMergeConflictResolutionAttemptCount, undefined);
    assert.equal(liveSession.autoMergeResolverSessionId, undefined);
  });

  it("uses a public control-field setter in the legacy control sync fallback", () => {
    const controlFields: Array<{ key: string; value: unknown }> = [];
    const liveSession = {
      id: "session-1",
      harnessSessionId: "h-session",
      name: "session-1",
      setControlField(key: string, value: unknown) {
        controlFields.push({ key, value });
        Object.assign(this, { [key]: value });
      },
    } as any;

    const service = new SessionStateSyncService({
      store: {
        getPersistedSession: () => undefined,
        assertPersistedEntry: () => {},
        saveIndex: () => {},
      } as any,
      sessions: new Map(),
      resolveSession: () => liveSession,
    });

    const updated = service.applySessionPatch("session-1", {
      planModeApproved: true,
    });

    assert.equal(updated, true);
    assert.deepEqual(controlFields, [{ key: "planModeApproved", value: true }]);
    assert.equal(liveSession.planModeApproved, true);
  });

  it("applies grouped control, session, and worktree metadata patches consistently", () => {
    const controlPatches: Array<Record<string, unknown>> = [];
    const liveSession = {
      id: "session-2",
      harnessSessionId: "h-session-2",
      name: "session-2",
      lifecycle: "active",
      approvalRationale: undefined,
      pendingWorktreeDecisionSince: undefined,
      worktreePrTargetRepo: undefined,
      worktreePushRemote: undefined,
      worktreeLifecycle: undefined,
      applyControlPatch(patch: Record<string, unknown>) {
        controlPatches.push(patch);
        Object.assign(this, patch);
      },
    } as any;

    const service = new SessionStateSyncService({
      store: {
        getPersistedSession: () => undefined,
        assertPersistedEntry: () => {},
        saveIndex: () => {},
      } as any,
      sessions: new Map(),
      resolveSession: () => liveSession,
    });

    const updated = service.applySessionPatch("session-2", {
      lifecycle: "awaiting_worktree_decision",
      approvalState: "approved",
      approvalExecutionState: "approved_then_implemented",
      requestedPermissionMode: "plan",
      currentPermissionMode: "bypassPermissions",
      pendingPlanApproval: false,
      planModeApproved: true,
      pendingWorktreeDecisionSince: "2026-04-10T12:00:00.000Z",
      approvalRationale: "needs release review",
      worktreePrTargetRepo: "openai/codex",
      worktreePushRemote: "origin",
      worktreeLifecycle: {
        state: "pending_decision",
        updatedAt: "2026-04-10T12:00:00.000Z",
        baseBranch: "main",
      },
    });

    assert.equal(updated, true);
    assert.equal(controlPatches.length, 1);
    assert.equal(controlPatches[0].lifecycle, "awaiting_worktree_decision");
    assert.equal(controlPatches[0].approvalState, "approved");
    assert.equal(controlPatches[0].approvalExecutionState, "approved_then_implemented");
    assert.equal(controlPatches[0].requestedPermissionMode, "plan");
    assert.equal(controlPatches[0].currentPermissionMode, "bypassPermissions");
    assert.equal(controlPatches[0].pendingPlanApproval, false);
    assert.equal(controlPatches[0].planModeApproved, true);
    assert.equal(controlPatches[0].pendingWorktreeDecisionSince, "2026-04-10T12:00:00.000Z");
    assert.equal(liveSession.approvalRationale, "needs release review");
    assert.equal(liveSession.worktreePrTargetRepo, "openai/codex");
    assert.equal(liveSession.worktreePushRemote, "origin");
    assert.deepEqual(liveSession.worktreeLifecycle, {
      state: "pending_decision",
      updatedAt: "2026-04-10T12:00:00.000Z",
      baseBranch: "main",
    });
  });
});
