import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionWorktreeMessageService } from "../src/session-worktree-message-service";
import { SessionWorktreeStrategyService } from "../src/session-worktree-strategy-service";
import { createWorktree, getBranchName, getDiffSummary } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createConflictedWorktree(name: string): {
  repoDir: string;
  worktreePath: string;
  branchName: string;
} {
  const repoDir = mkdtempSync(join(tmpdir(), `openclaw-auto-merge-${name}-`));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");

  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");

  writeFileSync(join(worktreePath, "README.md"), "feature\n", "utf-8");
  git(worktreePath, "add", "README.md");
  git(worktreePath, "commit", "-m", "feature change");

  writeFileSync(join(repoDir, "README.md"), "main\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "main change");

  return { repoDir, worktreePath, branchName };
}

describe("SessionWorktreeStrategyService auto-merge conflict flow", () => {
  it("spawns a resolver session and marks the worktree as conflict-resolving on first rebase conflict", async () => {
    const { repoDir, worktreePath, branchName } = createConflictedWorktree("resolver-first");
    try {
      const patches: Array<Record<string, unknown>> = [];
      const notifications: Array<Record<string, unknown>> = [];
      const spawnCalls: Array<Record<string, unknown>> = [];
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "has-commits",
        updatePersistedSession: (_ref, patch) => {
          patches.push(patch as Record<string, unknown>);
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request as Record<string, unknown>);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => undefined,
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        spawnConflictResolver: async (args) => {
          spawnCalls.push(args as unknown as Record<string, unknown>);
          return { id: "resolver-1", name: "resolver-first-conflict-resolver" };
        },
        runAutoPr: async () => ({ success: true }),
      });

      const session: any = {
        id: "s-resolver-first",
        name: "resolver-first",
        harnessSessionId: "h-resolver-first",
        worktreePrTargetRepo: undefined,
        worktreePushRemote: undefined,
      };

      const diffSummary = getDiffSummary(repoDir, branchName, "main");
      assert.ok(diffSummary, "diff summary should be available");

      await (service as any).handleAutoMergeStrategy(
        session,
        repoDir,
        worktreePath,
        branchName,
        "main",
        diffSummary,
        session.id,
      );

      assert.equal(spawnCalls.length, 1);
      assert.equal(session.autoMergeConflictResolutionAttemptCount, 1);
      assert.equal(session.autoMergeResolverSessionId, "resolver-1");
      assert.equal(session.worktreeState, "merge_conflict_resolving");
      assert.equal(session.worktreeLifecycle?.state, "merge_conflict_resolving");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-merge-conflict-resolving");
      assert.match(String(notifications[0].userMessage), /will retry automatically if it succeeds/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("escalates after the retry budget is exhausted instead of spawning another resolver", async () => {
    const { repoDir, worktreePath, branchName } = createConflictedWorktree("resolver-exhausted");
    try {
      const notifications: Array<Record<string, unknown>> = [];
      let spawnCalled = false;
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "has-commits",
        updatePersistedSession: (_ref, patch) => {
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request as Record<string, unknown>);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => undefined,
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        spawnConflictResolver: async () => {
          spawnCalled = true;
          return { id: "resolver-2", name: "resolver-exhausted-conflict-resolver" };
        },
        runAutoPr: async () => ({ success: true }),
      });

      const session: any = {
        id: "s-resolver-exhausted",
        name: "resolver-exhausted",
        harnessSessionId: "h-resolver-exhausted",
        autoMergeConflictResolutionAttemptCount: 1,
        worktreePrTargetRepo: undefined,
        worktreePushRemote: undefined,
      };

      const diffSummary = getDiffSummary(repoDir, branchName, "main");
      assert.ok(diffSummary, "diff summary should be available");

      await (service as any).handleAutoMergeStrategy(
        session,
        repoDir,
        worktreePath,
        branchName,
        "main",
        diffSummary,
        session.id,
      );

      assert.equal(spawnCalled, false);
      assert.equal(session.worktreeState, "pending_decision");
      assert.equal(session.worktreeLifecycle?.state, "pending_decision");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-merge-conflict-escalated");
      assert.ok(Array.isArray(notifications[0].buttons));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("resets conflict-resolving sessions to pending decision when the retry fails with a non-rebase error", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true,
      isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: (dir) => dir,
      getWorktreeCompletionState: () => "has-commits",
      updatePersistedSession: (_ref, patch) => {
        Object.assign(session, patch);
        return true;
      },
      dispatchSessionNotification: (_session, request) => {
        notifications.push(request as Record<string, unknown>);
      },
      getOutputPreview: () => "",
      originThreadLine: () => "thread",
      getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranchFn: () => ({ success: false, error: "ff-only merge failed" }),
      spawnConflictResolver: async () => ({ id: "resolver-3", name: "unused" }),
      runAutoPr: async () => ({ success: true }),
    });

    const session: any = {
      id: "s-resolver-retry-failure",
      name: "resolver-retry-failure",
      harnessSessionId: "h-resolver-retry-failure",
      worktreeState: "merge_conflict_resolving",
      worktreeLifecycle: {
        state: "merge_conflict_resolving",
        updatedAt: new Date().toISOString(),
        baseBranch: "main",
      },
      worktreePrTargetRepo: undefined,
      worktreePushRemote: undefined,
    };

    await (service as any).handleAutoMergeStrategy(
      session,
      "/tmp/repo",
      "/tmp/worktree",
      "agent/retry-failure",
      "main",
      {
        commits: 1,
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
        changedFiles: ["README.md"],
        commitMessages: [],
      },
      session.id,
    );

    assert.equal(session.worktreeState, "pending_decision");
    assert.equal(session.worktreeLifecycle?.state, "pending_decision");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].label, "worktree-merge-error");
    assert.match(String(notifications[0].userMessage), /auto-merge retry did not complete/i);
    assert.ok(Array.isArray(notifications[0].buttons));
  });
});
