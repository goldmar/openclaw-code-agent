import { readdirSync, statSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import packageJson from "./package.json";

import { AutoUpdateService } from "./src/auto-update";
import { makeAgentLaunchTool } from "./src/tools/agent-launch";
import { makeAgentSessionsTool } from "./src/tools/agent-sessions";
import { makeAgentKillTool } from "./src/tools/agent-kill";
import { makeAgentOutputTool } from "./src/tools/agent-output";
import { makeAgentRespondTool } from "./src/tools/agent-respond";
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
import { resolveOpenclawHomeDir } from "./src/openclaw-paths";
import { routeFromOriginMetadata } from "./src/session-route";
import type { SessionRoute } from "./src/types";
import { definePluginEntry, type OpenClawPluginApi, type OpenClawPluginServiceContext, type OpenClawPluginToolContext } from "./api";

/**
 * Startup orphan cleanup: scan worktree base dir(s) for old worktrees and clean them up.
 * For each dir matching openclaw-worktree-* older than the cleanup age:
 * - Use rmSync directly (orphaned worktrees are already detached, no git cleanup needed)
 *
 * Base dir resolution priority:
 * 1. OPENCLAW_WORKTREE_DIR env var or pluginConfig.worktreeDir (single fixed dir)
 * 2. When no fixed dir is configured, derive <repoRoot>/.worktrees for each unique repo
 *    root found in persisted session workdirs — so cleanup works without any explicit config.
 */
function cleanupOrphanedWorktrees(sm: SessionManager): void {
  const cleanupAgeHours = parseInt(process.env.OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS ?? "168", 10) || 168;
  const cleanupAgeMs = cleanupAgeHours * 60 * 60 * 1000;
  const cutoffTime = Date.now() - cleanupAgeMs;
  const managedWorktrees = new Set(
    sm.listPersistedSessions()
      .map((session) => session.worktreePath)
      .filter((path): path is string => typeof path === "string" && path.length > 0),
  );

  // Build the set of base dirs to scan
  const dirsToScan = new Set<string>();

  const fixedBaseDir = process.env.OPENCLAW_WORKTREE_DIR ?? pluginConfig.worktreeDir;
  if (fixedBaseDir) {
    dirsToScan.add(fixedBaseDir);
  } else {
    // No fixed dir — collect unique repo roots from persisted session workdirs
    for (const session of sm.listPersistedSessions()) {
      if (!session.workdir) continue;
      try {
        const root = execFileSync(
          "git", ["rev-parse", "--show-toplevel"],
          { cwd: session.workdir, timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
        if (root) dirsToScan.add(join(root, ".worktrees"));
      } catch {
        // workdir may no longer exist or not be a git repo — skip
      }
    }
  }

  if (dirsToScan.size === 0) return;

  let removed = 0;
  for (const baseDir of dirsToScan) {
    try {
      const entries = readdirSync(baseDir);
      for (const entry of entries) {
        if (!entry.startsWith("openclaw-worktree-")) continue;

        const fullPath = join(baseDir, entry);
        try {
          const stats = statSync(fullPath);
          if (!stats.isDirectory()) continue;
          if (stats.mtimeMs > cutoffTime) continue;
          if (managedWorktrees.has(fullPath)) continue;

          // Only delete unmanaged old worktrees.
          rmSync(fullPath, { recursive: true, force: true });
          removed++;
        } catch (err) {
          // Best effort, skip this one
          console.warn(`[index] Failed to clean up orphaned worktree ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch {
      // baseDir doesn't exist yet (no worktrees ever created here) — skip silently
    }
  }

  if (removed > 0) {
    console.info(`[index] Cleaned up ${removed} orphaned worktree(s) at startup (age > ${cleanupAgeHours}h)`);
  }
}

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

  const defaultStateDir = (): string => join(resolveOpenclawHomeDir(process.env), "plugin-state", "openclaw-code-agent");

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

  const startCodeAgentService = (ctx?: OpenClawPluginServiceContext): void => {
    if (started) {
      if (ctx && !startedWithServiceContext) {
        setPluginRuntime(api.runtime, ctx.config);
        startedWithServiceContext = true;
      }
      return;
    }

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
    gc = new GoalController(sm);
    autoUpdate = new AutoUpdateService({
      stateDir: ctx?.stateDir ?? defaultStateDir(),
      currentVersion: api.version ?? (packageJson as { version?: string }).version ?? "0.0.0",
      actionButtonFactory: (sessionId, kind, label, options) =>
        sm!.makePluginActionButton(sessionId, kind, label, options),
    });
    setSessionManager(sm);
    setGoalController(gc);
    setAutoUpdateService(autoUpdate);
    gc.start();

    cleanupOrphanedWorktrees(sm);
    sm.bootstrapMaintenanceSchedules();
    started = true;
    maybeCheckForAutoUpdate();
  };

  const stopCodeAgentService = (): void => {
    if (gc) gc.stop();
    if (sm) sm.killAll("shutdown");
    if (sm) sm.dispose();
    gc = null;
    sm = null;
    autoUpdate = null;
    started = false;
    startedWithServiceContext = false;
    setPluginRuntime(undefined);
    setGoalController(null);
    setSessionManager(null);
    setAutoUpdateService(null);
  };

  const registerCodeAgentTool = (
    tool: (ctx: OpenClawPluginToolContext) => unknown,
    options: { optional?: boolean; name?: string },
  ): void => {
    registerTool((ctx: OpenClawPluginToolContext) => {
      startCodeAgentService();
      maybeCheckForAutoUpdate(routeFromToolContext(ctx));
      return tool(ctx);
    }, options);
  };

  const commandApi = {
    ...api,
    registerCommand(command: Parameters<OpenClawPluginApi["registerCommand"]>[0]) {
      api.registerCommand({
        ...command,
        handler: (ctx: Parameters<typeof command.handler>[0]) => {
          startCodeAgentService();
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
        startCodeAgentService();
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
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentRequestPlanApprovalTool(ctx), { optional: false, name: "agent_request_plan_approval" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentRequestWorktreeDecisionTool(ctx), { optional: false, name: "agent_request_worktree_decision" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentSendPlanOfferTool(ctx), { optional: false, name: "agent_send_plan_offer" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentStatsTool(ctx), { optional: false, name: "agent_stats" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentRepoPolicyTool(ctx), { optional: false, name: "agent_repo_policy" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentMergeTool(ctx), { optional: false, name: "agent_merge" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentPrTool(ctx), { optional: false, name: "agent_pr" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentWorktreeCleanupTool(ctx), { optional: false, name: "agent_worktree_cleanup" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeAgentWorktreeStatusTool(ctx), { optional: false, name: "agent_worktree_status" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeGoalLaunchTool(ctx), { optional: false, name: "goal_launch" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeGoalStatusTool(ctx), { optional: false, name: "goal_status" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeGoalStopTool(ctx), { optional: false, name: "goal_stop" });
  registerCodeAgentTool((ctx: OpenClawPluginToolContext) => makeGoalEditTool(ctx), { optional: false, name: "goal_edit" });

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
  name: "OpenClaw Code Agent",
  description: "Multi-session coding-agent orchestration from OpenClaw chat",
  register,
});
