import { goalController, sessionManager } from "../singletons";
import { formatGoalLaunchResult, resolveGoalLaunchRequest } from "../goal-launch-resolution";
import {
  GOAL_CONTROLLER_MISSING_MESSAGE,
  renderGoalEditResult,
  renderGoalStatus,
  renderGoalStopResult,
} from "../application/goal-view";
import type { OpenClawPluginToolContext, PermissionMode, GoalLoopMode } from "../types";
import { consumeFirstCommandArg, tokenizeCommandArgs } from "./args";

const GOAL_USAGE = [
  "Usage:",
  "/agent_goal [launch] [--name <name>] [--workdir <dir>] [--model <model>] [--harness <name>] [--mode <ralph|verifier>] [--completion-promise <text>] [--max-iterations N (max 25)] [--max-cost-usd N] [--permission-mode <default|plan|bypassPermissions>] [--verify <cmd> ...] <goal>",
  "/agent_goal status [<task>]",
  "/agent_goal stop <task>",
  "/agent_goal edit <task> <new goal>",
].join("\n");

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
    name: "agent_goal",
    description: "Goal loops: /agent_goal <goal> launches; /agent_goal status|stop|edit <task> manage one",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: GoalCommandContext) => {
      if (!goalController) {
        return { text: GOAL_CONTROLLER_MISSING_MESSAGE };
      }

      let raw = (ctx.args ?? "").trim();
      if (!raw) {
        return { text: GOAL_USAGE };
      }

      const first = consumeFirstCommandArg(raw);
      const subcommand = first?.value.toLowerCase();
      if (subcommand === "status") {
        return { text: renderGoalStatus(goalController, (sessionId) => sessionManager?.resolve(sessionId), first!.rest) };
      }
      if (subcommand === "stop") {
        const ref = first!.rest.trim();
        if (!ref) return { text: "Usage: /agent_goal stop <task>" };
        return { text: renderGoalStopResult(goalController.stopTask(ref), ref) };
      }
      if (subcommand === "edit") {
        const target = consumeFirstCommandArg(first!.rest);
        const ref = target?.value.trim();
        const replacementGoal = target?.rest.trim();
        if (!ref || !replacementGoal) return { text: "Usage: /agent_goal edit <task> <new goal>" };
        return { text: renderGoalEditResult(goalController.editTask(ref, replacementGoal), ref) };
      }
      if (subcommand === "launch") {
        raw = first!.rest.trim();
        if (!raw) return { text: GOAL_USAGE };
      }

      const tokens = tokenizeCommandArgs(raw);
      let name: string | undefined;
      let workdir: string | undefined;
      let model: string | undefined;
      let maxIterations: number | undefined;
      let maxCostUsd: number | undefined;
      // Unset follows the configured permissionMode (default plan): the first
      // iteration's plan goes through the normal plan gate.
      let permissionMode: PermissionMode | undefined;
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
        } else if (token === "--max-cost-usd" && i + 1 < tokens.length) {
          const parsed = Number.parseFloat(tokens[++i]);
          if (!Number.isFinite(parsed) || parsed <= 0) return { text: "Error: --max-cost-usd must be a positive number." };
          maxCostUsd = parsed;
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
        maxCostUsd,
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
          maxCostUsd: resolution.maxCostUsd,
          // The user typed these commands themselves: no extra confirmation.
          requireVerifierConfirmation: false,
        });

        return { text: formatGoalLaunchResult(task, { ...resolution, maxIterations }) };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: `Error launching goal task: ${message}` };
      }
    },
  });
}
