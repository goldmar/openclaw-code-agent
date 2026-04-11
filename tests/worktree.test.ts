import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock execFileSync for testing
const originalExecFileSync = execFileSync;

describe("worktree utilities", () => {
  it("should export required functions", async () => {
    const worktree = await import("../src/worktree.js");
    assert.ok(typeof worktree.isGitAvailable === "function");
    assert.ok(typeof worktree.isGitHubCLIAvailable === "function");
    assert.ok(typeof worktree.getBranchName === "function");
    assert.ok(typeof worktree.hasCommitsAhead === "function");
    assert.ok(typeof worktree.getDiffSummary === "function");
    assert.ok(typeof worktree.pushBranch === "function");
    assert.ok(typeof worktree.mergeBranch === "function");
    assert.ok(typeof worktree.createPR === "function");
    assert.ok(typeof worktree.deleteBranch === "function");
    assert.ok(typeof worktree.hasEnoughWorktreeSpace === "function");
    assert.ok(typeof worktree.checkDirtyTracked === "function");
    assert.ok(typeof worktree.isBranchAncestorOfBase === "function");
    assert.ok(typeof worktree.getAheadBehindCounts === "function");
    assert.ok(typeof worktree.wouldMergeBeNoop === "function");
    assert.ok(typeof worktree.resolveWorktreeLifecycle === "function");
    assert.ok(typeof worktree.resolveTargetRepo === "function");
    assert.ok(typeof worktree.formatWorktreeOutcomeLine === "function");
  });
});

describe("formatWorktreeOutcomeLine", () => {
  it("formats merge outcome with stats", async () => {
    const { formatWorktreeOutcomeLine } = await import("../src/worktree.js");
    const result = formatWorktreeOutcomeLine({
      kind: "merge",
      branch: "agent/fix-auth",
      base: "main",
      filesChanged: 3,
      insertions: 45,
      deletions: 12,
    });
    assert.ok(result.includes("Merged"));
    assert.ok(result.includes("agent/fix-auth"));
    assert.ok(result.includes("main"));
    assert.ok(result.includes("3 files"));
    assert.ok(result.includes("+45/-12"));
  });

  it("formats merge outcome without stats", async () => {
    const { formatWorktreeOutcomeLine } = await import("../src/worktree.js");
    const result = formatWorktreeOutcomeLine({
      kind: "merge",
      branch: "agent/fix-auth",
      base: "main",
    });
    assert.ok(result.includes("Merged"));
    assert.ok(result.includes("agent/fix-auth → main"));
    assert.ok(!result.includes("files"));
  });

  it("formats pr-opened outcome for same-repo PR", async () => {
    const { formatWorktreeOutcomeLine } = await import("../src/worktree.js");
    const result = formatWorktreeOutcomeLine({
      kind: "pr-opened",
      branch: "agent/fix-auth",
      prUrl: "https://github.com/myorg/myrepo/pull/42",
    });
    assert.ok(result.includes("PR opened"));
    assert.ok(result.includes("https://github.com/myorg/myrepo/pull/42"));
    assert.ok(!result.includes("against"));
  });

  it("formats pr-opened outcome for cross-repo PR", async () => {
    const { formatWorktreeOutcomeLine } = await import("../src/worktree.js");
    const result = formatWorktreeOutcomeLine({
      kind: "pr-opened",
      branch: "agent/fix-auth",
      targetRepo: "openai/codex",
      prUrl: "https://github.com/openai/codex/pull/99",
    });
    assert.ok(result.includes("PR opened against openai/codex"));
    assert.ok(result.includes("https://github.com/openai/codex/pull/99"));
  });

  it("formats pr-updated outcome", async () => {
    const { formatWorktreeOutcomeLine } = await import("../src/worktree.js");
    const result = formatWorktreeOutcomeLine({
      kind: "pr-updated",
      branch: "agent/fix-auth",
      prUrl: "https://github.com/myorg/myrepo/pull/42",
    });
    assert.ok(result.includes("PR updated"));
    assert.ok(result.includes("https://github.com/myorg/myrepo/pull/42"));
  });
});

describe("worktree base dir and PR target resolution", () => {
  it("defaults the worktree base dir to <repo>/.worktrees", async () => {
    const { getWorktreeBaseDir } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-basedir-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      const canonicalRoot = execFileSync("git", ["-C", repoDir, "rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      assert.equal(getWorktreeBaseDir(repoDir), join(canonicalRoot, ".worktrees"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("checks free space against the repo root before the first .worktrees directory exists", async () => {
    const { getWorktreeSpaceProbePath } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-space-first-run-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      const canonicalRoot = execFileSync("git", ["-C", repoDir, "rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      assert.equal(getWorktreeSpaceProbePath(repoDir), canonicalRoot);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("walks up to the nearest existing ancestor for custom worktree dirs", async () => {
    const { getWorktreeSpaceProbePath } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-space-custom-"));
    const previousWorktreeDir = process.env.OPENCLAW_WORKTREE_DIR;

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      const existingParent = join(repoDir, "custom-worktrees");
      mkdirSync(existingParent);
      writeFileSync(join(existingParent, ".gitkeep"), "", { encoding: "utf-8", flag: "w" });
      process.env.OPENCLAW_WORKTREE_DIR = join(existingParent, "nested", "agent-worktrees");
      assert.equal(getWorktreeSpaceProbePath(repoDir), existingParent);
    } finally {
      if (previousWorktreeDir === undefined) {
        delete process.env.OPENCLAW_WORKTREE_DIR;
      } else {
        process.env.OPENCLAW_WORKTREE_DIR = previousWorktreeDir;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("applies the 100 MB worktree free-space threshold", async () => {
    const { hasEnoughFreeBytes } = await import("../src/worktree.js");
    assert.equal(hasEnoughFreeBytes(99 * 1024 * 1024), false);
    assert.equal(hasEnoughFreeBytes(100 * 1024 * 1024), true);
    assert.equal(hasEnoughFreeBytes(500 * 1024 * 1024), true);
  });

  it("prefers an explicit PR target repo override", async () => {
    const { resolveTargetRepo } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-target-explicit-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:me/fork.git"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "upstream", "git@github.com:openai/codex.git"], { cwd: repoDir, stdio: "ignore" });
      assert.equal(resolveTargetRepo(repoDir, "custom/target"), "custom/target");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("uses upstream as the PR target when origin and upstream differ", async () => {
    const { resolveTargetRepo } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-target-upstream-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:me/fork.git"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "upstream", "git@github.com:openai/codex.git"], { cwd: repoDir, stdio: "ignore" });
      assert.equal(resolveTargetRepo(repoDir), "openai/codex");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("uses upstream as the PR target even when origin is missing", async () => {
    const { resolveTargetRepo } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-target-upstream-only-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "upstream", "git@github.com:openai/codex.git"], { cwd: repoDir, stdio: "ignore" });
      assert.equal(resolveTargetRepo(repoDir), "openai/codex");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("returns undefined when no usable upstream target exists", async () => {
    const { resolveTargetRepo } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-target-none-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:me/fork.git"], { cwd: repoDir, stdio: "ignore" });
      assert.equal(resolveTargetRepo(repoDir), undefined);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("removeWorktree", () => {
  it("refuses implicit cleanup for dirty worktrees but allows explicit destructive cleanup", async () => {
    const { createWorktree, removeWorktree } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-cleanup-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "OpenClaw Tests"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "base\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

      const worktreePath = createWorktree(repoDir, "dirty-cleanup");
      writeFileSync(join(worktreePath, "notes.txt"), "untracked\n");

      assert.equal(removeWorktree(repoDir, worktreePath), false);
      assert.equal(existsSync(worktreePath), true);

      assert.equal(removeWorktree(repoDir, worktreePath, { destructive: true }), true);
      assert.equal(existsSync(worktreePath), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
