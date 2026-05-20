import { goalController } from "../singletons";
import { formatGoalLaunchResult, resolveGoalLaunchRequest } from "../goal-launch-resolution";
import type { OpenClawPluginToolContext, PermissionMode, GoalLoopMode } from "../types";
import { tokenizeCommandArgs } from "./args";

const GOAL_USAGE = "Usage: /goal [--name <name>] [--workdir <dir>] [--model <model>] [--harness <name>] [--mode <ralph|verifier>] [--completion-promise <text>] [--max-iterations N] [--verify <cmd> ...] <goal>";

interface GoalCommandContext extends Partial<OpenClawPluginToolContext> {
  args?: string;
}

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: GoalCommandContext) => Promise<{ text: string }>;
  }): void;
}

export function registerGoalCommand(api: CommandApi): void {
  api.registerCommand({
    name: "goal",
    description: "Launch an explicit goal task (Ralph-style completion loop or verifier-driven loop)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: GoalCommandContext) => {
      if (!goalController) {
        return { text: "Error: GoalController not initialized. The code-agent service must be running." };
      }

      const raw = (ctx.args ?? "").trim();
      if (!raw) {
        return { text: GOAL_USAGE };
      }

      const tokens = tokenizeCommandArgs(raw);
      let name: string | undefined;
      let workdir: string | undefined;
      let model: string | undefined;
      let maxIterations: number | undefined;
      let permissionMode: PermissionMode = "bypassPermissions";
      let harness: string | undefined;
      let loopMode: GoalLoopMode | undefined;
      let completionPromise: string | undefined;
      const verifierCommands: string[] = [];
      const goalParts: string[] = [];

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === "--name" && i + 1 < tokens.length) {
          name = tokens[++i];
        } else if (token === "--workdir" && i + 1 < tokens.length) {
          workdir = tokens[++i];
        } else if (token === "--model" && i + 1 < tokens.length) {
          model = tokens[++i];
        } else if (token === "--max-iterations" && i + 1 < tokens.length) {
          const parsed = parseInt(tokens[++i], 10);
          if (!Number.isNaN(parsed) && parsed > 0) maxIterations = parsed;
        } else if (token === "--permission-mode" && i + 1 < tokens.length) {
          const mode = tokens[++i];
          if (mode === "default" || mode === "plan" || mode === "bypassPermissions") {
            permissionMode = mode;
          } else {
            return { text: `Error: Invalid permission mode "${mode}".` };
          }
        } else if (token === "--harness" && i + 1 < tokens.length) {
          harness = tokens[++i];
        } else if (token === "--mode" && i + 1 < tokens.length) {
          const mode = tokens[++i];
          if (mode === "ralph" || mode === "verifier") {
            loopMode = mode;
          } else {
            return { text: `Error: Invalid goal mode "${mode}". Use ralph or verifier.` };
          }
        } else if (token === "--completion-promise" && i + 1 < tokens.length) {
          completionPromise = tokens[++i];
        } else if (token === "--verify" && i + 1 < tokens.length) {
          const command = tokens[++i].trim();
          if (!command) {
            return { text: "Error: --verify commands must not be empty." };
          }
          verifierCommands.push(command);
        } else {
          goalParts.push(token);
        }
      }

      const goal = goalParts.join(" ").trim();
      if (!goal) {
        return { text: GOAL_USAGE };
      }

      const resolution = resolveGoalLaunchRequest({
        goal,
        verifierCommands,
        name,
        workdir,
        model,
        maxIterations,
        permissionMode,
        harness,
        goalMode: loopMode,
        completionPromise,
      }, ctx as OpenClawPluginToolContext);
      if (resolution.kind !== "resolved") {
        return { text: resolution.text };
      }

      try {
        const task = await goalController.launchTask({
          goal: resolution.goal,
          name: resolution.name,
          workdir: resolution.workdir,
          model: resolution.model,
          reasoningEffort: resolution.reasoningEffort,
          fastMode: resolution.fastMode,
          maxIterations: resolution.maxIterations,
          permissionMode: resolution.permissionMode,
          harness: resolution.harness,
          loopMode: resolution.loopMode,
          completionPromise: resolution.completionPromise,
          originChannel: resolution.originChannel,
          originThreadId: resolution.originThreadId,
          originAgentId: resolution.originAgentId,
          originSessionKey: resolution.originSessionKey,
          route: resolution.route,
          verifierCommands: resolution.verifierCommands,
        });

        return { text: formatGoalLaunchResult(task, resolution) };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: `Error launching goal task: ${message}` };
      }
    },
  });
}
