import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/session-manager";
import { createStubSession } from "./helpers";
import { reviewPendingReminder } from "./reviewed-reminder-fixture";
import { reviewedTaskFixture } from "./task-outcome-fixture";

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
    cleanup: () => { sm.dispose(); rmSync(storeDir, { recursive: true, force: true }); },
  };
}

function buttonLabels(buttons: unknown): string[] {
  assert.ok(Array.isArray(buttons));
  return buttons.flat().map((button: any) => button.label);
}

describe("SessionManager auto-merge conflict resolver terminal handling", () => {
  it("preserves both terminal notices and refuses a merge retry for an unreviewed resolver", async () => {
    const { sm, cleanup } = createSessionManager();
    try {
      const notifications: Array<Record<string, unknown>> = [];
      let retries = 0;
      (sm as any).persistSession = () => {};
      (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
      (sm as any).notifications = { dispatch: (_session: unknown, request: Record<string, unknown>) => { notifications.push(request); }, dispose: () => {} };
      (sm as any).worktreeStrategy.handleWorktreeStrategy = async () => { retries++; return { notificationSent: false, worktreeRemoved: false }; };
      const parent = reviewPendingReminder({ id: "parent-session", name: "parent-session", status: "completed",
        worktreePath: undefined as string | undefined, route: ROUTE, worktreeBranch: "agent/parent-session", autoMergeResolverSessionId: "resolver-session" });
      (sm as any).sessions.set(parent.id, parent);
      const resolver = createStubSession({ id: "resolver-session", name: "conflict-resolver", status: "completed",
        workdir: parent.worktreePath, autoMergeParentSessionId: parent.id });
      (sm as any).sessions.set(resolver.id, resolver);

      await (sm as any).onSessionTerminal(resolver);

      assert.equal(retries, 0);
      assert.equal(parent.autoMergeResolverSessionId, resolver.id);
      assert.deepEqual(notifications.map((notice) => notice.label), ["task-unverified", "worktree-resolver-unverified"]);
      assert.ok(notifications.every((notice) => !String(notice.userMessage).includes("✅")));
      assert.ok(notifications.every((notice) => !buttonLabels(notice.buttons ?? []).includes("Merge")));
    } finally { cleanup(); }
  });

  it("requires the parent evidence to be revalidated after a reviewed resolver", async () => {
    const { sm, cleanup } = createSessionManager();
    try {
      const notices: Array<Record<string, unknown>> = [];
      let retries = 0;
      (sm as any).persistSession = () => {};
      (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
      (sm as any).notifications = { dispatch: (_session: unknown, request: Record<string, unknown>) => { notices.push(request); }, dispose: () => {} };
      (sm as any).worktreeStrategy.handleWorktreeStrategy = async () => { retries++; return { notificationSent: false, worktreeRemoved: false }; };
      const parent = reviewPendingReminder({ id: "parent-session", name: "parent-session", status: "completed",
        worktreePath: undefined as string | undefined, route: ROUTE, worktreeBranch: "agent/parent-session" });
      const resolver = reviewedTaskFixture(createStubSession({ id: "resolver-session", name: "conflict-resolver",
        status: "completed", workdir: parent.worktreePath, autoMergeParentSessionId: parent.id }));
      delete (parent as { taskOutcome?: unknown }).taskOutcome;
      (sm as any).sessions.set(parent.id, parent);

      await (sm as any).handleAutoMergeResolverTerminal(resolver);

      assert.equal(retries, 0);
      assert.equal(notices[0]?.label, "worktree-parent-revalidation-required");
      assert.match(String(notices[0]?.userMessage), /Nothing was merged automatically/);
      assert.equal(notices[0]?.buttons, undefined);
    } finally { cleanup(); }
  });

  it("retries the original auto-merge session when the resolver completes successfully", async () => {
    const { sm, cleanup } = createSessionManager();
    try {
      let retriedSession: unknown;
      (sm as any).persistSession = () => {};
      (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
      (sm as any).worktreeStrategy.handleWorktreeStrategy = async (session: unknown, options?: unknown) => {
        retriedSession = session;
        // A reviewed resolver may retry only a parent whose evidence is current.
        assert.deepEqual(options, { retryAfterConflict: true });
        assert.equal((session as any).autoMergeResolverSessionId, undefined);
        return { notificationSent: true, worktreeRemoved: false };
      };

      const parent: any = {
        id: "parent-session",
        name: "parent-session",
        status: "completed",
        worktreeBranch: "agent/parent-session",
        worktreeBaseBranch: "main",
        route: ROUTE,
        autoMergeResolverSessionId: "resolver-session",
      };
      reviewPendingReminder(parent);
      (sm as any).sessions.set(parent.id, parent);

      const resolver = reviewedTaskFixture(createStubSession({
        id: "resolver-session",
        name: "parent-session-conflict-resolver",
        status: "completed",
        workdir: parent.worktreePath,
        autoMergeParentSessionId: "parent-session",
      }));
      await (sm as any).handleAutoMergeResolverTerminal(resolver);

      assert.equal(retriedSession, parent);
      assert.equal(parent.autoMergeResolverSessionId, undefined);
    } finally {
      cleanup();
    }
  });

  it("reports how the retry ended when the retry itself sent nothing", async () => {
    const cases: Array<{ stored: Record<string, unknown>; text: string }> = [
      { stored: { worktreeMerged: true }, text: "ℹ️ [parent-session] Already merged; nothing left to do." },
      {
        stored: { worktreePrUrl: "https://github.com/example/repo/pull/7" },
        text: "ℹ️ [parent-session] PR: https://github.com/example/repo/pull/7",
      },
      { stored: {}, text: "ℹ️ [parent-session] Nothing was merged automatically. The branch is kept; inspect the current integration state." },
    ];
    for (const testCase of cases) {
      const { sm, cleanup } = createSessionManager();
      try {
        const notifications: Array<Record<string, unknown>> = [];
        (sm as any).persistSession = () => {};
        (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
        (sm as any).notifications = {
          dispatch: (_session: unknown, request: Record<string, unknown>) => { notifications.push(request); },
          notifyWorktreeOutcome: () => {},
          dispose: () => {},
        };
        // Already merged in the queue, PR up to date, or skipped by the planner.
        (sm as any).worktreeStrategy.handleWorktreeStrategy = async () => ({ notificationSent: false, worktreeRemoved: false });
        const parent: any = {
          id: "parent-session",
          name: "parent-session",
          status: "completed",
          worktreeBranch: "agent/parent-session",
          route: ROUTE,
          autoMergeResolverSessionId: "resolver-session",
        };
        reviewPendingReminder(parent);
        (sm as any).sessions.set(parent.id, parent);
        (sm as any).updatePersistedSession = () => true;
        (sm as any).getPersistedSession = () => ({ name: "parent-session", ...testCase.stored });

        const resolver = reviewedTaskFixture(createStubSession({
          id: "resolver-session",
          name: "parent-session-conflict-resolver",
          status: "completed",
          workdir: parent.worktreePath,
          autoMergeParentSessionId: "parent-session",
        }));
        await (sm as any).handleAutoMergeResolverTerminal(resolver);

        // The user was told the merge is retried automatically: one closing line, no `✅`.
        assert.deepEqual(notifications.map((request) => request.userMessage), [testCase.text]);
        assert.equal(notifications[0]!.notifyUser, "always");
      } finally {
        cleanup();
      }
    }
  });

  it("preserves the branch and shows policy-aware buttons when the resolver fails", async () => {
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
        worktreeBaseBranch: "main",
        repoIntegrationPolicy: "never-pr",
        route: ROUTE,
      };
      reviewPendingReminder(parent);
      (sm as any).sessions.set(parent.id, parent);

      (sm as any).updatePersistedSession = (_ref: string, patch: Record<string, unknown>) => {
        persistedPatches.push(patch);
        Object.assign(parent, patch);
        return true;
      };

      const resolver = createStubSession({
        id: "resolver-session",
        name: "parent-session-conflict-resolver",
        status: "failed",
        autoMergeParentSessionId: "parent-session",
        getOutput: (): string[] => ["Conflict resolution failed; the branch remains preserved."],
      });
      (sm as any).sessions.set(resolver.id, resolver);
      await (sm as any).onSessionTerminal(resolver);

      assert.equal(parent.worktreeState, "pending_decision");
      assert.equal(parent.worktreeLifecycle?.state, "pending_decision");
      assert.equal(notifications.length, 2, "the resolver failure and parent integration notice are both required");
      assert.equal(notifications[0].label, "failed");
      assert.match(String(notifications[0].userMessage), /^❌/);
      assert.equal(notifications[1].label, "worktree-merge-conflict-resolver-failed");
      const labels = buttonLabels(notifications[1].buttons);
      assert.ok(!labels.includes("Open PR"), "expected no Open PR button for never-pr policy");
      assert.ok(labels.includes("Merge"), "expected Merge button for never-pr policy");
      assert.equal(persistedPatches.length, 1);
      assert.equal(persistedPatches[0].autoMergeResolverSessionId, undefined);
      assert.equal(persistedPatches[0].worktreeState, "pending_decision");
    } finally {
      cleanup();
    }
  });
});
