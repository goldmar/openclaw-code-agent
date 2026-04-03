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
      "Send a follow-up message to a running coding agent session. The session must be running. All sessions are multi-turn.",
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
        Type.Boolean({ description: "Set to true to escalate session permissions to bypassPermissions. Works in two scenarios: (1) approve a pending plan in plan mode, or (2) escalate a default-mode session to skip remaining OpenClaw approval checkpoints. No-op if already in bypassPermissions mode. In plan mode without a pending plan, this flag is ignored." }),
      ),
      approval_rationale: Type.Optional(
        Type.String({ description: "Optional structured rationale for a direct delegated plan approval. Use this instead of embedding the rationale in message text when approve=true for a pending plan." }),
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
      });

      return {
        isError: result.isError ?? false,
        content: [{ type: "text", text: result.text }],
      };
    },
  };
}
