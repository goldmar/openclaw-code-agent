import { normalizeSessionReferenceParams, sessionReferenceProperties, requiredSessionReference } from "./session-reference-params";
import { sessionToolError, unknownSessionError } from "./session-tool-error";
import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getSessionOutputText } from "../application/session-view";

interface AgentOutputParams {
  ocaSessionId: string;
  lines?: number;
  full?: boolean;
}

function isAgentOutputParams(value: unknown): value is AgentOutputParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.ocaSessionId === "string"
    && (params.lines === undefined || typeof params.lines === "number")
    && (params.full === undefined || typeof params.full === "boolean");
}

/** Register the `agent_output` tool factory. */
export function makeAgentOutputTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_output",
    description: "Recent output of a session, with its status header. Use full=true to read a whole plan or result.",
    parameters: Type.Object({
      ...sessionReferenceProperties(),
      lines: Type.Optional(Type.Number({ description: "Default 50" })),
      full: Type.Optional(Type.Boolean()),
    }, requiredSessionReference),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return sessionToolError("service_unavailable", "Error: SessionManager not initialized. The code-agent service must be running.");
      }
      const normalized = normalizeSessionReferenceParams(params);
      if (normalized.ok === false) return normalized.error;
      params = normalized.params;
      if (!isAgentOutputParams(params)) {
        return sessionToolError("invalid_parameters", "Error: Invalid parameters. Expected { ocaSessionId, lines?, full? }.");
      }
      const sm = sessionManager;
      if (!sm.resolve(params.ocaSessionId) && !sm.getPersistedSession(params.ocaSessionId)) {
        return unknownSessionError(params.ocaSessionId);
      }
      const text = getSessionOutputText(sm, params.ocaSessionId, {
        full: params.full,
        lines: params.lines,
        readerSessionKey: ctx?.sessionKey || undefined,
      });
      return { content: [{ type: "text", text }] };
    },
  };
}
