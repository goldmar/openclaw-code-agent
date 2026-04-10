import { readdirSync, statSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

import { makeAgentLaunchTool } from "./src/tools/agent-launch";
import { makeAgentSessionsTool } from "./src/tools/agent-sessions";
import { makeAgentKillTool } from "./src/tools/agent-kill";
import { makeAgentOutputTool } from "./src/tools/agent-output";
import { makeAgentRespondTool } from "./src/tools/agent-respond";
import { makeAgentRequestPlanApprovalTool } from "./src/tools/agent-request-plan-approval";
import { makeAgentSendMonitorReportTool } from "./src/tools/agent-send-monitor-report";
import { makeAgentStatsTool } from "./src/tools/agent-stats";
import { makeAgentMergeTool } from "./src/tools/agent-merge";
import { makeAgentPrTool } from "./src/tools/agent-pr";
import { makeAgentWorktreeCleanupTool } from "./src/tools/agent-worktree-cleanup";
import { makeAgentWorktreeStatusTool } from "./src/tools/agent-worktree-status";
import { makeGoalLaunchTool } from "./src/tools/goal-launch";
import { makeGoalStatusTool } from "./src/tools/goal-status";
import { makeGoalStopTool } from "./src/tools/goal-stop";
import { createCallbackHandler } from "./src/callback-handler";
import { registerAgentCommand } from "./src/commands/agent";
import { registerAgentSessionsCommand } from "./src/commands/agent-sessions";
import { registerAgentKillCommand } from "./src/commands/agent-kill";
import { registerAgentRespondCommand } from "./src/commands/agent-respond";
import { registerAgentStatsCommand } from "./src/commands/agent-stats";
import { registerAgentOutputCommand } from "./src/commands/agent-output";
import { registerGoalCommand } from "./src/commands/goal";
import { registerGoalStatusCommand } from "./src/commands/goal-status";
import { registerGoalStopCommand } from "./src/commands/goal-stop";
import { GoalController } from "./src/goal-controller";
import { SessionManager } from "./src/session-manager";
import { setGoalController, setSessionManager } from "./src/singletons";
import { setPluginRuntime, setOpenClawConfig } from "./src/runtime-store";
import { setPluginConfig, pluginConfig } from "./src/config";
import { definePluginEntry, type OpenClawPluginApi, type OpenClawPluginToolContext } from "./api";

/**
 * A1 — Startup orphan cleanup: scan worktree base dir(s) for old worktrees and clean them up.
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

/** Register plugin tools, commands, and the background session service. */
export function register(api: OpenClawPluginApi): void {
  let sm: SessionManager | null = null;
  let gc: GoalController | null = null;
  const registerTool = api.registerTool as (
    tool: (ctx: OpenClawPluginToolContext) => unknown,
    options?: { optional?: boolean },
  ) => void;
  setPluginRuntime(api.runtime);
  setOpenClawConfig(api.config);

  // Tools
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentLaunchTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentSessionsTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentKillTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentOutputTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentRespondTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentRequestPlanApprovalTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentSendMonitorReportTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentStatsTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentMergeTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentPrTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentWorktreeCleanupTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeAgentWorktreeStatusTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeGoalLaunchTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeGoalStatusTool(ctx), { optional: false });
  registerTool((ctx: OpenClawPluginToolContext) => makeGoalStopTool(ctx), { optional: false });

  // Interactive handlers (shared action-token callbacks across chat transports)
  api.registerInteractiveHandler(createCallbackHandler("telegram"));
  api.registerInteractiveHandler(createCallbackHandler("discord"));

  // Commands
  registerAgentCommand(api);
  registerAgentSessionsCommand(api);
  registerAgentKillCommand(api);
  registerAgentRespondCommand(api);
  registerAgentStatsCommand(api);
  registerAgentOutputCommand(api);
  registerGoalCommand(api);
  registerGoalStatusCommand(api);
  registerGoalStopCommand(api);

  // Service
  api.registerService({
    id: "openclaw-code-agent",
    start: (ctx) => {
      const config = api.pluginConfig ?? {};
      setPluginConfig(config);
      setPluginRuntime(api.runtime);
      setOpenClawConfig(api.config);

      sm = new SessionManager(pluginConfig.maxSessions, pluginConfig.maxPersistedSessions);
      gc = new GoalController(sm);
      setSessionManager(sm);
      setGoalController(gc);
      gc.start();

      // A1: Cleanup orphaned worktrees at startup (needs sm for per-repo workdir scan)
      cleanupOrphanedWorktrees(sm);
      sm.bootstrapMaintenanceSchedules();
    },
    stop: () => {
      if (gc) gc.stop();
      if (sm) sm.killAll("shutdown");
      if (sm) sm.dispose();
      gc = null;
      sm = null;
      setPluginRuntime(undefined);
      setOpenClawConfig(undefined);
      setGoalController(null);
      setSessionManager(null);
    },
  });
}

export default definePluginEntry({
  id: "openclaw-code-agent",
  name: "OpenClaw Code Agent",
  description: "Multi-session coding-agent orchestration from OpenClaw chat",
  register,
});
