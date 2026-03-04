import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getKillSessionText } from "../application/session-control";

interface AgentKillParams {
  session: string;
  reason?: "completed" | "killed";
}

function isAgentKillParams(value: unknown): value is AgentKillParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  if (typeof params.session !== "string") return false;
  if (params.reason === undefined) return true;
  return params.reason === "completed" || params.reason === "killed";
}

/** Register the `agent_kill` tool factory. */
export function makeAgentKillTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_kill",
    description: "Terminate or complete a running coding agent session by name or ID. Use reason='completed' to mark a session as successfully completed instead of killed.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to terminate" }),
      reason: Type.Optional(
        Type.Union(
          [Type.Literal("completed"), Type.Literal("killed")],
          { description: "Reason for closing the session. 'completed' marks it as successfully done (sends ✅ notification). 'killed' (default) terminates it." },
        ),
      ),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentKillParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, reason? }." }] };
      }

      const text = getKillSessionText(sessionManager, params.session, params.reason);
      return { content: [{ type: "text", text }] };
    },
  };
}
