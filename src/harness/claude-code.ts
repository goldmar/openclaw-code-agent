/**
 * Claude Code harness — wraps @anthropic-ai/claude-agent-sdk and emits the
 * plugin's structured backend/run event model.
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import {
  getSessionInfo as sdkGetSessionInfo,
  startup as sdkStartup,
  type CanUseTool,
  type ModelInfo,
  type ModelUsage,
  type Options,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  PendingInputState,
  PlanArtifact,
  ReasoningEffort,
} from "../types";
import {
  extractPendingInputQuestions,
  formatPendingInputQuestions,
  formatPendingInputWizardQuestion,
} from "../pending-input-normalization";
import type {
  AgentHarness,
  HarnessBackendInfo,
  HarnessLaunchOptions,
  HarnessModelUsage,
  HarnessPlanDecision,
  HarnessSession,
  HarnessUsage,
} from "./types";
import {
  createBackendRefEvent,
  createPendingInputEvent,
  createPendingInputResolvedEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  createSettingsChangedEvent,
  createTextDeltaEvent,
  createToolCallEvent,
  HarnessMessageQueue,
} from "./harness-events";
import { createLogger } from "../logger";

const log = createLogger("claude-code");

/** The part of the SDK's public `WarmQuery` the harness uses. */
type ClaudeWarmQuery = {
  query(prompt: string | AsyncIterable<SDKUserMessage>): Query;
  close(): void;
};

interface ClaudeCodeHarnessDeps {
  startup?: (params: { options: Options }) => Promise<ClaudeWarmQuery>;
  getSessionInfo?: typeof sdkGetSessionInfo;
}

/**
 * Plan-mode workflow body passed as the SDK `planModeInstructions` option. The
 * CLI wraps it with its read-only enforcement preamble and ExitPlanMode footer.
 */
export const CLAUDE_PLAN_MODE_INSTRUCTIONS = [
  "This session runs under OpenClaw. The user reviews your plan asynchronously in a chat, so the plan must stand on its own.",
  "1. Explore the codebase with read-only tools until you understand the task. Use AskUserQuestion only for ambiguities that genuinely block planning.",
  "2. Write a concrete implementation plan to the plan file: the goal, the files to change, the step-by-step changes, and how you will verify them (tests, builds, checks).",
  "3. Call ExitPlanMode to submit the plan. The user approves it, requests changes, or rejects it.",
  "4. If the user requests changes, the ExitPlanMode result contains their feedback. Revise the plan file to address it and call ExitPlanMode again. Do not implement anything before the plan is approved.",
].join("\n");

const PLAN_MODE_TOOL_DENIED_MESSAGE =
  "Plan mode is active: implementation tools stay blocked until the user approves your plan. Finish the plan and call ExitPlanMode.";

/** Tool-result text returned to Claude when the user requests plan changes. */
function formatPlanRevisionFeedback(feedback: string): string {
  return [
    "The user reviewed this plan and requested changes before approving it. Do not implement anything yet.",
    "",
    "User feedback:",
    feedback.trim(),
    "",
    "Revise the plan to address the feedback, then call ExitPlanMode again to resubmit it for approval.",
  ].join("\n");
}

const INTERRUPTED_TERMINAL_REASONS = new Set(["aborted_streaming", "aborted_tools"]);

function resolveResultText(msg: SDKResultMessage): string | undefined {
  if (msg.subtype === "success" && typeof msg.result === "string" && msg.result.length > 0) {
    return msg.result;
  }
  if (msg.subtype !== "success" && Array.isArray(msg.errors)) {
    const errors = msg.errors.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (errors.length > 0) {
      return errors.join("\n");
    }
  }
  return undefined;
}

function toModelUsage(modelUsage: Record<string, ModelUsage> | undefined): HarnessModelUsage[] | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const models = Object.entries(modelUsage).map(([model, usage]): HarnessModelUsage => ({
    model,
    ...(usage.canonicalModel ? { canonicalModel: usage.canonicalModel } : {}),
    costUsd: Number.isFinite(usage.costUSD) ? usage.costUSD : 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.thinkingTokens !== undefined ? { reasoningTokens: usage.thinkingTokens } : {}),
    cacheReadTokens: usage.cacheReadInputTokens ?? 0,
    cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
    ...(usage.costBasis ? { costBasis: usage.costBasis } : {}),
  }));
  return models.length > 0 ? models : undefined;
}

/** Per-model totals are the authoritative cost source; fall back to the aggregate. */
function resolveTotalCostUsd(msg: SDKResultMessage, models: HarnessModelUsage[] | undefined): number {
  if (models) {
    return models.reduce((sum, entry) => sum + entry.costUsd, 0);
  }
  return Number.isFinite(msg.total_cost_usd) ? msg.total_cost_usd : 0;
}

/**
 * Results that close no user turn: an empty, zero-turn result produced for a
 * background-task notification that shared one model call with a sibling
 * notification (SDK 0.3.274+: "all but the last empty with num_turns: 0").
 */
function isCoalescedBackgroundResult(msg: SDKResultMessage): boolean {
  return msg.origin?.kind === "task-notification"
    && msg.num_turns === 0
    && !resolveResultText(msg);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

/**
 * `planFilePath` comes from model-authored tool input. Only accept Markdown
 * files inside a Claude plans directory (the user config dir or the project's
 * `.claude/plans`), after resolving symlinks, so a plan request can never
 * surface an arbitrary local file in chat or session output.
 */
export function trustedPlanFilePath(path: string | undefined, projectDirs: Array<string | undefined>): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed || !isAbsolute(trimmed) || !trimmed.toLowerCase().endsWith(".md")) return undefined;
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const roots = [
    join(configDir, "plans"),
    ...projectDirs.filter((dir): dir is string => !!dir).map((dir) => join(dir, ".claude", "plans")),
  ].map(realpathOrSelf);
  const resolved = realpathOrSelf(trimmed);
  return roots.some((root) => isInside(root, resolved)) ? resolved : undefined;
}

function readPlanFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function buildPendingInputState(
  sessionId: string,
  requestId: number,
  input: Record<string, unknown>,
): PendingInputState {
  const questions = extractPendingInputQuestions(input);
  const activeQuestionIndex = questions.length > 0 ? 0 : undefined;
  const activeQuestion = activeQuestionIndex != null ? questions[activeQuestionIndex] : undefined;
  const options = activeQuestion?.options.map((option) => option.label) ?? [];
  const promptText = activeQuestion
    ? formatPendingInputWizardQuestion(activeQuestion, activeQuestionIndex, questions.length)
    : formatPendingInputQuestions(questions);

  return {
    requestId: `${sessionId || "claude"}-ask-${requestId}`,
    kind: "question",
    promptText,
    options,
    ...(questions.length > 0 ? { questions } : {}),
    ...(activeQuestionIndex != null ? { activeQuestionIndex } : {}),
    allowsFreeText: activeQuestion?.allowsFreeText === true || options.length === 0,
  };
}

function resolveBackendInfo(args: {
  requestedModel?: string;
  requestedEffort?: ReasoningEffort;
  initModel?: string;
  initEffort?: ReasoningEffort | null;
  models?: ModelInfo[];
}): HarnessBackendInfo {
  const info: HarnessBackendInfo = {};
  if (args.initModel) info.model = args.initModel;
  if (args.initEffort !== undefined) info.reasoningEffort = args.initEffort;
  if (!args.requestedEffort) return info;
  if (args.initEffort !== undefined) {
    // system/init reports the effort applied after model-support downgrades.
    info.reasoningEffortSupported = args.initEffort === args.requestedEffort;
    return info;
  }
  const requested = args.requestedModel?.trim().toLowerCase();
  const modelInfo = args.models?.find((entry) => entry.value.toLowerCase() === requested)
    ?? args.models?.find((entry) => !!args.initModel && entry.resolvedModel === args.initModel);
  if (!modelInfo) return info;
  if (modelInfo.supportsEffort === false) {
    info.reasoningEffortSupported = false;
  } else if (Array.isArray(modelInfo.supportedEffortLevels)) {
    info.reasoningEffortSupported = modelInfo.supportedEffortLevels.includes(args.requestedEffort);
  }
  return info;
}

type PendingPlanRequest = {
  requestId: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
};

export class ClaudeCodeHarness implements AgentHarness {
  constructor(private readonly deps: ClaudeCodeHarnessDeps = {}) {}

  readonly name = "claude-code";
  readonly backendKind = "claude-code" as const;
  readonly supportedPermissionModes = [
    "default",
    "plan",
    "bypassPermissions",
  ] as const;
  readonly capabilities = {
    nativePendingInput: false,
    nativePlanArtifacts: true,
    nativePlanDecisions: true,
  } as const;

  /** Launch a Claude Code session and adapt SDK messages into structured events. */
  launch(options: HarnessLaunchOptions): HarnessSession {
    const queue = new HarnessMessageQueue();
    let sawRunOutput = false;
    let requestCounter = 0;
    let currentSessionId = options.resumeSessionId ?? "";
    let currentPermissionMode = options.permissionMode;
    let pendingPlan: PendingPlanRequest | undefined;
    let closed = false;

    const settlePendingPlan = (result: PermissionResult): PendingPlanRequest | undefined => {
      const pending = pendingPlan;
      pendingPlan = undefined;
      pending?.resolve(result);
      return pending;
    };

    const requestPlanApproval = (
      input: Record<string, unknown>,
      requestId: string,
      signal: AbortSignal,
    ): Promise<PermissionResult> => {
      settlePendingPlan({ behavior: "deny", message: "Superseded by a newer plan submission." });
      const planFilePath = trustedPlanFilePath(
        typeof input.planFilePath === "string" ? input.planFilePath : undefined,
        [options.cwd, options.originalWorkdir],
      );
      const inlinePlan = typeof input.plan === "string" ? input.plan.trim() : "";
      const artifact: PlanArtifact = {
        explanation: undefined,
        steps: [],
        markdown: inlinePlan || readPlanFile(planFilePath) || "",
      };
      return new Promise<PermissionResult>((resolve) => {
        if (closed || signal.aborted) {
          resolve({ behavior: "deny", message: "Plan review was cancelled.", interrupt: true });
          return;
        }
        const onAbort = (): void => {
          if (pendingPlan?.requestId !== requestId) return;
          settlePendingPlan({ behavior: "deny", message: "Plan review was cancelled.", interrupt: true });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pendingPlan = {
          requestId,
          input,
          resolve: (result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
        };
        queue.enqueue({
          type: "plan_approval_requested",
          request: {
            requestId,
            artifact,
            ...(planFilePath ? { planFilePath } : {}),
          },
        });
      });
    };

    const askUserQuestion = options.canUseTool;
    const canUseTool: CanUseTool = async (toolName, input, toolOptions) => {
      if (toolName === "AskUserQuestion") {
        if (!askUserQuestion) {
          return { behavior: "deny", message: "No interactive user is attached to this session; proceed with your best judgment." };
        }
        const state = buildPendingInputState(currentSessionId, ++requestCounter, input);
        queue.enqueue(createPendingInputEvent(state));
        try {
          return await askUserQuestion(toolName, input);
        } finally {
          queue.enqueue(createPendingInputResolvedEvent(state.requestId));
        }
      }
      if (toolName === "ExitPlanMode") {
        if (currentPermissionMode !== "plan") {
          return { behavior: "allow", updatedInput: input };
        }
        return await requestPlanApproval(
          input,
          toolOptions.requestId || toolOptions.toolUseID,
          toolOptions.signal,
        );
      }
      // Since SDK 0.3.269 plan mode routes writes and other mutating tools
      // here even with allowDangerouslySkipPermissions. Plan-file writes are
      // allowed by the CLI itself and never reach this callback.
      if (currentPermissionMode === "plan") {
        return { behavior: "deny", message: PLAN_MODE_TOOL_DENIED_MESSAGE };
      }
      return { behavior: "allow", updatedInput: input };
    };

    const worktreeConfigRoot = options.originalWorkdir
      && options.worktreeStrategy
      && options.worktreeStrategy !== "off"
      && options.originalWorkdir !== options.cwd
      ? options.originalWorkdir
      : undefined;

    const sdkOptions: Options = {
      cwd: options.cwd,
      model: options.model,
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      permissionMode: options.permissionMode as ClaudePermissionMode | undefined,
      allowDangerouslySkipPermissions: true,
      planModeInstructions: CLAUDE_PLAN_MODE_INSTRUCTIONS,
      allowedTools: options.allowedTools,
      systemPrompt: options.systemPrompt === undefined
        ? undefined
        : { type: "custom", prompt: options.systemPrompt, snapshot: false },
      includePartialMessages: true,
      abortController: options.abortController,
      canUseTool,
      // Worktree sessions keep project settings, hooks, `.mcp.json`, and
      // `.claude/` config from the trusted checkout instead of the branch.
      ...(worktreeConfigRoot ? { projectConfigRoot: worktreeConfigRoot } : {}),
      env: {
        ...process.env,
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
      },
    };

    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
      sdkOptions.forkSession = options.forkSession ?? false;
    }

    const prompt = options.prompt as string | AsyncIterable<SDKUserMessage>;
    const startupFn = this.deps.startup ?? sdkStartup;
    const getSessionInfo = this.deps.getSessionInfo ?? sdkGetSessionInfo;
    const qPromise = (async (): Promise<Query> => {
      if (options.resumeSessionId) {
        // Completed Claude sessions are resumable; confirm the transcript still
        // exists so a missing one fails with a clear reason instead of a CLI error.
        const info = await getSessionInfo(options.resumeSessionId).catch((): undefined => undefined);
        if (!info) {
          throw new Error(`Claude Code session ${options.resumeSessionId} was not found on this host, so it cannot be resumed.`);
        }
      }
      const warmQuery = await startupFn({ options: sdkOptions });
      try {
        return warmQuery.query(prompt);
      } catch (error) {
        warmQuery.close();
        throw error;
      }
    })();

    // Advisory reporting calls; awaited before the queue closes so late
    // updates from short sessions still reach consumers.
    const reporting = new Set<Promise<void>>();
    const track = (task: Promise<void>): void => {
      reporting.add(task);
      void task.finally(() => reporting.delete(task));
    };

    const publishContextUsage = (q: Query): void => {
      track((async () => {
        try {
          const context = await q.getContextUsage({ detail: "summary" });
          if (!Number.isFinite(context?.totalTokens)) return;
          queue.enqueue({
            type: "usage_updated",
            usage: {
              contextTokens: context.totalTokens,
              ...(Number.isFinite(context.maxTokens) ? { contextWindow: context.maxTokens } : {}),
            },
          });
        } catch {
          // Context usage is advisory; older CLIs and closed queries lack it.
        }
      })());
    };

    const publishBackendInfo = (q: Query, initModel: string | undefined, initEffort: ReasoningEffort | null | undefined): void => {
      track((async () => {
        let models: ModelInfo[] | undefined;
        if (options.reasoningEffort && initEffort === undefined) {
          try {
            models = await q.supportedModels();
          } catch {
            models = undefined;
          }
        }
        const info = resolveBackendInfo({
          requestedModel: options.model,
          requestedEffort: options.reasoningEffort,
          initModel,
          initEffort,
          models,
        });
        if (Object.keys(info).length > 0) {
          queue.enqueue({ type: "backend_info", info });
        }
      })());
    };

    void (async () => {
      try {
        const q = await qPromise;
        let skippedResult: SDKResultMessage | undefined;
        let emittedCompletion = false;
        let sawInit = false;
        let lastAssistantError: string | undefined;
        let backgroundTasks = 0;

        const emitResult = (msg: SDKResultMessage): void => {
          const models = toModelUsage(msg.modelUsage);
          const interrupted = typeof msg.terminal_reason === "string"
            && INTERRUPTED_TERMINAL_REASONS.has(msg.terminal_reason);
          const failed = msg.subtype !== "success" || msg.is_error === true;
          const outcome = interrupted ? "interrupted" : (failed ? "failed" : "completed");
          const errorCode = outcome === "failed"
            ? ("startup_failure_reason" in msg && msg.startup_failure_reason) || lastAssistantError
            : undefined;
          const usage: HarnessUsage = {
            ...(models ? { models } : {}),
            backgroundTasks,
          };
          queue.enqueue(createRunCompletedEvent({
            success: outcome === "completed",
            outcome,
            outcomeAuthoritative: true,
            ...(errorCode ? { errorCode } : {}),
            duration_ms: msg.duration_ms ?? 0,
            total_cost_usd: resolveTotalCostUsd(msg, models),
            num_turns: msg.num_turns ?? 0,
            result: resolveResultText(msg),
            session_id: msg.session_id ?? currentSessionId,
            usage,
          }));
          emittedCompletion = true;
          lastAssistantError = undefined;
          sawRunOutput = false;
        };

        for await (const msg of q as AsyncIterable<SDKMessage>) {
          if (msg.type === "system" && msg.subtype === "init") {
            currentSessionId = msg.session_id ?? currentSessionId;
            queue.enqueue(createBackendRefEvent({
              kind: "claude-code",
              conversationId: currentSessionId,
            }));
            if (!sawInit) {
              sawInit = true;
              publishBackendInfo(q, msg.model, msg.effort);
            }
            continue;
          }

          if (msg.type === "system" && msg.subtype === "status") {
            if (msg.permissionMode) {
              currentPermissionMode = msg.permissionMode;
              queue.enqueue(createSettingsChangedEvent(msg.permissionMode));
            }
            continue;
          }

          if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
            backgroundTasks = msg.tasks.filter((task) => task.ambient !== true).length;
            queue.enqueue({ type: "usage_updated", usage: { backgroundTasks } });
            continue;
          }

          if (msg.type === "system" && msg.subtype === "permission_denied") {
            log.warn("tool.permission_denied", {
              tool: msg.tool_name,
              reasonType: msg.decision_reason_type,
              hasSessionId: Boolean(currentSessionId),
            });
            queue.enqueue({ type: "activity" });
            continue;
          }

          if (msg.type === "system" && msg.subtype === "session_state_changed") {
            queue.enqueue({ type: "activity" });
            continue;
          }

          if (msg.type === "assistant") {
            if (!sawRunOutput) {
              sawRunOutput = true;
              queue.enqueue(createRunStartedEvent());
            }
            if (msg.error) lastAssistantError = msg.error;
            for (const block of msg.message?.content ?? []) {
              if (block.type === "text") {
                queue.enqueue(createTextDeltaEvent(block.text));
                continue;
              }
              if (block.type === "tool_use" && block.name !== "AskUserQuestion") {
                queue.enqueue(createToolCallEvent(block.name, block.input));
              }
            }
            continue;
          }

          if (msg.type === "result") {
            // More user sends are queued: the last of them carries the turn end.
            if ((msg.queued_turn_count ?? 0) > 0 || isCoalescedBackgroundResult(msg)) {
              skippedResult = msg;
              continue;
            }
            skippedResult = undefined;
            emitResult(msg);
            publishContextUsage(q);
          }
        }
        // A skipped result may also be the only result of a completed query.
        if (skippedResult && !emittedCompletion) {
          emitResult(skippedResult);
        }
      } catch (error: unknown) {
        queue.enqueue(createRunCompletedEvent({
          success: false,
          outcome: "failed",
          outcomeAuthoritative: true,
          duration_ms: 0,
          total_cost_usd: 0,
          num_turns: 0,
          result: error instanceof Error ? error.message : String(error),
          session_id: currentSessionId,
        }));
      } finally {
        closed = true;
        settlePendingPlan({ behavior: "deny", message: "The session ended before the plan was reviewed.", interrupt: true });
        await Promise.allSettled([...reporting]);
        queue.close();
      }
    })();

    return {
      messages: queue.messages(),

      async setPermissionMode(mode: string): Promise<void> {
        const q = await qPromise;
        await q.setPermissionMode(mode as ClaudePermissionMode);
        currentPermissionMode = mode;
      },

      async resolvePlanDecision(decision: HarnessPlanDecision): Promise<boolean> {
        if (!pendingPlan) return false;
        if (decision.kind === "approve") {
          const pending = pendingPlan;
          currentPermissionMode = decision.permissionMode;
          settlePendingPlan({
            behavior: "allow",
            updatedInput: pending.input,
            updatedPermissions: [{
              type: "setMode",
              mode: decision.permissionMode as ClaudePermissionMode,
              destination: "session",
            }],
          });
          return true;
        }
        settlePendingPlan({ behavior: "deny", message: formatPlanRevisionFeedback(decision.feedback) });
        return true;
      },

      async streamInput(input: AsyncIterable<unknown>): Promise<void> {
        const q = await qPromise;
        await q.streamInput(input as AsyncIterable<SDKUserMessage>);
      },

      async interrupt(): Promise<void> {
        const q = await qPromise;
        await q.interrupt();
      },
    };
  }

  /** Build the multi-turn user-message payload expected by Claude Code SDK. */
  buildUserMessage(text: string, _sessionId: string): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
  }
}
