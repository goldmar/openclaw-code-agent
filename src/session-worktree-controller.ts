import { existsSync } from "fs";
import type { PersistedSessionInfo } from "./types";
import { getCommitsAheadCount, hasDirtyWorktreeEntries, isBranchAncestorOfBase } from "./worktree";

export type WorktreeCompletionState =
  | "no-change"
  | "dirty-uncommitted"
  | "base-advanced"
  | "merged"
  | "has-commits";

export class SessionWorktreeController {
  getCompletionState(
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): WorktreeCompletionState {
    const branchAheadCount = getCommitsAheadCount(repoDir, branchName, baseBranch);
    if (branchAheadCount === undefined) return "has-commits";
    if (branchAheadCount === 0) {
      const baseAheadCount = getCommitsAheadCount(repoDir, baseBranch, branchName);
      if (baseAheadCount === undefined) return "has-commits";
      if (baseAheadCount > 0) {
        if (isBranchAncestorOfBase(repoDir, branchName, baseBranch)) return "merged";
        return "base-advanced";
      }
      if (hasDirtyWorktreeEntries(worktreePath)) return "dirty-uncommitted";
      return "no-change";
    }
    return "has-commits";
  }

  isResolvedWorktreeEligibleForCleanup(
    session: PersistedSessionInfo,
    now: number,
    retentionMs: number,
  ): boolean {
    if (!session.worktreePath || !session.workdir) return false;
    if (!existsSync(session.worktreePath)) return false;
    if (session.pendingWorktreeDecisionSince) return false;
    if (session.worktreeState === "pending_decision") return false;

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
