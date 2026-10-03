import { sessionManager } from "../singletons";
import { SERVICE_NOT_RUNNING } from "./args";
import { getKillSessionText } from "../application/session-control";
import { isCommandInRouteChat } from "../config";
import type { AgentCommandContext } from "./agent";

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: AgentCommandContext) => { text: string };
  }): void;
}

/** Register `/agent_kill` chat command. */
export function registerAgentKillCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_kill",
    description: "Kill a coding agent session by name or ID",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: AgentCommandContext) => {
      if (!sessionManager) {
        return { text: SERVICE_NOT_RUNNING };
      }

      const ref = ctx.args?.trim();
      if (!ref) return { text: "Usage: /agent_kill <name-or-id>" };

      // In the session's own chat the reply is the stop notice itself: one
      // message. From another chat the notice stays in the session's chat.
      return {
        text: getKillSessionText(sessionManager, ref, "killed", {
          replyIsStopNotice: (session) => isCommandInRouteChat(ctx, session),
        }),
      };
    },
  });
}
