import { sessionManager } from "../singletons";
import { getSessionsListingText } from "../application/session-view";

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: { args?: string }) => { text: string };
  }): void;
}

/** Register `/agent_status`: the sessions waiting for a decision or an answer. */
export function registerAgentStatusCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_status",
    description: "Show coding sessions waiting for a plan decision, an answer, or a merge / PR decision",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }
      return { text: getSessionsListingText(sessionManager, "waiting") };
    },
  });
}
