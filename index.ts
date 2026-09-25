import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
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
import { getPluginRuntime, setPluginRuntime } from "./src/runtime-store";
import {
  acquireSharedRuntime,
  allocateRuntimeOwnerSequence,
  getSharedRuntime,
  releaseSharedRuntime,
  updateSharedRuntimeOwnerHandles,
  type RuntimeHostHandles,
  type RuntimeServices,
} from "./src/process-runtime";
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

/**
 * Identity of this build: package version plus a digest of the entry module.
 * Every captured copy of one build shares it; a hot-reloaded build differs even
 * when the version label did not change.
 */
function resolveBuildId(): string {
  try {
    const digest = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
    return `${packageVersion ?? "0.0.0"}+${digest.slice(0, 16)}`;
  } catch {
    return `${packageVersion ?? "0.0.0"}+unknown`;
  }
}

const BUILD_ID = resolveBuildId();

type CodeAgentServices = {
  sm: SessionManager;
  gc: GoalController;
  autoUpdate: AutoUpdateService | null;
};

/**
 * True while this module graph's runtime store is driven by the shared runtime
 * (this graph created it). Registration must then not overwrite the handles the
 * shared runtime selected.
 */
let hostBoundBySharedRuntime = false;

/**
 * Services of the shared runtime when this module graph created it. The
 * runtime's own code (for example the automatic PR and merge paths, which call
 * the tool implementations of this graph) reads this graph's singletons, so
 * they keep pointing at the runtime until it stops, even after this graph's
 * own registration detached.
 */
let servicesCreatedHere: CodeAgentServices | null = null;

/** Stable identity of plugin settings: key order does not matter. */
function stableConfigKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableConfigKey).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableConfigKey(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Register plugin tools, commands, and the background session service.
 *
 * OpenClaw may call this once per plugin registry, each time in its own module
 * graph. Every registration is an owner of the one process-wide runtime in
 * `src/process-runtime.ts`: tools, commands, interactive handlers, and the
 * service all attach to it, so there is exactly one SessionManager per process.
 */
export function register(api: OpenClawPluginApi): void {
  const regSeq = allocateRuntimeOwnerSequence(BUILD_ID);
  const ownerId = `${BUILD_ID.split("+")[1]?.slice(0, 8) ?? "build"}#${regSeq}`;
  let sm: SessionManager | null = null;
  let gc: GoalController | null = null;
  let autoUpdate: AutoUpdateService | null = null;
  let attached = false;
  let retired = false;
  let serviceContext: OpenClawPluginServiceContext | undefined;
  const registerTool = api.registerTool as (
    tool: (ctx: OpenClawPluginToolContext) => unknown,
    options?: { optional?: boolean; name?: string },
  ) => void;
  if (!hostBoundBySharedRuntime) setPluginRuntime(api.runtime);

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

  const ownerHandles = (): RuntimeHostHandles => ({
    runtime: api.runtime,
    runtimeConfig: serviceContext?.config,
    hasRuntimeConfig: serviceContext != null,
    pluginConfig: api.pluginConfig ?? {},
  });

  /** Point this graph's config and runtime store at the given owner's handles. */
  const bindLocalHost = (handles: RuntimeHostHandles | undefined): void => {
    // Reset first so a switch without service config reloads it from the new runtime.
    setPluginRuntime(undefined);
    hostBoundBySharedRuntime = handles != null;
    if (!handles) return;
    setPluginConfig(handles.pluginConfig);
    if (handles.hasRuntimeConfig) setPluginRuntime(handles.runtime, handles.runtimeConfig);
    else setPluginRuntime(handles.runtime);
  };

  const detachLocal = (): void => {
    sm = null;
    gc = null;
    autoUpdate = null;
    attached = false;
    setSessionManager(servicesCreatedHere?.sm ?? null);
    setGoalController(servicesCreatedHere?.gc ?? null);
    setAutoUpdateService(servicesCreatedHere?.autoUpdate ?? null);
  };

  const createServices = async (handles: RuntimeHostHandles, instanceId: string): Promise<RuntimeServices<CodeAgentServices>> => {
    bindLocalHost(handles);
    try {
      const createdSm = new SessionManager(pluginConfig.maxSessions, pluginConfig.maxPersistedSessions, {
        worktreeSummaryProvider: createRuntimeWorktreeDecisionSummaryProvider(),
        store: { instanceId: `${instanceId}/${BUILD_ID}` },
      });
      try {
        await createdSm.ready;
      } catch (err) {
        createdSm.dispose();
        throw err;
      }
      const createdGc = new GoalController(createdSm);
      // `autoUpdate: false` disables the self-updater entirely: no update checks,
      // no installs, no Gateway restarts. When enabled, installs and restarts
      // run only after the user presses the matching update button.
      const createdAutoUpdate = pluginConfig.autoUpdate
        ? new AutoUpdateService({
            ...autoUpdateStateOptions(serviceContext),
            currentVersion: api.version ?? packageVersion ?? "0.0.0",
            actionButtonFactory: (sessionId, kind, label, options) =>
              createdSm.makePluginActionButton(sessionId, kind, label, options),
          })
        : null;
      createdGc.start();
      // Worktree cleanup is owned by the maintenance schedules (resolved/merged
      // worktrees after their retention window) and `agent_worktree_cleanup`;
      // there is no age-based startup sweep of unmanaged worktree directories.
      // Reminder/retention deadlines need git evidence; they settle in the background.
      void createdSm.bootstrapMaintenanceSchedules();
      const services: CodeAgentServices = { sm: createdSm, gc: createdGc, autoUpdate: createdAutoUpdate };
      servicesCreatedHere = services;
      return {
        services,
        bindHost: bindLocalHost,
        stop: async () => {
          createdGc.stop();
          try {
            await createdSm.shutdown();
          } finally {
            if (servicesCreatedHere === services) {
              servicesCreatedHere = null;
              setSessionManager(null);
              setGoalController(null);
              setAutoUpdateService(null);
            }
          }
        },
      };
    } catch (err) {
      bindLocalHost(undefined);
      throw err;
    }
  };

  const startCodeAgentService = async (ctx?: OpenClawPluginServiceContext): Promise<void> => {
    while (stopping || starting) {
      await (stopping ?? starting);
    }
    if (retired) {
      throw new Error("This OpenClaw Code Agent plugin instance was retired by the host.");
    }
    const contextChanged = ctx != null && ctx !== serviceContext;
    if (ctx) serviceContext = ctx;
    if (attached && getSharedRuntime()?.owners.has(ownerId)) {
      if (contextChanged) {
        updateSharedRuntimeOwnerHandles(ownerId, ownerHandles());
        if (!hostBoundBySharedRuntime) setPluginRuntime(api.runtime, serviceContext?.config);
      }
      return;
    }

    starting = (async () => {
      const runtime = await acquireSharedRuntime<CodeAgentServices>({
        id: ownerId,
        regSeq,
        buildId: BUILD_ID,
        configKey: stableConfigKey(api.pluginConfig ?? {}),
        handles: ownerHandles(),
        onDetached: detachLocal,
      }, createServices);
      // A graph that did not create the runtime still runs its own tool and
      // command code; give that code this live instance's handles.
      if (runtime.bindHost !== bindLocalHost && !hostBoundBySharedRuntime) {
        setPluginConfig(api.pluginConfig ?? {});
        if (serviceContext) setPluginRuntime(api.runtime, serviceContext.config);
        else if (!getPluginRuntime()) setPluginRuntime(api.runtime);
      }
      ({ sm, gc, autoUpdate } = runtime.services);
      attached = true;
      setSessionManager(sm);
      setGoalController(gc);
      setAutoUpdateService(autoUpdate);
      maybeCheckForAutoUpdate();
    })();
    try {
      await starting;
    } catch (err) {
      detachLocal();
      throw err;
    } finally {
      starting = undefined;
    }
  };

  const stopCodeAgentService = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      await starting?.catch(() => {});
      try {
        // The last owner drains the runtime here; singletons keep pointing at it
        // until the drain finishes, as a single-registry stop always did.
        await releaseSharedRuntime(ownerId);
      } finally {
        detachLocal();
        if (!hostBoundBySharedRuntime) setPluginRuntime(undefined);
      }
    })().finally(() => {
      stopping = undefined;
    });
    return stopping;
  };

  // A retired instance detaches immediately and never re-attaches; its handles
  // stop being used as soon as the runtime switches to another live owner.
  const retire = (): Promise<void> => {
    retired = true;
    return stopCodeAgentService();
  };
  api.lifecycle?.onDispose?.(retire);
  api.lifecycle?.signal?.addEventListener("abort", () => { void retire(); }, { once: true });

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
