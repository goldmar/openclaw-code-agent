import { execFileSync } from "child_process";
import { statfsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pluginConfig } from "./config";

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
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-.]|[-.]$/g, "")
    .slice(0, 100) || "session";
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
    const baseDir = getWorktreeBaseDir(repoDir);
    const stats = statfsSync(baseDir);
    const freeBytes = stats.bavail * stats.bsize;
    const minBytes = 100 * 1024 * 1024;
    return freeBytes >= minBytes;
  } catch (err) {
    console.warn(`[worktree] Failed to check free space: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

export function branchExists(repoDir: string, branchName: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", branchName],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

export function detectDefaultBranch(repoDir: string): string {
  const envBranch = process.env.OPENCLAW_WORKTREE_BASE_BRANCH?.trim();
  if (envBranch) return envBranch;

  try {
    const result = execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--abbrev-ref", "origin/HEAD"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const branch = result.trim().replace(/^origin\//, "");
    if (branch) return branch;
  } catch {
    // fall through
  }

  try {
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "main"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return "main";
  } catch {
    // fall through
  }

  try {
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "master"],
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
      console.warn(`[worktree] Worktree ${worktreePath} is in detached HEAD state — cannot determine branch name`);
      return undefined;
    }
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export function hasCommitsAhead(repoDir: string, branch: string, base: string): boolean {
  try {
    const result = execFileSync(
      "git",
      ["-C", repoDir, "rev-list", "--count", `${base}..${branch}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const count = parseInt(result.trim(), 10);
    return count > 0;
  } catch {
    return false;
  }
}

export function getAheadBehindCounts(
  repoDir: string,
  branch: string,
  base: string,
): { ahead: number; behind: number } | undefined {
  try {
    const result = execFileSync(
      "git",
      ["-C", repoDir, "rev-list", "--left-right", "--count", `${branch}...${base}`],
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
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "merge-base", "--is-ancestor", branch, base],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

export function wouldMergeBeNoop(repoDir: string, branch: string, base: string): boolean {
  try {
    const mergedTree = execFileSync(
      "git",
      ["-C", repoDir, "merge-tree", "--write-tree", base, branch],
      { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const baseTree = execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", `${base}^{tree}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return Boolean(mergedTree) && mergedTree === baseTree;
  } catch {
    return false;
  }
}

export function deleteBranch(repoDir: string, branch: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "branch", "-D", branch],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch (err) {
    console.warn(`[worktree] Failed to delete branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
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
