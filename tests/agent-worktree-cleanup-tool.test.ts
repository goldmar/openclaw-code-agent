import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionManager } from "../src/singletons";
import { makeAgentWorktreeCleanupTool } from "../src/tools/agent-worktree-cleanup";
import { makeAgentWorktreeStatusTool } from "../src/tools/agent-worktree-status";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function initRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  return repoDir;
}

function createCommittedWorktree(repoDir: string, name: string, fileName = "feature.txt", contents = `${name}\n`) {
  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");
  writeFileSync(join(worktreePath, fileName), contents, "utf-8");
  git(worktreePath, "add", fileName);
  git(worktreePath, "commit", "-m", `feat: ${name}`);
  return { worktreePath, branchName };
}

afterEach(() => {
  setSessionManager(null);
});

describe("agent_worktree_status", () => {
  it("renders derived released lifecycle details from repository evidence", async () => {
    const repoDir = initRepo("status-released-");
    try {
      const released = createCommittedWorktree(repoDir, "released-status", "feature.txt", "released\n");
      const releasedCommit = git(released.worktreePath, "rev-parse", "HEAD");
      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "main-only.txt"), "main first\n", "utf-8");
      git(repoDir, "add", "main-only.txt");
      git(repoDir, "commit", "-m", "main diverges");
      git(repoDir, "cherry-pick", releasedCommit);

      const persisted = {
        sessionId: "s-released-status",
        harnessSessionId: "h-released-status",
        name: "released-status",
        prompt: "released",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: released.worktreePath,
        worktreeBranch: released.branchName,
        worktreeBaseBranch: "main",
        worktreeLifecycle: {
          state: "pending_decision",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
      } as any);

      const tool = makeAgentWorktreeStatusTool();
      const result = await tool.execute("tool-id", { session: "released-status" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Session: released-status \[s-released-status\]/);
      assert.match(text, /Lifecycle:\s*needs decision/);
      assert.match(text, /Derived:\s*released/);
      assert.match(text, /Cleanup:\s*preserve/);
      assert.match(text, /Ahead:\s*\d+ ahead \/ \d+ behind/);
      assert.match(text, /Reasons:\s*pending decision, content already on base/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("renders merge-conflict-resolving worktrees as preserved conflict resolution state", async () => {
    const repoDir = initRepo("status-conflict-resolving-");
    try {
      const conflicted = createCommittedWorktree(repoDir, "conflict-resolving-status", "feature.txt", "resolver\n");

      const persisted = {
        sessionId: "s-conflict-resolving",
        harnessSessionId: "h-conflict-resolving",
        name: "conflict-resolving-status",
        prompt: "resolve the merge conflict",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: conflicted.worktreePath,
        worktreeBranch: conflicted.branchName,
        worktreeBaseBranch: "main",
        worktreeLifecycle: {
          state: "merge_conflict_resolving",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
      } as any);

      const tool = makeAgentWorktreeStatusTool();
      const result = await tool.execute("tool-id", { session: "conflict-resolving-status" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Lifecycle:\s*conflict resolving/);
      assert.match(text, /Cleanup:\s*preserve/);
      assert.match(text, /Reasons:\s*conflict resolving, still has unique content/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("agent_worktree_cleanup", () => {
  it("preview_all reports safe released worktrees and kept unresolved worktrees with reasons", async () => {
    const repoDir = initRepo("cleanup-preview-");
    try {
      const released = createCommittedWorktree(repoDir, "released-branch", "feature.txt", "released\n");
      const releasedCommit = git(released.worktreePath, "rev-parse", "HEAD");
      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "main-only.txt"), "main first\n", "utf-8");
      git(repoDir, "add", "main-only.txt");
      git(repoDir, "commit", "-m", "main diverges");
      git(repoDir, "cherry-pick", releasedCommit);

      const unique = createCommittedWorktree(repoDir, "unique-branch", "unique.txt");
      git(repoDir, "checkout", "main");

      const persisted = [
        {
          sessionId: "s-released",
          harnessSessionId: "h-released",
          name: "released-task",
          prompt: "released",
          workdir: repoDir,
          status: "completed",
          costUsd: 0,
          worktreePath: released.worktreePath,
          worktreeBranch: released.branchName,
          worktreeBaseBranch: "main",
          worktreeLifecycle: {
            state: "released",
            updatedAt: new Date().toISOString(),
            baseBranch: "main",
          },
        },
        {
          sessionId: "s-unique",
          harnessSessionId: "h-unique",
          name: "unique-task",
          prompt: "unique",
          workdir: repoDir,
          status: "completed",
          costUsd: 0,
          worktreePath: unique.worktreePath,
          worktreeBranch: unique.branchName,
          worktreeBaseBranch: "main",
          worktreeLifecycle: {
            state: "pending_decision",
            updatedAt: new Date().toISOString(),
            baseBranch: "main",
          },
        },
      ];

      setSessionManager({
        list: () => [],
        resolve(ref: string) {
          if (ref === "s-unique") {
            return { id: "s-unique", name: "unique-task", status: "running", worktreePath: unique.worktreePath } as any;
          }
          return undefined;
        },
        listPersistedSessions: () => persisted as any,
        getPersistedSession(ref: string) {
          return persisted.find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
        updatePersistedSession() { return true; },
        dismissWorktree: async () => "dismissed",
      } as any);

      const tool = makeAgentWorktreeCleanupTool();
      const result = await tool.execute("tool-id", { mode: "preview_all" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Worktree lifecycle review:/);
      assert.match(text, /SAFE NOW \(1\): released-task \(released\)/);
      assert.match(text, /KEPT \(1\): unique-task \[kept: .*active session.*pending decision.*still has unique content/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("clean_safe removes released worktrees and clears persisted worktree metadata", async () => {
    const repoDir = initRepo("cleanup-exec-");
    try {
      const released = createCommittedWorktree(repoDir, "released-clean", "feature.txt", "released\n");
      const releasedCommit = git(released.worktreePath, "rev-parse", "HEAD");
      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "main-only.txt"), "main first\n", "utf-8");
      git(repoDir, "add", "main-only.txt");
      git(repoDir, "commit", "-m", "main diverges");
      git(repoDir, "cherry-pick", releasedCommit);

      const persisted = {
        sessionId: "s-clean",
        harnessSessionId: "h-clean",
        name: "released-clean",
        prompt: "released",
        workdir: repoDir,
        status: "completed",
        costUsd: 0,
        worktreePath: released.worktreePath,
        worktreeBranch: released.branchName,
        worktreeBaseBranch: "main",
        worktreeState: "ready",
        worktreeLifecycle: {
          state: "released",
          updatedAt: new Date().toISOString(),
          baseBranch: "main",
        },
      };

      setSessionManager({
        list: () => [],
        resolve: () => undefined,
        listPersistedSessions: () => [persisted] as any,
        getPersistedSession(ref: string) {
          return [persisted].find((session) =>
            session.sessionId === ref || session.harnessSessionId === ref || session.name === ref
          ) as any;
        },
        updatePersistedSession(ref: string, patch: Record<string, unknown>) {
          if (ref === persisted.sessionId || ref === persisted.harnessSessionId || ref === persisted.name) {
            Object.assign(persisted, patch);
            return true;
          }
          return false;
        },
        dismissWorktree: async () => "dismissed",
      } as any);

      const tool = makeAgentWorktreeCleanupTool();
      const result = await tool.execute("tool-id", { mode: "clean_safe" });
      const text = (result.content[0] as { text: string }).text;

      assert.match(text, /Clean all safe:/);
      assert.match(text, /SAFE FOUND \(1\): released-clean \(released\)/);
      assert.match(text, /CLEANED \(1\): released-clean \(released\)/);
      assert.equal(existsSync(released.worktreePath), false);
      assert.throws(() => git(repoDir, "rev-parse", "--verify", released.branchName), /fatal:/);
      assert.equal(persisted.worktreePath, undefined);
      assert.equal(persisted.worktreeBranch, undefined);
      assert.equal(persisted.worktreeState, "none");
      assert.equal(persisted.worktreeLifecycle?.state, "released");
      assert.equal(typeof persisted.worktreeLifecycle?.resolvedAt, "string");
      assert.equal(persisted.worktreeLifecycle?.resolutionSource, "maintenance");
      assert.ok((persisted.worktreeLifecycle?.notes ?? []).includes("merge_noop_content_already_on_base"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
