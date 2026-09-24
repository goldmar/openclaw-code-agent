import { join } from "path";
// Named import: the bundler keeps only `version`, not the whole package.json.
import { version as packageVersion } from "./package.json";

import { AutoUpdateService } from "./src/auto-update";
import { makeAgentLaunchTool } from "./src/tools/agent-launch";
import { makeAgentSessionsTool } from "./src/tools/agent-sessions";
import { makeAgentKillTool } from "./src/tools/agent-kill";
import { makeAgentOutputTool } from "./src/tools/agent-output";
import { makeAgentRespondTool } from "./src/tools/agent-respond";
import { makeAgentSessionActionTool } from "./src/tools/agent-session-action";
import { makeAgentRequestPlanApprovalTool } from "./src/tools/agent-request-plan-approval";
import { makeAgentRequestWorktreeDecisionTool } from "./src/tools/agent-request-worktree-decision";
import { makeAgentSendPlanOfferTool } from "./src/tools/agent-send-plan-offer";
import { makeAgentStatsTool } from "./src/tools/agent-stats";
import { makeAgentRepoPolicyTool } from "./src/tools/agent-repo-policy";
import { makeAgentMergeTool } from "./src/tools/agent-merge";
import { makeAgentPrTool } from "./src/tools/agent-pr";
import { makeAgentWorktreeCleanupTool } from "./src/tools/agent-worktree-cleanup";
import { makeAgentWorktreeStatusTool } from "./src/tools/agent-worktree-status";
import { makeGoalLaunchTool } from "./src/tools/goal-launch";
import { makeGoalStatusTool } from "./src/tools/goal-status";
import { makeGoalStopTool } from "./src/tools/goal-stop";
import { makeGoalEditTool } from "./src/tools/goal-edit";
import { createCallbackHandler } from "./src/callback-handler";
import { registerAgentCommand } from "./src/commands/agent";
import { registerAgentSessionsCommand } from "./src/commands/agent-sessions";
import { registerAgentKillCommand } from "./src/commands/agent-kill";
import { registerAgentRespondCommand } from "./src/commands/agent-respond";
import { registerAgentStatsCommand } from "./src/commands/agent-stats";
import { registerAgentPolicyCommand } from "./src/commands/agent-policy";
import { registerAgentOutputCommand } from "./src/commands/agent-output";
import { registerGoalCommand } from "./src/commands/goal";
import { registerGoalStatusCommand } from "./src/commands/goal-status";
import { registerGoalStopCommand } from "./src/commands/goal-stop";
import { registerGoalEditCommand } from "./src/commands/goal-edit";
import { GoalController } from "./src/goal-controller";
import { SessionManager } from "./src/session-manager";
import { setAutoUpdateService, setGoalController, setSessionManager } from "./src/singletons";
import { setPluginRuntime } from "./src/runtime-store";
import { createRuntimeWorktreeDecisionSummaryProvider } from "./src/worktree-decision-summary";
import { setPluginConfig, pluginConfig } from "./src/config";
import { resolveCodeAgentStateDir, resolveOpenClawStateDir } from "./src/state-paths";
import { routeFromOriginMetadata } from "./src/session-route";
import type { SessionRoute } from "./src/types";
import { definePluginEntry, type OpenClawPluginApi, type OpenClawPluginServiceContext, type OpenClawPluginToolContext } from "./api";

export function routeFromInteractiveContext(ctx: unknown): SessionRoute | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const record = ctx as {
    channel?: string;
    accountId?: string;
    conversationId?: string;
    parentConversationId?: string;
    threadId?: string | number;
    sessionKey?: string;
    callback?: { chatId?: string };
  };
  const channel = record.channel?.trim().toLowerCase();
  if (!channel) return undefined;
  const target = channel === "telegram"
    ? record.callback?.chatId ?? record.parentConversationId ?? record.conversationId
    : record.parentConversationId ?? record.conversationId ?? record.callback?.chatId;
  if (!target) return undefined;
  return routeFromOriginMetadata(
    record.accountId ? `${channel}|${record.accountId}|${target}` : `${channel}|${target}`,
    record.threadId,
    record.sessionKey,
  );
}

/** Register plugin tools, commands, and the background session service. */
export function register(api: OpenClawPluginApi): void {
  let sm: SessionManager | null = null;
  let gc: GoalController | null = null;
  let autoUpdate: AutoUpdateService | null = null;
  let started = false;
  let startedWithServiceContext = false;
  const registerTool = api.registerTool as (
    tool: (ctx: OpenClawPluginToolContext) => unknown,
    options?: { optional?: boolean; name?: string },
  ) => void;
  setPluginRuntime(api.runtime);

  const autoUpdateStateOptions = (ctx?: OpenClawPluginServiceContext) => {
    const openclawStateDir = ctx?.stateDir ?? resolveOpenClawStateDir(process.env);
    const stateDir = resolveCodeAgentStateDir(process.env, openclawStateDir);
    return {
      stateDir,
      legacyStatePaths: [
        join(openclawStateDir, "openclaw-code-agent-auto-update.json"),
        join(stateDir, "openclaw-code-agent-auto-update.json"),
      ],
    };
  };

  const routeFromToolContext = (ctx: OpenClawPluginToolContext): SessionRoute | undefined => {
    const delivery = ctx.deliveryContext;
    if (delivery?.channel && delivery.to) {
      return routeFromOriginMetadata(
        delivery.accountId ? `${delivery.channel}|${delivery.accountId}|${delivery.to}` : `${delivery.channel}|${delivery.to}`,
        delivery.threadId,
        ctx.sessionKey,
      );
    }
    return routeFromOriginMetadata(ctx.messageChannel, undefined, ctx.sessionKey);
  };

  const maybeCheckForAutoUpdate = (route?: SessionRoute): void => {
    autoUpdate?.maybeCheckForUpdate({ route });
  };

  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const startCodeAgentService = async (ctx?: OpenClawPluginServiceContext): Promise<void> => {
    while (stopping || starting) {
      await (stopping ?? starting);
    }
    if (started) {
      if (ctx && !startedWithServiceContext) {
        setPluginRuntime(api.runtime, ctx.config);
        startedWithServiceContext = true;
      }
      return;
    }

    starting = Promise.resolve().then(async () => {
      const config = api.pluginConfig ?? {};
      setPluginConfig(config);
      if (ctx) {
        setPluginRuntime(api.runtime, ctx.config);
        startedWithServiceContext = true;
      } else {
        setPluginRuntime(api.runtime);
        startedWithServiceContext = false;
      }

      sm = new SessionManager(pluginConfig.maxSessions, pluginConfig.maxPersistedSessions, {
        worktreeSummaryProvider: createRuntimeWorktreeDecisionSummaryProvider(),
      });
      await sm.ready;
      gc = new GoalController(sm);
      // `autoUpdate: false` disables the self-updater entirely: no update checks,
      // no installs, no Gateway restarts. When enabled, installs and restarts
      // run only after the user presses the matching update button.
      autoUpdate = pluginConfig.autoUpdate
        ? new AutoUpdateService({
            ...autoUpdateStateOptions(ctx),
            currentVersion: api.version ?? packageVersion ?? "0.0.0",
            actionButtonFactory: (sessionId, kind, label, options) =>
              sm!.makePluginActionButton(sessionId, kind, label, options),
          })
        : null;
      setSessionManager(sm);
      setGoalController(gc);
      setAutoUpdateService(autoUpdate);
      gc.start();

      // Worktree cleanup is owned by the maintenance schedules (resolved/merged
      // worktrees after their retention window) and `agent_worktree_cleanup`;
      // there is no age-based startup sweep of unmanaged worktree directories.
      // Reminder/retention deadlines need git evidence; they settle in the background.
      void sm.bootstrapMaintenanceSchedules();
      started = true;
      maybeCheckForAutoUpdate();
    });
    try {
      await starting;
    } catch (err) {
      gc?.stop();
      sm?.dispose();
      sm = null;
      gc = null;
      autoUpdate = null;
      started = false;
      startedWithServiceContext = false;
      setPluginRuntime(undefined);
      setSessionManager(null);
      setGoalController(null);
      setAutoUpdateService(null);
      throw err;
    } finally {
      starting = undefined;
    }
  };

  const stopCodeAgentService = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(async () => {
      await starting?.catch(() => {});
      if (gc) gc.stop();
      try {
        await sm?.shutdown();
      } finally {
        gc = null;
        sm = null;
        autoUpdate = null;
        started = false;
        startedWithServiceContext = false;
        setPluginRuntime(undefined);
        setGoalController(null);
        setSessionManager(null);
        setAutoUpdateService(null);
      }
    }).finally(() => {
      stopping = undefined;
    });
    return stopping;
  };

  const registerCodeAgentTool = (
    tool: (ctx: OpenClawPluginToolContext) => unknown,
    options: { optional?: boolean; name?: string },
  ): void => {
    registerTool((ctx: OpenClawPluginToolContext) => {
      const definition = tool(ctx) as {
        execute: (id: string, params: unknown) => unknown;
        [key: string]: unknown;
      };
      return {
        ...definition,
        async execute(id: string, params: unknown) {
          await startCodeAgentService();
          maybeCheckForAutoUpdate(routeFromToolContext(ctx));
          return definition.execute(id, params);
        },
      };
    }, options);
  };

  const commandApi = {
    ...api,
    registerCommand(command: Parameters<OpenClawPluginApi["registerCommand"]>[0]) {
      api.registerCommand({
        ...command,
        handler: async (ctx: Parameters<typeof command.handler>[0]) => {
          await startCodeAgentService();
          maybeCheckForAutoUpdate(routeFromToolContext(ctx as unknown as OpenClawPluginToolContext));
          return command.handler(ctx);
        },
      });
    },
  } as OpenClawPluginApi;

  const registerCodeAgentInteractiveHandler = (channel: "telegram" | "discord"): void => {
    const registration = createCallbackHandler(channel);
    api.registerInteractiveHandler({
      ...registration,
      handler: async (ctx: Parameters<typeof registration.handler>[0]) => {
        await startCodeAgentService();
        maybeCheckForAutoUpdate(routeFromInteractiveContext(ctx));
        return registration.handler(ctx);
      },
    });
  };

  // Tools
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentLaunchTool(ctx), { optional: false, name: "agent_launch" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentSessionsTool(ctx), { optional: false, name: "agent_sessions" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentKillTool(ctx), { optional: false, name: "agent_kill" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentOutputTool(ctx), { optional: false, name: "agent_output" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentRespondTool(ctx), { optional: false, name: "agent_respond" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentSessionActionTool(ctx), { optional: false, name: "agent_session_action" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentRequestPlanApprovalTool(ctx), { optional: false, name: "agent_request_plan_approval" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentRequestWorktreeDecisionTool(ctx), { optional: false, name: "agent_request_worktree_decision" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentSendPlanOfferTool(ctx), { optional: false, name: "agent_send_plan_offer" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentStatsTool(ctx), { optional: false, name: "agent_stats" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentRepoPolicyTool(ctx), { optional: false, name: "agent_repo_policy" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentMergeTool(ctx), { optional: false, name: "agent_merge" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentPrTool(ctx), { optional: false, name: "agent_pr" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentWorktreeCleanupTool(ctx), { optional: false, name: "agent_worktree_cleanup" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentWorktreeStatusTool(ctx), { optional: false, name: "agent_worktree_status" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeGoalLaunchTool(ctx), { optional: false, name: "agent_goal_launch" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeGoalStatusTool(ctx), { optional: false, name: "agent_goal_status" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeGoalStopTool(ctx), { optional: false, name: "agent_goal_stop" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeGoalEditTool(ctx), { optional: false, name: "agent_goal_edit" });

  // Interactive handlers (shared action-token callbacks across chat transports)
  registerCodeAgentInteractiveHandler("telegram");
  registerCodeAgentInteractiveHandler("discord");

  // Commands
  registerAgentCommand(commandApi);
  registerAgentSessionsCommand(commandApi);
  registerAgentKillCommand(commandApi);
  registerAgentRespondCommand(commandApi);
  registerAgentStatsCommand(commandApi);
  registerAgentPolicyCommand(commandApi);
  registerAgentOutputCommand(commandApi);
  registerGoalCommand(commandApi);
  registerGoalStatusCommand(commandApi);
  registerGoalStopCommand(commandApi);
  registerGoalEditCommand(commandApi);

  // Service
  api.registerService({
    id: "openclaw-code-agent",
    start: startCodeAgentService,
    stop: stopCodeAgentService,
  });
}

export default definePluginEntry({
  id: "openclaw-code-agent",
  name: "Code Agent",
  description: "Multi-session coding-agent orchestration from OpenClaw chat",
  register,
});
