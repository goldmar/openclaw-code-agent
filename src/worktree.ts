import { execSync } from "child_process";

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
 * Check if a directory is a git repo with at least one remote.
 */
export function isGitRepoWithRemote(dir: string): boolean {
  try {
    const result = execSync("git remote", { cwd: dir, timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Create a worktree for a session.
 * - Branch name: `agent/<session-name>` (sanitized)
 * - Worktree path: `/tmp/openclaw-worktree-<session-name>`
 * - Base: current HEAD of the repo
 * - Returns the worktree path
 */
export function createWorktree(repoDir: string, sessionName: string): string {
  const sanitized = sanitizeBranchName(sessionName);
  const branchName = `agent/${sanitized}`;
  const worktreePath = `/tmp/openclaw-worktree-${sanitized}`;

  execSync(
    `git -C ${JSON.stringify(repoDir)} worktree add -b ${JSON.stringify(branchName)} ${JSON.stringify(worktreePath)}`,
    { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );

  return worktreePath;
}

/**
 * Remove a worktree (best-effort cleanup).
 * Does not remove the branch — it may have commits to push.
 */
export function removeWorktree(repoDir: string, worktreePath: string): void {
  try {
    execSync(
      `git -C ${JSON.stringify(repoDir)} worktree remove --force ${JSON.stringify(worktreePath)}`,
      { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    console.warn(`[worktree] Failed to remove worktree at ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
