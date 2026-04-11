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
import { checkDirtyTracked } from "./worktree-merge";

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
  return session.worktreeLifecycle?.baseBranch
    ?? session.worktreeBaseBranch
    ?? (existsSync(session.workdir) ? detectDefaultBranch(session.workdir) : undefined);
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
  const repoExists = existsSync(session.workdir);
  const worktreeExists = Boolean(session.worktreePath && existsSync(session.worktreePath));
  const branchName = session.worktreeBranch;
  const baseBranch = getEffectiveBaseBranch(session);

  let branchPresent = false;
  let dirtyTracked = false;
  let topologyMerged = false;
  let releaseNoopMerge = false;
  let branchAheadCount: number | undefined;
  let baseAheadCount: number | undefined;
  let prState: WorktreeRepositoryEvidence["prState"] = session.worktreePrUrl ? "open" : "none";
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

  if (repoExists && branchName) {
    branchPresent = branchExists(session.workdir, branchName);
    if (!branchPresent) {
      reasons.add("branch_missing");
    }
  }

  if (worktreeExists && session.worktreePath) {
    dirtyTracked = checkDirtyTracked(session.worktreePath);
    if (dirtyTracked) reasons.add("dirty_tracked_changes");
  }

  if (repoExists && branchPresent && baseBranch) {
    const counts = getAheadBehindCounts(session.workdir, branchName!, baseBranch);
    branchAheadCount = counts?.ahead;
    baseAheadCount = counts?.behind;
    topologyMerged = isBranchAncestorOfBase(session.workdir, branchName!, baseBranch);
    if (topologyMerged) {
      reasons.add("topology_merged");
    } else {
      releaseNoopMerge = wouldMergeBeNoop(session.workdir, branchName!, baseBranch);
      if (releaseNoopMerge) reasons.add("merge_noop_content_already_on_base");
      if (!releaseNoopMerge && (branchAheadCount ?? 0) > 0) {
        reasons.add("unique_content");
      }
    }
  } else if (!baseBranch) {
    reasons.add("base_branch_missing");
  }

  if (options.includePrSync && repoExists && branchName) {
    const prStatus = syncWorktreePR(session.workdir, branchName, session.worktreePrTargetRepo ?? lifecycle.targetRepo);
    prState = prStatus.state;
    prUrl = prStatus.url ?? prUrl;
    prNumber = prStatus.number ?? prNumber;
  }

  if (prState === "open") reasons.add("pr_open");
  if (prState === "merged" && !topologyMerged && !releaseNoopMerge) reasons.add("pr_merged_not_reflected_locally");

  let derivedState: ManagedWorktreeLifecycleState = lifecycle.state;
  if (topologyMerged) {
    derivedState = "merged";
  } else if (releaseNoopMerge) {
    derivedState = "released";
  } else if (!branchPresent && lifecycle.state === "pending_decision") {
    derivedState = "cleanup_failed";
  }

  const preserve = options.activeSession
    || dirtyTracked
    || lifecycle.state === "pending_decision"
    || lifecycle.state === "merge_conflict_resolving"
    || lifecycle.state === "pr_open"
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
    dirtyTracked,
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
