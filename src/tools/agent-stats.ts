import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { formatStats } from "../format";
import type { OpenClawPluginToolContext } from "../types";

/** Create `agent_stats` tool definition. */
export function makeAgentStatsTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_stats",
    description:
      "Show OpenClaw Code Agent usage metrics: session counts by status, average duration, and notable sessions.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: Record<string, never>) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const metrics = sessionManager.getMetrics();
      const runningCount = sessionManager.list("running").length;
      return { content: [{ type: "text", text: formatStats(metrics, runningCount) }] };
    },
  };
}
