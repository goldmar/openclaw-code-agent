import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionWorktreeMessageService } from "../src/session-worktree-message-service";
import { SessionWorktreeController } from "../src/session-worktree-controller";
import { SessionWorktreeStrategyService } from "../src/session-worktree-strategy-service";
import { createWorktree, getBranchName, getDiffSummary, mergeBranch } from "../src/worktree";

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

function createMergeableWorktree(name: string): {
  repoDir: string;
  worktreePath: string;
  branchName: string;
} {
  const repoDir = mkdtempSync(join(tmpdir(), `openclaw-auto-merge-success-${name}-`));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");

  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");

  writeFileSync(join(worktreePath, "feature.txt"), "feature\n", "utf-8");
  git(worktreePath, "add", "feature.txt");
  git(worktreePath, "commit", "-m", "feature change");

  return { repoDir, worktreePath, branchName };
}

describe("SessionWorktreeStrategyService auto-merge conflict flow", () => {
  it("keys generic worktree notifications by terminal cycle and worktree identity", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true,
      isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: () => undefined,
      getWorktreeCompletionState: () => {
        throw new Error("missing repo notifications should not inspect completion state");
      },
      updatePersistedSession: () => true,
      dispatchSessionNotification: (_session, request) => {
        notifications.push(request as Record<string, unknown>);
      },
      getOutputPreview: () => "",
      originThreadLine: () => "thread",
      getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch,
      spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
      runAutoPr: async () => ({ success: true }),
    });

    await service.handleWorktreeStrategy({
      id: "s-worktree-generic",
      name: "generic-worktree",
      status: "completed",
      phase: "implementing",
      lifecycle: "active",
      worktreeState: "active",
      worktreePath: "/tmp/repo/.worktrees/generic",
      worktreeBranch: "agent/generic",
      worktreeStrategy: "ask",
      completedAt: 1700000004000,
      originalWorkdir: "/tmp/repo",
      harnessSessionId: "h-worktree-generic",
      getOutput: () => [],
    } as any);

    assert.equal(notifications.length, 1);
    assert.equal(
      notifications[0]?.idempotencyKey,
      "worktree-action:s-worktree-generic:worktree-missing-repo-dir:1700000004000:agent/generic:/tmp/repo/.worktrees/generic",
    );
  });

  it("does not re-emit an ask-mode worktree prompt after the worktree is PR-open", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true,
      isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: () => {
        throw new Error("PR-open worktrees should be resolved before repo planning");
      },
      getWorktreeCompletionState: () => {
        throw new Error("PR-open worktrees should not be inspected for a new decision");
      },
      updatePersistedSession: () => true,
      dispatchSessionNotification: (_session, request) => {
        notifications.push(request as Record<string, unknown>);
      },
      getOutputPreview: () => "",
      originThreadLine: () => "thread",
      getWorktreeDecisionButtons: () => [[{ label: "Update PR", callbackData: "update-pr" }]],
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch,
      spawnConflictResolver: async () => ({ id: "resolver-pr-open", name: "unused" }),
      runAutoPr: async () => ({ success: true }),
    });

    const session: any = {
      id: "s-pr-open",
      name: "pr-open",
      status: "completed",
      phase: "implementing",
      lifecycle: "awaiting_worktree_decision",
      worktreeState: "pending_decision",
      worktreeLifecycle: {
        state: "pr_open",
        updatedAt: "2026-06-03T12:00:00.000Z",
        resolutionSource: "agent_pr",
      },
      pendingWorktreeDecisionSince: "2026-06-03T11:55:00.000Z",
      originalWorkdir: "/tmp/repo",
      worktreePath: "/tmp/repo/.worktrees/pr-open",
      worktreeBranch: "agent/pr-open",
      worktreeStrategy: "ask",
      pendingPlanApproval: false,
    };

    const result = await service.handleWorktreeStrategy(session);

    assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
    assert.equal(notifications.length, 0);
  });

  it("runs auto-pr follow-through for completed PR-open worktree follow-up sessions", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("pr-open-auto");
    const notifications: Array<Record<string, unknown>> = [];
    let autoPrCalled = false;
    try {
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
        getWorktreeDecisionButtons: () => [[{ label: "Update PR", callbackData: "update-pr" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-pr-open-auto", name: "unused" }),
        runAutoPr: async (_session, baseBranch) => {
          autoPrCalled = true;
          assert.equal(baseBranch, "main");
          return { success: true };
        },
      });

      const session: any = {
        id: "s-pr-open-auto",
        name: "pr-open-auto",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "pr_open",
        worktreeLifecycle: {
          state: "pr_open",
          updatedAt: "2026-06-03T12:00:00.000Z",
          resolutionSource: "agent_pr",
        },
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(autoPrCalled, true);
      assert.equal(notifications.length, 0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("releases an auto-pr worktree when the current PR head already contains its branch", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-auto-pr-existing-head-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      git(repoDir, "checkout", "-b", "agent/fix-oca-441-regression");
      writeFileSync(join(repoDir, "README.md"), "release prep\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "Fix OCA 4.4.1 session lifecycle regression");

      const worktreePath = createWorktree(repoDir, "address-pr-194-comments");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      assert.equal(branchName, "agent/address-pr-194-comments");

      writeFileSync(join(repoDir, "release.txt"), "4.4.2\n", "utf-8");
      git(repoDir, "add", "release.txt");
      git(repoDir, "commit", "-m", "Prepare release 4.4.2");
      writeFileSync(join(repoDir, "review.txt"), "addressed\n", "utf-8");
      git(repoDir, "add", "review.txt");
      git(repoDir, "commit", "-m", "Address PR 194 review feedback");

      assert.equal(git(repoDir, "rev-list", "--count", `main..${branchName}`), "1");
      assert.equal(git(repoDir, "rev-list", "--count", `${branchName}..agent/fix-oca-441-regression`), "2");
      git(repoDir, "merge-base", "--is-ancestor", branchName, "agent/fix-oca-441-regression");

      const notifications: Array<Record<string, unknown>> = [];
      let autoPrCalled = false;
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: (repo, worktree, branch, base) => (
          new SessionWorktreeController().getCompletionState(repo, worktree, branch, base)
        ),
        updatePersistedSession: (_ref, patch) => {
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request as Record<string, unknown>);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => [[{ label: "Open PR", callbackData: "open-pr" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-existing-head", name: "unused" }),
        runAutoPr: async (_session, baseBranch) => {
          autoPrCalled = true;
          assert.equal(baseBranch, "main");
          return { success: false };
        },
      });

      const session: any = {
        id: "s-address-pr-194-comments",
        name: "address-pr-194-comments",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "provisioned",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: true });
      assert.equal(autoPrCalled, true);
      assert.equal(notifications.length, 0);
      assert.equal(session.worktreePath, undefined);
      assert.equal(session.worktreeState, "released");
      assert.equal(session.worktreeLifecycle?.state, "released");
      assert.deepEqual(session.worktreeLifecycle?.notes, ["released_by_branch:agent/fix-oca-441-regression"]);
      assert.throws(() => git(repoDir, "rev-parse", "--verify", branchName));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("requests a routed follow-up summary after auto-merge succeeds", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("summary-success");
    try {
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
        originThreadLine: () => "Session origin route (authoritative for human follow-ups):\noriginRoute: {\"provider\":\"telegram\",\"target\":\"-100123\",\"threadId\":\"32947\"}",
        getWorktreeDecisionButtons: () => undefined,
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-success", name: "unused" }),
        runAutoPr: async () => ({ success: true }),
      });

      const session: any = {
        id: "s-summary-success",
        name: "summary-success",
        harnessSessionId: "h-summary-success",
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

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-merge-success");
      assert.equal(notifications[0].completionWakeSummaryRequired, true);
      assert.equal(notifications[0].deferConditionalWakeUntilNextTick, true);
      assert.match(String(notifications[0].wakeMessageOnNotifySuccess), /agent_output\(session='s-summary-success', full=true\)/);
      assert.match(String(notifications[0].wakeMessageOnNotifySuccess), /originRoute: \{"provider":"telegram","target":"-100123","threadId":"32947"\}/);
      assert.equal(session.worktreeState, "merged");
      assert.equal(session.worktreeLifecycle?.state, "merged");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("marks 0-ahead ancestry-merged auto-merge worktrees as merged instead of suspicious base advancement", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("already-merged");
    const notifications: Array<Record<string, unknown>> = [];
    const controller = new SessionWorktreeController();
    try {
      git(repoDir, "merge", "--no-ff", branchName, "-m", "merge already-merged");
      assert.equal(git(repoDir, "rev-list", "--count", `main..${branchName}`), "0");
      assert.equal(git(repoDir, "rev-list", "--count", `${branchName}..main`), "1");
      git(repoDir, "merge-base", "--is-ancestor", branchName, "main");

      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: (repo, worktree, branch, base) => (
          controller.getCompletionState(repo, worktree, branch, base)
        ),
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
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => ({ success: true }),
      });

      const session: any = {
        id: "s-already-merged",
        name: "already-merged",
        harnessSessionId: "h-already-merged",
        status: "completed",
        phase: "implementing",
        lifecycle: "active",
        worktreeState: "provisioned",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-merge",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: true });
      assert.throws(() => git(repoDir, "rev-parse", "--verify", branchName));
      assert.equal(notifications.length, 0);
      assert.equal(session.lifecycle, "terminal");
      assert.equal(session.worktreeState, "merged");
      assert.equal(session.worktreeMerged, true);
      assert.equal(session.worktreeLifecycle?.state, "merged");
      assert.equal(session.worktreeLifecycle?.resolutionSource, "agent_merge");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("includes stash-pop-conflict warnings in the auto-merge follow-up wake", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-auto-merge-stash-conflict-"));
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Test User");
    git(repoDir, "config", "user.email", "test@example.com");
    writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "init");
    git(repoDir, "branch", "agent/stash-conflict");
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
      originThreadLine: () => "",
      getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch: () => ({
        success: true,
        fastForward: true,
        stashPopConflict: true,
        stashRef: "stash@{2}",
      }),
      spawnConflictResolver: async () => ({ id: "resolver-stash", name: "unused" }),
      runAutoPr: async () => ({ success: true }),
    });

    const session: any = {
      id: "s-stash-conflict",
      name: "stash-conflict",
      harnessSessionId: "h-stash-conflict",
      worktreePrTargetRepo: undefined,
      worktreePushRemote: undefined,
    };
    const diffSummary = {
      commits: 1,
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
      changedFiles: ["feature.txt"],
      commitMessages: [],
    };

    try {
      await (service as any).handleAutoMergeStrategy(
        session,
        repoDir,
        join(repoDir, ".worktrees/stash-conflict"),
        "agent/stash-conflict",
        "main",
        diffSummary,
        session.id,
      );

      assert.equal(notifications.length, 1);
      assert.match(String(notifications[0].userMessage), /Pre-merge stash pop conflicted/);
      assert.match(String(notifications[0].wakeMessageOnNotifySuccess), /Pre-merge stash pop conflicted/);
      assert.match(String(notifications[0].wakeMessageOnNotifySuccess), /stash@\{2\}/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

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
        mergeBranch,
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
        mergeBranch,
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

  it("falls back to an explicit pending decision notification when auto-pr fails", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    const buttons = [{ text: "Create PR", callback_data: "pr" }];
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
      getWorktreeDecisionButtons: () => buttons as any,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch,
      spawnConflictResolver: async () => ({ id: "resolver-auto-pr", name: "unused" }),
      runAutoPr: async () => ({ success: false }),
    });

    const session: any = {
      id: "s-auto-pr-failure",
      name: "auto-pr-failure",
      harnessSessionId: "h-auto-pr-failure",
      worktreePrTargetRepo: undefined,
      worktreePushRemote: undefined,
    };

    const result = await (service as any).handleAutoPrStrategy(session, "/tmp/repo", "/tmp/worktree", "agent/auto-pr-failure", "main");

    assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
    assert.equal(session.worktreeState, "pending_decision");
    assert.equal(session.worktreeLifecycle?.state, "pending_decision");
    assert.equal(patches.some((patch) => patch.worktreeState === "pr_in_progress"), true);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].label, "worktree-auto-pr-failed");
    assert.match(String(notifications[0].userMessage), /Auto-PR did not complete/i);
    assert.equal(notifications[0].buttons, buttons);
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
      mergeBranch: () => ({ success: false, error: "ff-only merge failed" }),
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
