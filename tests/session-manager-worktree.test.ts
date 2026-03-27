import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/session-manager";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function stubDispatch(sm: SessionManager): void {
  (sm as any).__dispatchCalls = [];
  (sm as any).notifications = {
    dispatch: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    notifyWorktreeOutcome: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    dispose: () => {},
  };
  (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
}

describe("SessionManager.handleWorktreeStrategy()", () => {
  it("notifies no-change cleanup only after the worktree is actually deleted", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "no-change-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const sm = new SessionManager(5);
      stubDispatch(sm);
      (sm as any).store.persisted.set("h-no-change", {
        harnessSessionId: "h-no-change",
        name: "no-change",
        prompt: "test",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
      });

      const session = {
        id: "s-no-change",
        name: "no-change",
        status: "completed",
        phase: "implementing",
        harnessSessionId: "h-no-change",
        prompt: "test",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "ask",
        worktreeBaseBranch: "main",
        pendingPlanApproval: false,
      };

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: true });
      assert.equal(session.worktreePath, undefined);
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-no-changes");
      assert.match(request.userMessage, /worktree cleaned up/);
      const persisted = (sm as any).store.persisted.get("h-no-change");
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeDisposition, "no-change-cleaned");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("routes delegate mode to the orchestrator without user buttons", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-delegate-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "delegate-buttons");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      writeFileSync(join(worktreePath, "README.md"), "hello\nupdated\n", "utf-8");
      git(worktreePath, "add", "README.md");
      git(worktreePath, "commit", "-m", "update readme");

      const sm = new SessionManager(5);
      stubDispatch(sm);
      (sm as any).store.persisted.set("h-delegate", {
        harnessSessionId: "h-delegate",
        name: "delegate-session",
        prompt: "update the readme",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "delegate",
      });

      const session = {
        id: "s-delegate",
        name: "delegate-session",
        status: "completed",
        phase: "implementing",
        harnessSessionId: "h-delegate",
        prompt: "update the readme",
        originalWorkdir: repoDir,
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "delegate",
        worktreeBaseBranch: "main",
        pendingPlanApproval: false,
      };
      (sm as any).sessions.set(session.id, session);

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-delegate");
      assert.equal(request.notifyUser, "never");
      assert.equal(request.userMessage, undefined);
      assert.equal(request.buttons, undefined);
      assert.match(request.wakeMessage, /DELEGATED WORKTREE DECISION/);
      assert.match(request.wakeMessage, /agent_merge\(session="delegate-session"/);
      assert.match(request.wakeMessage, /Never call agent_pr\(\) autonomously/);
      const persisted = (sm as any).store.persisted.get("h-delegate");
      assert.match(persisted.pendingWorktreeDecisionSince, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("daily cleanup removes resolved worktrees after retention", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-retention-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "resolved-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const sm = new SessionManager(5);
      (sm as any).store.persisted.set("h-resolved", {
        harnessSessionId: "h-resolved",
        name: "resolved-cleanup",
        prompt: "test",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeState: "merged",
        worktreeMergedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      });

      (sm as any).runDailyWorktreeMaintenance(Date.now());

      assert.equal(existsSync(worktreePath), false);
      const persisted = (sm as any).store.persisted.get("h-resolved");
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeState, "none");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("daily cleanup never deletes pending-decision worktrees", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "sm-worktree-pending-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
      git(repoDir, "add", "README.md");
      git(repoDir, "commit", "-m", "init");

      const worktreePath = createWorktree(repoDir, "pending-cleanup");
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");

      const sm = new SessionManager(5);
      (sm as any).store.persisted.set("h-pending", {
        harnessSessionId: "h-pending",
        name: "pending-cleanup",
        prompt: "test",
        workdir: repoDir,
        route: {
          provider: "telegram",
          target: "12345",
          sessionKey: "agent:main:telegram:group:12345",
        },
        status: "completed",
        costUsd: 0,
        worktreePath,
        worktreeBranch: branchName,
        worktreeState: "pending_decision",
        pendingWorktreeDecisionSince: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      });

      (sm as any).runDailyWorktreeMaintenance(Date.now());

      assert.equal(existsSync(worktreePath), true);
      const persisted = (sm as any).store.persisted.get("h-pending");
      assert.equal(persisted.worktreePath, worktreePath);
      assert.equal(persisted.worktreeState, "pending_decision");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
