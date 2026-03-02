import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { resolveAgentChannel } from "../config";
import { formatSessionListing } from "../format";
import type { OpenClawPluginToolContext } from "../types";

export function makeAgentSessionsTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_sessions",
    description: "List all coding agent sessions with their status and progress.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union(
          [Type.Literal("all"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("killed")],
          { description: 'Filter by status (default "all")' },
        ),
      ),
    }),
    async execute(_id: string, params: any) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const filter = params.status || "all";
      let sessions = sessionManager.list(filter);

      // Filter by agent channel if context is available
      if (ctx?.workspaceDir) {
        const agentChannel = resolveAgentChannel(ctx.workspaceDir);
        if (agentChannel) {
          sessions = sessions.filter((s) => s.originChannel === agentChannel);
        }
      }

      if (sessions.length === 0) {
        return { content: [{ type: "text", text: "No sessions found." }] };
      }

      return { content: [{ type: "text", text: sessions.map(formatSessionListing).join("\n\n") }] };
    },
  };
}
