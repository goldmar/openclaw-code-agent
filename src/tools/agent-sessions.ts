import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import { resolveAgentChannel } from "../config";
import type { OpenClawPluginToolContext } from "../types";
import { getSessionsListingText } from "../application/session-view";

type SessionsFilter = "all" | "running" | "waiting" | "completed" | "failed" | "killed";

interface AgentSessionsParams {
  status?: SessionsFilter;
  full?: boolean;
}

function parseStatus(params: unknown): SessionsFilter {
  if (!params || typeof params !== "object") return "all";
  const status = (params as Record<string, unknown>).status;
  switch (status) {
    case "running":
    case "waiting":
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
    description: "List sessions (5 most recent; full=true: last 24h). status='waiting' lists only sessions waiting for a decision or answer, with the next step.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.StringEnum(["all", "running", "waiting", "completed", "failed", "killed"],
          { description: "Default all" },
        ),
      ),
      full: Type.Optional(
        Type.Boolean(),
      ),
    }),
    async execute(_id: string, params: AgentSessionsParams | unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const filter = parseStatus(params);
      const originChannel = ctx?.workspaceDir ? resolveAgentChannel(ctx.workspaceDir) : undefined;
      const full = !!(params && typeof params === "object" && (params as Record<string, unknown>).full === true);
      const text = getSessionsListingText(sessionManager, filter, originChannel, { full, markOutcomesSeen: true });
      return { content: [{ type: "text", text }] };
    },
  };
}
