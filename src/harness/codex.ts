/**
 * Codex harness backed by the Codex App Server protocol over stdio.
 *
 * Transport lives in `codex-rpc`, typed request builders and server-request
 * translation live in `codex-protocol`, and the wire types are vendored from
 * `codex app-server generate-ts` in `codex-app-server-protocol/`. This file
 * coordinates one app-server connection per OCA session: thread
 * start/resume/fork, turns, steering, interrupts, approvals, and thread
 * actions (compact, review).
 */

// Named import: the bundler keeps only `version`, not the whole package.json.
import { version as packageVersion } from "../../package.json";
import { getHarnessConfig } from "../config";
import { getPluginRuntime, getRuntimeConfig } from "../runtime-store";
import type { PendingInputState, PlanArtifact, PlanArtifactStep, ThreadAction } from "../types";
import type {
  AgentHarness,
  HarnessBackendInfo,
  HarnessLaunchOptions,
  HarnessSession,
} from "./types";
import type { JsonRpcClient, JsonRpcId } from "./codex-rpc";
import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcResponseError, StdioJsonRpcClient } from "./codex-rpc";
import {
  codexAccountType,
  estimateCodexApiCostUsd,
  tokenUsageFromBreakdown,
  type CodexAccountType,
} from "./codex-cost";
import {
  createBackendRefEvent,
  createPendingInputEvent,
  createPendingInputResolvedEvent,
  createPlanArtifactEvent,
  createRunCompletedEvent,
  createPromptSettledEvent,
  createRunStartedEvent,
  createSettingsChangedEvent,
  createTextDeltaEvent,
  HarnessMessageQueue,
  PromptReader,
} from "./harness-events";
import { formatPendingInputWizardQuestion, resolvePendingInputAnswer } from "../pending-input-normalization";
import { canonicalizeModelForHarness, isModelFormatSupportedForHarness } from "../harness-models";
import {
  buildCommandApprovalRequest,
  buildFileChangeApprovalRequest,
  buildPermissionsApprovalRequest,
  buildReviewStartParams,
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  buildTurnSteerParams,
  buildUserInputRequest,
  classifyTurnOutcome,
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_PERMISSIONS_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  codexRequest,
  mapTurnPlanSteps,
  matchApprovalChoiceFromText,
  readOpenClawExecMode,
  resolveCodexExecutionSettings,
  turnErrorMessage,
  type CodexApprovalChoice,
  type CodexPendingRequest,
} from "./codex-protocol";
import { refreshCodexModelCatalog, type CodexModelInfo } from "./codex-model-catalog";
import {
  describeCodexLimitReset,
  mergeCodexRateLimitsUpdate,
  recordCodexRateLimits,
  releaseCodexRateLimits,
  unreportedCodexAccountKey,
} from "./codex-rate-limits";
import type { ThreadForkResponse, ThreadResumeResponse, ThreadStartResponse } from "./codex-app-server-protocol";
import type { AccountRateLimitsUpdatedNotification } from "./codex-app-server-protocol/v2/AccountRateLimitsUpdatedNotification";
import type { AgentMessageDeltaNotification } from "./codex-app-server-protocol/v2/AgentMessageDeltaNotification";
import type { CommandExecutionRequestApprovalParams } from "./codex-app-server-protocol/v2/CommandExecutionRequestApprovalParams";
import type { DynamicToolCallResponse } from "./codex-app-server-protocol/v2/DynamicToolCallResponse";
import type { FileChangeRequestApprovalParams } from "./codex-app-server-protocol/v2/FileChangeRequestApprovalParams";
import type { ItemCompletedNotification } from "./codex-app-server-protocol/v2/ItemCompletedNotification";
import type { McpServerElicitationRequestResponse } from "./codex-app-server-protocol/v2/McpServerElicitationRequestResponse";
import type { ModelReroutedNotification } from "./codex-app-server-protocol/v2/ModelReroutedNotification";
import type { PermissionsRequestApprovalParams } from "./codex-app-server-protocol/v2/PermissionsRequestApprovalParams";
import type { ServerRequestResolvedNotification } from "./codex-app-server-protocol/v2/ServerRequestResolvedNotification";
import type { ThreadSettingsUpdatedNotification } from "./codex-app-server-protocol/v2/ThreadSettingsUpdatedNotification";
import type { ThreadTokenUsageUpdatedNotification } from "./codex-app-server-protocol/v2/ThreadTokenUsageUpdatedNotification";
import type { ToolRequestUserInputParams } from "./codex-app-server-protocol/v2/ToolRequestUserInputParams";
import type { Turn } from "./codex-app-server-protocol/v2/Turn";
import type { TurnCompletedNotification } from "./codex-app-server-protocol/v2/TurnCompletedNotification";
import type { TurnPlanUpdatedNotification } from "./codex-app-server-protocol/v2/TurnPlanUpdatedNotification";
import type { TurnStartedNotification } from "./codex-app-server-protocol/v2/TurnStartedNotification";
import { createLogger } from "../logger";

const log = createLogger("codex");

interface CodexHarnessDeps {
  createClient?: (settings: {
    command: string;
    args: string[];
    requestTimeoutMs: number;
  }) => JsonRpcClient;
}

/** An in-flight server request surfaced to OCA's pending-input UI. */
type CodexPendingInput = {
  requestId: string;
  request: CodexPendingRequest;
  state: PendingInputState;
  answers: Record<string, { answers: string[] }>;
  resolveResponse: (payload: unknown) => void;
};

type ActiveTurn = {
  kind: "user" | "compact" | "review";
  turnId?: string;
  interruptRequested: boolean;
  terminal?: Turn;
  failure?: string;
  resolve: () => void;
};

/** Queued control message for thread actions (see `buildThreadActionMessage`). */
type CodexThreadActionMessage = { type: "codex_thread_action"; action: ThreadAction };

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_APP_SERVER_ARGS = ["--listen", "stdio://"];
const AUXILIARY_READ_TIMEOUT_MS = 5_000;
const OPENCLAW_CODEX_APP_SERVER_COMMAND_ENV = "OPENCLAW_CODEX_APP_SERVER_COMMAND";
const OPENCLAW_CODEX_APP_SERVER_ARGS_ENV = "OPENCLAW_CODEX_APP_SERVER_ARGS";
const OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS_ENV = "OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS";
const CODEX_APP_SERVER_SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * High-volume notifications OCA never consumes. Opting out keeps the stdio
 * stream (and the event loop) quiet during long command output or reasoning.
 */
const OPTED_OUT_NOTIFICATIONS = [
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/plan/delta",
  "command/exec/outputDelta",
];

/**
 * The host `tools.exec.mode` at launch time: the live config when the runtime
 * exposes it, else the snapshot taken at service start.
 */
function readHostExecMode(): ReturnType<typeof readOpenClawExecMode> {
  let config: unknown;
  try {
    config = getPluginRuntime()?.config.current();
  } catch {
    config = undefined;
  }
  return readOpenClawExecMode(config ?? getRuntimeConfig());
}

function normalizeCodexAppServerSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && CODEX_APP_SERVER_SESSION_ID_RE.test(trimmed)
    ? trimmed
    : undefined;
}

export function isCodexAppServerSessionId(value: string | undefined): value is string {
  return normalizeCodexAppServerSessionId(value) !== undefined;
}

function parseRequestTimeoutMs(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!/^\d+$/.test(trimmed)) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lifecycle events log at debug; declines, failures, and anomalies at warn. */
const WARN_HARNESS_EVENTS = new Set([
  "pending_input.concurrent_declined",
  "server_request.unsupported",
  "model.list.unavailable",
  "account.read.unavailable",
  "rate_limits.read.unavailable",
  "turn.error",
  "session.error",
  "action.rejected",
]);

function logCodexHarnessDiagnostic(event: string, fields: Record<string, unknown>): void {
  const emit = WARN_HARNESS_EVENTS.has(event) ? log.warn : log.debug;
  emit(JSON.stringify({
    component: "CodexHarness",
    event,
    at: new Date().toISOString(),
    ...fields,
  }));
}

function clientSettingsDiagnosticFields(settings: { command: string; args: readonly string[]; requestTimeoutMs: number }): Record<string, unknown> {
  return {
    commandKind: settings.command === "codex" ? "codex" : "custom",
    configuredArgCount: settings.args.length,
    requestTimeoutMs: settings.requestTimeoutMs,
  };
}

function threadDiagnosticFields(args: { threadId?: string; turnId?: string }): Record<string, unknown> {
  return {
    hasThreadId: Boolean(args.threadId),
    hasTurnId: Boolean(args.turnId),
  };
}

function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return String(message);
  const record = message as { message?: { content?: unknown }; text?: unknown };
  if (typeof record.message?.content === "string") return record.message.content;
  if (typeof record.text === "string") return record.text;
  return String(message);
}

function asThreadActionMessage(message: unknown): CodexThreadActionMessage | undefined {
  return message
    && typeof message === "object"
    && (message as { type?: unknown }).type === "codex_thread_action"
    ? message as CodexThreadActionMessage
    : undefined;
}

function notificationThreadId(params: unknown): string | undefined {
  const threadId = params && typeof params === "object" ? (params as { threadId?: unknown }).threadId : undefined;
  return typeof threadId === "string" ? threadId : undefined;
}

function updateCodexWizardState(
  base: PendingInputState,
  activeQuestionIndex: number,
  answers: Record<string, { answers: string[] }>,
): PendingInputState {
  const questions = base.questions ?? [];
  const activeQuestion = questions[activeQuestionIndex];
  if (!activeQuestion) return base;
  return {
    ...base,
    promptText: formatPendingInputWizardQuestion(activeQuestion, activeQuestionIndex, questions.length),
    options: activeQuestion.options.map((option) => option.label),
    actions: activeQuestion.options.map((option) => ({ kind: "option", label: option.label, value: option.value ?? option.label })),
    activeQuestionIndex,
    answers,
  };
}

const DECLINED_ELICITATION: McpServerElicitationRequestResponse = { action: "decline", content: null, _meta: null };
const DECLINED_DYNAMIC_TOOL: DynamicToolCallResponse = {
  contentItems: [{ type: "inputText", text: "OpenClaw Code Agent does not register dynamic tools; this call was declined." }],
  success: false,
};

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
    threadActions: ["compact", "review"],
  } as const;

  constructor(private readonly deps: CodexHarnessDeps = {}) {}

  launch(options: HarnessLaunchOptions): HarnessSession {
    const clientSettings = {
      command: process.env[OPENCLAW_CODEX_APP_SERVER_COMMAND_ENV]?.trim() || "codex",
      args: resolveAppServerArgs(process.env[OPENCLAW_CODEX_APP_SERVER_ARGS_ENV]),
      requestTimeoutMs: parseRequestTimeoutMs(process.env[OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS_ENV]),
    };
    const timeoutMs = clientSettings.requestTimeoutMs;
    const client = this.deps.createClient?.(clientSettings)
      ?? new StdioJsonRpcClient(
        clientSettings.command,
        clientSettings.args,
        clientSettings.requestTimeoutMs,
      );
    const execution = resolveCodexExecutionSettings(getHarnessConfig("codex"), readHostExecMode());

    const queue = new HarnessMessageQueue();
    let threadId = normalizeCodexAppServerSessionId(options.resumeSessionId);
    if (options.resumeSessionId && !threadId) {
      log.warn("[CodexHarness] Ignoring invalid Codex App Server resume session id. Expected a Codex thread UUID.");
    }
    let threadReady = false;
    let forkPending = options.forkSession === true && !!threadId;
    let rewindTurns = options.rewindTurns && options.rewindTurns > 0 ? Math.floor(options.rewindTurns) : 0;
    let lastTurnId: string | undefined;
    let currentPermissionMode = options.permissionMode ?? "default";
    const runtimeModel = canonicalizeModelForHarness(this.name, options.model);
    if (!isModelFormatSupportedForHarness(this.name, runtimeModel)) {
      throw new Error(`Codex model "${options.model}" is not supported. Use a bare Codex model id such as "gpt-6-sol" or "gpt-6-astra".`);
    }
    let threadModel: string | undefined;
    let effectiveModel = runtimeModel;
    let serviceTier: string | null | undefined;
    let accountType: CodexAccountType | undefined;
    // Rate limits are account-scoped; updates on this connection belong to it.
    let rateLimitAccountKey: string | undefined;
    // This connection's own model/list result: another app server (other
    // CODEX_HOME, account, or version) may support different efforts.
    let connectionModels: CodexModelInfo[] | undefined;
    let currentPendingInput: CodexPendingInput | undefined;
    let activeTurn: ActiveTurn | undefined;
    let runCounter = 0;
    let cumulativeCostUsd = 0;
    let lastPricedTotalTokens: number | undefined;
    let planExplanation = "";
    let planSteps: PlanArtifactStep[] = [];
    const streamedAgentItemIds = new Set<string>();
    // Set once the handle or the app server closed: nothing may start afterwards.
    let closed = false;
    const promptIterable = typeof options.prompt === "string"
      ? (async function* (): AsyncGenerator<unknown> {
          yield { type: "user", text: options.prompt };
        })()
      : options.prompt;
    const prompts = new PromptReader(promptIterable);
    let emittedText = false;

    const emitBackendRef = (): void => {
      if (!threadId) return;
      queue.enqueue(createBackendRefEvent({
        kind: "codex-app-server",
        conversationId: threadId,
        ...(lastTurnId ? { runId: lastTurnId } : {}),
      }));
    };

    const noteTurnId = (turnId: string): void => {
      if (activeTurn && !activeTurn.turnId) activeTurn.turnId = turnId;
      if (lastTurnId !== turnId) {
        lastTurnId = turnId;
        emitBackendRef();
      }
    };

    /** Separate consecutive agent messages so agent_output does not run them together. */
    const emitMessageSeparator = (): void => {
      if (emittedText) queue.enqueue(createTextDeltaEvent("\n\n"));
    };

    const finishActiveTurn = (update: { terminal?: Turn; failure?: string }): void => {
      if (!activeTurn) return;
      activeTurn.terminal ??= update.terminal;
      activeTurn.failure ??= update.failure;
      activeTurn.resolve();
    };

    const resolvePendingInput = (payload: unknown): void => {
      const pending = currentPendingInput;
      if (!pending) return;
      currentPendingInput = undefined;
      pending.resolveResponse(payload);
      queue.enqueue(createPendingInputResolvedEvent(pending.requestId));
    };

    const priceTokenUsage = (params: ThreadTokenUsageUpdatedNotification): void => {
      const total = params.tokenUsage.total.totalTokens;
      // Only price responses produced by the turn we are running, once each.
      if (!activeTurn?.turnId || params.turnId !== activeTurn.turnId) {
        lastPricedTotalTokens = total;
        return;
      }
      if (lastPricedTotalTokens !== undefined && total <= lastPricedTotalTokens) return;
      lastPricedTotalTokens = total;
      if (accountType !== "apiKey") return;
      const usage = tokenUsageFromBreakdown(params.tokenUsage.last);
      if (!usage) return;
      const cost = estimateCodexApiCostUsd({ model: effectiveModel ?? threadModel, serviceTier, usage });
      if (cost === undefined) return;
      cumulativeCostUsd += cost;
      // Report the running total so status views show spend mid-turn (for
      // example while the turn waits on an approval or a question).
      queue.enqueue({ type: "usage_updated", usage: { costUsd: cumulativeCostUsd } });
    };

    client.setCloseHandler?.(() => {
      closed = true;
      finishActiveTurn({ failure: "Codex App Server exited before the turn completed." });
    });

    client.setNotificationHandler(async (method, params) => {
      const notifiedThreadId = notificationThreadId(params);
      if (notifiedThreadId && threadId && notifiedThreadId !== threadId) return;

      switch (method) {
        case "turn/started": {
          const { turn } = params as TurnStartedNotification;
          noteTurnId(turn.id);
          return;
        }
        case "turn/completed": {
          const { turn } = params as TurnCompletedNotification;
          if (activeTurn && (!activeTurn.turnId || activeTurn.turnId === turn.id)) {
            noteTurnId(turn.id);
            finishActiveTurn({ terminal: turn });
          }
          return;
        }
        case "serverRequest/resolved": {
          const { requestId } = params as ServerRequestResolvedNotification;
          if (currentPendingInput && currentPendingInput.requestId === String(requestId)) {
            // Codex resolved the request itself (e.g. the turn was interrupted);
            // our late answer is ignored by the server.
            resolvePendingInput(currentPendingInput.request.kind === "approval"
              ? currentPendingInput.request.declineResponse
              : { answers: {} });
          }
          return;
        }
        case "model/rerouted": {
          const { toModel } = params as ModelReroutedNotification;
          if (toModel.trim()) effectiveModel = toModel.trim();
          return;
        }
        case "thread/settings/updated": {
          const { threadSettings } = params as ThreadSettingsUpdatedNotification;
          serviceTier = threadSettings.serviceTier;
          threadModel = threadSettings.model || threadModel;
          return;
        }
        case "thread/tokenUsage/updated":
          priceTokenUsage(params as ThreadTokenUsageUpdatedNotification);
          return;
        case "account/rateLimits/updated":
          if (rateLimitAccountKey) {
            mergeCodexRateLimitsUpdate(rateLimitAccountKey, (params as AccountRateLimitsUpdatedNotification).rateLimits);
          }
          return;
        case "turn/plan/updated": {
          const update = params as TurnPlanUpdatedNotification;
          planExplanation = update.explanation ?? planExplanation;
          if (update.plan.length > 0) planSteps = mapTurnPlanSteps(update.plan);
          return;
        }
        case "item/agentMessage/delta": {
          const delta = params as AgentMessageDeltaNotification;
          if (!delta.delta) return;
          if (!streamedAgentItemIds.has(delta.itemId)) {
            streamedAgentItemIds.add(delta.itemId);
            emitMessageSeparator();
          }
          emittedText = true;
          queue.enqueue(createTextDeltaEvent(delta.delta));
          return;
        }
        case "item/completed": {
          const { item } = params as ItemCompletedNotification;
          if (item.type === "plan" && item.text.trim()) {
            const artifact: PlanArtifact = {
              explanation: planExplanation || undefined,
              steps: planSteps,
              markdown: item.text.trim(),
            };
            queue.enqueue(createPlanArtifactEvent(artifact, true));
          } else if (item.type === "agentMessage" && item.text && !streamedAgentItemIds.has(item.id)) {
            emitMessageSeparator();
            emittedText = true;
            queue.enqueue(createTextDeltaEvent(item.text));
          } else if (item.type === "contextCompaction") {
            emitMessageSeparator();
            emittedText = true;
            queue.enqueue(createTextDeltaEvent("[Codex] Conversation context compacted."));
          }
          return;
        }
        default:
          return;
      }
    });

    const awaitPendingInput = (requestId: JsonRpcId, request: CodexPendingRequest): Promise<unknown> => {
      if (currentPendingInput) {
        // Codex serializes interactive requests per turn; decline a second
        // concurrent one rather than silently replacing the visible prompt.
        logCodexHarnessDiagnostic("pending_input.concurrent_declined", { requestKind: request.kind });
        return Promise.resolve(request.kind === "approval" ? request.declineResponse : { answers: {} });
      }
      return new Promise<unknown>((resolve) => {
        currentPendingInput = {
          requestId: String(requestId),
          request,
          state: request.state,
          answers: {},
          resolveResponse: resolve,
        };
        queue.enqueue(createPendingInputEvent(request.state));
      });
    };

    client.setRequestHandler(async (method, params, id) => {
      const requestId = String(id);
      switch (method) {
        case CODEX_COMMAND_APPROVAL_METHOD:
          return await awaitPendingInput(id, buildCommandApprovalRequest(requestId, params as CommandExecutionRequestApprovalParams));
        case CODEX_FILE_CHANGE_APPROVAL_METHOD:
          return await awaitPendingInput(id, buildFileChangeApprovalRequest(requestId, params as FileChangeRequestApprovalParams));
        case CODEX_PERMISSIONS_APPROVAL_METHOD:
          return await awaitPendingInput(id, buildPermissionsApprovalRequest(requestId, params as PermissionsRequestApprovalParams));
        case CODEX_USER_INPUT_METHOD: {
          let request: CodexPendingRequest;
          try {
            request = buildUserInputRequest(requestId, params as ToolRequestUserInputParams);
          } catch (error) {
            log.warn(`[CodexHarness] ${errorMessage(error)}`);
            throw error;
          }
          return await awaitPendingInput(id, request);
        }
        case "mcpServer/elicitation/request":
          // OCA has no UI for MCP elicitation forms/URLs; decline explicitly.
          logCodexHarnessDiagnostic("server_request.declined", { method });
          return DECLINED_ELICITATION;
        case "item/tool/call":
          logCodexHarnessDiagnostic("server_request.declined", { method });
          return DECLINED_DYNAMIC_TOOL;
        case "currentTime/read":
          return { currentTimeAt: Math.floor(Date.now() / 1000) };
        case "account/chatgptAuthTokens/refresh":
          // Only sent to clients that log in with externally managed ChatGPT
          // tokens; OCA always lets Codex manage its own credentials.
          throw new JsonRpcResponseError(JSON_RPC_METHOD_NOT_FOUND, "OpenClaw Code Agent does not manage ChatGPT auth tokens; Codex must use its own login.");
        default:
          logCodexHarnessDiagnostic("server_request.unsupported", { method });
          throw new JsonRpcResponseError(JSON_RPC_METHOD_NOT_FOUND, `OpenClaw Code Agent does not support server request ${method}.`);
      }
    });

    const initialize = async (): Promise<void> => {
      logCodexHarnessDiagnostic("client.initialize.start", {
        ...clientSettingsDiagnosticFields(clientSettings),
        hasResumeSessionId: Boolean(options.resumeSessionId),
      });
      await client.connect();
      await codexRequest(client, "initialize", {
        clientInfo: { name: "openclaw-code-agent", title: "OpenClaw Code Agent", version: packageVersion },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: OPTED_OUT_NOTIFICATIONS,
        },
      }, timeoutMs);
      await client.notify("initialized", {});
      const auxTimeoutMs = Math.min(timeoutMs, AUXILIARY_READ_TIMEOUT_MS);
      const [account, models] = await Promise.allSettled([
        codexRequest(client, "account/read", { refreshToken: false }, auxTimeoutMs),
        refreshCodexModelCatalog(client, auxTimeoutMs),
      ]);
      if (models.status === "fulfilled") {
        connectionModels = models.value;
      } else {
        logCodexHarnessDiagnostic("model.list.unavailable", { error: errorMessage(models.reason) });
      }
      if (account.status === "fulfilled") {
        accountType = codexAccountType(account.value);
      } else {
        logCodexHarnessDiagnostic("account.read.unavailable", { error: errorMessage(account.reason) });
      }
      if (accountType === "chatgpt") {
        await codexRequest(client, "account/rateLimits/read", undefined, auxTimeoutMs)
          .then((limits) => { rateLimitAccountKey = recordCodexRateLimits(limits, unreportedCodexAccountKey()); })
          .catch((error: unknown) => {
            // Still track this connection's rolling updates under its own key.
            rateLimitAccountKey = unreportedCodexAccountKey();
            logCodexHarnessDiagnostic("rate_limits.read.unavailable", { error: errorMessage(error) });
          });
      }
      logCodexHarnessDiagnostic("client.initialize.done", {
        hasResumeSessionId: Boolean(options.resumeSessionId),
        accountType: accountType ?? "unknown",
      });
    };

    const applyThreadResponse = (response: ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse): void => {
      threadId = response.thread.id;
      threadModel = response.model || threadModel;
      serviceTier = response.serviceTier;
      threadReady = true;
      emitBackendRef();
    };

    const threadOptions = () => ({
      model: runtimeModel,
      fastMode: options.fastMode,
      developerInstructions: options.systemPrompt,
      execution,
    });

    /**
     * Resolve the turn id that starts the last `count` completed turns of a
     * thread, paging past any in-progress turn.
     */
    const resolveRewindBeforeTurnId = async (sourceThreadId: string, count: number): Promise<string> => {
      const finished: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20 && finished.length < count; page += 1) {
        const response = await codexRequest(client, "thread/turns/list", {
          threadId: sourceThreadId,
          limit: count + 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
          ...(cursor ? { cursor } : {}),
        }, timeoutMs);
        for (const turn of response.data) {
          if (turn.status !== "inProgress") finished.push(turn.id);
        }
        cursor = response.nextCursor;
        if (!cursor) break;
      }
      if (finished.length < count) {
        throw new Error(`Cannot rewind ${count} turn(s): the Codex thread only has ${finished.length} completed turn(s).`);
      }
      return finished[count - 1];
    };

    const ensureThread = async (): Promise<void> => {
      if (threadReady) return;
      if (threadId && forkPending) {
        logCodexHarnessDiagnostic("thread.fork.start", { ...threadDiagnosticFields({ threadId }), rewindTurns });
        const beforeTurnId = rewindTurns > 0 ? await resolveRewindBeforeTurnId(threadId, rewindTurns) : undefined;
        const forked = await codexRequest(client, "thread/fork", buildThreadForkParams({
          ...threadOptions(),
          threadId,
          cwd: options.cwd,
          beforeTurnId,
        }), timeoutMs);
        forkPending = false;
        rewindTurns = 0;
        applyThreadResponse(forked);
        logCodexHarnessDiagnostic("thread.fork.done", threadDiagnosticFields({ threadId }));
        return;
      }
      if (threadId) {
        logCodexHarnessDiagnostic("thread.resume.start", { ...threadDiagnosticFields({ threadId }), rewindTurns });
        const resumed = await codexRequest(client, "thread/resume", buildThreadResumeParams({
          ...threadOptions(),
          threadId,
          cwd: options.cwd,
        }), timeoutMs);
        applyThreadResponse(resumed);
        if (rewindTurns > 0) {
          const beforeTurnId = await resolveRewindBeforeTurnId(threadId, rewindTurns);
          await codexRequest(client, "thread/revert", { threadId, beforeTurnId }, timeoutMs);
          logCodexHarnessDiagnostic("thread.revert.done", { ...threadDiagnosticFields({ threadId }), rewindTurns });
          rewindTurns = 0;
        }
        logCodexHarnessDiagnostic("thread.resume.done", threadDiagnosticFields({ threadId }));
        return;
      }
      logCodexHarnessDiagnostic("thread.start.start", { hasCwd: Boolean(options.cwd) });
      const started = await codexRequest(client, "thread/start", buildThreadStartParams({
        ...threadOptions(),
        cwd: options.cwd,
      }), timeoutMs);
      applyThreadResponse(started);
      logCodexHarnessDiagnostic("thread.start.done", threadDiagnosticFields({ threadId }));
    };

    const resolveTurnModel = (): string => {
      const model = runtimeModel ?? threadModel;
      if (!model) throw new Error("Codex App Server did not report the thread model.");
      return model;
    };

    let reportedBackendInfo: string | undefined;
    const resolveTurnEffort = (model: string): string | undefined => {
      const effort = options.reasoningEffort;
      const wanted = model.toLowerCase();
      const info = connectionModels?.find((entry) => entry.id.toLowerCase() === wanted || entry.model.toLowerCase() === wanted);
      const supported = effort && info ? info.supportedReasoningEfforts.includes(effort) : undefined;
      // Report what this connection actually applies so status lines never
      // claim an effort its own server rejected.
      const backendInfo: HarnessBackendInfo = {
        model,
        ...(effort ? { reasoningEffort: supported === false ? null : effort } : {}),
        ...(supported !== undefined ? { reasoningEffortSupported: supported } : {}),
      };
      const serialized = JSON.stringify(backendInfo);
      if (serialized !== reportedBackendInfo) {
        reportedBackendInfo = serialized;
        queue.enqueue({ type: "backend_info", info: backendInfo });
      }
      if (!effort) return undefined;
      if (supported === false) {
        logCodexHarnessDiagnostic("turn.effort.unsupported", { model, effort });
        return undefined;
      }
      return effort;
    };

    /**
     * Run one Codex turn started by `start` and translate its lifecycle into
     * harness events. Every turn kind (user prompt, compaction, review) ends
     * with exactly one `turn/completed`.
     */
    const runTrackedTurn = async (
      kind: ActiveTurn["kind"],
      start: () => Promise<string | undefined>,
    ): Promise<void> => {
      logCodexHarnessDiagnostic("turn.start", {
        ...threadDiagnosticFields({ threadId }),
        kind,
        runCounter: runCounter + 1,
        permissionMode: currentPermissionMode,
      });
      queue.enqueue(createRunStartedEvent());
      runCounter += 1;
      planExplanation = "";
      planSteps = [];
      streamedAgentItemIds.clear();
      // Model reroutes are turn-scoped; begin each turn from the requested model.
      effectiveModel = runtimeModel;

      const completion = new Promise<void>((resolve) => {
        activeTurn = { kind, interruptRequested: false, resolve };
      });
      const turn = activeTurn!;
      try {
        const startedTurnId = await start();
        if (startedTurnId) noteTurnId(startedTurnId);
        await completion;
        if (turn.failure && !turn.terminal) throw new Error(turn.failure);
        const outcome = classifyTurnOutcome(turn.terminal);
        let resultText = turnErrorMessage(turn.terminal);
        const errorInfo = turn.terminal?.error?.codexErrorInfo;
        if (errorInfo === "usageLimitExceeded" || errorInfo === "rateLimitExceeded") {
          const resetHint = rateLimitAccountKey ? describeCodexLimitReset(rateLimitAccountKey) : undefined;
          if (resetHint) resultText = resultText ? `${resultText}\n${resetHint}` : resetHint;
        }
        logCodexHarnessDiagnostic("turn.terminal", {
          ...threadDiagnosticFields({ threadId, turnId: turn.turnId }),
          kind,
          outcome,
        });
        if (await deferResultToQueuedPrompt(outcome === "failed" ? resultText : undefined)) return;
        queue.enqueue(createRunCompletedEvent({
          success: outcome === "completed",
          outcome,
          duration_ms: turn.terminal?.durationMs ?? 0,
          total_cost_usd: cumulativeCostUsd,
          num_turns: runCounter,
          result: resultText,
          session_id: threadId!,
        }));
      } catch (error) {
        logCodexHarnessDiagnostic("turn.error", {
          ...threadDiagnosticFields({ threadId, turnId: turn.turnId }),
          kind,
          error: errorMessage(error),
        });
        if (await deferResultToQueuedPrompt(errorMessage(error))) return;
        queue.enqueue(createRunCompletedEvent({
          success: false,
          duration_ms: 0,
          total_cost_usd: cumulativeCostUsd,
          num_turns: runCounter,
          result: errorMessage(error),
          session_id: threadId ?? "",
        }));
      } finally {
        if (activeTurn === turn) activeTurn = undefined;
        if (currentPendingInput) {
          resolvePendingInput(currentPendingInput.request.kind === "approval"
            ? currentPendingInput.request.declineResponse
            : { answers: {} });
        }
      }
    };

    /**
     * When the next prompt is already queued, report this turn through the next
     * one instead (see PromptReader); a failure stays visible in the output.
     */
    const deferResultToQueuedPrompt = async (failure: string | undefined): Promise<boolean> => {
      if (closed || !(await prompts.hasQueued())) return false;
      if (failure) {
        emitMessageSeparator();
        emittedText = true;
        queue.enqueue(createTextDeltaEvent(`[Codex] Turn failed: ${failure}`));
      }
      logCodexHarnessDiagnostic("turn.result.deferred", threadDiagnosticFields({ threadId, turnId: lastTurnId }));
      return true;
    };

    const assertOpen = (what: string): void => {
      if (closed) {
        logCodexHarnessDiagnostic("action.rejected", { what, ...threadDiagnosticFields({ threadId, turnId: lastTurnId }) });
        throw new Error(`Codex session has ended; cannot run ${what}. Resume the session or start a new one first.`);
      }
    };

    const runUserTurn = async (prompt: string): Promise<void> => {
      assertOpen("a new turn");
      await ensureThread();
      const model = resolveTurnModel();
      await runTrackedTurn("user", async () => {
        const started = await codexRequest(client, "turn/start", buildTurnStartParams({
          threadId: threadId!,
          prompt,
          model,
          reasoningEffort: resolveTurnEffort(model),
          permissionMode: currentPermissionMode,
        }), timeoutMs);
        return started.turn.id;
      });
    };

    const runThreadAction = async (action: ThreadAction): Promise<void> => {
      assertOpen(action.kind === "compact" ? "compact" : "review");
      await ensureThread();
      if (action.kind === "compact") {
        await runTrackedTurn("compact", async () => {
          await codexRequest(client, "thread/compact/start", { threadId: threadId! }, timeoutMs);
          return undefined;
        });
        return;
      }
      await runTrackedTurn("review", async () => {
        const started = await codexRequest(client, "review/start", buildReviewStartParams(threadId!, action.target), timeoutMs);
        return started.turn.id;
      });
    };

    const steer = async (text: string): Promise<boolean> => {
      const turn = activeTurn;
      if (closed || !turn || turn.kind !== "user" || !turn.turnId || turn.interruptRequested || turn.terminal || !threadId) {
        return false;
      }
      try {
        await codexRequest(client, "turn/steer", buildTurnSteerParams({
          threadId,
          expectedTurnId: turn.turnId,
          text,
        }), timeoutMs);
        logCodexHarnessDiagnostic("turn.steer.done", threadDiagnosticFields({ threadId, turnId: turn.turnId }));
        return true;
      } catch (error) {
        // Typically "no active turn" or an expectedTurnId mismatch because the
        // turn just ended; the caller queues the message as a new turn.
        logCodexHarnessDiagnostic("turn.steer.rejected", {
          ...threadDiagnosticFields({ threadId, turnId: turn.turnId }),
          error: errorMessage(error),
        });
        return false;
      }
    };

    const answerQuestion = (pending: CodexPendingInput, questionId: string, answers: string[]): boolean => {
      const questions = pending.state.questions ?? [];
      const activeIndex = pending.state.activeQuestionIndex ?? 0;
      pending.answers = { ...pending.answers, [questionId]: { answers } };
      const nextIndex = activeIndex + 1;
      if (nextIndex < questions.length) {
        pending.state = updateCodexWizardState(pending.state, nextIndex, pending.answers);
        queue.enqueue(createPendingInputEvent(pending.state));
        return true;
      }
      resolvePendingInput({ answers: pending.answers });
      return true;
    };

    const resolveApprovalChoice = (choice: CodexApprovalChoice): void => {
      resolvePendingInput(choice.response);
    };

    const submitPendingInputText = async (text: string): Promise<boolean> => {
      const pending = currentPendingInput;
      if (!pending) return false;
      const answer = text.trim();
      // An empty reply never decides anything, least of all a decline.
      if (!answer) return false;
      if (pending.request.kind === "approval") {
        const choice = matchApprovalChoiceFromText(pending.request.choices, answer);
        if (choice) {
          resolveApprovalChoice(choice);
          return true;
        }
        // Not a decision: decline and hand the text to the agent as feedback.
        resolvePendingInput(pending.request.declineResponse);
        return await steer(answer);
      }
      const questions = pending.state.questions ?? [];
      const question = questions[pending.state.activeQuestionIndex ?? 0];
      if (!question) return false;
      // Option numbers and labels select the option, as in Codex's own TUI.
      const resolved = resolvePendingInputAnswer(question, answer);
      if (!resolved.ok) return false;
      return answerQuestion(pending, question.id, resolved.answers);
    };

    const submitPendingInputOption = async (
      index: number,
      context: { requestId?: string; questionId?: string } = {},
    ): Promise<boolean> => {
      const pending = currentPendingInput;
      if (!pending) return false;
      if (context.requestId && context.requestId !== pending.state.requestId) return false;
      if (pending.request.kind === "approval") {
        const choice = pending.request.choices[index];
        if (!choice) return false;
        resolveApprovalChoice(choice);
        return true;
      }
      const questions = pending.state.questions ?? [];
      const question = questions[pending.state.activeQuestionIndex ?? 0];
      if (!question) return false;
      if (context.questionId && context.questionId !== question.id) return false;
      const option = question.options[index];
      if (!option) return false;
      return answerQuestion(pending, question.id, [option.value ?? option.label]);
    };

    // The session loop owns every failure: it reports errors as a failed run and
    // always closes the client, so this detached promise never rejects.
    void (async () => {
      try {
        await initialize();
        while (true) {
          const next = await prompts.next();
          if (next.done) break;
          const rawMessage = next.value;
          if (closed) {
            // The session ended (handle or app server closed) with this prompt
            // still queued: never start work on a closed transport.
            logCodexHarnessDiagnostic("action.rejected", { what: "queued prompt after close", ...threadDiagnosticFields({ threadId, turnId: lastTurnId }) });
            break;
          }
          const control = asThreadActionMessage(rawMessage);
          if (control) {
            await runThreadAction(control.action);
            continue;
          }
          const text = extractPromptText(rawMessage).trim();
          if (!text || await submitPendingInputText(text)) {
            queue.enqueue(createPromptSettledEvent());
            continue;
          }
          await runUserTurn(text);
        }
      } catch (error) {
        logCodexHarnessDiagnostic("session.error", {
          ...threadDiagnosticFields({ threadId, turnId: lastTurnId }),
          error: errorMessage(error),
        });
        queue.enqueue(createRunCompletedEvent({
          success: false,
          duration_ms: 0,
          total_cost_usd: cumulativeCostUsd,
          num_turns: runCounter,
          result: errorMessage(error),
          session_id: threadId ?? options.resumeSessionId ?? "",
        }));
      } finally {
        logCodexHarnessDiagnostic("client.close.start", threadDiagnosticFields({ threadId, turnId: lastTurnId }));
        await client.close().catch((): undefined => undefined);
        if (rateLimitAccountKey) releaseCodexRateLimits(rateLimitAccountKey);
        logCodexHarnessDiagnostic("client.close.done", threadDiagnosticFields({ threadId, turnId: lastTurnId }));
        queue.close();
      }
    })();

    return {
      messages: queue.messages(),

      async setPermissionMode(mode: string): Promise<void> {
        currentPermissionMode = mode;
        queue.enqueue(createSettingsChangedEvent(mode));
      },

      async submitPendingInputOption(
        index: number,
        context?: { requestId?: string; questionId?: string },
      ): Promise<boolean> {
        return submitPendingInputOption(index, context);
      },

      async submitPendingInputText(text: string): Promise<boolean> {
        return submitPendingInputText(text);
      },

      steer,

      async interrupt(): Promise<void> {
        const turn = activeTurn;
        if (closed || !threadId || !turn?.turnId) return;
        turn.interruptRequested = true;
        await codexRequest(client, "turn/interrupt", { threadId, turnId: turn.turnId }, timeoutMs)
          .catch((): undefined => undefined);
      },

      async close(): Promise<void> {
        closed = true;
        await client.close();
      },
    };
  }

  buildUserMessage(text: string, sessionId: string): unknown {
    return { type: "user", text, session_id: sessionId };
  }

  buildThreadActionMessage(action: ThreadAction): unknown {
    return { type: "codex_thread_action", action } satisfies CodexThreadActionMessage;
  }
}

function resolveAppServerArgs(value: string | undefined): string[] {
  if (value === undefined) return DEFAULT_APP_SERVER_ARGS;
  const parsed = parseCsvEnv(value);
  return parsed.length > 0 ? parsed : DEFAULT_APP_SERVER_ARGS;
}
