import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/session-manager";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
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
      (sm as any).wakeDispatcher = {
        dispatchSessionNotification: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
      };
      (sm as any).__dispatchCalls = [];
      (sm as any).store.persisted.set("h-no-change", {
        harnessSessionId: "h-no-change",
        name: "no-change",
        prompt: "test",
        workdir: repoDir,
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

  it("sends the standard worktree decision buttons in delegate mode", async () => {
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
      (sm as any).wakeDispatcher = {
        dispatchSessionNotification: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
      };
      (sm as any).__dispatchCalls = [];
      (sm as any).store.persisted.set("h-delegate", {
        harnessSessionId: "h-delegate",
        name: "delegate-session",
        prompt: "update the readme",
        workdir: repoDir,
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

      const result = await (sm as any).handleWorktreeStrategy(session);

      assert.deepEqual(result, { notificationSent: true, worktreeRemoved: false });
      const calls = (sm as any).__dispatchCalls;
      assert.equal(calls.length, 1);
      const [_sessionArg, request] = calls[0];
      assert.equal(request.label, "worktree-delegate");
      assert.equal(request.notifyUser, "always");
      assert.match(request.userMessage, /Delegating merge decision/);
      assert.match(request.userMessage, /Commits: 1 \| Files: 1/);
      assert.equal(request.buttons[0][0].label, "✅ Merge");
      assert.equal(request.buttons[0][1].label, "📬 Open PR");
      assert.equal(request.buttons[0][2].label, "⏭️ Decide later");
      assert.equal(request.buttons[0][3].label, "🗑️ Dismiss (deletes branch)");
      assert.match(request.wakeMessage, /DELEGATED WORKTREE DECISION/);
      const persisted = (sm as any).store.persisted.get("h-delegate");
      assert.match(persisted.pendingWorktreeDecisionSince, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
