import { sessionManager } from "../singletons";
import { SERVICE_NOT_RUNNING } from "./args";
import { getFreshSessionsListingText } from "../application/session-view";

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: { args?: string }) => Promise<{ text: string }>;
  }): void;
}

/** Register `/agent_status`: the sessions waiting for a decision or an answer. */
export function registerAgentStatusCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_status",
    description: "Show coding sessions waiting for a plan decision, an answer, or a merge / PR decision",
    acceptsArgs: false,
    requireAuth: true,
    handler: async () => {
      if (!sessionManager) {
        return { text: SERVICE_NOT_RUNNING };
      }
      return { text: await getFreshSessionsListingText(sessionManager, "waiting", undefined, { forUser: true }) };
    },
  });
}
