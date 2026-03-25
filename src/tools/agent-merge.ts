import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getBranchName, mergeBranch, pushBranch, deleteBranch, detectDefaultBranch, removeWorktree, pruneWorktrees } from "../worktree";

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

/** Register the `agent_merge` tool factory. */
export function makeAgentMergeTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_merge",
    description: "Merge a worktree branch back to the base branch. Resolves session (active or persisted), gets worktree path, and performs the merge. On conflict, spawns a Claude Code conflict-resolver session.",
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
      let targetSession = sessionManager.resolve(params.session);
      let persistedSession = sessionManager.getPersistedSession(params.session);

      if (!targetSession && !persistedSession) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" not found.` }] };
      }

      // Extract worktree info
      const worktreePath = targetSession?.worktreePath ?? persistedSession?.worktreePath;
      const originalWorkdir = targetSession?.originalWorkdir ?? persistedSession?.workdir;

      if (!worktreePath || !originalWorkdir) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" does not have a worktree.` }] };
      }

      // Fix 2-A: Fall back to persisted branch name if live lookup fails (worktree may be removed)
      const liveBranch = getBranchName(worktreePath);
      const branchName = liveBranch ?? persistedSession?.worktreeBranch;
      if (!branchName) {
        return { content: [{ type: "text", text: `Error: Cannot determine branch name for worktree at ${worktreePath}. The worktree may have been removed and no persisted branch name is available.` }] };
      }

      // Fix 2-D: If worktreePath no longer exists (removed after session ended), that is fine —
      // mergeBranch operates on originalWorkdir and does not require the worktree directory.
      if (!existsSync(worktreePath)) {
        console.info(`[agent_merge] Worktree directory ${worktreePath} no longer exists; proceeding with merge via originalWorkdir (${originalWorkdir})`);
      }

      // Fix 2-E: Guard against stale persisted sessions where workdir was incorrectly
      // stored as the worktree path rather than the original repo directory.
      // Symptom: `git -C <worktreePath> checkout main` → "No such file or directory".
      // Heuristic: if originalWorkdir doesn't exist on disk, derive the repo root from
      // the worktree path (worktrees live at <repoRoot>/.worktrees/<sessionName>).
      let effectiveWorkdir = originalWorkdir;
      if (!existsSync(originalWorkdir)) {
        const derivedRepoDir = resolve(dirname(worktreePath), "..");
        if (existsSync(derivedRepoDir)) {
          console.warn(
            `[agent_merge] originalWorkdir "${originalWorkdir}" does not exist — ` +
            `falling back to derived repo root "${derivedRepoDir}" (worktree path: ${worktreePath}).`
          );
          effectiveWorkdir = derivedRepoDir;
        } else {
          return { content: [{ type: "text", text: `Error: originalWorkdir "${originalWorkdir}" does not exist and could not derive repo root from worktree path "${worktreePath}".` }] };
        }
      }

      const baseBranch = params.base_branch ?? detectDefaultBranch(effectiveWorkdir);
      const strategy = params.strategy ?? "merge";
      const shouldPush = params.push === true; // Default false
      const shouldCleanup = params.delete_branch !== false; // Default true

      // Idempotency guard: if already merged, return early before touching the queue
      if (persistedSession?.worktreeMerged) {
        return { content: [{ type: "text", text: `ℹ️ Session "${params.session}" is already merged.` }] };
      }

      // Serialise against concurrent merges on the same repo directory
      let toolResult: { content: Array<{ type: string; text: string }> } = {
        content: [{ type: "text", text: "❌ Merge did not run (internal error)" }],
      };

      await sessionManager.enqueueMerge(effectiveWorkdir, async () => {
        // Re-check inside the queue slot — a concurrent auto-merge may have beaten us
        const freshPersisted = sessionManager.getPersistedSession(params.session);
        if (freshPersisted?.worktreeMerged) {
          toolResult = { content: [{ type: "text", text: `ℹ️ Session "${params.session}" was already merged while waiting in queue.` }] };
          return;
        }

        // Attempt merge — pass worktreePath so rebase runs there when the worktree still exists
        const mergeResult = mergeBranch(effectiveWorkdir, branchName, baseBranch, strategy, worktreePath);

        if (mergeResult.success) {
          // Push base branch if requested
          if (shouldPush) {
            if (!pushBranch(effectiveWorkdir, baseBranch)) {
              toolResult = { content: [{ type: "text", text: `⚠️ Merged ${branchName} → ${baseBranch} locally, but failed to push ${baseBranch}` }] };
              return;
            }
          }

          // Cleanup branch if requested
          if (shouldCleanup) {
            deleteBranch(effectiveWorkdir, branchName);
          }

          // Remove worktree directory — it lingered while pendingWorktreeDecisionSince was set
          // (onSessionTerminal skipped cleanup while awaiting the user's button click).
          if (existsSync(worktreePath)) {
            removeWorktree(effectiveWorkdir, worktreePath);
            pruneWorktrees(effectiveWorkdir);
          }

          // Persist merge status if we have a persisted session
          if (freshPersisted) {
            sessionManager.updatePersistedSession(freshPersisted.harnessSessionId, {
              worktreeMerged: true,
              worktreeMergedAt: new Date().toISOString(),
              pendingWorktreeDecisionSince: undefined,
              lastWorktreeReminderAt: undefined,
            });
          }

          const mergeTypeMsg = mergeResult.fastForward ? "⚡ Fast-forward" : "🔀 Merge commit";
          const cleanupMsg = shouldCleanup ? " Branch and worktree cleaned up." : "";
          const pushMsg = shouldPush ? " Pushed." : "";
          let successText = `✅ ${mergeTypeMsg}: ${branchName} → ${baseBranch}.${pushMsg}${cleanupMsg}`;
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
              harness: "claude-code",
              permissionMode: "bypassPermissions",
              multiTurn: true,
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
