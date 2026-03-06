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

/** Register `/agent_sessions` chat command. */
export function registerAgentSessionsCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_sessions",
    description: "List coding agent sessions. Usage: /agent_sessions [--full]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: { args?: string }) => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      const full = (ctx.args ?? "").split(/\s+/).includes("--full");
      return { text: getSessionsListingText(sessionManager, "all", undefined, { full }) };
    },
  });
}
