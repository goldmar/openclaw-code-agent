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
  });
});
