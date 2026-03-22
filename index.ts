import { readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { makeAgentLaunchTool } from "./src/tools/agent-launch";
import { makeAgentSessionsTool } from "./src/tools/agent-sessions";
import { makeAgentKillTool } from "./src/tools/agent-kill";
import { makeAgentOutputTool } from "./src/tools/agent-output";
import { makeAgentRespondTool } from "./src/tools/agent-respond";
import { makeAgentStatsTool } from "./src/tools/agent-stats";
import { makeAgentMergeTool } from "./src/tools/agent-merge";
import { makeAgentPrTool } from "./src/tools/agent-pr";
import { makeAgentWorktreeCleanupTool } from "./src/tools/agent-worktree-cleanup";
import { makeAgentWorktreeStatusTool } from "./src/tools/agent-worktree-status";
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

/**
 * A1 — Startup orphan cleanup: scan worktree base dir for old worktrees and clean them up.
 * For each dir matching openclaw-worktree-* older than the cleanup age:
 * - Use rmSync directly (orphaned worktrees are already detached, no git cleanup needed)
 */
function cleanupOrphanedWorktrees(): void {
  const baseDir = process.env.OPENCLAW_WORKTREE_DIR ?? tmpdir();
  const cleanupAgeHours = parseInt(process.env.OPENCLAW_WORKTREE_CLEANUP_AGE_HOURS ?? "1", 10) || 1;
  const cleanupAgeMs = cleanupAgeHours * 60 * 60 * 1000;
  const cutoffTime = Date.now() - cleanupAgeMs;
  let removed = 0;

  try {
    const entries = readdirSync(baseDir);
    for (const entry of entries) {
      if (!entry.startsWith("openclaw-worktree-")) continue;

      const fullPath = join(baseDir, entry);
      try {
        const stats = statSync(fullPath);
        if (!stats.isDirectory()) continue;
        if (stats.mtimeMs > cutoffTime) continue;

        // Orphaned worktrees are already detached — just rmSync directly
        rmSync(fullPath, { recursive: true, force: true });
        removed++;
      } catch (err) {
        // Best effort, skip this one
        console.warn(`[index] Failed to clean up orphaned worktree ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (removed > 0) {
      console.info(`[index] Cleaned up ${removed} orphaned worktree(s) at startup (age > ${cleanupAgeHours}h)`);
    }
  } catch (err) {
    console.warn(`[index] Failed to scan for orphaned worktrees: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentMergeTool(ctx), { optional: false });
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentPrTool(ctx), { optional: false });
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentWorktreeCleanupTool(ctx), { optional: false });
  api.registerTool((ctx: OpenClawPluginToolContext) => makeAgentWorktreeStatusTool(ctx), { optional: false });

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

      // A1: Cleanup orphaned worktrees at startup
      cleanupOrphanedWorktrees();

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
