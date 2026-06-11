import { Type } from "../tool-schema";
import { existsSync } from "fs";
import { getDefaultHarnessName } from "../config";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import {
  mergeBranch,
  pushBranch,
  deleteBranch,
  detectDefaultBranch,
  removeWorktree,
  pruneWorktrees,
  getDiffSummary,
  formatWorktreeOutcomeLine,
  hasCommitsAhead,
  hasDirtyWorktreeEntries,
} from "../worktree";
import { getPersistedTargetMutationRefs, resolveWorktreeToolTarget } from "./worktree-tool-context";

interface AgentMergeParams {
  session: string;
  base_branch?: string;
  strategy?: "merge" | "squash";
  push?: boolean;
  delete_branch?: boolean;
}

function isAgentMergeParams(value: unknown): value is AgentMergeParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.session === "string";
}

function buildStashOutcomeDetailLines(args: {
  mergeResult: ReturnType<typeof mergeBranch>;
  repoDir: string;
  baseBranch: string;
}): string[] {
  if (args.mergeResult.stashPopConflict) {
    return [
      `Pre-merge stash pop conflicted; run git stash show ${args.mergeResult.stashRef ?? "stash@{0}"} in ${args.repoDir} to review stashed changes.`,
    ];
  }
  if (args.mergeResult.stashed) {
    return [`Pre-existing changes on ${args.baseBranch} were auto-stashed and restored.`];
  }
  return [];
}

export function formatCleanupOutcome(args: {
  deleteBranchRequested: boolean;
  branchDeleted: boolean;
  worktreeCleanedUp: boolean;
  worktreeAlreadyAbsent: boolean;
}): { detailLine: string; summaryFragment: string } {
  if (!args.deleteBranchRequested) {
    if (args.worktreeCleanedUp && !args.worktreeAlreadyAbsent) {
      return {
        detailLine: "Worktree cleaned up; branch deletion was not requested.",
        summaryFragment: " Worktree cleaned up; branch kept.",
      };
    }
    if (args.worktreeAlreadyAbsent) {
      return {
        detailLine: "Worktree was already absent; branch deletion was not requested.",
        summaryFragment: " Worktree was already absent; branch kept.",
      };
    }
    return {
      detailLine: "Worktree cleanup failed; branch deletion was not requested.",
      summaryFragment: " Worktree cleanup failed; branch kept.",
    };
  }

  if (args.branchDeleted && args.worktreeCleanedUp && !args.worktreeAlreadyAbsent) {
    return {
      detailLine: "Branch and worktree cleaned up.",
      summaryFragment: " Branch and worktree cleaned up.",
    };
  }

  if (args.branchDeleted && args.worktreeAlreadyAbsent) {
    return {
      detailLine: "Branch deleted; worktree was already absent.",
      summaryFragment: " Branch deleted; worktree was already absent.",
    };
  }

  if (args.branchDeleted) {
    return {
      detailLine: "Branch deleted; worktree cleanup failed.",
      summaryFragment: " Branch deleted; worktree cleanup failed.",
    };
  }

  if (args.worktreeAlreadyAbsent) {
    return {
      detailLine: "Worktree was already absent; branch deletion failed.",
      summaryFragment: " Worktree was already absent; branch deletion failed.",
    };
  }

  if (args.worktreeCleanedUp) {
    return {
      detailLine: "Worktree cleaned up; branch deletion failed.",
      summaryFragment: " Worktree cleaned up; branch deletion failed.",
    };
  }

  return {
    detailLine: "Branch deletion and worktree cleanup failed.",
    summaryFragment: " Branch deletion and worktree cleanup failed.",
  };
}

/** Register the `agent_merge` tool factory. */
export function makeAgentMergeTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_merge",
    description: "Merge a worktree branch back to the base branch. Resolves session (active or persisted), gets worktree path, and performs the merge. On conflict, spawns a conflict-resolver session using the configured default harness.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to merge" }),
      base_branch: Type.Optional(Type.String({ description: "Base branch to merge into (default: main)" })),
      strategy: Type.Optional(
        Type.Union([Type.Literal("merge"), Type.Literal("squash")], {
          description: "Merge strategy: 'merge' (default, fast-forward if possible; merge commit if branches have diverged) or 'squash' (squashes all commits into one)",
        }),
      ),
      push: Type.Optional(Type.Boolean({ description: "Push the base branch after successful merge (default: false)" })),
      delete_branch: Type.Optional(Type.Boolean({ description: "Delete the worktree branch after successful merge (default: true)" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentMergeParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, base_branch?, strategy?, push?, delete_branch? }." }] };
      }

      // Resolve session (active or persisted)
      const target = resolveWorktreeToolTarget(sessionManager, params.session);
      const targetSession = target.activeSession;
      const persistedSession = target.persistedSession;

      if (!targetSession && !persistedSession) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" not found.` }] };
      }

      const { worktreePath, originalWorkdir, branchName } = target;

      if (!worktreePath || !originalWorkdir) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" does not have a worktree.` }] };
      }

      if (!branchName) {
        return { content: [{ type: "text", text: `Error: Cannot determine branch name for worktree at ${worktreePath}. The worktree may have been removed and no persisted branch name is available.` }] };
      }

      // A removed worktree path is fine here; mergeBranch operates on
      // originalWorkdir and the persisted branch name.
      if (!existsSync(worktreePath)) {
        console.info(`[agent_merge] Worktree directory ${worktreePath} no longer exists; proceeding with merge via originalWorkdir (${originalWorkdir})`);
      }

      let effectiveWorkdir = originalWorkdir;
      if (!existsSync(originalWorkdir)) {
        return { content: [{ type: "text", text: `Error: originalWorkdir "${originalWorkdir}" does not exist.` }] };
      }

      const resolvedBaseBranch = params.base_branch ?? detectDefaultBranch(effectiveWorkdir);
      const baseBranch = resolvedBaseBranch;
      const strategy = params.strategy ?? "merge";
      const shouldPush = params.push === true; // Default false
      const shouldCleanup = params.delete_branch !== false; // Default true
      const repoPolicy = sessionManager.resolveRepoPolicy(effectiveWorkdir);
      if (repoPolicy?.policy === "pr-required") {
        return {
          content: [{
            type: "text",
            text: `❌ Merge blocked: repo policy requires a pull request for ${repoPolicy.identity?.repoRoot ?? effectiveWorkdir}. Use agent_pr if PR automation is available.`,
          }],
        };
      }

      // Idempotency guard: if already merged, return early before touching the queue
      if (persistedSession?.worktreeLifecycle?.state === "merged" || persistedSession?.worktreeMerged) {
        return { content: [{ type: "text", text: `ℹ️ Session "${params.session}" is already merged.` }] };
      }

      if (
        existsSync(worktreePath)
        && !hasCommitsAhead(effectiveWorkdir, branchName, baseBranch)
        && hasDirtyWorktreeEntries(worktreePath)
      ) {
        return {
          content: [{
            type: "text",
            text: [
              `❌ Merge blocked: session "${params.session}" has uncommitted worktree changes but branch ${branchName} has no commits ahead of ${baseBranch}.`,
              `Worktree: ${worktreePath}`,
              `Resume or inspect the session, then commit real task changes or clean temporary files before retrying agent_merge.`,
            ].join("\n"),
          }],
        };
      }

      // Serialise against concurrent merges on the same repo directory
      let toolResult: { content: Array<{ type: string; text: string }> } = {
        content: [{ type: "text", text: "❌ Merge did not run (internal error)" }],
      };

      const persistedRef = target.persistedRef;

      await sessionManager.enqueueMerge(effectiveWorkdir, async () => {
        // Re-check inside the queue slot — a concurrent auto-merge may have beaten us
        const freshPersisted = sessionManager.getPersistedSession(params.session);
        if (freshPersisted?.worktreeLifecycle?.state === "merged" || freshPersisted?.worktreeMerged) {
          toolResult = { content: [{ type: "text", text: `ℹ️ Session "${params.session}" was already merged while waiting in queue.` }] };
          return;
        }

        // Get diff summary before merging for outcome notification
        const diffSummary = getDiffSummary(effectiveWorkdir, branchName, resolvedBaseBranch);

        // Attempt merge — pass worktreePath so rebase runs there when the worktree still exists
        const mergeResult = mergeBranch(effectiveWorkdir, branchName, baseBranch, strategy, worktreePath);

        if (mergeResult.success) {
          const stashDetailLines = buildStashOutcomeDetailLines({
            mergeResult,
            repoDir: effectiveWorkdir,
            baseBranch,
          });

          // Push base branch if requested
          if (shouldPush) {
            if (!pushBranch(effectiveWorkdir, baseBranch)) {
              const pushFailedText = `⚠️ Merged ${branchName} → ${baseBranch} locally, but failed to push ${baseBranch}`;
              sessionManager.notifyWorktreeOutcome(
                target.notificationTarget!,
                pushFailedText,
                {
                  detailLines: [
                    `Branch ${branchName} was merged into ${baseBranch} in the local repository.`,
                    `Pushing ${baseBranch} failed; remote state may not include the merge.`,
                    `Cleanup was skipped so the branch/worktree remains available for follow-up.`,
                    ...stashDetailLines,
                  ],
                },
              );
              toolResult = { content: [{ type: "text", text: pushFailedText }] };
              return;
            }
          }

          let branchDeleted = false;
          let worktreeCleanedUp = false;
          const worktreeAlreadyAbsent = !existsSync(worktreePath);
          worktreeCleanedUp = worktreeAlreadyAbsent
            ? true
            : removeWorktree(effectiveWorkdir, worktreePath);
          pruneWorktrees(effectiveWorkdir);
          if (shouldCleanup) {
            branchDeleted = deleteBranch(effectiveWorkdir, branchName);
          }
          const cleanupOutcome = formatCleanupOutcome({
            deleteBranchRequested: shouldCleanup,
            branchDeleted,
            worktreeCleanedUp,
            worktreeAlreadyAbsent,
          });

          // Persist merge status if we have a persisted session
          if (freshPersisted) {
            for (const mutationRef of getPersistedTargetMutationRefs({ ...target, persistedSession: freshPersisted })) {
              sessionManager.updatePersistedSession(mutationRef, {
                worktreeMerged: true,
                worktreeMergedAt: new Date().toISOString(),
                pendingWorktreeDecisionSince: undefined,
                lastWorktreeReminderAt: undefined,
                lifecycle: "terminal",
                worktreeState: "merged",
                worktreeDisposition: "merged",
                worktreeLifecycle: {
                  state: "merged",
                  updatedAt: new Date().toISOString(),
                  resolvedAt: new Date().toISOString(),
                  resolutionSource: "agent_merge",
                  baseBranch: resolvedBaseBranch,
                  targetRepo: freshPersisted.worktreePrTargetRepo,
                  pushRemote: freshPersisted.worktreePushRemote,
                },
              });
            }
          }

          // Send unified confirmation notification
          const outcomeLine = formatWorktreeOutcomeLine({
            kind: "merge",
            branch: branchName,
            base: resolvedBaseBranch,
            filesChanged: diffSummary?.filesChanged,
            insertions: diffSummary?.insertions,
            deletions: diffSummary?.deletions,
          });
          sessionManager.notifyWorktreeOutcome(
            target.notificationTarget!,
            outcomeLine,
            {
              detailLines: [
                mergeResult.fastForward ? "Merge type: fast-forward." : "Merge type: merge commit.",
                shouldPush ? `Pushed ${baseBranch}.` : `Did not push ${baseBranch}; push was not requested.`,
                cleanupOutcome.detailLine,
                ...stashDetailLines,
              ],
            },
          );

          const mergeTypeMsg = mergeResult.fastForward ? "⚡ Fast-forward" : "🔀 Merge commit";
          const pushMsg = shouldPush ? " Pushed." : "";
          let successText = `✅ ${mergeTypeMsg}: ${branchName} → ${baseBranch}.${pushMsg}${cleanupOutcome.summaryFragment}`;
          if (mergeResult.stashPopConflict) {
            successText += `\n⚠️ Pre-merge stash pop conflicted — run \`git stash show ${mergeResult.stashRef ?? "stash@{0}"}\` in ${effectiveWorkdir} to review stashed changes.`;
          } else if (mergeResult.stashed) {
            successText += `\n(Pre-existing changes on ${baseBranch} were auto-stashed and restored.)`;
          }
          toolResult = { content: [{ type: "text", text: successText }] };
        } else if (mergeResult.rebaseConflict) {
          // Rebase conflicts require manual resolution — surface instructions to the user
          toolResult = { content: [{ type: "text", text: `⚠️ Rebase conflicts — manual resolution required:\n\n${mergeResult.error}` }] };
        } else if (mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0) {
          // Squash-merge conflict path (should be rare after rebase) — spawn conflict resolver
          const conflictPrompt = [
            `Resolve merge conflicts in the following files and commit the resolution:`,
            ``,
            ...mergeResult.conflictFiles.map((f) => `- ${f}`),
            ``,
            `After resolving, commit with message: "Resolve merge conflicts from ${branchName}"`,
          ].join("\n");

          try {
            const conflictSession = sessionManager.spawn({
              prompt: conflictPrompt,
              workdir: effectiveWorkdir,
              name: `${params.session}-conflict-resolver`,
              harness: getDefaultHarnessName(),
              permissionMode: "bypassPermissions",
              multiTurn: true,
              route: targetSession?.route ?? persistedSession?.route,
              originChannel: targetSession?.originChannel ?? persistedSession?.originChannel,
              originThreadId: targetSession?.originThreadId ?? persistedSession?.originThreadId,
              originAgentId: targetSession?.originAgentId ?? persistedSession?.originAgentId,
              originSessionKey: targetSession?.originSessionKey ?? persistedSession?.originSessionKey,
            });

            toolResult = { content: [{ type: "text", text: `⚠️ Merge conflicts in ${mergeResult.conflictFiles.length} file(s) — spawned conflict resolver session: ${conflictSession.name}` }] };
          } catch (err) {
            toolResult = { content: [{ type: "text", text: `❌ Merge conflicts detected, but failed to spawn resolver: ${err instanceof Error ? err.message : String(err)}` }] };
          }
        } else {
          const errorText = mergeResult.dirtyError
            ? `❌ Merge blocked: ${mergeResult.error}`
            : `❌ Merge failed: ${mergeResult.error ?? "unknown error"}`;
          toolResult = { content: [{ type: "text", text: errorText }] };
        }
      });

      return toolResult;
    },
  };
}
