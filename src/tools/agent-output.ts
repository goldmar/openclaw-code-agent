import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getSessionOutputText } from "../application/session-view";

interface AgentOutputParams {
  session: string;
  lines?: number;
  full?: boolean;
}

function isAgentOutputParams(value: unknown): value is AgentOutputParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.session === "string";
}

/** Register the `agent_output` tool factory. */
export function makeAgentOutputTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_output",
    description: "Show recent output from a coding agent session (by name or ID).",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to get output from" }),
      lines: Type.Optional(Type.Number({ description: "Number of recent lines to show (default 50)" })),
      full: Type.Optional(Type.Boolean({ description: "Show all available output" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentOutputParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, lines?, full? }." }] };
      }
      const text = getSessionOutputText(sessionManager, params.session, {
        full: params.full,
        lines: params.lines,
      });
      return { content: [{ type: "text", text }] };
    },
  };
}
