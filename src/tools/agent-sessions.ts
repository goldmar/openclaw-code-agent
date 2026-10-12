import { normalizeBooleanParams } from "./boolean-normalization";
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

function isAgentSessionsParams(value: unknown): value is AgentSessionsParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return (params.status === undefined || ["all", "running", "waiting", "completed", "failed", "killed"].some((status) => status === params.status))
    && (params.full === undefined || typeof params.full === "boolean");
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
        Type.BooleanLike(),
      ),
    }),
    async execute(_id: string, params: AgentSessionsParams | unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const input = normalizeBooleanParams(params ?? {}, ["full"], isAgentSessionsParams);
      if (!input) return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { status?, full? }." }] };
      const filter = parseStatus(input);
      const originChannel = ctx?.workspaceDir ? resolveAgentChannel(ctx.workspaceDir) : undefined;
      const full = input.full === true;
      const text = getSessionsListingText(sessionManager, filter, originChannel, { full });
      return { content: [{ type: "text", text }] };
    },
  };
}
