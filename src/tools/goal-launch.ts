import { Type } from "../tool-schema";

import { goalController } from "../singletons";
import { formatGoalLaunchResult, resolveGoalLaunchRequest } from "../goal-launch-resolution";
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
    name: "agent_goal_launch",
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
      harness: Type.Optional(Type.String({ description: "Agent harness to use ('claude-code', 'codex', or experimental 'opencode')." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) {
        return { content: [{ type: "text", text: "Error: GoalController not initialized. The code-agent service must be running." }] };
      }
      if (!isGoalLaunchParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected at least { goal }." }] };
      }

      const resolution = resolveGoalLaunchRequest({
        goal: params.goal,
        verifierCommands: params.verifier_commands,
        name: params.name,
        workdir: params.workdir,
        model: params.model,
        systemPrompt: params.system_prompt,
        allowedTools: params.allowed_tools,
        maxIterations: params.max_iterations,
        permissionMode: params.permission_mode,
        harness: params.harness,
        goalMode: params.goal_mode,
        completionPromise: params.completion_promise,
      }, ctx);
      if (resolution.kind !== "resolved") {
        return { content: [{ type: "text", text: resolution.text }] };
      }

      try {
        const task = await goalController.launchTask({
          goal: resolution.goal,
          name: resolution.name,
          workdir: resolution.workdir,
          model: resolution.model,
          reasoningEffort: resolution.reasoningEffort,
          fastMode: resolution.fastMode,
          systemPrompt: resolution.systemPrompt,
          allowedTools: resolution.allowedTools,
          maxIterations: resolution.maxIterations,
          permissionMode: resolution.permissionMode,
          loopMode: resolution.loopMode,
          completionPromise: resolution.completionPromise,
          originChannel: resolution.originChannel,
          originThreadId: resolution.originThreadId,
          originAgentId: resolution.originAgentId,
          originSessionKey: resolution.originSessionKey,
          route: resolution.route,
          harness: resolution.harness,
          verifierCommands: resolution.verifierCommands,
        });

        return {
          content: [{
            type: "text",
            text: formatGoalLaunchResult(task, resolution),
          }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error launching goal task: ${message}` }] };
      }
    },
  };
}
