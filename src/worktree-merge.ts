import { assertBranchName, localBranchRef } from "./worktree-ref-validation";
import { runGit, withRepoLock } from "./git-exec";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { repoHookGitArgs } from "./git-hooks";
import { getCheckoutPathForBranch, isBranchPublished } from "./worktree-repo";
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
    await runGit([...repoHookGitArgs(), "-C", repoDir, "push", remote, `${branchRef}:${branchRef}`], { timeout: 60_000 });
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

/**
 * Land `branch` on `base` without ever switching a checkout to another branch.
 *
 * - `merge` rebases the branch onto base when needed (in the session worktree,
 *   the checkout that already has the branch, or a temporary worktree), then
 *   fast-forwards base.
 * - `squash` lands the branch as one commit on base.
 *
 * Base itself moves where it lives: when base is checked out (usually the
 * user's main checkout) the merge runs there, so repository hooks run as
 * configured (`worktreeGitHooks`) and uncommitted changes are auto-stashed and
 * restored on that same branch. When base is not checked out anywhere, the ref
 * is updated directly (compare-and-swap) and the user's checkout is untouched.
 */
export function mergeBranch(
  repoDir: string,
  branch: string,
  base: string,
  strategy: "merge" | "squash" = "merge",
  worktreePath?: string,
): Promise<MergeResult> {
  return withRepoLock(repoDir, () => mergeBranchLocked(repoDir, branch, base, strategy, worktreePath));
}

async function revParse(repoDir: string, ref: string): Promise<string> {
  return (await runGit(["-C", repoDir, "rev-parse", "--verify", `${ref}^{commit}`], { timeout: 10_000 })).trim();
}

async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(["-C", repoDir, "merge-base", "--is-ancestor", ancestor, descendant], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function removeTemporaryWorktree(repoDir: string, path: string): Promise<void> {
  try {
    await runGit(["-C", repoDir, "worktree", "remove", "--force", path], { timeout: 15_000 });
  } catch {
    rmSync(path, { recursive: true, force: true });
    await runGit(["-C", repoDir, "worktree", "prune"], { timeout: 10_000 }).catch(() => "");
  }
  rmSync(dirname(path), { recursive: true, force: true });
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
  const hooks = repoHookGitArgs();

  let stashed = false;
  let stashRef: string | undefined;
  const warnings: string[] = [];
  const withWarnings = <T extends MergeResult>(result: T): T => (
    warnings.length > 0 ? { ...result, warnings: [...warnings] } : result
  );
  const warnRecovery = (message: string, err: unknown) => {
    warnings.push(`${message}: ${errorMessage(err)}`);
  };

  try {
    // 1. `merge`: make the branch contain base, rebasing only when needed.
    if (strategy === "merge" && !(await isAncestor(repoDir, baseRef, branchRef))) {
      if (await isBranchPublished(repoDir, branch)) {
        warnings.push(
          `${branch} was already pushed; rebasing it onto ${base} rewrote its commits, so the remote copy of ${branch} still has the old ones.`,
        );
      }
      const sessionWorktree = worktreePath && existsSync(worktreePath) ? worktreePath : undefined;
      const existingCheckout = sessionWorktree ?? await getCheckoutPathForBranch(repoDir, branch);
      let rebaseDir = existingCheckout;
      let temporaryWorktree: string | undefined;
      if (rebaseDir && await checkDirtyTracked(rebaseDir)) {
        return withWarnings({
          success: false,
          dirtyError: true,
          error: `The checkout of ${branch} at ${rebaseDir} has uncommitted changes. Commit or discard them, then merge again.`,
        });
      }
      if (!rebaseDir) {
        temporaryWorktree = join(mkdtempSync(join(tmpdir(), "oca-merge-")), "worktree");
        await runGit([...hooks, "-C", repoDir, "worktree", "add", temporaryWorktree, branch], { timeout: 30_000 });
        rebaseDir = temporaryWorktree;
      }
      try {
        await runGit([...hooks, "-C", rebaseDir, "rebase", baseRef], { timeout: 60_000 });
      } catch {
        try {
          await runGit(["-C", rebaseDir, "rebase", "--abort"], { timeout: 15_000 });
        } catch (err) {
          warnRecovery("Failed to abort rebase during recovery", err);
        }
        return withWarnings({
          success: false,
          rebaseConflict: true,
          error: [
            `Rebase of ${branch} onto ${base} hit conflicts.`,
            `To resolve manually:`,
            `  cd ${existingCheckout ?? repoDir}`,
            ...(existingCheckout ? [] : [`  git switch ${branch}`]),
            `  git rebase ${base}`,
            `  # resolve conflicts in each file, then:`,
            `  git add <file>`,
            `  git rebase --continue`,
            `  # repeat until rebase finishes, then re-run agent_merge.`,
          ].join("\n"),
        });
      } finally {
        if (temporaryWorktree) await removeTemporaryWorktree(repoDir, temporaryWorktree);
      }
    }

    // 2. Move base where it lives.
    const baseCheckout = await getCheckoutPathForBranch(repoDir, base);
    if (!baseCheckout) {
      const oldBase = await revParse(repoDir, baseRef);
      let newBase: string;
      if (strategy === "squash") {
        let tree: string;
        try {
          tree = (await runGit(["-C", repoDir, "merge-tree", "--write-tree", baseRef, branchRef], { timeout: 30_000 })).split("\n")[0]!.trim();
        } catch (err) {
          return withWarnings({ success: false, error: `Squash merge of ${branch} into ${base} hit conflicts: ${errorMessage(err)}` });
        }
        newBase = (await runGit(["-C", repoDir, "commit-tree", tree, "-p", oldBase, "-m", `Squash merge ${branch}`], { timeout: 10_000 })).trim();
      } else {
        newBase = await revParse(repoDir, branchRef);
        if (!(await isAncestor(repoDir, oldBase, newBase))) {
          return withWarnings({ success: false, error: `${base} moved while merging ${branch}; merge again.` });
        }
      }
      await runGit(["-C", repoDir, "update-ref", "-m", `openclaw-code-agent: merge ${branch}`, baseRef, newBase, oldBase], { timeout: 10_000 });
      return withWarnings(strategy === "squash" ? { success: true, squash: true } : { success: true, fastForward: true });
    }

    if (await checkDirtyTracked(baseCheckout)) {
      let stashOutput: string;
      try {
        stashOutput = await runGit(["-C", baseCheckout, "stash", "push", "-m", `pre-merge stash before ${branch}`], { timeout: 10_000 });
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
          stashRef = (await runGit(["-C", baseCheckout, "stash", "list", "--format=%gd", "-n", "1"], { timeout: 5_000 })).trim() || undefined;
        } catch (err) {
          warnRecovery("Failed to determine auto-stash ref", err);
        }
      }
    }

    try {
      if (strategy === "squash") {
        await runGit([...hooks, "-C", baseCheckout, "merge", "--squash", branchRef], { timeout: 30_000 });
        await runGit([...hooks, "-C", baseCheckout, "commit", "-m", `Squash merge ${branch}`], { timeout: 60_000 });
      } else {
        await runGit([...hooks, "-C", baseCheckout, "merge", "--ff-only", branchRef], { timeout: 30_000 });
      }
    } catch (err) {
      if (strategy === "squash") {
        try {
          await runGit(["-C", baseCheckout, "reset", "--merge"], { timeout: 15_000 });
        } catch (resetErr) {
          warnRecovery("Failed to reset the squash merge during recovery", resetErr);
        }
      }
      if (stashed) {
        try {
          await runGit(["-C", baseCheckout, "stash", "pop"], { timeout: 10_000 });
        } catch (popErr) {
          warnRecovery("Failed to pop auto-stash during recovery", popErr);
        }
      }
      return withWarnings({ success: false, error: errorMessage(err), stashed: stashed || undefined, stashRef });
    }

    let stashPopConflict = false;
    if (stashed) {
      try {
        await runGit(["-C", baseCheckout, "stash", "pop"], { timeout: 10_000 });
      } catch (err) {
        stashPopConflict = true;
        warnRecovery("Failed to pop auto-stash after merge", err);
      }
    }

    return withWarnings({
      success: true,
      ...(strategy === "squash" ? { squash: true } : { fastForward: true }),
      stashed: stashed || undefined,
      stashRef,
      stashPopConflict: stashPopConflict || undefined,
    });
  } catch (err) {
    return withWarnings({
      success: false,
      error: errorMessage(err),
      stashed: stashed || undefined,
      stashRef,
    });
  }
}
