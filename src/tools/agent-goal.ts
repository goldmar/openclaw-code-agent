import { Type } from "../tool-parameter-schema";

import {
  GOAL_CONTROLLER_MISSING_MESSAGE,
  renderGoalEditResult,
  renderGoalStatus,
  renderGoalStopResult,
} from "../application/goal-view";
import { formatGoalLaunchResult, resolveGoalLaunchRequest, verifierCommandsNeedConfirmation } from "../goal-launch-resolution";
import { goalController, sessionManager } from "../singletons";
import type { GoalLoopMode, OpenClawPluginToolContext, PermissionMode } from "../types";

type GoalAction = "launch" | "status" | "edit" | "stop";

interface AgentGoalParams {
  action: GoalAction;
  task?: string;
  goal?: string;
  verifier_commands?: string[];
  name?: string;
  workdir?: string;
  model?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  max_iterations?: number;
  max_cost_usd?: number;
  goal_mode?: GoalLoopMode;
  completion_promise?: string;
  permission_mode?: PermissionMode;
  harness?: string;
}

const GOAL_ACTIONS = ["launch", "status", "edit", "stop"] as const satisfies readonly GoalAction[];

function text(value: string, isError = false) {
  return { isError, content: [{ type: "text" as const, text: value }] };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Validate the fields each action needs; returns an error message or undefined. */
export function agentGoalParamsError(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return "Expected { action, ... }.";
  const record = params as Record<string, unknown>;
  if (!GOAL_ACTIONS.includes(record.action as GoalAction)) {
    return "action must be one of launch, status, edit, stop.";
  }
  switch (record.action as GoalAction) {
    case "launch":
      return optionalString(record.goal) ? undefined : "action 'launch' requires goal.";
    case "stop":
      return optionalString(record.task) ? undefined : "action 'stop' requires task.";
    case "edit":
      return optionalString(record.task) && optionalString(record.goal)
        ? undefined
        : "action 'edit' requires task and goal.";
    case "status":
      return undefined;
  }
}

/** `agent_goal`: launch, inspect, edit, or stop an explicit goal loop. */
export function makeAgentGoalTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_goal",
    description:
      "Goal loops: a session that repeats until verifier commands pass ('verifier') or a completion promise appears ('ralph'). Use only when the user asks for a goal/autonomous loop. action: launch | status | edit | stop.",
    parameters: Type.Object({
      action: Type.StringEnum(GOAL_ACTIONS, { description: "launch needs goal; stop needs task; edit needs task and goal; status lists all or one task" }),
      task: Type.Optional(Type.String({ description: "Goal task name or ID (status, edit, stop)" })),
      goal: Type.Optional(Type.String({ description: "Goal text (launch), or the replacement goal (edit)" })),
      verifier_commands: Type.Optional(Type.Array(Type.String(), {
        minItems: 1,
        description: "launch: shell commands that must pass (bash -c in the workdir, minimal env). Commands not in the plugin's trustedVerifierCommands need one user confirmation before the loop starts.",
      })),
      name: Type.Optional(Type.String({ description: "launch: short kebab-case task name" })),
      workdir: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      harness: Type.Optional(Type.String({ description: "claude-code, codex, or opencode" })),
      system_prompt: Type.Optional(Type.String()),
      allowed_tools: Type.Optional(Type.Array(Type.String())),
      max_iterations: Type.Optional(Type.Number({ minimum: 1, description: "Default 8, capped at 25" })),
      max_cost_usd: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Stop starting iterations once the task cost this much" })),
      goal_mode: Type.Optional(Type.StringEnum(["ralph", "verifier"], { description: "Default: verifier when verifier_commands are given, else ralph" })),
      completion_promise: Type.Optional(Type.String({ description: "ralph: text that ends the loop (default DONE)" })),
      permission_mode: Type.Optional(Type.StringEnum(["default", "plan", "bypassPermissions"],
        { description: "First iteration's mode; default: the plugin permissionMode (plan, so the first plan goes through plan approval)" },
      )),
    }),
    async execute(_id: string, params: unknown) {
      if (!goalController) return text(GOAL_CONTROLLER_MISSING_MESSAGE, true);
      const error = agentGoalParamsError(params);
      if (error) return text(`Error: Invalid parameters. ${error}`, true);
      const p = params as AgentGoalParams;

      if (p.action === "status") {
        return text(renderGoalStatus(goalController, (sessionId) => sessionManager?.resolve(sessionId), optionalString(p.task)));
      }
      if (p.action === "stop") {
        const task = optionalString(p.task)!;
        return text(renderGoalStopResult(goalController.stopTask(task), task));
      }
      if (p.action === "edit") {
        const task = optionalString(p.task)!;
        return text(renderGoalEditResult(goalController.editTask(task, p.goal!), task));
      }

      const resolution = resolveGoalLaunchRequest({
        goal: p.goal!,
        verifierCommands: p.verifier_commands,
        name: p.name,
        workdir: p.workdir,
        model: p.model,
        systemPrompt: p.system_prompt,
        allowedTools: p.allowed_tools,
        maxIterations: p.max_iterations,
        permissionMode: p.permission_mode,
        harness: p.harness,
        goalMode: p.goal_mode,
        completionPromise: p.completion_promise,
        maxCostUsd: p.max_cost_usd,
      }, ctx);
      if (resolution.kind !== "resolved") return text(resolution.text);

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
          maxCostUsd: resolution.maxCostUsd,
          // The orchestrator chose these commands: the user confirms them once.
          requireVerifierConfirmation: verifierCommandsNeedConfirmation(resolution.verifierCommands),
        });
        return text(formatGoalLaunchResult(task, { ...resolution, maxIterations: p.max_iterations }));
      } catch (err: unknown) {
        return text(`Error launching goal task: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  };
}
