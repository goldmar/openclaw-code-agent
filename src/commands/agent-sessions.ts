import { sessionManager } from "../singletons";
import { formatSessionListing } from "../format";

export function registerAgentSessionsCommand(api: any): void {
  api.registerCommand({
    name: "agent_sessions",
    description: "List all coding agent sessions",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      const sessions = sessionManager.list("all");
      if (sessions.length === 0) return { text: "No sessions found." };
      return { text: sessions.map(formatSessionListing).join("\n\n") };
    },
  });
}
