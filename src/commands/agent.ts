import { sessionManager } from "../singletons";
import {
  pluginConfig,
} from "../config";
import { resolveSessionTaskLifecycle } from "../session-task-lifecycle";
import type { OpenClawPluginToolContext } from "../types";
import { resolveAgentLaunchRequest } from "../tools/agent-launch-resolution";
import { tokenizeCommandArgs } from "./args";

interface AgentCommandContext {
  args?: string;
  workspaceDir?: string;
  messageChannel?: string;
  agentAccountId?: string;
  requesterSenderId?: string;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  agentId?: string;
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

function parseAgentCommandArgs(raw: string): { name?: string; prompt: string } {
  const tokens = tokenizeCommandArgs(raw);
  let name: string | undefined;
  let promptTokens = tokens;
  if (tokens[0] === "--name" && tokens[1]) {
    name = tokens[1];
    promptTokens = tokens.slice(2);
  }
  return {
    name,
    prompt: promptTokens.join(" ").trim(),
  };
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

      const raw = (ctx.args ?? "").trim();
      if (!raw) return { text: "Usage: /agent [--name <name>] <prompt>" };

      const { name, prompt } = parseAgentCommandArgs(raw);
      if (!prompt) return { text: "Usage: /agent [--name <name>] <prompt>" };

      try {
        const resolution = resolveAgentLaunchRequest(
          { prompt, name },
          ctx as OpenClawPluginToolContext,
          sessionManager,
        );
        if (resolution.kind !== "resolved") {
          return { text: resolution.text };
        }

        const session = sessionManager.spawn({
          prompt,
          name,
          workdir: resolution.workdir,
          model: resolution.resolvedModel,
          reasoningEffort: resolution.reasoningEffort,
          fastMode: resolution.fastMode,
          codexApprovalPolicy: resolution.harness === "codex" ? "never" : undefined,
          originChannel: resolution.originChannel,
          originThreadId: resolution.originThreadId,
          originAgentId: ctx.agentId || undefined,
          originSessionKey: resolution.originSessionKey,
          route: resolution.route,
          harness: resolution.harness,
          permissionMode: resolution.permissionMode,
          planApproval: resolution.planApproval,
          taskLifecycle: resolveSessionTaskLifecycle(ctx as OpenClawPluginToolContext),
        });

        return { text: sessionManager.formatLaunchResult({
          prompt,
          workdir: resolution.workdir,
          harness: resolution.harness,
          permissionMode: resolution.permissionMode ?? pluginConfig.permissionMode,
          planApproval: resolution.planApproval,
        }, session) };
      } catch (err: unknown) {
        const message = errorMessage(err);
        const hint = message.includes("Max sessions") ? "" : "\n\nUse /agent_sessions to see active sessions.";
        return { text: `Error launching session: ${message}${hint}` };
      }
    },
  });
}
