import { sessionManager } from "../singletons";
import { formatStats } from "../format";

export function registerAgentStatsCommand(api: any): void {
  api.registerCommand({
    name: "agent_stats",
    description: "Show OpenClaw Code Agent usage metrics",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      const metrics = sessionManager.getMetrics();
      const runningCount = sessionManager.list("running").length;
      return { text: formatStats(metrics, runningCount) };
    },
  });
}
