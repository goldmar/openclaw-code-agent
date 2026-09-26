import { sessionManager } from "../singletons";
import { formatHarnessModelLabel } from "../session-display";
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
    handler: (ctx: AgentCommandContext) => Promise<{ text: string }>;
  }): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const AGENT_USAGE = "Usage: /agent [--name <name>] [--workdir <dir>] [--harness <claude-code|codex|opencode>] [--model <model>] <prompt>";

/** `--name`, `--workdir`, `--harness` and `--model` before the prompt (N45). */
export function parseAgentCommandArgs(raw: string): { name?: string; workdir?: string; harness?: string; model?: string; prompt: string } {
  const tokens = tokenizeCommandArgs(raw);
  const flags: Record<string, string | undefined> = {};
  let index = 0;
  while (index < tokens.length) {
    const flag = tokens[index];
    const key = flag === "--name" ? "name" : flag === "--workdir" ? "workdir" : flag === "--harness" ? "harness" : flag === "--model" ? "model" : undefined;
    if (!key || tokens[index + 1] === undefined) break;
    flags[key] = tokens[index + 1];
    index += 2;
  }
  return {
    name: flags.name,
    workdir: flags.workdir,
    harness: flags.harness,
    model: flags.model,
    prompt: tokens.slice(index).join(" ").trim(),
  };
}

/** Register `/agent` chat command. */
export function registerAgentCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent",
    description: "Launch a coding agent session. Usage: /agent [--name <name>] [--workdir <dir>] [--harness <name>] [--model <model>] <prompt>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: AgentCommandContext) => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      const raw = (ctx.args ?? "").trim();
      if (!raw) return { text: AGENT_USAGE };

      const { name, workdir, harness, model, prompt } = parseAgentCommandArgs(raw);
      if (!prompt) return { text: AGENT_USAGE };

      try {
        const resolution = resolveAgentLaunchRequest(
          { prompt, name, workdir, harness, model },
          ctx as OpenClawPluginToolContext,
          sessionManager,
        );
        if (resolution.kind !== "resolved") {
          return { text: resolution.text };
        }

        const session = await sessionManager.launchSession({
          prompt,
          name,
          workdir: resolution.workdir,
          model: resolution.resolvedModel,
          reasoningEffort: resolution.reasoningEffort,
          fastMode: resolution.fastMode,
          originChannel: resolution.originChannel,
          originThreadId: resolution.originThreadId,
          originAgentId: ctx.agentId || undefined,
          originSessionKey: resolution.originSessionKey,
          route: resolution.route,
          harness: resolution.harness,
          permissionMode: resolution.permissionMode,
          planApproval: resolution.planApproval,
          taskLifecycle: resolveSessionTaskLifecycle(ctx as OpenClawPluginToolContext),
        }, { notifyLaunch: false });

        // One message: this reply replaces the separate 🚀 launch notice (N45).
        const harnessLabel = formatHarnessModelLabel({
          harness: session.harnessName,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
        }) ?? resolution.harness;
        return { text: `🚀 [${session.name}] Launched | ${session.worktreePath ?? resolution.workdir} | ${harnessLabel}\nFollow it with /agent_output ${session.name} or /agent_status.` };
      } catch (err: unknown) {
        const message = errorMessage(err);
        const hint = message.includes("Max sessions") ? "" : "\n\nUse /agent_sessions to see active sessions.";
        return { text: `Error launching session: ${message}${hint}` };
      }
    },
  });
}
