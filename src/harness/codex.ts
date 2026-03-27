/**
 * Codex harness backed by the Codex App Server protocol over stdio.
 *
 * This keeps the plugin's session-centric control plane while replacing the
 * older SDK message model with richer structured backend events.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type {
  PendingInputDecision,
  PendingInputState,
  PendingInputAction,
  PlanArtifact,
  PlanArtifactStep,
} from "../types";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessMessage,
  HarnessResult,
  HarnessSession,
} from "./types";

type JsonRpcId = string | number;
type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcNotificationHandler = (method: string, params: unknown) => Promise<void> | void;
type JsonRpcRequestHandler = (method: string, params: unknown) => Promise<unknown>;

type JsonRpcClient = {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  notify: (method: string, params?: unknown) => Promise<void>;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  setNotificationHandler: (handler: JsonRpcNotificationHandler) => void;
  setRequestHandler: (handler: JsonRpcRequestHandler) => void;
};

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
  state: PendingInputState;
  options: string[];
  actions: PendingInputAction[];
  resolveResponse: (payload: unknown) => void;
};

const DEFAULT_PROTOCOL_VERSION = "1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const OPENCLAW_CODEX_APP_SERVER_COMMAND_ENV = "OPENCLAW_CODEX_APP_SERVER_COMMAND";
const OPENCLAW_CODEX_APP_SERVER_ARGS_ENV = "OPENCLAW_CODEX_APP_SERVER_ARGS";
const OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS_ENV = "OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
  options?: { trim?: boolean },
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value !== "string") continue;
    const text = options?.trim === false ? value : value.trim();
    if (text) return text;
  }
  return undefined;
}

function pickFiniteNumber(record: Record<string, unknown> | null | undefined, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

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

function parseJsonRpc(raw: string): JsonRpcEnvelope | null {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return payload as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

async function dispatchJsonRpcEnvelope(
  payload: JsonRpcEnvelope,
  params: {
    pending: Map<string, PendingRequest>;
    onNotification: JsonRpcNotificationHandler;
    onRequest: JsonRpcRequestHandler;
    respond: (payload: JsonRpcEnvelope) => void;
  },
): Promise<void> {
  if (payload.id != null && (Object.hasOwn(payload, "result") || Object.hasOwn(payload, "error"))) {
    const key = String(payload.id);
    const pending = params.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    params.pending.delete(key);
    if (payload.error) {
      pending.reject(new Error(`codex app server rpc error (${payload.error.code ?? "unknown"}): ${payload.error.message ?? "unknown error"}`));
      return;
    }
    pending.resolve(payload.result);
    return;
  }

  const method = payload.method?.trim();
  if (!method) return;
  if (payload.id == null) {
    await params.onNotification(method, payload.params);
    return;
  }

  try {
    const result = await params.onRequest(method, payload.params);
    params.respond({ jsonrpc: "2.0", id: payload.id, result: result ?? {} });
  } catch (error) {
    params.respond({
      jsonrpc: "2.0",
      id: payload.id,
      error: {
        code: -32603,
        message: errorMessage(error),
      },
    });
  }
}

class StdioJsonRpcClient implements JsonRpcClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private counter = 0;
  private onNotification: JsonRpcNotificationHandler = () => undefined;
  private onRequest: JsonRpcRequestHandler = async () => ({});

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly requestTimeoutMs: number,
  ) {}

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.onNotification = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.onRequest = handler;
  }

  async connect(): Promise<void> {
    if (this.process) return;
    const child = spawn(this.command, ["app-server", ...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("codex app server stdio pipes unavailable");
    }
    this.process = child;
    const reader = readline.createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      void this.handleLine(line);
    });
    child.stderr.on("data", () => undefined);
    child.on("close", () => {
      this.flushPending(new Error("codex app server stdio closed"));
      this.process = null;
    });
  }

  async close(): Promise<void> {
    this.flushPending(new Error("codex app server stdio closed"));
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.kill();
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = `rpc-${++this.counter}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app server timeout: ${method}`));
      }, Math.max(100, timeoutMs ?? this.requestTimeoutMs));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return await result;
  }

  private write(payload: JsonRpcEnvelope): void {
    if (!this.process?.stdin) {
      throw new Error("codex app server stdio not connected");
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    const payload = parseJsonRpc(line);
    if (!payload) return;
    await dispatchJsonRpcEnvelope(payload, {
      pending: this.pending,
      onNotification: this.onNotification,
      onRequest: this.onRequest,
      respond: (frame) => this.write(frame),
    });
  }

  private flushPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function collectStreamingText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => collectStreamingText(entry)).join("");
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["delta", "text", "content", "message", "input", "output", "parts"]) {
    const direct = collectStreamingText(record[key]);
    if (direct) return direct;
  }
  for (const key of ["item", "turn", "thread", "response", "result", "data"]) {
    const nested = collectStreamingText(record[key]);
    if (nested) return nested;
  }
  return "";
}

function extractIds(value: unknown): {
  threadId?: string;
  runId?: string;
  requestId?: string;
  itemId?: string;
} {
  const record = asRecord(value);
  if (!record) return {};
  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  const turnRecord = asRecord(record.turn) ?? asRecord(record.run);
  const itemRecord = asRecord(record.item);
  const serverRequest = asRecord(record.serverRequest);
  return {
    threadId:
      pickString(record, ["threadId", "thread_id", "conversationId", "conversation_id"]) ??
      pickString(threadRecord, ["id", "threadId", "thread_id", "conversationId"]),
    runId:
      pickString(record, ["turnId", "turn_id", "runId", "run_id"]) ??
      pickString(turnRecord, ["id", "turnId", "turn_id", "runId", "run_id"]),
    requestId:
      pickString(record, ["requestId", "request_id", "serverRequestId"]) ??
      pickString(serverRequest, ["id", "requestId", "request_id"]),
    itemId:
      pickString(record, ["itemId", "item_id"]) ??
      pickString(itemRecord, ["id", "itemId", "item_id"]),
  };
}

function extractAssistantItemId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const item = asRecord(record.item) ?? record;
  return pickString(item, ["id", "itemId", "item_id", "messageId", "message_id"]);
}

function extractAssistantTextFromItemPayload(value: unknown, streaming = false): string {
  const record = asRecord(value);
  if (!record) return "";
  const item = asRecord(record.item) ?? record;
  const itemType = pickString(item, ["type"])?.toLowerCase();
  if (itemType !== "agentmessage") return "";
  return streaming
    ? collectStreamingText(item)
    : (pickString(item, ["text"], { trim: false }) ?? collectStreamingText(item));
}

function extractAssistantNotificationText(
  method: string,
  params: unknown,
): { mode: "delta" | "snapshot" | "ignore"; text: string; itemId?: string } {
  const methodLower = method.trim().toLowerCase();
  if (methodLower === "item/agentmessage/delta") {
    return {
      mode: "delta",
      text: collectStreamingText(params),
      itemId: extractAssistantItemId(params),
    };
  }
  if (methodLower === "item/completed") {
    return {
      mode: "snapshot",
      text: extractAssistantTextFromItemPayload(params),
      itemId: extractAssistantItemId(params),
    };
  }
  return { mode: "ignore", text: "" };
}

function extractPlanDeltaNotification(value: unknown): { itemId?: string; delta: string } {
  return {
    itemId: extractAssistantItemId(value),
    delta: collectStreamingText(value),
  };
}

function extractTurnPlanUpdate(value: unknown): { explanation?: string; steps: PlanArtifactStep[] } {
  const record = asRecord(value);
  const planRecord = asRecord(record?.plan);
  const rawPlan = Array.isArray(record?.plan)
    ? record.plan
    : Array.isArray(planRecord?.steps)
      ? planRecord.steps
      : [];
  const steps = rawPlan
    .map((entry) => {
      const stepRecord = asRecord(entry);
      const step = pickString(stepRecord, ["step", "title", "text"]);
      if (!step) return null;
      const statusRaw = pickString(stepRecord, ["status"])?.toLowerCase() ?? "pending";
      const status =
        statusRaw === "inprogress" || statusRaw === "in_progress"
          ? "inProgress"
          : statusRaw === "completed"
            ? "completed"
            : "pending";
      return { step, status } as const;
    })
    .filter(Boolean) as PlanArtifactStep[];

  return {
    explanation:
      pickString(planRecord, ["explanation"]) ??
      pickString(record, ["explanation"]),
    steps,
  };
}

function extractCompletedPlanText(value: unknown): { itemId?: string; text?: string } {
  const record = asRecord(value);
  if (!record) return {};
  const item = asRecord(record.item) ?? record;
  if (pickString(item, ["type"])?.toLowerCase() !== "plan") return {};
  return {
    itemId: extractAssistantItemId(item),
    text: pickString(item, ["text"], { trim: false }) ?? collectStreamingText(item),
  };
}

function normalizeTerminalStatus(method: string, params: unknown): HarnessResult["success"] {
  const methodLower = method.trim().toLowerCase();
  if (methodLower === "turn/failed") return false;
  if (methodLower === "turn/cancelled") return false;
  const record = asRecord(params) ?? {};
  const turn = asRecord(record.turn) ?? record;
  const status = pickString(turn, ["status"])?.toLowerCase();
  return status !== "failed" && status !== "interrupted" && status !== "cancelled";
}

function extractTerminalMessage(method: string, params: unknown): string | undefined {
  const record = asRecord(params) ?? {};
  const turn = asRecord(record.turn) ?? record;
  const error = asRecord(turn.error) ?? asRecord(record.error);
  if (!error) return undefined;
  return pickString(error, ["message", "text", "summary", "reason"]);
}

function isMethodUnavailableError(error: unknown, method?: string): boolean {
  const text = errorMessage(error).toLowerCase();
  if (text.includes("method not found") || text.includes("unknown method")) return true;
  if (!text.includes("unknown variant")) return false;
  if (!method) return true;
  return text.includes(`unknown variant \`${method.toLowerCase()}\``);
}

const METHODS_REQUIRING_THREAD = new Set([
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

function methodRequiresThreadId(method: string): boolean {
  return METHODS_REQUIRING_THREAD.has(method.trim().toLowerCase());
}

function payloadHasThreadId(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  return Boolean(pickString(record, ["threadId", "thread_id"]));
}

async function requestWithFallbacks(params: {
  client: JsonRpcClient;
  methods: string[];
  payloads: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  if (params.payloads.length === 0) {
    throw new Error(`codex app server request skipped: no payloads for ${params.methods.join(", ") || "<none>"}`);
  }

  let lastError: unknown;
  for (const method of params.methods) {
    for (const payload of params.payloads) {
      if (methodRequiresThreadId(method) && !payloadHasThreadId(payload)) {
        throw new Error(`codex app server request missing threadId: ${method}`);
      }
      try {
        return await params.client.request(method, payload, params.timeoutMs);
      } catch (error) {
        lastError = error;
        if (!isMethodUnavailableError(error, method)) {
          continue;
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildThreadStartPayloads(params: { cwd: string; model?: string }): unknown[] {
  return [
    { cwd: params.cwd, model: params.model },
    { cwd: params.cwd },
    {},
  ];
}

function buildThreadResumePayloads(params: {
  threadId: string;
  model?: string;
  reasoningEffort?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
}): Array<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    threadId: params.threadId,
    persistExtendedHistory: false,
  };
  if (params.model?.trim()) base.model = params.model.trim();
  if (params.reasoningEffort?.trim()) base.reasoningEffort = params.reasoningEffort.trim();
  if (params.cwd?.trim()) base.cwd = params.cwd.trim();
  if (params.approvalPolicy?.trim()) base.approvalPolicy = params.approvalPolicy.trim();
  if (params.sandbox?.trim()) base.sandbox = params.sandbox.trim();
  return [base];
}

function buildTurnInput(prompt: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: prompt }];
}

function buildCollaborationMode(mode: string, model?: string, reasoningEffort?: string): Record<string, unknown> | undefined {
  const normalizedModel = model?.trim();
  if (mode !== "plan") return normalizedModel ? {
    mode: "default",
    settings: {
      model: normalizedModel,
      ...(reasoningEffort?.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}),
      developerInstructions: null,
    },
  } : undefined;

  if (!normalizedModel) return undefined;
  return {
    mode: "plan",
    settings: {
      model: normalizedModel,
      ...(reasoningEffort?.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}),
      developerInstructions: null,
    },
  };
}

function buildTurnStartPayloads(params: {
  threadId: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
}): unknown[] {
  const base: Record<string, unknown> = {
    threadId: params.threadId,
    input: buildTurnInput(params.prompt),
  };
  if (params.model?.trim()) base.model = params.model.trim();
  const collaborationMode = buildCollaborationMode(params.permissionMode ?? "default", params.model, params.reasoningEffort);
  if (!collaborationMode) return [base];
  return [
    { ...base, collaborationMode },
    {
      ...base,
      collaboration_mode: {
        mode: collaborationMode.mode,
        settings: {
          model: (collaborationMode.settings as { model: string }).model,
          ...(typeof (collaborationMode.settings as { reasoningEffort?: string }).reasoningEffort === "string"
            ? { reasoning_effort: (collaborationMode.settings as { reasoningEffort: string }).reasoningEffort }
            : {}),
          developer_instructions: null,
        },
      },
    },
    base,
  ];
}

function buildTurnInterruptPayloads(params: { threadId: string; turnId: string }): unknown[] {
  return [{ threadId: params.threadId, turnId: params.turnId }];
}

function firstNestedString(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = firstNestedString(entry, keys, depth + 1);
      if (match) return match;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = pickString(record, keys);
  if (direct) return direct;
  for (const nested of Object.values(record)) {
    const match = firstNestedString(nested, keys, depth + 1);
    if (match) return match;
  }
  return undefined;
}

function extractOptionValues(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  const rawOptions = record.options ?? record.choices ?? record.availableDecisions ?? record.decisions;
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      return pickString(asRecord(entry), ["label", "title", "text", "value", "name", "id"]) ?? "";
    })
    .filter(Boolean);
}

function normalizeApprovalDecision(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("session")) return "acceptForSession";
  if (/cancel|abort|stop/.test(normalized)) return "cancel";
  if (/deny|decline|reject|block|no/.test(normalized)) return "decline";
  if (/approve|allow|accept|yes/.test(normalized)) return "accept";
  return value.trim();
}

function buildPendingInputState(method: string, requestId: string, requestParams: unknown): PendingInputState {
  const methodLower = method.trim().toLowerCase();
  const options = extractOptionValues(requestParams);
  const promptText =
    firstNestedString(requestParams, ["question", "prompt", "message", "text", "summary", "reason"]) ??
    undefined;
  const isApproval = methodLower.includes("requestapproval");
  const actions: PendingInputAction[] = isApproval
    ? options.map((option) => ({
        kind: "approval" as const,
        label: option,
        decision: normalizeApprovalDecision(option) as PendingInputDecision,
        responseDecision: option,
      }))
    : options.map((option) => ({
        kind: "option" as const,
        label: option,
        value: option,
      }));

  return {
    requestId,
    kind: isApproval ? "approval" : "question",
    promptText,
    options,
    actions,
    allowsFreeText: true,
  };
}

function isInteractiveServerRequest(method: string): boolean {
  const normalized = method.trim().toLowerCase();
  return normalized.includes("requestuserinput") || normalized.includes("requestapproval");
}

function approvalPolicyForMode(mode: string | undefined, codexApprovalPolicy?: string): string | undefined {
  if (mode === "bypassPermissions") return "never";
  return codexApprovalPolicy?.trim() || "on-request";
}

function sandboxForMode(mode: string | undefined): string | undefined {
  if (mode === "bypassPermissions") return "danger-full-access";
  return undefined;
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
    worktrees: "plugin-managed",
    nativeWorktreeRestore: false,
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

    const queue: HarnessMessage[] = [];
    let queueResolve: (() => void) | null = null;
    let queueDone = false;
    let threadId = options.resumeSessionId;
    let turnId: string | undefined;
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

    const flushResolve = (): void => {
      if (queueResolve) {
        queueResolve();
        queueResolve = null;
      }
    };

    const enqueue = (message: HarnessMessage): void => {
      queue.push(message);
      flushResolve();
    };

    const endQueue = (): void => {
      queueDone = true;
      flushResolve();
    };

    const emitBackendRef = (): void => {
      if (!threadId) return;
      enqueue({
        type: "backend_ref",
        ref: {
          kind: "codex-app-server",
          conversationId: threadId,
          ...(turnId ? { runId: turnId } : {}),
        },
      });
    };

    client.setNotificationHandler(async (method, params) => {
      const methodLower = method.trim().toLowerCase();
      const ids = extractIds(params);
      if (ids.threadId && threadId && ids.threadId !== threadId) return;
      if (ids.threadId) {
        threadId = ids.threadId;
        emitBackendRef();
      }
      if (ids.runId) {
        turnId = ids.runId;
      }

      if (methodLower === "serverrequest/resolved") {
        if (currentPendingInput) {
          enqueue({ type: "pending_input_resolved", requestId: currentPendingInput.requestId });
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
          enqueue({ type: "plan_artifact", artifact, finalized: true });
          return;
        }
      }

      const assistant = extractAssistantNotificationText(methodLower, params);
      if (assistant.mode === "delta" && assistant.text) {
        if (assistant.itemId) {
          assistantStreamByItemId.add(assistant.itemId);
        }
        enqueue({ type: "text_delta", text: assistant.text });
        return;
      }
      if (assistant.mode === "snapshot" && assistant.text) {
        if (!assistant.itemId || !assistantStreamByItemId.has(assistant.itemId)) {
          enqueue({ type: "text_delta", text: assistant.text });
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
      if (ids.threadId && threadId && ids.threadId !== threadId) {
        return {};
      }
      if (ids.threadId) {
        threadId = ids.threadId;
        emitBackendRef();
      }
      if (ids.runId) {
        turnId = ids.runId;
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
        enqueue({ type: "pending_input", state });
      });
      currentPendingInput = undefined;
      enqueue({ type: "pending_input_resolved", requestId });
      return response;
    });

    const initialize = async (): Promise<void> => {
      await client.connect();
      await client.request("initialize", {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        clientInfo: { name: "openclaw-code-agent", version: "3.5.0" },
        capabilities: { experimentalApi: true },
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      await client.notify("initialized", {});
    };

    const ensureThread = async (): Promise<void> => {
      if (threadId) {
        const resumed = await requestWithFallbacks({
          client,
          methods: ["thread/resume"],
          payloads: buildThreadResumePayloads({
            threadId,
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            cwd: options.cwd,
            approvalPolicy: approvalPolicyForMode(currentPermissionMode, options.codexApprovalPolicy),
            sandbox: sandboxForMode(currentPermissionMode),
          }),
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        });
        threadId = extractIds(resumed).threadId ?? threadId;
        emitBackendRef();
        return;
      }

      const started = await requestWithFallbacks({
        client,
        methods: ["thread/start", "thread/new"],
        payloads: buildThreadStartPayloads({ cwd: options.cwd, model: options.model }),
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      });
      threadId = extractIds(started).threadId;
      if (!threadId) {
        throw new Error("Codex App Server did not return a thread id.");
      }
      emitBackendRef();
    };

    const runTurn = async (prompt: string): Promise<void> => {
      await ensureThread();
      enqueue({ type: "run_started" });
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
        const started = await requestWithFallbacks({
          client,
          methods: ["turn/start"],
          payloads: buildTurnStartPayloads({
            threadId: threadId!,
            prompt,
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            permissionMode: currentPermissionMode,
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
        enqueue({
          type: "run_completed",
          data: {
            success: normalizeTerminalStatus(terminalMethod, terminalParams),
            duration_ms: 0,
            total_cost_usd: 0,
            num_turns: runCounter,
            result: extractTerminalMessage(terminalMethod, terminalParams),
            session_id: threadId!,
          },
        });
      } catch (error) {
        enqueue({
          type: "run_completed",
          data: {
            success: false,
            duration_ms: 0,
            total_cost_usd: 0,
            num_turns: runCounter,
            result: errorMessage(error),
            session_id: threadId ?? "",
          },
        });
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
        enqueue({
          type: "run_completed",
          data: {
            success: false,
            duration_ms: 0,
            total_cost_usd: 0,
            num_turns: runCounter,
            result: errorMessage(error),
            session_id: threadId ?? options.resumeSessionId ?? "",
          },
        });
      } finally {
        await client.close().catch((): undefined => undefined);
        endQueue();
      }
    })();

    return {
      messages: (async function* (): AsyncGenerator<HarnessMessage> {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (queueDone) return;
          await new Promise<void>((resolve) => {
            queueResolve = resolve;
          });
        }
      })(),

      async setPermissionMode(mode: string): Promise<void> {
        currentPermissionMode = mode;
        enqueue({ type: "settings_changed", permissionMode: mode });
      },

      async submitPendingInputOption(index: number): Promise<boolean> {
        return submitPendingInputOption(index);
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
