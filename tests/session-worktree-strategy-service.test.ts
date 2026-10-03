import "./test-env";
import { describe, it, mock, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionWorktreeMessageService } from "../src/session-worktree-message-service";
import { SessionWorktreeController } from "../src/session-worktree-controller";
import { SessionWorktreeStrategyService } from "../src/session-worktree-strategy-service";
import { createWorktree, getBranchName, getDiffSummary, mergeBranch, type DiffSummary } from "../src/worktree";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";
import { buildCompletedPayload } from "../src/session-notification-builders/terminal";

// PR buttons depend on GitHub CLI availability; never probe the host `gh` (a slow
// cold start used to hit the probe timeout and flip these tests).
before(() => setGitHubCliAvailabilityForTests(true));
after(() => setGitHubCliAvailabilityForTests(undefined));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function createConflictedWorktree(name: string): Promise<{
  repoDir: string;
  worktreePath: string;
  branchName: string;
}> {
  const repoDir = mkdtempSync(join(tmpdir(), `openclaw-auto-merge-${name}-`));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");

  const worktreePath = await createWorktree(repoDir, name);
  const branchName = await getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");

  writeFileSync(join(worktreePath, "README.md"), "feature\n", "utf-8");
  git(worktreePath, "add", "README.md");
  git(worktreePath, "commit", "-m", "feature change");

  writeFileSync(join(repoDir, "README.md"), "main\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "main change");

  return { repoDir, worktreePath, branchName };
}

async function createMergeableWorktree(name: string): Promise<{
  repoDir: string;
  worktreePath: string;
  branchName: string;
}> {
  const repoDir = mkdtempSync(join(tmpdir(), `openclaw-auto-merge-success-${name}-`));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");

  const worktreePath = await createWorktree(repoDir, name);
  const branchName = await getBranchName(worktreePath);
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
  it("releases stale helper metadata after the existing PR head was updated from a separate worktree", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-existing-pr-remote-head-"));
    const remoteDir = `${repoDir}-remote.git`;
    const worktreePath = `${repoDir}-helper`;
    const patches: Array<Record<string, unknown>> = [];
    let autoPrCalled = false;
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      execFileSync("git", ["init", "--bare", remoteDir], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      git(repoDir, "remote", "add", "origin", remoteDir);
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "push", "-u", "origin", "main");
      git(repoDir, "checkout", "-b", "agent/fix-durable-goal-owner");
      writeFileSync(join(repoDir, "pr.txt"), "existing PR\n", "utf-8");
      git(repoDir, "add", "pr.txt");
      git(repoDir, "commit", "-m", "Existing PR work");
      git(repoDir, "push", "-u", "origin", "agent/fix-durable-goal-owner");
      git(repoDir, "worktree", "add", "-b", "agent/address-pr-104265-review", worktreePath, "HEAD");
      writeFileSync(join(worktreePath, "review.txt"), "review fix\n", "utf-8");
      git(worktreePath, "add", "review.txt");
      git(worktreePath, "commit", "-m", "Address review");
      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "upstream.txt"), "upstream change\n", "utf-8");
      git(repoDir, "add", "upstream.txt");
      git(repoDir, "commit", "-m", "Advance upstream base");
      git(repoDir, "checkout", "agent/fix-durable-goal-owner");
      git(worktreePath, "rebase", "main");
      git(worktreePath, "push", "--force-with-lease", "origin", "HEAD:agent/fix-durable-goal-owner");

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
        dispatchSessionNotification: () => { throw new Error("represented update must not leave a worktree decision"); },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => { throw new Error("must not request worktree buttons"); },
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        getPrStatusForBranch: (_dir, branch, targetRepo) => {
          assert.equal(branch, "agent/fix-durable-goal-owner");
          assert.equal(targetRepo, "openclaw/openclaw");
          return {
            exists: true,
            state: "open",
            url: "https://github.com/openclaw/openclaw/pull/104265",
            number: 104265,
            headRefName: branch,
            baseRefName: "main",
          };
        },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => {
          autoPrCalled = true;
          return { success: false, notificationSent: false };
        },
      });
      const session: any = {
        id: "s-pr-104265-review",
        name: "address-pr-104265-review",
        harnessSessionId: "_gL05S6a",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "provisioned",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: "agent/address-pr-104265-review",
        worktreeParentBranch: "agent/fix-durable-goal-owner",
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        worktreePrTargetRepo: "openclaw/openclaw",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: false, worktreeRemoved: true });
      assert.equal(autoPrCalled, false);
      assert.equal(session.worktreePath, undefined);
      assert.equal(session.worktreeState, "released");
      assert.equal(session.worktreePrUrl, "https://github.com/openclaw/openclaw/pull/104265");
      assert.equal(session.worktreePrNumber, 104265);
      assert.equal(patches.some((patch) => patch.worktreeRemoteOutcome === "pr-updated"), true);
      assert.equal(patches.some((patch) => patch.worktreeState === "pending_decision"), false);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("does not adopt an unrelated parent-checkout PR after the worktree was created", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-unrelated-parent-pr-"));
    const notifications: SessionNotificationRequest[] = [];
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "checkout", "-b", "agent/intended-pr");
      const worktreePath = await createWorktree(repoDir, "unrelated-parent-helper");
      const branchName = await getBranchName(worktreePath);
      assert.ok(branchName);
      writeFileSync(join(worktreePath, "review.txt"), "review fix\n", "utf-8");
      git(worktreePath, "add", "review.txt");
      git(worktreePath, "commit", "-m", "Address review");

      git(repoDir, "checkout", "-b", "agent/unrelated-pr");
      git(repoDir, "merge", "--ff-only", branchName);

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
          notifications.push(request);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => [[{ label: "Open PR", callbackData: "open-pr" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        getPrStatusForBranch: () => {
          throw new Error("an unrelated current parent branch must not be queried");
        },
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => ({ success: false, notificationSent: false }),
      });
      const session: any = {
        id: "s-unrelated-parent-pr",
        name: "unrelated-parent-pr",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
        worktreeState: "provisioned",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeParentBranch: "agent/intended-pr",
        worktreeBaseBranch: "main",
        worktreeStrategy: "auto-pr",
        repoIntegrationPolicy: "pr-allowed",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(session.worktreeState, "pending_decision");
      assert.equal(existsSync(worktreePath), true);
      assert.equal(session.worktreePrUrl, undefined);
      assert.equal(notifications.at(-1)?.label, "worktree-auto-pr-failed");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("keys generic worktree notifications by terminal cycle and worktree identity", async () => {
    const notifications: SessionNotificationRequest[] = [];
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true,
      isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: () => undefined,
      getWorktreeCompletionState: () => {
        throw new Error("missing repo notifications should not inspect completion state");
      },
      updatePersistedSession: () => true,
      dispatchSessionNotification: (_session, request) => {
        notifications.push(request);
      },
      getOutputPreview: () => "",
      originThreadLine: () => "thread",
      getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch,
      spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: true }),
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
      getOutput: (): never[] => [],
    } as any);

    assert.equal(notifications.length, 1);
    assert.equal(
      notifications[0]?.idempotencyKey,
      "worktree-action:s-worktree-generic:worktree-missing-repo-dir:1700000003000:agent/generic:/tmp/repo/.worktrees/generic",
    );
  });

  it("keeps generic worktree notification keys stable when completedAt is populated later", async () => {
    const notifications: SessionNotificationRequest[] = [];
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true,
      isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: () => undefined,
      getWorktreeCompletionState: () => {
        throw new Error("missing repo notifications should not inspect completion state");
      },
      updatePersistedSession: () => true,
      dispatchSessionNotification: (_session, request) => {
        notifications.push(request);
      },
      getOutputPreview: () => "",
      originThreadLine: () => "thread",
      getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch,
      spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: true }),
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
      getOutput: (): never[] => [],
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
    const notifications: SessionNotificationRequest[] = [];
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
        notifications.push(request);
      },
      getOutputPreview: () => "",
      originThreadLine: () => "thread",
      getWorktreeDecisionButtons: () => [[{ label: "Update PR", callbackData: "update-pr" }]],
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch,
      spawnConflictResolver: async () => ({ id: "resolver-pr-open", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: true }),
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

    assert.deepEqual(result, { notificationSent: false, worktreeRemoved: false });
    assert.equal(notifications.length, 0);
  });

  it("preserves no-change worktrees only after verifying the branch still has an open PR", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-no-change-open-pr-"));
    const notifications: SessionNotificationRequest[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let openPrLookup: { repoDir: string; branchName: string; targetRepo?: string } | undefined;
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      const worktreePath = await createWorktree(repoDir, "verified-open-pr-no-change");
      const branchName = await getBranchName(worktreePath);
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
          notifications.push(request);
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
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("delegate-policy-blocked");
    const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
        runAutoPr: async () => ({ success: true, notificationSent: true }),
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
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("policy-blocked-completed-at");
    const notifications: SessionNotificationRequest[] = [];
    try {
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "has-commits",
        updatePersistedSession: () => true,
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request);
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
        runAutoPr: async () => ({ success: true, notificationSent: true }),
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
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("pr-open-auto");
    const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
          return { success: true, notificationSent: true };
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
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("existing-pr-never-pr");
    const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
          return { success: true, notificationSent: true };
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
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("existing-pr-missing-policy");
    const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
          return { success: true, notificationSent: true };
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

  it("does not bypass a never-pr policy for a recorded PR targeting a different base", async () => {
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("recorded-pr-wrong-base");
    const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => [[{ label: "Merge", callbackData: "merge" }]],
        getPolicyAwareWorktreeDecisionButtons: (_sessionId, _options, allowedActions) => policyAwareButtons(allowedActions),
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        isPrAvailable: () => true,
        hasOpenPrForBranch: () => false,
        getPrStatusForUrl: (_dir, prUrl) => ({
          exists: true,
          state: "open",
          url: prUrl,
          number: 98910,
          headRefName: "agent/task-flow-lifecycle-hooks",
          baseRefName: "release/next",
        }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => {
          autoPrCalled = true;
          return { success: true, notificationSent: true };
        },
      });
      const session: any = {
        id: "s-recorded-pr-wrong-base",
        name: "recorded-pr-wrong-base",
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
        worktreePrUrl: "https://github.com/openclaw/openclaw/pull/98910",
        pendingPlanApproval: false,
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      assert.equal(autoPrCalled, false);
      assert.equal(session.worktreeState, "pending_decision");
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.label, "worktree-merge-ask");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("downgrades stale pr-open lifecycle under never-pr before starting auto-pr", async () => {
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("stale-pr-open-never-pr");
    const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
          return { success: true, notificationSent: true };
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

      const worktreePath = await createWorktree(repoDir, "address-pr-194-comments");
      const branchName = await getBranchName(worktreePath);
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

      const notifications: SessionNotificationRequest[] = [];
      let autoPrCalled = false;
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: async (repo, worktree, branch, base) => (
          await new SessionWorktreeController().getCompletionState(repo, worktree, branch, base)
        ),
        updatePersistedSession: (_ref, patch) => {
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request);
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
        fetchRemoteBranch: (_repo, branch) => branch,
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

  it("preserves represented helper work when the remote PR head cannot be verified", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-auto-pr-fetch-failure-"));
    const notifications: SessionNotificationRequest[] = [];
    const patches: Array<Record<string, unknown>> = [];
    let autoPrCalled = false;
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "checkout", "-b", "agent/existing-pr-head");
      writeFileSync(join(repoDir, "pr.txt"), "existing PR\n", "utf-8");
      git(repoDir, "add", "pr.txt");
      git(repoDir, "commit", "-m", "Existing PR work");
      const worktreePath = await createWorktree(repoDir, "fetch-failure-helper");
      const branchName = await getBranchName(worktreePath);
      assert.ok(branchName);
      writeFileSync(join(worktreePath, "review.txt"), "review fix\n", "utf-8");
      git(worktreePath, "add", "review.txt");
      git(worktreePath, "commit", "-m", "Address review");
      git(repoDir, "merge", "--ff-only", branchName);

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
          notifications.push(request);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => [[{ label: "Open PR", callbackData: "open-pr" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        getPrStatusForUrl: (_dir, prUrl) => ({
          exists: true,
          state: "open",
          url: prUrl,
          number: 314,
          headRefName: "agent/existing-pr-head",
          baseRefName: "main",
        }),
        fetchRemoteBranch: () => undefined,
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => {
          autoPrCalled = true;
          return { success: false, notificationSent: false };
        },
      });
      const session: any = {
        id: "s-fetch-failure-helper",
        name: "fetch-failure-helper",
        status: "completed",
        phase: "implementing",
        lifecycle: "terminal",
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
      assert.equal(session.worktreeState, "pending_decision");
      assert.equal(existsSync(worktreePath), true);
      assert.equal(git(repoDir, "rev-parse", "--verify", branchName).length > 0, true);
      assert.equal(patches.some((patch) => patch.worktreeRemoteOutcome === "pr-updated"), false);
      assert.equal(notifications.at(-1)?.label, "worktree-auto-pr-failed");
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

      const worktreePath = await createWorktree(repoDir, "pr-314-comments-cleanup");
      const branchName = await getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      assert.equal(branchName, "agent/pr-314-comments-cleanup");

      writeFileSync(join(worktreePath, "cleanup.txt"), "commit 7f50458\n", "utf-8");
      git(worktreePath, "add", "cleanup.txt");
      git(worktreePath, "commit", "-m", "Address PR 314 review feedback");
      git(repoDir, "checkout", "fix-test-session-store-isolation");
      git(repoDir, "merge", "--ff-only", branchName);
      git(repoDir, "merge-base", "--is-ancestor", branchName, "fix-test-session-store-isolation");

      const notifications: SessionNotificationRequest[] = [];
      let autoPrCalled = false;
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: async (repo, worktree, branch, base) => (
          await new SessionWorktreeController().getCompletionState(repo, worktree, branch, base)
        ),
        updatePersistedSession: (_ref, patch) => {
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request);
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
        fetchRemoteBranch: (_repo, branch) => branch,
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

      const worktreePath = await createWorktree(repoDir, "helper-staging");
      const branchName = await getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "helper.txt"), "helper\n", "utf-8");
      git(worktreePath, "add", "helper.txt");
      git(worktreePath, "commit", "-m", "Helper cleanup work");
      git(repoDir, "checkout", "-b", "staging", "intended-pr");
      git(repoDir, "merge", "--ff-only", branchName);
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
          return { success: true, notificationSent: true };
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

      const worktreePath = await createWorktree(repoDir, "helper-remove-fails");
      const branchName = await getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "helper.txt"), "helper\n", "utf-8");
      git(worktreePath, "add", "helper.txt");
      git(worktreePath, "commit", "-m", "Helper cleanup work");
      git(repoDir, "checkout", "intended-pr");
      git(repoDir, "merge", "--ff-only", branchName);

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
        fetchRemoteBranch: (_repo, branch) => branch,
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

  it("asks the user instead of auto-merging a branch that changes git hooks, naming the files (D4)", async () => {
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("hook-change");
    try {
      mkdirSync(join(worktreePath, ".husky"), { recursive: true });
      writeFileSync(join(worktreePath, ".husky", "pre-commit"), "echo hook\n", "utf-8");
      git(worktreePath, "add", ".husky/pre-commit");
      git(worktreePath, "commit", "-m", "add hook");
      const notifications: SessionNotificationRequest[] = [];
      let mergeCalls = 0;
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "has-commits",
        updatePersistedSession: (_ref, patch) => { Object.assign(session, patch); return true; },
        dispatchSessionNotification: (_session, request) => { notifications.push(request); },
        getOutputPreview: () => "",
        originThreadLine: () => "",
        getWorktreeDecisionButtons: () => [[{ label: "Merge", callbackData: "merge" }]],
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch: async () => { mergeCalls += 1; return { success: true, fastForward: true }; },
        spawnConflictResolver: async () => ({ id: "unused", name: "unused" }),
        runAutoPr: async () => { mergeCalls += 1; return { success: true, notificationSent: true }; },
      });
      const session: any = {
        id: "s-hook-change",
        name: "hook-change",
        harnessSessionId: "h-hook-change",
        status: "completed",
        worktreeStrategy: "auto-merge",
        worktreePath,
        worktreeBranch: branchName,
        originalWorkdir: repoDir,
        workdir: worktreePath,
        worktreeBaseBranch: "main",
        prompt: "add a hook",
      };

      const result = await service.handleWorktreeStrategy(session);

      assert.equal(mergeCalls, 0, "nothing is merged or opened automatically");
      assert.equal(result.notificationSent, true);
      assert.equal(notifications.at(-1)?.label, "worktree-merge-ask");
      assert.match(String(notifications.at(-1)?.userMessage), /`\.husky\/pre-commit`/);
      assert.ok(notifications.at(-1)?.buttons, "the user gets the decision buttons");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("requests a routed follow-up summary after auto-merge succeeds", async () => {
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("summary-success");
    const warn = mock.method(console, "warn", () => {});
    try {
      const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "Session origin route (authoritative for human follow-ups):\noriginRoute: {\"provider\":\"telegram\",\"target\":\"-100123\",\"threadId\":\"32947\"}",
        getWorktreeDecisionButtons: () => undefined,
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-success", name: "unused" }),
        runAutoPr: async () => ({ success: true, notificationSent: true }),
      });

      const session: any = {
        id: "s-summary-success",
        name: "summary-success",
        harnessSessionId: "h-summary-success",
        worktreePrTargetRepo: undefined,
        worktreePushRemote: undefined,
      };

      const diffSummary = await getDiffSummary(repoDir, branchName, "main");
      assert.ok(diffSummary, "diff summary should be available");

      const { worktreeRemoved, notificationSent } = await (service as any).handleAutoMergeStrategy(
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
      assert.equal(notificationSent, true);
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
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree(name);
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
        runAutoPr: async () => ({ success: true, notificationSent: true }),
      });
      const session: any = {
        id: "s-summary-cleanup-fails",
        name,
        harnessSessionId: "h-summary-cleanup-fails",
        worktreePath,
      };
      const diffSummary = await getDiffSummary(repoDir, branchName, "main");
      assert.ok(diffSummary, "diff summary should be available");

      const { worktreeRemoved, notificationSent } = await (service as any).handleAutoMergeStrategy(
        session,
        repoDir,
        worktreePath,
        branchName,
        "main",
        diffSummary,
        session.id,
      );

      assert.equal(worktreeRemoved, false);
      assert.equal(notificationSent, true);
      assert.equal(session.worktreeState, "merged");
      assert.equal(session.worktreePath, worktreePath);
      assert.equal(git(repoDir, "rev-parse", "--verify", branchName).length > 0, true);
      assert.equal(git(worktreePath, "status", "--short"), "?? late-dirty.txt");

      const followUpPath = await createWorktree(repoDir, name);
      assert.notEqual(followUpPath, worktreePath);
      assert.notEqual(await getBranchName(followUpPath), branchName);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("marks 0-ahead ancestry-merged auto-merge worktrees as merged without suppressing the generic terminal wake", async () => {
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("already-merged");
    const notifications: SessionNotificationRequest[] = [];
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
        getWorktreeCompletionState: async (repo, worktree, branch, base) => (
          await controller.getCompletionState(repo, worktree, branch, base)
        ),
        updatePersistedSession: (_ref, patch) => {
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "thread",
        getWorktreeDecisionButtons: () => undefined,
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: async (_repoDir, fn) => { await fn(); },
        mergeBranch,
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => ({ success: true, notificationSent: true }),
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

  describe("auto-merge outcome reporting", () => {
    const repoDirs: string[] = [];
    afterEach(() => {
      for (const repoDir of repoDirs.splice(0)) rmSync(repoDir, { recursive: true, force: true });
    });
    const diffSummary: DiffSummary = {
      commits: 1, filesChanged: 1, insertions: 2, deletions: 0, changedFiles: ["feature.txt"], commitMessages: [],
    };
    function createAutoMergeService(overrides: {
      isAlreadyMerged?: () => boolean;
      enqueueMerge?: (repoDir: string, fn: () => Promise<void>, onQueued?: () => void) => Promise<void>;
      getCurrentSessionStatus?: () => "running" | "completed" | undefined;
      mergeBranch?: () => Promise<{ success: boolean; fastForward?: boolean; error?: string; dirtyError?: boolean }>;
    } = {}) {
      const repoDir = mkdtempSync(join(tmpdir(), "openclaw-auto-merge-outcome-"));
      repoDirs.push(repoDir);
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "branch", "agent/auto-merge-outcome");
      const notifications: SessionNotificationRequest[] = [];
      let merges = 0;
      const session: any = {
        id: "s-auto-merge-outcome",
        status: "completed",
        name: "auto-merge-outcome",
        harnessSessionId: "h-auto-merge-outcome",
      };
      const service = new SessionWorktreeStrategyService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: overrides.isAlreadyMerged ?? (() => false),
        resolveWorktreeRepoDir: (dir) => dir,
        getWorktreeCompletionState: () => "has-commits",
        updatePersistedSession: (_ref, patch) => {
          Object.assign(session, patch);
          return true;
        },
        dispatchSessionNotification: (_session, request) => {
          notifications.push(request);
        },
        getOutputPreview: () => "",
        originThreadLine: () => "",
        getWorktreeDecisionButtons: () => undefined,
        makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
        worktreeMessages: new SessionWorktreeMessageService(),
        enqueueMerge: overrides.enqueueMerge ?? (async (_repoDir, fn) => { await fn(); }),
        mergeBranch: async () => {
          merges += 1;
          return overrides.mergeBranch ? overrides.mergeBranch() : { success: true, fastForward: true };
        },
        spawnConflictResolver: async () => ({ id: "resolver-unused", name: "unused" }),
        runAutoPr: async () => ({ success: true, notificationSent: true }),
        ...(overrides.getCurrentSessionStatus ? { getCurrentSessionStatus: overrides.getCurrentSessionStatus } : {}),
      });
      const run = () => (service as any).handleAutoMergeStrategy(
        session, repoDir, join(repoDir, ".worktrees/auto-merge-outcome"), "agent/auto-merge-outcome", "main", diffSummary, session.id,
      );
      return { session, notifications, run, merges: () => merges };
    }

    it("reports no notice when the session is already merged before the merge is queued", async () => {
      const f = createAutoMergeService({ isAlreadyMerged: () => true });
      assert.deepEqual(await f.run(), { notificationSent: false, worktreeRemoved: false });
      assert.equal(f.notifications.length, 0);
      assert.equal(f.merges(), 0);
    });

    it("reports no notice while a conflict resolver owns the merge", async () => {
      const f = createAutoMergeService();
      f.session.autoMergeResolverSessionId = "resolver-1";
      assert.deepEqual(await f.run(), { notificationSent: false, worktreeRemoved: false });
      assert.equal(f.notifications.length, 0);
      assert.equal(f.merges(), 0);
    });

    it("does not count the queued note as the outcome when the merge landed while waiting", async () => {
      let merged = false;
      const f = createAutoMergeService({
        isAlreadyMerged: () => merged,
        enqueueMerge: async (_repoDir, fn, onQueued) => {
          onQueued?.();
          merged = true;
          await fn();
        },
      });
      assert.deepEqual(await f.run(), { notificationSent: false, worktreeRemoved: false });
      assert.deepEqual(f.notifications.map((request) => request.label), ["worktree-merge-queued"]);
      assert.equal(f.merges(), 0);
    });

    it("reports a merge error as the sent outcome", async () => {
      const f = createAutoMergeService({
        mergeBranch: async () => ({ success: false, error: "base is dirty", dirtyError: true }),
      });
      assert.deepEqual(await f.run(), { notificationSent: true, worktreeRemoved: false });
      assert.deepEqual(f.notifications.map((request) => request.label), ["worktree-merge-error"]);
    });

    it("reports a queued merge as a milestone when the session id was resumed meanwhile", async () => {
      const f = createAutoMergeService({ getCurrentSessionStatus: () => "running" });
      const result = await f.run();
      assert.equal(result.notificationSent, true);
      assert.equal(f.session.status, "completed", "the captured session object is stale");
      assert.equal(f.notifications.length, 1);
      assert.match(String(f.notifications[0].userMessage), /^ℹ️ \[auto-merge-outcome\] Merged: `agent\/auto-merge-outcome` → `main`/);
      assert.doesNotMatch(String(f.notifications[0].userMessage), /Completed/);
    });

    it("gives the automatic merge line the same stats footer as the generic completion notice", async () => {
      const f = createAutoMergeService();
      Object.assign(f.session, { costUsd: 0.11, duration: 8_000, harnessName: "claude-code", model: "sonnet", reasoningEffort: "low" });
      await f.run();
      const line = String(f.notifications[0].userMessage);
      const completed = buildCompletedPayload({ session: f.session, originThreadLine: "", preview: "" }).userMessage;
      const footer = completed.slice("✅ [auto-merge-outcome] Completed".length);
      assert.match(footer, /^ \| \$0\.11 \| 8s \| /);
      assert.equal(line, `✅ [auto-merge-outcome] Completed — Merged: \`agent/auto-merge-outcome\` → \`main\` (1 file, +2/-0)${footer}`);
    });

    it("keeps the completion form when the current status is still completed or unknown", async () => {
      for (const status of ["completed", undefined] as const) {
        const f = createAutoMergeService({ getCurrentSessionStatus: () => status });
        await f.run();
        assert.match(String(f.notifications[0].userMessage), /^✅ \[auto-merge-outcome\] Completed — Merged:/);
      }
    });
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
    const notifications: SessionNotificationRequest[] = [];
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
        notifications.push(request);
      },
      getOutputPreview: () => "",
      originThreadLine: () => "",
      getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch: async () => ({
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
      runAutoPr: async () => ({ success: true, notificationSent: true }),
    });

    const session: any = {
      id: "s-stash-conflict",
      status: "completed",
      name: "stash-conflict",
      harnessSessionId: "h-stash-conflict",
      worktreePrTargetRepo: undefined,
      worktreePushRemote: undefined,
    };
    const diffSummary: DiffSummary = {
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
      assert.match(String(notifications[0].userMessage), /^✅ \[stash-conflict\] Completed — Merged:/);
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
    const notifications: SessionNotificationRequest[] = [];
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
        notifications.push(request);
      },
      getOutputPreview: () => "",
      originThreadLine: () => "thread",
      getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch: async () => ({
        success: false,
        rebaseConflict: true,
        error: "rebase conflict",
        warnings: ["Failed to abort rebase during recovery: abort failed"],
      }),
      spawnConflictResolver: async (args) => {
        spawnCalls.push(args as unknown as Record<string, unknown>);
        return { id: "resolver-warning", name: "resolver-warning-session" };
      },
      runAutoPr: async () => ({ success: true, notificationSent: true }),
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
    const { repoDir, worktreePath, branchName } = await createConflictedWorktree("resolver-first");
    try {
      const patches: Array<Record<string, unknown>> = [];
      const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
        runAutoPr: async () => ({ success: true, notificationSent: true }),
      });

      const session: any = {
        id: "s-resolver-first",
        name: "resolver-first",
        harnessSessionId: "h-resolver-first",
        worktreePrTargetRepo: undefined,
        worktreePushRemote: undefined,
      };

      const diffSummary = await getDiffSummary(repoDir, branchName, "main");
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
    const { repoDir, worktreePath, branchName } = await createConflictedWorktree("resolver-spawn-policy");
    try {
      const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
        runAutoPr: async () => ({ success: true, notificationSent: true }),
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
    const { repoDir, worktreePath, branchName } = await createConflictedWorktree("resolver-spawn-merge-fallback");
    try {
      const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
        runAutoPr: async () => ({ success: true, notificationSent: true }),
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
    const { repoDir, worktreePath, branchName } = await createConflictedWorktree("resolver-exhausted");
    try {
      const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
        mergeBranch: async () => ({
          success: false,
          rebaseConflict: true,
          error: "still conflicts",
          warnings: ["Failed to abort rebase during recovery: abort failed"],
        }),
        spawnConflictResolver: async () => {
          spawnCalled = true;
          return { id: "resolver-2", name: "resolver-exhausted-conflict-resolver" };
        },
        runAutoPr: async () => ({ success: true, notificationSent: true }),
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
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree("auto-pr-failure-policy");
    const notifications: SessionNotificationRequest[] = [];
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
          notifications.push(request);
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
        runAutoPr: async () => ({ success: false, notificationSent: false }),
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
      assert.match(String(notifications[0].userMessage), /^⚠️ \[[\w-]+\] Completed — auto-PR failed( \|[^\n]*)?\nThe worktree is kept; choose below\.$/);
      assert.deepEqual(policyAllowedActions, { merge: false, pr: true });
      assert.equal(buttonLabels(notifications[0].buttons).includes("Merge"), false);
      assert.equal(buttonLabels(notifications[0].buttons).includes("Open PR"), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("resets conflict-resolving sessions to pending decision when the retry fails with a non-rebase error", async () => {
    const notifications: SessionNotificationRequest[] = [];
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
        notifications.push(request);
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
      mergeBranch: async () => ({
        success: false,
        error: "ff-only merge failed",
        warnings: ["Failed to check out main during recovery: checkout failed"],
      }),
      spawnConflictResolver: async () => ({ id: "resolver-3", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: true }),
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
      true,
    );

    assert.equal(session.worktreeState, "pending_decision");
    assert.equal(session.worktreeLifecycle?.state, "pending_decision");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].label, "worktree-merge-error");
    // A follow-up of the cycle that already said `Completed — merge conflict`.
    assert.match(String(notifications[0].userMessage), /^⚠️ \[resolver-retry-failure\] Merge failed\nff-only merge failed\n/);
    assert.doesNotMatch(String(notifications[0].userMessage), /Completed —/);
    assert.match(String(notifications[0].userMessage), /auto-merge retry did not complete/i);
    assert.match(String(notifications[0].userMessage), /Recovery warning: Failed to check out main during recovery/);
    assert.deepEqual(policyAllowedActions, { merge: true, pr: false });
    assert.ok(Array.isArray(notifications[0].buttons));
    assert.equal(buttonLabels(notifications[0].buttons).includes("Open PR"), false);
    assert.equal(buttonLabels(notifications[0].buttons).includes("Merge"), true);
  });
});

describe("SessionWorktreeStrategyService retry after the conflict resolver", () => {
  // The cycle already sent `⚠️ [name] Completed — merge conflict`: the retry
  // must not send a second `Completed —` line (✅ or ⚠️) and defers no `✅`.
  async function retryFixture(name: string, completionState: "has-commits" | "dirty-uncommitted" | "no-change" | "merged" | "released" | "base-advanced") {
    const { repoDir, worktreePath, branchName } = await createMergeableWorktree(name);
    const notifications: SessionNotificationRequest[] = [];
    const patches: Array<Record<string, unknown>> = [];
    const session: any = {
      id: `s-${name}`,
      name,
      harnessSessionId: `h-${name}`,
      status: "completed",
      startedAt: 1700000009000,
      worktreeState: "merge_conflict_resolving",
      worktreeStrategy: "auto-merge",
      worktreePath,
      worktreeBranch: branchName,
      originalWorkdir: repoDir,
      workdir: worktreePath,
      worktreeBaseBranch: "main",
      prompt: "resolve",
      costUsd: 0.5,
    };
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true,
      isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: (dir) => dir,
      getWorktreeCompletionState: () => completionState,
      updatePersistedSession: (_ref, patch) => { patches.push(patch); Object.assign(session, patch); return true; },
      dispatchSessionNotification: (_session, request) => { notifications.push(request); },
      getOutputPreview: () => "",
      originThreadLine: () => "",
      getWorktreeDecisionButtons: () => [[{ label: "Merge", callbackData: "merge" }]],
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "open-pr" }),
      worktreeMessages: new SessionWorktreeMessageService(),
      enqueueMerge: async (_repoDir, fn) => { await fn(); },
      mergeBranch,
      spawnConflictResolver: async () => ({ id: "unused", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: true }),
    });
    const texts = () => notifications.map((request) => String(request.userMessage));
    return { repoDir, worktreePath, branchName, session, service, notifications, patches, texts };
  }

  it("reports leftover uncommitted files as a plain follow-up that does not claim missing commits", async () => {
    const f = await retryFixture("retry-dirty", "dirty-uncommitted");
    try {
      writeFileSync(join(f.worktreePath, "leftover.txt"), "left by the resolver\n", "utf-8");
      await f.service.handleWorktreeStrategy(f.session, { retryAfterConflict: true });
      assert.equal(f.notifications.length, 1);
      const [first, second] = f.texts()[0]!.split("\n");
      assert.equal(first, `⚠️ [retry-dirty] Uncommitted changes on \`${f.branchName}\``);
      // The branch has a commit of its own: "no commits" would be false.
      assert.equal(second, "Commit or discard them before the branch is merged.");
      assert.doesNotMatch(f.texts()[0]!, /Completed —|no commits/);
      assert.doesNotMatch(String(f.notifications[0]!.wakeMessageOnNotifyFailed), /no commits/);

      // The first pass of a cycle keeps the `Completed —` form with the footer.
      const firstPass = await retryFixture("first-dirty", "dirty-uncommitted");
      try {
        writeFileSync(join(firstPass.worktreePath, "leftover.txt"), "x\n", "utf-8");
        await firstPass.service.handleWorktreeStrategy(firstPass.session);
        assert.ok(firstPass.texts()[0]!.split("\n")[0]!.startsWith(`⚠️ [first-dirty] Completed — uncommitted changes on \`${firstPass.branchName}\` | $0.50`), firstPass.texts()[0]);
      } finally {
        rmSync(firstPass.repoDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(f.repoDir, { recursive: true, force: true });
    }
  });

  it("reports a retry with nothing left to merge as a milestone, not a second completion", async () => {
    const f = await retryFixture("retry-no-change", "no-change");
    try {
      const result = await f.service.handleWorktreeStrategy(f.session, { retryAfterConflict: true });
      assert.equal(result.notificationSent, true);
      assert.equal(f.texts().length, 1);
      assert.match(f.texts()[0]!, /^ℹ️ \[retry-no-change\] No changes left to merge after conflict resolution \| \$0\.50[^\n]*$/);
    } finally {
      rmSync(f.repoDir, { recursive: true, force: true });
    }
    for (const state of ["merged", "released"] as const) {
      const g = await retryFixture(`retry-${state}`, state);
      try {
        // Without the retry these paths stay silent and the generic terminal notice follows.
        const silent = await retryFixture(`first-${state}`, state);
        try {
          assert.equal((await silent.service.handleWorktreeStrategy(silent.session)).notificationSent, false);
          assert.deepEqual(silent.texts(), []);
        } finally {
          rmSync(silent.repoDir, { recursive: true, force: true });
        }
        const result = await g.service.handleWorktreeStrategy(g.session, { retryAfterConflict: true });
        assert.equal(result.notificationSent, true, "the user was told the merge would be retried");
        assert.equal(g.texts().length, 1);
        assert.ok(g.texts()[0]!.startsWith(state === "merged"
          ? `ℹ️ [retry-merged] Merged: \`${g.branchName}\` → \`main\` | $0.50`
          : "ℹ️ [retry-released] No changes left to merge after conflict resolution | $0.50"), g.texts()[0]);
        assert.doesNotMatch(g.texts()[0]!, /\n/);
        assert.equal(g.session.worktreeState, state);
      } finally {
        rmSync(g.repoDir, { recursive: true, force: true });
      }
    }
  });

  it("defers no completion marker when the retry ends in the decision prompt", async () => {
    for (const retry of [true, false]) {
      const f = await retryFixture(`retry-ask-${retry}`, "has-commits");
      try {
        mkdirSync(join(f.worktreePath, ".husky"), { recursive: true });
        writeFileSync(join(f.worktreePath, ".husky", "pre-commit"), "echo hook\n", "utf-8");
        git(f.worktreePath, "add", ".husky/pre-commit");
        git(f.worktreePath, "commit", "-m", "add hook");
        await f.service.handleWorktreeStrategy(f.session, retry ? { retryAfterConflict: true } : {});
        assert.equal(f.notifications.at(-1)?.label, "worktree-merge-ask");
        // Without the marker a later Merge / PR is an `ℹ️` milestone (see owedCompletionCycle).
        assert.equal(
          f.patches.some((patch) => patch.deferredCompletionCycle !== undefined),
          !retry,
          retry ? "the retry must not defer a second completion" : "the first prompt defers the ✅",
        );
        assert.equal(f.session.deferredCompletionCycle, retry ? undefined : 1700000009000);
      } finally {
        rmSync(f.repoDir, { recursive: true, force: true });
      }
    }
  });

  it("repeats no Completed line for a retried merge, a moved base, or a blocking policy", async () => {
    const merged = await retryFixture("retry-merge", "has-commits");
    try {
      // No hook change and a policy that allows the merge.
      merged.session.repoIntegrationPolicy = "never-pr";
      await merged.service.handleWorktreeStrategy(merged.session, { retryAfterConflict: true });
      assert.equal(merged.notifications.at(-1)?.label, "worktree-merge-success");
      assert.match(merged.texts().at(-1)!, /^ℹ️ \[retry-merge\] Merged: /);
    } finally {
      rmSync(merged.repoDir, { recursive: true, force: true });
    }
    const moved = await retryFixture("retry-moved", "base-advanced");
    try {
      await moved.service.handleWorktreeStrategy(moved.session, { retryAfterConflict: true });
      assert.equal(moved.texts()[0]!.split("\n")[0], `⚠️ [retry-moved] No commits on \`${moved.branchName}\`, but \`main\` moved`);
    } finally {
      rmSync(moved.repoDir, { recursive: true, force: true });
    }
    const blocked = await retryFixture("retry-blocked", "has-commits");
    try {
      // No repo policy is known: automatic follow-through is blocked.
      await blocked.service.handleWorktreeStrategy(blocked.session, { retryAfterConflict: true });
      assert.deepEqual(blocked.texts()[0]!.split("\n"), ["⚠️ [retry-blocked] Blocked by repo policy", "Repo integration policy is unknown."]);
      const first = await retryFixture("first-blocked", "has-commits");
      try {
        await first.service.handleWorktreeStrategy(first.session);
        const [heading, reason] = first.texts()[0]!.split("\n");
        assert.ok(heading!.startsWith("⚠️ [first-blocked] Completed — blocked by repo policy | $0.50"), heading);
        assert.equal(reason, "Repo integration policy is unknown.");
      } finally {
        rmSync(first.repoDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(blocked.repoDir, { recursive: true, force: true });
    }
  });
});
