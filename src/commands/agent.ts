import { sessionManager } from "../singletons";
import {
  getDefaultHarnessName,
  pluginConfig,
  resolveApprovalPolicyForHarness,
  resolveDefaultModelForHarness,
  resolveOriginChannel,
  resolveOriginThreadId,
  resolveReasoningEffortForHarness,
} from "../config";

interface AgentCommandContext {
  args?: string;
  id?: string | number;
  channel?: string;
  chatId?: string | number;
  senderId?: string | number;
  channelId?: string;
  messageThreadId?: string | number;
}

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: AgentCommandContext) => { text: string };
  }): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Register `/agent` chat command. */
export function registerAgentCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent",
    description: "Launch a coding agent session. Usage: /agent [--name <name>] <prompt>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: AgentCommandContext) => {
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
        const harness = getDefaultHarnessName();
        const defaultModel = resolveDefaultModelForHarness(harness);
        if (!defaultModel) {
          return {
            text: `Error: No default model configured for harness "${harness}". Set plugins.entries["openclaw-code-agent"].config.harnesses.${harness}.defaultModel or pass model explicitly via agent_launch.`,
          };
        }

        const session = sessionManager.spawn({
          prompt,
          name,
          workdir: pluginConfig.defaultWorkdir || process.cwd(),
          model: defaultModel,
          reasoningEffort: resolveReasoningEffortForHarness(harness),
          codexApprovalPolicy: harness === "codex"
            ? (resolveApprovalPolicyForHarness(harness) ?? pluginConfig.codexApprovalPolicy)
            : undefined,
          originChannel: resolveOriginChannel(ctx),
          originThreadId: resolveOriginThreadId(ctx),
          harness,
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
      } catch (err: unknown) {
        const message = errorMessage(err);
        const hint = message.includes("Max sessions") ? "" : "\n\nUse /agent_sessions to see active sessions.";
        return { text: `Error launching session: ${message}${hint}` };
      }
    },
  });
}
