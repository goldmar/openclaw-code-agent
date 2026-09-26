import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describeMergeType, mergeBranch } from "../src/worktree-merge";

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
  it("reports a warning when restoring an auto-stash fails after a successful squash merge", async () => {
    const repoDir = createRepo();
    try {
      git(repoDir, "checkout", "-b", "feature");
      writeFileSync(join(repoDir, "file.txt"), "feature\n", "utf-8");
      git(repoDir, "commit", "-am", "feature change");

      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "file.txt"), "local dirty change\n", "utf-8");

      const result = await mergeBranch(repoDir, "feature", "main", "squash");

      assert.equal(result.success, true);
      assert.equal(result.squash, true);
      assert.equal(describeMergeType(result), "squash commit");
      assert.equal(result.stashed, true);
      assert.equal(result.stashPopConflict, true);
      assert.ok(result.warnings?.some((warning) => warning.includes("Failed to pop auto-stash after merge")));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports a warning when restoring an auto-stash fails after a fast-forward merge", async () => {
    const repoDir = createRepo();
    const worktreePath = mkdtempSync(join(tmpdir(), "openclaw-worktree-merge-ff-worktree-"));
    rmSync(worktreePath, { recursive: true, force: true });
    try {
      git(repoDir, "worktree", "add", "-b", "feature", worktreePath);
      writeFileSync(join(worktreePath, "file.txt"), "feature\n", "utf-8");
      git(worktreePath, "commit", "-am", "feature change");

      writeFileSync(join(repoDir, "file.txt"), "local dirty change\n", "utf-8");

      const result = await mergeBranch(repoDir, "feature", "main", "merge", worktreePath);

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

  it("reports uncommitted changes in the branch's own checkout as a dirty error, not a rebase conflict", async () => {
    const repoDir = createRepo();
    try {
      git(repoDir, "checkout", "-b", "feature");
      writeFileSync(join(repoDir, "file.txt"), "feature\n", "utf-8");
      git(repoDir, "commit", "-am", "feature change");
      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "local.txt"), "main\n", "utf-8");
      git(repoDir, "commit", "-am", "main change");
      git(repoDir, "checkout", "feature");
      writeFileSync(join(repoDir, "file.txt"), "local dirty change\n", "utf-8");

      const result = await mergeBranch(repoDir, "feature", "main");

      assert.equal(result.success, false);
      assert.equal(result.dirtyError, true);
      assert.equal(result.rebaseConflict, undefined);
      assert.equal(git(repoDir, "branch", "--show-current"), "feature");
      assert.equal(readFileSync(join(repoDir, "file.txt"), "utf-8"), "local dirty change\n");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports a real rebase conflict and leaves the checkout where it was", async () => {
    const repoDir = createRepo();
    const worktreePath = join(mkdtempSync(join(tmpdir(), "openclaw-merge-conflict-wt-")), "wt");
    try {
      git(repoDir, "worktree", "add", "-b", "feature", worktreePath);
      writeFileSync(join(worktreePath, "file.txt"), "feature\n", "utf-8");
      git(worktreePath, "commit", "-am", "feature change");
      writeFileSync(join(repoDir, "file.txt"), "main\n", "utf-8");
      git(repoDir, "commit", "-am", "main change");

      const result = await mergeBranch(repoDir, "feature", "main", "merge", worktreePath);

      assert.equal(result.success, false);
      assert.equal(result.rebaseConflict, true);
      assert.equal(git(repoDir, "branch", "--show-current"), "main");
      assert.equal(git(worktreePath, "status", "--porcelain"), "", "the aborted rebase leaves the worktree clean");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("mergeBranch keeps the user's checkout (B4)", () => {
  function setup(): { repoDir: string; worktreePath: string } {
    const repoDir = createRepo();
    const worktreePath = join(mkdtempSync(join(tmpdir(), "openclaw-merge-user-wt-")), "wt");
    git(repoDir, "worktree", "add", "-b", "agent/task", worktreePath);
    writeFileSync(join(worktreePath, "task.txt"), "task\n", "utf-8");
    git(worktreePath, "add", "task.txt");
    git(worktreePath, "commit", "-m", "task");
    // The user works on another branch, with uncommitted changes.
    git(repoDir, "checkout", "-b", "feature-x");
    writeFileSync(join(repoDir, "local.txt"), "user work in progress\n", "utf-8");
    return { repoDir, worktreePath };
  }

  for (const strategy of ["merge", "squash"] as const) {
    it(`${strategy}: lands on base without switching or touching the user's checkout`, async () => {
      const { repoDir, worktreePath } = setup();
      try {
        // Base moved on since the branch was created, so `merge` must rebase.
        git(repoDir, "switch", "-q", "main");
        writeFileSync(join(repoDir, "base.txt"), "base moved\n", "utf-8");
        git(repoDir, "add", "base.txt");
        git(repoDir, "commit", "-m", "base moved");
        git(repoDir, "switch", "-q", "feature-x");

        const result = await mergeBranch(repoDir, "agent/task", "main", strategy, worktreePath);

        assert.equal(result.success, true, result.error);
        assert.equal(result.stashed, undefined, "nothing of the user's is stashed");
        assert.equal(git(repoDir, "branch", "--show-current"), "feature-x");
        assert.equal(readFileSync(join(repoDir, "local.txt"), "utf-8"), "user work in progress\n");
        assert.match(git(repoDir, "log", "--format=%s", "main"), strategy === "squash" ? /Squash merge agent\/task/ : /^task$/m);
        assert.equal(git(repoDir, "show", "main:task.txt"), "task");
        assert.equal(git(repoDir, "show", "main:base.txt"), "base moved");
      } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  }

  it("rebases in a temporary worktree when the session worktree is gone", async () => {
    const { repoDir, worktreePath } = setup();
    try {
      git(repoDir, "worktree", "remove", "--force", worktreePath);
      git(repoDir, "switch", "-q", "main");
      writeFileSync(join(repoDir, "base.txt"), "base moved\n", "utf-8");
      git(repoDir, "add", "base.txt");
      git(repoDir, "commit", "-m", "base moved");
      git(repoDir, "switch", "-q", "feature-x");

      const result = await mergeBranch(repoDir, "agent/task", "main", "merge");

      assert.equal(result.success, true, result.error);
      assert.equal(git(repoDir, "branch", "--show-current"), "feature-x");
      assert.equal(git(repoDir, "show", "main:task.txt"), "task");
      assert.doesNotMatch(git(repoDir, "worktree", "list"), /oca-merge-/, "the temporary worktree is removed");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reports a dirty session worktree instead of a rebase conflict", async () => {
    const { repoDir, worktreePath } = setup();
    try {
      git(repoDir, "switch", "-q", "main");
      writeFileSync(join(repoDir, "base.txt"), "base moved\n", "utf-8");
      git(repoDir, "add", "base.txt");
      git(repoDir, "commit", "-m", "base moved");
      writeFileSync(join(worktreePath, "file.txt"), "uncommitted agent change\n", "utf-8");

      const result = await mergeBranch(repoDir, "agent/task", "main", "merge", worktreePath);

      assert.equal(result.success, false);
      assert.equal(result.dirtyError, true);
      assert.equal(result.rebaseConflict, undefined);
      assert.match(result.error ?? "", /uncommitted changes/);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("never rebases the branch a switched session worktree now has (it rebases the session branch elsewhere)", async () => {
    const { repoDir, worktreePath } = setup();
    try {
      git(repoDir, "switch", "-q", "main");
      writeFileSync(join(repoDir, "base.txt"), "base moved\n", "utf-8");
      git(repoDir, "add", "base.txt");
      git(repoDir, "commit", "-m", "base moved");
      git(worktreePath, "switch", "-q", "-c", "other-work");
      const otherHead = git(worktreePath, "rev-parse", "HEAD");

      const result = await mergeBranch(repoDir, "agent/task", "main", "merge", worktreePath);

      assert.equal(result.success, true, result.error);
      assert.equal(git(worktreePath, "rev-parse", "other-work"), otherHead, "the unrelated branch is untouched");
      assert.equal(git(repoDir, "show", "main:task.txt"), "task");
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("runs commit hooks for a squash even when base is not checked out anywhere", async () => {
    const { repoDir, worktreePath } = setup();
    try {
      mkdirSync(join(repoDir, ".git", "hooks"), { recursive: true });
      const marker = join(repoDir, "..", `${basename(repoDir)}-hook-ran`);
      writeFileSync(join(repoDir, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });

      const result = await mergeBranch(repoDir, "agent/task", "main", "squash", worktreePath);

      assert.equal(result.success, true, result.error);
      assert.equal(git(repoDir, "branch", "--show-current"), "feature-x");
      assert.equal(existsSync(marker), true, "the pre-commit hook ran");
      assert.match(git(repoDir, "log", "--format=%s", "-1", "main"), /Squash merge agent\/task/);
      assert.doesNotMatch(git(repoDir, "worktree", "list"), /oca-merge-/);
      rmSync(marker, { force: true });
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("warns before rebasing a branch that was already pushed", async () => {
    const { repoDir, worktreePath } = setup();
    const remote = mkdtempSync(join(tmpdir(), "openclaw-merge-remote-"));
    try {
      git(remote, "init", "--bare", "-b", "main");
      git(repoDir, "remote", "add", "origin", remote);
      git(repoDir, "push", "-q", "origin", "agent/task");
      git(repoDir, "switch", "-q", "main");
      writeFileSync(join(repoDir, "base.txt"), "base moved\n", "utf-8");
      git(repoDir, "add", "base.txt");
      git(repoDir, "commit", "-m", "base moved");

      const result = await mergeBranch(repoDir, "agent/task", "main", "merge", worktreePath);

      assert.equal(result.success, true, result.error);
      assert.ok(result.warnings?.some((warning) => /already pushed/.test(warning)), JSON.stringify(result.warnings));
    } finally {
      rmSync(remote, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("describeMergeType", () => {
  it("names fast-forward, squash, and merge-commit outcomes", () => {
    assert.equal(describeMergeType({ fastForward: true }), "fast-forward");
    assert.equal(describeMergeType({ squash: true }), "squash commit");
    assert.equal(describeMergeType({}), "merge commit");
  });
});
