import "./test-env";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRepoLock } from "../src/git-exec";
import { resolveExistingTargetPrUpdateBranch } from "../src/tools/agent-pr";
import type { PRStatus } from "../src/worktree-pr";

function fixture(t: TestContext, checkedOut: boolean) {
  const root = mkdtempSync(join(tmpdir(), "oca-pr-generation-"));
  const repo = join(root, "repo");
  const targetCheckout = join(root, "pr");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture User");
  git("config", "user.email", "fixture@example.com");
  git("commit", "--allow-empty", "-m", "base");
  git("branch", "feature/pr");
  const before = git("rev-parse", "feature/pr");
  git("switch", "-c", "agent/task");
  writeFileSync(join(repo, "task.txt"), "verified task implementation\n");
  git("add", "task.txt");
  git("commit", "-m", "task implementation");
  git("switch", "main");
  if (checkedOut) git("worktree", "add", targetCheckout, "feature/pr");
  const targetPrStatus: PRStatus = {
    exists: true, state: "open", url: "https://github.com/example/repo/pull/9", number: 9,
    headRefName: "feature/pr", baseRefName: "main", ownHead: true,
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { repo, targetCheckout, targetPrStatus, before, git };
}

describe("PR branch movement rechecks task evidence under the repository lock", () => {
  it("refuses a queued automatic update after its session resumes", async (t) => {
    const f = fixture(t, false);
    let release!: () => void;
    let acquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const held = withRepoLock(f.repo, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await lockAcquired;
    let current = true;
    let refreshed = 0;
    const update = resolveExistingTargetPrUpdateBranch({
      repoDir: f.repo, sourceBranch: "agent/task", targetPrStatus: f.targetPrStatus,
      mutationGuard: { refresh: async () => { refreshed++; return current; }, isCurrent: () => current },
    });
    current = false;
    release();
    await held;
    const result = await update;
    assert.equal(result.success, false);
    if (result.success === false) assert.equal(result.code, "task_not_ready");
    assert.equal(refreshed, 0, "the under-lock metadata check refuses before Git preparation");
    assert.equal(f.git("rev-parse", "feature/pr"), f.before);
  });

  for (const checkedOut of [false, true]) {
    it(`refuses stale evidence immediately before ${checkedOut ? "checked-out branch merge" : "ref update"}`, async (t) => {
      const f = fixture(t, checkedOut);
      let current = true;
      let refreshed = 0;
      const result = await resolveExistingTargetPrUpdateBranch({
        repoDir: f.repo, sourceBranch: "agent/task", targetPrStatus: f.targetPrStatus,
        mutationGuard: {
          refresh: async () => {
            refreshed++;
            // A resume happened while the final async evidence refresh ran;
            // the final synchronous ticket check must reject its old result.
            current = false;
            return true;
          },
          isCurrent: () => current,
        },
      });
      assert.equal(result.success, false);
      if (result.success === false) assert.equal(result.code, "task_not_ready");
      assert.equal(refreshed, 1);
      assert.equal(f.git("rev-parse", "feature/pr"), f.before);
      if (checkedOut) assert.equal(existsSync(join(f.targetCheckout, "task.txt")), false);
    });
  }

  it("retains explicit manual branch-update behavior without an automatic task ticket", async (t) => {
    const f = fixture(t, true);
    const result = await resolveExistingTargetPrUpdateBranch({
      repoDir: f.repo, sourceBranch: "agent/task", targetPrStatus: f.targetPrStatus,
    });
    assert.equal(result.success, true);
    assert.equal(f.git("rev-parse", "feature/pr"), f.git("rev-parse", "agent/task"));
    assert.equal(existsSync(join(f.targetCheckout, "task.txt")), true);
  });
});
