import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
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
  createServer?: (options: { cwd: string }) => Promise<OpenCodeServerHandle>;
  fetch?: FetchLike;
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

async function startOpenCodeServerOnce(options: { cwd: string }): Promise<OpenCodeServerHandle> {
  const port = await getFreePort();
  const command = process.env[OPENCODE_COMMAND_ENV]?.trim() || "opencode";
  const child = spawn(command, [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode server exited before readiness.${stderr ? ` ${stderr.trim()}` : ""}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: authHeader() });
      if (response.ok) {
        return {
          baseUrl,
          async close(): Promise<void> {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(() => {
                if (child.exitCode === null) child.kill("SIGKILL");
                resolve();
              }, 2_000);
              child.once("exit", () => {
                clearTimeout(timeout);
                resolve();
              });
            });
          },
        };
      }
    } catch {
      // Retry until the process exits or the startup deadline is reached.
    }
    await delay(100);
  }

  child.kill("SIGTERM");
  throw new Error(`Timed out waiting for OpenCode server readiness.${stderr ? ` ${stderr.trim()}` : ""}`);
}

async function defaultCreateServer(options: { cwd: string }): Promise<OpenCodeServerHandle> {
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

class OpenCodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = options.signal ? undefined : new AbortController();
    const timeout = controller
      ? setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
      : undefined;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...authHeader(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: options.signal ?? controller?.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`OpenCode ${method} ${path} failed with ${response.status}${text ? `: ${text}` : ""}`);
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async streamEvents(
    onEvent: (event: unknown) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/event`, {
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
    const name = typeof wrapped.name === "string" ? wrapped.name.replace(/\.1$/, "") : undefined;
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
    if (!isRecord(message) || message.type !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.at(-1);
}

function buildPromptText(text: string, systemPrompt: string | undefined): string {
  const trimmedSystemPrompt = systemPrompt?.trim();
  return trimmedSystemPrompt ? `${trimmedSystemPrompt}\n\n${text}` : text;
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
    let sessionId = options.resumeSessionId;
    let runCounter = 0;
    let currentPermissionMode = options.permissionMode ?? "default";
    let currentPendingInput: OpenCodePendingInput | undefined;
    let firstResumedPrompt = !!options.resumeSessionId;
    let systemPromptInjected = false;
    const streamController = new AbortController();
    let activeWaitController: AbortController | undefined;
    let streamStarted = false;
    let turnInProgress = false;
    let turnCompletionEmitted = false;
    let sessionInterrupted = false;
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
      server = await (this.deps.createServer ?? defaultCreateServer)({ cwd: options.cwd });
      client = new OpenCodeClient(server.baseUrl, fetchImpl);
      return client;
    };

    const replyPermission = async (requestId: string, response: string): Promise<void> => {
      if (!client || !sessionId) return;
      await client.request("POST", `/api/session/${encodeURIComponent(sessionId)}/permission/request/${encodeURIComponent(requestId)}/reply`, {
        response,
      });
    };

    const replyQuestion = async (requestId: string, answer: string): Promise<void> => {
      if (!client || !sessionId) return;
      await client.request("POST", `/api/session/${encodeURIComponent(sessionId)}/question/request/${encodeURIComponent(requestId)}/reply`, {
        answers: [[answer]],
      });
    };

    const handleEvent = async (raw: unknown): Promise<void> => {
      const event = normalizeEvent(raw);
      const eventSessionId = sessionIdFromProperties(event.properties);
      if (eventSessionId && sessionId && eventSessionId !== sessionId) return;

      if (event.type === "session.next.text.delta" && typeof event.properties.delta === "string") {
        queue.enqueue(createTextDeltaEvent(event.properties.delta));
        return;
      }
      if (event.type === "session.next.tool.called") {
        const tool = typeof event.properties.tool === "string" ? event.properties.tool : "tool";
        queue.enqueue(createToolCallEvent(tool, event.properties.input));
        return;
      }
      if (event.type === "session.next.step.failed" || event.type === "session.error") {
        const reason = isRecord(event.properties.error)
          && typeof event.properties.error.message === "string"
          ? event.properties.error.message
          : `${event.type} failed`;
        if (turnInProgress) {
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
      if (event.type?.startsWith("session.next.") || event.type === "session.idle") {
        queue.enqueue({ type: "activity" });
      }
    };

    const startEventStream = (): void => {
      if (streamStarted || !client) return;
      streamStarted = true;
      void client.streamEvents(handleEvent, streamController.signal).catch((error) => {
        if (!streamController.signal.aborted && turnInProgress) {
          activeWaitController?.abort();
          finishTurn(false, "failed", errorMessage(error));
        }
      });
    };

    const ensureSession = async (): Promise<string> => {
      const http = await ensureClient();
      if (sessionId) {
        if (options.forkSession) {
          const forked = await http.request<OpenCodeSession>("POST", `/session/${encodeURIComponent(sessionId)}/fork`, {});
          if (!forked.id) throw new Error("OpenCode fork did not return a session id.");
          sessionId = forked.id;
          firstResumedPrompt = false;
        } else {
          await http.request("GET", `/api/session/${encodeURIComponent(sessionId)}/context`);
        }
        emitBackendRef();
        startEventStream();
        return sessionId;
      }

      const created = await http.request<OpenCodeSession>("POST", "/session", {
        ...(toOpenCodeModel(options.model) ? { model: toOpenCodeModel(options.model) } : {}),
        metadata: { client: "openclaw-code-agent" },
        permission: permissionRulesForMode(currentPermissionMode),
      });
      if (!created.id) throw new Error("OpenCode did not return a session id.");
      sessionId = created.id;
      emitBackendRef();
      startEventStream();
      return sessionId;
    };

    const completeTurn = async (success: boolean, result?: string, outcome: "completed" | "failed" | "interrupted" = success ? "completed" : "failed"): Promise<void> => {
      let finalResult = result;
      if (success && client && sessionId) {
        const messages = await client.request<unknown>("GET", `/api/session/${encodeURIComponent(sessionId)}/context`)
          .catch((): undefined => undefined);
        finalResult = finalResult ?? extractAssistantResult(messages);
      }
      finishTurn(success, outcome, finalResult);
    };

    const runTurn = async (text: string): Promise<void> => {
      turnInProgress = true;
      turnCompletionEmitted = false;
      try {
        const http = await ensureClient();
        if (sessionInterrupted) return;
        const id = await ensureSession();
        if (sessionInterrupted) return;
        queue.enqueue(createRunStartedEvent());
        runCounter += 1;
        const promptSystemPrompt = systemPromptInjected ? undefined : options.systemPrompt;
        await http.request("POST", `/api/session/${encodeURIComponent(id)}/prompt`, {
          prompt: { text: buildPromptText(text, promptSystemPrompt) },
          delivery: "queue",
          ...(firstResumedPrompt ? { resume: true } : {}),
        });
        systemPromptInjected = true;
        firstResumedPrompt = false;
        const waitController = new AbortController();
        activeWaitController = waitController;
        await http.request("POST", `/api/session/${encodeURIComponent(id)}/wait`, undefined, {
          signal: waitController.signal,
        });
        activeWaitController = undefined;
        await completeTurn(true);
      } catch (error) {
        activeWaitController = undefined;
        await completeTurn(false, errorMessage(error));
      } finally {
        turnInProgress = false;
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
        currentPermissionMode = mode;
        const http = await ensureClient();
        if (sessionId) {
          await http.request("PATCH", `/session/${encodeURIComponent(sessionId)}`, {
            permission: permissionRulesForMode(mode),
          });
        }
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
        if (!turnInProgress) {
          turnCompletionEmitted = false;
        }
        finishTurn(false, "interrupted");
        if (!client || !sessionId) return;
        const abortRequest = client.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`).catch((): undefined => undefined);
        activeWaitController?.abort();
        await abortRequest;
      },
    };
  }

  buildUserMessage(text: string, sessionId: string): unknown {
    return { type: "user", text, session_id: sessionId };
  }
}
