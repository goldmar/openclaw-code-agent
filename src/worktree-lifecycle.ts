import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { branchExists, getWorktreeBaseDir, sanitizeBranchName } from "./worktree-repo";

export interface RemoveWorktreeOptions {
  destructive?: boolean;
}

export interface CreateWorktreeOptions {
  allowExistingBranch?: boolean;
}

export function createWorktree(
  repoDir: string,
  sessionName: string,
  options: CreateWorktreeOptions = {},
): string {
  const sanitized = sanitizeBranchName(sessionName);
  const baseDir = getWorktreeBaseDir(repoDir);
  mkdirSync(baseDir, { recursive: true });
  const allowExistingBranch = options.allowExistingBranch === true;

  let worktreePath: string | undefined;
  let branchName: string | undefined;
  const maxRetries = 10;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const suffix = attempt === 0 ? "" : `-${Math.random().toString(16).slice(2, 6)}`;
    const candidatePath = `${baseDir}/openclaw-worktree-${sanitized}${suffix}`;
    const candidateBranch = `agent/${sanitized}${suffix}`;
    if (!allowExistingBranch && branchExists(repoDir, candidateBranch)) {
      continue;
    }

    try {
      mkdirSync(candidatePath, { recursive: false });
      worktreePath = candidatePath;
      branchName = candidateBranch;
      break;
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        if (allowExistingBranch && attempt === 0) {
          try {
            rmSync(candidatePath, { recursive: true, force: true });
            attempt--;
          } catch {
            // best effort; fall through to a suffixed retry if cleanup fails
          }
        }
        continue;
      }
      throw err;
    }
  }

  if (!worktreePath || !branchName) {
    throw new Error(`Failed to create unique worktree directory and branch after ${maxRetries} attempts`);
  }

  const branchAlreadyExists = branchExists(repoDir, branchName);
  try {
    if (branchAlreadyExists) {
      execFileSync("git", ["-C", repoDir, "worktree", "add", worktreePath, branchName], {
        timeout: 15_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      execFileSync("git", ["-C", repoDir, "worktree", "add", "-b", branchName, worktreePath], {
        timeout: 15_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch (err) {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // best effort
    }
    throw err;
  }

  return worktreePath;
}

function listDirtyWorktreeEntries(worktreePath: string): string[] {
  if (!existsSync(worktreePath)) return [];
  try {
    const result = execFileSync(
      "git",
      ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"],
      {
        timeout: 10_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    return result ? result.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function removeWorktree(
  repoDir: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {},
): boolean {
  const destructive = options.destructive === true;
  const dirtyEntries = listDirtyWorktreeEntries(worktreePath);
  if (dirtyEntries.length > 0 && !destructive) {
    console.warn(
      `[worktree] Refusing implicit cleanup for dirty worktree ${worktreePath}: ${dirtyEntries[0]}`,
    );
    return false;
  }

  try {
    execFileSync("git", ["-C", repoDir, "worktree", "remove", ...(destructive ? ["--force"] : []), worktreePath], {
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (err) {
    console.warn(`[worktree] git worktree remove failed for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
    if (!destructive) return false;
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

export function pruneWorktrees(repoDir: string): void {
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "worktree", "prune"],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    // best-effort
  }
}

export function worktreeExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}
