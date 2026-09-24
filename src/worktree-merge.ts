import { assertBranchName, localBranchRef } from "./worktree-ref-validation";
import { runGit, withRepoLock } from "./git-exec";
import { existsSync } from "fs";
import { createLogger } from "./logger";

const log = createLogger("worktree-merge");

export interface DiffSummary {
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  changedFiles: string[];
  commitMessages: Array<{ hash: string; message: string; author: string }>;
}

export interface MergeResult {
  success: boolean;
  conflictFiles?: string[];
  error?: string;
  warnings?: string[];
  stashed?: boolean;
  stashRef?: string;
  stashPopConflict?: boolean;
  dirtyError?: boolean;
  fastForward?: boolean;
  /** The branch landed as one squash commit (`git merge --squash`). */
  squash?: boolean;
  rebaseConflict?: boolean;
}

/** How a successful merge landed: "fast-forward", "squash commit", or "merge commit". */
export function describeMergeType(result: Pick<MergeResult, "fastForward" | "squash">): "fast-forward" | "squash commit" | "merge commit" {
  if (result.fastForward) return "fast-forward";
  if (result.squash) return "squash commit";
  return "merge commit";
}

export function buildMergeWarningLines(mergeResult: MergeResult): string[] {
  return (mergeResult.warnings ?? [])
    .filter((warning) => !(mergeResult.stashPopConflict && warning.startsWith("Failed to pop auto-stash after merge")))
    .map((warning) => `Recovery warning: ${warning}`);
}

export function appendMergeWarnings(text: string, mergeResult: MergeResult): string {
  const warningLines = buildMergeWarningLines(mergeResult);
  if (warningLines.length === 0) return text;
  return `${text}\n${warningLines.map((line) => `⚠️ ${line}`).join("\n")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function getDiffSummary(repoDir: string, branch: string, base: string): Promise<DiffSummary | undefined> {
  await assertBranchName(branch);
  await assertBranchName(base);
  const branchRef = await localBranchRef(branch);
  const baseRef = await localBranchRef(base);

  try {
    const countResult = await runGit(["-C", repoDir, "rev-list", "--count", `${baseRef}..${branchRef}`], { timeout: 10_000 });
    const commits = parseInt(countResult.trim(), 10);

    const diffStatResult = await runGit(["-C", repoDir, "diff", "--shortstat", `${baseRef}...${branchRef}`], { timeout: 10_000 });
    const diffStat = diffStatResult.trim();

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    const filesMatch = diffStat.match(/(\d+)\s+files?\s+changed/);
    if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

    const insertionsMatch = diffStat.match(/(\d+)\s+insertions?\(/);
    if (insertionsMatch) insertions = parseInt(insertionsMatch[1], 10);

    const deletionsMatch = diffStat.match(/(\d+)\s+deletions?\(/);
    if (deletionsMatch) deletions = parseInt(deletionsMatch[1], 10);

    const changedFilesResult = await runGit(["-C", repoDir, "diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...${branchRef}`], { timeout: 10_000 });
    const changedFiles = changedFilesResult
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const logResult = await runGit(["-C", repoDir, "log", `${baseRef}..${branchRef}`, "--format=%h|%s|%an", "-n", "5"], { timeout: 10_000 });

    const commitMessages = logResult
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, message, author] = line.split("|");
        return { hash: hash || "", message: message || "", author: author || "" };
      });

    return { commits, filesChanged, insertions, deletions, changedFiles, commitMessages };
  } catch (err) {
    log.warn(`[worktree] Failed to get diff summary: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function pushBranch(repoDir: string, branch: string, remote: string = "origin"): Promise<boolean> {
  await assertBranchName(branch);
  await assertBranchName(remote);
  const branchRef = await localBranchRef(branch);

  try {
    await runGit(["-C", repoDir, "push", remote, `${branchRef}:${branchRef}`], { timeout: 60_000 });
    return true;
  } catch (err) {
    log.warn(`[worktree] Failed to push branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function checkDirtyTracked(repoDir: string): Promise<boolean> {
  try {
    const status = await runGit(["-C", repoDir, "status", "--porcelain"], { timeout: 5_000 });
    return status.split("\n").some(
      (line) => line.length > 0 && !line.startsWith("??") && !line.startsWith("!!"),
    );
  } catch {
    return false;
  }
}

export function mergeBranch(
  repoDir: string,
  branch: string,
  base: string,
  strategy: "merge" | "squash" = "merge",
  worktreePath?: string,
): Promise<MergeResult> {
  return withRepoLock(repoDir, () => mergeBranchLocked(repoDir, branch, base, strategy, worktreePath));
}

async function mergeBranchLocked(
  repoDir: string,
  branch: string,
  base: string,
  strategy: "merge" | "squash",
  worktreePath: string | undefined,
): Promise<MergeResult> {
  await assertBranchName(branch);
  await assertBranchName(base);
  const branchRef = await localBranchRef(branch);
  const baseRef = await localBranchRef(base);

  let stashed = false;
  let stashRef: string | undefined;
  const warnings: string[] = [];

  const withWarnings = <T extends MergeResult>(result: T): T => (
    warnings.length > 0 ? { ...result, warnings: [...warnings] } : result
  );

  const warnRecovery = (message: string, err: unknown) => {
    warnings.push(`${message}: ${errorMessage(err)}`);
  };

  const tryPopStash = async (dir: string) => {
    if (!stashed) return;
    try {
      await runGit(["-C", dir, "stash", "pop"], { timeout: 10_000 });
    } catch (err) {
      warnRecovery("Failed to pop auto-stash during recovery", err);
    }
  };

  try {
    if (strategy === "squash") {
      await runGit(["-C", repoDir, "checkout", base], { timeout: 15_000 });

      if (await checkDirtyTracked(repoDir)) {
        let stashOutput: string;
        try {
          stashOutput = await runGit(["-C", repoDir, "stash", "push", "-m", `pre-merge stash before ${branch}`], { timeout: 10_000 });
        } catch (stashErr) {
          return withWarnings({
            success: false,
            dirtyError: true,
            error: `Auto-stash failed: ${errorMessage(stashErr)}. Commit or stash changes manually, then retry.`,
          });
        }
        if (!stashOutput.includes("No local changes to save")) {
          stashed = true;
          try {
            stashRef = (await runGit(["-C", repoDir, "stash", "list", "--format=%gd", "-n", "1"], { timeout: 5_000 })).trim() || undefined;
          } catch (err) {
            warnRecovery("Failed to determine auto-stash ref", err);
          }
        }
      }

      await runGit(["-C", repoDir, "merge", "--squash", branchRef], { timeout: 30_000 });
      await runGit(["-C", repoDir, "commit", "-m", `Squash merge ${branch}`], { timeout: 10_000 });

      let stashPopConflict = false;
      if (stashed) {
        try {
          await runGit(["-C", repoDir, "stash", "pop"], { timeout: 10_000 });
        } catch (err) {
          stashPopConflict = true;
          warnRecovery("Failed to pop auto-stash after merge", err);
        }
      }

      return withWarnings({ success: true, squash: true, stashed: stashed || undefined, stashRef, stashPopConflict: stashPopConflict || undefined });
    }

    const useWorktree = worktreePath && existsSync(worktreePath);
    const rebaseDir = useWorktree ? worktreePath : repoDir;

    if (!useWorktree) {
      await runGit(["-C", repoDir, "checkout", branch], { timeout: 15_000 });
    }

    if (await checkDirtyTracked(repoDir)) {
      let stashOutput: string;
      try {
        stashOutput = await runGit(["-C", repoDir, "stash", "push", "-m", `pre-merge stash before ${branch}`], { timeout: 10_000 });
      } catch (stashErr) {
        try {
          await runGit(["-C", repoDir, "checkout", base], { timeout: 15_000 });
        } catch (err) {
          warnRecovery(`Failed to check out ${base} after auto-stash failure`, err);
        }
        return withWarnings({
          success: false,
          dirtyError: true,
          error: `Auto-stash failed: ${errorMessage(stashErr)}. Commit or stash changes manually, then retry.`,
        });
      }
      if (!stashOutput.includes("No local changes to save")) {
        stashed = true;
        try {
          stashRef = (await runGit(["-C", repoDir, "stash", "list", "--format=%gd", "-n", "1"], { timeout: 5_000 })).trim() || undefined;
        } catch (err) {
          warnRecovery("Failed to determine auto-stash ref", err);
        }
      }
    }

    try {
      await runGit(["-C", rebaseDir, "rebase", baseRef], { timeout: 60_000 });
    } catch {
      try {
        await runGit(["-C", rebaseDir, "rebase", "--abort"], { timeout: 15_000 });
      } catch (err) {
        warnRecovery("Failed to abort rebase during recovery", err);
      }
      try {
        await runGit(["-C", repoDir, "checkout", base], { timeout: 15_000 });
      } catch (err) {
        warnRecovery(`Failed to check out ${base} during recovery`, err);
      }
      await tryPopStash(repoDir);
      return withWarnings({
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
      });
    }

    await runGit(["-C", repoDir, "checkout", base], { timeout: 15_000 });
    await runGit(["-C", repoDir, "merge", "--ff-only", branchRef], { timeout: 30_000 });

    let stashPopConflict = false;
    if (stashed) {
      try {
        await runGit(["-C", repoDir, "stash", "pop"], { timeout: 10_000 });
      } catch (err) {
        stashPopConflict = true;
        warnRecovery("Failed to pop auto-stash after merge", err);
      }
    }

    return withWarnings({
      success: true,
      fastForward: true,
      stashed: stashed || undefined,
      stashRef,
      stashPopConflict: stashPopConflict || undefined,
    });
  } catch (err) {
    try {
      await runGit(["-C", repoDir, "checkout", base], { timeout: 15_000 });
    } catch (checkoutErr) {
      warnRecovery(`Failed to check out ${base} during recovery`, checkoutErr);
    }
    await tryPopStash(repoDir);
    return withWarnings({
      success: false,
      error: errorMessage(err),
      stashed: stashed || undefined,
      stashRef,
    });
  }
}
