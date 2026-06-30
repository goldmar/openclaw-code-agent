import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveWorktreeLifecycle } from "../src/worktree-lifecycle-resolver";

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

describe("resolveWorktreeLifecycle", () => {
  it("treats persisted sessions without a workdir as repo missing", () => {
    const resolved = resolveWorktreeLifecycle({
      workdir: undefined,
      worktreeBranch: "agent/missing-workdir",
      worktreeLifecycle: {
        state: "pending_decision",
        updatedAt: new Date().toISOString(),
      },
    } as any);

    assert.equal(resolved.evidence.repoExists, false);
    assert.equal(resolved.derivedState, "cleanup_failed");
    assert.ok(resolved.reasons.includes("repo_missing"));
    assert.ok(resolved.reasons.includes("base_branch_missing"));
  });

  it("detects topology-merged branches as merged", () => {
    const repoDir = initRepo("resolver-merged-");
    try {
      git(repoDir, "checkout", "-b", "agent/merged");
      writeFileSync(join(repoDir, "feature.txt"), "merged\n", "utf-8");
      git(repoDir, "add", "feature.txt");
      git(repoDir, "commit", "-m", "feat: merged");
      git(repoDir, "checkout", "main");
      git(repoDir, "merge", "--ff-only", "agent/merged");

      const resolved = resolveWorktreeLifecycle({
        workdir: repoDir,
        worktreeBranch: "agent/merged",
      });

      assert.equal(resolved.derivedState, "merged");
      assert.equal(resolved.cleanupSafe, true);
      assert.ok(resolved.reasons.includes("topology_merged"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("treats stale pending decisions as cleanup-safe after repository merge evidence", () => {
    const repoDir = initRepo("resolver-pending-merged-");
    try {
      git(repoDir, "checkout", "-b", "agent/pending-merged");
      writeFileSync(join(repoDir, "feature.txt"), "merged\n", "utf-8");
      git(repoDir, "add", "feature.txt");
      git(repoDir, "commit", "-m", "feat: pending merged");
      git(repoDir, "checkout", "main");
      git(repoDir, "merge", "--ff-only", "agent/pending-merged");

      const resolved = resolveWorktreeLifecycle({
        workdir: repoDir,
        worktreeBranch: "agent/pending-merged",
        worktreeLifecycle: {
          state: "pending_decision",
          updatedAt: new Date().toISOString(),
        },
      });

      assert.equal(resolved.derivedState, "merged");
      assert.equal(resolved.cleanupSafe, true);
      assert.equal(resolved.preserve, false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not derive merged while a matching session is still active", () => {
    const repoDir = initRepo("resolver-active-merged-");
    try {
      git(repoDir, "checkout", "-b", "agent/active-merged");
      writeFileSync(join(repoDir, "feature.txt"), "merged\n", "utf-8");
      git(repoDir, "add", "feature.txt");
      git(repoDir, "commit", "-m", "feat: active merged");
      git(repoDir, "checkout", "main");
      git(repoDir, "merge", "--ff-only", "agent/active-merged");

      const resolved = resolveWorktreeLifecycle({
        workdir: repoDir,
        worktreeBranch: "agent/active-merged",
        worktreeLifecycle: {
          state: "provisioned",
          updatedAt: new Date().toISOString(),
        },
      }, { activeSession: true });

      assert.equal(resolved.derivedState, "provisioned");
      assert.equal(resolved.cleanupSafe, false);
      assert.equal(resolved.preserve, true);
      assert.ok(resolved.reasons.includes("active_session"));
      assert.ok(resolved.reasons.includes("topology_merged"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not derive merged while the worktree has dirty entries", () => {
    const repoDir = initRepo("resolver-dirty-merged-");
    try {
      git(repoDir, "checkout", "-b", "agent/dirty-merged");
      writeFileSync(join(repoDir, "feature.txt"), "merged\n", "utf-8");
      git(repoDir, "add", "feature.txt");
      git(repoDir, "commit", "-m", "feat: dirty merged");
      git(repoDir, "checkout", "main");
      git(repoDir, "merge", "--ff-only", "agent/dirty-merged");
      writeFileSync(join(repoDir, "dirty.txt"), "uncommitted\n", "utf-8");

      const resolved = resolveWorktreeLifecycle({
        workdir: repoDir,
        worktreePath: repoDir,
        worktreeBranch: "agent/dirty-merged",
        worktreeLifecycle: {
          state: "provisioned",
          updatedAt: new Date().toISOString(),
        },
      });

      assert.equal(resolved.derivedState, "provisioned");
      assert.equal(resolved.cleanupSafe, false);
      assert.equal(resolved.preserve, true);
      assert.ok(resolved.reasons.includes("dirty_worktree_entries"));
      assert.ok(resolved.reasons.includes("topology_merged"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("detects cherry-picked branch content as released", () => {
    const repoDir = initRepo("resolver-released-cherry-");
    try {
      git(repoDir, "checkout", "-b", "agent/released");
      writeFileSync(join(repoDir, "feature.txt"), "released\n", "utf-8");
      git(repoDir, "add", "feature.txt");
      git(repoDir, "commit", "-m", "feat: released");
      const branchCommit = git(repoDir, "rev-parse", "HEAD");

      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "main-only.txt"), "main first\n", "utf-8");
      git(repoDir, "add", "main-only.txt");
      git(repoDir, "commit", "-m", "main diverges");
      git(repoDir, "cherry-pick", branchCommit);

      const resolved = resolveWorktreeLifecycle({
        workdir: repoDir,
        worktreeBranch: "agent/released",
      });

      assert.equal(resolved.derivedState, "released");
      assert.equal(resolved.cleanupSafe, true);
      assert.ok(resolved.reasons.includes("merge_noop_content_already_on_base"));
      assert.ok(!resolved.reasons.includes("topology_merged"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("keeps released detection true when base has unrelated extra commits", () => {
    const repoDir = initRepo("resolver-released-extra-");
    try {
      git(repoDir, "checkout", "-b", "agent/released-extra");
      writeFileSync(join(repoDir, "feature.txt"), "released\n", "utf-8");
      git(repoDir, "add", "feature.txt");
      git(repoDir, "commit", "-m", "feat: released");

      git(repoDir, "checkout", "main");
      git(repoDir, "merge", "--squash", "agent/released-extra");
      git(repoDir, "commit", "-m", "squash released-extra");
      writeFileSync(join(repoDir, "other.txt"), "main only\n", "utf-8");
      git(repoDir, "add", "other.txt");
      git(repoDir, "commit", "-m", "main extra");

      const resolved = resolveWorktreeLifecycle({
        workdir: repoDir,
        worktreeBranch: "agent/released-extra",
      });

      assert.equal(resolved.derivedState, "released");
      assert.equal(resolved.cleanupSafe, true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not classify partially landed content as released", () => {
    const repoDir = initRepo("resolver-not-released-");
    try {
      git(repoDir, "checkout", "-b", "agent/not-released");
      writeFileSync(join(repoDir, "a.txt"), "A\n", "utf-8");
      writeFileSync(join(repoDir, "b.txt"), "B\n", "utf-8");
      git(repoDir, "add", "a.txt", "b.txt");
      git(repoDir, "commit", "-m", "feat: two files");

      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "a.txt"), "A\n", "utf-8");
      git(repoDir, "add", "a.txt");
      git(repoDir, "commit", "-m", "partial landing");

      const resolved = resolveWorktreeLifecycle({
        workdir: repoDir,
        worktreeBranch: "agent/not-released",
      });

      assert.notEqual(resolved.derivedState, "released");
      assert.equal(resolved.cleanupSafe, false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not preserve stale PR state without current open PR evidence", () => {
    const repoDir = initRepo("resolver-pr-open-");
    try {
      git(repoDir, "checkout", "-b", "agent/pr-open");
      writeFileSync(join(repoDir, "feature.txt"), "released\n", "utf-8");
      git(repoDir, "add", "feature.txt");
      git(repoDir, "commit", "-m", "feat: pr open");
      const branchCommit = git(repoDir, "rev-parse", "HEAD");

      git(repoDir, "checkout", "main");
      writeFileSync(join(repoDir, "main-only.txt"), "main first\n", "utf-8");
      git(repoDir, "add", "main-only.txt");
      git(repoDir, "commit", "-m", "main diverges");
      git(repoDir, "cherry-pick", branchCommit);

      const resolved = resolveWorktreeLifecycle({
        workdir: repoDir,
        worktreeBranch: "agent/pr-open",
        worktreePrUrl: "https://github.com/example/repo/pull/1",
        worktreeLifecycle: {
          state: "pr_open",
          updatedAt: new Date().toISOString(),
        },
      });

      assert.equal(resolved.derivedState, "released");
      assert.equal(resolved.preserve, false);
      assert.equal(resolved.cleanupSafe, true);
      assert.equal(resolved.evidence.prState, "none");
      assert.equal(resolved.reasons.includes("pr_open"), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
