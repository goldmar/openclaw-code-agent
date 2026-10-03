import { goalController, sessionManager } from "../singletons";
import { resolveGoalLaunchRequest } from "../goal-launch-resolution";
import { renderGoalStatus } from "../application/goal-view";
import { isCommandInRouteChat } from "../config";
import type { GoalReplyNotice } from "../goal-controller";
import type { GoalTaskState, OpenClawPluginToolContext, PermissionMode, GoalLoopMode } from "../types";
import { consumeFirstCommandArg, SERVICE_NOT_RUNNING, tokenizeCommandArgs } from "./args";

const GOAL_USAGE = [
  "Operator-required verifiers apply in both modes. Omit --verify to use the complete configured suite.",
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
        return { text: SERVICE_NOT_RUNNING };
      }

      let raw = (ctx.args ?? "").trim();
      if (!raw) {
        return { text: GOAL_USAGE };
      }

      // The controller's notice (`🎯 … Goal task started`, `⛔ … Goal task stopped`,
      // `✏️ … Goal task edited`, `❌ … Goal task failed`) is this command's one
      // answer: in the task's own chat it is the reply instead of a second message.
      // From another chat the notice goes to the task's chat and the reply is
      // a short line, like `/agent_kill`.
      const reply: GoalReplyNotice = { sameChat: (task) => isCommandInRouteChat(ctx, task) };
      const answer = (task: GoalTaskState, short: string, notice: string): string =>
        reply.sameChat(task) ? reply.text ?? notice : short;
      const notFound = (ref: string): string => `❌ Goal task "${ref}" not found.`;
      const first = consumeFirstCommandArg(raw);
      const subcommand = first?.value.toLowerCase();
      if (subcommand === "status") {
        return { text: renderGoalStatus(goalController, (sessionId) => sessionManager?.resolve(sessionId), first!.rest).replace(/^Error:/u, "❌") };
      }
      if (subcommand === "stop") {
        const ref = first!.rest.trim();
        if (!ref) return { text: "Usage: /agent_goal stop <task>" };
        const result = goalController.stopTask(ref, reply);
        if (!result) return { text: notFound(ref) };
        return {
          text: result.action === "already_terminal"
            ? `ℹ️ [${result.task.name}] Already ${result.task.status}; nothing to stop.`
            : answer(result.task, `⛔ [${result.task.name}] Stopped.`, `⛔ [${result.task.name}] Goal task stopped`),
        };
      }
      if (subcommand === "edit") {
        const target = consumeFirstCommandArg(first!.rest);
        const ref = target?.value.trim();
        const replacementGoal = target?.rest.trim();
        if (!ref || !replacementGoal) return { text: "Usage: /agent_goal edit <task> <new goal>" };
        try {
          const result = goalController.editTask(ref, replacementGoal, reply);
          if (result.action === "updated") {
            return { text: answer(result.task, `✏️ [${result.task.name}] Goal task edited.`, `✏️ [${result.task.name}] Goal task edited`) };
          }
          if (result.action === "not_editable") {
            return {
              text: result.task.status === "waiting_for_user"
                ? `❌ [${result.task.name}] Cannot edit the goal while the task waits for your input.`
                : `ℹ️ [${result.task.name}] Already ${result.task.status}; nothing to edit.`,
            };
          }
          return { text: result.action === "not_found" ? notFound(ref) : "❌ The new goal must not be empty." };
        } catch (err) {
          return { text: `❌ Goal task not edited: ${err instanceof Error ? err.message : String(err)}` };
        }
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
          if (!Number.isFinite(parsed) || parsed <= 0) return { text: "❌ --max-cost-usd must be a positive number." };
          maxCostUsd = parsed;
        } else if (token === "--permission-mode" && i + 1 < tokens.length) {
          const mode = tokens[++i];
          if (mode === "default" || mode === "plan" || mode === "bypassPermissions") {
            permissionMode = mode;
          } else {
            return { text: `❌ Invalid permission mode "${mode}".` };
          }
        } else if (token === "--harness" && i + 1 < tokens.length) {
          harness = tokens[++i];
        } else if (token === "--mode" && i + 1 < tokens.length) {
          const mode = tokens[++i];
          if (mode === "ralph" || mode === "verifier") {
            loopMode = mode;
          } else {
            return { text: `❌ Invalid goal mode "${mode}". Use ralph or verifier.` };
          }
        } else if (token === "--completion-promise" && i + 1 < tokens.length) {
          completionPromise = tokens[++i];
        } else if (token === "--verify" && i + 1 < tokens.length) {
          const command = tokens[++i].trim();
          if (!command) {
            return { text: "❌ --verify commands must not be empty." };
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
        verifierCommands: verifierCommands.length ? verifierCommands : undefined,
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
        }, reply);

        return {
          text: `${answer(task, `🎯 [${task.name}] Goal task started.`, `🎯 [${task.name}] Goal task started`)}\n\nFollow it with /agent_goal status ${task.name}; stop it with /agent_goal stop ${task.name}.`,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // A task that failed while starting already has its `❌ [task] Goal task failed` notice.
        return { text: reply.text?.startsWith("❌") ? reply.text : `❌ Goal task did not start: ${message}` };
      }
    },
  });
}
