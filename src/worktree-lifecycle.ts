import { runGit, withRepoLock } from "./git-exec";
import { randomBytes } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { relative, sep } from "path";
import { branchExists, getWorktreeBaseDir, sanitizeBranchName } from "./worktree-repo";
import { provisionWorktreeIncludes, runWorktreeSetupScript } from "./worktree-provisioning";
import { createLogger } from "./logger";

const log = createLogger("worktree-lifecycle");

export interface RemoveWorktreeOptions {
  destructive?: boolean;
}

export interface CreateWorktreeOptions {
  allowExistingBranch?: boolean;
}

type CreatedWorktree = {
  worktreePath: string;
  branchName: string;
  branchCreated: boolean;
};

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

export async function createWorktree(
  repoDir: string,
  sessionName: string,
  options: CreateWorktreeOptions = {},
): Promise<string> {
  const created = await withRepoLock(repoDir, () => createWorktreeLocked(repoDir, sessionName, options));
  try {
    await prepareCreatedWorktree(repoDir, created.worktreePath);
  } catch (err) {
    await rollbackCreatedWorktree(repoDir, created);
    throw err;
  }
  return created.worktreePath;
}

/**
 * Apply OpenClaw's managed-worktree conventions to a fresh OCA worktree:
 * copy `.worktreeinclude` files, then run `.openclaw/worktree-setup.sh`.
 * Runs outside the repository lock so a slow setup script does not block
 * other worktree operations on the same repository.
 */
async function prepareCreatedWorktree(repoDir: string, worktreePath: string): Promise<void> {
  const sourceRoot = (await getRepoRoot(repoDir)) ?? repoDir;
  const provisioned = await provisionWorktreeIncludes(sourceRoot, worktreePath);
  if (provisioned.length > 0) {
    log.info(`[worktree] Copied ${provisioned.length} .worktreeinclude file(s) into ${worktreePath}`);
  }
  await runWorktreeSetupScript(sourceRoot, worktreePath);
}

async function rollbackCreatedWorktree(repoDir: string, created: CreatedWorktree): Promise<void> {
  await withRepoLock(repoDir, async () => {
    try {
      await runGit(["-C", repoDir, "worktree", "remove", "--force", created.worktreePath], { timeout: 15_000 });
    } catch (err) {
      log.warn(`[worktree] Rollback could not remove ${created.worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        rmSync(created.worktreePath, { recursive: true, force: true });
        await runGit(["-C", repoDir, "worktree", "prune"], { timeout: 10_000 });
      } catch {
        // best effort
      }
    }
    // Only a branch this call created is deleted; a recreated resume branch keeps its commits.
    if (!created.branchCreated) return;
    try {
      await runGit(["-C", repoDir, "branch", "-D", created.branchName], { timeout: 10_000 });
    } catch (err) {
      log.warn(`[worktree] Rollback could not delete branch ${created.branchName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

async function createWorktreeLocked(
  repoDir: string,
  sessionName: string,
  options: CreateWorktreeOptions,
): Promise<CreatedWorktree> {
  const sanitized = sanitizeBranchName(sessionName);
  const baseDir = await getWorktreeBaseDir(repoDir);
  if (!baseDir) {
    throw new Error(`Cannot create a worktree for ${repoDir}: it is not inside a git repository. Launch from a repository root, or set worktree_strategy "off".`);
  }
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

  return { worktreePath, branchName, branchCreated: !branchAlreadyExists };
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
  if (!existsSync(worktreePath)) {
    // Already gone (removed by hand or by an earlier cleanup): drop git's stale
    // registration when the repository is reachable and report it as removed,
    // so callers clear the metadata instead of retrying forever.
    if (repoDir !== worktreePath && existsSync(repoDir)) {
      try {
        await runGit(["-C", repoDir, "worktree", "prune"], { timeout: 10_000 });
      } catch (err) {
        log.debug(`[worktree] git worktree prune after missing ${worktreePath} failed: ${err instanceof Error ? err.message.split(/\r?\n/, 1)[0] : String(err)}`);
      }
    }
    log.info(`[worktree] Worktree ${worktreePath} is already gone; treating it as removed`);
    return true;
  }
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
