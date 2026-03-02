import { sessionManager } from "../singletons";
import { pluginConfig, resolveOriginChannel, resolveOriginThreadId } from "../config";

export function registerAgentCommand(api: any): void {
  api.registerCommand({
    name: "agent",
    description: "Launch a coding agent session. Usage: /agent [--name <name>] <prompt>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      let args = (ctx.args ?? "").trim();
      if (!args) return { text: "Usage: /agent [--name <name>] <prompt>" };

      let name: string | undefined;
      const nameMatch = args.match(/^--name\s+(\S+)\s+/);
      if (nameMatch) {
        name = nameMatch[1];
        args = args.slice(nameMatch[0].length).trim();
      }

      const prompt = args;
      if (!prompt) return { text: "Usage: /agent [--name <name>] <prompt>" };

      try {
        const session = sessionManager.spawn({
          prompt,
          name,
          workdir: pluginConfig.defaultWorkdir || process.cwd(),
          model: pluginConfig.defaultModel,
          originChannel: resolveOriginChannel(ctx),
          originThreadId: resolveOriginThreadId(ctx),
        });

        const promptSummary = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
        return {
          text: [
            `Session launched.`,
            `  Name: ${session.name}`,
            `  ID: ${session.id}`,
            `  Prompt: "${promptSummary}"`,
            `  Status: ${session.status}`,
          ].join("\n"),
        };
      } catch (err: any) {
        const hint = err.message.includes("Max sessions") ? "" : "\n\nUse /agent_sessions to see active sessions.";
        return { text: `Error launching session: ${err.message}${hint}` };
      }
    },
  });
}
