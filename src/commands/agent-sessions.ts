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

/** Register `/agent_sessions` chat command. */
export function registerAgentSessionsCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_sessions",
    description: "List coding agent sessions. Usage: /agent_sessions [--full]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: { args?: string }) => {
      if (!sessionManager) {
        return { text: SERVICE_NOT_RUNNING };
      }

      const full = (ctx.args ?? "").split(/\s+/).includes("--full");
      return { text: getSessionsListingText(sessionManager, "all", undefined, { full }) };
    },
  });
}
