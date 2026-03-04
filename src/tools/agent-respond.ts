import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { executeRespond } from "../actions/respond";
import type { OpenClawPluginToolContext } from "../types";

interface AgentRespondParams {
  session: string;
  message: string;
  interrupt?: boolean;
  userInitiated?: boolean;
  approve?: boolean;
}

/** Create `agent_respond` tool definition. */
export function makeAgentRespondTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_respond",
    description:
      "Send a follow-up message to a running coding agent session. The session must be running. Sessions are multi-turn by default, so this works with any session unless it was launched with multi_turn_disabled: true.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to respond to" }),
      message: Type.String({ description: "The message to send to the session" }),
      interrupt: Type.Optional(
        Type.Boolean({ description: "If true, interrupt the current turn before sending the message. Useful to redirect the session mid-response." }),
      ),
      userInitiated: Type.Optional(
        Type.Boolean({ description: "Set to true when the message comes from the user (not auto-generated). Resets the auto-respond counter and bypasses the auto-respond limit." }),
      ),
      approve: Type.Optional(
        Type.Boolean({ description: "Set to true to approve a pending plan and switch the session from plan mode to bypassPermissions. Only works when the session has a pending plan approval (after ExitPlanMode / set_permission_mode). To request changes instead, omit this flag — the message will be sent as revision feedback and the agent will revise the plan." }),
      ),
    }),
    async execute(_id: string, params: AgentRespondParams) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const result = await executeRespond(sessionManager, params);

      return {
        isError: result.isError ?? false,
        content: [{ type: "text", text: result.text }],
      };
    },
  };
}
