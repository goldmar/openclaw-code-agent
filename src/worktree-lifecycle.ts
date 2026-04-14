import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { branchExists, getWorktreeBaseDir, sanitizeBranchName } from "./worktree-repo";

export interface RemoveWorktreeOptions {
  destructive?: boolean;
}

export interface CreateWorktreeOptions {
  allowExistingBranch?: boolean;
}

function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === code);
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
  let cleanedStaleResumeDir = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const suffix = attempt === 0 ? "" : `-${Math.random().toString(16).slice(2, 6)}`;
    const candidatePath = `${baseDir}/openclaw-worktree-${sanitized}${suffix}`;
    const candidateBranch = `agent/${sanitized}${suffix}`;
    if (!allowExistingBranch && branchExists(repoDir, candidateBranch)) {
      continue;
    }

    let retryCurrentCandidate = false;
    do {
      retryCurrentCandidate = false;
      try {
        mkdirSync(candidatePath, { recursive: false });
        worktreePath = candidatePath;
        branchName = candidateBranch;
        break;
      } catch (err: unknown) {
        if (isNodeErrorWithCode(err, "EEXIST")) {
          if (allowExistingBranch && attempt === 0 && !cleanedStaleResumeDir) {
            try {
              rmSync(candidatePath, { recursive: true, force: true });
              cleanedStaleResumeDir = true;
              retryCurrentCandidate = true;
            } catch (cleanupErr) {
              throw new Error(
                `Failed to recreate existing worktree branch ${candidateBranch}: could not clear blocked path ${candidatePath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
              );
            }
          } else if (allowExistingBranch && attempt === 0) {
            throw new Error(
              `Failed to recreate existing worktree branch ${candidateBranch}: path ${candidatePath} remains blocked after one cleanup attempt`,
            );
          }
          continue;
        }
        throw err;
      }
    } while (retryCurrentCandidate);

    if (worktreePath && branchName) {
      break;
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
