import { sessionManager } from "../singletons";
import { SERVICE_NOT_RUNNING } from "./args";
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
        return { text: SERVICE_NOT_RUNNING };
      }
      return { text: getSessionsListingText(sessionManager, "waiting") };
    },
  });
}
