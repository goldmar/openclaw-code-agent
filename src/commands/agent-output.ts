import { sessionManager } from "../singletons";
import { getSessionOutputText } from "../application/session-view";

const DEFAULT_OUTPUT_LINES = 50;

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: { args?: string }) => { text: string };
  }): void;
}

/** Register `/agent_output` chat command. */
export function registerAgentOutputCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_output",
    description:
      "Show recent output from a coding agent session. Usage: /agent_output <id-or-name> [--full] [--lines N]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: { args?: string }) => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      const raw = (ctx.args ?? "").trim();
      if (!raw) {
        return { text: "Usage: /agent_output <id-or-name> [--full] [--lines N]" };
      }

      // Parse flags from args
      const tokens = raw.split(/\s+/);
      let ref = "";
      let full = false;
      let lines = DEFAULT_OUTPUT_LINES;

      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === "--full") {
          full = true;
        } else if (tokens[i] === "--lines" && i + 1 < tokens.length) {
          const n = parseInt(tokens[i + 1], 10);
          if (!isNaN(n) && n > 0) lines = n;
          i++; // skip the number token
        } else if (!ref) {
          ref = tokens[i];
        }
      }

      if (!ref) {
        return { text: "Usage: /agent_output <id-or-name> [--full] [--lines N]" };
      }

      const text = getSessionOutputText(sessionManager, ref, { full, lines });
      return { text };
    },
  });
}
