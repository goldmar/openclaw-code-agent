import { normalizeSessionReferenceParams, sessionReferenceProperties, requiredSessionReference } from "./session-reference-params";
import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getKillSessionText } from "../application/session-control";

interface AgentKillParams {
  ocaSessionId: string;
  reason?: "completed" | "killed";
}

const AGENT_KILL_PARAM_KEYS = new Set(["ocaSessionId", "reason"]);

function isAgentKillParams(value: unknown): value is AgentKillParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  if (typeof params.ocaSessionId !== "string") return false;
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
    description: "Stop a session. reason='completed' marks a running session done (the user gets the completion notice) instead of killed. A suspended session (idle timeout, or recovered after a restart) is closed without a user notice.",
    parameters: Type.Object({
      ...sessionReferenceProperties(),
      reason: Type.Optional(Type.StringEnum(["completed", "killed"], { description: "Default killed" })),
    }, { ...requiredSessionReference, additionalProperties: false }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      const normalized = normalizeSessionReferenceParams(params);
      if (normalized.ok === false) return normalized.error;
      params = normalized.params;
      if (!isAgentKillParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { ocaSessionId, reason? }." }] };
      }

      const text = getKillSessionText(sessionManager, params.ocaSessionId, params.reason);
      return { content: [{ type: "text", text }] };
    },
  };
}
