import { Type } from "../tool-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface AgentRequestWorktreeDecisionParams {
  session: string;
  summary: string;
}

function isAgentRequestWorktreeDecisionParams(value: unknown): value is AgentRequestWorktreeDecisionParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.session === "string" && typeof params.summary === "string";
}

export function makeAgentRequestWorktreeDecisionTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_request_worktree_decision",
    description:
      "Send a worktree Merge/Open PR/Later/Discard decision prompt to the user for a delegated worktree session that is awaiting human choice.",
    parameters: Type.Object({
      session: Type.String({ description: "Delegated session name or ID awaiting a worktree decision" }),
      summary: Type.String({ description: "Concise user-facing summary of scope, risk, and why human choice is needed" }),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentRequestWorktreeDecisionParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, summary }." }] };
      }

      const text = sessionManager.requestWorktreeDecisionFromUser(params.session, params.summary);
      return {
        isError: text.startsWith("Error:"),
        content: [{ type: "text", text }],
      };
    },
  };
}
