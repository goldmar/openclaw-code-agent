import { runGit, withRepoLock } from "./git-exec";
import { randomBytes } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { relative, sep } from "path";
import { branchExists, getWorktreeBaseDir, sanitizeBranchName } from "./worktree-repo";
import { createLogger } from "./logger";

const log = createLogger("worktree-lifecycle");

export interface RemoveWorktreeOptions {
  destructive?: boolean;
}

export interface CreateWorktreeOptions {
  allowExistingBranch?: boolean;
}


function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === code);
}

async function getRepoRoot(repoDir: string): Promise<string | undefined> {
  try {
    const result = await runGit(["-C", repoDir, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
    return result.trim() || undefined;
  } catch {
    return undefined;
  }
}

function createRetrySuffix(attempt: number): string {
  if (attempt === 0) return "";
  return `-${attempt}-${randomBytes(8).toString("hex")}`;
}

async function ensureWorktreeBaseIgnored(repoDir: string, baseDir: string): Promise<void> {
  const repoRoot = await getRepoRoot(repoDir);
  if (!repoRoot) return;

  const relativeBaseDir = relative(repoRoot, baseDir);
  if (!relativeBaseDir || relativeBaseDir.startsWith("..") || relativeBaseDir.includes(`..${sep}`)) return;

  const excludePath = `${repoRoot}/.git/info/exclude`;
  const normalizedPattern = `${relativeBaseDir.split(sep).join("/").replace(/\/$/, "")}/`;
  try {
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
    const alreadyIgnored = existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === normalizedPattern || line === `/${normalizedPattern}`);
    if (!alreadyIgnored) {
      appendFileSync(excludePath, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${normalizedPattern}\n`, "utf-8");
    }
  } catch (err) {
    log.warn(`[worktree] Failed to add ${normalizedPattern} to ${excludePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createWorktree(
  repoDir: string,
  sessionName: string,
  options: CreateWorktreeOptions = {},
): Promise<string> {
  return withRepoLock(repoDir, () => createWorktreeLocked(repoDir, sessionName, options));
}

async function createWorktreeLocked(
  repoDir: string,
  sessionName: string,
  options: CreateWorktreeOptions,
): Promise<string> {
  const sanitized = sanitizeBranchName(sessionName);
  const baseDir = await getWorktreeBaseDir(repoDir);
  await ensureWorktreeBaseIgnored(repoDir, baseDir);
  mkdirSync(baseDir, { recursive: true });
  const allowExistingBranch = options.allowExistingBranch === true;

  let worktreePath: string | undefined;
  let branchName: string | undefined;
  const maxRetries = 10;
  let cleanedStaleResumeDir = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const suffix = createRetrySuffix(attempt);
    const candidatePath = `${baseDir}/openclaw-worktree-${sanitized}${suffix}`;
    const candidateBranch = `agent/${sanitized}${suffix}`;
    if (!allowExistingBranch && await branchExists(repoDir, candidateBranch)) {
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

  const branchAlreadyExists = await branchExists(repoDir, branchName);
  try {
    if (branchAlreadyExists) {
      await runGit(["-C", repoDir, "worktree", "add", worktreePath, branchName], { timeout: 15_000 });
    } else {
      await runGit(["-C", repoDir, "worktree", "add", "-b", branchName, worktreePath], { timeout: 15_000 });
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

export async function listDirtyWorktreeEntries(worktreePath: string): Promise<string[]> {
  if (!existsSync(worktreePath)) return [];
  try {
    const result = (await runGit(
      ["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"],
      { timeout: 10_000 },
    )).trim();
    return result ? result.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function hasDirtyWorktreeEntries(worktreePath: string): Promise<boolean> {
  return (await listDirtyWorktreeEntries(worktreePath)).length > 0;
}

export function removeWorktree(
  repoDir: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {},
): Promise<boolean> {
  return withRepoLock(repoDir, () => removeWorktreeLocked(repoDir, worktreePath, options));
}

async function removeWorktreeLocked(
  repoDir: string,
  worktreePath: string,
  options: RemoveWorktreeOptions,
): Promise<boolean> {
  const destructive = options.destructive === true;
  const dirtyEntries = await listDirtyWorktreeEntries(worktreePath);
  if (dirtyEntries.length > 0 && !destructive) {
    log.warn(
      `[worktree] Refusing implicit cleanup for dirty worktree ${worktreePath}: ${dirtyEntries[0]}`,
    );
    return false;
  }

  try {
    await runGit(["-C", repoDir, "worktree", "remove", ...(destructive ? ["--force"] : []), worktreePath], { timeout: 15_000 });
    return true;
  } catch (err) {
    log.warn(`[worktree] git worktree remove failed for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
    if (!destructive) return false;
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      log.info(`[worktree] Fallback rmSync succeeded for ${worktreePath}`);
      return true;
    } catch (fallbackErr) {
      log.error(`[worktree] Both git worktree remove and rmSync failed for ${worktreePath}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      return false;
    }
  }
}

export function pruneWorktrees(repoDir: string): Promise<void> {
  return withRepoLock(repoDir, async () => {
    try {
      await runGit(["-C", repoDir, "worktree", "prune"], { timeout: 10_000 });
    } catch (err) {
      const reason = err instanceof Error ? err.message.split(/\r?\n/, 1)[0] : String(err);
      log.warn(`[worktree] git worktree prune failed for ${repoDir}: ${reason}`);
    }
  });
}

export function worktreeExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}
