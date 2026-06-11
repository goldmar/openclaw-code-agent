import { execFileSync } from "child_process";
import { existsSync } from "fs";

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
  rebaseConflict?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getDiffSummary(repoDir: string, branch: string, base: string): DiffSummary | undefined {
  try {
    const countResult = execFileSync(
      "git",
      ["-C", repoDir, "rev-list", "--count", `${base}..${branch}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const commits = parseInt(countResult.trim(), 10);

    const diffStatResult = execFileSync(
      "git",
      ["-C", repoDir, "diff", "--shortstat", `${base}...${branch}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
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

    const changedFilesResult = execFileSync(
      "git",
      ["-C", repoDir, "diff", "--name-only", "--diff-filter=ACMR", `${base}...${branch}`],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const changedFiles = changedFilesResult
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

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

    return { commits, filesChanged, insertions, deletions, changedFiles, commitMessages };
  } catch (err) {
    console.warn(`[worktree] Failed to get diff summary: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

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

export function checkDirtyTracked(repoDir: string): boolean {
  try {
    const status = execFileSync("git", ["-C", repoDir, "status", "--porcelain"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
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
): MergeResult {
  let stashed = false;
  let stashRef: string | undefined;
  const warnings: string[] = [];

  const withWarnings = <T extends MergeResult>(result: T): T => (
    warnings.length > 0 ? { ...result, warnings: [...warnings] } : result
  );

  const warnRecovery = (message: string, err: unknown) => {
    warnings.push(`${message}: ${errorMessage(err)}`);
  };

  const tryPopStash = (dir: string) => {
    if (!stashed) return;
    try {
      execFileSync("git", ["-C", dir, "stash", "pop"], { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      warnRecovery("Failed to pop auto-stash during recovery", err);
    }
  };

  try {
    if (strategy === "squash") {
      execFileSync("git", ["-C", repoDir, "checkout", base], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

      if (checkDirtyTracked(repoDir)) {
        let stashOutput: string;
        try {
          stashOutput = execFileSync(
            "git",
            ["-C", repoDir, "stash", "push", "-m", `pre-merge stash before ${branch}`],
            { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
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
            stashRef = execFileSync("git", ["-C", repoDir, "stash", "list", "--format=%gd", "-n", "1"], {
              timeout: 5_000,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            }).trim() || undefined;
          } catch (err) {
            warnRecovery("Failed to determine auto-stash ref", err);
          }
        }
      }

      execFileSync("git", ["-C", repoDir, "merge", "--squash", branch], { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      execFileSync("git", ["-C", repoDir, "commit", "-m", `Squash merge ${branch}`], { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

      let stashPopConflict = false;
      if (stashed) {
        try {
          execFileSync("git", ["-C", repoDir, "stash", "pop"], { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        } catch (err) {
          stashPopConflict = true;
          warnRecovery("Failed to pop auto-stash after merge", err);
        }
      }

      return withWarnings({ success: true, stashed: stashed || undefined, stashRef, stashPopConflict: stashPopConflict || undefined });
    }

    const useWorktree = worktreePath && existsSync(worktreePath);
    const rebaseDir = useWorktree ? worktreePath : repoDir;

    if (!useWorktree) {
      execFileSync("git", ["-C", repoDir, "checkout", branch], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    }

    if (checkDirtyTracked(repoDir)) {
      let stashOutput: string;
      try {
        stashOutput = execFileSync(
          "git",
          ["-C", repoDir, "stash", "push", "-m", `pre-merge stash before ${branch}`],
          { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch (stashErr) {
        try {
          execFileSync("git", ["-C", repoDir, "checkout", base], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
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
          stashRef = execFileSync("git", ["-C", repoDir, "stash", "list", "--format=%gd", "-n", "1"], {
            timeout: 5_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim() || undefined;
        } catch (err) {
          warnRecovery("Failed to determine auto-stash ref", err);
        }
      }
    }

    try {
      execFileSync("git", ["-C", rebaseDir, "rebase", base], { timeout: 60_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      try {
        execFileSync("git", ["-C", rebaseDir, "rebase", "--abort"], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        warnRecovery("Failed to abort rebase during recovery", err);
      }
      try {
        execFileSync("git", ["-C", repoDir, "checkout", base], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        warnRecovery(`Failed to check out ${base} during recovery`, err);
      }
      tryPopStash(repoDir);
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

    execFileSync("git", ["-C", repoDir, "checkout", base], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    execFileSync("git", ["-C", repoDir, "merge", "--ff-only", branch], { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

    let stashPopConflict = false;
    if (stashed) {
      try {
        execFileSync("git", ["-C", repoDir, "stash", "pop"], { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
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
      execFileSync("git", ["-C", repoDir, "checkout", base], { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (checkoutErr) {
      warnRecovery(`Failed to check out ${base} during recovery`, checkoutErr);
    }
    tryPopStash(repoDir);
    return withWarnings({
      success: false,
      error: errorMessage(err),
      stashed: stashed || undefined,
      stashRef,
    });
  }
}
