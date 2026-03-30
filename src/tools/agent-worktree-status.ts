import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import type { ManagedWorktreeLifecycleState, OpenClawPluginToolContext } from "../types";
import { resolveWorktreeLifecycle } from "../worktree-lifecycle-resolver";
import { listWorktreeToolTargets, matchesWorktreeToolRef } from "./worktree-tool-context";

interface AgentWorktreeStatusParams {
  session?: string;
}

function isAgentWorktreeStatusParams(value: unknown): value is AgentWorktreeStatusParams {
  if (!value || typeof value !== "object") return true;
  return true;
}

function formatLifecycleState(state: ManagedWorktreeLifecycleState): string {
  switch (state) {
    case "none":
      return "none";
    case "provisioned":
      return "active";
    case "pending_decision":
      return "needs decision";
    case "pr_open":
      return "pr open";
    case "merged":
      return "merged";
    case "released":
      return "released";
    case "dismissed":
      return "dismissed";
    case "no_change":
      return "no change";
    case "cleanup_failed":
      return "cleanup failed";
  }
}

function formatReason(reason: string): string {
  switch (reason) {
    case "active_session":
      return "active session";
    case "pending_decision":
      return "pending decision";
    case "dirty_tracked_changes":
      return "dirty worktree";
    case "unique_content":
      return "still has unique content";
    case "topology_merged":
      return "merged by ancestry";
    case "merge_noop_content_already_on_base":
      return "content already on base";
    case "pr_open":
      return "PR open";
    case "pr_merged_not_reflected_locally":
      return "merged PR not reflected locally";
    case "repo_missing":
      return "repo missing";
    case "branch_missing":
      return "branch missing";
    case "worktree_missing":
      return "worktree missing";
    case "base_branch_missing":
      return "base branch missing";
    default:
      return reason.replaceAll("_", " ");
  }
}

export function makeAgentWorktreeStatusTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_worktree_status",
    description: "Show lifecycle-first worktree status for coding agent sessions. Displays product-facing lifecycle state, released handling, cleanup safety, and retained reasons.",
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
      let sessionsToShow = listWorktreeToolTargets(sessionManager);
      if (targetSession) {
        sessionsToShow = sessionsToShow.filter((session) => matchesWorktreeToolRef(session, targetSession));
        if (sessionsToShow.length === 0) {
          return { content: [{ type: "text", text: `Error: Session "${targetSession}" not found or has no worktree.` }] };
        }
      }
      if (sessionsToShow.length === 0) {
        return { content: [{ type: "text", text: "No sessions with worktrees found." }] };
      }

      const lines: string[] = [];
      for (const target of sessionsToShow) {
        const persisted = sessionManager.getPersistedSession(target.id)
          ?? (target.backendConversationId ? sessionManager.getPersistedSession(target.backendConversationId) : undefined)
          ?? (target.harnessSessionId ? sessionManager.getPersistedSession(target.harnessSessionId) : undefined)
          ?? sessionManager.getPersistedSession(target.name);
        const active = sessionManager.resolve(target.id)
          ?? (target.backendConversationId ? sessionManager.resolve(target.backendConversationId) : undefined)
          ?? (target.harnessSessionId ? sessionManager.resolve(target.harnessSessionId) : undefined)
          ?? sessionManager.resolve(target.name);

        const resolved = resolveWorktreeLifecycle({
          workdir: target.workdir,
          worktreePath: target.worktreePath,
          worktreeBranch: target.worktreeBranch,
          worktreeBaseBranch: persisted?.worktreeBaseBranch,
          worktreePrTargetRepo: persisted?.worktreePrTargetRepo,
          worktreePushRemote: persisted?.worktreePushRemote,
          worktreePrUrl: persisted?.worktreePrUrl,
          worktreePrNumber: persisted?.worktreePrNumber,
          worktreeLifecycle: persisted?.worktreeLifecycle,
        }, {
          activeSession: Boolean(active && (active.status === "starting" || active.status === "running")),
          includePrSync: Boolean(persisted?.worktreeLifecycle?.state === "pr_open" || persisted?.worktreePrUrl),
        });

        const cleanup = resolved.cleanupSafe
          ? "safe now"
          : (resolved.preserve ? "preserve" : "blocked");

        lines.push(`Session: ${target.name} [${target.id}]`);
        lines.push(`  Branch:   ${target.worktreeBranch ?? "(unknown)"} → ${resolved.lifecycle.baseBranch ?? persisted?.worktreeBaseBranch ?? "main"}`);
        lines.push(`  Repo:     ${target.workdir}`);
        lines.push(`  Lifecycle:${formatLifecycleState(resolved.lifecycle.state)}`);
        if (resolved.derivedState !== resolved.lifecycle.state) {
          lines.push(`  Derived:  ${formatLifecycleState(resolved.derivedState)}`);
        }
        lines.push(`  Cleanup:  ${cleanup}`);
        if (resolved.evidence.prUrl) {
          lines.push(`  PR:       ${resolved.evidence.prUrl} (${resolved.evidence.prState ?? "unknown"})`);
        }
        if (resolved.evidence.branchAheadCount != null || resolved.evidence.baseAheadCount != null) {
          lines.push(`  Ahead:    ${resolved.evidence.branchAheadCount ?? 0} ahead / ${resolved.evidence.baseAheadCount ?? 0} behind`);
        }
        lines.push(`  Reasons:  ${resolved.reasons.length > 0 ? resolved.reasons.map(formatReason).join(", ") : "none"}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    },
  };
}
