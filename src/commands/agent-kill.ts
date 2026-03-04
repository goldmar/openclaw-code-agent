import { sessionManager } from "../singletons";
import { getKillSessionText } from "../application/session-control";

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: { args?: string }) => { text: string };
  }): void;
}

/** Register `/agent_kill` chat command. */
export function registerAgentKillCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_kill",
    description: "Kill a coding agent session by name or ID",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: { args?: string }) => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      const ref = ctx.args?.trim();
      if (!ref) return { text: "Usage: /agent_kill <name-or-id>" };

      return { text: getKillSessionText(sessionManager, ref, "killed") };
    },
  });
}
