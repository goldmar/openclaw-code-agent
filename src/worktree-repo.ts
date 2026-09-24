import { assertBranchName, branchOrRemoteTrackingRef, localBranchRef } from "./worktree-ref-validation";
import { execFileSync } from "child_process";
import * as fs from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pluginConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("worktree-repo");

let gitAvailableCache: boolean | undefined;
let ghCliAvailableCache: boolean | undefined;

function getRepoRoot(dir: string): string | undefined {
  try {
    const result = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: dir, timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim() || undefined;
  } catch {
    return undefined;
  }
}

function getWorktreeBaseDir(repoDir?: string): string {
  if (process.env.OPENCLAW_WORKTREE_DIR) return process.env.OPENCLAW_WORKTREE_DIR;
  if (pluginConfig.worktreeDir) return pluginConfig.worktreeDir;
  if (repoDir) {
    const root = getRepoRoot(repoDir);
    if (root) return join(root, ".worktrees");
  }
  return tmpdir();
}

export function sanitizeBranchName(name: string): string {
  const sanitized = name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-.]|[-.]$/g, "")
    .slice(0, 100)
    .replace(/[-.]+$/, "");

  return sanitized || "session";
}

export function getPrimaryRepoRootFromWorktree(worktreePath: string): string | undefined {
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", worktreePath, "rev-parse", "--git-common-dir"],
      { cwd: worktreePath, timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!commonDir) return undefined;
    return commonDir.endsWith("/.git") ? dirname(commonDir) : undefined;
  } catch {
    return undefined;
  }
}

export function isGitAvailable(): boolean {
  if (gitAvailableCache !== undefined) return gitAvailableCache;
  try {
    execFileSync("git", ["--version"], { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    gitAvailableCache = true;
    return true;
  } catch {
    gitAvailableCache = false;
    return false;
  }
}

export function isGitHubCLIAvailable(): boolean {
  if (ghCliAvailableCache !== undefined) return ghCliAvailableCache;
  try {
    execFileSync("gh", ["--version"], { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    ghCliAvailableCache = true;
    return true;
  } catch {
    ghCliAvailableCache = false;
    return false;
  }
}

export function isGitRepo(dir: string): boolean {
  if (!isGitAvailable()) return false;
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: dir, timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export function hasEnoughWorktreeSpace(repoDir?: string): boolean {
  try {
    const probePath = getWorktreeSpaceProbePath(repoDir);
    if (!probePath) {
      log.warn(`[worktree] Failed to resolve free-space probe path for ${getWorktreeBaseDir(repoDir)}`);
      return true;
    }
    const stats = fs.statfsSync(probePath);
    const freeBytes = stats.bavail * stats.bsize;
    return hasEnoughFreeBytes(freeBytes);
  } catch (err) {
    log.warn(`[worktree] Failed to check free space: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export function branchExists(repoDir: string, branchName: string): boolean {
  assertBranchName(branchName);

  try {
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", localBranchRef(branchName)],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

/** Fetch a single branch into a remote-tracking ref without changing a checkout. */
export function fetchRemoteBranchRef(repoDir: string, branchName: string, remote = "origin"): string | undefined {
  assertBranchName(branchName);
  assertBranchName(remote);

  const remoteRef = `refs/remotes/${remote}/${branchName}`;
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "fetch", remote, `+${localBranchRef(branchName)}:${remoteRef}`],
      { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", remoteRef],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return remoteRef;
  } catch {
    return undefined;
  }
}

function resolveExistingAncestorPath(targetPath: string): string | undefined {
  let currentPath = targetPath;
  while (true) {
    if (fs.existsSync(currentPath)) return currentPath;
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return undefined;
    currentPath = parentPath;
  }
}

export function getWorktreeSpaceProbePath(repoDir?: string): string | undefined {
  return resolveExistingAncestorPath(getWorktreeBaseDir(repoDir));
}

export function hasEnoughFreeBytes(freeBytes: number): boolean {
  const minBytes = 100 * 1024 * 1024;
  return freeBytes >= minBytes;
}

export function detectDefaultBranch(repoDir: string): string {
  const envBranch = process.env.OPENCLAW_WORKTREE_BASE_BRANCH;
  if (envBranch !== undefined) {
    assertBranchName(envBranch);
    return envBranch;
  }

  try {
    const result = execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--abbrev-ref", "origin/HEAD"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const branch = result.trim().replace(/^origin\//, "");
    if (branch) {
      assertBranchName(branch);
      return branch;
    }
  } catch {
    // fall through
  }

  try {
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", localBranchRef("main")],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return "main";
  } catch {
    // fall through
  }

  try {
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", localBranchRef("master")],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return "master";
  } catch {
    return "main";
  }
}

export function getBranchName(worktreePath: string): string | undefined {
  try {
    const result = execFileSync(
      "git",
      ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const branch = result.trim();
    if (branch === "HEAD") {
      log.warn(`[worktree] Worktree ${worktreePath} is in detached HEAD state — cannot determine branch name`);
      return undefined;
    }
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export function getCommitsAheadCount(repoDir: string, branch: string, base: string): number | undefined {
  assertBranchName(branch);
  assertBranchName(base);

  try {
    const result = execFileSync(
      "git",
      ["-C", repoDir, "rev-list", "--count", `${localBranchRef(base)}..${localBranchRef(branch)}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const count = parseInt(result.trim(), 10);
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

export function hasCommitsAhead(repoDir: string, branch: string, base: string): boolean {
  return (getCommitsAheadCount(repoDir, branch, base) ?? 0) > 0;
}

export function getAheadBehindCounts(
  repoDir: string,
  branch: string,
  base: string,
): { ahead: number; behind: number } | undefined {
  assertBranchName(branch);
  assertBranchName(base);

  try {
    const result = execFileSync(
      "git",
      ["-C", repoDir, "rev-list", "--left-right", "--count", `${localBranchRef(branch)}...${localBranchRef(base)}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const [aheadRaw, behindRaw] = result.split(/\s+/);
    return {
      ahead: parseInt(aheadRaw ?? "0", 10) || 0,
      behind: parseInt(behindRaw ?? "0", 10) || 0,
    };
  } catch {
    return undefined;
  }
}

export function isBranchAncestorOfBase(repoDir: string, branch: string, base: string): boolean {
  const branchRef = branchOrRemoteTrackingRef(branch);
  const baseRef = branchOrRemoteTrackingRef(base);

  try {
    execFileSync(
      "git",
      ["-C", repoDir, "merge-base", "--is-ancestor", branchRef, baseRef],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

export function wouldMergeBeNoop(repoDir: string, branch: string, base: string): boolean {
  assertBranchName(branch);
  assertBranchName(base);

  try {
    const mergedTree = execFileSync(
      "git",
      ["-C", repoDir, "merge-tree", "--write-tree", localBranchRef(base), localBranchRef(branch)],
      { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const baseTree = execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", `${localBranchRef(base)}^{tree}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return Boolean(mergedTree) && mergedTree === baseTree;
  } catch {
    return false;
  }
}

export function deleteBranch(repoDir: string, branch: string): boolean {
  assertBranchName(branch);

  try {
    execFileSync(
      "git",
      ["-C", repoDir, "branch", "-D", branch],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch (err) {
    log.warn(`[worktree] Failed to delete branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function resolveTargetRepo(repoDir: string, explicitRepo?: string): string | undefined {
  if (explicitRepo) return explicitRepo;
  let origin: string | undefined;
  try {
    origin = execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || undefined;
  } catch {
    // no origin remote
  }
  try {
    const upstream = execFileSync("git", ["-C", repoDir, "remote", "get-url", "upstream"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (upstream && upstream !== origin) {
      const match = upstream.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) return match[1];
    }
  } catch {
    // no upstream remote
  }
  return undefined;
}

export { getWorktreeBaseDir };
