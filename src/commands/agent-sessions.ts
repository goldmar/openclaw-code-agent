import { sessionManager } from "../singletons";
import { getSessionsListingText } from "../application/session-view";

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: () => { text: string };
  }): void;
}

/** Register `/agent_sessions` chat command. */
export function registerAgentSessionsCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_sessions",
    description: "List all coding agent sessions",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      return { text: getSessionsListingText(sessionManager, "all") };
    },
  });
}
