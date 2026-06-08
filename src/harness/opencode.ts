import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, accessSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, sep } from "node:path";
import type {
  PendingInputAction,
  PendingInputState,
  PermissionMode,
} from "../types";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessSession,
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

type FetchLike = typeof fetch;

interface OpenCodeServerHandle {
  baseUrl: string;
  close(): Promise<void>;
}

interface OpenCodeHarnessDeps {
  createServer?: (options: { cwd: string; signal?: AbortSignal; fetch?: FetchLike; requestTimeoutMs?: number; startupTimeoutMs?: number }) => Promise<OpenCodeServerHandle>;
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
}

interface OpenCodeSession {
  id?: string;
  cost?: number;
  title?: string;
}

type OpenCodePendingInput = {
  requestId: string;
  kind: "approval" | "question";
  options: string[];
  actions: PendingInputAction[];
};

const OPENCODE_COMMAND_ENV = "OPENCLAW_OPENCODE_COMMAND";
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 15 * 60_000;
const MUTATION_PERMISSIONS = [
  "edit",
  "bash",
  "task",
  "todowrite",
  "external_directory",
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || (sep === "\\" && command.includes("\\"));
}

function candidateSearchPaths(envPath: string | undefined): string[] {
  const paths = (envPath ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const expanded = [...paths];
  for (const entry of paths) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.endsWith("/opt/node/bin")) {
      expanded.push(join(dirname(dirname(dirname(entry))), "bin"));
    }
  }
  expanded.push("/home/linuxbrew/.linuxbrew/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(expanded)];
}

function resolveCommandPath(command: string, envPath = process.env.PATH): string {
  if (commandHasPathSeparator(command)) return command;
  for (const entry of candidateSearchPaths(envPath)) {
    const candidate = join(entry, command);
    if (isExecutable(candidate)) return candidate;
  }
  return command;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractPromptText(message: unknown): string {
  if (typeof message === "string") return message;
  if (!isRecord(message)) return String(message);
  if (typeof message.text === "string") return message.text;
  const nested = isRecord(message.message) ? message.message : undefined;
  if (typeof nested?.content === "string") return nested.content;
  return String(message);
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

function toOpenCodeModel(model: string | undefined): { id: string; providerID: string } | undefined {
  const parsed = parseModel(model);
  return parsed ? { id: parsed.modelID, providerID: parsed.providerID } : undefined;
}

function permissionRulesForMode(mode: string | undefined): Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }> {
  const effective = mode ?? "default";
  const action = effective === "plan"
    ? "deny"
    : effective === "bypassPermissions"
      ? "allow"
      : "ask";
  return MUTATION_PERMISSIONS.map((permission) => ({
    permission,
    pattern: "*",
    action,
  }));
}

function authHeader(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Could not allocate local OpenCode server port."));
        }
      });
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function boundedPromise<T>(
  promise: Promise<T>,
  options: {
    timeoutMs: number;
    timeoutMessage: string;
    signal?: AbortSignal;
    abortMessage?: string;
    onTimeout?: () => void;
  },
): Promise<T> {
  if (options.signal?.aborted) {
    throw new Error(options.abortMessage ?? "Operation was aborted.");
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = (): void => {
      finish(() => reject(new Error(options.abortMessage ?? "Operation was aborted.")));
    };
    const timeout = setTimeout(() => {
      finish(() => {
        options.onTimeout?.();
        reject(new Error(options.timeoutMessage));
      });
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let killTimeout: NodeJS.Timeout | undefined;
    const forceTimeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      killTimeout = setTimeout(resolve, 1_000);
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(forceTimeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

class OpenCodeHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`OpenCode ${method} ${path} failed with ${status}${body ? `: ${body}` : ""}`);
  }
}

function responseContentType(response: Response): string {
  return response.headers.get("content-type")?.toLowerCase() ?? "";
}

function previewResponseBody(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function isHtmlResponse(contentType: string, text: string): boolean {
  return contentType.includes("text/html") || /^\s*<!doctype html\b/i.test(text) || /^\s*<html[\s>]/i.test(text);
}

function unexpectedJsonResponseMessage(method: string, path: string, contentType: string, text: string): string {
  const typeDescription = contentType ? `content-type ${contentType}` : "missing content-type";
  const body = previewResponseBody(text);
  const htmlHint = isHtmlResponse(contentType, text) ? " (looks like the OpenCode web UI HTML app shell)" : "";
  return `OpenCode ${method} ${path} expected JSON API response but received ${typeDescription}${htmlHint}${body ? `: ${body}` : ""}`;
}

function classicPromptBody(text: string, model: string | undefined, systemPrompt: string | undefined): Record<string, unknown> {
  const parsed = parseModel(model);
  return {
    ...(parsed ? { model: { providerID: parsed.providerID, modelID: parsed.modelID } } : {}),
    ...(systemPrompt?.trim() ? { system: systemPrompt.trim() } : {}),
    parts: [{ type: "text", text }],
  };
}

function isIdleSessionStatus(statuses: unknown, sessionId: string): boolean {
  if (!isRecord(statuses)) return false;
  if (!(sessionId in statuses)) return true;
  const status = statuses[sessionId];
  return isRecord(status) && status.type === "idle";
}

function eventIndicatesSessionIdle(event: { type?: string; properties: Record<string, unknown> }): boolean {
  if (event.type === "session.idle") return true;
  if (event.type !== "session.status") return false;
  const status = event.properties.status ?? event.properties.type;
  return status === "idle";
}

async function startOpenCodeServerOnce(options: { cwd: string; signal?: AbortSignal; fetch?: FetchLike; requestTimeoutMs?: number; startupTimeoutMs?: number }): Promise<OpenCodeServerHandle> {
  const port = await getFreePort();
  const requestedCommand = process.env[OPENCODE_COMMAND_ENV]?.trim() || "opencode";
  const command = resolveCommandPath(requestedCommand);
  const args = [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
    "--print-logs",
  ];
  const fetchImpl = options.fetch ?? fetch;
  const readinessRequestTimeoutMs = Math.min(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, 10_000);
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  const appendOutput = (current: string, chunk: unknown): string => {
    const next = current + String(chunk);
    return next.length > 8_000 ? next.slice(-8_000) : next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendOutput(stderr, chunk);
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const launchDescription = (): string => {
    const commandDescription = requestedCommand === command ? command : `${command} (resolved from ${requestedCommand})`;
    return ` Command: ${commandDescription} ${args.join(" ")}. Cwd: ${options.cwd}. Port: ${port}. PATH: ${process.env.PATH ?? ""}.`;
  };
  const outputSuffix = (): string => {
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
    return `${launchDescription()}${output ? ` Output:\n${output}` : ""}`;
  };
  const abortStartup = (): void => {
    void terminateChild(child);
  };
  if (options.signal?.aborted) {
    await terminateChild(child);
    throw new Error(`OpenCode server startup aborted before readiness.${outputSuffix()}`);
  }
  options.signal?.addEventListener("abort", abortStartup, { once: true });

  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < startupTimeoutMs) {
      if (options.signal?.aborted) {
        await terminateChild(child);
        throw new Error(`OpenCode server startup aborted before readiness.${outputSuffix()}`);
      }
      if (spawnError) {
        throw new Error(`OpenCode server failed to start: ${spawnError.message}${outputSuffix()}`);
      }
      if (child.exitCode !== null) {
        throw new Error(`OpenCode server exited before readiness.${outputSuffix()}`);
      }
      try {
        const ready = await probeOpenCodeHealth({
          baseUrl,
          fetchImpl,
          requestTimeoutMs: readinessRequestTimeoutMs,
          startupSignal: options.signal,
          timeoutMessage: `OpenCode GET /api/health timed out after ${readinessRequestTimeoutMs}ms during server readiness.${outputSuffix()}`,
          abortMessage: `OpenCode server startup aborted before readiness.${outputSuffix()}`,
        });
        if (ready) {
          return {
            baseUrl,
            close: async () => {
              await terminateChild(child);
            },
          };
        }
      } catch (error) {
        if (options.signal?.aborted) {
          await terminateChild(child);
          throw new Error(`OpenCode server startup aborted before readiness.${outputSuffix()}`);
        }
        // Retry until the process exits or the startup deadline is reached.
      }
      await delay(100);
    }

    await terminateChild(child);
    throw new Error(`Timed out waiting for OpenCode server readiness.${outputSuffix()}`);
  } finally {
    options.signal?.removeEventListener("abort", abortStartup);
  }
}

async function defaultCreateServer(options: { cwd: string; signal?: AbortSignal; fetch?: FetchLike; requestTimeoutMs?: number; startupTimeoutMs?: number }): Promise<OpenCodeServerHandle> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startOpenCodeServerOnce(options);
    } catch (error) {
      if (attempt >= 3 || !/EADDRINUSE|address already in use|bind: address already in use/i.test(errorMessage(error))) {
        throw error;
      }
    }
  }
}

async function probeOpenCodeHealth(args: {
  baseUrl: string;
  fetchImpl: FetchLike;
  requestTimeoutMs: number;
  startupSignal?: AbortSignal;
  timeoutMessage: string;
  abortMessage: string;
}): Promise<boolean> {
  const controller = new AbortController();
  const abortController = (): void => controller.abort();
  if (args.startupSignal?.aborted) {
    controller.abort();
  } else {
    args.startupSignal?.addEventListener("abort", abortController, { once: true });
  }
  try {
    const response = await boundedPromise(
      args.fetchImpl(`${args.baseUrl}/api/health`, { headers: authHeader(), signal: controller.signal }),
      {
        timeoutMs: args.requestTimeoutMs,
        timeoutMessage: args.timeoutMessage,
        signal: args.startupSignal,
        abortMessage: args.abortMessage,
        onTimeout: () => controller.abort(),
      },
    );
    return response.ok;
  } finally {
    args.startupSignal?.removeEventListener("abort", abortController);
  }
}

class OpenCodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    let callerAborted = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const timeoutMessage = `OpenCode ${method} ${path} timed out after ${timeoutMs}ms.`;
    const abortMessage = `OpenCode ${method} ${path} was aborted.`;
    const abortFromCaller = (): void => {
      callerAborted = true;
      controller.abort();
    };
    if (options.signal?.aborted) {
      callerAborted = true;
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    try {
      const response = await boundedPromise(
        this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            ...authHeader(),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        }),
        {
          timeoutMs,
          timeoutMessage,
          signal: options.signal,
          abortMessage,
          onTimeout: () => {
            timedOut = true;
            controller.abort();
          },
        },
      );
      if (!response.ok) {
        const text = await boundedPromise(response.text(), {
          timeoutMs,
          timeoutMessage,
          signal: options.signal,
          abortMessage,
          onTimeout: () => {
            timedOut = true;
            controller.abort();
          },
        }).catch(() => "");
        throw new OpenCodeHttpError(method, path, response.status, previewResponseBody(text));
      }
      if (response.status === 204) return undefined as T;
      const text = await boundedPromise(response.text(), {
        timeoutMs,
        timeoutMessage,
        signal: options.signal,
        abortMessage,
        onTimeout: () => {
          timedOut = true;
          controller.abort();
        },
      });
      if (!text) return undefined as T;
      const contentType = responseContentType(response);
      if (!contentType.includes("application/json") && !contentType.includes("+json")) {
        throw new Error(unexpectedJsonResponseMessage(method, path, contentType, text));
      }
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        const preview = previewResponseBody(text);
        throw new Error(`OpenCode ${method} ${path} returned invalid JSON: ${errorMessage(error)}${preview ? `: ${preview}` : ""}`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) {
          throw new Error(`OpenCode ${method} ${path} timed out after ${timeoutMs}ms.`);
        }
        if (callerAborted) {
          throw new Error(`OpenCode ${method} ${path} was aborted.`);
        }
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async streamEvents(
    onEvent: (event: unknown) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/event`, {
      headers: authHeader(),
      signal,
    });
    if (!response.ok) {
      throw new Error(`OpenCode event stream failed with ${response.status}`);
    }
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const flushFrame = async (frame: string): Promise<void> => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") return;
      await onEvent(JSON.parse(data));
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        await flushFrame(frame);
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
    const tail = buffer.trim();
    if (tail) await flushFrame(tail);
  }
}

function normalizeEvent(raw: unknown): { type?: string; properties: Record<string, unknown> } {
  const wrapped = isRecord(raw) && isRecord(raw.payload) ? raw.payload : raw;
  if (!isRecord(wrapped)) return { properties: {} };
  if (wrapped.type === "sync") {
    const name = typeof wrapped.name === "string" ? wrapped.name.replace(/\.\d+$/, "") : undefined;
    return {
      type: name,
      properties: isRecord(wrapped.data) ? wrapped.data : {},
    };
  }
  return {
    type: typeof wrapped.type === "string" ? wrapped.type : undefined,
    properties: isRecord(wrapped.properties) ? wrapped.properties : wrapped,
  };
}

function sessionIdFromProperties(properties: Record<string, unknown>): string | undefined {
  return typeof properties.sessionID === "string" ? properties.sessionID : undefined;
}

function buildPermissionPendingInput(request: Record<string, unknown>): PendingInputState {
  const requestId = typeof request.id === "string" ? request.id : "opencode-permission";
  const permission = typeof request.permission === "string" ? request.permission : "permission";
  const patterns = Array.isArray(request.patterns)
    ? request.patterns.filter((value): value is string => typeof value === "string")
    : [];
  const promptText = patterns.length > 0
    ? `OpenCode requests ${permission} permission for ${patterns.join(", ")}.`
    : `OpenCode requests ${permission} permission.`;
  const actions: PendingInputAction[] = [
    { kind: "approval", label: "Allow once", decision: "accept", responseDecision: "once" },
    { kind: "approval", label: "Always allow", decision: "acceptForSession", responseDecision: "always" },
    { kind: "approval", label: "Reject", decision: "decline", responseDecision: "reject" },
  ];
  return {
    requestId,
    kind: "approval",
    promptText,
    options: actions.map((action) => action.label),
    actions,
    responseMode: "structured",
  };
}

function buildQuestionPendingInput(request: Record<string, unknown>): PendingInputState {
  const requestId = typeof request.id === "string" ? request.id : "opencode-question";
  const promptText = typeof request.question === "string"
    ? request.question
    : typeof request.prompt === "string"
      ? request.prompt
      : "OpenCode is asking for input.";
  const options = Array.isArray(request.options)
    ? request.options
        .map((option) => {
          if (typeof option === "string") return option;
          if (isRecord(option) && typeof option.label === "string") return option.label;
          return "";
        })
        .filter(Boolean)
    : [];
  return {
    requestId,
    kind: "question",
    promptText,
    options,
    allowsFreeText: true,
  };
}

function extractAssistantResult(messages: unknown): string | undefined {
  return extractAssistantMessageState(messages).result;
}

function extractAssistantMessageState(messages: unknown): { count: number; result?: string } {
  const records = Array.isArray(messages)
    ? messages
    : isRecord(messages) && Array.isArray(messages.messages)
      ? messages.messages
      : isRecord(messages) && Array.isArray(messages.items)
        ? messages.items
        : [];
  const texts: string[] = [];
  for (const entry of records) {
    const message = isRecord(entry) && isRecord(entry.info) ? entry.info : entry;
    if (!isRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : message.type;
    if (role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const parts = isRecord(entry) && Array.isArray(entry.parts) ? entry.parts : [];
    for (const part of [...content, ...parts]) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  return { count: texts.length, result: texts.at(-1) };
}

export class OpenCodeHarness implements AgentHarness {
  readonly name = "opencode";
  readonly backendKind = "opencode-server" as const;
  readonly supportedPermissionModes = [
    "default",
    "plan",
    "bypassPermissions",
  ] as const;
  readonly capabilities = {
    nativePendingInput: true,
    nativePlanArtifacts: false,
    worktrees: "plugin-managed",
  } as const;

  constructor(private readonly deps: OpenCodeHarnessDeps = {}) {}

  launch(options: HarnessLaunchOptions): HarnessSession {
    const queue = new HarnessMessageQueue();
    const fetchImpl = this.deps.fetch ?? fetch;
    let server: OpenCodeServerHandle | undefined;
    let client: OpenCodeClient | undefined;
    let clientPromise: Promise<OpenCodeClient> | undefined;
    let sessionId = options.resumeSessionId;
    let runCounter = 0;
    let currentPermissionMode = options.permissionMode ?? "default";
    let currentPendingInput: OpenCodePendingInput | undefined;
    let sessionValidated = !options.resumeSessionId;
    let sessionForked = false;
    let systemPromptInjected = false;
    const streamController = new AbortController();
    let activeWaitController: AbortController | undefined;
    let streamStarted = false;
    let turnInProgress = false;
    let turnWaitCompleted = false;
    let turnCompletionEmitted = false;
    let sessionInterrupted = false;
    let turnSawSseIdle = false;
    let lastBackendRefConversationId: string | undefined;
    const resolvedPendingInputRequestIds = new Set<string>();

    const emitRunCompleted = (data: Parameters<typeof createRunCompletedEvent>[0]): boolean => {
      if (turnCompletionEmitted) return false;
      turnCompletionEmitted = true;
      queue.enqueue(createRunCompletedEvent(data));
      return true;
    };
    const finishTurn = (
      success: boolean,
      outcome: "completed" | "failed" | "interrupted",
      result?: string,
    ): boolean => emitRunCompleted({
      success,
      outcome,
      duration_ms: 0,
      total_cost_usd: 0,
      num_turns: runCounter,
      result,
      session_id: sessionId ?? "",
    });

    const emitBackendRef = (): void => {
      if (!sessionId) return;
      if (lastBackendRefConversationId === sessionId) return;
      lastBackendRefConversationId = sessionId;
      queue.enqueue(createBackendRefEvent({
        kind: "opencode-server",
        conversationId: sessionId,
      }));
    };
    const resolvePendingInput = (requestId: string | undefined): void => {
      if (requestId && resolvedPendingInputRequestIds.has(requestId)) return;
      if (requestId) resolvedPendingInputRequestIds.add(requestId);
      queue.enqueue(createPendingInputResolvedEvent(requestId));
      if (requestId && currentPendingInput?.requestId === requestId) {
        currentPendingInput = undefined;
      }
    };

    const ensureClient = async (): Promise<OpenCodeClient> => {
      if (client) return client;
      clientPromise ??= (async () => {
        const handle = await (this.deps.createServer ?? defaultCreateServer)({
          cwd: options.cwd,
          signal: options.abortController?.signal,
          fetch: fetchImpl,
          requestTimeoutMs: this.deps.requestTimeoutMs,
          startupTimeoutMs: this.deps.startupTimeoutMs,
        });
        if (sessionInterrupted || options.abortController?.signal.aborted) {
          await handle.close().catch((): undefined => undefined);
          throw new Error("OpenCode startup was interrupted before session creation.");
        }
        server = handle;
        client = new OpenCodeClient(handle.baseUrl, fetchImpl, this.deps.requestTimeoutMs);
        return client;
      })();
      try {
        return await clientPromise;
      } catch (error) {
        clientPromise = undefined;
        throw error;
      }
    };

    const replyPermission = async (requestId: string, response: string): Promise<void> => {
      if (!client || !sessionId) return;
      await client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, {
        reply: response,
      });
    };

    const replyQuestion = async (requestId: string, answer: string): Promise<void> => {
      if (!client || !sessionId) return;
      await client.request("POST", `/question/${encodeURIComponent(requestId)}/reply`, {
        answers: [[answer]],
      });
    };

    const handleEvent = async (raw: unknown): Promise<void> => {
      const event = normalizeEvent(raw);
      const eventSessionId = sessionIdFromProperties(event.properties);
      if (eventSessionId && eventSessionId !== sessionId) return;

      if (
        (event.type === "session.next.text.delta" || event.type === "message.part.delta")
        && event.properties.field !== "reasoning"
        && typeof event.properties.delta === "string"
      ) {
        queue.enqueue(createTextDeltaEvent(event.properties.delta));
        return;
      }
      if (event.type === "session.next.tool.called" || event.type === "message.part.updated") {
        const part = isRecord(event.properties.part) ? event.properties.part : undefined;
        if (event.type === "message.part.updated" && part?.type !== "tool") {
          queue.enqueue({ type: "activity" });
          return;
        }
        const tool = typeof event.properties.tool === "string"
          ? event.properties.tool
          : typeof part?.tool === "string"
            ? part.tool
            : "tool";
        queue.enqueue(createToolCallEvent(tool, event.properties.input));
        return;
      }
      if (event.type === "session.next.step.failed" || event.type === "session.error") {
        const reason = isRecord(event.properties.error)
          && typeof event.properties.error.message === "string"
          ? event.properties.error.message
          : `${event.type} failed`;
        if (turnInProgress && !turnWaitCompleted) {
          activeWaitController?.abort();
          finishTurn(false, "failed", reason);
        }
        return;
      }
      if (event.type === "permission.asked") {
        if (currentPermissionMode === "bypassPermissions") {
          const requestId = typeof event.properties.id === "string" ? event.properties.id : undefined;
          if (requestId) {
            await replyPermission(requestId, "once").catch((): undefined => undefined);
            resolvePendingInput(requestId);
          }
          return;
        }
        const state = buildPermissionPendingInput(event.properties);
        currentPendingInput = {
          requestId: state.requestId,
          kind: "approval",
          options: state.options,
          actions: state.actions ?? [],
        };
        queue.enqueue(createPendingInputEvent(state));
        return;
      }
      if (event.type === "permission.replied") {
        const requestId = typeof event.properties.requestID === "string" ? event.properties.requestID : undefined;
        resolvePendingInput(requestId);
        return;
      }
      if (event.type === "question.asked") {
        const state = buildQuestionPendingInput(event.properties);
        currentPendingInput = {
          requestId: state.requestId,
          kind: "question",
          options: state.options,
          actions: [],
        };
        queue.enqueue(createPendingInputEvent(state));
        return;
      }
      if (event.type === "question.replied" || event.type === "question.rejected") {
        const requestId = typeof event.properties.requestID === "string" ? event.properties.requestID : undefined;
        resolvePendingInput(requestId);
        return;
      }
      if (
        event.type?.startsWith("session.next.")
        || event.type?.startsWith("message.")
        || event.type === "session.status"
        || event.type === "session.idle"
      ) {
        if (eventIndicatesSessionIdle(event)) {
          turnSawSseIdle = true;
        }
        queue.enqueue({ type: "activity" });
      }
    };

    const startEventStream = (): void => {
      if (streamStarted || !client) return;
      streamStarted = true;
      void client.streamEvents(handleEvent, streamController.signal)
        .catch((error) => {
          if (!streamController.signal.aborted && turnInProgress && !turnWaitCompleted) {
            activeWaitController?.abort();
            finishTurn(false, "failed", errorMessage(error));
          }
        })
        .finally(() => {
          streamStarted = false;
        });
    };

    const fetchSessionMessages = async (http: OpenCodeClient, id: string): Promise<unknown> => {
      return await http.request<unknown>("GET", `/session/${encodeURIComponent(id)}/message`);
    };

    const sendPrompt = async (http: OpenCodeClient, id: string, text: string, promptSystemPrompt: string | undefined, signal: AbortSignal): Promise<void> => {
      await http.request("POST", `/session/${encodeURIComponent(id)}/prompt_async`, classicPromptBody(text, options.model, promptSystemPrompt), { signal });
    };

    const waitForTurn = async (http: OpenCodeClient, id: string, baselineAssistantCount: number, signal: AbortSignal): Promise<void> => {
      const startedAt = Date.now();
      let observedBusy = false;
      let lastAssistantCount = baselineAssistantCount;
      let lastAssistantResult: string | undefined;
      let stableAssistantPolls = 0;
      let lastStatusError: string | undefined;
      const turnTimeoutMs = this.deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;
      while (true) {
        if (signal.aborted) throw new Error("wait aborted");
        const messages = await fetchSessionMessages(http, id).catch((): undefined => undefined);
        const assistantState = extractAssistantMessageState(messages);
        const hasNewAssistantResult = assistantState.count > baselineAssistantCount && Boolean(assistantState.result);
        if (hasNewAssistantResult && assistantState.count === lastAssistantCount && assistantState.result === lastAssistantResult) {
          stableAssistantPolls += 1;
        } else {
          stableAssistantPolls = hasNewAssistantResult ? 1 : 0;
          lastAssistantCount = assistantState.count;
          lastAssistantResult = assistantState.result;
        }

        let idle = false;
        try {
          const statuses = await http.request<unknown>("GET", "/session/status", undefined, {
            signal,
            timeoutMs: Math.min(this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, 10_000),
          });
          idle = isIdleSessionStatus(statuses, id);
          lastStatusError = undefined;
          if (!idle) {
            observedBusy = true;
          }
        } catch (error) {
          if (signal.aborted) throw new Error("wait aborted");
          lastStatusError = errorMessage(error);
        }

        if (idle && (observedBusy || assistantState.count > baselineAssistantCount)) {
          return;
        }
        if (turnSawSseIdle && assistantState.count > baselineAssistantCount) {
          return;
        }
        if (stableAssistantPolls >= 2 && (observedBusy || lastStatusError)) {
          return;
        }
        if (Date.now() - startedAt > turnTimeoutMs) {
          const statusSuffix = lastStatusError ? ` Last status error: ${lastStatusError}` : "";
          throw new Error(`Timed out waiting for OpenCode session ${id} to become idle after ${turnTimeoutMs}ms.${statusSuffix}`);
        }
        await delay(250);
      }
    };

    const ensureSession = async (): Promise<string> => {
      const http = await ensureClient();
      if (sessionId) {
        if (options.forkSession && !sessionForked) {
          const forked = await http.request<OpenCodeSession>("POST", `/session/${encodeURIComponent(sessionId)}/fork`, {});
          if (!forked.id) throw new Error("OpenCode fork did not return a session id.");
          sessionId = forked.id;
          sessionForked = true;
          sessionValidated = true;
        } else if (!sessionValidated) {
          await fetchSessionMessages(http, sessionId);
          sessionValidated = true;
        }
        emitBackendRef();
        startEventStream();
        return sessionId;
      }

      const model = toOpenCodeModel(options.model);
      const created = await http.request<OpenCodeSession>("POST", "/session", {
        ...(model ? { model } : {}),
        metadata: { client: "openclaw-code-agent" },
        permission: permissionRulesForMode(currentPermissionMode),
      });
      if (!created.id) throw new Error("OpenCode did not return a session id.");
      sessionId = created.id;
      sessionValidated = true;
      emitBackendRef();
      startEventStream();
      return sessionId;
    };

    const completeTurn = async (success: boolean, result?: string, outcome: "completed" | "failed" | "interrupted" = success ? "completed" : "failed"): Promise<void> => {
      let finalResult = result;
      if (success && client && sessionId) {
        const messages = await fetchSessionMessages(client, sessionId)
          .catch((): undefined => undefined);
        finalResult = finalResult ?? extractAssistantResult(messages);
      }
      finishTurn(success, outcome, finalResult);
    };

    const runTurn = async (text: string): Promise<void> => {
      turnInProgress = true;
      turnWaitCompleted = false;
      turnCompletionEmitted = false;
      turnSawSseIdle = false;
      try {
        const http = await ensureClient();
        if (sessionInterrupted) return;
        const id = await ensureSession();
        if (sessionInterrupted) return;
        queue.enqueue(createRunStartedEvent());
        runCounter += 1;
        const promptSystemPrompt = systemPromptInjected ? undefined : options.systemPrompt;
        const baselineMessages = await fetchSessionMessages(http, id).catch((): undefined => undefined);
        const baselineAssistantCount = extractAssistantMessageState(baselineMessages).count;
        const waitController = new AbortController();
        activeWaitController = waitController;
        await sendPrompt(http, id, text, promptSystemPrompt, waitController.signal);
        systemPromptInjected = true;
        await waitForTurn(http, id, baselineAssistantCount, waitController.signal);
        activeWaitController = undefined;
        turnWaitCompleted = true;
        await completeTurn(true);
      } catch (error) {
        activeWaitController = undefined;
        await completeTurn(false, errorMessage(error));
      } finally {
        turnInProgress = false;
        turnWaitCompleted = false;
      }
    };

    const promptIterable = typeof options.prompt === "string"
      ? (async function* (): AsyncGenerator<unknown> {
          yield { type: "user", text: options.prompt, session_id: options.resumeSessionId ?? "" };
        })()
      : options.prompt;

    void (async () => {
      try {
        for await (const rawMessage of promptIterable) {
          if (sessionInterrupted) break;
          const text = extractPromptText(rawMessage).trim();
          if (!text) continue;
          if (currentPendingInput?.kind === "question") {
            await replyQuestion(currentPendingInput.requestId, text);
            resolvePendingInput(currentPendingInput.requestId);
            continue;
          }
          await runTurn(text);
          if (sessionInterrupted) break;
        }
      } catch (error) {
        if (!sessionInterrupted) {
          if (!turnInProgress) turnCompletionEmitted = false;
          finishTurn(false, "failed", errorMessage(error));
        }
      } finally {
        streamController.abort();
        await server?.close().catch((): undefined => undefined);
        queue.close();
      }
    })();

    return {
      messages: queue.messages(),

      async setPermissionMode(mode: string): Promise<void> {
        if (sessionId) {
          const http = await ensureClient();
          await http.request("PATCH", `/session/${encodeURIComponent(sessionId)}`, {
            permission: permissionRulesForMode(mode),
          });
        }
        currentPermissionMode = mode;
        queue.enqueue(createSettingsChangedEvent(mode));
      },

      async submitPendingInputOption(index: number): Promise<boolean> {
        const pending = currentPendingInput;
        if (!pending) return false;
        if (pending.kind === "approval") {
          const action = pending.actions[index];
          const response = action?.kind === "approval" ? action.responseDecision : undefined;
          if (!response) return false;
          await replyPermission(pending.requestId, response);
          resolvePendingInput(pending.requestId);
          return true;
        }
        const option = pending.options[index];
        if (!option) return false;
        await replyQuestion(pending.requestId, option);
        resolvePendingInput(pending.requestId);
        return true;
      },

      async submitPendingInputText(text: string): Promise<boolean> {
        const pending = currentPendingInput;
        if (!pending || pending.kind !== "question") return false;
        await replyQuestion(pending.requestId, text);
        resolvePendingInput(pending.requestId);
        return true;
      },

      async interrupt(): Promise<void> {
        sessionInterrupted = true;
        streamController.abort();
        activeWaitController?.abort();
        if (!turnInProgress) {
          turnCompletionEmitted = false;
        }
        finishTurn(false, "interrupted");
        if (!client) {
          await server?.close().catch((): undefined => undefined);
          return;
        }
        if (!sessionId) return;
        const abortRequest = client.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`).catch((): undefined => undefined);
        await abortRequest;
      },
    };
  }

  buildUserMessage(text: string, sessionId: string): unknown {
    return { type: "user", text, session_id: sessionId };
  }
}
