import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
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

describe("createPR", () => {
  function installMockGh(t: import("node:test").TestContext, options: { failOnDraft?: boolean } = {}) {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-gh-"));
    const binDir = join(tempDir, "bin");
    const logPath = join(tempDir, "gh-args.log");
    mkdirSync(binDir);
    const ghPath = join(binDir, "gh");
    const failOnDraft = options.failOnDraft ? "1" : "0";
    writeFileSync(ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$GH_ARGS_LOG\"",
      "if [ \"$1\" = \"--version\" ]; then",
      "  echo 'gh version 2.0.0'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"create\" ]; then",
      "  if [ \"${FAIL_ON_DRAFT:-0}\" = \"1\" ] && echo \"$*\" | grep -q -- \"--draft\"; then",
      "    echo 'error: draft PRs are not supported on this repository' >&2",
      "    exit 1",
      "  fi",
      "  echo 'https://github.com/acme/repo/pull/1'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(ghPath, 0o755);

    const originalPath = process.env.PATH;
    const originalLog = process.env.GH_ARGS_LOG;
    const originalFail = process.env.FAIL_ON_DRAFT;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    process.env.GH_ARGS_LOG = logPath;
    if (options.failOnDraft) {
      process.env.FAIL_ON_DRAFT = "1";
    }
    t.after(() => {
      process.env.PATH = originalPath;
      if (originalLog === undefined) {
        delete process.env.GH_ARGS_LOG;
      } else {
        process.env.GH_ARGS_LOG = originalLog;
      }
      if (originalFail === undefined) {
        delete process.env.FAIL_ON_DRAFT;
      } else {
        process.env.FAIL_ON_DRAFT = originalFail;
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    return { logPath };
  }

  it("passes --draft for newly created PRs by default", async (t) => {
    const { logPath } = installMockGh(t);
    const { createPR } = await import("../src/worktree.js");

    const result = createPR("/tmp", "agent/draft-default", "main", "Draft default", "Body");

    assert.deepEqual(result, { success: true, prUrl: "https://github.com/acme/repo/pull/1" });
    const calls = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.equal(calls.at(-1), "pr create --base main --draft --head agent/draft-default --title Draft default --body Body");
  });

  it("allows draft creation to be disabled explicitly", async (t) => {
    const { logPath } = installMockGh(t);
    const { createPR } = await import("../src/worktree.js");

    const result = createPR("/tmp", "agent/ready-pr", "main", "Ready PR", "Body", undefined, { draft: false });

    assert.deepEqual(result, { success: true, prUrl: "https://github.com/acme/repo/pull/1" });
    const calls = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.equal(calls.at(-1), "pr create --base main --head agent/ready-pr --title Ready PR --body Body");
  });

  it("retries without --draft and returns warnings when target repo rejects drafts", async (t) => {
    const { logPath } = installMockGh(t, { failOnDraft: true });
    const { createPR } = await import("../src/worktree.js");

    const result = createPR("/tmp", "agent/draft-retry", "main", "Draft PR", "Body");

    assert.deepEqual(result, {
      success: true,
      prUrl: "https://github.com/acme/repo/pull/1",
      warnings: ["Target repo does not support draft PRs; created as regular (non-draft) PR instead."],
    });

    const calls = readFileSync(logPath, "utf-8").trim().split("\n");
    // First call should have had --draft
    assert.ok(calls.some((c) => c.includes("--draft")), "first call should request draft");
    // Second call (retry) should not have --draft
    const lastCall = calls.at(-1)!;
    assert.ok(!lastCall.includes("--draft"), "retry call must not include --draft");
    assert.ok(lastCall.includes("pr create --base main --head agent/draft-retry"));
  });
});

describe("syncWorktreePR", () => {
  function installMockGh(t: import("node:test").TestContext) {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-gh-list-"));
    const binDir = join(tempDir, "bin");
    const logPath = join(tempDir, "gh-args.log");
    mkdirSync(binDir);
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$GH_ARGS_LOG\"",
      "if [ \"$1\" = \"--version\" ]; then",
      "  echo 'gh version 2.0.0'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"list\" ]; then",
      "  echo '{\"url\":\"https://github.com/openai/codex/pull/12\",\"number\":12,\"title\":\"Fix PR lookup\",\"state\":\"OPEN\"}'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(ghPath, 0o755);

    const originalPath = process.env.PATH;
    const originalLog = process.env.GH_ARGS_LOG;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    process.env.GH_ARGS_LOG = logPath;
    t.after(() => {
      process.env.PATH = originalPath;
      if (originalLog === undefined) {
        delete process.env.GH_ARGS_LOG;
      } else {
        process.env.GH_ARGS_LOG = originalLog;
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    return { logPath };
  }

  it("uses origin owner in --head when looking up a target repo PR", async (t) => {
    const { logPath } = installMockGh(t);
    const { syncWorktreePR } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-sync-pr-fork-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:me/fork.git"], { cwd: repoDir, stdio: "ignore" });

      const result = syncWorktreePR(repoDir, "agent/fix-lookup", "openai/codex");

      assert.deepEqual(result, {
        exists: true,
        state: "open",
        url: "https://github.com/openai/codex/pull/12",
        number: 12,
        title: "Fix PR lookup",
      });
      const calls = readFileSync(logPath, "utf-8").trim().split("\n");
      assert.equal(calls.at(-1), "pr list --head me:agent/fix-lookup --state all --json url,number,title,state --jq .[0] --repo openai/codex");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("uses a branch-only --head when no target repo is provided", async (t) => {
    const { logPath } = installMockGh(t);
    const { syncWorktreePR } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-sync-pr-same-repo-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:me/repo.git"], { cwd: repoDir, stdio: "ignore" });

      syncWorktreePR(repoDir, "agent/fix-lookup");

      const calls = readFileSync(logPath, "utf-8").trim().split("\n");
      assert.equal(calls.at(-1), "pr list --head agent/fix-lookup --state all --json url,number,title,state --jq .[0]");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("falls back to a branch-only --head for target repo lookup when origin is absent", async (t) => {
    const { logPath } = installMockGh(t);
    const { syncWorktreePR } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-sync-pr-no-origin-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });

      syncWorktreePR(repoDir, "agent/fix-lookup", "openai/codex");

      const calls = readFileSync(logPath, "utf-8").trim().split("\n");
      assert.equal(calls.at(-1), "pr list --head agent/fix-lookup --state all --json url,number,title,state --jq .[0] --repo openai/codex");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
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

  it("adds the default managed worktree directory to the repo-local exclude file", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-exclude-default-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "OpenClaw Tests"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "base\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

      createWorktree(repoDir, "exclude-default");

      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const exclude = readFileSync(join(repoDir, ".git", "info", "exclude"), "utf-8");
      assert.match(exclude, /^\.worktrees\/$/m);
      assert.equal(status, "");
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

describe("createWorktree branch selection", () => {
  it("creates a fresh suffixed branch when the default agent branch name already exists", async () => {
    const { createWorktree, getBranchName } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-branch-collision-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "OpenClaw Tests"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "base\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

      execFileSync("git", ["checkout", "-b", "agent/branch-collision"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "stale.txt"), "old branch state\n");
      execFileSync("git", ["add", "stale.txt"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "stale branch commit"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "ignore" });

      const worktreePath = createWorktree(repoDir, "branch-collision");
      const branchName = getBranchName(worktreePath);

      assert.ok(branchName);
      assert.notEqual(branchName, "agent/branch-collision");
      assert.match(branchName, /^agent\/branch-collision-/);
      assert.equal(existsSync(join(worktreePath, "stale.txt")), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("can explicitly reuse an existing agent branch when recreating a missing worktree", async () => {
    const { createWorktree, getBranchName } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-branch-reuse-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "OpenClaw Tests"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "base\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

      execFileSync("git", ["checkout", "-b", "agent/resume-target"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "resume.txt"), "resume branch state\n");
      execFileSync("git", ["add", "resume.txt"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "resume branch commit"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "ignore" });

      const worktreePath = createWorktree(repoDir, "resume-target", { allowExistingBranch: true });
      const branchName = getBranchName(worktreePath);

      assert.equal(branchName, "agent/resume-target");
      assert.equal(existsSync(join(worktreePath, "resume.txt")), true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("retries the original resume branch after removing a stale leftover worktree directory", async () => {
    const { createWorktree, getBranchName, getWorktreeBaseDir } = await import("../src/worktree.js");
    const repoDir = mkdtempSync(join(tmpdir(), "openclaw-worktree-branch-resume-dir-collision-"));

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "OpenClaw Tests"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "README.md"), "base\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

      execFileSync("git", ["checkout", "-b", "agent/resume-dir-collision"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "resume.txt"), "resume branch state\n");
      execFileSync("git", ["add", "resume.txt"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "resume branch commit"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "ignore" });

      const stalePath = join(
        getWorktreeBaseDir(repoDir),
        "openclaw-worktree-resume-dir-collision",
      );
      mkdirSync(stalePath, { recursive: true });
      writeFileSync(join(stalePath, "leftover.txt"), "stale directory\n");

      const worktreePath = createWorktree(repoDir, "resume-dir-collision", { allowExistingBranch: true });
      const branchName = getBranchName(worktreePath);

      assert.equal(worktreePath, stalePath);
      assert.equal(branchName, "agent/resume-dir-collision");
      assert.equal(existsSync(join(worktreePath, "resume.txt")), true);
      assert.equal(existsSync(join(worktreePath, "leftover.txt")), false);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
