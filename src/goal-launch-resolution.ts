import { existsSync } from "fs";

import {
  getDefaultHarnessName,
  pluginConfig,
  resolveAllowedModelsForHarness,
  resolveAgentChannel,
  resolveDefaultModelForHarness,
  resolveFastModeForHarness,
  resolveOriginChannel,
  resolveReasoningEffortForHarness,
  resolveSessionRoute,
  resolveToolChannel,
} from "./config";
import {
  canonicalAllowedModelForHarness,
  canonicalizeModelForHarness,
  isModelAllowedForHarness,
  isModelFormatSupportedForHarness,
} from "./harness-models";
import type {
  GoalLoopMode,
  GoalTaskState,
  GoalVerifierSpec,
  OpenClawPluginToolContext,
  PermissionMode,
  ReasoningEffort,
  SessionRoute,
} from "./types";
import { resolveRequiredAsyncLaunchRoute } from "./async-launch-route";

export interface GoalLaunchRequest {
  goal: string;
  verifierCommands?: string[];
  name?: string;
  workdir?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  maxIterations?: number;
  permissionMode?: PermissionMode;
  harness?: string;
  goalMode?: GoalLoopMode;
  completionPromise?: string;
  maxCostUsd?: number;
}

export type GoalLaunchResolution =
  | { kind: "error"; text: string }
  | {
      kind: "resolved";
      goal: string;
      name?: string;
      workdir: string;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      fastMode?: boolean;
      systemPrompt?: string;
      allowedTools?: string[];
      maxIterations?: number;
      permissionMode: PermissionMode;
      harness: string;
      loopMode: GoalLoopMode;
      completionPromise?: string;
      originChannel: string;
      originThreadId?: string | number;
      originAgentId?: string;
      originSessionKey?: string;
      route?: SessionRoute;
      verifierCommands: GoalVerifierSpec[];
      maxCostUsd?: number;
    };

function normalizeGoalVerifiers(commands: string[] = []): GoalVerifierSpec[] {
  return commands
    .map((command, index) => ({
      label: `check-${index + 1}`,
      command: command.trim(),
    }))
    .filter((command) => command.command.length > 0);
}

export function resolveGoalLaunchRequest(
  request: GoalLaunchRequest,
  ctx: OpenClawPluginToolContext,
): GoalLaunchResolution {
  const goal = request.goal.trim();
  if (!goal) {
    return { kind: "error", text: "Error: goal must not be empty." };
  }

  const workdir = request.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();
  if (!existsSync(workdir)) {
    return { kind: "error", text: `Error: Working directory does not exist: ${workdir}` };
  }

  if (request.maxCostUsd !== undefined && !(Number.isFinite(request.maxCostUsd) && request.maxCostUsd > 0)) {
    return { kind: "error", text: "Error: max_cost_usd must be a positive number." };
  }
  const verifierCommands = normalizeGoalVerifiers(request.verifierCommands);
  const loopMode = request.goalMode ?? (verifierCommands.length > 0 ? "verifier" : "ralph");
  if (loopMode === "verifier" && verifierCommands.length === 0) {
    return { kind: "error", text: "Error: verifier mode requires at least one non-empty verifier command." };
  }

  const harness = request.harness ?? getDefaultHarnessName();
  const rawModel = request.model ?? resolveDefaultModelForHarness(harness);
  const canonicalModel = canonicalizeModelForHarness(harness, rawModel);
  const allowedModels = resolveAllowedModelsForHarness(harness);
  if (!canonicalModel && (harness !== "opencode" || (allowedModels && allowedModels.length > 0))) {
    return {
      kind: "error",
      text: `Error: No default model configured for harness "${harness}". Set plugins.entries["openclaw-code-agent"].config.harnesses.${harness}.defaultModel or pass model explicitly.`,
    };
  }

  if (canonicalModel && !isModelFormatSupportedForHarness(harness, canonicalModel)) {
    return {
      kind: "error",
      text: `Error: Model "${rawModel}" is not supported for harness "${harness}". Use a bare Codex model id such as "gpt-6-sol" or "gpt-6-astra".`,
    };
  }

  if (canonicalModel && !isModelAllowedForHarness(harness, canonicalModel, allowedModels)) {
    return {
      kind: "error",
      text: `Error: Model "${rawModel}" is not allowed. Permitted models: ${allowedModels?.join(", ")}`,
    };
  }
  const model = canonicalAllowedModelForHarness(harness, canonicalModel, allowedModels);

  const originSessionKey = ctx.sessionKey || undefined;
  const ctxChannel = resolveToolChannel(ctx);
  const originChannel = resolveOriginChannel(ctx, ctxChannel || resolveAgentChannel(workdir));
  const route = resolveSessionRoute(ctx, originChannel, originSessionKey);
  const routeResolution = resolveRequiredAsyncLaunchRoute({
    ctx,
    route,
    operation: "goal task",
  });
  if (routeResolution.kind === "error") return routeResolution;
  const resolvedRoute = routeResolution.route;

  return {
    kind: "resolved",
    goal,
    name: request.name,
    workdir,
    model,
    reasoningEffort: resolveReasoningEffortForHarness(harness),
    fastMode: resolveFastModeForHarness(harness),
    systemPrompt: request.systemPrompt,
    allowedTools: request.allowedTools,
    maxIterations: request.maxIterations,
    // The first iteration follows the configured mode (default: plan), so its
    // plan goes through the normal plan gate.
    permissionMode: request.permissionMode ?? pluginConfig.permissionMode ?? "plan",
    harness,
    loopMode,
    completionPromise: request.completionPromise,
    originChannel,
    originThreadId: route?.threadId,
    originAgentId: ctx.agentId || undefined,
    originSessionKey,
    route: resolvedRoute,
    verifierCommands,
    ...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {}),
  };
}

/**
 * True when goal verifier commands need the user's confirmation: they came
 * from the orchestrator and are not all pre-approved in `trustedVerifierCommands`.
 */
export function verifierCommandsNeedConfirmation(commands: readonly GoalVerifierSpec[]): boolean {
  const trusted = new Set((pluginConfig.trustedVerifierCommands ?? [])
    .filter((command): command is string => typeof command === "string")
    .map((command) => command.trim())
    .filter((command) => command.length > 0));
  return commands.some((command) => !trusted.has(command.command.trim()));
}

export function formatGoalLaunchResult(task: GoalTaskState, resolution: Pick<
  Extract<GoalLaunchResolution, { kind: "resolved" }>,
  "goal" | "harness" | "model" | "fastMode" | "verifierCommands"
> & { maxIterations?: number }): string {
  if (task.status === "awaiting_verifier_confirmation") {
    return [
      `Goal task created and waiting for the user's confirmation. Nothing runs until they confirm.`,
      `  Name: ${task.name}`,
      `  ID: ${task.id}`,
      `  Dir: ${task.workdir}`,
      `  Max iterations: ${task.maxIterations}${resolution.maxIterations !== undefined && resolution.maxIterations > task.maxIterations ? ` (capped from ${resolution.maxIterations})` : ""}`,
      `  Verifiers to confirm:`,
      ...resolution.verifierCommands.map((command) => `  - ${command.command}`),
      ``,
      `The user got a message listing these exact commands with Run / Cancel buttons. Do not start the task another way; tell the user it is waiting for their confirmation.`,
    ].join("\n");
  }
  const lines = [
    `Goal task launched.`,
    `  Name: ${task.name}`,
    `  ID: ${task.id}`,
    `  Dir: ${task.workdir}`,
    `  Session: ${task.sessionName} [${task.sessionId}]`,
    `  Harness: ${resolution.harness}`,
    `  Model: ${resolution.model ?? "default"}`,
    ...(resolution.fastMode ? [`  Fast mode: enabled`] : []),
    `  Loop mode: ${task.loopMode}`,
    `  Max controller iterations: ${task.maxIterations}${resolution.maxIterations !== undefined && resolution.maxIterations > task.maxIterations ? ` (capped from ${resolution.maxIterations})` : ""}`,
    `  Goal: "${resolution.goal.length > 100 ? `${resolution.goal.slice(0, 100)}...` : resolution.goal}"`,
    ...(task.loopMode === "ralph"
      ? [`  Completion promise: ${task.completionPromise}`]
      : [
          `  Verifiers:`,
          ...resolution.verifierCommands.map((command) => `  - ${command.command}`),
        ]),
    ``,
    `Controller iteration progress advances only when the goal controller starts another agent turn; internal agent review passes are reported in the completion summary.`,
    ``,
    `Follow it with agent_goal(action='status', task='${task.name}') or /agent_goal status ${task.name}; stop it with action 'stop' or /agent_goal stop ${task.name}.`,
  ];

  return lines.join("\n");
}
