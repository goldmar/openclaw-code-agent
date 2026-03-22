import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getBranchName, hasCommitsAhead, getDiffSummary, detectDefaultBranch } from "../worktree";

interface AgentWorktreeStatusParams {
  session?: string;
}

function isAgentWorktreeStatusParams(value: unknown): value is AgentWorktreeStatusParams {
  if (!value || typeof value !== "object") return true; // All params optional
  return true;
}

/** Register the `agent_worktree_status` tool factory. */
export function makeAgentWorktreeStatusTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_worktree_status",
    description: "Show worktree status for coding agent sessions. If session parameter is provided, shows status for that session only. Otherwise, shows all sessions with worktrees. Displays branch name, repository, strategy, commits ahead, merge status, and PR URLs.",
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "Session name or ID to show status for (optional, shows all if omitted)" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentWorktreeStatusParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session? }." }] };
      }

      const targetSession = (params as AgentWorktreeStatusParams).session;
      const lines: string[] = [];

      // Get all sessions with worktrees (active + persisted)
      const activeSessions = sessionManager.list("all").filter((s) => s.worktreePath);
      const persistedSessions = sessionManager.listPersistedSessions().filter((p) => p.worktreePath);

      // Build a unified list (prefer active over persisted for same session ID)
      const sessionMap = new Map<string, {
        id: string;
        name: string;
        worktreePath: string;
        worktreeBranch?: string;
        worktreeStrategy?: string;
        workdir: string;
        worktreeMerged?: boolean;
        worktreeMergedAt?: string;
        worktreePrUrl?: string;
      }>();

      for (const p of persistedSessions) {
        if (!p.worktreePath) continue;
        const key = p.sessionId ?? p.harnessSessionId;
        sessionMap.set(key, {
          id: key,
          name: p.name,
          worktreePath: p.worktreePath,
          worktreeBranch: p.worktreeBranch,
          worktreeStrategy: p.worktreeStrategy,
          workdir: p.workdir,
          worktreeMerged: p.worktreeMerged,
          worktreeMergedAt: p.worktreeMergedAt,
          worktreePrUrl: p.worktreePrUrl,
        });
      }

      for (const s of activeSessions) {
        if (!s.worktreePath) continue;
        sessionMap.set(s.id, {
          id: s.id,
          name: s.name,
          worktreePath: s.worktreePath,
          worktreeBranch: getBranchName(s.worktreePath),
          worktreeStrategy: s.worktreeStrategy,
          workdir: s.originalWorkdir ?? s.workdir,
          worktreeMerged: undefined,
          worktreeMergedAt: undefined,
          worktreePrUrl: undefined,
        });
      }

      // Filter by target session if specified
      let sessionsToShow = Array.from(sessionMap.values());
      if (targetSession) {
        sessionsToShow = sessionsToShow.filter(
          (s) => s.id === targetSession || s.name === targetSession
        );
        if (sessionsToShow.length === 0) {
          return { content: [{ type: "text", text: `Error: Session "${targetSession}" not found or has no worktree.` }] };
        }
      }

      if (sessionsToShow.length === 0) {
        return { content: [{ type: "text", text: "No sessions with worktrees found." }] };
      }

      // --- Pending decisions section ---
      const allPersisted = sessionManager.listPersistedSessions();
      const pendingDecisions = allPersisted.filter(
        (p) => p.pendingWorktreeDecisionSince && !p.worktreeMerged && !p.worktreePrUrl,
      );
      const filteredPending = targetSession
        ? pendingDecisions.filter(
            (p) => p.harnessSessionId === targetSession || p.name === targetSession || p.sessionId === targetSession,
          )
        : pendingDecisions;

      if (filteredPending.length > 0) {
        lines.push(`⏳ Pending decisions (${filteredPending.length}):`);
        lines.push("");
        for (const p of filteredPending) {
          const since = new Date(p.pendingWorktreeDecisionSince!);
          const pendingMs = Date.now() - since.getTime();
          const pendingTotalHours = Math.floor(pendingMs / (60 * 60 * 1000));
          const pendingDays = Math.floor(pendingTotalHours / 24);
          const pendingRemainHours = pendingTotalHours % 24;
          const pendingMins = Math.floor((pendingMs % (60 * 60 * 1000)) / 60_000);
          const pendingStr = pendingDays > 0
            ? `${pendingDays}d ${pendingRemainHours}h`
            : pendingTotalHours > 0
              ? `${pendingTotalHours}h ${pendingMins}m`
              : `${pendingMins}m`;
          const baseBranch = detectDefaultBranch(p.workdir);
          lines.push(`• ${p.name.padEnd(14)} ${(p.worktreeBranch ?? "?").padEnd(30)} → ${baseBranch.padEnd(10)}  pending ${pendingStr}`);
        }
        lines.push("");
        if (filteredPending.length === 1) {
          const p = filteredPending[0]!;
          lines.push(`Use agent_merge(session="${p.name}") or agent_pr(session="${p.name}") to resolve.`);
        } else {
          lines.push(`Use agent_merge(session="<name>") or agent_pr(session="<name>") to resolve.`);
        }
        lines.push("");
        lines.push("────────────────────────────────────────────────────");
        lines.push("All worktrees:");
        lines.push("");
      }

      // Show status for each session
      for (const session of sessionsToShow) {
        const branchName = session.worktreeBranch ?? getBranchName(session.worktreePath);
        if (!branchName) {
          lines.push(`Session: ${session.name} [${session.id}]`);
          lines.push(`  Worktree: ${session.worktreePath}`);
          lines.push(`  Status:   Cannot determine branch (detached HEAD or worktree removed)`);
          lines.push("");
          continue;
        }

        const baseBranch = detectDefaultBranch(session.workdir);
        const repoExists = existsSync(session.workdir);

        lines.push(`Session: ${session.name} [${session.id}]`);
        lines.push(`  Branch:   ${branchName} → ${baseBranch}`);
        lines.push(`  Repo:     ${session.workdir}`);
        if (session.worktreeStrategy) {
          lines.push(`  Strategy: ${session.worktreeStrategy}`);
        }

        // Try to get commits ahead (only if repo still exists)
        if (repoExists) {
          try {
            const isAhead = hasCommitsAhead(session.workdir, branchName, baseBranch);
            if (isAhead) {
              const diffSummary = getDiffSummary(session.workdir, branchName, baseBranch);
              if (diffSummary) {
                lines.push(`  Commits:  ${diffSummary.commits} ahead of ${baseBranch} (+${diffSummary.insertions} / -${diffSummary.deletions})`);
              } else {
                lines.push(`  Commits:  ahead of ${baseBranch}`);
              }
            } else {
              lines.push(`  Commits:  even with ${baseBranch}`);
            }
          } catch {
            lines.push(`  Commits:  (unable to check)`);
          }
        } else {
          lines.push(`  Commits:  (repo no longer exists)`);
        }

        // Show merge/PR status
        if (session.worktreeMerged) {
          const mergedAt = session.worktreeMergedAt ? new Date(session.worktreeMergedAt).toLocaleString() : "unknown";
          lines.push(`  Merged:   Yes (${mergedAt})`);
        } else if (session.worktreePrUrl) {
          lines.push(`  PR:       ${session.worktreePrUrl}`);
        } else {
          lines.push(`  Merged:   No`);
        }

        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    },
  };
}
