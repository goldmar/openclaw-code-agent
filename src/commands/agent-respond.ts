import { sessionManager } from "../singletons";
import { executeRespond } from "../actions/respond";

interface AgentRespondCommandContext {
  args?: string;
}

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
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      const args = (ctx.args ?? "").trim();
      if (!args) {
        return { text: "Usage: /agent_respond <id-or-name> <message>\n       /agent_respond --interrupt <id-or-name> <message>" };
      }

      let interrupt = false;
      let remaining = args;
      if (remaining.startsWith("--interrupt ")) {
        interrupt = true;
        remaining = remaining.slice("--interrupt ".length).trim();
      }

      const spaceIdx = remaining.indexOf(" ");
      if (spaceIdx === -1) {
        return { text: "Error: Missing message. Usage: /agent_respond <id-or-name> <message>" };
      }

      const ref = remaining.slice(0, spaceIdx);
      const message = remaining.slice(spaceIdx + 1).trim();
      if (!message) {
        return { text: "Error: Empty message. Usage: /agent_respond <id-or-name> <message>" };
      }

      const result = await executeRespond(sessionManager, {
        session: ref,
        message,
        interrupt,
        userInitiated: true, // Command is always user-initiated
      });

      return { text: result.text };
    },
  });
}
