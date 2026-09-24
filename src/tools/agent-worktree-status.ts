import { Type } from "../tool-parameter-schema";
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
  if (value == null) return true;
  if (Array.isArray(value)) return false;
  if (typeof value !== "object") return false;
  const session = (value as Record<string, unknown>).session;
  return session === undefined || typeof session === "string";
}

const STATUS_LABEL_WIDTH = "Lifecycle:".length;

/** One indented `Label: value` row; values share a column and always follow a space. */
function statusField(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(STATUS_LABEL_WIDTH)} ${value}`;
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

      const targetSession = params && typeof params === "object"
        ? (params as AgentWorktreeStatusParams).session
        : undefined;
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
        const { persistedSession: persisted, resolvedLifecycle: resolved } = await resolveWorktreeToolLifecycle(sessionManager, target);

        const cleanup = resolved.cleanupSafe
          ? "safe now"
          : (resolved.preserve ? "preserve" : "blocked");

        lines.push(`Session: ${target.name} [${target.id}]`);
        lines.push(statusField("Branch", `${target.worktreeBranch ?? "(unknown)"} → ${resolved.lifecycle.baseBranch ?? persisted?.worktreeBaseBranch ?? "main"}`));
        lines.push(statusField("Repo", target.workdir));
        lines.push(statusField("Lifecycle", formatWorktreeLifecycleState(resolved.lifecycle.state)));
        if (resolved.derivedState !== resolved.lifecycle.state) {
          lines.push(statusField("Derived", formatWorktreeLifecycleState(resolved.derivedState)));
        }
        lines.push(statusField("Cleanup", cleanup));
        if (resolved.evidence.prUrl) {
          lines.push(statusField("PR", `${resolved.evidence.prUrl} (${resolved.evidence.prState ?? "unknown"})`));
        }
        if (resolved.evidence.branchAheadCount != null || resolved.evidence.baseAheadCount != null) {
          lines.push(statusField("Ahead", `${resolved.evidence.branchAheadCount ?? 0} ahead / ${resolved.evidence.baseAheadCount ?? 0} behind`));
        }
        lines.push(statusField("Reasons", resolved.reasons.length > 0 ? resolved.reasons.map(formatWorktreePreserveReason).join(", ") : "none"));
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    },
  };
}
