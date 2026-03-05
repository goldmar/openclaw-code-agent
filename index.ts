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
import { setSessionManager } from "./src/singletons";
import { setPluginConfig, pluginConfig } from "./src/config";
import type { OpenClawPluginToolContext, PluginConfig } from "./src/types";

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
    start: (ctx: { config?: unknown; logger?: { warn: (message: string) => void; error: (message: string) => void } }) => void;
    stop: (ctx: { config?: unknown; logger?: { warn: (message: string) => void; error: (message: string) => void } }) => void;
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
  runtime?: unknown;
}

/** Register plugin tools, commands, and the background session service. */
export function register(api: OpenClawPluginApi): void {
  let sm: SessionManager | null = null;
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
    start: (ctx) => {
      const config = api.pluginConfig ?? api.getConfig?.() ?? {};
      setPluginConfig(config);

      sm = new SessionManager(pluginConfig.maxSessions, pluginConfig.maxPersistedSessions);
      setSessionManager(sm);

      cleanupInterval = setInterval(() => sm!.cleanup(), 5 * 60 * 1000);
    },
    stop: () => {
      if (sm) sm.killAll("shutdown");
      if (cleanupInterval) clearInterval(cleanupInterval);
      cleanupInterval = null;
      sm = null;
      setSessionManager(null);
    },
  });
}
