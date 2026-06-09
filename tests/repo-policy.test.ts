import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRepoProvider,
  normalizeRemoteUrl,
  resolveWorktreePolicyDecision,
  seededRepoPolicy,
  resolveRepoIdentity,
} from "../src/repo-policy";
import { SessionWorktreeActionService } from "../src/session-worktree-action-service";
import { createWorktree, getBranchName } from "../src/worktree";
import { SessionManager } from "../src/session-manager";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createRepoWithWorktree(name: string) {
  const repoDir = mkdtempSync(join(tmpdir(), `openclaw-policy-${name}-`));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  const worktreePath = createWorktree(repoDir, name);
  const branchName = getBranchName(worktreePath);
  assert.ok(branchName);
  writeFileSync(join(worktreePath, "feature.txt"), "feature\n", "utf-8");
  git(worktreePath, "add", "feature.txt");
  git(worktreePath, "commit", "-m", "feature");
  return { repoDir, worktreePath, branchName };
}

describe("repo policy resolution", () => {
  it("normalizes GitHub remotes and detects unsupported providers", () => {
    assert.equal(normalizeRemoteUrl("git@github.com:Goldmar/OpenClaw-Code-Agent.git"), "https://github.com/goldmar/openclaw-code-agent");
    assert.equal(detectRepoProvider("https://github.com/goldmar/openclaw-code-agent"), "github");
    assert.equal(detectRepoProvider("https://gitlab.com/example/repo"), "unsupported");
  });

  it("blocks first worktree launch when repo policy is unknown", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-unknown-"));
    const storeDir = mkdtempSync(join(tmpdir(), "openclaw-policy-store-"));
    try {
      git(repoDir, "init", "-b", "main");
      const sm = new SessionManager(1, 10, { store: { indexPath: join(storeDir, "sessions.json") } });
      const result = sm.checkRepoPolicyForLaunch(repoDir, "delegate");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.text, /Repo integration policy is not set/);
        assert.match(result.text, /agent_repo_policy/);
      }
      sm.dispose();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("seeds openclaw-code-agent as PR-required", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-policy-seed-"));
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "remote", "add", "origin", "https://github.com/goldmar/openclaw-code-agent.git");
      const identity = resolveRepoIdentity(repoDir);
      assert.ok(identity);
      assert.equal(seededRepoPolicy(identity), "pr-required");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("downgrades or blocks requested strategies according to policy and PR capability", () => {
    assert.deepEqual(
      resolveWorktreePolicyDecision({ requestedStrategy: "auto-merge", policy: "pr-required", prAvailable: true }),
      {
        strategy: "auto-pr",
        reason: "Repo policy requires a PR; auto-merge was downgraded to auto-pr.",
        allowedActions: { merge: false, pr: true },
      },
    );
    assert.equal(
      resolveWorktreePolicyDecision({ requestedStrategy: "auto-merge", policy: "pr-required", prAvailable: false }).blocked,
      true,
    );
    assert.equal(
      resolveWorktreePolicyDecision({ requestedStrategy: "auto-pr", policy: "never-pr", prAvailable: true }).strategy,
      "ask",
    );
  });
});

describe("SessionWorktreeActionService repo policy planning", () => {
  it("turns auto-merge into auto-pr for PR-required repos when PRs are available", async () => {
    const { repoDir, worktreePath, branchName } = createRepoWithWorktree("auto-pr-required");
    try {
      const service = new SessionWorktreeActionService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: () => repoDir,
        getWorktreeCompletionState: () => "has-commits",
        isPrAvailable: () => true,
      });
      const action = await service.plan({
        id: "s-policy-pr",
        name: "policy-pr",
        status: "completed",
        lifecycle: "active",
        phase: "implementing",
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "auto-merge",
        repoIntegrationPolicy: "pr-required",
        originalWorkdir: repoDir,
        harnessSessionId: "h-policy-pr",
      } as any);
      assert.equal(action.kind, "decision");
      if (action.kind === "decision") {
        assert.equal(action.strategy, "auto-pr");
        assert.equal(action.allowedActions.merge, false);
        assert.equal(action.allowedActions.pr, true);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("blocks auto-merge for PR-required repos when PRs are unavailable", async () => {
    const { repoDir, worktreePath, branchName } = createRepoWithWorktree("pr-unavailable");
    try {
      const service = new SessionWorktreeActionService({
        shouldRunWorktreeStrategy: () => true,
        isAlreadyMerged: () => false,
        resolveWorktreeRepoDir: () => repoDir,
        getWorktreeCompletionState: () => "has-commits",
        isPrAvailable: () => false,
      });
      const action = await service.plan({
        id: "s-policy-block",
        name: "policy-block",
        status: "completed",
        lifecycle: "active",
        phase: "implementing",
        worktreePath,
        worktreeBranch: branchName,
        worktreeStrategy: "auto-merge",
        repoIntegrationPolicy: "pr-required",
        originalWorkdir: repoDir,
        harnessSessionId: "h-policy-block",
      } as any);
      assert.equal(action.kind, "decision");
      if (action.kind === "decision") {
        assert.equal(action.policyBlocked, true);
        assert.equal(action.allowedActions.merge, false);
        assert.equal(action.allowedActions.pr, false);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
