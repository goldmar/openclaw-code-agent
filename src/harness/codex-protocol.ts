import type {
  PendingInputAction,
  PendingInputDecision,
  PendingInputState,
  PlanArtifactStep,
} from "../types";
import type { HarnessResult } from "./types";
import type { JsonRpcClient } from "./codex-rpc";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function collectStreamingText(value: unknown): string {
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

export function extractIds(value: unknown): {
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

export function firstNestedString(value: unknown, keys: readonly string[], depth = 0): string | undefined {
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

export function extractThreadState(value: unknown): { threadId?: string; cwd?: string } {
  const ids = extractIds(value);
  return {
    threadId: ids.threadId,
    cwd: firstNestedString(value, ["cwd", "workdir", "directory"]),
  };
}

export function isNativeCodexWorktreePath(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && /[/\\]worktrees[/\\][^/\\]+[/\\][^/\\]+/.test(trimmed));
}

export function deriveWorktreeIdFromPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[/\\]+/).filter(Boolean);
  const worktreesIndex = parts.lastIndexOf("worktrees");
  if (worktreesIndex < 0 || worktreesIndex + 1 >= parts.length) return undefined;
  return parts[worktreesIndex + 1];
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

export function extractAssistantNotificationText(
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

export function extractPlanDeltaNotification(value: unknown): { itemId?: string; delta: string } {
  return {
    itemId: extractAssistantItemId(value),
    delta: collectStreamingText(value),
  };
}

export function extractTurnPlanUpdate(value: unknown): { explanation?: string; steps: PlanArtifactStep[] } {
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

export function extractCompletedPlanText(value: unknown): { itemId?: string; text?: string } {
  const record = asRecord(value);
  if (!record) return {};
  const item = asRecord(record.item) ?? record;
  if (pickString(item, ["type"])?.toLowerCase() !== "plan") return {};
  return {
    itemId: extractAssistantItemId(item),
    text: pickString(item, ["text"], { trim: false }) ?? collectStreamingText(item),
  };
}

export function normalizeTerminalStatus(method: string, params: unknown): HarnessResult["success"] {
  const methodLower = method.trim().toLowerCase();
  if (methodLower === "turn/failed") return false;
  if (methodLower === "turn/cancelled") return false;
  const record = asRecord(params) ?? {};
  const turn = asRecord(record.turn) ?? record;
  const status = pickString(turn, ["status"])?.toLowerCase();
  return status !== "failed" && status !== "interrupted" && status !== "cancelled";
}

export function extractTerminalMessage(method: string, params: unknown): string | undefined {
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

export async function requestWithFallbacks(params: {
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

export function buildThreadStartPayloads(params: {
  cwd: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
}): unknown[] {
  const base: Record<string, unknown> = { cwd: params.cwd };
  if (params.model?.trim()) base.model = params.model.trim();
  if (params.approvalPolicy?.trim()) base.approvalPolicy = params.approvalPolicy.trim();
  if (params.sandbox?.trim()) base.sandbox = params.sandbox.trim();
  const fallback: Record<string, unknown> = { cwd: params.cwd };
  if (params.approvalPolicy?.trim()) fallback.approvalPolicy = params.approvalPolicy.trim();
  if (params.sandbox?.trim()) fallback.sandbox = params.sandbox.trim();
  return [
    base,
    fallback,
    {},
  ];
}

export function buildThreadResumePayloads(params: {
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

export function buildTurnInput(prompt: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: prompt }];
}

export function buildCollaborationMode(
  mode: string,
  model?: string,
  reasoningEffort?: string,
  developerInstructions?: string,
): Record<string, unknown> | undefined {
  const normalizedModel = model?.trim();
  const normalizedDeveloperInstructions = developerInstructions?.trim();
  if (mode !== "plan") {
    return normalizedModel || normalizedDeveloperInstructions ? {
      mode: "default",
      settings: {
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(reasoningEffort?.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}),
        developerInstructions: normalizedDeveloperInstructions ?? null,
      },
    } : undefined;
  }

  if (!normalizedModel && !normalizedDeveloperInstructions) return undefined;
  return {
    mode: "plan",
    settings: {
      ...(normalizedModel ? { model: normalizedModel } : {}),
      ...(reasoningEffort?.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}),
      developerInstructions: normalizedDeveloperInstructions ?? null,
    },
  };
}

export function buildTurnStartPayloads(params: {
  threadId: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt?: string;
  permissionMode?: string;
  approvalPolicy?: string;
  sandbox?: string;
}): unknown[] {
  const base: Record<string, unknown> = {
    threadId: params.threadId,
    input: buildTurnInput(params.prompt),
  };
  if (params.model?.trim()) base.model = params.model.trim();
  if (params.approvalPolicy?.trim()) base.approvalPolicy = params.approvalPolicy.trim();
  if (params.sandbox?.trim()) base.sandbox = params.sandbox.trim();
  const collaborationMode = buildCollaborationMode(
    params.permissionMode ?? "default",
    params.model,
    params.reasoningEffort,
    params.systemPrompt,
  );
  if (!collaborationMode) return [base];
  return [
    { ...base, collaborationMode },
    {
      ...base,
      collaboration_mode: {
        mode: collaborationMode.mode,
        settings: {
          ...((typeof (collaborationMode.settings as { model?: string }).model === "string")
            ? { model: (collaborationMode.settings as { model: string }).model }
            : {}),
          ...(typeof (collaborationMode.settings as { reasoningEffort?: string }).reasoningEffort === "string"
            ? { reasoning_effort: (collaborationMode.settings as { reasoningEffort: string }).reasoningEffort }
            : {}),
          developer_instructions:
            (collaborationMode.settings as { developerInstructions?: string | null }).developerInstructions ?? null,
        },
      },
    },
    base,
  ];
}

export function buildTurnInterruptPayloads(params: { threadId: string; turnId: string }): unknown[] {
  return [{ threadId: params.threadId, turnId: params.turnId }];
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

export function buildPendingInputState(method: string, requestId: string, requestParams: unknown): PendingInputState {
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

export function isInteractiveServerRequest(method: string): boolean {
  const normalized = method.trim().toLowerCase();
  return normalized.includes("requestuserinput") || normalized.includes("requestapproval");
}

export function codexExecutionPolicyForMode(
  mode: string | undefined,
  codexApprovalPolicy?: string,
): { approvalPolicy?: string; sandbox?: string } {
  const approvalPolicy = mode === "bypassPermissions"
    ? "never"
    : (codexApprovalPolicy?.trim() || "never");
  const sandbox = approvalPolicy === "never" ? "danger-full-access" : undefined;
  return { approvalPolicy, sandbox };
}
