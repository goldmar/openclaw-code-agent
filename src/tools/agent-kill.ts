import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

export function makeAgentKillTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_kill",
    description: "Terminate or complete a running coding agent session by name or ID. Use reason='completed' to mark a session as successfully completed instead of killed.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to terminate" }),
      reason: Type.Optional(
        Type.Union(
          [Type.Literal("completed"), Type.Literal("killed")],
          { description: "Reason for closing the session. 'completed' marks it as successfully done (sends ✅ notification). 'killed' (default) terminates it." },
        ),
      ),
    }),
    async execute(_id: string, params: any) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const session = sessionManager.resolve(params.session);
      if (!session) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" not found.` }] };
      }

      if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
        return { content: [{ type: "text", text: `Session ${session.name} [${session.id}] is already ${session.status}. No action needed.` }] };
      }

      if (params.reason === "completed") {
        session.complete();
        return { content: [{ type: "text", text: `Session ${session.name} [${session.id}] marked as completed.` }] };
      }

      sessionManager.kill(session.id);
      return { content: [{ type: "text", text: `Session ${session.name} [${session.id}] has been terminated.` }] };
    },
  };
}
