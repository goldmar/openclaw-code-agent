import { Type } from "@sinclair/typebox";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import type { OpenClawPluginToolContext } from "../types";
import { deleteBranch, detectDefaultBranch, getBranchName, isGitHubCLIAvailable } from "../worktree";
import { sessionManager } from "../singletons";

interface AgentWorktreeCleanupParams {
  workdir?: string;
  base_branch?: string;
  skip_session_check?: boolean; // Fix 3-B: renamed from force
  force?: boolean;              // Fix 3-B: deprecated alias for skip_session_check
  dry_run?: boolean;
  session?: string;
  dismiss_session?: boolean;
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

/**
 * Get the number of commits a branch is ahead of a base branch.
 */
function getCommitsAheadCount(workdir: string, branch: string, baseBranch: string): number {
  try {
    const result = execFileSync("git", ["-C", workdir, "rev-list", "--count", `${baseBranch}..${branch}`], {
      timeout: 5_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Fix 3-C: Check if a branch has an open PR.
 * Fast path: check persisted sessions for a matching worktreeBranch with a PR URL.
 * Slow path: query gh CLI for open PRs on this branch.
 * Returns { number, url } if an open PR is found, null otherwise.
 */
function checkOpenPR(workdir: string, branch: string): { number: number; url?: string } | null {
  // Fast path: check persisted sessions
  if (sessionManager) {
    for (const session of sessionManager.listPersistedSessions()) {
      if (
        session.worktreeBranch === branch &&
        session.worktreePrUrl &&
        session.worktreeMerged !== true
      ) {
        return { number: session.worktreePrNumber ?? 0, url: session.worktreePrUrl };
      }
    }
  }

  // Slow path: gh CLI
  if (isGitHubCLIAvailable()) {
    try {
      const result = execFileSync(
        "gh",
        ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"],
        {
          timeout: 15_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          cwd: workdir,
        },
      );
      const parsed = JSON.parse(result.trim()) as Array<{ number: number; url?: string }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { number: parsed[0].number, url: parsed[0].url };
      }
    } catch {
      // gh not available or failed — skip
    }
  }

  return null;
}

/**
 * Fix 3-D: Register the `agent_worktree_cleanup` tool factory.
 *
 * Three categories are ALWAYS protected from deletion:
 *   1. Branches with active running/starting sessions
 *   2. Branches with unmerged commits ahead of the base branch
 *   3. Branches with open GitHub PRs
 *
 * Only fully merged branches with no active session and no open PR are deleted.
 * Use skip_session_check (alias: force) to bypass the active-session check only —
 * useful when a session crashed and left a stale branch.
 */
export function makeAgentWorktreeCleanupTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_worktree_cleanup",
    description:
      "Clean up agent/* branches. Three categories are always protected from deletion: " +
      "(1) branches with active running/starting sessions, " +
      "(2) branches with unmerged commits ahead of the base branch, " +
      "(3) branches with open GitHub PRs. " +
      "Only fully merged branches with no active session or open PR are eligible for deletion. " +
      "Use skip_session_check (alias: force) to bypass the active-session check only — " +
      "useful when a session crashed and left a stale branch. " +
      "Use session to dismiss a pending worktree decision without merging.",
    parameters: Type.Object({
      workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
      base_branch: Type.Optional(Type.String({ description: "Base branch to check merge status against (default: main)" })),
      skip_session_check: Type.Optional(
        Type.Boolean({
          description:
            "Skip the check for running sessions (use only when a session crashed and left a stale branch). " +
            "Does NOT override unmerged commit or open PR protection. (default: false)",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Deprecated alias for skip_session_check. See skip_session_check for details.",
        }),
      ),
      dry_run: Type.Optional(Type.Boolean({ description: "Show what would be deleted without actually deleting (default: false)" })),
      session: Type.Optional(Type.String({ description: "Session name or ID to dismiss/clear pending worktree decision for (optional)" })),
      dismiss_session: Type.Optional(Type.Boolean({ description: "When true and session is provided, permanently dismiss the worktree — deletes the branch and worktree directory. Irreversible. (default: false)" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!isAgentWorktreeCleanupParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { workdir?, base_branch?, skip_session_check?, force?, dry_run?, session? }." }] };
      }

      const sessionRef = (params as AgentWorktreeCleanupParams).session;
      const dismissSession = (params as AgentWorktreeCleanupParams).dismiss_session === true;

      // If session is provided and dismiss_session=true, permanently delete branch/worktree
      if (sessionRef && dismissSession && sessionManager) {
        const dismissResult = await sessionManager.dismissWorktree(sessionRef);
        return { content: [{ type: "text", text: dismissResult }] };
      }

      // If session is provided, clear the pending worktree decision for it
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
      // Fix 3-B: skip_session_check (with force as deprecated alias) bypasses only the active-session check
      const skipSessionCheck =
        (params as AgentWorktreeCleanupParams).skip_session_check === true ||
        (params as AgentWorktreeCleanupParams).force === true;
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

      // Fix 3-A: Build set of branches belonging to running/starting sessions.
      // These are NEVER deleted unless skip_session_check is set.
      const activeBranchSet = new Set<string>();
      const activeBranchInfo = new Map<string, string>(); // branch → "session-name is status"
      if (sessionManager) {
        for (const session of sessionManager.list()) {
          if (session.status === "starting" || session.status === "running") {
            const branch = session.worktreeBranch;
            if (branch) {
              activeBranchSet.add(branch);
              activeBranchInfo.set(branch, `${session.name} is ${session.status}`);
            }
          }
        }
      }

      // Categorize branches into four buckets
      const toDelete: string[] = [];
      const unmergedBranches: Array<{ branch: string; commitsAhead: number }> = [];
      const runningProtectedBranches: string[] = []; // Fix 3-A
      const prProtectedBranches: Array<{ branch: string; prNumber: number; prUrl?: string }> = []; // Fix 3-C

      for (const branch of agentBranches) {
        // Fix 3-A: Active session check — bypassed only when skip_session_check is set
        if (!skipSessionCheck && activeBranchSet.has(branch)) {
          const info = activeBranchInfo.get(branch) ?? "unknown";
          runningProtectedBranches.push(`${branch} (session: ${info})`);
          continue;
        }

        // Fix 3-B: Merge status is ALWAYS checked — force/skip_session_check does NOT bypass this
        if (isBranchMerged(workdir, branch, baseBranch)) {
          toDelete.push(branch);
        } else {
          // Fix 3-C: Check for open PR before classifying as simply unmerged
          const prInfo = checkOpenPR(workdir, branch);
          if (prInfo) {
            prProtectedBranches.push({ branch, prNumber: prInfo.number, prUrl: prInfo.url });
          } else {
            const commitsAhead = getCommitsAheadCount(workdir, branch, baseBranch);
            unmergedBranches.push({ branch, commitsAhead });
          }
        }
      }

      // Fix 3-E: Build structured output showing all four categories
      const buildOutput = (actuallyDeleted: string[], failures: string[]): string => {
        const lines: string[] = ["agent/* branch status:"];

        // DELETED / WOULD DELETE
        const deletedLabel = dryRun ? "WOULD DELETE" : "DELETED";
        const deletedList = (dryRun ? toDelete : actuallyDeleted).join(", ") || "(none)";
        const failNote = failures.length > 0 ? `; ${failures.length} failed: ${failures.join(", ")}` : "";
        lines.push(`  ${deletedLabel} (${dryRun ? toDelete.length : actuallyDeleted.length}): ${deletedList}${failNote}`);

        // KEPT – unmerged
        const unmergedList =
          unmergedBranches.length > 0
            ? unmergedBranches
                .map(({ branch, commitsAhead }) =>
                  commitsAhead > 0
                    ? `${branch} [${commitsAhead} commit${commitsAhead !== 1 ? "s" : ""} ahead]`
                    : branch,
                )
                .join(", ")
            : "(none)";
        lines.push(`  KEPT – unmerged (${unmergedBranches.length}): ${unmergedList}`);

        // KEPT – active session
        const runningList = runningProtectedBranches.length > 0
          ? runningProtectedBranches.join(", ")
          : "(none)";
        lines.push(`  KEPT – active session (${runningProtectedBranches.length}): ${runningList}`);

        // KEPT – open PR
        const prList =
          prProtectedBranches.length > 0
            ? prProtectedBranches
                .map(({ branch, prNumber, prUrl }) =>
                  prNumber > 0 ? `${branch} [PR #${prNumber}]` : `${branch} [open PR]`,
                )
                .join(", ")
            : "(none)";
        lines.push(`  KEPT – open PR (${prProtectedBranches.length}): ${prList}`);

        return lines.join("\n");
      };

      // Dry run: just report what would happen
      if (dryRun) {
        return { content: [{ type: "text", text: buildOutput([], []) }] };
      }

      // Actually delete merged branches
      const actuallyDeleted: string[] = [];
      const failures: string[] = [];

      for (const branch of toDelete) {
        if (deleteBranch(workdir, branch)) {
          actuallyDeleted.push(branch);
        } else {
          failures.push(branch);
        }
      }

      return { content: [{ type: "text", text: buildOutput(actuallyDeleted, failures) }] };
    },
  };
}
