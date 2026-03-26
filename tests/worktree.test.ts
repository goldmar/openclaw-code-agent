import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { execFileSync } from "child_process";

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
