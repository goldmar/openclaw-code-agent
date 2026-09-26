import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBranchName, assertBranchOrRemoteTrackingRef, branchNameValidationError, targetRepoValidationError } from "../src/worktree-ref-validation";
import { resolveTargetRepo } from "../src/worktree-repo";
import { branchExists, deleteBranch, fetchRemoteBranchRef, getAheadBehindCounts, getDiffSummary, getCommitsAheadCount, isBranchAncestorOfBase, wouldMergeBeNoop, mergeBranch, pushBranch } from "../src/worktree";
import { makeAgentLaunchTool } from "../src/tools/agent-launch";
import { makeAgentMergeTool } from "../src/tools/agent-merge";
import { makeAgentPrTool } from "../src/tools/agent-pr";
import { makeAgentWorktreeCleanupTool } from "../src/tools/agent-worktree-cleanup";
import { setSessionManager } from "../src/singletons";
import { prepareSessionBootstrap } from "../src/session-bootstrap";

const invalid: unknown[] = [null, 3, {}, [], "", " main", "main ", "a\nb", "a\0b", "-f", "--exec=touch /tmp/oca-unwanted", "main~1", "main^", "main..other", "main:other", "@{-1}", "@", "a@{1}", "a//b", "/main", "a.lock", "a/.hidden", "main/", "HEAD", "refs/heads/main", "refs/remotes/origin/main", "refs/tags/v1"];

describe("literal worktree ref boundary", () => {
  afterEach(() => setSessionManager(null as any));

  it("rejects options, revision syntax, malformed refs and nonstring runtime input", async () => {
    for (const value of invalid) await assert.rejects(async () => await assertBranchName(value), /literal Git branch|valid literal/);
    for (const value of ["main", "feature/security-fix", "release/2026.9", "refs/feature", "refs/feature/topic", "refs/heads-up"]) {
      assert.equal(await branchNameValidationError(value), undefined);
    }
  });

  it("accepts only OWNER/REPO or HOST/OWNER/REPO PR target repositories (N5)", async () => {
    for (const value of ["octo-org/octo-repo", "a/b", "octo/repo.name_1", "github.example.com/octo/repo"]) {
      assert.equal(targetRepoValidationError(value), undefined, value);
    }
    const badRepos: unknown[] = [undefined, 3, "", "repo", "-R/x", "--repo=evil/x", "octo/-x", "octo/..", "octo/.", "-octo/repo", "octo-/repo",
      "octo/repo/extra/more", "https://github.com/octo/repo", "octo/repo.git", "octo /repo", "octo/re po", "octo/repo\n", "octo--org/repo"];
    for (const value of badRepos) assert.match(targetRepoValidationError(value) ?? "", /OWNER\/REPO/, String(value));
    await assert.rejects(async () => await resolveTargetRepo("/nonexistent", "--repo=evil/x"), /Invalid PR target repository/);

    setSessionManager(new Proxy({}, { get() { throw new Error("session manager must not be reached"); } }) as any);
    const pr = await makeAgentPrTool().execute("test", { session: "test", target_repo: "--web" });
    assert.match(pr.content[0].text, /Error: target_repo: Expected a GitHub repository/);
    const launch = await makeAgentLaunchTool({} as any).execute("test", { prompt: "test", worktree_pr_target_repo: "octo/repo --web" });
    assert.match(launch.content[0].text, /Error: worktree_pr_target_repo: Expected a GitHub repository/);
  });

  it("permits computed remote-tracking refs only at read-only comparison boundaries", async () => {
    await assert.doesNotReject(async () => await assertBranchOrRemoteTrackingRef("refs/remotes/origin/main"));
    await assert.rejects(async () => await assertBranchOrRemoteTrackingRef("refs/remotes/origin/bad..ref"), /valid literal Git branch or remote-tracking ref/);
    await assert.rejects(async () => await assertBranchOrRemoteTrackingRef("refs/heads/main"), /literal Git branch/);
    await assert.rejects(async () => await assertBranchOrRemoteTrackingRef("refs/tags/v1"), /literal Git branch/);
  });

  it("rejects direct tool calls before session resolution or launch", async () => {
    setSessionManager(new Proxy({}, { get() { throw new Error("session manager must not be reached"); } }) as any);
    for (const value of invalid) {
      for (const [tool, params] of [
        [makeAgentLaunchTool({} as any), { prompt: "test", worktree_base_branch: value }],
        [makeAgentMergeTool(), { session: "test", base_branch: value }],
        [makeAgentPrTool(), { session: "test", base_branch: value }],
        [makeAgentWorktreeCleanupTool(), { base_branch: value }],
      ] as const) {
        const result = await tool.execute("test", params);
        assert.match(result.content[0].text, /Error: Expected/);
      }
    }
  });

  it("blocks unsafe persisted refs at shared helpers before any repository operation", async () => {
    const missingRepo = "/does-not-exist/oca-ref-test";
    await assert.rejects(async () => await mergeBranch(missingRepo, "agent/test", "--exec=touch sentinel"), /literal Git branch/);
    await assert.rejects(async () => await pushBranch(missingRepo, "--all"), /literal Git branch/);
    await assert.rejects(async () => await pushBranch(missingRepo, "main", "--receive-pack=command"), /literal Git branch/);
    await assert.rejects(async () => await fetchRemoteBranchRef(missingRepo, "main:other"), /valid literal/);
    await assert.rejects(async () => await fetchRemoteBranchRef(missingRepo, "main", "--upload-pack=command"), /literal Git branch/);
    await assert.rejects(async () => await branchExists(missingRepo, "--help"), /literal Git branch/);
    await assert.rejects(async () => await deleteBranch(missingRepo, "--all"), /literal Git branch/);
    await assert.rejects(async () => await getDiffSummary(missingRepo, "main", "--output=sentinel"), /literal Git branch/);
    await assert.rejects(async () => await getAheadBehindCounts(missingRepo, "main", "main~1"), /valid literal/);
    await assert.rejects(async () => await prepareSessionBootstrap({ worktreeBaseBranch: "--exec=command" } as any, "test", () => undefined), /literal Git branch/);
  });

  it("merges refs-prefixed local branches without accepting full refs or detaching HEAD", async () => {
    const repo = mkdtempSync(join(tmpdir(), "oca-local-refs-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "-b", "refs/base");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      git("commit", "--allow-empty", "-m", "base");
      const base = git("rev-parse", "HEAD");
      git("checkout", "-b", "refs/feature");
      writeFileSync(join(repo, "file"), "change");
      git("add", "file");
      git("commit", "-m", "change");
      const head = git("rev-parse", "HEAD");
      git("update-ref", "refs/feature", base);
      git("update-ref", "refs/base", head);
      git("update-ref", "refs/shadow-only", base);
      git("update-ref", "refs/remotes/origin/main", base);
      git("tag", "v1", base);
      assert.equal(await branchExists(repo, "refs/shadow-only"), false);
      assert.deepEqual(await getAheadBehindCounts(repo, "refs/feature", "refs/base"), { ahead: 1, behind: 0 });
      assert.equal(await getCommitsAheadCount(repo, "refs/feature", "refs/base"), 1);
      assert.equal((await getDiffSummary(repo, "refs/feature", "refs/base"))?.commits, 1);
      assert.equal(await isBranchAncestorOfBase(repo, "refs/base", "refs/feature"), true);
      assert.equal(await isBranchAncestorOfBase(repo, "refs/feature", "refs/base"), false);
      assert.equal(await wouldMergeBeNoop(repo, "refs/feature", "refs/base"), false);
      for (const fullRef of ["refs/heads/refs/base", "refs/remotes/origin/main", "refs/tags/v1"]) {
        await assert.rejects(async () => await mergeBranch(repo, "refs/feature", fullRef), /literal Git branch/);
        assert.equal(git("symbolic-ref", "HEAD"), "refs/heads/refs/feature");
        assert.equal(git("rev-parse", "HEAD"), head);
        assert.equal(git("rev-parse", "refs/heads/refs/base"), base);
      }
      git("checkout", "refs/base");
      assert.equal(await branchExists(repo, "refs/feature"), true);
      assert.equal((await mergeBranch(repo, "refs/feature", "refs/base")).success, true);
      assert.equal(git("symbolic-ref", "HEAD"), "refs/heads/refs/base");
      assert.equal(git("rev-parse", "refs/heads/refs/base"), head);
      assert.equal(git("rev-parse", "refs/feature"), base);
      // A local bare remote exercises refspec resolution without network access.
      const remote = join(repo, "remote.git");
      git("init", "--bare", remote);
      git("remote", "add", "origin", remote);
      assert.equal(await pushBranch(repo, "refs/feature"), true);
      assert.equal(git("--git-dir", remote, "rev-parse", "refs/heads/refs/feature"), head);
      git("--git-dir", remote, "update-ref", "refs/feature", base);
      assert.equal(await fetchRemoteBranchRef(repo, "refs/feature"), "refs/remotes/origin/refs/feature");
      assert.equal(git("rev-parse", "refs/remotes/origin/refs/feature"), head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("merges a valid slash branch with cwd metacharacters without shell interpretation", async () => {
    const repo = mkdtempSync(join(tmpdir(), "oca-ref-$(literal); space-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      writeFileSync(join(repo, "file"), "base");
      git("add", "file");
      git("commit", "-m", "base");
      git("checkout", "-b", "feature/security-fix");
      git("branch", "--set-upstream-to=main");
      writeFileSync(join(repo, "file"), "change");
      git("commit", "-am", "change");
      const head = git("rev-parse", "HEAD");
      // The pre-fix helper runs this as git rebase --exec, creates the marker,
      // and then reports failure when checkout rejects the bogus base branch.
      await assert.rejects(async () => await mergeBranch(repo, "feature/security-fix", "--exec=touch oca-injection-marker"), /literal Git branch/);
      assert.equal(existsSync(join(repo, "oca-injection-marker")), false);
      assert.equal(git("rev-parse", "HEAD"), head);
      git("checkout", "main");
      assert.equal((await mergeBranch(repo, "feature/security-fix", "main")).success, true);
      assert.equal(git("rev-parse", "main"), head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
