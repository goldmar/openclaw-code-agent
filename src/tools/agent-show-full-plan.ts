import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface AgentShowFullPlanParams {
  session: string;
}

function isAgentShowFullPlanParams(value: unknown): value is AgentShowFullPlanParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.session === "string";
}

export function makeAgentShowFullPlanTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_show_full_plan",
    description:
      "Send the current full plan back to the user using the plugin's paginated plan renderer and approval buttons. Use this when the user asks to see the full plan again in chat instead of replying with a long plain-text summary.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID that is waiting on direct user plan approval" }),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentShowFullPlanParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session }." }] };
      }

      const text = sessionManager.sendFullPlanToUser(params.session);
      return {
        isError: text.startsWith("Error:"),
        content: [{ type: "text", text }],
      };
    },
  };
}
