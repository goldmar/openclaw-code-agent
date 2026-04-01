import { existsSync } from "fs";

import { goalController } from "../singletons";
import {
  getDefaultHarnessName,
  pluginConfig,
  resolveAllowedModelsForHarness,
  resolveDefaultModelForHarness,
  resolveOriginChannel,
  resolveReasoningEffortForHarness,
  resolveSessionRoute,
} from "../config";
import { isModelAllowed } from "../model-allowlist";

function tokenizeArgs(raw: string): string[] {
  const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!matches) return [];
  return matches.map((token) => {
    if (
      (token.startsWith("\"") && token.endsWith("\""))
      || (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

export function registerGoalCommand(api: any): void {
  api.registerCommand({
    name: "goal",
    description: "Launch an explicit goal task (Ralph-style completion loop or verifier-driven loop)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      if (!goalController) {
        return { text: "Error: GoalController not initialized. The code-agent service must be running." };
      }

      const raw = (ctx.args ?? "").trim();
      if (!raw) {
        return { text: "Usage: /goal [--name <name>] [--workdir <dir>] [--model <model>] [--harness <name>] [--mode <ralph|verifier>] [--completion-promise <text>] [--max-iterations N] [--verify <cmd> ...] <goal>" };
      }

      const tokens = tokenizeArgs(raw);
      let name: string | undefined;
      let workdir = pluginConfig.defaultWorkdir || process.cwd();
      let model: string | undefined;
      let maxIterations: number | undefined;
      let permissionMode: "default" | "plan" | "bypassPermissions" = "bypassPermissions";
      let harness: string | undefined;
      let loopMode: "ralph" | "verifier" | undefined;
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
        return { text: "Usage: /goal [--name <name>] [--workdir <dir>] [--model <model>] [--harness <name>] [--mode <ralph|verifier>] [--completion-promise <text>] [--max-iterations N] [--verify <cmd> ...] <goal>" };
      }
      if (!existsSync(workdir)) {
        return { text: `Error: Working directory does not exist: ${workdir}` };
      }

      const resolvedLoopMode = loopMode ?? (verifierCommands.length > 0 ? "verifier" : "ralph");
      if (resolvedLoopMode === "verifier" && verifierCommands.length === 0) {
        return { text: "Error: verifier mode requires at least one --verify command." };
      }

      const resolvedHarness = harness ?? getDefaultHarnessName();
      const resolvedModel = model ?? resolveDefaultModelForHarness(resolvedHarness);
      if (!resolvedModel) {
        return {
          text: `Error: No default model configured for harness "${resolvedHarness}". Set plugins.entries["openclaw-code-agent"].config.harnesses.${resolvedHarness}.defaultModel or pass model explicitly.`,
        };
      }

      const allowedModels = resolveAllowedModelsForHarness(resolvedHarness);
      if (!isModelAllowed(resolvedModel, allowedModels)) {
        return { text: `Error: Model "${resolvedModel}" is not allowed. Permitted models: ${allowedModels?.join(", ")}` };
      }

      try {
        const route = resolveSessionRoute(ctx);
        const task = await goalController.launchTask({
          goal,
          name,
          workdir,
          model: resolvedModel,
          reasoningEffort: resolveReasoningEffortForHarness(resolvedHarness),
          maxIterations,
          permissionMode,
          harness: resolvedHarness,
          loopMode: resolvedLoopMode,
          completionPromise,
          originChannel: resolveOriginChannel(ctx),
          originThreadId: route?.threadId,
          originSessionKey: ctx.sessionKey,
          route,
          verifierCommands: verifierCommands.map((command, index) => ({
            label: `check-${index + 1}`,
            command,
          })),
        });

        return {
          text: [
            `Goal task launched.`,
            `  Name: ${task.name}`,
            `  ID: ${task.id}`,
            `  Session: ${task.sessionName} [${task.sessionId}]`,
            `  Harness: ${resolvedHarness}`,
            `  Loop mode: ${task.loopMode}`,
            ...(task.loopMode === "ralph" ? [`  Completion promise: ${task.completionPromise}`] : []),
            `  Max iterations: ${task.maxIterations}`,
            `  Goal: "${goal.length > 100 ? `${goal.slice(0, 100)}...` : goal}"`,
          ].join("\n"),
        };
      } catch (err: any) {
        return { text: `Error launching goal task: ${err.message}` };
      }
    },
  });
}
