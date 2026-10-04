import { existsSync } from "fs";
import type {
  ManagedWorktreeLifecycleState,
  PersistedSessionInfo,
  PersistedWorktreeLifecycle,
  ResolvedWorktreeLifecycle,
  WorktreeRepositoryEvidence,
} from "./types";
import {
  branchExists,
  detectDefaultBranch,
  getAheadBehindCounts,
  getBranchName,
  isBranchAncestorOfBase,
  wouldMergeBeNoop,
} from "./worktree-repo";
import { syncWorktreePR, syncWorktreePRByUrl, type PRStatus } from "./worktree-pr";
import { hasDirtyWorktreeEntries } from "./worktree-lifecycle";

function isoNow(): string {
  return new Date().toISOString();
}

function buildDefaultLifecycle(session: Pick<
  PersistedSessionInfo,
  "worktreeLifecycle" | "worktreePath" | "worktreeBranch" | "worktreeBaseBranch" | "worktreePrTargetRepo" | "worktreePushRemote"
>): PersistedWorktreeLifecycle {
  return session.worktreeLifecycle ?? {
    state: session.worktreePath || session.worktreeBranch ? "provisioned" : "none",
    updatedAt: isoNow(),
    baseBranch: session.worktreeBaseBranch,
    targetRepo: session.worktreePrTargetRepo,
    pushRemote: session.worktreePushRemote,
  };
}

/**
 * The base branch a session lands on: the base this call names; else the base
 * a PR or merge already fixed for the session (its worktree lifecycle); else
 * the base recorded at launch (`worktree_base_branch`); else the repository's
 * detected default branch. Merge, PR, the decision prompt and the status tool
 * all use this one order.
 */
export async function resolveLandingBaseBranch(
  session: Pick<PersistedSessionInfo, "worktreeBaseBranch" | "worktreeLifecycle"> | undefined,
  repoDir: string,
  explicitBaseBranch?: string,
): Promise<string> {
  return explicitBaseBranch
    ?? session?.worktreeLifecycle?.baseBranch
    ?? session?.worktreeBaseBranch
    ?? await detectDefaultBranch(repoDir);
}

async function getEffectiveBaseBranch(
  session: Pick<PersistedSessionInfo, "workdir" | "worktreeBaseBranch" | "worktreeLifecycle">,
): Promise<string | undefined> {
  const workdir = getSessionWorkdir(session);
  return session.worktreeLifecycle?.baseBranch
    ?? session.worktreeBaseBranch
    ?? (workdir && existsSync(workdir) ? await detectDefaultBranch(workdir) : undefined);
}

function getSessionWorkdir(session: Pick<PersistedSessionInfo, "workdir">): string | undefined {
  return typeof session.workdir === "string" && session.workdir.length > 0 ? session.workdir : undefined;
}

export async function resolveWorktreeLifecycle(
  session: Pick<
    PersistedSessionInfo,
    "workdir"
    | "worktreePath"
    | "worktreeBranch"
    | "worktreeBaseBranch"
    | "worktreePrTargetRepo"
    | "worktreePushRemote"
    | "worktreePrUrl"
    | "worktreePrNumber"
    | "worktreeLifecycle"
  >,
  options: {
    activeSession?: boolean;
    includePrSync?: boolean;
    /** Branch PR lookups shared by the calls of one pass (for example a maintenance pass over all sessions). */
    prLookups?: Map<string, Promise<PRStatus>>;
  } = {},
): Promise<ResolvedWorktreeLifecycle> {
  const lifecycle = buildDefaultLifecycle(session);
  const checkedAt = isoNow();
  const reasons = new Set<string>();
  const workdir = getSessionWorkdir(session);
  const repoExists = Boolean(workdir && existsSync(workdir));
  const worktreeExists = Boolean(session.worktreePath && existsSync(session.worktreePath));
  const branchName = session.worktreeBranch;
  const baseBranch = await getEffectiveBaseBranch(session);

  let branchPresent = false;
  let dirtyWorktreeEntries = false;
  let topologyMerged = false;
  let releaseNoopMerge = false;
  let representedByTargetPrBranch = false;
  let branchAheadCount: number | undefined;
  let baseAheadCount: number | undefined;
  let prState: WorktreeRepositoryEvidence["prState"] = "none";
  let branchHasOpenPr = false;
  // The session's recorded PR, read at most once per call.
  let recordedPrLookup: Promise<PRStatus> | undefined;
  const recordedPrStatus = (): Promise<PRStatus> => {
    recordedPrLookup ??= syncWorktreePRByUrl(workdir!, session.worktreePrUrl!, session.worktreePrTargetRepo ?? lifecycle.targetRepo);
    return recordedPrLookup;
  };
  let prUrl = session.worktreePrUrl;
  let prNumber = session.worktreePrNumber;

  if (!repoExists) {
    reasons.add("repo_missing");
  }
  if (!branchName) {
    reasons.add("branch_missing");
  }
  if (!worktreeExists && session.worktreePath) {
    reasons.add("worktree_missing");
  }
  if (options.activeSession) {
    reasons.add("active_session");
  }
  if (lifecycle.state === "pending_decision") {
    reasons.add("pending_decision");
  }
  if (lifecycle.state === "merge_conflict_resolving") {
    reasons.add("merge_conflict_resolving");
  }

  if (repoExists && workdir && branchName) {
    branchPresent = await branchExists(workdir, branchName);
    if (!branchPresent) {
      reasons.add("branch_missing");
    }
  }

  if (worktreeExists && session.worktreePath) {
    dirtyWorktreeEntries = await hasDirtyWorktreeEntries(session.worktreePath);
    if (dirtyWorktreeEntries) reasons.add("dirty_worktree_entries");
  }

  if (repoExists && workdir && branchPresent && branchName && baseBranch) {
    const counts = await getAheadBehindCounts(workdir, branchName, baseBranch);
    branchAheadCount = counts?.ahead;
    baseAheadCount = counts?.behind;
    topologyMerged = await isBranchAncestorOfBase(workdir, branchName, baseBranch);
    if (topologyMerged) {
      reasons.add("topology_merged");
    } else {
      releaseNoopMerge = await wouldMergeBeNoop(workdir, branchName, baseBranch);
      if (releaseNoopMerge) reasons.add("merge_noop_content_already_on_base");
      if (!releaseNoopMerge && (branchAheadCount ?? 0) > 0) {
        reasons.add("unique_content");
      }
    }
    const currentRepoBranch = await getBranchName(workdir);
    if (options.includePrSync && session.worktreePrUrl && currentRepoBranch && currentRepoBranch !== branchName && currentRepoBranch !== baseBranch) {
      const currentPrStatus = await recordedPrStatus();
      representedByTargetPrBranch = Boolean(
        (currentPrStatus.state === "open" || currentPrStatus.state === "merged")
        && currentPrStatus.headRefName === currentRepoBranch
        && currentPrStatus.baseRefName === baseBranch
        && await isBranchAncestorOfBase(workdir, branchName, currentRepoBranch)
      );
      if (representedByTargetPrBranch) {
        reasons.delete("unique_content");
        reasons.add(`released_by_branch:${currentRepoBranch}`);
      }
    }
  } else if (!baseBranch) {
    reasons.add("base_branch_missing");
  }

  if (options.includePrSync && repoExists && workdir && branchName) {
    // Like `agent_pr`: the session's recorded PR first (when it is this
    // branch's PR), else the branch's PR into the session's base branch.
    // A recorded URL is trusted only for this repository's own branch.
    const prTargetRepo = session.worktreePrTargetRepo ?? lifecycle.targetRepo;
    const recordedPr = session.worktreePrUrl ? await recordedPrStatus() : undefined;
    const recordedIsBranchPr = Boolean(recordedPr?.exists && recordedPr.headRefName === branchName && recordedPr.ownHead !== false);
    const lookupBranchPr = (): Promise<PRStatus> => {
      const lookupBase = session.worktreeBaseBranch ?? lifecycle.baseBranch;
      const key = [workdir, branchName, prTargetRepo ?? "", lookupBase ?? ""].join("\0");
      const pending = options.prLookups?.get(key) ?? syncWorktreePR(workdir, branchName, prTargetRepo, lookupBase);
      options.prLookups?.set(key, pending);
      return pending;
    };
    let prStatus: PRStatus;
    if (recordedIsBranchPr) {
      prStatus = recordedPr!;
      // Retention must not remove the worktree while any PR of this branch is
      // open, into whatever base, also one opened by hand next to a closed
      // recorded PR. No lookup is needed when the recorded PR is open (it
      // preserves by itself) or merged (the branch landed), or when no
      // worktree is left to keep.
      if (prStatus.state === "closed" && worktreeExists) branchHasOpenPr = (await lookupBranchPr()).anyOpen === true;
    } else {
      prStatus = await lookupBranchPr();
      branchHasOpenPr = prStatus.anyOpen === true;
    }
    if (branchHasOpenPr && prStatus.state !== "open") reasons.add("branch_pr_open");
    prState = prStatus.state;
    prUrl = prStatus.url ?? prUrl;
    prNumber = prStatus.number ?? prNumber;
  }

  if (prState === "open") reasons.add("pr_open");
  if (prState === "merged" && !topologyMerged && !releaseNoopMerge) reasons.add("pr_merged_not_reflected_locally");
  const stalePrOpenLifecycle = options.includePrSync && lifecycle.state === "pr_open" && prState !== "open";
  if (stalePrOpenLifecycle) reasons.add("stale_pr_open");

  let repositoryDerivedState: ManagedWorktreeLifecycleState | undefined;
  if (topologyMerged) {
    repositoryDerivedState = "merged";
  } else if (releaseNoopMerge || representedByTargetPrBranch) {
    repositoryDerivedState = "released";
  }

  const resolutionBlocked = options.activeSession || dirtyWorktreeEntries;
  let derivedState: ManagedWorktreeLifecycleState = lifecycle.state;
  if (!resolutionBlocked && repositoryDerivedState) {
    derivedState = repositoryDerivedState;
  } else if (stalePrOpenLifecycle) {
    derivedState = "pending_decision";
  } else if (!branchPresent && lifecycle.state === "pending_decision") {
    derivedState = "cleanup_failed";
  }

  const resolvedByRepositoryEvidence = derivedState === "merged" || derivedState === "released";
  const preserve = options.activeSession
    || dirtyWorktreeEntries
    || (!resolvedByRepositoryEvidence && lifecycle.state === "pending_decision")
    || lifecycle.state === "merge_conflict_resolving"
    || prState === "open"
    || branchHasOpenPr
    || reasons.has("pr_merged_not_reflected_locally");
  const cleanupSafe = !preserve && (
    derivedState === "merged"
    || derivedState === "released"
    || lifecycle.state === "dismissed"
    || lifecycle.state === "no_change"
  );

  const evidence: WorktreeRepositoryEvidence = {
    checkedAt,
    repoExists,
    branchExists: branchPresent,
    worktreeExists,
    activeSession: options.activeSession === true,
    dirtyTracked: dirtyWorktreeEntries,
    topologyMerged,
    releaseNoopMerge,
    representedByTargetPrBranch,
    branchAheadCount,
    baseAheadCount,
    prState,
    prUrl,
    prNumber,
    reasons: [...reasons],
  };

  return {
    lifecycle,
    evidence,
    derivedState,
    cleanupSafe,
    preserve,
    reasons: [...reasons],
  };
}
