import { sessionManager } from "../singletons";
import { formatStats } from "../format";

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: () => { text: string };
  }): void;
}

/** Register `/agent_stats` chat command. */
export function registerAgentStatsCommand(api: CommandApi): void {
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
