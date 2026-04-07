import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import {
  formatWorktreeLifecycleState,
  formatWorktreePreserveReason,
  listWorktreeToolTargets,
  matchesWorktreeToolRef,
  resolveWorktreeToolLifecycle,
} from "./worktree-tool-context";

interface AgentWorktreeStatusParams {
  session?: string;
}

function isAgentWorktreeStatusParams(value: unknown): value is AgentWorktreeStatusParams {
  if (!value || typeof value !== "object") return true;
  return true;
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
        const { persistedSession: persisted, resolvedLifecycle: resolved } = resolveWorktreeToolLifecycle(sessionManager, target);

        const cleanup = resolved.cleanupSafe
          ? "safe now"
          : (resolved.preserve ? "preserve" : "blocked");

        lines.push(`Session: ${target.name} [${target.id}]`);
        lines.push(`  Branch:   ${target.worktreeBranch ?? "(unknown)"} → ${resolved.lifecycle.baseBranch ?? persisted?.worktreeBaseBranch ?? "main"}`);
        lines.push(`  Repo:     ${target.workdir}`);
        lines.push(`  Lifecycle:${formatWorktreeLifecycleState(resolved.lifecycle.state)}`);
        if (resolved.derivedState !== resolved.lifecycle.state) {
          lines.push(`  Derived:  ${formatWorktreeLifecycleState(resolved.derivedState)}`);
        }
        lines.push(`  Cleanup:  ${cleanup}`);
        if (resolved.evidence.prUrl) {
          lines.push(`  PR:       ${resolved.evidence.prUrl} (${resolved.evidence.prState ?? "unknown"})`);
        }
        if (resolved.evidence.branchAheadCount != null || resolved.evidence.baseAheadCount != null) {
          lines.push(`  Ahead:    ${resolved.evidence.branchAheadCount ?? 0} ahead / ${resolved.evidence.baseAheadCount ?? 0} behind`);
        }
        lines.push(`  Reasons:  ${resolved.reasons.length > 0 ? resolved.reasons.map(formatWorktreePreserveReason).join(", ") : "none"}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    },
  };
}
