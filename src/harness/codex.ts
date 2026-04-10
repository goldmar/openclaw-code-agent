/**
 * Codex harness backed by the Codex App Server protocol over stdio.
 *
 * This file is intentionally small now: transport lives in `codex-rpc`,
 * protocol normalization/builders live in `codex-protocol`, and the harness
 * here just coordinates launch/resume/interrupt with the shared contract.
 */

import type { PlanArtifact, PlanArtifactStep } from "../types";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessSession,
} from "./types";
import type { JsonRpcClient } from "./codex-rpc";
import { StdioJsonRpcClient } from "./codex-rpc";
import {
  createBackendRefEvent,
  createPendingInputEvent,
  createPendingInputResolvedEvent,
  createPlanArtifactEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  createSettingsChangedEvent,
  createTextDeltaEvent,
  HarnessMessageQueue,
} from "./harness-events";
import {
  buildPendingInputState,
  buildThreadResumePayloads,
  buildThreadStartPayloads,
  buildTurnInterruptPayloads,
  buildTurnStartPayloads,
  codexExecutionPolicyForMode,
  deriveWorktreeIdFromPath,
  extractAssistantNotificationText,
  classifyTerminalOutcome,
  extractCompletedPlanText,
  extractIds,
  extractPlanDeltaNotification,
  extractTerminalMessage,
  extractThreadState,
  extractTurnPlanUpdate,
  isInteractiveServerRequest,
  isNativeCodexWorktreePath,
  normalizeTerminalStatus,
  parseCsvEnv,
  requestWithFallbacks,
} from "./codex-protocol";

interface CodexHarnessDeps {
  createClient?: (settings: {
    command: string;
    args: string[];
    requestTimeoutMs: number;
  }) => JsonRpcClient;
}

type CodexPendingInput = {
  requestId: string;
  methodLower: string;
  state: import("../types").PendingInputState;
  options: string[];
  actions: import("../types").PendingInputAction[];
  resolveResponse: (payload: unknown) => void;
};

const DEFAULT_PROTOCOL_VERSION = "1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const OPENCLAW_CODEX_APP_SERVER_COMMAND_ENV = "OPENCLAW_CODEX_APP_SERVER_COMMAND";
const OPENCLAW_CODEX_APP_SERVER_ARGS_ENV = "OPENCLAW_CODEX_APP_SERVER_ARGS";
const OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS_ENV = "OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return String(message);
  const record = message as { message?: { content?: unknown }; text?: unknown };
  if (typeof record.message?.content === "string") return record.message.content;
  if (typeof record.text === "string") return record.text;
  return String(message);
}

export class CodexHarness implements AgentHarness {
  readonly name = "codex";
  readonly backendKind = "codex-app-server" as const;
  readonly supportedPermissionModes = [
    "default",
    "plan",
    "bypassPermissions",
  ] as const;
  readonly capabilities = {
    nativePendingInput: true,
    nativePlanArtifacts: true,
    worktrees: "native-restore",
  } as const;

  constructor(private readonly deps: CodexHarnessDeps = {}) {}

  launch(options: HarnessLaunchOptions): HarnessSession {
    const clientSettings = {
      command: process.env[OPENCLAW_CODEX_APP_SERVER_COMMAND_ENV]?.trim() || "codex",
      args: parseCsvEnv(process.env[OPENCLAW_CODEX_APP_SERVER_ARGS_ENV]),
      requestTimeoutMs:
        Number.parseInt(process.env[OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS_ENV] ?? String(DEFAULT_REQUEST_TIMEOUT_MS), 10)
        || DEFAULT_REQUEST_TIMEOUT_MS,
    };
    const client = this.deps.createClient?.(clientSettings)
      ?? new StdioJsonRpcClient(
        clientSettings.command,
        clientSettings.args,
        clientSettings.requestTimeoutMs,
      );

    const queue = new HarnessMessageQueue();
    let threadId = options.resumeSessionId;
    let turnId: string | undefined;
    let backendWorktreePath = options.backendRef?.worktreePath;
    let backendWorktreeId = options.backendRef?.worktreeId;
    let currentPermissionMode = options.permissionMode ?? "default";
    let currentPendingInput: CodexPendingInput | undefined;
    let runCounter = 0;
    let planExplanation = "";
    let planSteps: PlanArtifactStep[] = [];
    let activeTurnCompletion:
      | {
          resolve: () => void;
          method?: string;
          params?: unknown;
        }
      | undefined;
    const planDraftByItemId = new Map<string, string>();
    const assistantStreamByItemId = new Set<string>();

    const updateBackendWorktree = (candidatePath: string | undefined): void => {
      const trimmed = candidatePath?.trim();
      if (!trimmed) return;
      const originalWorkdir = options.originalWorkdir?.trim() || options.cwd.trim();
      const worktreesEnabled = !!options.worktreeStrategy && options.worktreeStrategy !== "off";
      if (!worktreesEnabled) return;
      if (trimmed === originalWorkdir) return;
      if (!isNativeCodexWorktreePath(trimmed)) return;
      backendWorktreePath = trimmed;
      backendWorktreeId = deriveWorktreeIdFromPath(trimmed);
    };

    const emitBackendRef = (): void => {
      if (!threadId) return;
      queue.enqueue(createBackendRefEvent({
        kind: "codex-app-server",
        conversationId: threadId,
        ...(turnId ? { runId: turnId } : {}),
        ...(backendWorktreeId ? { worktreeId: backendWorktreeId } : {}),
        ...(backendWorktreePath ? { worktreePath: backendWorktreePath } : {}),
      }));
    };

    client.setNotificationHandler(async (method, params) => {
      const methodLower = method.trim().toLowerCase();
      const ids = extractIds(params);
      const threadState = extractThreadState(params);
      if (ids.threadId && threadId && ids.threadId !== threadId) return;
      if (ids.threadId) {
        threadId = ids.threadId;
      }
      if (ids.runId) {
        turnId = ids.runId;
      }
      updateBackendWorktree(threadState.cwd);
      if (ids.threadId || ids.runId || threadState.cwd) {
        emitBackendRef();
      }

      if (methodLower === "serverrequest/resolved") {
        if (currentPendingInput) {
          queue.enqueue(createPendingInputResolvedEvent(currentPendingInput.requestId));
          currentPendingInput = undefined;
        }
        return;
      }

      if (methodLower === "turn/plan/updated") {
        const update = extractTurnPlanUpdate(params);
        planExplanation = update.explanation ?? planExplanation;
        if (update.steps.length > 0) {
          planSteps = update.steps;
        }
        return;
      }

      if (methodLower === "item/plan/delta") {
        const delta = extractPlanDeltaNotification(params);
        if (delta.itemId && delta.delta) {
          const existing = planDraftByItemId.get(delta.itemId) ?? "";
          planDraftByItemId.set(delta.itemId, `${existing}${delta.delta}`);
        }
        return;
      }

      if (methodLower === "item/completed") {
        const completedPlan = extractCompletedPlanText(params);
        if (completedPlan.text?.trim()) {
          const artifact: PlanArtifact = {
            explanation: planExplanation || undefined,
            steps: planSteps,
            markdown: completedPlan.text.trim(),
          };
          queue.enqueue(createPlanArtifactEvent(artifact, true));
          return;
        }
      }

      const assistant = extractAssistantNotificationText(methodLower, params);
      if (assistant.mode === "delta" && assistant.text) {
        if (assistant.itemId) {
          assistantStreamByItemId.add(assistant.itemId);
        }
        queue.enqueue(createTextDeltaEvent(assistant.text));
        return;
      }
      if (assistant.mode === "snapshot" && assistant.text) {
        if (!assistant.itemId || !assistantStreamByItemId.has(assistant.itemId)) {
          queue.enqueue(createTextDeltaEvent(assistant.text));
        }
      }

      if (methodLower === "turn/completed" || methodLower === "turn/failed" || methodLower === "turn/cancelled") {
        if (activeTurnCompletion) {
          activeTurnCompletion.method = method;
          activeTurnCompletion.params = params;
          activeTurnCompletion.resolve();
        }
      }
    });

    client.setRequestHandler(async (method, params) => {
      if (!isInteractiveServerRequest(method)) {
        return {};
      }

      const ids = extractIds(params);
      const threadState = extractThreadState(params);
      if (ids.threadId && threadId && ids.threadId !== threadId) {
        return {};
      }
      if (ids.threadId) {
        threadId = ids.threadId;
      }
      if (ids.runId) {
        turnId = ids.runId;
      }
      updateBackendWorktree(threadState.cwd);
      if (ids.threadId || ids.runId || threadState.cwd) {
        emitBackendRef();
      }

      const requestId = ids.requestId ?? `${threadId ?? "codex"}-${Date.now().toString(36)}`;
      const state = buildPendingInputState(method, requestId, params);
      const methodLower = method.trim().toLowerCase();
      const options = state.options;
      const actions = state.actions ?? [];
      const response = await new Promise<unknown>((resolve) => {
        currentPendingInput = {
          requestId,
          methodLower,
          state,
          options,
          actions,
          resolveResponse: resolve,
        };
        queue.enqueue(createPendingInputEvent(state));
      });
      currentPendingInput = undefined;
      queue.enqueue(createPendingInputResolvedEvent(requestId));
      return response;
    });

    const initialize = async (): Promise<void> => {
      await client.connect();
      await client.request("initialize", {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        clientInfo: { name: "openclaw-code-agent", version: "3.1.0" },
        capabilities: { experimentalApi: true },
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      await client.notify("initialized", {});
    };

    const ensureThread = async (): Promise<void> => {
      const executionPolicy = codexExecutionPolicyForMode(
        currentPermissionMode,
        options.codexApprovalPolicy,
      );
      if (threadId) {
        const resumed = await requestWithFallbacks({
          client,
          methods: ["thread/resume"],
          payloads: buildThreadResumePayloads({
            threadId,
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            approvalPolicy: executionPolicy.approvalPolicy,
            sandbox: executionPolicy.sandbox,
          }),
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        });
        const state = extractThreadState(resumed);
        threadId = state.threadId ?? threadId;
        updateBackendWorktree(state.cwd);
        emitBackendRef();
        return;
      }

      const started = await requestWithFallbacks({
        client,
        methods: ["thread/start", "thread/new"],
        payloads: buildThreadStartPayloads({
          cwd: options.originalWorkdir?.trim() || options.cwd,
          model: options.model,
          approvalPolicy: executionPolicy.approvalPolicy,
          sandbox: executionPolicy.sandbox,
        }),
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      });
      const state = extractThreadState(started);
      threadId = state.threadId;
      if (!threadId) {
        throw new Error("Codex App Server did not return a thread id.");
      }
      updateBackendWorktree(state.cwd);
      emitBackendRef();
    };

    const runTurn = async (prompt: string): Promise<void> => {
      await ensureThread();
      queue.enqueue(createRunStartedEvent());
      runCounter += 1;
      planExplanation = "";
      planSteps = [];
      planDraftByItemId.clear();
      assistantStreamByItemId.clear();

      let terminalMethod = "";
      let terminalParams: unknown;
      let completionResolve!: () => void;
      const completion = new Promise<void>((resolve) => {
        completionResolve = resolve;
      });
      activeTurnCompletion = { resolve: completionResolve };

      try {
        const executionPolicy = codexExecutionPolicyForMode(
          currentPermissionMode,
          options.codexApprovalPolicy,
        );
        const started = await requestWithFallbacks({
          client,
          methods: ["turn/start"],
          payloads: buildTurnStartPayloads({
            threadId: threadId!,
            prompt,
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            systemPrompt: options.systemPrompt,
            permissionMode: currentPermissionMode,
            approvalPolicy: executionPolicy.approvalPolicy,
            sandbox: executionPolicy.sandbox,
          }),
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        });
        const ids = extractIds(started);
        if (ids.runId) {
          turnId = ids.runId;
          emitBackendRef();
        }

        await completion;
        terminalMethod = activeTurnCompletion?.method ?? "turn/failed";
        terminalParams = activeTurnCompletion?.params;
        const outcome = classifyTerminalOutcome(terminalMethod, terminalParams);
        queue.enqueue(createRunCompletedEvent({
          success: outcome === "completed",
          outcome,
          duration_ms: 0,
          total_cost_usd: 0,
          num_turns: runCounter,
          result: extractTerminalMessage(terminalMethod, terminalParams),
          session_id: threadId!,
        }));
      } catch (error) {
        queue.enqueue(createRunCompletedEvent({
          success: false,
          duration_ms: 0,
          total_cost_usd: 0,
          num_turns: runCounter,
          result: errorMessage(error),
          session_id: threadId ?? "",
        }));
      } finally {
        activeTurnCompletion = undefined;
      }
    };

    const submitPendingInputText = async (text: string): Promise<boolean> => {
      if (!currentPendingInput) return false;
      if (currentPendingInput.methodLower.includes("requestapproval")) {
        currentPendingInput.resolveResponse({ decision: text.trim() || "decline" });
      } else {
        currentPendingInput.resolveResponse({ text: text.trim() });
      }
      return true;
    };

    const submitPendingInputOption = async (index: number): Promise<boolean> => {
      const pending = currentPendingInput;
      if (!pending) return false;
      const action = pending.actions[index];
      if (action?.kind === "approval") {
        pending.resolveResponse({
          decision: action.responseDecision,
          ...(action.proposedExecpolicyAmendment
            ? { proposedExecpolicyAmendment: action.proposedExecpolicyAmendment }
            : {}),
        });
        return true;
      }
      const option = pending.options[index];
      if (!option) return false;
      if (pending.methodLower.includes("requestapproval")) {
        pending.resolveResponse({ decision: option });
      } else {
        pending.resolveResponse({ option, index });
      }
      return true;
    };

    const promptIterable = typeof options.prompt === "string"
      ? (async function* (): AsyncGenerator<unknown> {
          yield { type: "user", text: options.prompt, session_id: options.resumeSessionId ?? "" };
        })()
      : options.prompt;

    void (async () => {
      try {
        await initialize();
        for await (const rawMessage of promptIterable) {
          const text = extractPromptText(rawMessage).trim();
          if (!text) continue;
          const handledPending = await submitPendingInputText(text);
          if (handledPending) continue;
          await runTurn(text);
        }
      } catch (error) {
        queue.enqueue(createRunCompletedEvent({
          success: false,
          duration_ms: 0,
          total_cost_usd: 0,
          num_turns: runCounter,
          result: errorMessage(error),
          session_id: threadId ?? options.resumeSessionId ?? "",
        }));
      } finally {
        await client.close().catch((): undefined => undefined);
        queue.close();
      }
    })();

    return {
      messages: queue.messages(),

      async setPermissionMode(mode: string): Promise<void> {
        currentPermissionMode = mode;
        queue.enqueue(createSettingsChangedEvent(mode));
      },

      async submitPendingInputOption(index: number): Promise<boolean> {
        return submitPendingInputOption(index);
      },

      async submitPendingInputText(text: string): Promise<boolean> {
        return submitPendingInputText(text);
      },

      async interrupt(): Promise<void> {
        if (!threadId || !turnId) return;
        await requestWithFallbacks({
          client,
          methods: ["turn/interrupt"],
          payloads: buildTurnInterruptPayloads({ threadId, turnId }),
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        }).catch((): undefined => undefined);
      },
    };
  }

  buildUserMessage(text: string, sessionId: string): unknown {
    return { type: "user", text, session_id: sessionId };
  }
}
