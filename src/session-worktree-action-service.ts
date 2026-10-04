import type { Session } from "./session";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import { getPrimarySessionLookupRef } from "./session-backend-ref";
import { getCommitsAheadCount, getDiffSummary, resolveLandingBaseBranch } from "./worktree";
import { resolveWorktreePolicyDecision } from "./repo-policy";
import type { RepoPolicyResolution } from "./repo-policy";
import type { RepoIntegrationPolicy } from "./types";
import { createLogger } from "./logger";

const log = createLogger("session-worktree-action-service");

type DiffSummary = NonNullable<Awaited<ReturnType<typeof getDiffSummary>>>;

const RESOLVED_WORKTREE_STATES = new Set([
  "merged",
  "released",
  "pr_open",
  "dismissed",
  "cleanup_failed",
]);

export type PlannedWorktreeAction =
  | { kind: "skip"; result: { notificationSent: boolean; worktreeRemoved: boolean } }
  /** `problem` completes `⚠️ [name] Completed — `; `detail` lines follow it. */
  | { kind: "notify"; label: string; problem: string; detail: string[] }
  | {
      kind: "dirty-uncommitted";
      worktreePath: string;
      branchName: string;
      baseBranch: string;
      /** True when the branch has no commits of its own (only then is there "nothing to merge"). */
      noCommits: boolean;
    }
  | {
      kind: "no-change";
      repoDir: string;
      worktreePath: string;
      branchName: string;
    }
  | {
      kind: "merged";
      repoDir: string;
      worktreePath: string;
      branchName: string;
      baseBranch: string;
    }
  | {
      kind: "released";
      repoDir: string;
      worktreePath: string;
      branchName: string;
      baseBranch: string;
      reasons: string[];
    }
  | {
      kind: "decision";
      strategy: "ask" | "delegate" | "auto-merge" | "auto-pr";
      policy?: RepoIntegrationPolicy;
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
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined | Promise<string | undefined>;
      getWorktreeCompletionState: (
        repoDir: string,
        worktreePath: string,
        branchName: string,
        baseBranch: string,
      ) => WorktreeCompletionState | Promise<WorktreeCompletionState>;
      isPrAvailable: (repoDir: string) => boolean | Promise<boolean>;
      resolveRepoPolicy?: (repoDir: string) => RepoPolicyResolution | Promise<RepoPolicyResolution>;
    },
  ) {}

  async plan(session: Session): Promise<PlannedWorktreeAction> {
    const sessionRef = getPrimarySessionLookupRef(session) ?? session.harnessSessionId;
    if (this.deps.isAlreadyMerged(sessionRef)) {
      log.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" already merged — skipping strategy handling`);
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }
    const resolvedWorktreeState =
      RESOLVED_WORKTREE_STATES.has(session.worktreeState)
        ? session.worktreeState
        : (session.worktreeLifecycle?.state && RESOLVED_WORKTREE_STATES.has(session.worktreeLifecycle.state)
          ? session.worktreeLifecycle.state
          : undefined);
    if (resolvedWorktreeState && !(resolvedWorktreeState === "pr_open" && session.worktreeStrategy === "auto-pr")) {
      log.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" worktree is ${session.worktreeLifecycle?.state ?? session.worktreeState} — skipping strategy handling`);
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }
    if (session.status !== "completed") {
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }
    if (!this.deps.shouldRunWorktreeStrategy(session)) {
      log.info(`[SessionManager] handleWorktreeStrategy: skipping — session "${session.name}" is in phase "${session.phase}"`);
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    const strategy = session.worktreeStrategy;
    if (!strategy || strategy === "off" || strategy === "manual") {
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    const worktreePath = session.worktreePath!;
    const repoDir = await this.deps.resolveWorktreeRepoDir(session.originalWorkdir, worktreePath);
    const branchName = session.worktreeBranch;
    if (!repoDir) {
      return {
        kind: "notify",
        label: "worktree-missing-repo-dir",
        problem: "original repository not found",
        detail: [`Worktree: ${worktreePath}`, "Manual inspection is required."],
      };
    }
    if (!branchName) {
      return {
        kind: "notify",
        label: "worktree-no-branch-name",
        problem: "branch name unknown",
        detail: [`Worktree: ${worktreePath}`, "The worktree may have been removed or is in detached HEAD state. Manual cleanup may be needed."],
      };
    }

    const baseBranch = await resolveLandingBaseBranch(session, repoDir);
    const completionState = await this.deps.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch);

    if (completionState === "no-change") {
      return {
        kind: "no-change",
        repoDir,
        worktreePath,
        branchName,
      };
    }
    if (completionState === "merged") {
      return {
        kind: "merged",
        repoDir,
        worktreePath,
        branchName,
        baseBranch,
      };
    }
    if (completionState === "released") {
      return {
        kind: "released",
        repoDir,
        worktreePath,
        branchName,
        baseBranch,
        reasons: ["merge_noop_content_already_on_base"],
      };
    }
    if (completionState === "base-advanced") {
      return {
        kind: "notify",
        label: "worktree-no-commits-ahead",
        problem: `no commits on \`${branchName}\`, but \`${baseBranch}\` moved`,
        detail: [
          `Commits likely landed outside the worktree branch. Check that they were not made directly on \`${baseBranch}\`.`,
          `Worktree: ${worktreePath}`,
        ],
      };
    }
    if (completionState === "dirty-uncommitted") {
      return {
        kind: "dirty-uncommitted",
        worktreePath,
        branchName,
        baseBranch,
        noCommits: (await getCommitsAheadCount(repoDir, branchName, baseBranch)) === 0,
      };
    }

    const diffSummary = await getDiffSummary(repoDir, branchName, baseBranch);
    if (!diffSummary) {
      log.warn(`[SessionManager] Failed to get diff summary for ${branchName}, skipping merge-back`);
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    const livePolicy = session.repoIntegrationPolicy ? undefined : await this.deps.resolveRepoPolicy?.(repoDir);
    const effectivePolicy = session.repoIntegrationPolicy ?? livePolicy?.policy;
    const prAvailable = session.repoIntegrationPolicy
      ? await this.deps.isPrAvailable(repoDir)
      : livePolicy?.prAvailable ?? await this.deps.isPrAvailable(repoDir);
    const policyDecision = resolveWorktreePolicyDecision({
      requestedStrategy: strategy,
      policy: effectivePolicy,
      prAvailable,
      existingOpenPr: false,
    });

    if (!policyDecision.strategy) {
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    return {
      kind: "decision",
      strategy: policyDecision.strategy,
      policy: effectivePolicy,
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
