import { existsSync } from "fs";
import type { PersistedSessionInfo } from "./types";
import { checkDirtyTracked, hasCommitsAhead } from "./worktree";

export type WorktreeCompletionState =
  | "no-change"
  | "dirty-uncommitted"
  | "base-advanced"
  | "has-commits";

export class SessionWorktreeController {
  getCompletionState(
    repoDir: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string,
  ): WorktreeCompletionState {
    if (!hasCommitsAhead(repoDir, branchName, baseBranch)) {
      const baseBranchAdvanced = hasCommitsAhead(repoDir, baseBranch, branchName);
      if (baseBranchAdvanced) return "base-advanced";
      if (checkDirtyTracked(worktreePath)) return "dirty-uncommitted";
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
