import type { Session } from "./session";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import { getPrimarySessionLookupRef } from "./session-backend-ref";
import { existsSync } from "node:fs";
import { getCommitsAheadCount, getCommitsAheadCountSince, getDiffSummary, getUnpushedCommits, resolveLandingBaseBranch } from "./worktree";
import { formatCount } from "./format";
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
  | { kind: "skip"; result: { notificationSent: boolean; worktreeRemoved: boolean; completionNote?: string } }
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
      /**
       * The worktree had been resolved (a PR was opened, or the branch was
       * merged or released) and the session committed again afterwards. With
       * `pr_open` the counts are the commits the PR does not have.
       */
      reopenedFrom?: "pr_open" | "merged" | "released";
    };

/** Commits made after a worktree was resolved. `sinceRef`: the PR's pushed head, when known. */
type NewWorkSinceResolution = { state: "pr_open" | "merged" | "released"; count?: number; sinceRef?: string };

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

  /**
   * A resolved worktree stays resolved only while the branch has nothing new.
   * A session can commit after its PR was opened or its branch was merged (the
   * PR or merge happened while it ran, or it was resumed): those commits would
   * otherwise end with a plain `✅` and never be pushed or merged.
   * Undefined: nothing new, the worktree is still resolved.
   */
  private async newWorkSinceResolution(
    session: Session,
    state: string,
  ): Promise<NewWorkSinceResolution | undefined> {
    if (state !== "pr_open" && state !== "merged" && state !== "released") return undefined;
    const worktreePath = session.worktreePath;
    const branchName = session.worktreeBranch;
    if (!worktreePath || !branchName || !existsSync(worktreePath)) return undefined;
    const repoDir = await this.deps.resolveWorktreeRepoDir(session.originalWorkdir, worktreePath);
    if (!repoDir) return undefined;
    if (state === "pr_open") {
      // What the last push has: local evidence, nothing is fetched. Unknown
      // counts as new (fail towards asking).
      const unpushed = await getUnpushedCommits(repoDir, branchName, session.worktreePushRemote ?? "origin");
      if (unpushed?.count === 0) return undefined;
      return { state, count: unpushed?.count, sinceRef: unpushed?.remoteRef };
    }
    // Merged or released: new only when commits made after that moment are
    // ahead of the base, with content the base does not have. (Being ahead
    // of the local base alone proves nothing: a PR merged on GitHub leaves the
    // local base behind.) Without a recorded moment the worktree stays resolved.
    const resolvedAt = session.worktreeMergedAt ?? session.worktreeLifecycle?.resolvedAt;
    if (!resolvedAt) return undefined;
    const baseBranch = await resolveLandingBaseBranch(session, repoDir);
    const ahead = await getCommitsAheadCountSince(repoDir, branchName, baseBranch, resolvedAt);
    if (!ahead) return undefined;
    const completionState = await this.deps.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch);
    return completionState === "has-commits" || completionState === "dirty-uncommitted" ? { state, count: ahead } : undefined;
  }

  async plan(session: Session): Promise<PlannedWorktreeAction> {
    const sessionRef = getPrimarySessionLookupRef(session) ?? session.harnessSessionId;
    const skip: PlannedWorktreeAction = { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    const recordedState =
      RESOLVED_WORKTREE_STATES.has(session.worktreeState)
        ? session.worktreeState
        : (session.worktreeLifecycle?.state && RESOLVED_WORKTREE_STATES.has(session.worktreeLifecycle.state)
          ? session.worktreeLifecycle.state
          : undefined);
    const alreadyMerged = this.deps.isAlreadyMerged(sessionRef);
    // `auto-pr` with an open PR is not "resolved": it updates the PR below.
    const resolvedState = alreadyMerged
      ? (recordedState === "released" ? "released" : "merged")
      : (recordedState === "pr_open" && session.worktreeStrategy === "auto-pr" ? undefined : recordedState);
    const strategy = session.worktreeStrategy;
    const runsNow = session.status === "completed" && this.deps.shouldRunWorktreeStrategy(session);

    let newWork: NewWorkSinceResolution | undefined;
    if (resolvedState) {
      newWork = runsNow ? await this.newWorkSinceResolution(session, resolvedState) : undefined;
      if (!newWork) {
        log.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" worktree is ${resolvedState} — skipping strategy handling`);
        return skip;
      }
      log.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" committed after its worktree was ${resolvedState} — not resolved`);
    }
    if (session.status !== "completed") {
      return skip;
    }
    if (!this.deps.shouldRunWorktreeStrategy(session)) {
      log.info(`[SessionManager] handleWorktreeStrategy: skipping — session "${session.name}" is in phase "${session.phase}"`);
      return skip;
    }

    if (!strategy || strategy === "off" || strategy === "manual") {
      // Nobody is prompted under these strategies: the completion notice says
      // what the PR is missing.
      if (newWork?.state === "pr_open" && newWork.count) {
        return {
          kind: "skip",
          result: {
            notificationSent: false,
            worktreeRemoved: false,
            completionNote: `⚠️ ${formatCount(newWork.count, "commit")} on \`${session.worktreeBranch}\` ${newWork.count === 1 ? "is" : "are"} not in the PR${session.worktreePrUrl ? `: ${session.worktreePrUrl}` : ""}`,
          },
        };
      }
      return skip;
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

    // With an open PR the prompt counts what the PR does not have yet.
    const diffSummary = (newWork?.state === "pr_open" && newWork.sinceRef
      ? await getDiffSummary(repoDir, branchName, baseBranch, { sinceRef: newWork.sinceRef })
      : undefined) ?? await getDiffSummary(repoDir, branchName, baseBranch);
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
      // `auto-merge` with an open PR: merging past the PR is the user's call,
      // so it becomes the prompt (Merge / Sync PR / Later / Discard).
      requestedStrategy: newWork?.state === "pr_open" && strategy === "auto-merge" ? "ask" : strategy,
      policy: effectivePolicy,
      prAvailable,
      existingOpenPr: newWork?.state === "pr_open",
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
      ...(newWork ? { reopenedFrom: newWork.state } : {}),
    };
  }
}
