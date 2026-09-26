import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorktree } from "../src/worktree";
import { normalizeProvisionedRelativePath, provisionWorktreeIncludes, runWorktreeSetupScript } from "../src/worktree-provisioning";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.OPENCLAW_WORKTREE_DIR;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(repoDir);
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, ".gitignore"), [".env", "config/local.json", "config/secret.json", "node_modules/", "cache.bin", ""].join("\n"));
  writeFileSync(join(repoDir, ".env.example"), "EXAMPLE=1\n");
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-m", "init");
  return repoDir;
}

function writeSetupScript(repoDir: string, body: string[]): string {
  mkdirSync(join(repoDir, ".openclaw"), { recursive: true });
  const scriptPath = join(repoDir, ".openclaw", "worktree-setup.sh");
  writeFileSync(scriptPath, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("worktree provisioning (.worktreeinclude)", () => {
  it("copies only ignored files matched by .worktreeinclude into a new worktree", async () => {
    const repoDir = createRepo("oca-provision-");
    writeFileSync(join(repoDir, ".env"), "SECRET=1\n");
    chmodSync(join(repoDir, ".env"), 0o600);
    mkdirSync(join(repoDir, "config"));
    writeFileSync(join(repoDir, "config", "local.json"), "{\"local\":true}\n");
    writeFileSync(join(repoDir, "config", "secret.json"), "{\"secret\":true}\n");
    mkdirSync(join(repoDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(repoDir, "untracked-not-ignored.txt"), "draft\n");
    writeFileSync(join(repoDir, "cache.bin"), "cache\n");
    writeFileSync(join(repoDir, ".worktreeinclude"), [
      "# local environment",
      ".env",
      ".env.example",
      "config/*.json",
      "!config/secret.json",
      "untracked-not-ignored.txt",
      "",
    ].join("\n"));
    git(repoDir, "add", ".worktreeinclude");
    git(repoDir, "commit", "-qm", "include list");

    const worktreePath = await createWorktree(repoDir, "provisioned");

    assert.equal(readFileSync(join(worktreePath, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(statSync(join(worktreePath, ".env")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(worktreePath, "config", "local.json"), "utf8"), "{\"local\":true}\n");
    assert.equal(existsSync(join(worktreePath, "config", "secret.json")), false, "negated pattern is not copied");
    assert.equal(existsSync(join(worktreePath, "node_modules")), false, "ignored but not included is not copied");
    assert.equal(existsSync(join(worktreePath, "cache.bin")), false);
    assert.equal(existsSync(join(worktreePath, "untracked-not-ignored.txt")), false, "untracked files that are not ignored are not copied");
    assert.equal(readFileSync(join(worktreePath, ".env.example"), "utf8"), "EXAMPLE=1\n", "tracked files come from git checkout");
  });

  it("does nothing without .worktreeinclude and never overwrites or follows symlinks", async () => {
    const repoDir = createRepo("oca-provision-skip-");
    const worktreeParent = mkdtempSync(join(tmpdir(), "oca-provision-target-"));
    tempDirs.push(worktreeParent);
    const worktreeDir = join(worktreeParent, "wt");
    git(repoDir, "worktree", "add", "-q", "-b", "agent/skip", worktreeDir);
    assert.deepEqual(await provisionWorktreeIncludes(repoDir, worktreeDir), []);

    writeFileSync(join(repoDir, ".env"), "SOURCE=1\n");
    writeFileSync(join(repoDir, "outside.txt"), "outside\n");
    symlinkSync(join(repoDir, "outside.txt"), join(repoDir, "cache.bin"));
    writeFileSync(join(repoDir, ".worktreeinclude"), ".env\ncache.bin\n");
    git(repoDir, "add", ".worktreeinclude");
    git(repoDir, "commit", "-qm", "include list");
    writeFileSync(join(worktreeDir, ".env"), "EXISTING=1\n");

    assert.deepEqual(await provisionWorktreeIncludes(repoDir, worktreeDir, { baseCommit: git(repoDir, "rev-parse", "HEAD") }), []);
    assert.equal(readFileSync(join(worktreeDir, ".env"), "utf8"), "EXISTING=1\n");
    assert.equal(existsSync(join(worktreeDir, "cache.bin")), false);
  });

  it("does not copy files the recreated branch does not ignore", async () => {
    const repoDir = createRepo("oca-provision-branch-ignore-");
    // The agent branch stops ignoring .env; recreating its worktree must not
    // copy the source checkout's ignored .env into a place it could be committed.
    git(repoDir, "checkout", "-q", "-b", "agent/unignored");
    writeFileSync(join(repoDir, ".gitignore"), ["config/local.json", ""].join("\n"));
    git(repoDir, "commit", "-qam", "stop ignoring .env");
    git(repoDir, "checkout", "-q", "main");
    writeFileSync(join(repoDir, ".env"), "SECRET=1\n");
    mkdirSync(join(repoDir, "config"));
    writeFileSync(join(repoDir, "config", "local.json"), "{}\n");
    writeFileSync(join(repoDir, ".worktreeinclude"), ".env\nconfig/local.json\n");
    git(repoDir, "add", ".worktreeinclude");
    git(repoDir, "commit", "-qm", "include list");

    const worktreePath = await createWorktree(repoDir, "unignored", { allowExistingBranch: true });

    assert.equal(existsSync(join(worktreePath, ".env")), false);
    assert.equal(readFileSync(join(worktreePath, "config", "local.json"), "utf8"), "{}\n");
  });

  it("rejects unsafe relative paths", () => {
    for (const unsafe of ["", "/etc/passwd", "../escape", "a/../b", "a//b", "./a", "dir/"]) {
      assert.equal(normalizeProvisionedRelativePath(unsafe), undefined, unsafe);
    }
    assert.equal(normalizeProvisionedRelativePath("config/local.json"), join("config", "local.json"));
  });

  it("ignores an untracked or modified .worktreeinclude: only the committed list counts (B11)", async () => {
    const repoDir = createRepo("oca-provision-untracked-");
    writeFileSync(join(repoDir, ".env"), "SECRET=1\n");
    writeFileSync(join(repoDir, ".worktreeinclude"), ".env\n");
    const untracked = await createWorktree(repoDir, "untracked-include");
    assert.equal(existsSync(join(untracked, ".env")), false, "an untracked include list is ignored");

    writeFileSync(join(repoDir, ".worktreeinclude"), "cache.bin\n");
    git(repoDir, "add", ".worktreeinclude");
    git(repoDir, "commit", "-qm", "committed include list");
    writeFileSync(join(repoDir, "cache.bin"), "cache\n");
    writeFileSync(join(repoDir, ".worktreeinclude"), ".env\n");
    const modified = await createWorktree(repoDir, "modified-include");
    assert.equal(existsSync(join(modified, ".env")), false, "a modified working-tree include list is ignored");
    assert.equal(readFileSync(join(modified, "cache.bin"), "utf8"), "cache\n", "the committed include list is used");
  });

  it("fails worktree creation and rolls back when the committed .worktreeinclude is a symlink", async () => {
    const repoDir = createRepo("oca-provision-dir-");
    symlinkSync("README.md", join(repoDir, ".worktreeinclude"));
    git(repoDir, "add", ".worktreeinclude");
    git(repoDir, "commit", "-qm", "symlinked include");
    const worktreeBase = mkdtempSync(join(tmpdir(), "oca-provision-base-"));
    tempDirs.push(worktreeBase);
    process.env.OPENCLAW_WORKTREE_DIR = worktreeBase;

    await assert.rejects(createWorktree(repoDir, "bad-include"), /\.worktreeinclude must be a regular file/);
    assert.equal(existsSync(join(worktreeBase, "openclaw-worktree-bad-include")), false);
    assert.equal(git(repoDir, "branch", "--list", "agent/bad-include"), "");
  });
});

describe("worktree provisioning (.openclaw/worktree-setup.sh)", () => {
  it("runs an executable setup script in the new worktree with source and worktree paths", async () => {
    const repoDir = createRepo("oca-setup-");
    writeSetupScript(repoDir, [
      "printf '%s\\n%s\\n%s\\n' \"$OPENCLAW_SOURCE_TREE_PATH\" \"$OPENCLAW_WORKTREE_PATH\" \"$(pwd)\" > setup-ran.txt",
    ]);
    git(repoDir, "add", ".openclaw/worktree-setup.sh");
    git(repoDir, "commit", "-m", "setup");

    const worktreePath = await createWorktree(repoDir, "with-setup");

    const [sourcePath, reportedWorktree, cwd] = readFileSync(join(worktreePath, "setup-ran.txt"), "utf8").trim().split("\n");
    assert.equal(sourcePath, repoDir);
    assert.equal(reportedWorktree, worktreePath);
    assert.equal(cwd, worktreePath);
  });

  it("runs the committed script with a minimal environment, never a modified or untracked copy (B11/B12)", async () => {
    const repoDir = createRepo("oca-setup-committed-");
    writeSetupScript(repoDir, ["echo committed > setup-ran.txt", "echo \"gh=${GH_TOKEN:-unset}\" >> setup-ran.txt"]);
    git(repoDir, "add", ".openclaw/worktree-setup.sh");
    git(repoDir, "commit", "-m", "setup");
    writeSetupScript(repoDir, ["echo modified > setup-ran.txt"]);
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "gh-secret";
    try {
      const worktreePath = await createWorktree(repoDir, "committed-setup");
      assert.equal(readFileSync(join(worktreePath, "setup-ran.txt"), "utf8"), "committed\ngh=unset\n");
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }

    const untrackedRepo = createRepo("oca-setup-untracked-");
    writeSetupScript(untrackedRepo, ["touch should-not-exist.txt"]);
    const untrackedWorktree = await createWorktree(untrackedRepo, "untracked-setup");
    assert.equal(existsSync(join(untrackedWorktree, "should-not-exist.txt")), false, "an untracked script never runs");
  });

  it("skips a setup script that is not executable", async () => {
    const repoDir = createRepo("oca-setup-noexec-");
    const scriptPath = writeSetupScript(repoDir, ["touch should-not-exist.txt"]);
    chmodSync(scriptPath, 0o644);
    git(repoDir, "add", ".openclaw/worktree-setup.sh");
    git(repoDir, "commit", "-qm", "non-executable setup");
    chmodSync(scriptPath, 0o755);
    const worktreeDir = mkdtempSync(join(tmpdir(), "oca-setup-noexec-target-"));
    tempDirs.push(worktreeDir);

    assert.equal(await runWorktreeSetupScript(repoDir, worktreeDir, { baseCommit: git(repoDir, "rev-parse", "HEAD") }), false);
    assert.equal(existsSync(join(worktreeDir, "should-not-exist.txt")), false);
  });

  it("fails worktree creation with the script output tail and removes the worktree and new branch", async () => {
    const repoDir = createRepo("oca-setup-fail-");
    writeSetupScript(repoDir, ["echo 'installing deps'", "echo 'npm ERR! missing token' >&2", "exit 7"]);
    git(repoDir, "add", ".openclaw/worktree-setup.sh");
    git(repoDir, "commit", "-qm", "failing setup");
    const worktreeBase = mkdtempSync(join(tmpdir(), "oca-setup-fail-base-"));
    tempDirs.push(worktreeBase);
    process.env.OPENCLAW_WORKTREE_DIR = worktreeBase;

    await assert.rejects(createWorktree(repoDir, "setup-fails"), (err: Error) => {
      assert.match(err.message, /^worktree setup failed \(exit code 7\):/);
      assert.match(err.message, /npm ERR! missing token/);
      assert.match(err.message, /installing deps/);
      return true;
    });
    assert.equal(existsSync(join(worktreeBase, "openclaw-worktree-setup-fails")), false);
    assert.equal(git(repoDir, "branch", "--list", "agent/setup-fails"), "");
    assert.doesNotMatch(git(repoDir, "worktree", "list"), /setup-fails/);
  });

  it("keeps an existing branch when a recreated resume worktree fails setup", async () => {
    const repoDir = createRepo("oca-setup-resume-");
    writeSetupScript(repoDir, ["exit 3"]);
    git(repoDir, "add", ".openclaw/worktree-setup.sh");
    git(repoDir, "commit", "-qm", "failing setup");
    git(repoDir, "branch", "agent/resume-me");
    const worktreeBase = mkdtempSync(join(tmpdir(), "oca-setup-resume-base-"));
    tempDirs.push(worktreeBase);
    process.env.OPENCLAW_WORKTREE_DIR = worktreeBase;

    await assert.rejects(createWorktree(repoDir, "resume-me", { allowExistingBranch: true }), /exit code 3/);
    assert.equal(existsSync(join(worktreeBase, "openclaw-worktree-resume-me")), false);
    assert.equal(git(repoDir, "branch", "--list", "agent/resume-me"), "agent/resume-me");
  });

  it("times out and terminates the setup script's process group", async () => {
    const repoDir = createRepo("oca-setup-timeout-");
    const worktreeDir = mkdtempSync(join(tmpdir(), "oca-setup-timeout-target-"));
    tempDirs.push(worktreeDir);
    const pidFile = join(worktreeDir, "child.pid");
    writeSetupScript(repoDir, [
      "trap '' TERM",
      `sleep 30 & echo $! > '${pidFile}'`,
      "echo 'still preparing'",
      "wait",
    ]);
    git(repoDir, "add", ".openclaw/worktree-setup.sh");
    git(repoDir, "commit", "-qm", "slow setup");

    await assert.rejects(runWorktreeSetupScript(repoDir, worktreeDir, { timeoutMs: 300, baseCommit: git(repoDir, "rev-parse", "HEAD") }), (err: Error) => {
      assert.match(err.message, /^worktree setup failed \(timed out after 0 seconds\):/);
      assert.match(err.message, /still preparing/);
      return true;
    });
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processAlive(childPid), false, "background child in the script's process group is killed");
  });
});

describe("git runner stdin", () => {
  it("rejects instead of crashing when git exits before reading its input", async () => {
    const { runGit } = await import("../src/git-exec");
    // `git --version` never reads stdin; a large payload forces EPIPE on write.
    const output = await runGit(["--version"], { timeout: 10_000, input: "x".repeat(4 * 1024 * 1024) });
    assert.match(output, /git version/);
  });
});
