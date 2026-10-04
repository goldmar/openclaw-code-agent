import { assertBranchName, localBranchRef } from "./worktree-ref-validation";
import { runGh, runGit, type CommandError } from "./git-exec";
import { hasGitHubRemote, isGitHubCLIAvailable, knownGitHubHosts } from "./worktree-repo";
import { createLogger } from "./logger";
import { formatCount } from "./format";

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
  headRefOid?: string;
  mergedAt?: string;
  /** False when the PR's head is known not to be this repository's branch (another owner's or a deleted fork). */
  ownHead?: boolean;
  /** Branch lookup only: whether any PR of this repository's branch is open, into whatever base. */
  anyOpen?: boolean;
  /** Branch lookup only: gh could not be asked (the reason). `exists: false` then means "unknown", not "no PR". */
  lookupFailed?: string;
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
  pushRemote?: string;
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
  /** Session name shown as `[name]` after the status icon. */
  sessionName?: string;
  /** This outcome is the successful terminal session notice, not a manual milestone. */
  sessionCompleted?: boolean;
}

function formatOutcomeStats(params: Pick<WorktreeOutcomeParams, "filesChanged" | "insertions" | "deletions">): string {
  return params.filesChanged !== undefined
    ? ` (${formatCount(params.filesChanged, "file")}, +${params.insertions ?? 0}/-${params.deletions ?? 0})`
    : "";
}

/**
 * What gh reported for a failed command: its stderr, or a description of how
 * it failed. Never the thrown message: it contains the full command line
 * (`gh pr create ... --draft ... --body <PR body>`), so heuristics would match
 * `draft` or `already exists` in OCA's own arguments, and the PR body would
 * leak into the tool result.
 */
function ghFailureReason(err: unknown): string {
  const failure = err as CommandError | undefined;
  const stderr = failure?.stderr?.trim();
  if (stderr) return stderr;
  if (failure?.killed) return "gh did not finish before its timeout";
  if (typeof failure?.code === "number") return `gh exited with code ${failure.code} without an error message`;
  if (typeof failure?.code === "string") return `gh could not run (${failure.code})`;
  return "gh failed without an error message";
}

/**
 * gh refused to create a duplicate: the GraphQL error (`A pull request already
 * exists for …`, `createPullRequest`) or gh's own check before the request
 * (`a pull request for branch "X" into branch "Y" already exists:`).
 */
function isExistingPullRequestError(message: string): boolean {
  return /pull request already exists/i.test(message)
    || (/createPullRequest/i.test(message) && /already exists/i.test(message))
    || /a pull request for branch .+ into branch .+ already exists/i.test(message);
}

/** How long a failed canonical-name lookup is remembered, so a gh outage costs one call, not one per session. */
const CANONICAL_REPO_FAILURE_TTL_MS = 5 * 60_000;

/** Canonical `owner/repo` per named repository, as GitHub names it now; shared while a lookup is in flight. */
const canonicalRepoNames = new Map<string, { name: Promise<string | undefined>; failedAt?: number }>();

/** Test hook: forget the cached canonical repository names. */
export function resetCanonicalRepoNamesForTests(): void {
  canonicalRepoNames.clear();
}

/**
 * GitHub's current `owner/repo` for a repository named `expected`. The name is
 * passed explicitly (gh's own choice of remote may prefer `upstream`); GitHub
 * redirects a renamed or transferred repository, so the canonical name comes back.
 */
/**
 * How a repository is named for gh and for the PR-URL comparison: `ownerRepo`
 * (lower case) is what a PR URL's path is compared with, and `ghName` is the
 * name gh takes, which is also the cache key: `HOST/OWNER/REPO` only for a
 * GitHub host gh is configured for other than github.com (GitHub Enterprise),
 * and plain `OWNER/REPO` otherwise. `ssh.github.com` and SSH config aliases
 * are not hosts gh knows, so they keep the plain name, as before.
 */
export function repoNameForGh(
  source: { targetRepo?: string; originUrl?: string },
  gitHubHosts: ReadonlySet<string> = knownGitHubHosts(),
): { ownerRepo: string; ghName: string } | undefined {
  const qualify = (host: string | undefined, ownerRepo: string): string =>
    (host && host !== "github.com" && gitHubHosts.has(host) ? `${host}/${ownerRepo}` : ownerRepo);
  const target = source.targetRepo?.trim();
  if (target) {
    const parts = target.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    const ownerRepo = parts.slice(-2).join("/").toLowerCase();
    const host = parts.length >= 3 ? parts.slice(0, -2).join("/").toLowerCase() : undefined;
    return { ownerRepo, ghName: qualify(host, ownerRepo) };
  }
  const origin = source.originUrl?.trim();
  if (!origin) return undefined;
  // `git@host:owner/repo.git`, `ssh://git@host[:port]/owner/repo.git`, `https://[user@]host/owner/repo.git`
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+(?:.*\/)?([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin);
  if (!match) return undefined;
  const host = match[1]!.toLowerCase();
  const ownerRepo = match[2]!.toLowerCase();
  return { ownerRepo, ghName: qualify(host, ownerRepo) };
}

function canonicalRepoName(repoDir: string, expected: string): Promise<string | undefined> {
  const cached = canonicalRepoNames.get(expected);
  if (cached && (cached.failedAt === undefined || Date.now() - cached.failedAt < CANONICAL_REPO_FAILURE_TTL_MS)) return cached.name;
  const entry: { name: Promise<string | undefined>; failedAt?: number } = {
    name: runGh(["repo", "view", expected, "--json", "nameWithOwner"], { cwd: repoDir, timeout: 10_000 })
      .then((out) => (JSON.parse(out.trim()) as { nameWithOwner?: string }).nameWithOwner?.toLowerCase())
      .catch((): undefined => undefined)
      .then((name) => {
        if (!name) entry.failedAt = Date.now();
        return name;
      }),
  };
  canonicalRepoNames.set(expected, entry);
  return entry.name;
}

/**
 * Whether a PR URL names a PR of the repository that PRs of this checkout go
 * to: the target repo, else origin's repository. gh answers with the PR's
 * canonical URL, while origin's URL (or a configured target repo) may still
 * carry the owner or name from before a rename or transfer. So when the names
 * differ, the repository's identity decides: gh is asked for the canonical
 * name of the expected repository. An unknown side counts as a match; when gh
 * cannot say, differing names are a mismatch.
 */
async function prUrlIsInExpectedRepo(repoDir: string, prUrl: string, targetRepo: string | undefined): Promise<boolean> {
  const urlRepo = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//i.exec(prUrl)?.[1]?.toLowerCase();
  let expected = repoNameForGh({ targetRepo });
  if (!expected) {
    try {
      expected = repoNameForGh({ originUrl: (await runGit(["-C", repoDir, "remote", "get-url", "origin"], { timeout: 5_000 })).trim() });
    } catch {
      expected = undefined;
    }
  }
  if (!urlRepo || !expected || urlRepo === expected.ownerRepo) return true;
  // Asked on the repository's own host (GitHub Enterprise too), and cached per host-qualified name.
  const canonical = await canonicalRepoName(repoDir, expected.ghName);
  return canonical !== undefined && urlRepo === canonical;
}

/**
 * Whether a PR's head is this repository's own branch. With a target repo (a
 * PR from this fork into upstream) the head owner must be the selected push remote's owner.
 * Without one, a PR from the repository itself always counts, whatever its
 * owner is called (origin's URL may still carry the name from before a rename
 * or transfer); a PR that GitHub marks as coming from another repository is
 * left out when its head owner differs from origin's or is unknown (a deleted fork).
 */
function prHeadIsOwnBranch(
  candidate: { headRepositoryOwner?: { login?: string } | null; isCrossRepository?: boolean },
  originOwner: string | undefined,
  targetRepo: string | undefined,
  pushRemote = "origin",
): boolean {
  const headOwner = candidate.headRepositoryOwner?.login?.toLowerCase();
  if (pushRemote !== "origin") return originOwner !== undefined && headOwner === originOwner;
  if (targetRepo) return !originOwner || headOwner === originOwner;
  return !(candidate.isCrossRepository === true && (!headOwner || (originOwner !== undefined && headOwner !== originOwner)));
}

async function recoverExistingPullRequest(repoDir: string, branch: string, targetRepo: string | undefined, base: string, pushRemote = "origin"): Promise<PRResult | undefined> {
  // The PR that "already exists" is the one into the base this PR was created for.
  const existingPr = await syncWorktreePR(repoDir, branch, targetRepo, base, { pushRemote });
  // The lookup only prefers that base: a PR into another base is not the one
  // gh refused to duplicate, so it is neither reused nor reported.
  if (existingPr.exists && existingPr.baseRefName !== undefined && existingPr.baseRefName !== base) return undefined;
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
      error: `A PR already exists for \`${branch}\`, but it is ${existingPr.state}: ${existingPr.url}`,
    };
  }
  return undefined;
}

async function inferHeadOwner(repoDir: string, pushRemote = "origin"): Promise<string | undefined> {
  try {
    await assertBranchName(pushRemote);
    const originUrl = (await runGit(["-C", repoDir, "remote", "get-url", pushRemote], { timeout: 5_000 })).trim();
    return repoNameForGh({ originUrl })?.ownerRepo.split("/")[0];
  } catch {
    return undefined;
  }
}

async function resolveGhHeadArg(repoDir: string, branch: string, targetRepo?: string, pushRemote = "origin"): Promise<string> {
  if (!targetRepo && pushRemote === "origin") {
    return branch;
  }
  const forkOwner = await inferHeadOwner(repoDir, pushRemote);
  if (!forkOwner && pushRemote !== "origin") throw new Error("Could not identify the selected push remote head owner");
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
    args.push("--head", await resolveGhHeadArg(repoDir, branch, targetRepo, options.pushRemote));
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
      return (await recoverExistingPullRequest(repoDir, branch, targetRepo, base, options.pushRemote)) ?? { success: false, error: reason };
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
          return (await recoverExistingPullRequest(repoDir, branch, targetRepo, base, options.pushRemote))
            ?? { success: false, error: `Draft PR creation failed (${reason}); non-draft retry also failed: ${retryReason}` };
        }
        return { success: false, error: `Draft PR creation failed (${reason}); non-draft retry also failed: ${retryReason}` };
      }
    }
    return { success: false, error: reason };
  }
}

/**
 * The PR of a branch. `baseBranch` (the session's recorded base branch, or the
 * base an `agent_pr` call names) makes a PR into that base win over a PR from
 * the same branch into another base. A session's recorded PR is looked up by
 * its URL (`syncWorktreePRByUrl`) before this is used.
 */
export async function syncWorktreePR(
  repoDir: string,
  branchName: string,
  targetRepo?: string,
  baseBranch?: string,
  /** `preferOpen`: an open PR comes before any other, whatever its base (the PR a push would update). */
  options: { preferOpen?: boolean; pushRemote?: string } = {},
): Promise<PRStatus> {
  await assertBranchName(branchName);
  // Without a GitHub remote gh can serve (and no explicit target repo) there is no PR to find.
  if (!targetRepo && !(await hasGitHubRemote(repoDir))) {
    return { exists: false, state: "none" };
  }
  if (!(await isGitHubCLIAvailable())) {
    return { exists: false, state: "none" };
  }

  try {
    const ghArgs = ["pr", "list", "--head", branchName, "--state", "all", "--json", "url,number,title,state,headRepositoryOwner,headRefName,baseRefName,isCrossRepository,headRefOid,mergedAt"];
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
      headRefOid?: string;
      mergedAt?: string;
      isCrossRepository?: boolean;
    }>;
    // Only a PR whose head is this repository's branch counts: `--head <branch>`
    // also lists PRs from other owners' forks that use the same branch name.
    const originOwner = (await inferHeadOwner(repoDir, options.pushRemote))?.toLowerCase();
    if (options.pushRemote && options.pushRemote !== "origin" && !originOwner) return { exists: false, state: "none", lookupFailed: "Could not identify the selected push remote head owner" };
    const headOwnerMatches = (candidate: (typeof prs)[number]): boolean => prHeadIsOwnBranch(candidate, originOwner, targetRepo, options.pushRemote);
    // Which PR, not whatever order gh lists them in: one into the session's
    // base branch before one into another base; then an open one; then the
    // newest (a newer closed PR on a reused branch counts, not an older merged
    // one). With `preferOpen` an open PR comes first, whatever its base.
    const baseRank = (candidate: (typeof prs)[number]): number => (baseBranch && candidate.baseRefName !== baseBranch ? 1 : 0);
    const openRank = (candidate: (typeof prs)[number]): number => (normalizePrState(candidate.state) === "open" ? 0 : 1);
    const own = prs.filter((candidate) => candidate.headRefName === branchName && headOwnerMatches(candidate));
    const pr = [...own].sort((a, b) => (options.preferOpen ? openRank(a) - openRank(b) : 0) || baseRank(a) - baseRank(b) || openRank(a) - openRank(b) || b.number - a.number)[0];
    if (!pr) {
      return { exists: false, state: "none" };
    }
    const state = normalizePrState(pr.state);

    const status: PRStatus = {
      exists: true,
      state,
      anyOpen: own.some((candidate) => openRank(candidate) === 0),
      url: pr.url,
      number: pr.number,
      title: pr.title,
      ...(typeof pr.headRefOid === "string" ? { headRefOid: pr.headRefOid } : {}),
      ...(typeof pr.mergedAt === "string" ? { mergedAt: pr.mergedAt } : {}),
    };
    if (pr.headRefName !== undefined) {
      status.headRefName = pr.headRefName;
    }
    if (pr.baseRefName !== undefined) {
      status.baseRefName = pr.baseRefName;
    }
    return status;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`[worktree] Failed to sync PR status for ${branchName}: ${reason}`);
    return { exists: false, state: "none", lookupFailed: reason.split("\n")[0]!.slice(0, 200) };
  }
}

export async function syncWorktreePRByUrl(repoDir: string, prUrl: string, targetRepo?: string, pushRemote = "origin"): Promise<PRStatus> {
  if (!(await isGitHubCLIAvailable())) {
    return { exists: false, state: "none" };
  }

  try {
    const ghArgs = ["pr", "view", prUrl, "--json", "url,number,title,state,headRefName,baseRefName,headRepositoryOwner,isCrossRepository,headRefOid,mergedAt"];
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
      headRefOid?: string;
      mergedAt?: string;
      headRepositoryOwner?: { login?: string } | null;
      isCrossRepository?: boolean;
    };
    const status: PRStatus = {
      exists: true,
      state: normalizePrState(pr.state),
      url: pr.url,
      number: pr.number,
      title: pr.title,
      ...(typeof pr.headRefOid === "string" ? { headRefOid: pr.headRefOid } : {}),
      ...(typeof pr.mergedAt === "string" ? { mergedAt: pr.mergedAt } : {}),
      // A recorded URL can name any PR: say whether it is a PR of this
      // repository (or of the target repo) whose head is this repository's branch.
      ownHead: prHeadIsOwnBranch(pr, (await inferHeadOwner(repoDir, pushRemote))?.toLowerCase(), targetRepo, pushRemote)
        && await prUrlIsInExpectedRepo(repoDir, pr.url, targetRepo),
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
  const tag = params.sessionName ? `[${params.sessionName}] ` : "";
  const prefix = params.sessionCompleted ? `✅ ${tag}Completed — ` : `ℹ️ ${tag}`;
  if (params.kind === "merge") {
    return `${prefix}Merged: \`${params.branch}\` → \`${params.base ?? "main"}\`${stats}`;
  }
  if (params.kind === "pr-updated") {
    return `${prefix}PR updated: ${params.prUrl ?? ""}${stats}`;
  }
  if (params.targetRepo) {
    return `${prefix}PR opened against ${params.targetRepo}: ${params.prUrl ?? ""}${stats}`;
  }
  return `${prefix}PR opened: ${params.prUrl ?? ""}${stats}`;
}

/** Immutable GitHub PR head, including a merged PR whose remote branch was deleted.
 * A missing or invalid head is unknown; it never proves the branch is settled.
 */
export async function getCommitsNotInPr(repoDir: string, branch: string, status: PRStatus, remote = "origin"): Promise<{ count: number; headRef: string } | undefined> {
  const oid = status.headRefOid;
  if (!status.exists || status.ownHead === false || !oid || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(oid)) return undefined;
  try {
    await assertBranchName(remote);
    const branchRef = await localBranchRef(branch);
    try {
      await runGit(["-C", repoDir, "cat-file", "-e", `${oid}^{commit}`], { timeout: 10_000 });
    } catch {
      // Fetch the authenticated API's exact commit, never the current branch tip.
      await runGit(["-C", repoDir, "fetch", "--no-tags", remote, oid], { timeout: 60_000 });
    }
    const count = Number((await runGit(["-C", repoDir, "rev-list", "--count", `${oid}..${branchRef}`], { timeout: 10_000 })).trim());
    return Number.isSafeInteger(count) && count >= 0 ? { count, headRef: oid } : undefined;
  } catch { return undefined; }
}


/** The review base belongs to the PR target repository, which can differ from
 * the fork receiving the push. Unknown identity must not fall back to origin.
 */
export async function resolvePrBaseRemote(repoDir: string, targetRepo?: string, pushRemote = "origin"): Promise<string | undefined> {
  if (!targetRepo && pushRemote === "origin") return "origin";
  try {
    // Without an explicit target, gh serves the origin repository. A different
    // push fork supplies the head, not the review base.
    const originUrl = targetRepo ? undefined : (await runGit(["-C", repoDir, "remote", "get-url", "origin"], { timeout: 5_000 })).trim();
    const expected = repoNameForGh({ targetRepo, originUrl });
    if (!expected) return undefined;
    const remotes = (await runGit(["-C", repoDir, "remote"], { timeout: 5_000 })).trim().split("\n").filter(Boolean);
    // Prefer the selected push remote when it also identifies the PR target.
    remotes.sort((a, b) => Number(b === pushRemote) - Number(a === pushRemote));
    for (const remote of remotes) {
      await assertBranchName(remote);
      const url = (await runGit(["-C", repoDir, "remote", "get-url", remote], { timeout: 5_000 })).trim();
      if (repoNameForGh({ originUrl: url })?.ghName === expected.ghName) return remote;
    }
  } catch { return undefined; }
  return undefined;
}
