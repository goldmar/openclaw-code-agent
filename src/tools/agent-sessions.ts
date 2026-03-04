import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { resolveAgentChannel } from "../config";
import type { OpenClawPluginToolContext } from "../types";
import { getSessionsListingText } from "../application/session-view";

type SessionsFilter = "all" | "running" | "completed" | "failed" | "killed";

interface AgentSessionsParams {
  status?: SessionsFilter;
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
    description: "List all coding agent sessions with their status and progress.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union(
          [Type.Literal("all"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("killed")],
          { description: 'Filter by status (default "all")' },
        ),
      ),
    }),
    async execute(_id: string, params: AgentSessionsParams | unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const filter = parseStatus(params);
      const originChannel = ctx?.workspaceDir ? resolveAgentChannel(ctx.workspaceDir) : undefined;
      const text = getSessionsListingText(sessionManager, filter, originChannel);
      return { content: [{ type: "text", text }] };
    },
  };
}
