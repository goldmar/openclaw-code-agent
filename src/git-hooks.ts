import { isAbsolute, relative, resolve, sep } from "node:path";
import { pluginConfig } from "./config";
import { runGit } from "./git-exec";
import { localBranchRef } from "./worktree-ref-validation";

/**
 * `git -c` arguments for OCA git commands that can run repository hooks
 * (merge, rebase, commit, push, checkout, worktree add). Empty with the default
 * `worktreeGitHooks: "run"`; with `"skip"` hooks are disabled for that command.
 */
export function repoHookGitArgs(): string[] {
  return pluginConfig.worktreeGitHooks === "skip" ? ["-c", "core.hooksPath=/dev/null"] : [];
}

/** Hook and worktree-provisioning locations a branch must not change without the user's consent. */
const HOOK_DIRECTORY_PREFIXES = [".husky/", ".githooks/"];
const HOOK_FILES = [".openclaw/worktree-setup.sh", ".worktreeinclude"];

/** Repo-relative, slash-terminated directory of `core.hooksPath` when it lies inside the repository. */
async function configuredHooksPrefix(repoDir: string): Promise<string | undefined> {
  let hooksPath: string;
  let repoRoot: string;
  try {
    hooksPath = (await runGit(["-C", repoDir, "config", "--get", "core.hooksPath"], { timeout: 5_000 })).trim();
    repoRoot = (await runGit(["-C", repoDir, "rev-parse", "--show-toplevel"], { timeout: 5_000 })).trim();
  } catch {
    return undefined;
  }
  if (!hooksPath || !repoRoot) return undefined;
  // A relative core.hooksPath is resolved against the working tree that runs the hook.
  const absolute = isAbsolute(hooksPath) ? hooksPath : resolve(repoRoot, hooksPath);
  const inside = relative(repoRoot, absolute);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
  return `${inside.split(sep).join("/").replace(/\/+$/, "")}/`;
}

/**
 * Files changed on `branch` since it left `base` that are git hooks or OCA
 * worktree provisioning inputs: `.husky/`, `.githooks/`, the in-repo
 * `core.hooksPath` directory, `.openclaw/worktree-setup.sh`, `.worktreeinclude`.
 * A merge or PR carrying such a change runs code on the next git operation or
 * worktree creation, so it is never automatic.
 */
export async function listHookPathChanges(repoDir: string, branch: string, base: string, remote = "origin"): Promise<string[]> {
  const branchRef = await localBranchRef(branch);
  const baseRef = await resolveBaseRef(repoDir, base, remote);
  const output = await runGit(
    ["-C", repoDir, "diff", "--name-only", "--no-renames", "-z", `${baseRef}...${branchRef}`],
    { timeout: 15_000 },
  );
  const prefixes = [...HOOK_DIRECTORY_PREFIXES];
  const configured = await configuredHooksPrefix(repoDir);
  if (configured && !prefixes.includes(configured)) prefixes.push(configured);
  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => HOOK_FILES.includes(path) || prefixes.some((prefix) => path.startsWith(prefix)))
    .sort();
}

/**
 * The ref to diff against for `base`: the local branch, else its
 * remote-tracking ref (a PR's base need not be checked out locally), fetched
 * first when it is not there yet. Throws when neither exists; callers treat
 * that as "changed".
 */
async function resolveBaseRef(repoDir: string, base: string, remote: string): Promise<string> {
  const localRef = await localBranchRef(base);
  const exists = async (ref: string): Promise<boolean> => {
    try {
      await runGit(["-C", repoDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  };
  if (await exists(localRef)) return localRef;
  const remoteRef = `refs/remotes/${remote}/${localRef.replace(/^refs\/heads\//, "")}`;
  if (await exists(remoteRef)) return remoteRef;
  await runGit(["-C", repoDir, "fetch", "--no-tags", remote, `+${localRef}:${remoteRef}`], { timeout: 60_000 });
  if (await exists(remoteRef)) return remoteRef;
  throw new Error(`base branch ${base} was not found locally or on ${remote}`);
}

/**
 * True only when git positively reports that the local branch does not exist
 * (a listing that succeeds and is empty). Such a branch has no commits to
 * merge or push. Any failure to find out is "not known missing".
 */
export async function localBranchIsKnownMissing(repoDir: string, branch: string): Promise<boolean> {
  try {
    const ref = await localBranchRef(branch);
    const listed = await runGit(["-C", repoDir, "for-each-ref", "--format=%(refname)", ref], { timeout: 10_000 });
    return !listed.split("\n").some((line) => line.trim() === ref);
  } catch {
    return false;
  }
}

/** The warning when the hook-change check itself could not be computed: unknown counts as changed, so a person decides. */
export const HOOK_CHECK_UNAVAILABLE_WARNING =
  "⚠️ Could not check this branch for git hook or worktree setup changes, so merging or opening a PR needs your confirmation.";

/** One line naming hook-path changes for a user prompt, or undefined when there are none. */
export function describeHookPathChanges(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const shown = paths.slice(0, 8).map((path) => `\`${path}\``).join(", ");
  const more = paths.length > 8 ? ` and ${paths.length - 8} more` : "";
  return `⚠️ This branch changes git hook or worktree setup files: ${shown}${more}. They run code on later git operations, so merging or opening a PR needs your confirmation.`;
}
