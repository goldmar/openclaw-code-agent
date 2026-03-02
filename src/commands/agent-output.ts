import { readFileSync, existsSync } from "fs";
import { sessionManager } from "../singletons";
import { formatDuration } from "../format";

export function registerAgentOutputCommand(api: any): void {
  api.registerCommand({
    name: "agent_output",
    description:
      "Show recent output from a coding agent session. Usage: /agent_output <id-or-name> [--full] [--lines N]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
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
      let lines = 50;

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

      // Try active session first
      const session = sessionManager.resolve(ref);

      if (!session) {
        // Fall back to persisted session + /tmp output file
        const persisted = sessionManager.getPersistedSession(ref);
        if (persisted?.outputPath && existsSync(persisted.outputPath)) {
          try {
            const fileContent = readFileSync(persisted.outputPath, "utf-8");
            const header = [
              `Session: ${persisted.name} | Status: ${persisted.status.toUpperCase()} | Cost: $${persisted.costUsd.toFixed(4)}`,
              `(retrieved from ${persisted.outputPath} — session was garbage-collected)`,
              `${"─".repeat(60)}`,
            ].join("\n");

            let output = fileContent;
            if (!full && fileContent) {
              const fileLines = fileContent.split("\n");
              output = fileLines.slice(-lines).join("\n");
            }

            return { text: output ? `${header}\n${output}` : `${header}\n(output file was empty)` };
          } catch (err: any) {
            return { text: `Error: Session "${ref}" was cleaned up and output file could not be read: ${err.message}` };
          }
        }

        return { text: `Error: Session "${ref}" not found.` };
      }

      // Active session
      const outputLines = full ? session.getOutput() : session.getOutput(lines);
      const duration = formatDuration(session.duration);
      const costStr = ` | Cost: $${session.costUsd.toFixed(4)}`;
      const phaseStr = session.status === "running" ? ` | Phase: ${session.phase}` : "";
      const header = [
        `Session: ${session.name} [${session.id}] | Status: ${session.status.toUpperCase()}${phaseStr}${costStr} | Duration: ${duration}`,
        `${"─".repeat(60)}`,
      ].join("\n");

      if (outputLines.length === 0) {
        return { text: `${header}\n(no output yet)` };
      }

      return { text: `${header}\n${outputLines.join("\n")}` };
    },
  });
}
