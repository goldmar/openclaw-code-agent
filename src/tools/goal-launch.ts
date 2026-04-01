import { existsSync } from "fs";
import { Type } from "@sinclair/typebox";

import { goalController } from "../singletons";
import {
  getDefaultHarnessName,
  pluginConfig,
  resolveAllowedModelsForHarness,
  resolveDefaultModelForHarness,
  resolveOriginChannel,
  resolveReasoningEffortForHarness,
  resolveSessionRoute,
  resolveToolChannel,
} from "../config";
import { isModelAllowed } from "../model-allowlist";
import type { OpenClawPluginToolContext } from "../types";

interface GoalLaunchParams {
  goal: string;
  verifier_commands?: string[];
  name?: string;
  workdir?: string;
  model?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  max_iterations?: number;
  permission_mode?: "default" | "plan" | "bypassPermissions";
  harness?: string;
  goal_mode?: "ralph" | "verifier";
  completion_promise?: string;
}

function isGoalLaunchParams(value: unknown): value is GoalLaunchParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.goal === "string";
}

export function makeGoalLaunchTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "goal_launch",
    description:
      "Launch an explicit goal loop. Use this only when the user specifically asks for a goal task, Ralph-style autonomous loop, iterative loop, autonomous repair loop, or keep-going-until-checks-pass workflow. This is not the default session path.",
    parameters: Type.Object({
      goal: Type.String({ description: "End goal for the autonomous task" }),
      verifier_commands: Type.Optional(
        Type.Array(
          Type.String({ description: "Shell command that must pass for the goal to be considered complete" }),
          { minItems: 1, description: "Verifier commands run after each coding turn" },
        ),
      ),
      name: Type.Optional(Type.String({ description: "Short task name (kebab-case preferred)" })),
      workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd / configured workspace)" })),
      model: Type.Optional(Type.String({ description: "Model name to use" })),
      system_prompt: Type.Optional(Type.String({ description: "Additional system prompt" })),
      allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "Allowed tools for the underlying agent session" })),
      max_iterations: Type.Optional(Type.Number({ description: "Maximum verifier-driven repair iterations", minimum: 1 })),
      goal_mode: Type.Optional(
        Type.Union(
          [Type.Literal("ralph"), Type.Literal("verifier")],
          { description: "Loop strategy. 'ralph' repeats until a completion promise appears. 'verifier' repeats until verifier commands pass. Defaults to 'ralph' when no verifiers are provided, otherwise 'verifier'." },
        ),
      ),
      completion_promise: Type.Optional(Type.String({ description: "Exact completion promise for Ralph-mode loops. Defaults to 'DONE'." })),
      permission_mode: Type.Optional(
        Type.Union(
          [Type.Literal("default"), Type.Literal("plan"), Type.Literal("bypassPermissions")],
          { description: "Permission mode for the underlying agent session. Defaults to bypassPermissions for autonomous goal loops." },
        ),
      ),
      harness: Type.Optional(Type.String({ description: "Agent harness to use (e.g. 'codex' or 'claude-code')." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: "Error: GoalController not initialized. The code-agent service must be running." }] };
      }
      if (!isGoalLaunchParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected at least { goal }." }] };
      }

      const workdir = params.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();
      if (!existsSync(workdir)) {
        return { content: [{ type: "text", text: `Error: Working directory does not exist: ${workdir}` }] };
      }

      const verifierCommands = (params.verifier_commands ?? [])
        .map((command, index) => ({
          label: `check-${index + 1}`,
          command: command.trim(),
        }))
        .filter((command) => command.command.length > 0);

      const goalMode = params.goal_mode ?? (verifierCommands.length > 0 ? "verifier" : "ralph");
      if (goalMode === "verifier" && verifierCommands.length === 0) {
        return { content: [{ type: "text", text: "Error: verifier_commands must contain at least one non-empty command for verifier goal mode." }] };
      }

      const harness = params.harness ?? getDefaultHarnessName();
      const resolvedModel = params.model ?? resolveDefaultModelForHarness(harness);
      if (!resolvedModel) {
        return {
          content: [{
            type: "text",
            text: `Error: No default model configured for harness "${harness}". Set plugins.entries[\"openclaw-code-agent\"].config.harnesses.${harness}.defaultModel or pass model explicitly.`,
          }],
        };
      }

      const allowedModels = resolveAllowedModelsForHarness(harness);
      if (!isModelAllowed(resolvedModel, allowedModels)) {
        return {
          content: [{
            type: "text",
            text: `Error: Model "${resolvedModel}" is not allowed. Permitted models: ${allowedModels?.join(", ")}`,
          }],
        };
      }

      const originSessionKey = ctx.sessionKey || undefined;
      const ctxChannel = resolveToolChannel(ctx);
      const originChannel = resolveOriginChannel(ctx, ctxChannel);
      const route = resolveSessionRoute(ctx, originChannel, originSessionKey);

      try {
        const task = await goalController.launchTask({
          goal: params.goal,
          name: params.name,
          workdir,
          model: resolvedModel,
          reasoningEffort: resolveReasoningEffortForHarness(harness),
          systemPrompt: params.system_prompt,
          allowedTools: params.allowed_tools,
          maxIterations: params.max_iterations,
          permissionMode: params.permission_mode ?? "bypassPermissions",
          loopMode: goalMode,
          completionPromise: params.completion_promise,
          originChannel,
          originThreadId: route?.threadId,
          originAgentId: ctx.agentId || undefined,
          originSessionKey,
          route,
          harness,
          verifierCommands,
        });

        const lines = [
          `Goal task launched successfully.`,
          `  Name: ${task.name}`,
          `  ID: ${task.id}`,
          `  Dir: ${task.workdir}`,
          `  Session: ${task.sessionName} [${task.sessionId}]`,
          `  Harness: ${harness}`,
          `  Model: ${resolvedModel}`,
          `  Loop mode: ${task.loopMode}`,
          `  Max iterations: ${task.maxIterations}`,
          `  Goal: "${params.goal.length > 100 ? `${params.goal.slice(0, 100)}...` : params.goal}"`,
          ...(task.loopMode === "ralph"
            ? [`  Completion promise: ${task.completionPromise}`]
            : [
                `  Verifiers:`,
                ...verifierCommands.map((command) => `  - ${command.command}`),
              ]),
          ``,
          `Use goal_status to follow progress or goal_stop to terminate the task.`,
        ];

        return {
          content: [{
            type: "text",
            text: lines.join("\n"),
          }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error launching goal task: ${message}` }] };
      }
    },
  };
}
