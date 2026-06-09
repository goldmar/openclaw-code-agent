import { execFileSync } from "child_process";
import { isGitHubCLIAvailable } from "./worktree-repo";

export interface PRResult {
  success: boolean;
  prUrl?: string;
  error?: string;
}

export interface PRStatus {
  exists: boolean;
  state: "open" | "merged" | "closed" | "none";
  url?: string;
  number?: number;
  title?: string;
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
    let forkOwner: string | undefined;
    if (targetRepo) {
      try {
        const originUrl = execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], {
          timeout: 5_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const match = originUrl.match(/[:/]([^/]+)\/[^/]+(?:\.git)?$/);
        if (match) forkOwner = match[1];
      } catch {
        // best effort
      }
    }

    args = ["pr", "create", "--base", base];
    if (options.draft ?? true) {
      args.push("--draft");
    }
    if (targetRepo) {
      args.push("--repo", targetRepo);
    }
    if (forkOwner) {
      args.push("--head", `${forkOwner}:${branch}`);
    } else {
      args.push("--head", branch);
    }
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
    // Recovery: if we requested draft and the error indicates drafts are not supported or enabled
    // on the target repo, retry once without --draft so that PR creation does not regress for repos
    // that previously accepted non-draft PRs.
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
        return { success: true, prUrl: retryUrl };
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
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
    const ghArgs = ["pr", "list", "--head", branchName, "--state", "all", "--json", "url,number,title,state", "--jq", ".[0]"];
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

    const pr = JSON.parse(prData) as { url: string; number: number; title: string; state: string };
    const ghState = pr.state.toLowerCase();
    const state =
      ghState === "open"
        ? "open"
        : ghState === "merged"
          ? "merged"
          : ghState === "closed"
            ? "closed"
            : "none";

    return {
      exists: true,
      state,
      url: pr.url,
      number: pr.number,
      title: pr.title,
    };
  } catch (err) {
    console.warn(`[worktree] Failed to sync PR status for ${branchName}: ${err instanceof Error ? err.message : String(err)}`);
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
  if (params.kind === "merge") {
    const stats = (params.filesChanged !== undefined)
      ? ` (${params.filesChanged} files, +${params.insertions ?? 0}/-${params.deletions ?? 0})`
      : "";
    return `✅ Merged: ${params.branch} → ${params.base ?? "main"}${stats}`;
  }
  if (params.kind === "pr-updated") {
    return `✅ PR updated: ${params.prUrl ?? ""}`;
  }
  if (params.targetRepo) {
    return `✅ PR opened against ${params.targetRepo}: ${params.prUrl ?? ""}`;
  }
  return `✅ PR opened: ${params.prUrl ?? ""}`;
}
