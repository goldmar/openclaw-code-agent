import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, statfsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Cached availability checks
let gitAvailableCache: boolean | undefined;
let ghCliAvailableCache: boolean | undefined;

/**
 * Sanitize a session name for use as a git branch name.
 * Replaces any characters not valid in git refs with dashes.
 */
function sanitizeBranchName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[-.]|[-.]$/g, "")
    .slice(0, 100) || "session";
}

/**
 * Resolve the git repository root for a given directory.
 * Returns undefined if the directory is not inside a git repo or git is unavailable.
 */
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

/**
 * Resolve the worktree base directory using the following priority chain:
 * 1. OPENCLAW_WORKTREE_DIR env var (explicit override)
 * 2. <repoRoot>/.worktrees — derived via git rev-parse relative to repoDir (when provided)
 * 3. tmpdir() — fallback when git is unavailable or repoDir is not supplied
 */
function getWorktreeBaseDir(repoDir?: string): string {
  if (process.env.OPENCLAW_WORKTREE_DIR) return process.env.OPENCLAW_WORKTREE_DIR;
  if (repoDir) {
    const root = getRepoRoot(repoDir);
    if (root) return join(root, ".worktrees");
  }
  return tmpdir();
}

/**
 * Check if git is available (cached).
 * G3 — Git availability check.
 */
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

/**
 * Check if GitHub CLI (gh) is available (cached).
 */
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

/**
 * Check if a directory is inside a git repository.
 */
export function isGitRepo(dir: string): boolean {
  if (!isGitAvailable()) return false;
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: dir, timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if there's enough free space in the worktree base directory (A3).
 * Returns true if at least 100MB is available.
 */
export function hasEnoughWorktreeSpace(): boolean {
  try {
    const baseDir = getWorktreeBaseDir();
    const stats = statfsSync(baseDir);
    const freeBytes = stats.bavail * stats.bsize;
    const minBytes = 100 * 1024 * 1024; // 100MB
    return freeBytes >= minBytes;
  } catch (err) {
    console.warn(`[worktree] Failed to check free space: ${err instanceof Error ? err.message : String(err)}`);
    return true; // Assume OK if we can't check
  }
}

/**
 * Check if a git branch exists in a repository.
 */
function branchExists(repoDir: string, branchName: string): boolean {
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

/**
 * Create a worktree for a session.
 * - Branch name: `agent/<session-name>` (sanitized)
 * - Worktree path: `<OPENCLAW_WORKTREE_DIR>/openclaw-worktree-<session-name>`
 * - Base: current HEAD of the repo
 * - Returns the worktree path
 * - C1: Uses atomic mkdir to avoid race conditions (with retry + suffix on EEXIST)
 * - C2: Reuses existing branch if it exists, creates new branch otherwise
 */
export function createWorktree(repoDir: string, sessionName: string): string {
  const sanitized = sanitizeBranchName(sessionName);
  const baseDir = getWorktreeBaseDir(repoDir);
  mkdirSync(baseDir, { recursive: true });

  // C1: Atomic mkdir with retry on collision
  let worktreePath: string | undefined;
  let branchName: string | undefined;
  const maxRetries = 10;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const suffix = attempt === 0 ? "" : `-${Math.random().toString(16).slice(2, 6)}`;
    const candidatePath = `${baseDir}/openclaw-worktree-${sanitized}${suffix}`;
    const candidateBranch = `agent/${sanitized}${suffix}`;

    try {
      mkdirSync(candidatePath, { recursive: false });
      worktreePath = candidatePath;
      branchName = candidateBranch;
      break;
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        // Path exists, retry with suffix
        continue;
      }
      // Other error, rethrow
      throw err;
    }
  }

  if (!worktreePath || !branchName) {
    throw new Error(`Failed to create unique worktree directory after ${maxRetries} attempts`);
  }

  // C2: Check if branch already exists
  const branchAlreadyExists = branchExists(repoDir, branchName);

  try {
    if (branchAlreadyExists) {
      // Reuse existing branch
      execFileSync(
        "git",
        ["-C", repoDir, "worktree", "add", worktreePath, branchName],
        { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } else {
      // Create new branch
      execFileSync(
        "git",
        ["-C", repoDir, "worktree", "add", "-b", branchName, worktreePath],
        { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    }
  } catch (err) {
    // Cleanup the directory we created if git worktree add failed
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Best effort
    }
    throw err;
  }

  return worktreePath;
}

/**
 * Remove a worktree (best-effort cleanup).
 * A2 — Falls back to rmSync if git worktree remove fails.
 * Does not remove the branch — it may have commits to push.
 * Returns true if removal succeeded (either method), false otherwise.
 */
export function removeWorktree(repoDir: string, worktreePath: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "worktree", "remove", "--force", worktreePath],
      { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch (err) {
    console.warn(`[worktree] git worktree remove failed for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);

    // A2: Fallback to rmSync
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      console.info(`[worktree] Fallback rmSync succeeded for ${worktreePath}`);
      return true;
    } catch (fallbackErr) {
      console.error(`[worktree] Both git worktree remove and rmSync failed for ${worktreePath}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      return false;
    }
  }
}

/**
 * Prune stale worktree metadata from `.git/worktrees/` (best-effort).
 * Call this before recreating a worktree whose directory was manually deleted but whose
 * git metadata still exists, to avoid "branch already used by worktree" errors.
 */
export function pruneWorktrees(repoDir: string): void {
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "worktree", "prune"],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    // best-effort — proceed even if prune fails
  }
}

// --- Merge-back utilities ---

/**
 * Detect the default branch of a repository.
 * Detection chain:
 * 1. OPENCLAW_WORKTREE_BASE_BRANCH env var (if set)
 * 2. origin/HEAD symbolic ref → strip "origin/" prefix
 * 3. Check if "main" exists
 * 4. Check if "master" exists
 * 5. Fallback: "main"
 */
export function detectDefaultBranch(repoDir: string): string {
  // Check env var first
  const envBranch = process.env.OPENCLAW_WORKTREE_BASE_BRANCH?.trim();
  if (envBranch) return envBranch;

  // Try to get default branch from origin/HEAD
  try {
    const result = execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--abbrev-ref", "origin/HEAD"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const branch = result.trim().replace(/^origin\//, "");
    if (branch) return branch;
  } catch {
    // origin/HEAD not set, try fallbacks
  }

  // Check if "main" exists
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "main"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return "main";
  } catch {
    // main doesn't exist
  }

  // Check if "master" exists
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "master"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return "master";
  } catch {
    // master doesn't exist
  }

  // Final fallback
  return "main";
}

/**
 * Get the current branch name of a worktree using git CLI.
 * Returns undefined if the worktree is not a valid git directory or is in detached HEAD state.
 * F9: Detached HEAD detection — if HEAD is detached, returns undefined and logs warning.
 */
export function getBranchName(worktreePath: string): string | undefined {
  try {
    const result = execFileSync(
      "git",
      ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const branch = result.trim();

    // F9: Detect detached HEAD state
    if (branch === "HEAD") {
      console.warn(`[worktree] Worktree ${worktreePath} is in detached HEAD state — cannot determine branch name`);
      return undefined;
    }

    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a branch has commits ahead of another branch.
 */
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

/**
 * Summary of changes between two branches.
 */
export interface DiffSummary {
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  commitMessages: Array<{ hash: string; message: string; author: string }>;
}

/**
 * Get a diff summary between two branches.
 */
export function getDiffSummary(repoDir: string, branch: string, base: string): DiffSummary | undefined {
  try {
    // Get commit count
    const countResult = execFileSync(
      "git",
      ["-C", repoDir, "rev-list", "--count", `${base}..${branch}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const commits = parseInt(countResult.trim(), 10);

    // Get diff stats
    const diffStatResult = execFileSync(
      "git",
      ["-C", repoDir, "diff", "--shortstat", `${base}...${branch}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const diffStat = diffStatResult.trim();

    // Parse: "3 files changed, 45 insertions(+), 12 deletions(-)"
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    const filesMatch = diffStat.match(/(\d+)\s+files?\s+changed/);
    if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

    const insertionsMatch = diffStat.match(/(\d+)\s+insertions?\(/);
    if (insertionsMatch) insertions = parseInt(insertionsMatch[1], 10);

    const deletionsMatch = diffStat.match(/(\d+)\s+deletions?\(/);
    if (deletionsMatch) deletions = parseInt(deletionsMatch[1], 10);

    // Get commit messages (last 5)
    const logResult = execFileSync(
      "git",
      ["-C", repoDir, "log", `${base}..${branch}`, "--format=%h|%s|%an", "-n", "5"],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    const commitMessages = logResult
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, message, author] = line.split("|");
        return { hash: hash || "", message: message || "", author: author || "" };
      });

    return { commits, filesChanged, insertions, deletions, commitMessages };
  } catch (err) {
    console.warn(`[worktree] Failed to get diff summary: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Push a branch to a remote.
 * Returns true on success, false on failure.
 */
export function pushBranch(repoDir: string, branch: string, remote: string = "origin"): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "push", remote, branch],
      { timeout: 60_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch (err) {
    console.warn(`[worktree] Failed to push branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Merge result with conflict details.
 */
export interface MergeResult {
  success: boolean;
  conflictFiles?: string[];
  error?: string;
  /** True when dirty tracked changes on base were auto-stashed before merging. */
  stashed?: boolean;
  /** e.g. "stash@{0}" — for user reference in notifications. */
  stashRef?: string;
  /** True when stash pop conflicted after a successful merge; stash left intact for manual recovery. */
  stashPopConflict?: boolean;
  /** True when the failure was specifically a stash-push failure (dirty state could not be stashed). */
  dirtyError?: boolean;
  /** True when the merge resulted in a clean fast-forward (linear history). Always true for "merge" strategy. */
  fastForward?: boolean;
  /** True when the rebase step hit conflicts; user must resolve manually with `git rebase --continue`. */
  rebaseConflict?: boolean;
}

/**
 * Returns true if the repo at repoDir has dirty tracked files (staged or unstaged).
 * Untracked files ("??") are ignored — they do not block git merge.
 */
function checkDirtyTracked(repoDir: string): boolean {
  try {
    const status = execFileSync(
      "git",
      ["-C", repoDir, "status", "--porcelain"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return status.split("\n").some(
      (line) => line.length > 0 && !line.startsWith("??") && !line.startsWith("!!"),
    );
  } catch {
    return false; // if check fails, proceed — merge will surface any error
  }
}

/**
 * Merge a branch into the base branch using a rebase-then-fast-forward strategy.
 *
 * For "merge" strategy:
 *   1. Rebase <branch> onto <base> (run in worktreePath if provided and exists, else in repoDir
 *      after checking out the branch). This keeps history linear.
 *   2. Fast-forward merge <base> ← <branch> (`git merge --ff-only`). Guaranteed to succeed
 *      after a successful rebase.
 *   If rebase hits conflicts → abort, restore state, return `rebaseConflict: true` with instructions.
 *
 * For "squash" strategy: standard squash merge into base (creates one commit, no merge commit).
 *
 * @param repoDir    The root of the git repository (main checkout).
 * @param branch     The agent branch to merge.
 * @param base       The base branch to merge into.
 * @param strategy   "merge" (default, rebase-then-ff) or "squash".
 * @param worktreePath  Optional path to the git worktree where <branch> is checked out.
 *                      When provided and the directory exists, the rebase is run there instead
 *                      of switching branches in repoDir — avoids a checkout round-trip.
 */
export function mergeBranch(
  repoDir: string,
  branch: string,
  base: string,
  strategy: "merge" | "squash" = "merge",
  worktreePath?: string,
): MergeResult {
  let stashed = false;
  let stashRef: string | undefined;

  // Helper: best-effort pop of the stash we created
  const tryPopStash = (dir: string) => {
    if (!stashed) return;
    try {
      execFileSync("git", ["-C", dir, "stash", "pop"], { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      // Best effort — stash remains for user recovery
    }
  };

  try {
    if (strategy === "squash") {
      // ── Squash path ────────────────────────────────────────────────────────
      // Checkout base, auto-stash if dirty, squash-merge, commit, pop stash.
      execFileSync(
        "git",
        ["-C", repoDir, "checkout", base],
        { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );

      if (checkDirtyTracked(repoDir)) {
        let stashOutput: string;
        try {
          stashOutput = execFileSync(
            "git",
            ["-C", repoDir, "stash", "push", "-m", `pre-merge stash before ${branch}`],
            { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
        } catch (stashErr) {
          return {
            success: false,
            dirtyError: true,
            error: `Auto-stash failed: ${stashErr instanceof Error ? stashErr.message : String(stashErr)}. Commit or stash changes manually, then retry.`,
          };
        }
        if (!stashOutput.includes("No local changes to save")) {
          stashed = true;
          try {
            stashRef = execFileSync(
              "git",
              ["-C", repoDir, "stash", "list", "--format=%gd", "-n", "1"],
              { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            ).trim() || undefined;
          } catch {
            // Best effort — stashRef is informational only
          }
        }
      }

      execFileSync(
        "git",
        ["-C", repoDir, "merge", "--squash", branch],
        { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      execFileSync(
        "git",
        ["-C", repoDir, "commit", "-m", `Squash merge ${branch}`],
        { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );

      let stashPopConflict = false;
      if (stashed) {
        try {
          execFileSync("git", ["-C", repoDir, "stash", "pop"], { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        } catch {
          stashPopConflict = true;
        }
      }

      return { success: true, stashed: stashed || undefined, stashRef, stashPopConflict: stashPopConflict || undefined };

    } else {
      // ── Rebase-then-fast-forward path ──────────────────────────────────────
      // Determine where to run the rebase:
      //   • If worktreePath is provided and exists on disk, the branch is already checked out
      //     there — rebase from the worktree directory directly.
      //   • Otherwise, check out the branch in repoDir and rebase from there.
      const useWorktree = worktreePath && existsSync(worktreePath);
      const rebaseDir = useWorktree ? worktreePath : repoDir;

      if (!useWorktree) {
        // Check out the agent branch in the main repo so we can rebase it
        execFileSync(
          "git",
          ["-C", repoDir, "checkout", branch],
          { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
      }

      // Auto-stash dirty tracked files in the base (main) repo before we touch it.
      // Note: we check repoDir regardless of whether we're using a worktree, because the
      // final ff-merge runs in repoDir on the base branch.
      if (checkDirtyTracked(repoDir)) {
        let stashOutput: string;
        try {
          stashOutput = execFileSync(
            "git",
            ["-C", repoDir, "stash", "push", "-m", `pre-merge stash before ${branch}`],
            { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
        } catch (stashErr) {
          // Restore branch pointer before returning
          try { execFileSync("git", ["-C", repoDir, "checkout", base], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }); } catch { /* best effort */ }
          return {
            success: false,
            dirtyError: true,
            error: `Auto-stash failed: ${stashErr instanceof Error ? stashErr.message : String(stashErr)}. Commit or stash changes manually, then retry.`,
          };
        }
        if (!stashOutput.includes("No local changes to save")) {
          stashed = true;
          try {
            stashRef = execFileSync(
              "git",
              ["-C", repoDir, "stash", "list", "--format=%gd", "-n", "1"],
              { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            ).trim() || undefined;
          } catch {
            // Best effort — stashRef is informational only
          }
        }
      }

      // Step 1: Rebase the agent branch onto base to linearise history.
      try {
        execFileSync(
          "git",
          ["-C", rebaseDir, "rebase", base],
          { timeout: 60_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch (rebaseErr) {
        // Rebase failed — abort to restore clean state
        try {
          execFileSync("git", ["-C", rebaseDir, "rebase", "--abort"], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        } catch { /* best effort */ }
        // Return to base branch in the main repo
        try {
          execFileSync("git", ["-C", repoDir, "checkout", base], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        } catch { /* best effort */ }
        tryPopStash(repoDir);
        return {
          success: false,
          rebaseConflict: true,
          stashed: stashed || undefined,
          stashRef,
          error: [
            `Rebase of ${branch} onto ${base} hit conflicts.`,
            `To resolve manually:`,
            `  cd ${rebaseDir}`,
            `  git rebase ${base}`,
            `  # resolve conflicts in each file, then:`,
            `  git add <file>`,
            `  git rebase --continue`,
            `  # repeat until rebase finishes, then re-run agent_merge.`,
          ].join("\n"),
        };
      }

      // Step 2: Checkout base in the main repo and fast-forward merge.
      execFileSync(
        "git",
        ["-C", repoDir, "checkout", base],
        { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );

      execFileSync(
        "git",
        ["-C", repoDir, "merge", "--ff-only", branch],
        { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );

      let stashPopConflict = false;
      if (stashed) {
        try {
          execFileSync("git", ["-C", repoDir, "stash", "pop"], { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        } catch {
          stashPopConflict = true;
        }
      }

      return {
        success: true,
        fastForward: true,
        stashed: stashed || undefined,
        stashRef,
        stashPopConflict: stashPopConflict || undefined,
      };
    }
  } catch (err) {
    // Unexpected error — best-effort cleanup
    try { execFileSync("git", ["-C", repoDir, "checkout", base], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }); } catch { /* best effort */ }
    tryPopStash(repoDir);

    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      stashed: stashed || undefined,
      stashRef,
    };
  }
}

/**
 * PR creation result.
 */
export interface PRResult {
  success: boolean;
  prUrl?: string;
  error?: string;
}

/**
 * Create a GitHub PR using gh CLI.
 * Requires gh CLI to be installed and authenticated.
 */
export function createPR(
  repoDir: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): PRResult {
  if (!isGitHubCLIAvailable()) {
    return { success: false, error: "GitHub CLI (gh) is not available" };
  }

  try {
    // Use --fill-verbose to auto-populate title/body from commits if not provided custom values
    const args = ["pr", "create", "--base", base, "--head", branch];

    // If title/body are provided, use them; otherwise let gh auto-fill from commits
    if (title && body) {
      args.push("--title", title, "--body", body);
    } else {
      args.push("--fill-verbose");
    }

    const result = execFileSync(
      "gh",
      args,
      { cwd: repoDir, timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    // gh pr create returns the PR URL on success
    const prUrl = result.trim();
    return { success: true, prUrl };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete a git branch.
 * Returns true on success, false on failure.
 */
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

/**
 * PR status information returned by syncWorktreePR.
 */
export interface PRStatus {
  exists: boolean;
  state: "open" | "merged" | "closed" | "none";
  url?: string;
  number?: number;
  title?: string;
}

/**
 * Check if a PR exists for a branch and return its current state.
 * Uses gh CLI to query PR state across all states (open, merged, closed).
 * Returns PRStatus with exists=false if no PR found.
 */
export function syncWorktreePR(repoDir: string, branchName: string): PRStatus {
  if (!isGitHubCLIAvailable()) {
    return { exists: false, state: "none" };
  }

  try {
    const result = execFileSync(
      "gh",
      ["pr", "list", "--head", branchName, "--state", "all", "--json", "url,number,title,state", "--jq", ".[0]"],
      { cwd: repoDir, timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    const prData = result.trim();
    if (!prData) {
      return { exists: false, state: "none" };
    }

    // Parse JSON response
    const pr = JSON.parse(prData) as { url: string; number: number; title: string; state: string };

    // Map GitHub PR state to our enum
    let state: "open" | "merged" | "closed" | "none";
    const ghState = pr.state.toLowerCase();
    if (ghState === "open") {
      state = "open";
    } else if (ghState === "merged") {
      state = "merged";
    } else if (ghState === "closed") {
      state = "closed";
    } else {
      state = "none";
    }

    return {
      exists: true,
      state,
      url: pr.url,
      number: pr.number,
      title: pr.title,
    };
  } catch (err) {
    console.warn(`[worktree] Failed to sync PR status for ${branchName}: ${err instanceof Error ? err.message : String(err)}`);
    return { exists: false, state: "none" };
  }
}

/**
 * Add a comment to an existing PR.
 * Returns true on success, false on failure.
 */
export function commentOnPR(repoDir: string, prNumber: number, body: string): boolean {
  if (!isGitHubCLIAvailable()) {
    return false;
  }

  try {
    execFileSync(
      "gh",
      ["pr", "comment", String(prNumber), "--body", body],
      { cwd: repoDir, timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch (err) {
    console.warn(`[worktree] Failed to comment on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
