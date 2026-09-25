import { assertBranchName } from "./worktree-ref-validation";
import { runGh, runGit, type CommandError } from "./git-exec";
import { hasGitHubRemote, isGitHubCLIAvailable } from "./worktree-repo";
import { createLogger } from "./logger";

const log = createLogger("worktree-pr");

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
  body?: string;
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

const ESCAPED_NEWLINE_SEPARATOR = /(?<!\\)\\(?:r\\)?n/g;

/** Decode transport-escaped Markdown newlines without rewriting intentional escaped text. */
export function normalizeExplicitPrBody(body: string): string {
  if (/\r|\n/.test(body) || !/(?<!\\)\\n\\n/.test(body)) return body;
  const candidate = body.replace(ESCAPED_NEWLINE_SEPARATOR, "\n");
  const lines = candidate.split("\n");
  const hasMarkdownStructure = lines.some((line) => /^#{1,6}\s+\S/.test(line.trim()))
    && lines.some((line) => /^(?:[-*+]\s+|\d+\.\s+|```)/.test(line.trim()));
  return hasMarkdownStructure ? candidate : body;
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

/**
 * What gh reported for a failed command: its stderr when there is any. The
 * thrown message starts with the full command line (`Command failed: gh pr
 * create ... --draft ... --body <PR body>`), so matching on it would find
 * `draft` or `already exists` in OCA's own arguments.
 */
function ghFailureReason(err: unknown): string {
  const stderr = (err as CommandError | undefined)?.stderr?.trim();
  if (stderr) return stderr;
  return err instanceof Error ? err.message : String(err);
}

function isExistingPullRequestError(message: string): boolean {
  return /pull request already exists/i.test(message) || (/createPullRequest/i.test(message) && /already exists/i.test(message));
}

async function recoverExistingPullRequest(repoDir: string, branch: string, targetRepo?: string): Promise<PRResult | undefined> {
  const existingPr = await syncWorktreePR(repoDir, branch, targetRepo);
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

async function inferOriginOwner(repoDir: string): Promise<string | undefined> {
  try {
    const originUrl = (await runGit(["-C", repoDir, "remote", "get-url", "origin"], { timeout: 5_000 })).trim();
    const match = originUrl.match(/[:/]([^/]+)\/[^/]+(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function resolveGhHeadArg(repoDir: string, branch: string, targetRepo?: string): Promise<string> {
  if (!targetRepo) {
    return branch;
  }
  const forkOwner = await inferOriginOwner(repoDir);
  return forkOwner ? `${forkOwner}:${branch}` : branch;
}

export async function createPR(
  repoDir: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  targetRepo?: string,
  options: CreatePROptions = {},
): Promise<PRResult> {
  await assertBranchName(branch);
  await assertBranchName(base);
  if (!targetRepo && !(await hasGitHubRemote(repoDir))) {
    return { success: false, error: "The repository has no GitHub remote that gh can serve, so a pull request cannot be opened" };
  }
  if (!(await isGitHubCLIAvailable())) {
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
    args.push("--head", await resolveGhHeadArg(repoDir, branch, targetRepo));
    if (title && body) {
      args.push("--title", title, "--body", normalizeExplicitPrBody(body));
    } else {
      args.push("--fill-verbose");
    }

    const result = await runGh(args, { cwd: repoDir, timeout: 30_000 });
    const prUrl = result.trim();
    return { success: true, prUrl };
  } catch (err) {
    const reason = ghFailureReason(err);
    if (isExistingPullRequestError(reason)) {
      return (await recoverExistingPullRequest(repoDir, branch, targetRepo)) ?? { success: false, error: reason };
    }
    // Recovery: if we requested draft and gh reports that drafts are not supported or enabled
    // on the target repo, retry once without --draft so that PR creation does not regress for repos
    // that previously accepted non-draft PRs.
    //
    // The /draft/i heuristic is intentionally broad (as noted in Greptile review) to catch common
    // GitHub CLI messages about draft support ("draft PRs are not supported", "draft", etc.). It
    // reads gh's stderr only: the thrown message also echoes the command line, whose `--draft`
    // flag (and PR body) would otherwise match every failure.
    // Trade-off: if a non-draft-related gh error happens to contain the substring "draft",
    // we will still retry without the flag and surface an explicit warning to the caller.
    // The caller (agent-pr.ts) always appends warnings to the final tool output text, so there is
    // no silent fallback.
    if ((options.draft ?? true) && args && /draft/i.test(reason)) {
      try {
        const retryArgs = args.filter((a) => a !== "--draft");
        const retryResult = await runGh(retryArgs, { cwd: repoDir, timeout: 30_000 });
        const retryUrl = retryResult.trim();
        return { success: true, prUrl: retryUrl, warnings: ["Target repo does not support draft PRs; created as regular (non-draft) PR instead."] };
      } catch (retryErr) {
        const retryReason = ghFailureReason(retryErr);
        if (isExistingPullRequestError(retryReason)) {
          return (await recoverExistingPullRequest(repoDir, branch, targetRepo))
            ?? { success: false, error: `Draft PR creation failed (${reason}); non-draft retry also failed: ${retryReason}` };
        }
        return { success: false, error: `Draft PR creation failed (${reason}); non-draft retry also failed: ${retryReason}` };
      }
    }
    return { success: false, error: reason };
  }
}

export async function syncWorktreePR(repoDir: string, branchName: string, targetRepo?: string): Promise<PRStatus> {
  await assertBranchName(branchName);
  // Without a GitHub remote gh can serve (and no explicit target repo) there is no PR to find.
  if (!targetRepo && !(await hasGitHubRemote(repoDir))) {
    return { exists: false, state: "none" };
  }
  if (!(await isGitHubCLIAvailable())) {
    return { exists: false, state: "none" };
  }

  try {
    const ghArgs = ["pr", "list", "--head", branchName, "--state", "all", "--json", "url,number,title,state,headRepositoryOwner,headRefName,baseRefName"];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    const result = await runGh(ghArgs, { cwd: repoDir, timeout: 10_000 });

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
    const expectedOwner = targetRepo ? (await inferOriginOwner(repoDir))?.toLowerCase() : undefined;
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
    log.warn(`[worktree] Failed to sync PR status for ${branchName}: ${err instanceof Error ? err.message : String(err)}`);
    return { exists: false, state: "none" };
  }
}

export async function syncWorktreePRByUrl(repoDir: string, prUrl: string, targetRepo?: string): Promise<PRStatus> {
  if (!(await isGitHubCLIAvailable())) {
    return { exists: false, state: "none" };
  }

  try {
    const ghArgs = ["pr", "view", prUrl, "--json", "url,number,title,state,headRefName,baseRefName"];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    const result = await runGh(ghArgs, { cwd: repoDir, timeout: 10_000 });
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
    log.warn(`[worktree] Failed to sync PR status for ${prUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { exists: false, state: "none" };
  }
}

export type PRBodyReadResult =
  | { ok: true; body?: string }
  | { ok: false; error: string };

export async function getPRBody(repoDir: string, prNumberOrUrl: number | string, targetRepo?: string): Promise<PRBodyReadResult> {
  if (!(await isGitHubCLIAvailable())) {
    return { ok: false, error: "GitHub CLI (gh) is not available" };
  }

  try {
    const ghArgs = ["pr", "view", String(prNumberOrUrl), "--json", "body"];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    const result = await runGh(ghArgs, { cwd: repoDir, timeout: 10_000 });
    const pr = JSON.parse(result.trim()) as { body?: string };
    return { ok: true, body: typeof pr.body === "string" ? pr.body : undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[worktree] Failed to read PR body for ${prNumberOrUrl}: ${message}`);
    return { ok: false, error: message };
  }
}

export async function updatePRBody(repoDir: string, prNumberOrUrl: number | string, body: string, targetRepo?: string): Promise<boolean> {
  if (!(await isGitHubCLIAvailable())) {
    return false;
  }

  try {
    const ghArgs = ["pr", "edit", String(prNumberOrUrl), "--body", normalizeExplicitPrBody(body)];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    await runGh(ghArgs, { cwd: repoDir, timeout: 30_000 });
    return true;
  } catch (err) {
    log.warn(`[worktree] Failed to update PR body for ${prNumberOrUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function updatePRTitle(repoDir: string, prNumberOrUrl: number | string, title: string, targetRepo?: string): Promise<boolean> {
  if (!(await isGitHubCLIAvailable())) {
    return false;
  }

  try {
    const ghArgs = ["pr", "edit", String(prNumberOrUrl), "--title", title];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    await runGh(ghArgs, { cwd: repoDir, timeout: 30_000 });
    return true;
  } catch (err) {
    log.warn(`[worktree] Failed to update PR title for ${prNumberOrUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function commentOnPR(repoDir: string, prNumber: number, body: string, targetRepo?: string): Promise<boolean> {
  if (!(await isGitHubCLIAvailable())) {
    return false;
  }

  try {
    const ghArgs = ["pr", "comment", String(prNumber), "--body", body];
    if (targetRepo) {
      ghArgs.push("--repo", targetRepo);
    }
    await runGh(ghArgs, { cwd: repoDir, timeout: 30_000 });
    return true;
  } catch (err) {
    log.warn(`[worktree] Failed to comment on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`);
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
