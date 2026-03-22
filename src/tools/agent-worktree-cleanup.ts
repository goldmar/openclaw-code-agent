import { Type } from "@sinclair/typebox";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import type { OpenClawPluginToolContext } from "../types";
import { deleteBranch, detectDefaultBranch } from "../worktree";
import { sessionManager } from "../singletons";

interface AgentWorktreeCleanupParams {
  workdir?: string;
  base_branch?: string;
  force?: boolean;
  dry_run?: boolean;
  session?: string;
}

function isAgentWorktreeCleanupParams(value: unknown): value is AgentWorktreeCleanupParams {
  if (!value || typeof value !== "object") return false;
  return true; // All params are optional
}

/**
 * List all agent/* branches in a repository.
 */
function listAgentBranches(workdir: string): string[] {
  try {
    const result = execFileSync("git", ["-C", workdir, "branch", "--list", "agent/*"], {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    return result
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\*?\s+/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a branch is merged into a base branch using merge-base.
 */
function isBranchMerged(workdir: string, branch: string, baseBranch: string): boolean {
  try {
    // Get merge-base of branch and baseBranch
    const mergeBase = execFileSync("git", ["-C", workdir, "merge-base", branch, baseBranch], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Get commit hash of branch
    const branchCommit = execFileSync("git", ["-C", workdir, "rev-parse", branch], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // If merge-base equals branch commit, the branch is fully merged
    return mergeBase === branchCommit;
  } catch {
    return false;
  }
}

/** Register the `agent_worktree_cleanup` tool factory. */
export function makeAgentWorktreeCleanupTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_worktree_cleanup",
    description: "Clean up agent/* branches. Lists all agent/* branches, checks merge status via git merge-base, and optionally deletes merged branches. Use force to delete all agent/* branches regardless of merge status. Use session to dismiss a pending worktree decision without merging.",
    parameters: Type.Object({
      workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
      base_branch: Type.Optional(Type.String({ description: "Base branch to check merge status against (default: main)" })),
      force: Type.Optional(Type.Boolean({ description: "Delete all agent/* branches regardless of merge status (default: false)" })),
      dry_run: Type.Optional(Type.Boolean({ description: "Show what would be deleted without actually deleting (default: false)" })),
      session: Type.Optional(Type.String({ description: "Session name or ID to dismiss/clear pending worktree decision for (optional)" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!isAgentWorktreeCleanupParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { workdir?, base_branch?, force?, dry_run?, session? }." }] };
      }

      const sessionRef = (params as AgentWorktreeCleanupParams).session;

      // If session is provided, dismiss the pending worktree decision for it
      if (sessionRef && sessionManager) {
        const persistedSession = sessionManager.getPersistedSession(sessionRef);
        if (persistedSession) {
          sessionManager.updatePersistedSession(persistedSession.harnessSessionId, {
            pendingWorktreeDecisionSince: undefined,
            lastWorktreeReminderAt: undefined,
          });
        }
      }

      const workdir = (params as AgentWorktreeCleanupParams).workdir || process.cwd();
      const baseBranch = (params as AgentWorktreeCleanupParams).base_branch ?? detectDefaultBranch(workdir);
      const force = (params as AgentWorktreeCleanupParams).force === true;
      const dryRun = (params as AgentWorktreeCleanupParams).dry_run === true;

      if (!existsSync(workdir)) {
        return { content: [{ type: "text", text: `Error: Working directory does not exist: ${workdir}` }] };
      }

      // Check if it's a git repo
      try {
        execFileSync("git", ["-C", workdir, "rev-parse", "--git-dir"], {
          timeout: 5_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        return { content: [{ type: "text", text: `Error: ${workdir} is not a git repository` }] };
      }

      // List all agent/* branches
      const agentBranches = listAgentBranches(workdir);
      if (agentBranches.length === 0) {
        return { content: [{ type: "text", text: "No agent/* branches found." }] };
      }

      // Categorize branches
      const merged: string[] = [];
      const unmerged: string[] = [];

      for (const branch of agentBranches) {
        if (force || isBranchMerged(workdir, branch, baseBranch)) {
          merged.push(branch);
        } else {
          unmerged.push(branch);
        }
      }

      if (merged.length === 0) {
        return { content: [{ type: "text", text: `No ${force ? "agent/*" : "merged"} branches to delete.` }] };
      }

      // Dry run: just report what would be deleted
      if (dryRun) {
        const lines = [
          `Dry run: would delete ${merged.length} branch(es):`,
          ...merged.map((b) => `  - ${b}`),
        ];
        if (unmerged.length > 0) {
          lines.push(``, `Would keep ${unmerged.length} unmerged branch(es):`);
          lines.push(...unmerged.map((b) => `  - ${b}`));
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // Actually delete
      let deleted = 0;
      const failures: string[] = [];

      for (const branch of merged) {
        if (deleteBranch(workdir, branch)) {
          deleted++;
        } else {
          failures.push(branch);
        }
      }

      const lines = [`Deleted ${deleted} branch(es).`];
      if (failures.length > 0) {
        lines.push(`Failed to delete ${failures.length} branch(es): ${failures.join(", ")}`);
      }
      if (unmerged.length > 0) {
        lines.push(`Kept ${unmerged.length} unmerged branch(es).`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}
