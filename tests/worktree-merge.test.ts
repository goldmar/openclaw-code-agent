import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeBranch } from "../src/worktree-merge";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function createRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-merge-"));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "file.txt"), "base\n", "utf-8");
  writeFileSync(join(repoDir, "local.txt"), "base\n", "utf-8");
  git(repoDir, "add", "file.txt", "local.txt");
  git(repoDir, "commit", "-m", "initial");
  return repoDir;
}

describe("mergeBranch", () => {
  it("reports a warning when restoring an auto-stash fails after a successful squash merge", () => {
    const repoDir = createRepo();
    try {
      git(repoDir, "checkout", "-b", "feature");
      writeFileSync(join(repoDir, "file.txt"), "feature\n", "utf-8");
      git(repoDir, "commit", "-am", "feature change");

      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "file.txt"), "local dirty change\n", "utf-8");

      const result = mergeBranch(repoDir, "feature", "main", "squash");

      assert.equal(result.success, true);
      assert.equal(result.stashed, true);
      assert.equal(result.stashPopConflict, true);
      assert.ok(result.warnings?.some((warning) => warning.includes("Failed to pop auto-stash after merge")));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports a warning when restoring an auto-stash fails after a fast-forward merge", () => {
    const repoDir = createRepo();
    const worktreePath = mkdtempSync(join(tmpdir(), "openclaw-worktree-merge-ff-worktree-"));
    rmSync(worktreePath, { recursive: true, force: true });
    try {
      git(repoDir, "worktree", "add", "-b", "feature", worktreePath);
      writeFileSync(join(worktreePath, "file.txt"), "feature\n", "utf-8");
      git(worktreePath, "commit", "-am", "feature change");

      writeFileSync(join(repoDir, "file.txt"), "local dirty change\n", "utf-8");

      const result = mergeBranch(repoDir, "feature", "main", "merge", worktreePath);

      assert.equal(result.success, true);
      assert.equal(result.fastForward, true);
      assert.equal(result.stashed, true);
      assert.equal(result.stashPopConflict, true);
      assert.ok(result.warnings?.some((warning) => warning.includes("Failed to pop auto-stash after merge")));
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports a recovery warning when rebase-conflict cleanup cannot restore an auto-stash", () => {
    const repoDir = createRepo();
    try {
      git(repoDir, "checkout", "-b", "feature");
      writeFileSync(join(repoDir, "file.txt"), "feature\n", "utf-8");
      writeFileSync(join(repoDir, "local.txt"), "feature\n", "utf-8");
      git(repoDir, "commit", "-am", "feature change");

      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "file.txt"), "main\n", "utf-8");
      writeFileSync(join(repoDir, "local.txt"), "main\n", "utf-8");
      git(repoDir, "commit", "-am", "main change");

      git(repoDir, "checkout", "feature");
      writeFileSync(join(repoDir, "local.txt"), "local dirty change\n", "utf-8");

      const result = mergeBranch(repoDir, "feature", "main");

      assert.equal(result.success, false);
      assert.equal(result.rebaseConflict, true);
      assert.equal(result.stashed, true);
      assert.ok(result.warnings?.some((warning) => warning.includes("Failed to pop auto-stash during recovery")));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
