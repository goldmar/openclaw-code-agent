import { sessionToolError, unknownSessionError } from "./session-tool-error";
import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getSessionOutputText } from "../application/session-view";

interface AgentOutputParams {
  codeAgentSessionId: string;
  lines?: number;
  full?: boolean;
}

function isAgentOutputParams(value: unknown): value is AgentOutputParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.codeAgentSessionId === "string"
    && (params.lines === undefined || typeof params.lines === "number")
    && (params.full === undefined || typeof params.full === "boolean");
}

/** Register the `agent_output` tool factory. */
export function makeAgentOutputTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_output",
    description: "Recent output of a session, with its status header. Use full=true to read a whole plan or result.",
    parameters: Type.Object({
      codeAgentSessionId: Type.String({ description: "Session name or ID" }),
      lines: Type.Optional(Type.Number({ description: "Default 50" })),
      full: Type.Optional(Type.Boolean()),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return sessionToolError("service_unavailable", "Error: SessionManager not initialized. The code-agent service must be running.");
      }
      if (!isAgentOutputParams(params)) {
        return sessionToolError("invalid_parameters", "Error: Invalid parameters. Expected { codeAgentSessionId, lines?, full? }.");
      }
      const sm = sessionManager;
      if (!sm.resolve(params.codeAgentSessionId) && !sm.getPersistedSession(params.codeAgentSessionId)) {
        return unknownSessionError(params.codeAgentSessionId);
      }
      const text = getSessionOutputText(sm, params.codeAgentSessionId, {
        full: params.full,
        lines: params.lines,
        readerSessionKey: ctx?.sessionKey || undefined,
      });
      return { content: [{ type: "text", text }] };
    },
  };
}
