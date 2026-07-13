import { describe, it, mock } from "node:test";
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

function buttonLabels(buttons: unknown): string[] {
  return (Array.isArray(buttons) ? buttons : [])
    .flat()
    .map((button: any) => String(button.label ?? button.text ?? ""));
}

function policyAwareButtons(allowedActions: { merge: boolean; pr: boolean }) {
  return [
    [
      ...(allowedActions.merge ? [{ label: "Merge", callbackData: "merge" }] : []),
      ...(allowedActions.pr ? [{ label: "Open PR", callbackData: "open-pr" }] : []),
    ],
    [{ label: "Later", callbackData: "later" }],
  ];
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
      startedAt: 1700000003000,
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
      "worktree-action:s-worktree-generic:worktree-missing-repo-dir:1700000003000:agent/generic:/tmp/repo/.worktrees/generic",
    );
  });

  it("keeps generic worktree notification keys stable when completedAt is populated later", async () => {
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
    const session: any = {
      id: "s-worktree-generic-retry",
      name: "generic-worktree-retry",
      status: "completed",
      phase: "implementing",
      lifecycle: "active",
      worktreeState: "active",
      startedAt: 1700000005000,
      worktreePath: "/tmp/repo/.worktrees/generic-retry",
      worktreeBranch: "agent/generic-retry",
      worktreeStrategy: "ask",
      completedAt: undefined,
      originalWorkdir: "/tmp/repo",
      harnessSessionId: "h-worktree-generic-retry",
      getOutput: () => [],
    };

    await service.handleWorktreeStrategy(session);
    session.completedAt = 1700000009000;
    await service.handleWorktreeStrategy(session);

    assert.equal(notifications.length, 2);
    assert.equal(notifications[0]?.idempotencyKey, notifications[1]?.idempotencyKey);
    assert.equal(
      notifications[0]?.idempotencyKey,
      "worktree-action:s-worktree-generic-retry:worktree-missing-repo-dir:1700000005000:agent/generic-retry:/tmp/repo/.worktrees/generic-retry",
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

  it("preserves no-change worktrees only after verifying the branch still has an open PR", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-no-change-open-pr-"));
    const notifications: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    let openPrLookup: { repoDir: string; branchName: string; targetRepo?: string } | undefined;
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      const worktreePath = createWorktree(repoDir, "verified-open-pr-no-change");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "no-change",
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
        getWorktreeDecisionButtons: () => [[{ label: "Merge", callbackData: "merge" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        hasOpenPrForBranch: (lookupRepoDir, lookupBranchName, targetRepo) => {
          openPrLookup = { repoDir: lookupRepoDir, branchName: lookupBranchName, targetRepo };
          return true;
        },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => {
          throw new Error("no-change open PR preservation should not run auto-pr");
        },
      });

      const session: any = {
        id: "s-verified-open-pr-no-change",
        name: "verified-open-pr-no-change",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "pr_open",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "never-pr",
        worktreePrUrl: "https://github.com/example/repo/pull/310",
        pendingPlanApproval: false,
        getOutput: () => ["Existing PR remains open."],
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.deepEqual(openPrLookup, { repoDir, branchName, targetRepo: undefined });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.label, "worktree-no-changes-preserved");
      assert.equal(session.worktreeState, "pr_open");
      assert.equal(session.worktreeLifecycle?.state, "pr_open");
      assert.equal(patches.some((patch) => (patch as any).worktreeLifecycle?.state === "pr_open"), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("allows delegate sessions to receive decision buttons when repo policy blocks follow-through", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("delegate-policy-blocked");
    const notifications: Array<Record<string, unknown>> = [];
    const policyButtons = [[{ label: "Later", callbackData: "later" }]];
    let policyButtonOptions: { allowDelegate?: boolean } | undefined;
    let policyAllowedActions: { merge: boolean; pr: boolean } | undefined;
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
        getWorktreeDecisionButtons: () => undefined,
        getPolicyAwareWorktreeDecisionButtons: (_sessionId, options, allowedActions) => {
          policyButtonOptions = options;
          policyAllowedActions = allowedActions;
          return policyButtons;
        },
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => false,
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => ({ success: true }),
      });

      const session: any = {
        id: "s-delegate-policy-blocked",
        name: "delegate-policy-blocked",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "active",
        startedAt: 1700000010000,
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "delegate",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-policy-blocked");
      assert.equal(notifications[0].buttons, policyButtons);
      assert.deepEqual(policyButtonOptions, { allowDelegate: true });
      assert.deepEqual(policyAllowedActions, { merge: false, pr: false });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("keeps policy-blocked worktree keys stable when completedAt is populated later", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("policy-blocked-completed-at");
    const notifications: Array<Record<string, unknown>> = [];
    try {
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "has-commits",
        updatePersistedSession: () => true,
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request as Record<string, unknown>);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => undefined,
        getPolicyAwareWorktreeDecisionButtons: () => [[{ label: "Later", callbackData: "later" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => false,
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => ({ success: true }),
      });
      const session: any = {
        id: "s-policy-blocked-completed-at",
        name: "policy-blocked-completed-at",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "active",
        startedAt: 1700000015000,
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "delegate",
        pendingPlanApproval: false,
      };

      await service.handleWorktreeStrategy(session);
      session.completedAt = 1700000019000;
      await service.handleWorktreeStrategy(session);

      assert.equal(notifications.length, 2);
      assert.equal(notifications[0]?.label, "worktree-policy-blocked");
      assert.equal(notifications[1]?.label, "worktree-policy-blocked");
      assert.equal(notifications[0]?.idempotencyKey, notifications[1]?.idempotencyKey);
      assert.match(
        String(notifications[0]?.idempotencyKey),
        new RegExp(`^worktree-policy-blocked:s-policy-blocked-completed-at:${branchName}:main:1700000015000:`),
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
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
        repoIntegrationPolicy: "pr-allowed",
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

  it("updates an existing open PR branch under never-pr policy without prompting for a worktree decision", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("existing-pr-never-pr");
    const notifications: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    let autoPrCalled = false;
    let openPrLookup: { repoDir: string; branchName: string; targetRepo?: string } | undefined;
    try {
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
        getPolicyAwareWorktreeDecisionButtons: () => {
          throw new Error("existing PR updates must not request manual decision buttons");
        },
        getWorktreeDecisionButtons: () => [[{ label: "Merge", callbackData: "merge" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => true,
        hasOpenPrForBranch: (lookupRepoDir, lookupBranchName, targetRepo) => {
          openPrLookup = { repoDir: lookupRepoDir, branchName: lookupBranchName, targetRepo };
          return true;
        },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async (_session, baseBranch) => {
          autoPrCalled = true;
          assert.equal(baseBranch, "main");
          Object.assign(session, {
            lifecycle: "terminal",
            worktreeState: "pr_open",
            pendingWorktreeDecisionSince: undefined,
            worktreeLifecycle: {
              state: "pr_open",
              updatedAt: "2026-06-30T12:00:00.000Z",
              resolutionSource: "agent_pr",
            },
            worktreePrUrl: "https://github.com/example/repo/pull/310",
          });
          return { success: true };
        },
      });

      const session: any = {
        id: "s-existing-pr-never-pr",
        name: "existing-pr-never-pr",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "active",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "never-pr",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(autoPrCalled, true);
      assert.deepEqual(openPrLookup, { repoDir, branchName, targetRepo: undefined });
      assert.equal(notifications.length, 0);
      assert.equal(session.lifecycle, "terminal");
      assert.equal(session.worktreeState, "pr_open");
      assert.equal(session.worktreeLifecycle?.state, "pr_open");
      assert.equal(session.pendingWorktreeDecisionSince, undefined);
      assert.equal(
        patches.some((patch) => patch.lifecycle === "awaiting_worktree_decision" || patch.worktreeState === "pending_decision"),
        false,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("updates a recorded open PR under missing repo policy without prompting for merge", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("existing-pr-missing-policy");
    const notifications: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    let autoPrCalled = false;
    let prStatusLookup: { repoDir: string; prUrl: string; targetRepo?: string } | undefined;
    try {
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
        getPolicyAwareWorktreeDecisionButtons: () => {
          throw new Error("recorded open PR updates must not request manual decision buttons");
        },
        getWorktreeDecisionButtons: () => [[{ label: "Merge", callbackData: "merge" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => true,
        getPrStatusForUrl: (lookupRepoDir, prUrl, targetRepo) => {
          prStatusLookup = { repoDir: lookupRepoDir, prUrl, targetRepo };
          return {
            exists: true,
            state: "open",
            url: prUrl,
            number: 98910,
            headRefName: "agent/task-flow-lifecycle-hooks",
            baseRefName: "main",
          };
        },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async (_session, baseBranch) => {
          autoPrCalled = true;
          assert.equal(baseBranch, "main");
          Object.assign(session, {
            lifecycle: "terminal",
            worktreeState: "pr_open",
            pendingWorktreeDecisionSince: undefined,
            worktreeLifecycle: {
              state: "pr_open",
              updatedAt: "2026-07-05T12:00:00.000Z",
              resolutionSource: "agent_pr",
            },
          });
          return { success: true };
        },
      });

      const session: any = {
        id: "s-existing-pr-missing-policy",
        name: "existing-pr-missing-policy",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "active",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        worktreePrUrl: "https://github.com/openclaw/openclaw/pull/98910",
        worktreePrTargetRepo: "openclaw/openclaw",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(autoPrCalled, true);
      assert.deepEqual(prStatusLookup, {
        repoDir,
        prUrl: "https://github.com/openclaw/openclaw/pull/98910",
        targetRepo: "openclaw/openclaw",
      });
      assert.equal(notifications.length, 0);
      assert.equal(
        patches.some((patch) => patch.lifecycle === "awaiting_worktree_decision" || patch.worktreeState === "pending_decision"),
        false,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("downgrades stale pr-open lifecycle under never-pr before starting auto-pr", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("stale-pr-open-never-pr");
    const notifications: Array<Record<string, unknown>> = [];
    let autoPrCalled = false;
    let openPrLookupCount = 0;
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
        getPolicyAwareWorktreeDecisionButtons: (_sessionId, _options, allowedActions) => policyAwareButtons(allowedActions),
        getWorktreeDecisionButtons: () => [[{ label: "Merge", callbackData: "merge" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => true,
        hasOpenPrForBranch: () => {
          openPrLookupCount += 1;
          return false;
        },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => {
          autoPrCalled = true;
          return { success: true };
        },
      });

      const session: any = {
        id: "s-stale-pr-open-never-pr",
        name: "stale-pr-open-never-pr",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "pr_open",
        worktreeLifecycle: {
          state: "pr_open",
          updatedAt: "2026-06-30T12:00:00.000Z",
          resolutionSource: "agent_pr",
        },
        worktreePrUrl: "https://github.com/example/repo/pull/310",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "never-pr",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(autoPrCalled, false);
      assert.equal(openPrLookupCount, 1);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.label, "worktree-merge-ask");
      assert.equal(session.lifecycle, "awaiting_worktree_decision");
      assert.equal(session.worktreeState, "pending_decision");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("releases an auto-pr worktree represented by the current branch before opening a PR", async () => {
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
        getPrStatusForUrl: (_repo, prUrl) => prUrl === "https://github.com/example/repo/pull/194"
          ? {
              exists: true,
              state: "open",
              url: "https://github.com/example/repo/pull/194",
              number: 194,
              headRefName: "agent/fix-oca-441-regression",
              baseRefName: "main",
            }
          : { exists: false, state: "none" },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-existing-head", name: "unused" }),
        runAutoPr: async () => {
          autoPrCalled = true;
          throw new Error("represented helper worktree should not create a PR");
        },
      });

      const session: any = {
        id: "s-address-pr-194-comments",
        name: "address-pr-194-comments",
        status: "completed",
        phase: "implementing",
        lifecycle: "active",
        worktreeState: "provisioned",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "pr-allowed",
        worktreePrUrl: "https://github.com/example/repo/pull/194",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: false, worktreeRemoved: true });
      assert.equal(autoPrCalled, false);
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

  it("suppresses helper-branch auto-pr when the existing PR branch already contains the helper work", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-pr-314-helper-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      git(repoDir, "checkout", "-b", "fix-test-session-store-isolation");
      writeFileSync(join(repoDir, "session-store.txt"), "pr 314\n", "utf-8");
      git(repoDir, "add", "session-store.txt");
      git(repoDir, "commit", "-m", "Fix test session store isolation");

      const worktreePath = createWorktree(repoDir, "pr-314-comments-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      assert.equal(branchName, "agent/pr-314-comments-cleanup");

      writeFileSync(join(worktreePath, "cleanup.txt"), "commit 7f50458\n", "utf-8");
      git(worktreePath, "add", "cleanup.txt");
      git(worktreePath, "commit", "-m", "Address PR 314 review feedback");
      const helperCommit = git(worktreePath, "rev-parse", "HEAD");

      git(repoDir, "checkout", "fix-test-session-store-isolation");
      git(repoDir, "cherry-pick", helperCommit);
      git(repoDir, "merge-base", "--is-ancestor", branchName, "fix-test-session-store-isolation");

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
        getPrStatusForUrl: (_repo, prUrl) => prUrl === "https://github.com/goldmar/openclaw-code-agent/pull/314"
          ? {
              exists: true,
              state: "open",
              url: "https://github.com/goldmar/openclaw-code-agent/pull/314",
              number: 314,
              headRefName: "fix-test-session-store-isolation",
              baseRefName: "main",
            }
          : { exists: false, state: "none" },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => {
          autoPrCalled = true;
          throw new Error("helper branch PR creation must be suppressed");
        },
      });

      const session: any = {
        id: "s-pr-314-comments-cleanup",
        name: "pr-314-comments-cleanup",
        status: "completed",
        phase: "implementing",
        lifecycle: "active",
        worktreeState: "provisioned",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "pr-allowed",
        worktreePrUrl: "https://github.com/goldmar/openclaw-code-agent/pull/314",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: false, worktreeRemoved: true });
      assert.equal(autoPrCalled, false);
      assert.equal(notifications.length, 0);
      assert.equal(session.worktreePath, undefined);
      assert.equal(session.worktreeState, "released");
      assert.equal(session.worktreeLifecycle?.state, "released");
      assert.deepEqual(session.worktreeLifecycle?.notes, ["released_by_branch:fix-test-session-store-isolation"]);
      assert.throws(() => git(repoDir, "rev-parse", "--verify", branchName), /fatal:/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not suppress helper auto-pr when only a staging branch contains the helper work", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-pr-helper-staging-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      git(repoDir, "checkout", "-b", "intended-pr");
      writeFileSync(join(repoDir, "intended.txt"), "intended\n", "utf-8");
      git(repoDir, "add", "intended.txt");
      git(repoDir, "commit", "-m", "Intended PR work");

      const worktreePath = createWorktree(repoDir, "helper-staging");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "helper.txt"), "helper\n", "utf-8");
      git(worktreePath, "add", "helper.txt");
      git(worktreePath, "commit", "-m", "Helper cleanup work");
      const helperCommit = git(worktreePath, "rev-parse", "HEAD");

      git(repoDir, "checkout", "-b", "staging", "intended-pr");
      git(repoDir, "cherry-pick", helperCommit);
      git(repoDir, "merge-base", "--is-ancestor", branchName, "staging");
      assert.throws(() => git(repoDir, "merge-base", "--is-ancestor", branchName, "intended-pr"), /Command failed/);
      assert.throws(() => git(repoDir, "merge-base", "--is-ancestor", branchName, "main"), /Command failed/);

      let autoPrCalled = false;
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "has-commits",
        updatePersistedSession: (_ref, patch) => {
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: () => {},
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => [[{ label: "Open PR", callbackData: "open-pr" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        getPrStatusForUrl: (_repo, prUrl) => prUrl === "https://github.com/example/repo/pull/314"
          ? {
              exists: true,
              state: "open",
              url: "https://github.com/example/repo/pull/314",
              number: 314,
              headRefName: "intended-pr",
              baseRefName: "main",
            }
          : { exists: false, state: "none" },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async (_session, baseBranch) => {
          autoPrCalled = true;
          assert.equal(baseBranch, "main");
          return { success: true };
        },
      });

      const session: any = {
        id: "s-helper-staging",
        name: "helper-staging",
        status: "completed",
        phase: "implementing",
        lifecycle: "active",
        worktreeState: "provisioned",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "pr-allowed",
        worktreePrUrl: "https://github.com/example/repo/pull/314",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(autoPrCalled, true);
      assert.equal(session.worktreePath, worktreePath);
      assert.notEqual(session.worktreeState, "released");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("preserves represented helper branches when worktree removal fails", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-pr-helper-remove-fails-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      git(repoDir, "checkout", "-b", "intended-pr");
      writeFileSync(join(repoDir, "intended.txt"), "intended\n", "utf-8");
      git(repoDir, "add", "intended.txt");
      git(repoDir, "commit", "-m", "Intended PR work");

      const worktreePath = createWorktree(repoDir, "helper-remove-fails");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "helper.txt"), "helper\n", "utf-8");
      git(worktreePath, "add", "helper.txt");
      git(worktreePath, "commit", "-m", "Helper cleanup work");
      const helperCommit = git(worktreePath, "rev-parse", "HEAD");

      git(repoDir, "checkout", "intended-pr");
      git(repoDir, "cherry-pick", helperCommit);

      const patches: Array<Record<string, unknown>> = [];
      let injectedDirtyEntry = false;
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
        dispatchSessionNotification: () => {},
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => [[{ label: "Open PR", callbackData: "open-pr" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        getPrStatusForUrl: (_repo, prUrl) => {
          if (prUrl !== "https://github.com/example/repo/pull/314") return { exists: false, state: "none" };
          if (!injectedDirtyEntry) {
            injectedDirtyEntry = true;
            writeFileSync(join(worktreePath, "late-dirty.txt"), "dirty after representation check\n", "utf-8");
          }
          return {
            exists: true,
            state: "open",
            url: "https://github.com/example/repo/pull/314",
            number: 314,
            headRefName: "intended-pr",
            baseRefName: "main",
          };
        },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => {
          throw new Error("represented helper branch should not create a PR after cleanup failure");
        },
      });

      const session: any = {
        id: "s-helper-remove-fails",
        name: "helper-remove-fails",
        status: "completed",
        phase: "implementing",
        lifecycle: "active",
        worktreeState: "provisioned",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "pr-allowed",
        worktreePrUrl: "https://github.com/example/repo/pull/314",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: false, worktreeRemoved: false });
      assert.equal(session.worktreeState, "pending_decision");
      assert.equal(session.worktreeLifecycle?.state, "pending_decision");
      assert.deepEqual(session.worktreeLifecycle?.notes, [
        "represented_by_branch:intended-pr",
        "represented_worktree_cleanup_failed",
      ]);
      assert.equal(patches.some((patch) => (patch as any).worktreeLifecycle?.state === "released"), false);
      assert.equal(git(repoDir, "rev-parse", "--verify", branchName).length > 0, true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("requests a routed follow-up summary after auto-merge succeeds", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("summary-success");
    const warn = mock.method(console, "warn", () => {});
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

      const worktreeRemoved = await (service as any).handleAutoMergeStrategy(
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
      assert.equal(git(repoDir, "branch", "--show-current"), "main");
      assert.equal(worktreeRemoved, true);
      assert.throws(() => git(repoDir, "rev-parse", "--verify", branchName));
      assert.doesNotMatch(git(repoDir, "worktree", "list", "--porcelain"), new RegExp(`branch refs/heads/${branchName}`));
      assert.equal(session.worktreePath, undefined);
      assert.equal(warn.mock.callCount(), 0);
    } finally {
      warn.mock.restore();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("preserves a dirty merged worktree without blocking a same-name follow-up worktree", async () => {
    const name = "summary-cleanup-fails";
    const { repoDir, worktreePath, branchName } = createMergeableWorktree(name);
    try {
      writeFileSync(join(worktreePath, "late-dirty.txt"), "preserve me\n", "utf-8");
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "has-commits",
        updatePersistedSession: (_ref, patch) => {
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: () => {},
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
        id: "s-summary-cleanup-fails",
        name,
        harnessSessionId: "h-summary-cleanup-fails",
        worktreePath,
      };
      const diffSummary = getDiffSummary(repoDir, branchName, "main");
      assert.ok(diffSummary, "diff summary should be available");

      const worktreeRemoved = await (service as any).handleAutoMergeStrategy(
        session,
        repoDir,
        worktreePath,
        branchName,
        "main",
        diffSummary,
        session.id,
      );

      assert.equal(worktreeRemoved, false);
      assert.equal(session.worktreeState, "merged");
      assert.equal(session.worktreePath, worktreePath);
      assert.equal(git(repoDir, "rev-parse", "--verify", branchName).length > 0, true);
      assert.equal(git(worktreePath, "status", "--short"), "?? late-dirty.txt");

      const followUpPath = createWorktree(repoDir, name);
      assert.notEqual(followUpPath, worktreePath);
      assert.notEqual(getBranchName(followUpPath), branchName);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("marks 0-ahead ancestry-merged auto-merge worktrees as merged without suppressing the generic terminal wake", async () => {
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

      assert.deepEqual(result, { notificationSent: false, worktreeRemoved: true });
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
        warnings: [
          "Failed to determine auto-stash ref: list failed",
          "Failed to pop auto-stash after merge: already covered",
        ],
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
      assert.match(String(notifications[0].userMessage), /Recovery warning: Failed to determine auto-stash ref/);
      assert.doesNotMatch(String(notifications[0].userMessage), /already covered/);
      assert.match(String(notifications[0].wakeMessageOnNotifySuccess), /Pre-merge stash pop conflicted/);
      assert.match(String(notifications[0].wakeMessageOnNotifySuccess), /stash@\{2\}/);
      assert.match(String(notifications[0].wakeMessageOnNotifySuccess), /Recovery warning: Failed to determine auto-stash ref/);
      assert.doesNotMatch(String(notifications[0].wakeMessageOnNotifySuccess), /already covered/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("includes recovery warnings when auto-merge starts conflict resolution", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const spawnCalls: Array<Record<string, unknown>> = [];
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
      mergeBranch: () => ({
        success: false,
        rebaseConflict: true,
        error: "rebase conflict",
        warnings: ["Failed to abort rebase during recovery: abort failed"],
      }),
      spawnConflictResolver: async (args) => {
        spawnCalls.push(args as unknown as Record<string, unknown>);
        return { id: "resolver-warning", name: "resolver-warning-session" };
      },
      runAutoPr: async () => ({ success: true }),
    });

    const session: any = {
      id: "s-resolver-warning",
      name: "resolver-warning",
      harnessSessionId: "h-resolver-warning",
      worktreePrTargetRepo: undefined,
      worktreePushRemote: undefined,
    };

    await (service as any).handleAutoMergeStrategy(
      session,
      "/tmp/repo",
      "/tmp/worktree",
      "agent/resolver-warning",
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

    assert.equal(spawnCalls.length, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].label, "worktree-merge-conflict-resolving");
    assert.match(String(notifications[0].userMessage), /Recovery warning: Failed to abort rebase during recovery/);
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

  it("renders policy-aware buttons when conflict resolver spawn fails", async () => {
    const { repoDir, worktreePath, branchName } = createConflictedWorktree("resolver-spawn-policy");
    try {
      const notifications: Array<Record<string, unknown>> = [];
      let policyAllowedActions: { merge: boolean; pr: boolean } | undefined;
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
        getPolicyAwareWorktreeDecisionButtons: (_sessionId, _options, allowedActions) => {
          policyAllowedActions = allowedActions;
          return policyAwareButtons(allowedActions);
        },
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => true,
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => {
          throw new Error("spawn failed");
        },
        runAutoPr: async () => ({ success: true }),
      });

      const session: any = {
        id: "s-resolver-spawn-policy",
        name: "resolver-spawn-policy",
        harnessSessionId: "h-resolver-spawn-policy",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "active",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-merge",
        repoIntegrationPolicy: "never-pr",
        pendingPlanApproval: false,
        worktreePrTargetRepo: undefined,
        worktreePushRemote: undefined,
      };

      await service.handleWorktreeStrategy(session);

      assert.equal(session.worktreeState, "pending_decision");
      assert.equal(session.worktreeLifecycle?.state, "pending_decision");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-merge-conflict-spawn-failed");
      assert.deepEqual(policyAllowedActions, { merge: true, pr: false });
      assert.equal(buttonLabels(notifications[0].buttons).includes("Open PR"), false);
      assert.equal(buttonLabels(notifications[0].buttons).includes("Merge"), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("falls back to merge buttons when PR-only fallback buttons are blocked", async () => {
    const { repoDir, worktreePath, branchName } = createConflictedWorktree("resolver-spawn-merge-fallback");
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
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => [[
          { label: "Merge", callbackData: "merge" },
          { label: "Later", callbackData: "later" },
        ]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => true,
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => {
          throw new Error("spawn failed");
        },
        runAutoPr: async () => ({ success: true }),
      });

      const session: any = {
        id: "s-resolver-spawn-merge-fallback",
        name: "resolver-spawn-merge-fallback",
        harnessSessionId: "h-resolver-spawn-merge-fallback",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "active",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-merge",
        repoIntegrationPolicy: "never-pr",
        pendingPlanApproval: false,
        worktreePrTargetRepo: undefined,
        worktreePushRemote: undefined,
      };

      await service.handleWorktreeStrategy(session);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-merge-conflict-spawn-failed");
      assert.equal(buttonLabels(notifications[0].buttons).includes("Open PR"), false);
      assert.equal(buttonLabels(notifications[0].buttons).includes("Merge"), true);
      assert.equal(buttonLabels(notifications[0].buttons).includes("Later"), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("escalates after the retry budget is exhausted instead of spawning another resolver", async () => {
    const { repoDir, worktreePath, branchName } = createConflictedWorktree("resolver-exhausted");
    try {
      const notifications: Array<Record<string, unknown>> = [];
      let policyAllowedActions: { merge: boolean; pr: boolean } | undefined;
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
        getPolicyAwareWorktreeDecisionButtons: (_sessionId, _options, allowedActions) => {
          policyAllowedActions = allowedActions;
          return policyAwareButtons(allowedActions);
        },
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => true,
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch: () => ({
          success: false,
          rebaseConflict: true,
          error: "still conflicts",
          warnings: ["Failed to abort rebase during recovery: abort failed"],
        }),
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
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "active",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-merge",
        repoIntegrationPolicy: "never-pr",
        pendingPlanApproval: false,
      };

      await service.handleWorktreeStrategy(session);

      assert.equal(spawnCalled, false);
      assert.equal(session.worktreeState, "pending_decision");
      assert.equal(session.worktreeLifecycle?.state, "pending_decision");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-merge-conflict-escalated");
      assert.match(String(notifications[0].userMessage), /Recovery warning: Failed to abort rebase during recovery/);
      assert.deepEqual(policyAllowedActions, { merge: true, pr: false });
      assert.ok(Array.isArray(notifications[0].buttons));
      assert.equal(buttonLabels(notifications[0].buttons).includes("Open PR"), false);
      assert.equal(buttonLabels(notifications[0].buttons).includes("Merge"), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("renders policy-aware decision buttons when auto-pr fails", async () => {
    const { repoDir, worktreePath, branchName } = createMergeableWorktree("auto-pr-failure-policy");
    const notifications: Array<Record<string, unknown>> = [];
    const patches: Array<Record<string, unknown>> = [];
    let policyAllowedActions: { merge: boolean; pr: boolean } | undefined;
    try {
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
        getWorktreeDecisionButtons: () => [[{ label: "Merge", callbackData: "merge" }, { label: "Open PR", callbackData: "open-pr" }]],
        getPolicyAwareWorktreeDecisionButtons: (_sessionId, _options, allowedActions) => {
          policyAllowedActions = allowedActions;
          return policyAwareButtons(allowedActions);
        },
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => true,
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
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "active",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "pr-required",
        pendingPlanApproval: false,
        worktreePrTargetRepo: undefined,
        worktreePushRemote: undefined,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(session.worktreeState, "pending_decision");
      assert.equal(session.worktreeLifecycle?.state, "pending_decision");
      assert.equal(patches.some((patch) => patch.worktreeState === "pr_in_progress"), true);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].label, "worktree-auto-pr-failed");
      assert.match(String(notifications[0].userMessage), /Auto-PR did not complete/i);
      assert.deepEqual(policyAllowedActions, { merge: false, pr: true });
      assert.equal(buttonLabels(notifications[0].buttons).includes("Merge"), false);
      assert.equal(buttonLabels(notifications[0].buttons).includes("Open PR"), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("resets conflict-resolving sessions to pending decision when the retry fails with a non-rebase error", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    let policyAllowedActions: { merge: boolean; pr: boolean } | undefined;
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
      getPolicyAwareWorktreeDecisionButtons: (_sessionId, _options, allowedActions) => {
        policyAllowedActions = allowedActions;
        return policyAwareButtons(allowedActions);
      },
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch: () => ({
        success: false,
        error: "ff-only merge failed",
        warnings: ["Failed to check out main during recovery: checkout failed"],
      }),
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
      { merge: true, pr: false },
    );

    assert.equal(session.worktreeState, "pending_decision");
    assert.equal(session.worktreeLifecycle?.state, "pending_decision");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].label, "worktree-merge-error");
    assert.match(String(notifications[0].userMessage), /auto-merge retry did not complete/i);
    assert.match(String(notifications[0].userMessage), /Recovery warning: Failed to check out main during recovery/);
    assert.deepEqual(policyAllowedActions, { merge: true, pr: false });
    assert.ok(Array.isArray(notifications[0].buttons));
    assert.equal(buttonLabels(notifications[0].buttons).includes("Open PR"), false);
    assert.equal(buttonLabels(notifications[0].buttons).includes("Merge"), true);
  });
});
