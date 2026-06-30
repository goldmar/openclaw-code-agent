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
  isBranchAncestorOfBase,
  wouldMergeBeNoop,
} from "./worktree-repo";
import { syncWorktreePR } from "./worktree-pr";
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

function getEffectiveBaseBranch(
  session: Pick<PersistedSessionInfo, "workdir" | "worktreeBaseBranch" | "worktreeLifecycle">,
): string | undefined {
  const workdir = getSessionWorkdir(session);
  return session.worktreeLifecycle?.baseBranch
    ?? session.worktreeBaseBranch
    ?? (workdir && existsSync(workdir) ? detectDefaultBranch(workdir) : undefined);
}

function getSessionWorkdir(session: Pick<PersistedSessionInfo, "workdir">): string | undefined {
  return typeof session.workdir === "string" && session.workdir.length > 0 ? session.workdir : undefined;
}

export function resolveWorktreeLifecycle(
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
  } = {},
): ResolvedWorktreeLifecycle {
  const lifecycle = buildDefaultLifecycle(session);
  const checkedAt = isoNow();
  const reasons = new Set<string>();
  const workdir = getSessionWorkdir(session);
  const repoExists = Boolean(workdir && existsSync(workdir));
  const worktreeExists = Boolean(session.worktreePath && existsSync(session.worktreePath));
  const branchName = session.worktreeBranch;
  const baseBranch = getEffectiveBaseBranch(session);

  let branchPresent = false;
  let dirtyWorktreeEntries = false;
  let topologyMerged = false;
  let releaseNoopMerge = false;
  let branchAheadCount: number | undefined;
  let baseAheadCount: number | undefined;
  let prState: WorktreeRepositoryEvidence["prState"] = "none";
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
    branchPresent = branchExists(workdir, branchName);
    if (!branchPresent) {
      reasons.add("branch_missing");
    }
  }

  if (worktreeExists && session.worktreePath) {
    dirtyWorktreeEntries = hasDirtyWorktreeEntries(session.worktreePath);
    if (dirtyWorktreeEntries) reasons.add("dirty_worktree_entries");
  }

  if (repoExists && workdir && branchPresent && branchName && baseBranch) {
    const counts = getAheadBehindCounts(workdir, branchName, baseBranch);
    branchAheadCount = counts?.ahead;
    baseAheadCount = counts?.behind;
    topologyMerged = isBranchAncestorOfBase(workdir, branchName, baseBranch);
    if (topologyMerged) {
      reasons.add("topology_merged");
    } else {
      releaseNoopMerge = wouldMergeBeNoop(workdir, branchName, baseBranch);
      if (releaseNoopMerge) reasons.add("merge_noop_content_already_on_base");
      if (!releaseNoopMerge && (branchAheadCount ?? 0) > 0) {
        reasons.add("unique_content");
      }
    }
  } else if (!baseBranch) {
    reasons.add("base_branch_missing");
  }

  if (options.includePrSync && repoExists && workdir && branchName) {
    const prStatus = syncWorktreePR(workdir, branchName, session.worktreePrTargetRepo ?? lifecycle.targetRepo);
    prState = prStatus.state;
    prUrl = prStatus.url ?? prUrl;
    prNumber = prStatus.number ?? prNumber;
  }

  if (prState === "open") reasons.add("pr_open");
  if (prState === "merged" && !topologyMerged && !releaseNoopMerge) reasons.add("pr_merged_not_reflected_locally");

  let repositoryDerivedState: ManagedWorktreeLifecycleState | undefined;
  if (topologyMerged) {
    repositoryDerivedState = "merged";
  } else if (releaseNoopMerge) {
    repositoryDerivedState = "released";
  }

  const resolutionBlocked = options.activeSession || dirtyWorktreeEntries;
  let derivedState: ManagedWorktreeLifecycleState = lifecycle.state;
  if (!resolutionBlocked && repositoryDerivedState) {
    derivedState = repositoryDerivedState;
  } else if (!branchPresent && lifecycle.state === "pending_decision") {
    derivedState = "cleanup_failed";
  }

  const resolvedByRepositoryEvidence = derivedState === "merged" || derivedState === "released";
  const preserve = options.activeSession
    || dirtyWorktreeEntries
    || (!resolvedByRepositoryEvidence && lifecycle.state === "pending_decision")
    || lifecycle.state === "merge_conflict_resolving"
    || prState === "open"
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
