import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import { executeRespond } from "../actions/respond";
import type { OpenClawPluginToolContext } from "../types";

interface AgentRespondParams {
  session: string;
  message: string;
  interrupt?: boolean;
  userInitiated?: boolean;
  approve?: boolean;
  approval_rationale?: string;
}

function isAgentRespondParams(value: unknown): value is AgentRespondParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.session === "string"
    && typeof params.message === "string"
    && (params.approval_rationale === undefined || typeof params.approval_rationale === "string");
}

/** Create `agent_respond` tool definition. */
export function makeAgentRespondTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_respond",
    description:
      "Send a message to a session: a follow-up, an answer to its question (option number or label; comma-separated for multi-select), or plan feedback. A stopped, suspended or completed session that still has its conversation is resumed.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID" }),
      message: Type.String(),
      interrupt: Type.Optional(Type.Boolean({ description: "Stop the current turn first" })),
      userInitiated: Type.Optional(
        Type.Boolean({ description: "true when forwarding the user's own words. Forward each user message whole, in one call. For a pending plan, a message that is only 'approve', 'reject' or 'revise' decides it; any other message (including 'revise …' with the changes) is one revision with that feedback." }),
      ),
      approve: Type.Optional(
        Type.Boolean({ description: "Approve the pending plan (delegate/approve modes). Refused when planApproval is 'ask': only the user approves there. On a default-mode session: switch to bypassPermissions." }),
      ),
      approval_rationale: Type.Optional(
        Type.String({ description: "With approve=true: one short line on why the plan is safe; shown to the user in the approval notice" }),
      ),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentRespondParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, message, interrupt?, userInitiated?, approve?, approval_rationale? }." }] };
      }

      const result = await executeRespond(sessionManager, {
        session: params.session,
        message: params.message,
        interrupt: params.interrupt,
        userInitiated: params.userInitiated,
        approve: params.approve,
        approvalRationale: params.approval_rationale,
        fromOrchestratorTurn: true,
      });

      return {
        isError: result.isError ?? false,
        content: [{ type: "text", text: result.text }],
      };
    },
  };
}
