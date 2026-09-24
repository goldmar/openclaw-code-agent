import { goalController, sessionManager } from "../singletons";
import { getForgetSessionText, getKillSessionText } from "../application/session-control";

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
    description: "Kill a coding agent session by name or ID. Usage: /agent_kill <name-or-id> | /agent_kill --forget <name-or-id>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: { args?: string }) => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      const args = ctx.args?.trim() ?? "";
      const forgetMatch = /^--forget(?:\s+|$)/.exec(args);
      const ref = forgetMatch ? args.slice(forgetMatch[0].length).trim() : args;
      if (!ref) return { text: "Usage: /agent_kill <name-or-id> | /agent_kill --forget <name-or-id>" };

      if (forgetMatch) return { text: getForgetSessionText(sessionManager, ref, goalController) };
      return { text: getKillSessionText(sessionManager, ref, "killed") };
    },
  });
}
