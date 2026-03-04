import { makeAgentLaunchTool } from "./src/tools/agent-launch";
import { makeAgentSessionsTool } from "./src/tools/agent-sessions";
import { makeAgentKillTool } from "./src/tools/agent-kill";
import { makeAgentOutputTool } from "./src/tools/agent-output";
import { makeAgentRespondTool } from "./src/tools/agent-respond";
import { makeAgentStatsTool } from "./src/tools/agent-stats";
import { registerAgentCommand } from "./src/commands/agent";
import { registerAgentSessionsCommand } from "./src/commands/agent-sessions";
import { registerAgentKillCommand } from "./src/commands/agent-kill";
import { registerAgentResumeCommand } from "./src/commands/agent-resume";
import { registerAgentRespondCommand } from "./src/commands/agent-respond";
import { registerAgentStatsCommand } from "./src/commands/agent-stats";
import { registerAgentOutputCommand } from "./src/commands/agent-output";
import { SessionManager } from "./src/session-manager";
import { NotificationService } from "./src/notifications";
import { setSessionManager, setNotificationService } from "./src/singletons";
import { setPluginConfig, pluginConfig } from "./src/config";
import type { OpenClawPluginToolContext, PluginConfig } from "./src/types";
import { execFile } from "child_process";

interface OpenClawCommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (...args: unknown[]) => unknown;
  }): void;
}

interface OpenClawServiceApi {
  registerService(config: {
    id: string;
    start: () => void;
    stop: () => void;
  }): void;
}

interface OpenClawToolApi {
  registerTool(
    factory: (ctx: OpenClawPluginToolContext) => unknown,
    options?: { optional?: boolean },
  ): void;
}

interface OpenClawPluginApi extends OpenClawCommandApi, OpenClawServiceApi, OpenClawToolApi {
  pluginConfig?: Partial<PluginConfig>;
  getConfig?: () => Partial<PluginConfig> | undefined;
}

/** Register plugin tools, commands, and the background session service. */
export function register(api: OpenClawPluginApi): void {
  let sm: SessionManager | null = null;
  let ns: NotificationService | null = null;
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // Tools
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentLaunchTool(ctx), { optional: false });
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentSessionsTool(ctx), { optional: false });
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentKillTool(ctx), { optional: false });
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentOutputTool(ctx), { optional: false });
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentRespondTool(ctx), { optional: false });
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentStatsTool(ctx), { optional: false });

  // Commands
  registerAgentCommand(api);
  registerAgentSessionsCommand(api);
  registerAgentKillCommand(api);
  registerAgentResumeCommand(api);
  registerAgentRespondCommand(api);
  registerAgentStatsCommand(api);
  registerAgentOutputCommand(api);

  // Service
  api.registerService({
    id: "openclaw-code-agent",
    start: () => {
      const config = api.pluginConfig ?? api.getConfig?.() ?? {};
      setPluginConfig(config);

      sm = new SessionManager(pluginConfig.maxSessions, pluginConfig.maxPersistedSessions);
      setSessionManager(sm);

      const sendMessage = (channelId: string, text: string, threadId?: string | number) => {
        let fallbackChannel = "telegram";
        let fallbackTarget = "";
        let fallbackAccount: string | undefined;
        if (pluginConfig.fallbackChannel?.includes("|")) {
          const fbParts = pluginConfig.fallbackChannel.split("|");
          if (fbParts.length >= 3 && fbParts[0] && fbParts[1]) {
            fallbackChannel = fbParts[0];
            fallbackAccount = fbParts[1];
            fallbackTarget = fbParts.slice(2).join("|");
          } else if (fbParts[0] && fbParts[1]) {
            fallbackChannel = fbParts[0];
            fallbackTarget = fbParts[1];
          }
        }

        let channel = fallbackChannel;
        let target = fallbackTarget;
        let account: string | undefined = fallbackAccount;

        if (channelId === "unknown" || !channelId) {
          if (!fallbackTarget) {
            console.warn(`[code-agent] sendMessage: channelId="${channelId}" and no fallbackChannel configured`);
            return;
          }
        } else if (channelId.includes("|")) {
          const parts = channelId.split("|");
          if (parts.length >= 3) {
            channel = parts[0];
            account = parts[1];
            target = parts.slice(2).join("|");
          } else if (parts[0] && parts[1]) {
            channel = parts[0];
            target = parts[1];
          }
        } else if (/^-?\d+$/.test(channelId)) {
          channel = "telegram";
          target = channelId;
        } else if (fallbackTarget) {
          // Use fallback
        } else {
          console.warn(`[code-agent] sendMessage: unrecognized channelId="${channelId}" and no fallbackChannel configured`);
          return;
        }

        const cliArgs = ["message", "send", "--channel", channel];
        if (account) cliArgs.push("--account", account);
        cliArgs.push("--target", target, "-m", text);
        if (threadId != null) cliArgs.push("--thread-id", String(threadId));

        execFile("openclaw", cliArgs, { timeout: 15_000 }, (err, _stdout, stderr) => {
          if (err) {
            console.error(`[code-agent] sendMessage CLI ERROR: ${err.message}`);
            if (stderr) console.error(`[code-agent] sendMessage CLI STDERR: ${stderr}`);
          }
        });
      };

      ns = new NotificationService(sendMessage);
      setNotificationService(ns);
      sm.notifications = ns;

      cleanupInterval = setInterval(() => sm!.cleanup(), 5 * 60 * 1000);
    },
    stop: () => {
      if (ns) ns.stop();
      if (sm) sm.killAll();
      if (cleanupInterval) clearInterval(cleanupInterval);
      cleanupInterval = null;
      sm = null;
      ns = null;
      setSessionManager(null);
      setNotificationService(null);
    },
  });
}
