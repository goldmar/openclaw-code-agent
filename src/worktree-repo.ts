import { assertBranchName, branchOrRemoteTrackingRef, localBranchRef } from "./worktree-ref-validation";
import { runGit, runGh, withRepoLock } from "./git-exec";
import * as fs from "fs";
import { basename, dirname, join } from "path";
import { pluginConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("worktree-repo");

let gitAvailableCache: Promise<boolean> | undefined;
let ghCliAvailableCache: Promise<boolean> | undefined;

async function getRepoRoot(dir: string): Promise<string | undefined> {
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 5_000 });
    return result.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Base directory for new worktrees: `OPENCLAW_WORKTREE_DIR`, then `worktreeDir`,
 * then `<repoRoot>/.worktrees`. Without an override and outside a git repository
 * there is no base directory (worktrees are never created in the OS temp dir).
 */
async function getWorktreeBaseDir(repoDir?: string): Promise<string | undefined> {
  if (process.env.OPENCLAW_WORKTREE_DIR) return process.env.OPENCLAW_WORKTREE_DIR;
  if (pluginConfig.worktreeDir) return pluginConfig.worktreeDir;
  if (!repoDir) return undefined;
  const root = await getRepoRoot(repoDir);
  return root ? join(root, ".worktrees") : undefined;
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

export async function getPrimaryRepoRootFromWorktree(worktreePath: string): Promise<string | undefined> {
  if (fs.existsSync(worktreePath)) {
    try {
      const commonDir = (await runGit(
        ["-C", worktreePath, "rev-parse", "--git-common-dir"],
        { cwd: worktreePath, timeout: 5_000 },
      )).trim();
      if (commonDir.endsWith("/.git")) return dirname(commonDir);
    } catch {
      // Fall through to the layout-based lookup.
    }
  }
  return primaryRepoRootFromDefaultLayout(worktreePath);
}

/**
 * A worktree that no longer exists cannot tell git where its repository is.
 * OCA's default layout is `<repoRoot>/.worktrees/<name>`, so use that when the
 * candidate root is still a git checkout.
 */
function primaryRepoRootFromDefaultLayout(worktreePath: string): string | undefined {
  const parent = dirname(worktreePath);
  if (basename(parent) !== ".worktrees") return undefined;
  const root = dirname(parent);
  return fs.existsSync(join(root, ".git")) ? root : undefined;
}

/** Probe `git --version` once per process; concurrent callers share the probe. */
export function isGitAvailable(): Promise<boolean> {
  gitAvailableCache ??= runGit(["--version"], { timeout: 5_000 }).then(() => true, () => false);
  return gitAvailableCache;
}

/** Probe `gh --version` once per process; concurrent callers share the probe. */
export function isGitHubCLIAvailable(): Promise<boolean> {
  ghCliAvailableCache ??= runGh(["--version"], { timeout: 5_000 }).then(() => true, () => false);
  return ghCliAvailableCache;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  if (!(await isGitAvailable())) return false;
  try {
    await runGit(["rev-parse", "--git-dir"], { cwd: dir, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function hasEnoughWorktreeSpace(repoDir?: string): Promise<boolean> {
  try {
    const baseDir = await getWorktreeBaseDir(repoDir);
    // No base directory means worktree creation fails with its own clear error.
    if (!baseDir) return true;
    const probePath = resolveExistingAncestorPath(baseDir);
    if (!probePath) {
      log.warn(`[worktree] Failed to resolve free-space probe path for ${baseDir}`);
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

export async function branchExists(repoDir: string, branchName: string): Promise<boolean> {
  await assertBranchName(branchName);

  try {
    await runGit(["-C", repoDir, "rev-parse", "--verify", await localBranchRef(branchName)], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Fetch a single branch into a remote-tracking ref without changing a checkout. */
export async function fetchRemoteBranchRef(repoDir: string, branchName: string, remote = "origin"): Promise<string | undefined> {
  await assertBranchName(branchName);
  await assertBranchName(remote);

  const remoteRef = `refs/remotes/${remote}/${branchName}`;
  try {
    await runGit(["-C", repoDir, "fetch", remote, `+${await localBranchRef(branchName)}:${remoteRef}`], { timeout: 30_000 });
    await runGit(["-C", repoDir, "rev-parse", "--verify", remoteRef], { timeout: 5_000 });
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

export async function getWorktreeSpaceProbePath(repoDir?: string): Promise<string | undefined> {
  const baseDir = await getWorktreeBaseDir(repoDir);
  return baseDir ? resolveExistingAncestorPath(baseDir) : undefined;
}

export function hasEnoughFreeBytes(freeBytes: number): boolean {
  const minBytes = 100 * 1024 * 1024;
  return freeBytes >= minBytes;
}

export async function detectDefaultBranch(repoDir: string): Promise<string> {
  const envBranch = process.env.OPENCLAW_WORKTREE_BASE_BRANCH;
  if (envBranch !== undefined) {
    await assertBranchName(envBranch);
    return envBranch;
  }

  try {
    const result = await runGit(["-C", repoDir, "rev-parse", "--abbrev-ref", "origin/HEAD"], { timeout: 5_000 });
    const branch = result.trim().replace(/^origin\//, "");
    if (branch) {
      await assertBranchName(branch);
      return branch;
    }
  } catch {
    // fall through
  }

  try {
    await runGit(["-C", repoDir, "rev-parse", "--verify", await localBranchRef("main")], { timeout: 5_000 });
    return "main";
  } catch {
    // fall through
  }

  try {
    await runGit(["-C", repoDir, "rev-parse", "--verify", await localBranchRef("master")], { timeout: 5_000 });
    return "master";
  } catch {
    return "main";
  }
}

export async function getBranchName(worktreePath: string): Promise<string | undefined> {
  try {
    const result = await runGit(["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5_000 });
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

export async function getCommitsAheadCount(repoDir: string, branch: string, base: string): Promise<number | undefined> {
  await assertBranchName(branch);
  await assertBranchName(base);

  try {
    const result = await runGit(
      ["-C", repoDir, "rev-list", "--count", `${await localBranchRef(base)}..${await localBranchRef(branch)}`],
      { timeout: 10_000 },
    );
    const count = parseInt(result.trim(), 10);
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

export async function hasCommitsAhead(repoDir: string, branch: string, base: string): Promise<boolean> {
  return ((await getCommitsAheadCount(repoDir, branch, base)) ?? 0) > 0;
}

export async function getAheadBehindCounts(
  repoDir: string,
  branch: string,
  base: string,
): Promise<{ ahead: number; behind: number } | undefined> {
  await assertBranchName(branch);
  await assertBranchName(base);

  try {
    const result = (await runGit(
      ["-C", repoDir, "rev-list", "--left-right", "--count", `${await localBranchRef(branch)}...${await localBranchRef(base)}`],
      { timeout: 10_000 },
    )).trim();
    const [aheadRaw, behindRaw] = result.split(/\s+/);
    return {
      ahead: parseInt(aheadRaw ?? "0", 10) || 0,
      behind: parseInt(behindRaw ?? "0", 10) || 0,
    };
  } catch {
    return undefined;
  }
}

export async function isBranchAncestorOfBase(repoDir: string, branch: string, base: string): Promise<boolean> {
  const branchRef = await branchOrRemoteTrackingRef(branch);
  const baseRef = await branchOrRemoteTrackingRef(base);

  try {
    await runGit(["-C", repoDir, "merge-base", "--is-ancestor", branchRef, baseRef], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function wouldMergeBeNoop(repoDir: string, branch: string, base: string): Promise<boolean> {
  await assertBranchName(branch);
  await assertBranchName(base);

  try {
    const mergedTree = (await runGit(
      ["-C", repoDir, "merge-tree", "--write-tree", await localBranchRef(base), await localBranchRef(branch)],
      { timeout: 15_000 },
    )).trim();
    const baseTree = (await runGit(
      ["-C", repoDir, "rev-parse", `${await localBranchRef(base)}^{tree}`],
      { timeout: 10_000 },
    )).trim();
    return Boolean(mergedTree) && mergedTree === baseTree;
  } catch {
    return false;
  }
}

export async function deleteBranch(repoDir: string, branch: string): Promise<boolean> {
  await assertBranchName(branch);

  return withRepoLock(repoDir, async () => {
    try {
      await runGit(["-C", repoDir, "branch", "-D", branch], { timeout: 10_000 });
      return true;
    } catch (err) {
      const stderr = (err as { stderr?: unknown }).stderr;
      const detail = `${typeof stderr === "string" ? stderr : ""}\n${err instanceof Error ? err.message : String(err)}`;
      if (/branch '[^']*' not found/i.test(detail)) {
        // Already deleted (for example by a squash-merge PR or by hand): the goal is met.
        log.debug(`[worktree] Branch ${branch} was already deleted`);
        return true;
      }
      log.warn(`[worktree] Failed to delete branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  });
}

/**
 * Whether any remote is hosted on a network host (`https://host/...`,
 * `ssh://host/...`, or scp-style `user@host:path`). Local-path and `file://`
 * remotes cannot have pull requests, so callers skip `gh` for repositories
 * whose remotes are all local. Any hosted remote qualifies, which keeps GitHub
 * Enterprise hosts (resolved by `gh` itself) working.
 */
export async function hasHostedRemote(repoDir: string): Promise<boolean> {
  let remotes: string;
  try {
    remotes = await runGit(["-C", repoDir, "remote", "-v"], { timeout: 5_000 });
  } catch {
    return false;
  }
  return remotes.split(/\r?\n/).some((line) => {
    const url = line.split(/\s+/)[1];
    if (!url) return false;
    if (/^(?:https?|ssh|git):\/\/[^/]+/i.test(url)) return true;
    return /^[^/\\:@\s]+@[^/\\:\s]+:/.test(url);
  });
}

export async function resolveTargetRepo(repoDir: string, explicitRepo?: string): Promise<string | undefined> {
  if (explicitRepo) return explicitRepo;
  let origin: string | undefined;
  try {
    origin = (await runGit(["-C", repoDir, "remote", "get-url", "origin"], { timeout: 5_000 })).trim() || undefined;
  } catch {
    // no origin remote
  }
  try {
    const upstream = (await runGit(["-C", repoDir, "remote", "get-url", "upstream"], { timeout: 5_000 })).trim();
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
