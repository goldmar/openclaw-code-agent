import { existsSync } from "fs";
import type { Session } from "./session";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import { getPrimarySessionLookupRef, usesNativeBackendWorktree } from "./session-backend-ref";
import { detectDefaultBranch, getDiffSummary } from "./worktree";
import { resolveWorktreePolicyDecision } from "./repo-policy";
import type { RepoPolicyResolution } from "./repo-policy";

type DiffSummary = NonNullable<ReturnType<typeof getDiffSummary>>;

const RESOLVED_WORKTREE_STATES = new Set([
  "merged",
  "released",
  "pr_open",
  "dismissed",
  "cleanup_failed",
]);

export type PlannedWorktreeAction =
  | { kind: "skip"; result: { notificationSent: boolean; worktreeRemoved: boolean } }
  | { kind: "notify"; label: string; message: string }
  | {
      kind: "dirty-uncommitted";
      worktreePath: string;
      branchName: string;
      baseBranch: string;
    }
  | {
      kind: "no-change";
      repoDir: string;
      worktreePath: string;
      nativeBackendWorktree: boolean;
    }
  | {
      kind: "merged";
      repoDir: string;
      worktreePath: string;
      branchName: string;
      nativeBackendWorktree: boolean;
    }
  | {
      kind: "decision";
      strategy: "ask" | "delegate" | "auto-merge" | "auto-pr";
      policyReason?: string;
      policyBlocked?: boolean;
      allowedActions: {
        merge: boolean;
        pr: boolean;
      };
      repoDir: string;
      worktreePath: string;
      branchName: string;
      baseBranch: string;
      diffSummary: DiffSummary;
      sessionRef?: string;
    };

/**
 * Pure worktree-strategy planner.
 * Computes what should happen next; execution/notifications stay outside.
 */
export class SessionWorktreeActionService {
  constructor(
    private readonly deps: {
      shouldRunWorktreeStrategy: (session: Session) => boolean;
      isAlreadyMerged: (ref: string | undefined) => boolean;
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined;
      getWorktreeCompletionState: (
        repoDir: string,
        worktreePath: string,
        branchName: string,
        baseBranch: string,
      ) => WorktreeCompletionState;
      isPrAvailable: (repoDir: string) => boolean;
      resolveRepoPolicy?: (repoDir: string) => RepoPolicyResolution;
    },
  ) {}

  async plan(session: Session): Promise<PlannedWorktreeAction> {
    const sessionRef = getPrimarySessionLookupRef(session) ?? session.harnessSessionId;
    if (this.deps.isAlreadyMerged(sessionRef)) {
      console.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" already merged — skipping strategy handling`);
      return { kind: "skip", result: { notificationSent: true, worktreeRemoved: false } };
    }
    const resolvedWorktreeState =
      RESOLVED_WORKTREE_STATES.has(session.worktreeState)
        ? session.worktreeState
        : (session.worktreeLifecycle?.state && RESOLVED_WORKTREE_STATES.has(session.worktreeLifecycle.state)
          ? session.worktreeLifecycle.state
          : undefined);
    if (resolvedWorktreeState && !(resolvedWorktreeState === "pr_open" && session.worktreeStrategy === "auto-pr")) {
      console.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" worktree is ${session.worktreeLifecycle?.state ?? session.worktreeState} — skipping strategy handling`);
      return { kind: "skip", result: { notificationSent: true, worktreeRemoved: false } };
    }
    if (session.status !== "completed") {
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }
    if (!this.deps.shouldRunWorktreeStrategy(session)) {
      console.info(`[SessionManager] handleWorktreeStrategy: skipping — session "${session.name}" is in phase "${session.phase}"`);
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    const strategy = session.worktreeStrategy;
    if (!strategy || strategy === "off" || strategy === "manual") {
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    const worktreePath = session.worktreePath!;
    const repoDir = this.deps.resolveWorktreeRepoDir(session.originalWorkdir, worktreePath);
    const branchName = session.worktreeBranch;
    if (!repoDir) {
      return {
        kind: "notify",
        label: "worktree-missing-repo-dir",
        message: `⚠️ [${session.name}] Cannot determine the original repo for worktree ${worktreePath}. Manual inspection is required.`,
      };
    }
    if (!branchName) {
      return {
        kind: "notify",
        label: "worktree-no-branch-name",
        message: `⚠️ [${session.name}] Cannot determine branch name for worktree ${worktreePath}. The worktree may have been removed or is in detached HEAD state. Manual cleanup may be needed.`,
      };
    }

    const nativeBackendWorktree = usesNativeBackendWorktree(session);
    if (nativeBackendWorktree && !existsSync(worktreePath)) {
      return {
        kind: "no-change",
        repoDir,
        worktreePath,
        nativeBackendWorktree,
      };
    }

    const baseBranch = session.worktreeBaseBranch ?? detectDefaultBranch(repoDir);
    const completionState = this.deps.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch);

    if (completionState === "no-change") {
      return {
        kind: "no-change",
        repoDir,
        worktreePath,
        nativeBackendWorktree,
      };
    }
    if (completionState === "merged") {
      return {
        kind: "merged",
        repoDir,
        worktreePath,
        branchName,
        nativeBackendWorktree,
      };
    }
    if (completionState === "base-advanced") {
      return {
        kind: "notify",
        label: "worktree-no-commits-ahead",
        message: `⚠️ [${session.name}] Auto-merge: branch '${branchName}' has no commits ahead of '${baseBranch}', but '${baseBranch}' has new commits — commits likely landed outside the worktree branch. Verify that commits were not made directly to '${baseBranch}' instead of the worktree branch. Worktree: ${worktreePath}`,
      };
    }
    if (completionState === "dirty-uncommitted") {
      return {
        kind: "dirty-uncommitted",
        worktreePath,
        branchName,
        baseBranch,
      };
    }

    const diffSummary = getDiffSummary(repoDir, branchName, baseBranch);
    if (!diffSummary) {
      console.warn(`[SessionManager] Failed to get diff summary for ${branchName}, skipping merge-back`);
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    const livePolicy = session.repoIntegrationPolicy ? undefined : this.deps.resolveRepoPolicy?.(repoDir);
    const policyDecision = resolveWorktreePolicyDecision({
      requestedStrategy: strategy,
      policy: session.repoIntegrationPolicy ?? livePolicy?.policy,
      prAvailable: session.repoIntegrationPolicy
        ? this.deps.isPrAvailable(repoDir)
        : livePolicy?.prAvailable ?? this.deps.isPrAvailable(repoDir),
    });

    if (!policyDecision.strategy) {
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    return {
      kind: "decision",
      strategy: policyDecision.strategy,
      policyReason: policyDecision.reason,
      policyBlocked: policyDecision.blocked,
      allowedActions: policyDecision.allowedActions,
      repoDir,
      worktreePath,
      branchName,
      baseBranch,
      diffSummary,
      sessionRef: sessionRef ?? undefined,
    };
  }
}
