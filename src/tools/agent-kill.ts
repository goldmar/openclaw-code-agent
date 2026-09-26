import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getKillSessionText } from "../application/session-control";

interface AgentKillParams {
  session: string;
  reason?: "completed" | "killed";
}

const AGENT_KILL_PARAM_KEYS = new Set(["session", "reason"]);

function isAgentKillParams(value: unknown): value is AgentKillParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  if (typeof params.session !== "string") return false;
  // Reject unknown fields so a call written for another parameter shape is
  // refused instead of falling through to a kill.
  if (Object.keys(params).some((key) => !AGENT_KILL_PARAM_KEYS.has(key))) return false;
  if (params.reason === undefined) return true;
  return params.reason === "completed" || params.reason === "killed";
}

/** Register the `agent_kill` tool factory. */
export function makeAgentKillTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_kill",
    description: "Stop a session. reason='completed' marks it done (✅) instead of killed.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID" }),
      reason: Type.Optional(Type.StringEnum(["completed", "killed"], { description: "Default killed" })),
    }, { additionalProperties: false }),
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
