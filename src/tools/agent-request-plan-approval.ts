import { Type } from "../tool-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

interface AgentRequestPlanApprovalParams {
  session: string;
  summary: string;
}

function isAgentRequestPlanApprovalParams(value: unknown): value is AgentRequestPlanApprovalParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.session === "string" && typeof params.summary === "string";
}

export function makeAgentRequestPlanApprovalTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_request_plan_approval",
    description:
      "Send a plan-approval decision prompt to the user for a session that is already waiting on plan approval. Reuses the plugin's Approve/Revise/Reject buttons so the user can decide directly from the message.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID awaiting plan approval" }),
      summary: Type.String({ description: "Concise user-facing summary of scope, risk, and any concerns that should accompany the approval buttons" }),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentRequestPlanApprovalParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, summary }." }] };
      }

      const text = sessionManager.requestPlanApprovalFromUser(params.session, params.summary);
      return {
        isError: text.startsWith("Error:"),
        content: [{ type: "text", text }],
      };
    },
  };
}
