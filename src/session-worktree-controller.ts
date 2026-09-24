import { existsSync } from "fs";
import type { PersistedSessionInfo } from "./types";
import { getBranchName, getCommitsAheadCount, hasDirtyWorktreeEntries, isBranchAncestorOfBase, wouldMergeBeNoop } from "./worktree";

export type WorktreeCompletionState =
  | "no-change"
  | "dirty-uncommitted"
  | "base-advanced"
  | "merged"
  | "released"
  | "has-commits";

export class SessionWorktreeController {
  async getCompletionState(
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<WorktreeCompletionState> {
    // Never classify or clean a worktree whose checked-out branch does not
    // match the session's persisted association. This can happen after a
    // stale resume/recovery row points at a sibling replacement worktree.
    if ((await getBranchName(worktreePath)) !== branchName) return "has-commits";
    const branchAheadCount = await getCommitsAheadCount(repoDir, branchName, baseBranch);
    if (branchAheadCount === undefined) return "has-commits";
    if (branchAheadCount === 0) {
      const baseAheadCount = await getCommitsAheadCount(repoDir, baseBranch, branchName);
      if (baseAheadCount === undefined) return "has-commits";
      if (baseAheadCount > 0) {
        if (await isBranchAncestorOfBase(repoDir, branchName, baseBranch)) return "merged";
        return "base-advanced";
      }
      if (await hasDirtyWorktreeEntries(worktreePath)) return "dirty-uncommitted";
      return "no-change";
    }
    if (await hasDirtyWorktreeEntries(worktreePath)) return "dirty-uncommitted";
    if (await wouldMergeBeNoop(repoDir, branchName, baseBranch)) return "released";
    return "has-commits";
  }

  async isResolvedWorktreeEligibleForCleanup(
    session: PersistedSessionInfo,
    now: number,
    retentionMs: number,
  ): Promise<boolean> {
    if (!session.worktreePath || !session.workdir) return false;
    if (!existsSync(session.worktreePath)) return false;
    if (session.pendingWorktreeDecisionSince) return false;
    if (session.worktreeState === "pending_decision") return false;
    if (session.pendingPlanApproval || session.resumable) return false;
    if (session.worktreeBranch && (await getBranchName(session.worktreePath)) !== session.worktreeBranch) return false;

    const resolvedAtIso =
      session.worktreeMergedAt
      ?? session.worktreeDismissedAt
      ?? session.completedAt
      ?? session.createdAt;
    const resolvedAt = typeof resolvedAtIso === "string"
      ? new Date(resolvedAtIso).getTime()
      : Number(resolvedAtIso ?? 0);

    return Boolean(resolvedAt) && now - resolvedAt >= retentionMs;
  }
}
