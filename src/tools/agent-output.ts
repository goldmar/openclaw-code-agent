import { Type } from "@sinclair/typebox";
import { readFileSync, existsSync } from "fs";
import { sessionManager } from "../singletons";
import { formatDuration } from "../format";
import type { OpenClawPluginToolContext } from "../types";

export function makeAgentOutputTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_output",
    description: "Show recent output from a coding agent session (by name or ID).",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to get output from" }),
      lines: Type.Optional(Type.Number({ description: "Number of recent lines to show (default 50)" })),
      full: Type.Optional(Type.Boolean({ description: "Show all available output" })),
    }),
    async execute(_id: string, params: any) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }

      const session = sessionManager.resolve(params.session);

      if (!session) {
        // Fall back to persisted info + /tmp output file
        const persisted = sessionManager.getPersistedSession(params.session);
        if (persisted?.outputPath && existsSync(persisted.outputPath)) {
          try {
            const fileContent = readFileSync(persisted.outputPath, "utf-8");
            const header = [
              `Session: ${persisted.name} | Status: ${persisted.status.toUpperCase()} | Cost: $${persisted.costUsd.toFixed(4)}`,
              `(retrieved from ${persisted.outputPath} — session was garbage-collected)`,
              `${"─".repeat(60)}`,
            ].join("\n");

            let output = fileContent;
            if (!params.full && fileContent) {
              const lines = fileContent.split("\n");
              output = lines.slice(-(params.lines ?? 50)).join("\n");
            }

            return { content: [{ type: "text", text: output ? `${header}\n${output}` : `${header}\n(output file was empty)` }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: `Error: Session "${params.session}" was cleaned up (expired) and output file could not be read: ${err.message}` }] };
          }
        }

        return { content: [{ type: "text", text: `Error: Session "${params.session}" not found.` }] };
      }

      const outputLines = params.full ? session.getOutput() : session.getOutput(params.lines ?? 50);
      const duration = formatDuration(session.duration);
      const costStr = ` | Cost: $${session.costUsd.toFixed(4)}`;
      const phaseStr = session.status === "running" ? ` | Phase: ${session.phase}` : "";
      const header = [
        `Session: ${session.name} [${session.id}] | Status: ${session.status.toUpperCase()}${phaseStr}${costStr} | Duration: ${duration}`,
        `${"─".repeat(60)}`,
      ].join("\n");

      if (outputLines.length === 0) {
        return { content: [{ type: "text", text: `${header}\n(no output yet)` }] };
      }

      return { content: [{ type: "text", text: `${header}\n${outputLines.join("\n")}` }] };
    },
  };
}
