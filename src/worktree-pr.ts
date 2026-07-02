import { execFileSync } from "child_process";
import { isGitHubCLIAvailable } from "./worktree-repo";

export interface PRResult {
  success: boolean;
  prUrl?: string;
  error?: string;
  warnings?: string[];
}

export interface PRStatus {
  exists: boolean;
  state: "open" | "merged" | "closed" | "none";
  url?: string;
  number?: number;
  title?: string;
  headRefName?: string;
  baseRefName?: string;
}

function normalizePrState(state: string): PRStatus["state"] {
  const ghState = state.toLowerCase();
  return ghState === "open"
    ? "open"
    : ghState === "merged"
      ? "merged"
      : ghState === "closed"
        ? "closed"
        : "none";
}

export interface CreatePROptions {
  draft?: boolean;
}

export interface WorktreeOutcomeParams {
  kind: "merge" | "pr-opened" | "pr-updated";
  branch: string;
  base?: string;
  targetRepo?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  prUrl?: string;
}

function formatOutcomeStats(params: Pick<WorktreeOutcomeParams, "filesChanged" | "insertions" | "deletions">): string {
  return params.filesChanged !== undefined
    ? ` (${params.filesChanged} files, +${params.insertions ?? 0}/-${params.deletions ?? 0})`
    : "";
}

function isExistingPullRequestError(message: string): boolean {
  return /pull request already exists/i.test(message) || (/createPullRequest/i.test(message) && /already exists/i.test(message));
}

function recoverExistingPullRequest(repoDir: string, branch: string, targetRepo?: string): PRResult | undefined {
  const existingPr = syncWorktreePR(repoDir, branch, targetRepo);
  if (existingPr.exists && existingPr.state === "open" && existingPr.url) {
    return {
      success: true,
      prUrl: existingPr.url,
      warnings: ["A PR already exists for this branch; reused the existing open PR."],
    };
  }
  if (existingPr.exists && existingPr.url) {
    return {
      success: false,
      error: `A PR already exists for ${branch}, but it is ${existingPr.state}: ${existingPr.url}`,
    };
  }
  return undefined;
}

function inferOriginOwner(repoDir: string): string | undefined {
  try {
    const originUrl = execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = originUrl.match(/[:/]([^/]+)\/[^/]+(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function resolveGhHeadArg(repoDir: string, branch: string, targetRepo?: string): string {
  if (!targetRepo) {
    return branch;
  }
  const forkOwner = inferOriginOwner(repoDir);
  return forkOwner ? `${forkOwner}:${branch}` : branch;
}

export function createPR(
  repoDir: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  targetRepo?: string,
  options: CreatePROptions = {},
): PRResult {
  if (!isGitHubCLIAvailable()) {
    return { success: false, error: "GitHub CLI (gh) is not available" };
  }

  let args: string[] | undefined;
  try {
    args = ["pr", "create", "--base", base];
    if (options.draft ?? true) {
      args.push("--draft");
    }
    if (targetRepo) {
      args.push("--repo", targetRepo);
    }
    args.push("--head", resolveGhHeadArg(repoDir, branch, targetRepo));
    if (title && body) {
      args.push("--title", title, "--body", body);
    } else {
      args.push("--fill-verbose");
    }

    const result = execFileSync("gh", args, {
      cwd: repoDir,
      timeout: 30_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const prUrl = result.trim();
    return { success: true, prUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isExistingPullRequestError(msg)) {
      return recoverExistingPullRequest(repoDir, branch, targetRepo) ?? { success: false, error: msg };
    }
    // Recovery: if we requested draft and the error indicates drafts are not supported or enabled
    // on the target repo, retry once without --draft so that PR creation does not regress for repos
    // that previously accepted non-draft PRs.
    //
    // The /draft/i heuristic is intentionally broad (as noted in Greptile review) to catch common
    // GitHub CLI messages about draft support ("draft PRs are not supported", "draft", etc.).
    // Trade-off: if a non-draft-related error message happens to contain the substring "draft",
    // we will still retry without the flag and surface an explicit warning to the caller.
    // The caller (agent-pr.ts) always appends warnings to the final tool output text, so there is
    // no silent fallback.
    if ((options.draft ?? true) && args && /draft/i.test(msg)) {
      try {
        const retryArgs = args.filter((a) => a !== "--draft");
        const retryResult = execFileSync("gh", retryArgs, {
          cwd: repoDir,
          timeout: 30_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        const retryUrl = retryResult.trim();
        return { success: true, prUrl: retryUrl, warnings: ["Target repo does not support draft PRs; created as regular (non-draft) PR instead."] };
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (isExistingPullRequestError(retryMsg)) {
          return recoverExistingPullRequest(repoDir, branch, targetRepo)
            ?? { success: false, error: `Draft PR creation failed (${msg}); non-draft retry also failed: ${retryMsg}` };
        }
        return { success: false, error: `Draft PR creation failed (${msg}); non-draft retry also failed: ${retryMsg}` };
      }
    }
    return { success: false, error: msg };
  }
}

export function syncWorktreePR(repoDir: string, branchName: string, targetRepo?: string): PRStatus {
  if (!isGitHubCLIAvailable()) {
    return { exists: false, state: "none" };
  }

  try {
    const ghArgs = ["pr", "list", "--head", branchName, "--state", "all", "--json", "url,number,title,state,headRepositoryOwner,headRefName,baseRefName"];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    const result = execFileSync("gh", ghArgs, {
      cwd: repoDir,
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const prData = result.trim();
    if (!prData) {
      return { exists: false, state: "none" };
    }

    const prs = JSON.parse(prData) as Array<{
      url: string;
      number: number;
      title: string;
      state: string;
      headRepositoryOwner?: { login?: string };
      headRefName?: string;
      baseRefName?: string;
    }>;
    const expectedOwner = targetRepo ? inferOriginOwner(repoDir)?.toLowerCase() : undefined;
    const pr = prs.find((candidate) => (
      candidate.headRefName === branchName
      && (!expectedOwner || candidate.headRepositoryOwner?.login?.toLowerCase() === expectedOwner)
    ));
    if (!pr) {
      return { exists: false, state: "none" };
    }
    const state = normalizePrState(pr.state);

    const status: PRStatus = {
      exists: true,
      state,
      url: pr.url,
      number: pr.number,
      title: pr.title,
    };
    if (pr.headRefName !== undefined) {
      status.headRefName = pr.headRefName;
    }
    if (pr.baseRefName !== undefined) {
      status.baseRefName = pr.baseRefName;
    }
    return status;
  } catch (err) {
    console.warn(`[worktree] Failed to sync PR status for ${branchName}: ${err instanceof Error ? err.message : String(err)}`);
    return { exists: false, state: "none" };
  }
}

export function syncWorktreePRByUrl(repoDir: string, prUrl: string, targetRepo?: string): PRStatus {
  if (!isGitHubCLIAvailable()) {
    return { exists: false, state: "none" };
  }

  try {
    const ghArgs = ["pr", "view", prUrl, "--json", "url,number,title,state,headRefName,baseRefName"];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    const result = execFileSync("gh", ghArgs, {
      cwd: repoDir,
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pr = JSON.parse(result.trim()) as {
      url: string;
      number: number;
      title: string;
      state: string;
      headRefName?: string;
      baseRefName?: string;
    };
    const status: PRStatus = {
      exists: true,
      state: normalizePrState(pr.state),
      url: pr.url,
      number: pr.number,
      title: pr.title,
    };
    if (pr.headRefName !== undefined) {
      status.headRefName = pr.headRefName;
    }
    if (pr.baseRefName !== undefined) {
      status.baseRefName = pr.baseRefName;
    }
    return status;
  } catch (err) {
    console.warn(`[worktree] Failed to sync PR status for ${prUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { exists: false, state: "none" };
  }
}

export function commentOnPR(repoDir: string, prNumber: number, body: string, targetRepo?: string): boolean {
  if (!isGitHubCLIAvailable()) {
    return false;
  }

  try {
    const ghArgs = ["pr", "comment", String(prNumber), "--body", body];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    execFileSync("gh", ghArgs, {
      cwd: repoDir,
      timeout: 30_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (err) {
    console.warn(`[worktree] Failed to comment on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function formatWorktreeOutcomeLine(params: WorktreeOutcomeParams): string {
  const stats = formatOutcomeStats(params);
  if (params.kind === "merge") {
    return `✅ Merged: ${params.branch} → ${params.base ?? "main"}${stats}`;
  }
  if (params.kind === "pr-updated") {
    return `✅ PR updated: ${params.prUrl ?? ""}${stats}`;
  }
  if (params.targetRepo) {
    return `✅ PR opened against ${params.targetRepo}: ${params.prUrl ?? ""}${stats}`;
  }
  return `✅ PR opened: ${params.prUrl ?? ""}${stats}`;
}
