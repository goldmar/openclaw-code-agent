import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/session-manager";

const ROUTE = {
  provider: "telegram",
  accountId: "bot",
  target: "12345",
  threadId: "42",
  sessionKey: "agent:main:telegram:group:12345:topic:42",
};

function createSessionManager(): { sm: SessionManager; cleanup: () => void } {
  const storeDir = mkdtempSync(join(tmpdir(), "sm-auto-merge-resolver-"));
  const sm = new SessionManager(5, 50, {
    store: {
      env: {},
      indexPath: join(storeDir, "sessions.json"),
    },
  });
  return {
    sm,
    cleanup: () => rmSync(storeDir, { recursive: true, force: true }),
  };
}

describe("SessionManager auto-merge conflict resolver terminal handling", () => {
  it("retries the original auto-merge session when the resolver completes successfully", async () => {
    const { sm, cleanup } = createSessionManager();
    try {
      let retriedSession: unknown;
      (sm as any).persistSession = () => {};
      (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
      (sm as any).worktreeStrategy.handleWorktreeStrategy = async (session: unknown) => {
        retriedSession = session;
        assert.equal((session as any).autoMergeResolverSessionId, undefined);
        return { notificationSent: true, worktreeRemoved: false };
      };

      const parent: any = {
        id: "parent-session",
        name: "parent-session",
        status: "completed",
        worktreeBranch: "agent/parent-session",
        worktreePath: "/tmp/worktree",
        worktreeBaseBranch: "main",
        route: ROUTE,
        autoMergeResolverSessionId: "resolver-session",
      };
      (sm as any).sessions.set(parent.id, parent);

      await (sm as any).onSessionTerminal({
        id: "resolver-session",
        name: "parent-session-conflict-resolver",
        status: "completed",
        autoMergeParentSessionId: "parent-session",
      });

      assert.equal(retriedSession, parent);
      assert.equal(parent.autoMergeResolverSessionId, undefined);
    } finally {
      cleanup();
    }
  });

  it("preserves the branch and notifies the user when the resolver fails", async () => {
    const { sm, cleanup } = createSessionManager();
    try {
      const persistedPatches: Array<Record<string, unknown>> = [];
      const notifications: Array<Record<string, unknown>> = [];
      (sm as any).persistSession = () => {};
      (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
      (sm as any).notifications = {
        dispatch: (_session: unknown, request: Record<string, unknown>) => {
          notifications.push(request);
        },
        notifyWorktreeOutcome: () => {},
        dispose: () => {},
      };

      const parent: any = {
        id: "parent-session",
        name: "parent-session",
        status: "completed",
        worktreeBranch: "agent/parent-session",
        worktreePath: "/tmp/worktree",
        worktreeBaseBranch: "main",
        route: ROUTE,
      };
      (sm as any).sessions.set(parent.id, parent);

      (sm as any).updatePersistedSession = (_ref: string, patch: Record<string, unknown>) => {
        persistedPatches.push(patch);
        Object.assign(parent, patch);
        return true;
      };

      await (sm as any).onSessionTerminal({
        id: "resolver-session",
        name: "parent-session-conflict-resolver",
        status: "failed",
        autoMergeParentSessionId: "parent-session",
      });

      assert.equal(parent.worktreeState, "pending_decision");
      assert.equal(parent.worktreeLifecycle?.state, "pending_decision");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-merge-conflict-resolver-failed");
      assert.ok(Array.isArray(notifications[0].buttons));
      assert.equal(
        notifications[0].buttons[0][0].label,
        "Open PR",
      );
      assert.equal(persistedPatches.length, 1);
      assert.equal(persistedPatches[0].autoMergeResolverSessionId, undefined);
      assert.equal(persistedPatches[0].worktreeState, "pending_decision");
    } finally {
      cleanup();
    }
  });
});
