import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { resolveAgentChannel } from "../config";
import type { OpenClawPluginToolContext } from "../types";
import { getSessionsListingText } from "../application/session-view";

type SessionsFilter = "all" | "running" | "completed" | "failed" | "killed";

interface AgentSessionsParams {
  status?: SessionsFilter;
  full?: boolean;
}

function parseStatus(params: unknown): SessionsFilter {
  if (!params || typeof params !== "object") return "all";
  const status = (params as Record<string, unknown>).status;
  switch (status) {
    case "running":
    case "completed":
    case "failed":
    case "killed":
    case "all":
      return status;
    default:
      return "all";
  }
}

/** Register the `agent_sessions` tool factory. */
export function makeAgentSessionsTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_sessions",
    description: "List coding agent sessions with their status and progress. By default, shows the 5 most recent sessions; set `full` to show all sessions from the last 24 hours.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union(
          [Type.Literal("all"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("killed")],
          { description: 'Filter by status (default "all")' },
        ),
      ),
      full: Type.Optional(
        Type.Boolean({ description: "Show all sessions from the last 24h instead of just the most recent 5" }),
      ),
    }),
    async execute(_id: string, params: AgentSessionsParams | unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const filter = parseStatus(params);
      const originChannel = ctx?.workspaceDir ? resolveAgentChannel(ctx.workspaceDir) : undefined;
      const full = !!(params && typeof params === "object" && (params as Record<string, unknown>).full === true);
      const text = getSessionsListingText(sessionManager, filter, originChannel, { full });
      return { content: [{ type: "text", text }] };
    },
  };
}
