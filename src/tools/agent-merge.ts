import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getBranchName, mergeBranch, pushBranch, deleteBranch, detectDefaultBranch } from "../worktree";

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
          description: "Merge strategy: 'merge' (default, creates merge commit) or 'squash' (squashes all commits)",
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

      const baseBranch = params.base_branch ?? detectDefaultBranch(originalWorkdir);
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

      await sessionManager.enqueueMerge(originalWorkdir, async () => {
        // Re-check inside the queue slot — a concurrent auto-merge may have beaten us
        const freshPersisted = sessionManager.getPersistedSession(params.session);
        if (freshPersisted?.worktreeMerged) {
          toolResult = { content: [{ type: "text", text: `ℹ️ Session "${params.session}" was already merged while waiting in queue.` }] };
          return;
        }

        // Attempt merge
        const mergeResult = mergeBranch(originalWorkdir, branchName, baseBranch, strategy);

        if (mergeResult.success) {
          // Push base branch if requested
          if (shouldPush) {
            if (!pushBranch(originalWorkdir, baseBranch)) {
              toolResult = { content: [{ type: "text", text: `⚠️ Merged ${branchName} → ${baseBranch} locally, but failed to push ${baseBranch}` }] };
              return;
            }
          }

          // Cleanup branch if requested
          if (shouldCleanup) {
            deleteBranch(originalWorkdir, branchName);
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

          const cleanupMsg = shouldCleanup ? " Branch cleaned up." : "";
          const pushMsg = shouldPush ? " Pushed." : "";
          let successText = `✅ Merged ${branchName} → ${baseBranch}.${pushMsg}${cleanupMsg}`;
          if (mergeResult.stashPopConflict) {
            successText += `\n⚠️ Pre-merge stash pop conflicted — run \`git stash show ${mergeResult.stashRef ?? "stash@{0}"}\` in ${originalWorkdir} to review stashed changes.`;
          } else if (mergeResult.stashed) {
            successText += `\n(Pre-existing changes on ${baseBranch} were auto-stashed and restored.)`;
          }
          toolResult = { content: [{ type: "text", text: successText }] };
        } else if (mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0) {
          // Spawn conflict resolver
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
              workdir: originalWorkdir,
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
