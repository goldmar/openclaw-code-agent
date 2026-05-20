import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionManager } from "../src/singletons";
import { makeAgentMergeTool } from "../src/tools/agent-merge";
import { createWorktree, getBranchName } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function createRepoWithRemote(prefix: string): { repoDir: string; remoteDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), `${prefix}-repo-`));
  const remoteDir = mkdtempSync(join(tmpdir(), `${prefix}-remote-`));

  git(remoteDir, "init", "--bare");
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "hello\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  git(repoDir, "remote", "add", "origin", remoteDir);
  git(repoDir, "push", "-u", "origin", "main");

  return { repoDir, remoteDir };
}

function createCommittedWorktree(repoDir: string, name: string): { worktreePath: string; branchName: string } {
  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");

  writeFileSync(join(worktreePath, "feature.txt"), `${name}\n`, "utf-8");
  git(worktreePath, "add", "feature.txt");
  git(worktreePath, "commit", "-m", `feat: ${name}`);

  return { worktreePath, branchName };
}

function remoteHead(repoDir: string, branch: string): string {
  const output = git(repoDir, "ls-remote", "--heads", "origin", branch);
  return output.split(/\s+/)[0] ?? "";
}

function installPersistedSessionStub(
  sessionName: string,
  repoDir: string,
  worktreePath: string,
  branchName: string,
  notifications: Array<{ session: unknown; outcomeLine: string; options?: unknown }> = [],
): Record<string, unknown> {
  const persistedSession: Record<string, unknown> = {
    harnessSessionId: `h-${sessionName}`,
    name: sessionName,
    prompt: "test",
    workdir: repoDir,
    worktreePath,
    worktreeBranch: branchName,
    status: "completed",
    costUsd: 0,
  };

  setSessionManager({
    resolve: () => undefined,
    getPersistedSession(ref: string) {
      if (ref === sessionName || ref === persistedSession.harnessSessionId) return persistedSession as any;
      return undefined;
    },
    enqueueMerge: async (_repoDir: string, fn: () => Promise<void>) => { await fn(); },
    updatePersistedSession(_id: string, patch: Record<string, unknown>) {
      Object.assign(persistedSession, patch);
    },
    notifyWorktreeOutcome(session: unknown, outcomeLine: string, options?: unknown) {
      notifications.push({ session, outcomeLine, options });
    },
    spawn() {
      throw new Error("conflict resolver should not be spawned in this test");
    },
  } as any);
  return persistedSession;
}

afterEach(() => {
  setSessionManager(null);
});

describe("agent_merge push behavior", () => {
  it("blocks dirty uncommitted worktrees that have no commits to merge", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-dirty");
    try {
      const sessionName = "merge-dirty";
      const worktreePath = createWorktree(repoDir, sessionName);
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "feature.txt"), "not committed\n", "utf-8");
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName);

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName });

      assert.match((result.content[0] as { text: string }).text, /Merge blocked/i);
      assert.match((result.content[0] as { text: string }).text, /uncommitted worktree changes/i);
      assert.equal(git(repoDir, "rev-parse", "main"), remoteHead(repoDir, "main"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("returns already merged before dirty/no-commit merge blocking", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-already-dirty");
    try {
      const sessionName = "merge-already-dirty";
      const worktreePath = createWorktree(repoDir, sessionName);
      const branchName = getBranchName(worktreePath);
      assert.ok(branchName, "worktree branch should exist");
      writeFileSync(join(worktreePath, "feature.txt"), "not committed\n", "utf-8");
      const persistedSession = installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName);
      persistedSession.worktreeMerged = true;

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName });

      assert.match((result.content[0] as { text: string }).text, /already merged/i);
      assert.doesNotMatch((result.content[0] as { text: string }).text, /Merge blocked/i);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("keeps the merged base branch local by default", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-default");
    try {
      const sessionName = "merge-default";
      const { worktreePath, branchName } = createCommittedWorktree(repoDir, sessionName);
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName);

      const initialRemoteMain = remoteHead(repoDir, "main");
      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /Fast-forward|Merge commit/);
      assert.doesNotMatch((result.content[0] as { text: string }).text, /Pushed\./);
      assert.equal(remoteHead(repoDir, "main"), initialRemoteMain);
      assert.notEqual(git(repoDir, "rev-parse", "main"), initialRemoteMain);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("pushes the merged base branch only when push=true is requested", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-push");
    try {
      const sessionName = "merge-push";
      const { worktreePath, branchName } = createCommittedWorktree(repoDir, sessionName);
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName);

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, push: true, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /Pushed\./);
      assert.equal(remoteHead(repoDir, "main"), git(repoDir, "rev-parse", "main"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });

  it("notifies with a summary wake when local merge succeeds but push fails", async () => {
    const { repoDir, remoteDir } = createRepoWithRemote("agent-merge-push-fail");
    try {
      const sessionName = "merge-push-fail";
      const { worktreePath, branchName } = createCommittedWorktree(repoDir, sessionName);
      const notifications: Array<{ session: unknown; outcomeLine: string; options?: any }> = [];
      installPersistedSessionStub(sessionName, repoDir, worktreePath, branchName, notifications);
      git(repoDir, "remote", "set-url", "origin", join(tmpdir(), "missing-openclaw-remote.git"));

      const tool = makeAgentMergeTool();
      const result = await tool.execute("tool-id", { session: sessionName, push: true, delete_branch: false });

      assert.match((result.content[0] as { text: string }).text, /locally, but failed to push main/);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].outcomeLine, /Merged .* locally, but failed to push main/);
      assert.match(String(notifications[0].options?.detailLines?.join("\n")), /remote state may not include the merge/i);
      assert.equal(git(repoDir, "rev-parse", "main"), git(repoDir, "rev-parse", branchName));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});
