import { sessionManager } from "../singletons";
import { executeRespond } from "../actions/respond";
import { isCommandInRouteChat } from "../config";
import type { AgentCommandContext } from "./agent";
import { consumeFirstCommandArg, SERVICE_NOT_RUNNING } from "./args";

type AgentRespondCommandContext = AgentCommandContext;

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: AgentRespondCommandContext) => Promise<{ text: string }>;
  }): void;
}

/** Register `/agent_respond` chat command. */
export function registerAgentRespondCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_respond",
    description:
      "Send a follow-up message to a running coding agent session. Usage: /agent_respond <id-or-name> <message>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: AgentRespondCommandContext) => {
      if (!sessionManager) {
        return { text: SERVICE_NOT_RUNNING };
      }

      const args = (ctx.args ?? "").trim();
      if (!args) {
        return { text: "Usage: /agent_respond <id-or-name> <message>\n       /agent_respond --interrupt <id-or-name> <message>" };
      }

      let interrupt = false;
      let remaining = args;
      const first = consumeFirstCommandArg(remaining);
      if (first?.value === "--interrupt") {
        interrupt = true;
        remaining = first.rest;
      }

      const refArg = consumeFirstCommandArg(remaining);
      if (!refArg) {
        return { text: "Error: Missing message. Usage: /agent_respond <id-or-name> <message>" };
      }

      const ref = refArg.value;
      const message = refArg.rest;
      if (!message.trim()) {
        return { text: "Error: Empty message. Usage: /agent_respond <id-or-name> <message>" };
      }

      const target = sessionManager.resolve(ref) ?? sessionManager.getPersistedSession(ref);
      const result = await executeRespond(sessionManager, {
        session: ref,
        message,
        interrupt,
        userInitiated: true, // Command is always user-initiated
        // In the session's own chat this reply is the one message: it replaces
        // the notice of a resume, plan approval or plan rejection.
        replyIsNotice: isCommandInRouteChat(ctx, target),
      });

      // The user-facing form: no session ids, no tool hints (those are for the orchestrator).
      return { text: result.userText ?? result.text };
    },
  });
}
