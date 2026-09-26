import { randomBytes } from "node:crypto";
import { buildHarnessChildEnv } from "../child-env";
import { spawnWithLifeline } from "./process-lifeline";
import { constants as fsConstants, accessSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import type {
  PendingInputAction,
  PendingInputQuestion,
  PendingInputState,
} from "../types";
import {
  extractPendingInputOptions,
  extractPendingInputQuestions,
  formatPendingInputWizardQuestion,
  matchApprovalChoiceText,
  resolvePendingInputAnswer,
} from "../pending-input-normalization";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessModelUsage,
  HarnessSession,
  HarnessUsage,
} from "./types";
import {
  createBackendRefEvent,
  createPendingInputEvent,
  createPendingInputResolvedEvent,
  createRunCompletedEvent,
  createPromptSettledEvent,
  createRunStartedEvent,
  createSettingsChangedEvent,
  createTextDeltaEvent,
  PromptReader,
  createToolCallEvent,
  HarnessMessageQueue,
} from "./harness-events";
import { createLogger } from "../logger";

const log = createLogger("opencode-harness");

type FetchLike = typeof fetch;

/** A running `opencode serve` process (or a test double). */
export interface OpenCodeServerHandle {
  baseUrl: string;
  /** `Authorization` header value for this server (N1: every spawn has its own password). */
  authorization?: string;
  close(): Promise<void>;
  /** Register a listener for an unexpected server exit. */
  onExit?(listener: (reason: string) => void): void;
}

export interface OpenCodeServerStartOptions {
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

interface OpenCodeHarnessDeps {
  createServer?: (options: OpenCodeServerStartOptions) => Promise<OpenCodeServerHandle>;
  fetch?: FetchLike;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** How long the shared server outlives its last session (default 30s). */
  serverIdleShutdownMs?: number;
  /** Poll interval used only while the event stream is disconnected. */
  fallbackPollIntervalMs?: number;
  /** Delay before reconnecting a dropped event stream. */
  streamReconnectDelayMs?: number;
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
  state?: PendingInputState;
  answers?: Record<string, { answers: string[] }>;
};

type NormalizedEvent = {
  type?: string;
  properties: Record<string, unknown>;
  /**
   * N24: the event belongs to a subagent (child) session of the listening
   * session, for example a permission prompt raised inside the `task` tool.
   */
  childSessionId?: string;
};

const OPENCODE_COMMAND_ENV = "OPENCLAW_OPENCODE_COMMAND";
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;
const SESSION_COST_TIMEOUT_MS = 250;
const TURN_TIMEOUT_MS = 15 * 60_000;
const SERVER_IDLE_SHUTDOWN_MS = 30_000;
const FALLBACK_POLL_INTERVAL_MS = 500;
const STREAM_RECONNECT_DELAY_MS = 1_000;
const STREAM_READY_TIMEOUT_MS = 2_000;
const LISTENING_LINE = /opencode server listening on (https?:\/\/\S+)/;
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

export function candidateSearchPaths(envPath: string | undefined): string[] {
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
  // N6: only standard system locations; a Homebrew/Linuxbrew install must be on
  // the Gateway's PATH or named by OPENCLAW_OPENCODE_COMMAND.
  expanded.push("/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(expanded)];
}

/**
 * Resolve the OpenCode executable to an absolute path against the Gateway's
 * working directory. The server is spawned with `cwd: tmpdir()`, so a relative
 * override such as `./bin/opencode` (or a relative PATH entry) would otherwise
 * be looked up from the temp directory.
 */
export function resolveCommandPath(command: string, envPath = process.env.PATH, baseDir = process.cwd()): string {
  // Prefix relative paths without normalizing: `..` must still be resolved by
  // the OS after symlinks, and absolute overrides pass through unchanged.
  const anchor = (path: string): string => (isAbsolute(path) ? path : `${baseDir}${sep}${path}`);
  if (commandHasPathSeparator(command)) return anchor(command);
  for (const entry of candidateSearchPaths(envPath)) {
    const candidate = isAbsolute(entry) ? join(entry, command) : `${anchor(entry)}${sep}${command}`;
    if (isExecutable(candidate)) return candidate;
  }
  return command;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sessionCostUsd(session: OpenCodeSession | undefined): number | undefined {
  const cost = finiteNumber(session?.cost);
  return cost !== undefined && cost >= 0 ? cost : undefined;
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

/** OpenCode's built-in agent for a permission mode (plan agent is read-only). */
export function openCodeAgentForMode(mode: string | undefined): "plan" | "build" {
  return mode === "plan" ? "plan" : "build";
}

/**
 * Session permission overlay for a permission mode. Session rules are
 * evaluated after the agent's own rules, so they override them.
 *
 * - plan: the built-in `plan` agent already denies edits (except its own plan
 *   files) and general subagents. It allows shell commands and only asks the
 *   model to keep them read-only, so OCA keeps `bash` hard-denied and blocks
 *   paths outside the project to preserve the read-only guarantee.
 * - default: mutating tools ask, and OCA routes the prompts to the user.
 * - bypassPermissions: mutating tools are allowed without prompts.
 */
export function permissionRulesForMode(mode: string | undefined): Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }> {
  const effective = mode ?? "default";
  if (effective === "plan") {
    return [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ];
  }
  const action = effective === "bypassPermissions" ? "allow" : "ask";
  return MUTATION_PERMISSIONS.map((permission) => ({
    permission,
    pattern: "*",
    action,
  }));
}

const OPENCODE_SERVER_USERNAME = "opencode";

/** Basic-auth header value for an OpenCode server password. */
export function openCodeAuthorization(password: string, username = OPENCODE_SERVER_USERNAME): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * Headers for every request to the local OpenCode server.
 *
 * `connection: close` turns off HTTP keep-alive. The shared server is restarted
 * after an exit and `--port 0` usually binds the same port (4096) again, so a
 * pooled keep-alive socket from the previous server generation could be reused
 * for the first request to the new one and fail with ECONNRESET ("fetch
 * failed"). A fresh loopback connection per request costs next to nothing.
 */
function requestHeaders(authorization: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(authorization ? { Authorization: authorization } : {}), connection: "close", ...extra };
}

const CONNECTION_RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

/** A request that failed because its connection was reset before a response arrived. */
export function isConnectionResetError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECTION_RESET_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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

/**
 * Start `opencode serve` on an OS-chosen port and read the bound URL from its
 * `opencode server listening on <url>` stdout line. With `--port 0` OpenCode
 * tries 4096 first and falls back to any free port, so the printed URL is the
 * only reliable address.
 */
export async function startOpenCodeServer(options: OpenCodeServerStartOptions = {}): Promise<OpenCodeServerHandle> {
  const requestedCommand = process.env[OPENCODE_COMMAND_ENV]?.trim() || "opencode";
  const command = resolveCommandPath(requestedCommand);
  const args = ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"];
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  // The server resolves a project instance per request (`?directory=`), so its
  // own working directory is irrelevant; keep it out of any repository.
  const serverCwd = tmpdir();
  // N1: without a password `opencode serve` accepts any local connection, and
  // every local user or process could drive the agent. Each spawn gets its own
  // random password, known only to this Gateway process.
  const password = randomBytes(24).toString("base64url");
  // N27: the server runs under a lifeline watchdog in its own process group,
  // so it (and its tool processes) stops with the Gateway, even on SIGKILL.
  const lifeline = spawnWithLifeline(command, args, {
    cwd: serverCwd,
    // Gateway environment minus secrets unrelated to the agent (see child-env.ts).
    env: buildHarnessChildEnv(process.env, {
      OPENCODE_SERVER_USERNAME: OPENCODE_SERVER_USERNAME,
      OPENCODE_SERVER_PASSWORD: password,
    }),
  });
  const child = lifeline.process;
  let stdout = "";
  let stderr = "";
  const appendOutput = (current: string, chunk: unknown): string => {
    const next = current + String(chunk);
    return next.length > 8_000 ? next.slice(-8_000) : next;
  };
  const describeLaunch = (): string => {
    const commandDescription = requestedCommand === command ? command : `${command} (resolved from ${requestedCommand})`;
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
    return ` Command: ${commandDescription} ${args.join(" ")}. PATH: ${process.env.PATH ?? ""}.${output ? ` Output:\n${output}` : ""}`;
  };

  const exitListeners: Array<(reason: string) => void> = [];
  let closing = false;
  let listening = false;

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void lifeline.terminate();
      reject(new Error(`Timed out waiting for OpenCode server readiness after ${startupTimeoutMs}ms.${describeLaunch()}`));
    }, startupTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
      if (listening) return;
      const match = LISTENING_LINE.exec(stdout);
      if (match) {
        listening = true;
        clearTimeout(timeout);
        resolve(match[1].replace(/\/+$/, ""));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`OpenCode server failed to start: ${error.message}${describeLaunch()}`));
    });
    child.once("exit", (code, signal) => {
      if (!listening) {
        clearTimeout(timeout);
        reject(new Error(`OpenCode server exited before readiness (${signal ?? `code ${code}`}).${describeLaunch()}`));
        return;
      }
      if (closing) return;
      const reason = `OpenCode server exited unexpectedly (${signal ?? `code ${code}`}).${describeLaunch()}`;
      for (const listener of exitListeners) listener(reason);
    });
  });

  // The shared server can outlive its last session for a short idle window;
  // never leave it running after the Gateway process itself exits (a normal
  // exit; the lifeline pipe covers a killed Gateway).
  const killOnParentExit = (): void => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  process.once("exit", killOnParentExit);
  child.once("exit", () => process.removeListener("exit", killOnParentExit));

  return {
    baseUrl,
    authorization: openCodeAuthorization(password),
    close: async () => {
      closing = true;
      await lifeline.terminate();
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
  };
}

/** A turn failure OpenCode reported with an error class (`error.name`). */
class OpenCodeTurnError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
    this.name = "OpenCodeTurnError";
  }
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

function classicPromptBody(args: {
  text: string;
  model: string | undefined;
  systemPrompt: string | undefined;
  agent: string;
  variant: string | undefined;
}): Record<string, unknown> {
  const parsed = parseModel(args.model);
  return {
    ...(parsed ? { model: { providerID: parsed.providerID, modelID: parsed.modelID } } : {}),
    agent: args.agent,
    // Model-specific reasoning variant; OpenCode ignores names the model lacks.
    ...(args.variant ? { variant: args.variant } : {}),
    ...(args.systemPrompt?.trim() ? { system: args.systemPrompt.trim() } : {}),
    parts: [{ type: "text", text: args.text }],
  };
}

function isIdleSessionStatus(statuses: unknown, sessionId: string): boolean {
  if (!isRecord(statuses)) return false;
  if (!(sessionId in statuses)) return true;
  const status = statuses[sessionId];
  return isRecord(status) && status.type === "idle";
}

function eventStatusType(event: NormalizedEvent): string | undefined {
  const status = event.properties.status;
  if (isRecord(status) && typeof status.type === "string") return status.type;
  if (typeof status === "string") return status;
  return typeof event.properties.type === "string" ? event.properties.type : undefined;
}

function eventIndicatesSessionIdle(event: NormalizedEvent): boolean {
  if (event.type === "session.idle") return true;
  return event.type === "session.status" && eventStatusType(event) === "idle";
}

type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with the headers of a successful response (paging cursors). */
  onHeaders?: (headers: Headers) => void;
};

/** One page of `GET /session/{id}/message`: chronological entries and the cursor to older ones. */
type MessagePage = { entries: unknown[]; nextCursor?: string };

/** Directory-scoped HTTP client for the classic OpenCode API. */
class OpenCodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
    private readonly directory?: string,
    private readonly authorization?: string,
  ) {}

  /** A client whose every request targets `directory` on the shared server. */
  forDirectory(directory: string): OpenCodeClient {
    return new OpenCodeClient(this.baseUrl, this.fetchImpl, this.requestTimeoutMs, directory, this.authorization);
  }

  private url(path: string): string {
    if (!this.directory) return `${this.baseUrl}${path}`;
    const separator = path.includes("?") ? "&" : "?";
    return `${this.baseUrl}${path}${separator}directory=${encodeURIComponent(this.directory)}`;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    try {
      return await this.requestOnce<T>(method, path, body, options);
    } catch (error) {
      // A reset connection never reached a handler; repeating a read is safe.
      // Writes are not retried: the server may have applied them.
      if (method !== "GET" || !isConnectionResetError(error) || options.signal?.aborted) throw error;
      log.warn(`OpenCode ${method} ${path} connection was reset; retrying once.`);
      return await this.requestOnce<T>(method, path, body, options);
    }
  }

  private async requestOnce<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
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
    const bounded = <V>(promise: Promise<V>): Promise<V> => boundedPromise(promise, {
      timeoutMs,
      timeoutMessage,
      signal: options.signal,
      abortMessage,
      onTimeout: () => {
        timedOut = true;
        controller.abort();
      },
    });
    try {
      const response = await bounded(this.fetchImpl(this.url(path), {
        method,
        headers: requestHeaders(this.authorization, body === undefined ? {} : { "content-type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      }));
      if (!response.ok) {
        const text = await bounded(response.text()).catch(() => "");
        throw new OpenCodeHttpError(method, path, response.status, previewResponseBody(text));
      }
      options.onHeaders?.(response.headers);
      if (response.status === 204) return undefined as T;
      const text = await bounded(response.text());
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

  /** Consume an SSE stream until it ends. `onOpen` fires once the stream is connected. */
  async streamEvents(
    path: string,
    onEvent: (event: unknown) => void,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<void> {
    const response = await this.fetchImpl(this.url(path), {
      headers: requestHeaders(this.authorization),
      signal,
    });
    if (!response.ok) {
      throw new Error(`OpenCode event stream failed with ${response.status}`);
    }
    onOpen?.();
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const flushFrame = (frame: string): void => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") return;
      try {
        onEvent(JSON.parse(data));
      } catch {
        // A malformed frame must not tear down the shared stream.
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        flushFrame(frame);
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
    const tail = buffer.trim();
    if (tail) flushFrame(tail);
  }
}

/**
 * Normalize classic (`{type, properties}`), global (`{directory, payload}`)
 * and v2 sync (`{type:"sync", name, data}`) event envelopes.
 */
function normalizeEvent(raw: unknown): NormalizedEvent {
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
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = isRecord(properties.info) ? properties.info : undefined;
  if (typeof info?.sessionID === "string") return info.sessionID;
  const part = isRecord(properties.part) ? properties.part : undefined;
  return typeof part?.sessionID === "string" ? part.sessionID : undefined;
}

type SessionEventListener = {
  onEvent(event: NormalizedEvent): void;
  /** A subagent (child) session of this session was created. */
  onChildSession?(childSessionId: string): void;
  /** The shared event stream dropped; events may have been missed. */
  onStreamGap(): void;
  /** The shared server process died. */
  onServerExit(reason: string): void;
};

type SharedServer = {
  handle: OpenCodeServerHandle;
  client: OpenCodeClient;
  alive: boolean;
  exitReason?: string;
  leases: number;
  listeners: Map<string, Set<SessionEventListener>>;
  /** Subagent session id → the listened-to session it descends from (N24). */
  childSessions: Map<string, string>;
  streamAbort: AbortController;
  streamConnected: boolean;
  streamReady: Promise<void>;
};

interface OpenCodeServerLease {
  /** Directory-scoped client for this session's project. */
  client: OpenCodeClient;
  readonly alive: boolean;
  readonly exitReason: string | undefined;
  readonly streamConnected: boolean;
  subscribe(sessionId: string, listener: SessionEventListener): () => void;
  release(): Promise<void>;
}

/**
 * One lazily started `opencode serve` process shared by every OpenCode
 * session of this plugin. OpenCode serves any project through the
 * `?directory=` parameter, and sessions run concurrently on one server, so
 * per-session processes and a startup mutex are unnecessary. A single
 * `/global/event` stream is demultiplexed by session id. If the process dies,
 * every in-flight turn fails with the exit reason and the next turn starts a
 * fresh server (OpenCode persists sessions, so they continue).
 */
class OpenCodeServerManager {
  private current?: SharedServer;
  private starting?: Promise<SharedServer>;
  private idleTimer?: NodeJS.Timeout;
  /** Launches currently waiting for the server to start. */
  private waiting = 0;

  constructor(private readonly deps: OpenCodeHarnessDeps) {}

  async acquire(directory: string, signal?: AbortSignal): Promise<OpenCodeServerLease> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const startup = this.ensureServer();
    this.waiting += 1;
    let server: SharedServer;
    try {
      server = signal
        ? await boundedPromise(startup, {
            timeoutMs: (this.deps.startupTimeoutMs ?? STARTUP_TIMEOUT_MS) + 5_000,
            timeoutMessage: "Timed out waiting for the shared OpenCode server.",
            signal,
            abortMessage: "OpenCode startup was interrupted before session creation.",
          })
        : await startup;
    } catch (error) {
      this.waiting -= 1;
      // The launch gave up, but startup may still finish: never leave a server
      // that nobody holds running without an idle-shutdown timer.
      startup.then((started) => this.releaseIfUnused(started), (): undefined => undefined);
      throw error;
    }
    this.waiting -= 1;
    server.leases += 1;
    await boundedPromise(server.streamReady, {
      timeoutMs: STREAM_READY_TIMEOUT_MS,
      timeoutMessage: "event stream not ready",
    }).catch((): undefined => undefined);
    let released = false;
    return {
      client: server.client.forDirectory(directory),
      get alive() { return server.alive; },
      get exitReason() { return server.exitReason; },
      get streamConnected() { return server.streamConnected; },
      subscribe: (sessionId, listener) => {
        let set = server.listeners.get(sessionId);
        if (!set) {
          set = new Set();
          server.listeners.set(sessionId, set);
        }
        set.add(listener);
        return () => {
          const listeners = server.listeners.get(sessionId);
          listeners?.delete(listener);
          if (listeners?.size === 0) {
            server.listeners.delete(sessionId);
            for (const [child, root] of server.childSessions) {
              if (root === sessionId) server.childSessions.delete(child);
            }
          }
        };
      },
      release: async () => {
        if (released) return;
        released = true;
        server.leases -= 1;
        await this.releaseIfUnused(server);
      },
    };
  }

  /** Shut down (now or after the idle window) a server that no session holds or awaits. */
  private async releaseIfUnused(server: SharedServer): Promise<void> {
    if (server.leases > 0 || this.waiting > 0 || server !== this.current || this.idleTimer) return;
    const idleMs = this.deps.serverIdleShutdownMs ?? SERVER_IDLE_SHUTDOWN_MS;
    if (idleMs <= 0) {
      await this.shutdown(server);
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (server.leases === 0 && this.waiting === 0 && server === this.current) void this.shutdown(server);
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private async ensureServer(): Promise<SharedServer> {
    if (this.current?.alive) return this.current;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return await this.starting;
  }

  private async start(): Promise<SharedServer> {
    const fetchImpl = this.deps.fetch ?? fetch;
    const handle = await (this.deps.createServer ?? startOpenCodeServer)({
      fetch: fetchImpl,
      requestTimeoutMs: this.deps.requestTimeoutMs,
      startupTimeoutMs: this.deps.startupTimeoutMs,
    });
    let markReady!: () => void;
    const server: SharedServer = {
      handle,
      client: new OpenCodeClient(handle.baseUrl, fetchImpl, this.deps.requestTimeoutMs, undefined, handle.authorization),
      alive: true,
      leases: 0,
      listeners: new Map(),
      childSessions: new Map(),
      streamAbort: new AbortController(),
      streamConnected: false,
      streamReady: new Promise<void>((resolve) => { markReady = resolve; }),
    };
    handle.onExit?.((reason) => this.handleExit(server, reason));
    this.current = server;
    void this.runEventStream(server, markReady);
    return server;
  }

  private dispatch(server: SharedServer, raw: unknown): void {
    const event = normalizeEvent(raw);
    this.trackChildSession(server, event);
    const sessionId = sessionIdFromProperties(event.properties);
    if (!sessionId) return;
    const direct = server.listeners.get(sessionId);
    if (direct) {
      for (const listener of [...direct]) listener.onEvent(event);
      return;
    }
    // N24: a subagent's events reach the session that started it (its
    // permission prompts and questions would otherwise never be seen).
    const root = server.childSessions.get(sessionId);
    if (!root) return;
    for (const listener of [...(server.listeners.get(root) ?? [])]) {
      listener.onEvent({ ...event, childSessionId: sessionId });
    }
  }

  /** Record `session.created`/`session.updated` of a subagent session under its listened-to ancestor. */
  private trackChildSession(server: SharedServer, event: NormalizedEvent): void {
    if (event.type !== "session.created" && event.type !== "session.updated") return;
    const info = isRecord(event.properties.info) ? event.properties.info : undefined;
    const childId = typeof info?.id === "string" ? info.id : undefined;
    const parentId = typeof info?.parentID === "string" ? info.parentID : undefined;
    if (!childId || !parentId || server.childSessions.has(childId)) return;
    const root = server.listeners.has(parentId) ? parentId : server.childSessions.get(parentId);
    if (!root) return;
    server.childSessions.set(childId, root);
    for (const listener of [...(server.listeners.get(root) ?? [])]) listener.onChildSession?.(childId);
  }

  private notifyAll(server: SharedServer, fn: (listener: SessionEventListener) => void): void {
    for (const listeners of [...server.listeners.values()]) {
      for (const listener of [...listeners]) fn(listener);
    }
  }

  private async runEventStream(server: SharedServer, markReady: () => void): Promise<void> {
    let everConnected = false;
    while (server.alive && !server.streamAbort.signal.aborted) {
      try {
        await server.client.streamEvents("/global/event", (raw) => this.dispatch(server, raw), server.streamAbort.signal, () => {
          server.streamConnected = true;
          if (everConnected) {
            // Reconnected: events during the gap are lost, so let sessions
            // reconcile their turns against the session status/messages.
            this.notifyAll(server, (listener) => listener.onStreamGap());
          }
          everConnected = true;
          markReady();
        });
      } catch {
        // Handled below as a gap.
      }
      server.streamConnected = false;
      markReady();
      if (!server.alive || server.streamAbort.signal.aborted) return;
      this.notifyAll(server, (listener) => listener.onStreamGap());
      await delay(this.deps.streamReconnectDelayMs ?? STREAM_RECONNECT_DELAY_MS);
    }
  }

  private handleExit(server: SharedServer, reason: string): void {
    if (!server.alive) return;
    server.alive = false;
    server.exitReason = reason;
    server.streamAbort.abort();
    if (this.current === server) this.current = undefined;
    this.notifyAll(server, (listener) => listener.onServerExit(reason));
  }

  private async shutdown(server: SharedServer): Promise<void> {
    server.alive = false;
    server.streamAbort.abort();
    if (this.current === server) this.current = undefined;
    await server.handle.close().catch((): undefined => undefined);
  }
}

function buildPermissionPendingInput(request: Record<string, unknown>, childSessionId?: string): PendingInputState {
  const requestId = typeof request.id === "string" ? request.id : "opencode-permission";
  const permission = typeof request.permission === "string" ? request.permission : "permission";
  const patterns = Array.isArray(request.patterns)
    ? request.patterns.filter((value): value is string => typeof value === "string")
    : [];
  const who = childSessionId ? "An OpenCode subagent" : "OpenCode";
  const promptText = patterns.length > 0
    ? `${who} requests ${permission} permission for ${patterns.join(", ")}.`
    : `${who} requests ${permission} permission.`;
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
    // Text replies map onto a decision; other text rejects with it as feedback.
    allowsFreeText: true,
    responseMode: "structured",
  };
}

/** OpenCode question fields: `multiple` (multi-select) and `custom` (free text, default on). */
function applyOpenCodeQuestionFlags(questions: PendingInputQuestion[], request: Record<string, unknown>): PendingInputQuestion[] {
  const rawQuestions = Array.isArray(request.questions) ? request.questions : [];
  return questions.map((question, index) => {
    const raw = isRecord(rawQuestions[index]) ? rawQuestions[index] : undefined;
    if (!raw) return question;
    const multiSelect = question.multiSelect === true || raw.multiple === true;
    return {
      ...question,
      ...(multiSelect ? { multiSelect: true } : {}),
      // `custom: false` restricts answers to the listed options.
      allowsFreeText: raw.custom !== false,
    };
  });
}

function buildQuestionPendingInput(request: Record<string, unknown>): PendingInputState {
  const requestId = typeof request.id === "string" ? request.id : "opencode-question";
  const promptText = typeof request.question === "string"
    ? request.question
    : typeof request.prompt === "string"
      ? request.prompt
      : "OpenCode is asking for input.";
  const normalizedQuestions = applyOpenCodeQuestionFlags(extractPendingInputQuestions(request), request);
  const topLevelOptions = extractPendingInputOptions(request);
  const questions: PendingInputQuestion[] = normalizedQuestions.length > 0
    ? normalizedQuestions
    : [{
        id: requestId,
        question: promptText,
        options: topLevelOptions,
        allowsFreeText: true,
      }];
  const activeQuestionIndex = questions.length > 0 ? 0 : undefined;
  const activeQuestion = activeQuestionIndex != null ? questions[activeQuestionIndex] : undefined;
  const options = activeQuestion?.options.map((option) => option.label) ?? topLevelOptions.map((option) => option.label);
  return {
    requestId,
    kind: "question",
    promptText: activeQuestion
      ? formatPendingInputWizardQuestion(activeQuestion, activeQuestionIndex ?? 0, questions.length)
      : promptText,
    options,
    ...(questions.length > 0 ? { questions } : {}),
    ...(activeQuestionIndex != null ? { activeQuestionIndex } : {}),
    allowsFreeText: true,
  };
}

function updateOpenCodeWizardState(
  base: PendingInputState,
  activeQuestionIndex: number,
  answers: Record<string, { answers: string[] }>,
): PendingInputState {
  const questions = base.questions ?? [];
  const question = questions[activeQuestionIndex];
  const options = question?.options.map((option) => option.label) ?? [];
  return {
    ...base,
    promptText: question
      ? formatPendingInputWizardQuestion(question, activeQuestionIndex, questions.length)
      : base.promptText,
    options,
    activeQuestionIndex,
    answers,
  };
}

type AssistantRecord = {
  id?: string;
  text?: string;
  error?: string;
  /** OpenCode's error class (`ProviderAuthError`, `APIError`, ...), reported as `errorCode` (N16). */
  errorName?: string;
  cost?: number;
  providerID?: string;
  modelID?: string;
  created?: number;
  completed?: number;
  tokens?: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

function assistantErrorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === "string" && error.name ? error.name : undefined;
}

function assistantErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const data = isRecord(error.data) ? error.data : undefined;
  if (typeof data?.message === "string" && data.message) return data.message;
  if (typeof error.message === "string" && error.message) return error.message;
  return typeof error.name === "string" ? error.name : undefined;
}

function parseAssistantTokens(value: unknown): AssistantRecord["tokens"] {
  if (!isRecord(value)) return undefined;
  const cache = isRecord(value.cache) ? value.cache : {};
  return {
    ...(finiteNumber(value.total) !== undefined ? { total: finiteNumber(value.total) } : {}),
    input: finiteNumber(value.input) ?? 0,
    output: finiteNumber(value.output) ?? 0,
    reasoning: finiteNumber(value.reasoning) ?? 0,
    cacheRead: finiteNumber(cache.read) ?? 0,
    cacheWrite: finiteNumber(cache.write) ?? 0,
  };
}

/** Assistant messages from `GET /session/{id}/message` in order (classic and current shapes). */
function extractAssistantRecords(messages: unknown): AssistantRecord[] {
  const entries = Array.isArray(messages)
    ? messages
    : isRecord(messages) && Array.isArray(messages.messages)
      ? messages.messages
      : isRecord(messages) && Array.isArray(messages.items)
        ? messages.items
        : [];
  const records: AssistantRecord[] = [];
  for (const entry of entries) {
    const info = isRecord(entry) && isRecord(entry.info) ? entry.info : entry;
    if (!isRecord(info)) continue;
    const role = typeof info.role === "string" ? info.role : info.type;
    if (role !== "assistant") continue;
    const content = Array.isArray(info.content) ? info.content : [];
    const parts = isRecord(entry) && Array.isArray(entry.parts) ? entry.parts : [];
    const texts = [...content, ...parts]
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.synthetic !== true)
      .map((part) => part.text as string);
    const time = isRecord(info.time) ? info.time : {};
    records.push({
      ...(typeof info.id === "string" ? { id: info.id } : {}),
      ...(texts.length > 0 ? { text: texts.at(-1) } : {}),
      ...(assistantErrorMessage(info.error) ? { error: assistantErrorMessage(info.error) } : {}),
      ...(assistantErrorName(info.error) ? { errorName: assistantErrorName(info.error) } : {}),
      ...(finiteNumber(info.cost) !== undefined ? { cost: finiteNumber(info.cost) } : {}),
      ...(typeof info.providerID === "string" ? { providerID: info.providerID } : {}),
      ...(typeof info.modelID === "string" ? { modelID: info.modelID } : {}),
      ...(finiteNumber(time.created) !== undefined ? { created: finiteNumber(time.created) } : {}),
      ...(finiteNumber(time.completed) !== undefined ? { completed: finiteNumber(time.completed) } : {}),
      ...(parseAssistantTokens(info.tokens) ? { tokens: parseAssistantTokens(info.tokens) } : {}),
    });
  }
  return records;
}

/** Cumulative per-model usage over every assistant message in the session. */
function summarizeModelUsage(records: AssistantRecord[]): HarnessModelUsage[] | undefined {
  const byModel = new Map<string, HarnessModelUsage>();
  for (const record of records) {
    if (!record.tokens && record.cost === undefined) continue;
    const model = record.providerID && record.modelID
      ? `${record.providerID}/${record.modelID}`
      : record.modelID ?? "unknown";
    const entry = byModel.get(model) ?? {
      model,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    entry.costUsd += record.cost ?? 0;
    entry.inputTokens += record.tokens?.input ?? 0;
    entry.outputTokens += record.tokens?.output ?? 0;
    entry.reasoningTokens = (entry.reasoningTokens ?? 0) + (record.tokens?.reasoning ?? 0);
    entry.cacheReadTokens = (entry.cacheReadTokens ?? 0) + (record.tokens?.cacheRead ?? 0);
    entry.cacheWriteTokens = (entry.cacheWriteTokens ?? 0) + (record.tokens?.cacheWrite ?? 0);
    byModel.set(model, entry);
  }
  return byModel.size > 0 ? [...byModel.values()] : undefined;
}

/** Context size of the latest request: its total tokens (prompt + cache + output). */
function latestContextTokens(records: AssistantRecord[]): number | undefined {
  const tokens = [...records].reverse().find((record) => record.tokens)?.tokens;
  if (!tokens) return undefined;
  return tokens.total ?? tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/** Turn duration from the turn's assistant records (first created → last completed). */
function recordDurationMs(records: AssistantRecord[]): number | undefined {
  const created = records.map((record) => record.created).filter((value): value is number => value !== undefined);
  const completed = records.map((record) => record.completed ?? record.created).filter((value): value is number => value !== undefined);
  if (created.length === 0 || completed.length === 0) return undefined;
  const duration = Math.max(...completed) - Math.min(...created);
  return duration >= 0 ? duration : undefined;
}

/** Id and role of one `GET /session/{id}/message` entry. */
function messageIdentity(entry: unknown): { id?: string; role?: string } {
  const info = isRecord(entry) && isRecord(entry.info) ? entry.info : entry;
  if (!isRecord(info)) return {};
  return {
    ...(typeof info.id === "string" ? { id: info.id } : {}),
    ...(typeof info.role === "string" ? { role: info.role } : {}),
  };
}

/** What `GET /config/providers` says about one model (N19). */
export type OpenCodeModelInfo = { variants?: string[]; contextWindow?: number };

export function findOpenCodeModelInfo(providers: unknown, model: string | undefined): OpenCodeModelInfo | undefined {
  const parsed = parseModel(model);
  if (!parsed || !isRecord(providers) || !Array.isArray(providers.providers)) return undefined;
  const provider = providers.providers.find((entry) => isRecord(entry) && entry.id === parsed.providerID);
  const models = isRecord(provider) && isRecord(provider.models) ? provider.models : undefined;
  const info = models && isRecord(models[parsed.modelID]) ? models[parsed.modelID] as Record<string, unknown> : undefined;
  if (!info) return undefined;
  const limit = isRecord(info.limit) ? info.limit : undefined;
  return {
    ...(isRecord(info.variants) ? { variants: Object.keys(info.variants) } : {}),
    ...(finiteNumber(limit?.context) ? { contextWindow: finiteNumber(limit?.context) } : {}),
  };
}

const MESSAGE_PAGE_SIZE = 50;

type TurnWaiter = {
  sawActivity: boolean;
  settled: boolean;
  resolve(): void;
  reject(error: Error): void;
};

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
    // Plan/build agent switching carries plan decisions; OpenCode injects its
    // own build-switch reminder when a plan-agent session moves to `build`.
    nativePlanDecisions: true,
  } as const;

  private readonly servers: OpenCodeServerManager;

  constructor(private readonly deps: OpenCodeHarnessDeps = {}) {
    this.servers = new OpenCodeServerManager(deps);
  }

  launch(options: HarnessLaunchOptions): HarnessSession {
    const queue = new HarnessMessageQueue();
    const deps = this.deps;
    const servers = this.servers;
    let lease: OpenCodeServerLease | undefined;
    let leasePromise: Promise<OpenCodeServerLease> | undefined;
    let unsubscribe: (() => void) | undefined;
    let sessionId = options.resumeSessionId;
    let runCounter = 0;
    let currentPermissionMode = options.permissionMode ?? "default";
    let currentPendingInput: OpenCodePendingInput | undefined;
    // N20: one visible request at a time; concurrent ones (for example from
    // parallel subagents) wait here in arrival order.
    const queuedPendingInputs: OpenCodePendingInput[] = [];
    // N24: subagent sessions started by this session's turns.
    const childSessionIds = new Set<string>();
    let sessionValidated = !options.resumeSessionId;
    let sessionForked = false;
    let closed = false;
    let lastBackendRefConversationId: string | undefined;
    let activeTurn: {
      waiter?: TurnWaiter;
      abort: AbortController;
      interrupted: boolean;
      inactivityTimer?: NodeJS.Timeout;
    } | undefined;
    const emittedToolCalls = new Set<string>();
    const prompts = new PromptReader(typeof options.prompt === "string"
      ? (async function* (): AsyncGenerator<unknown> {
          yield { type: "user", text: options.prompt };
        })()
      : options.prompt);
    const resolvedPendingInputRequestIds = new Set<string>();

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
      const queuedIndex = requestId ? queuedPendingInputs.findIndex((entry) => entry.requestId === requestId) : -1;
      if (queuedIndex >= 0) {
        // Answered or withdrawn before it was shown.
        queuedPendingInputs.splice(queuedIndex, 1);
        return;
      }
      queue.enqueue(createPendingInputResolvedEvent(requestId));
      if (requestId && currentPendingInput?.requestId === requestId) {
        currentPendingInput = undefined;
        showNextPendingInput();
      }
      if (activeTurn) armTurnInactivityTimer(activeTurn);
    };

    const showNextPendingInput = (): void => {
      if (currentPendingInput) return;
      const next = queuedPendingInputs.shift();
      if (!next?.state) return;
      currentPendingInput = next;
      queue.enqueue(createPendingInputEvent(next.state));
    };

    /** Show a new request now, or queue it behind the visible one (N20). */
    const presentPendingInput = (pending: OpenCodePendingInput): void => {
      if (currentPendingInput) {
        log.debug(`[OpenCodeHarness] ${pending.kind} ${pending.requestId} queued behind ${currentPendingInput.requestId}`);
        queuedPendingInputs.push(pending);
        return;
      }
      currentPendingInput = pending;
      queue.enqueue(createPendingInputEvent(pending.state!));
      refreshRunningUsage();
    };

    /** A turn's requests end with it (visible and queued). */
    const releaseAllPendingInput = (): void => {
      for (const queued of queuedPendingInputs.splice(0)) resolvedPendingInputRequestIds.add(queued.requestId);
      if (currentPendingInput) resolvePendingInput(currentPendingInput.requestId);
    };

    const ensureLease = async (): Promise<OpenCodeServerLease> => {
      if (lease?.alive) return lease;
      if (lease && !lease.alive) {
        // The shared server died since the last turn: detach and start anew.
        unsubscribe?.();
        unsubscribe = undefined;
        await lease.release();
        lease = undefined;
      }
      leasePromise ??= (async () => {
        const acquired = await servers.acquire(options.cwd, options.abortController?.signal);
        if (closed || options.abortController?.signal.aborted) {
          await acquired.release();
          throw new Error("OpenCode startup was interrupted before session creation.");
        }
        lease = acquired;
        return acquired;
      })();
      try {
        return await leasePromise;
      } finally {
        leasePromise = undefined;
      }
    };

    const client = (): OpenCodeClient => {
      if (!lease) throw new Error("OpenCode server is not connected.");
      return lease.client;
    };

    const applyPermissionRules = async (id: string, mode: string): Promise<void> => {
      if (!lease?.alive) return;
      await client().request("PATCH", `/session/${encodeURIComponent(id)}`, {
        permission: permissionRulesForMode(mode),
      }).catch((error: unknown) => {
        log.debug(`[OpenCodeHarness] permission overlay for ${id} failed: ${errorMessage(error)}`);
      });
    };

    const replyPermission = async (requestId: string, response: string, message?: string): Promise<void> => {
      if (!lease || !sessionId) return;
      await client().request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, {
        reply: response,
        ...(message ? { message } : {}),
      });
    };

    /** One answer array per question, in question order (multi-select ready). */
    const replyQuestion = async (requestId: string, answers: string[][]): Promise<void> => {
      if (!lease || !sessionId) return;
      await client().request("POST", `/question/${encodeURIComponent(requestId)}/reply`, { answers });
    };

    const settleWaiter = (fn: (waiter: TurnWaiter) => void): void => {
      const waiter = activeTurn?.waiter;
      if (!waiter || waiter.settled) return;
      waiter.settled = true;
      fn(waiter);
    };

    /**
     * Ask the shared server to stop this session's in-flight turn. Closing or
     * aborting the OCA session must stop the work (and the spending) on the
     * server too, not only locally.
     */
    const abortServerTurn = async (): Promise<void> => {
      const id = sessionId;
      if (!id || !lease?.alive) return;
      await client().request("POST", `/session/${encodeURIComponent(id)}/abort`).catch((): undefined => undefined);
    };

    /**
     * The turn limit counts inactivity, not wall time: it restarts on every
     * event of the turn, and it is paused while the turn waits for the user (a
     * question or approval). When it fires the server turn is aborted too.
     */
    const armTurnInactivityTimer = (turn: NonNullable<typeof activeTurn>): void => {
      if (turn.inactivityTimer) clearTimeout(turn.inactivityTimer);
      turn.inactivityTimer = undefined;
      if (activeTurn !== turn || turn.waiter?.settled || currentPendingInput) return;
      const turnTimeoutMs = deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;
      turn.inactivityTimer = setTimeout(() => {
        if (activeTurn !== turn || currentPendingInput) return;
        void abortServerTurn();
        settleWaiter((pending) => pending.reject(new Error(`OpenCode session ${sessionId ?? ""} showed no activity for ${Math.round(turnTimeoutMs / 1000)} s; the turn was aborted.`)));
      }, turnTimeoutMs);
      turn.inactivityTimer.unref?.();
    };

    let lastTextPartKey: string | undefined;

    const handleEvent = (event: NormalizedEvent): void => {
      if (closed) return;
      const waiter = activeTurn?.waiter;
      try {
        handleSessionEvent(event, waiter);
      } finally {
        // Every event of this session counts as turn activity (and a pending
        // question or approval pauses the limit until it is resolved).
        if (activeTurn) armTurnInactivityTimer(activeTurn);
      }
    };

    /** Permission prompts and questions (of the session or one of its subagents). */
    const handleInteractiveEvent = (event: NormalizedEvent): boolean => {
      if (event.type === "permission.asked") {
        if (currentPermissionMode === "bypassPermissions") {
          const requestId = typeof event.properties.id === "string" ? event.properties.id : undefined;
          if (requestId) {
            void replyPermission(requestId, "once")
              .catch((): undefined => undefined)
              .finally(() => resolvePendingInput(requestId));
          }
          return true;
        }
        const state = buildPermissionPendingInput(event.properties, event.childSessionId);
        presentPendingInput({
          requestId: state.requestId,
          kind: "approval",
          options: state.options,
          actions: state.actions ?? [],
          state,
        });
        return true;
      }
      if (event.type === "permission.replied") {
        const requestId = typeof event.properties.requestID === "string" ? event.properties.requestID : undefined;
        resolvePendingInput(requestId);
        return true;
      }
      if (event.type === "question.asked") {
        const state = buildQuestionPendingInput(event.properties);
        presentPendingInput({
          requestId: state.requestId,
          kind: "question",
          options: state.options,
          actions: [],
          state,
        });
        return true;
      }
      if (event.type === "question.replied" || event.type === "question.rejected") {
        const requestId = typeof event.properties.requestID === "string" ? event.properties.requestID : undefined;
        resolvePendingInput(requestId);
        return true;
      }
      return false;
    };

    const handleSessionEvent = (event: NormalizedEvent, waiter: TurnWaiter | undefined): void => {
      if (event.childSessionId) {
        // N24: a subagent's prompts go to the user like the session's own; the
        // rest of its stream only shows that the turn is still working (its
        // idle never ends the parent's turn, and its text is not the agent's).
        if (handleInteractiveEvent(event)) return;
        if (waiter) waiter.sawActivity = true;
        queue.enqueue({ type: "activity" });
        return;
      }
      if (handleInteractiveEvent(event)) return;
      if (
        (event.type === "session.next.text.delta" || event.type === "message.part.delta")
        && event.properties.field !== "reasoning"
        && typeof event.properties.delta === "string"
      ) {
        if (waiter) waiter.sawActivity = true;
        // Separate consecutive text parts/messages so agent_output does not run them together.
        const partKey = [event.properties.messageID, event.properties.partID ?? event.properties.id]
          .filter((value) => typeof value === "string")
          .join(":") || undefined;
        if (lastTextPartKey !== undefined && partKey !== lastTextPartKey) {
          queue.enqueue(createTextDeltaEvent("\n\n"));
        }
        lastTextPartKey = partKey ?? lastTextPartKey ?? "";
        queue.enqueue(createTextDeltaEvent(event.properties.delta));
        return;
      }
      if (event.type === "session.next.tool.called" || event.type === "message.part.updated") {
        if (waiter) waiter.sawActivity = true;
        const part = isRecord(event.properties.part) ? event.properties.part : undefined;
        if (event.type === "message.part.updated" && part?.type !== "tool") {
          queue.enqueue({ type: "activity" });
          // A finished step is when OpenCode adds its cost to the session.
          if (part?.type === "step-finish") {
            const tokens = parseAssistantTokens(part.tokens);
            if (tokens) latestStepContextTokens = tokens.total ?? tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
            refreshRunningUsage();
          }
          return;
        }
        // Tool parts are re-sent on every state change; report each call once,
        // when its input is known (not while it is still `pending`).
        const state = isRecord(part?.state) ? part.state : undefined;
        const callId = typeof part?.callID === "string"
          ? part.callID
          : typeof event.properties.callID === "string" ? event.properties.callID : undefined;
        if ((callId && emittedToolCalls.has(callId)) || state?.status === "pending") {
          queue.enqueue({ type: "activity" });
          return;
        }
        if (callId) emittedToolCalls.add(callId);
        const tool = typeof event.properties.tool === "string"
          ? event.properties.tool
          : typeof part?.tool === "string"
            ? part.tool
            : "tool";
        queue.enqueue(createToolCallEvent(tool, event.properties.input ?? state?.input));
        return;
      }
      if (event.type === "session.next.step.failed" || event.type === "session.error") {
        const reason = assistantErrorMessage(event.properties.error) ?? `${event.type} failed`;
        settleWaiter((pending) => pending.reject(new OpenCodeTurnError(reason, assistantErrorName(event.properties.error))));
        return;
      }
      if (eventIndicatesSessionIdle(event)) {
        queue.enqueue({ type: "activity" });
        if (!waiter || waiter.settled) return;
        if (waiter.sawActivity) {
          settleWaiter((pending) => pending.resolve());
          return;
        }
        // An idle with no activity for this turn may be stale; confirm it.
        void confirmIdleTurn();
        return;
      }
      if (
        event.type?.startsWith("session.next.")
        || event.type?.startsWith("message.")
        || event.type === "session.status"
      ) {
        if (waiter && (event.type !== "session.status" || eventStatusType(event) === "busy")) {
          waiter.sawActivity = true;
        }
        queue.enqueue({ type: "activity" });
      }
    };

    /**
     * N25: the newest message before this turn's prompt. A turn's own messages
     * are those after it, so finishing a turn reads only its own messages
     * instead of the whole history (which made every step O(history)).
     */
    let turnBaselineMessageId: string | undefined;
    /** Every assistant message of the session seen so far (cumulative per-model usage). */
    const knownAssistantRecords = new Map<string, AssistantRecord>();
    /** A resumed or forked session's earlier history is read once, on its first turn. */
    let historyLoaded = !options.resumeSessionId;
    /** Context size reported by the latest finished step of this turn. */
    let latestStepContextTokens: number | undefined;
    let modelContextWindow: number | undefined;

    const fetchMessagePage = async (id: string, limit: number, before?: string, signal?: AbortSignal): Promise<MessagePage> => {
      let nextCursor: string | undefined;
      const query = `limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      const body = await client().request<unknown>("GET", `/session/${encodeURIComponent(id)}/message?${query}`, undefined, {
        signal,
        onHeaders: (headers) => { nextCursor = headers.get("x-next-cursor") ?? undefined; },
      });
      return { entries: Array.isArray(body) ? body : [], ...(nextCursor ? { nextCursor } : {}) };
    };

    /**
     * Messages newer than `sinceId` (all of them without one), oldest first,
     * read newest-first one page at a time.
     */
    const fetchMessagesSince = async (id: string, sinceId: string | undefined): Promise<unknown[]> => {
      const collected: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 1_000; page += 1) {
        const { entries, nextCursor } = await fetchMessagePage(id, MESSAGE_PAGE_SIZE, cursor);
        const stop = sinceId ? entries.findIndex((entry) => messageIdentity(entry).id === sinceId) : -1;
        collected.unshift(...(stop >= 0 ? entries.slice(stop + 1) : entries));
        if (stop >= 0 || !nextCursor || entries.length === 0) break;
        cursor = nextCursor;
      }
      return collected;
    };

    const newestMessage = async (id: string, signal?: AbortSignal): Promise<{ id?: string; role?: string } | undefined> => {
      const { entries } = await fetchMessagePage(id, 1, undefined, signal);
      return entries.length > 0 ? messageIdentity(entries.at(-1)) : undefined;
    };

    /** The id of the user message that starts the `count`-th last turn (N23 rewind). */
    const findRewindMessageId = async (id: string, count: number): Promise<string> => {
      let cursor: string | undefined;
      let seen = 0;
      for (let page = 0; page < 1_000; page += 1) {
        const { entries, nextCursor } = await fetchMessagePage(id, MESSAGE_PAGE_SIZE, cursor);
        for (const entry of [...entries].reverse()) {
          const message = messageIdentity(entry);
          if (message.role !== "user" || !message.id) continue;
          seen += 1;
          if (seen === count) return message.id;
        }
        if (!nextCursor || entries.length === 0) break;
        cursor = nextCursor;
      }
      throw new Error(`Cannot rewind ${count} turn(s): the OpenCode session only has ${seen} turn(s).`);
    };

    const rememberRecords = (records: AssistantRecord[]): void => {
      for (const record of records) {
        if (record.id) knownAssistantRecords.set(record.id, record);
      }
    };

    /** N19: model facts (effort variants, context window) from the server's provider catalog. */
    let reportedModelInfo = false;
    let resolvedVariant: string | undefined = options.reasoningEffort;
    const resolveModelInfo = async (): Promise<void> => {
      if (reportedModelInfo || !options.model) return;
      reportedModelInfo = true;
      let info: OpenCodeModelInfo | undefined;
      try {
        info = findOpenCodeModelInfo(await client().request<unknown>("GET", "/config/providers", undefined, {
          timeoutMs: Math.min(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, 10_000),
        }), options.model);
      } catch (error) {
        log.debug(`[OpenCodeHarness] provider catalog unavailable: ${errorMessage(error)}`);
      }
      const effort = options.reasoningEffort;
      const supported = effort && info?.variants ? info.variants.includes(effort) : undefined;
      if (supported === false) {
        // OpenCode ignores a variant the model lacks; say so instead of claiming it.
        log.warn(`[OpenCodeHarness] model ${options.model} has no "${effort}" variant (available: ${info?.variants?.join(", ") || "none"}); running without one.`);
        resolvedVariant = undefined;
      }
      modelContextWindow = info?.contextWindow;
      queue.enqueue({
        type: "backend_info",
        info: {
          model: options.model,
          ...(effort ? { reasoningEffort: supported === false ? null : effort } : {}),
          ...(supported !== undefined ? { reasoningEffortSupported: supported } : {}),
        },
      });
      if (modelContextWindow) queue.enqueue({ type: "usage_updated", usage: { contextWindow: modelContextWindow } });
    };

    /** Resolve the turn when the session is idle and produced a new assistant message. */
    const confirmIdleTurn = async (): Promise<void> => {
      const waiter = activeTurn?.waiter;
      const id = sessionId;
      if (!waiter || waiter.settled || !id || !lease?.alive) return;
      try {
        const statuses = await client().request<unknown>("GET", "/session/status", undefined, {
          timeoutMs: Math.min(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, 10_000),
        });
        if (!isIdleSessionStatus(statuses, id)) return;
        const newest = await newestMessage(id);
        if (newest?.role === "assistant" && newest.id !== turnBaselineMessageId) {
          settleWaiter((pending) => pending.resolve());
        }
      } catch {
        // Status is best-effort; SSE or the next poll decides.
      }
    };

    const listener: SessionEventListener = {
      onEvent: handleEvent,
      onChildSession: (childId) => {
        childSessionIds.add(childId);
        // N24: a subagent session starts with its agent's own rules; give it
        // this session's permission overlay so "ask" (default) and "deny"
        // (plan) also hold inside subagents.
        void applyPermissionRules(childId, currentPermissionMode);
      },
      onStreamGap: () => {
        const turn = activeTurn;
        if (!turn?.waiter || turn.waiter.settled) return;
        void pollUntilSettled(turn.waiter, turn.abort.signal);
      },
      onServerExit: (reason) => {
        settleWaiter((pending) => pending.reject(new Error(`${reason} The in-flight OpenCode turn failed; the session can continue in a new turn.`)));
      },
    };

    /** Polling fallback, used only while the shared event stream is disconnected. */
    const pollUntilSettled = async (waiter: TurnWaiter, signal: AbortSignal): Promise<void> => {
      const interval = deps.fallbackPollIntervalMs ?? FALLBACK_POLL_INTERVAL_MS;
      while (!waiter.settled && !signal.aborted && !closed) {
        await confirmIdleTurn();
        if (waiter.settled || lease?.streamConnected) return;
        await delay(interval);
      }
    };

    const ensureSession = async (): Promise<string> => {
      const serverLease = await ensureLease();
      if (!unsubscribe && sessionId) {
        unsubscribe = serverLease.subscribe(sessionId, listener);
      }
      if (sessionId) {
        if (options.rewindTurns && options.rewindTurns > 0 && !options.forkSession) {
          throw new Error("OpenCode can only rewind into a fork (fork_session=true): its in-place revert would also undo file changes.");
        }
        if (options.forkSession && !sessionForked) {
          // N23: a rewind forks before the user message that started the
          // N-th last turn (the fork copies only the messages before it).
          const rewind = options.rewindTurns && options.rewindTurns > 0 ? Math.floor(options.rewindTurns) : 0;
          const messageID = rewind > 0 ? await findRewindMessageId(sessionId, rewind) : undefined;
          const forked = await client().request<OpenCodeSession>("POST", `/session/${encodeURIComponent(sessionId)}/fork`, messageID ? { messageID } : {});
          if (!forked?.id) throw new Error("OpenCode fork did not return a session id.");
          unsubscribe?.();
          sessionId = forked.id;
          unsubscribe = serverLease.subscribe(sessionId, listener);
          sessionForked = true;
          sessionValidated = true;
        } else if (!sessionValidated) {
          await fetchMessagePage(sessionId, 1);
          sessionValidated = true;
        }
        emitBackendRef();
        return sessionId;
      }

      const model = toOpenCodeModel(options.model);
      const created = await client().request<OpenCodeSession>("POST", "/session", {
        ...(model ? { model } : {}),
        metadata: { client: "openclaw-code-agent" },
        permission: permissionRulesForMode(currentPermissionMode),
      });
      if (!created?.id) throw new Error("OpenCode did not return a session id.");
      sessionId = created.id;
      unsubscribe = serverLease.subscribe(sessionId, listener);
      sessionValidated = true;
      emitBackendRef();
      return sessionId;
    };

    const readSessionCost = async (id: string): Promise<number | undefined> => {
      const session = await client().request<OpenCodeSession>("GET", `/session/${encodeURIComponent(id)}`, undefined, {
        timeoutMs: Math.min(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, SESSION_COST_TIMEOUT_MS),
      }).catch((): undefined => undefined);
      return sessionCostUsd(session);
    };

    /**
     * Cumulative session usage after a turn: the turn's own messages (plus, on
     * a resumed session's first turn, its earlier history once) and the
     * session cost as OpenCode reports it.
     */
    const readTurnUsage = async (id: string): Promise<{
      turnRecords: AssistantRecord[];
      usage: HarnessUsage;
      costUsd?: number;
    }> => {
      const [turnEntries, sessionCost] = await Promise.all([
        fetchMessagesSince(id, historyLoaded ? turnBaselineMessageId : undefined).catch((): unknown[] => []),
        readSessionCost(id),
      ]);
      const allNew = extractAssistantRecords(turnEntries);
      let turnRecords = allNew;
      if (!historyLoaded) {
        historyLoaded = true;
        const baselineIndex = turnBaselineMessageId
          ? turnEntries.findIndex((entry) => messageIdentity(entry).id === turnBaselineMessageId)
          : -1;
        turnRecords = baselineIndex >= 0 ? extractAssistantRecords(turnEntries.slice(baselineIndex + 1)) : allNew;
      }
      rememberRecords(allNew);
      const records = [...knownAssistantRecords.values()];
      const models = summarizeModelUsage(records);
      const contextTokens = latestContextTokens(turnRecords) ?? latestContextTokens(records);
      return {
        turnRecords,
        usage: {
          ...(models ? { models } : {}),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(modelContextWindow ? { contextWindow: modelContextWindow } : {}),
        },
        costUsd: sessionCost ?? (models ? models.reduce((sum, entry) => sum + entry.costUsd, 0) : undefined),
      };
    };

    let usageRefresh: Promise<void> | undefined;
    let usageRefreshQueued = false;
    /**
     * Report the running session cost mid-turn. OpenCode prices a step only
     * when it finishes, so this runs after each finished step and when the turn
     * starts waiting on the user; a step that is itself blocked on a question
     * or permission is priced once it resumes and finishes.
     */
    const refreshRunningUsage = (): void => {
      if (usageRefresh) {
        usageRefreshQueued = true;
        return;
      }
      const turn = activeTurn;
      const id = sessionId;
      if (!turn || !id || !lease?.alive || closed) return;
      usageRefresh = (async () => {
        try {
          // N25: one small request (the session's own cost), not the history.
          const costUsd = await readSessionCost(id);
          // Once the turn settles, run_completed carries the authoritative total.
          if (closed || activeTurn !== turn || turn.waiter?.settled || costUsd === undefined) return;
          queue.enqueue({
            type: "usage_updated",
            usage: {
              costUsd,
              ...(latestStepContextTokens !== undefined ? { contextTokens: latestStepContextTokens } : {}),
            },
          });
        } catch {
          // Usage is advisory; the turn result reports the final total.
        } finally {
          usageRefresh = undefined;
          if (usageRefreshQueued) {
            usageRefreshQueued = false;
            refreshRunningUsage();
          }
        }
      })();
    };

    const completeTurn = async (args: {
      outcome: "completed" | "failed" | "interrupted";
      result?: string;
      errorCode?: string;
      startedAt: number;
    }): Promise<void> => {
      let outcome = args.outcome;
      let finalResult = args.result;
      let errorCode = args.errorCode;
      let totalCostUsd = 0;
      let durationMs: number | undefined;
      let usage: HarnessUsage | undefined;
      if (lease?.alive && sessionId) {
        const snapshot = await readTurnUsage(sessionId);
        const turnRecords = snapshot.turnRecords;
        usage = snapshot.usage;
        totalCostUsd = snapshot.costUsd ?? 0;
        durationMs = recordDurationMs(turnRecords);
        const lastRecord = turnRecords.at(-1);
        if (outcome === "completed") {
          if (lastRecord?.error) {
            outcome = "failed";
            finalResult = lastRecord.error;
            errorCode = lastRecord.errorName;
          } else {
            finalResult = finalResult ?? [...turnRecords].reverse().find((record) => record.text)?.text;
          }
        } else if (outcome === "failed" && !errorCode) {
          errorCode = lastRecord?.errorName;
        }
      }
      if (!closed && await prompts.hasQueued()) {
        // A follow-up was queued during this turn: report the result through the
        // next turn so the session does not end with the follow-up dropped.
        if (outcome === "failed" && finalResult) {
          queue.enqueue(createTextDeltaEvent(`\n\n[OpenCode] Turn failed: ${finalResult}`));
        }
        return;
      }
      queue.enqueue(createRunCompletedEvent({
        success: outcome === "completed",
        outcome,
        // N16: OpenCode reports structured errors (assistant `error.name`), so
        // the outcome is authoritative and the error class travels as a code.
        outcomeAuthoritative: true,
        ...(outcome === "failed" && errorCode ? { errorCode } : {}),
        duration_ms: durationMs ?? Math.max(0, Date.now() - args.startedAt),
        total_cost_usd: totalCostUsd,
        num_turns: runCounter,
        result: outcome === "interrupted" ? undefined : finalResult,
        session_id: sessionId ?? "",
        ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
      }));
    };

    const runTurn = async (text: string): Promise<void> => {
      const startedAt = Date.now();
      const turn: NonNullable<typeof activeTurn> = { abort: new AbortController(), interrupted: false };
      activeTurn = turn;
      emittedToolCalls.clear();
      try {
        const id = await ensureSession();
        if (turn.interrupted || closed) {
          await completeTurn({ outcome: "interrupted", startedAt });
          return;
        }
        queue.enqueue(createRunStartedEvent());
        runCounter += 1;
        await resolveModelInfo();
        turnBaselineMessageId = (await newestMessage(id).catch((): undefined => undefined))?.id;
        latestStepContextTokens = undefined;

        const done = new Promise<void>((resolve, reject) => {
          turn.waiter = { sawActivity: false, settled: false, resolve, reject };
        });
        armTurnInactivityTimer(turn);
        const onAbort = (): void => settleWaiter((pending) => pending.reject(new Error("interrupted")));
        turn.abort.signal.addEventListener("abort", onAbort, { once: true });

        // OpenCode applies only the latest user message's `system`, so the
        // system prompt (worktree rules, launch instructions) goes with every turn.
        await client().request("POST", `/session/${encodeURIComponent(id)}/prompt_async`, classicPromptBody({
          text,
          model: options.model,
          systemPrompt: options.systemPrompt,
          agent: openCodeAgentForMode(currentPermissionMode),
          variant: resolvedVariant,
        }), { signal: turn.abort.signal });
        if (!lease?.streamConnected && turn.waiter) {
          void pollUntilSettled(turn.waiter, turn.abort.signal);
        }
        await done;
        await completeTurn({ outcome: "completed", startedAt });
      } catch (error) {
        if (turn.interrupted) {
          await completeTurn({ outcome: "interrupted", startedAt });
        } else {
          await completeTurn({
            outcome: "failed",
            result: errorMessage(error),
            ...(error instanceof OpenCodeTurnError && error.code ? { errorCode: error.code } : {}),
            startedAt,
          });
        }
      } finally {
        if (turn.inactivityTimer) clearTimeout(turn.inactivityTimer);
        if (activeTurn === turn) activeTurn = undefined;
        // A question or approval belongs to the turn that raised it. Once the
        // turn is over (completed, failed, aborted) it can no longer be
        // answered, and the next prompt must start a new turn, not answer it.
        releaseAllPendingInput();
      }
    };

    const answerPendingQuestion = async (
      answer: string,
      context: { requestId?: string; questionId?: string; optionValue?: string } = {},
    ): Promise<boolean> => {
      const pending = currentPendingInput;
      if (!pending || pending.kind !== "question") return false;
      if (context.requestId && context.requestId !== pending.requestId) return false;
      const trimmed = answer.trim();
      if (!trimmed) return false;

      const questions = pending.state?.questions ?? [];
      if (questions.length === 0) {
        await replyQuestion(pending.requestId, [[trimmed]]);
        resolvePendingInput(pending.requestId);
        return true;
      }
      const activeQuestionIndex = pending.state?.activeQuestionIndex ?? 0;
      const question = questions[activeQuestionIndex];
      if (!question) return false;
      if (context.questionId && context.questionId !== question.id) return false;
      let selected: string[];
      if (context.optionValue !== undefined) {
        selected = [context.optionValue];
      } else {
        // OpenCode expects the selected option labels; numbers select options too.
        const resolved = resolvePendingInputAnswer(question, trimmed);
        if (!resolved.ok) return false;
        selected = resolved.answers;
      }
      pending.answers = {
        ...pending.answers,
        [question.id]: { answers: selected },
      };
      const nextIndex = activeQuestionIndex + 1;
      if (nextIndex < questions.length) {
        pending.state = updateOpenCodeWizardState(pending.state!, nextIndex, pending.answers);
        pending.options = pending.state.options;
        queue.enqueue(createPendingInputEvent(pending.state));
        return true;
      }
      await replyQuestion(
        pending.requestId,
        questions.map((entry) => pending.answers?.[entry.id]?.answers ?? []),
      );
      resolvePendingInput(pending.requestId);
      return true;
    };

    const shutdown = async (): Promise<void> => {
      closed = true;
      settleWaiter((pending) => pending.reject(new Error("closed")));
      unsubscribe?.();
      unsubscribe = undefined;
      const heldLease = lease;
      lease = undefined;
      // Shutdown runs from fire-and-forget paths (abort, close); never reject.
      await heldLease?.release().catch((error: unknown) => {
        log.debug(`[OpenCodeHarness] lease release failed during shutdown: ${errorMessage(error)}`);
      });
    };

    // Owns every failure (reported as a failed run) and always shuts down, so
    // this detached promise never rejects.
    void (async () => {
      try {
        while (true) {
          const next = await prompts.next();
          if (next.done) break;
          const rawMessage = next.value;
          if (closed) break;
          const text = extractPromptText(rawMessage).trim();
          if (!text) {
            queue.enqueue(createPromptSettledEvent());
            continue;
          }
          await runTurn(text);
        }
      } catch (error) {
        if (!closed) {
          await completeTurn({ outcome: "failed", result: errorMessage(error), startedAt: Date.now() });
        }
      } finally {
        await shutdown();
        queue.close();
      }
    })();

    const abortSignal = options.abortController?.signal;
    abortSignal?.addEventListener("abort", () => {
      const turn = activeTurn;
      if (turn) {
        turn.interrupted = true;
        turn.abort.abort();
      }
      void (turn ? abortServerTurn() : Promise.resolve()).finally(() => shutdown());
    }, { once: true });

    return {
      messages: queue.messages(),

      async setPermissionMode(mode: string): Promise<void> {
        if (sessionId && lease?.alive) {
          await client().request("PATCH", `/session/${encodeURIComponent(sessionId)}`, {
            permission: permissionRulesForMode(mode),
          });
          for (const childId of childSessionIds) await applyPermissionRules(childId, mode);
        }
        // The next prompt also switches agent (plan → build), which makes
        // OpenCode inject its own build-switch reminder.
        currentPermissionMode = mode;
        queue.enqueue(createSettingsChangedEvent(mode));
      },

      async submitPendingInputOption(
        index: number,
        context: { requestId?: string; questionId?: string } = {},
      ): Promise<boolean> {
        const pending = currentPendingInput;
        if (!pending) return false;
        if (context.requestId && context.requestId !== pending.requestId) return false;
        if (pending.kind === "approval") {
          const action = pending.actions[index];
          const response = action?.kind === "approval" ? action.responseDecision : undefined;
          if (!response) return false;
          await replyPermission(pending.requestId, response);
          resolvePendingInput(pending.requestId);
          return true;
        }
        const questions = pending.state?.questions ?? [];
        const activeQuestionIndex = pending.state?.activeQuestionIndex ?? 0;
        const structuredQuestion = questions[activeQuestionIndex];
        if (context.questionId && context.questionId !== structuredQuestion?.id) return false;
        const structuredOption = structuredQuestion?.options[index];
        const label = structuredOption?.label ?? pending.options[index];
        if (!label) return false;
        return await answerPendingQuestion(label, {
          ...context,
          optionValue: structuredOption?.value ?? label,
        });
      },

      async submitPendingInputText(text: string): Promise<boolean> {
        const pending = currentPendingInput;
        if (pending?.kind === "approval") {
          const answer = text.trim();
          if (!answer) return false;
          const choices = pending.actions.flatMap((action) => (
            action.kind === "approval"
              ? [{ label: action.label, decision: action.decision, response: action.responseDecision }]
              : []
          ));
          const choice = matchApprovalChoiceText(choices, answer);
          // Not a decision: reject and hand the text to the agent as feedback.
          await replyPermission(pending.requestId, choice?.response ?? "reject", choice ? undefined : answer);
          resolvePendingInput(pending.requestId);
          return true;
        }
        return await answerPendingQuestion(text);
      },

      /** Abort the in-flight turn; the session keeps accepting prompts. */
      async interrupt(): Promise<void> {
        const turn = activeTurn;
        if (!turn) return;
        turn.interrupted = true;
        turn.abort.abort();
        await abortServerTurn();
      },

      async close(): Promise<void> {
        const turn = activeTurn;
        if (turn) {
          turn.interrupted = true;
          turn.abort.abort();
          // Stop the server-side turn before the lease is released.
          await abortServerTurn();
        }
        await shutdown();
        // Consumers stop even if the caller's prompt stream stays open.
        queue.close();
      },
    };
  }

  buildUserMessage(text: string, _sessionId: string): unknown {
    return { type: "user", text };
  }
}
