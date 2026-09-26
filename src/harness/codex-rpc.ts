import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { buildHarnessChildEnv } from "../child-env";
import readline from "node:readline";
import { createLogger } from "../logger";

const log = createLogger("codex-rpc");

export type JsonRpcId = string | number;
export type JsonRpcEnvelope = {
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
  method?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type JsonRpcNotificationHandler = (method: string, params: unknown) => Promise<void> | void;
export type JsonRpcRequestHandler = (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>;

/** Standard JSON-RPC error codes used for server-initiated requests OCA cannot serve. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

/**
 * Throw from a request handler to answer a server request with a specific
 * JSON-RPC error code instead of the generic internal-error response.
 */
export class JsonRpcResponseError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "JsonRpcResponseError";
  }
}

/**
 * N28: a JSON-RPC error response from the app server, with its `code` and
 * `data` kept for callers instead of being flattened into the message.
 */
export class JsonRpcRemoteError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, readonly remoteMessage: string, readonly data?: unknown) {
    super(`codex app server rpc error (${code ?? "unknown"}) on ${method}: ${remoteMessage}${describeErrorData(data)}`);
    this.name = "JsonRpcRemoteError";
  }
}

function describeErrorData(data: unknown): string {
  if (data === undefined || data === null) return "";
  const text = typeof data === "string" ? data : JSON.stringify(data);
  if (!text || text === "{}") return "";
  return ` (${text.length > 300 ? `${text.slice(0, 300)}…` : text})`;
}

export type JsonRpcClient = {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  notify: (method: string, params?: unknown) => Promise<void>;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  setNotificationHandler: (handler: JsonRpcNotificationHandler) => void;
  setRequestHandler: (handler: JsonRpcRequestHandler) => void;
  /** Called once when the transport closes unexpectedly or on shutdown. */
  setCloseHandler?: (handler: () => void) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Routine transport events log at debug; failures and anomalies at warn. */
const WARN_DIAGNOSTIC_EVENTS = new Set(["process.error", "request.timeout", "process.force_kill", "pending.flush", "stdin.error", "line.failed"]);

function logCodexRpcDiagnostic(event: string, fields: Record<string, unknown>): void {
  const emit = WARN_DIAGNOSTIC_EVENTS.has(event) ? log.warn : log.debug;
  emit(JSON.stringify({
    component: "CodexAppServerRpc",
    event,
    at: new Date().toISOString(),
    ...fields,
  }));
}

function processLaunchDiagnosticFields(command: string, args: readonly string[]): Record<string, unknown> {
  return {
    commandKind: command === "codex" ? "codex" : "custom",
    appServerSubcommand: true,
    configuredArgCount: args.length,
  };
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

export async function dispatchJsonRpcEnvelope(
  payload: JsonRpcEnvelope,
  params: {
    pending: Map<string, PendingRequest>;
    onNotification: JsonRpcNotificationHandler;
    onRequest: JsonRpcRequestHandler;
    respond: (frame: JsonRpcEnvelope) => void;
  },
): Promise<void> {
  if (payload.id != null && (Object.hasOwn(payload, "result") || Object.hasOwn(payload, "error"))) {
    const key = String(payload.id);
    const pending = params.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    params.pending.delete(key);
    if (payload.error) {
      pending.reject(new JsonRpcRemoteError(
        pending.method ?? "request",
        payload.error.code,
        payload.error.message ?? "unknown error",
        payload.error.data,
      ));
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
    const result = await params.onRequest(method, payload.params, payload.id);
    params.respond({ jsonrpc: "2.0", id: payload.id, result: result ?? {} });
  } catch (error) {
    params.respond({
      jsonrpc: "2.0",
      id: payload.id,
      error: {
        code: error instanceof JsonRpcResponseError ? error.code : JSON_RPC_INTERNAL_ERROR,
        message: errorMessage(error),
      },
    });
  }
}

export class StdioJsonRpcClient implements JsonRpcClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private stderrTail = "";
  private startError: Error | undefined;
  private counter = 0;
  private onNotification: JsonRpcNotificationHandler = () => undefined;
  private onClose: () => void = () => undefined;
  private onRequest: JsonRpcRequestHandler = async (method) => {
    throw new JsonRpcResponseError(JSON_RPC_METHOD_NOT_FOUND, `unsupported server request: ${method}`);
  };

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly requestTimeoutMs: number,
    private readonly shutdownGraceMs: number = 1_000,
  ) {}

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.onNotification = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.onRequest = handler;
  }

  setCloseHandler(handler: () => void): void {
    this.onClose = handler;
  }

  async connect(): Promise<void> {
    if (this.process) return;
    // Codex is a native local backend for this plugin, so the accepted transport
    // surface here is a stdio child process rather than an in-process SDK client.
    const child = spawn(this.command, ["app-server", ...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      // Gateway environment minus secrets unrelated to the agent (see child-env.ts).
      env: buildHarnessChildEnv(process.env),
      // N27: its own process group, so closing the session also stops the
      // commands Codex started. A dead Gateway closes the stdio pipe, and the
      // app server exits on that end of input.
      detached: process.platform !== "win32",
    });
    logCodexRpcDiagnostic("process.spawn", {
      ...processLaunchDiagnosticFields(this.command, this.args),
      pid: child.pid,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("codex app server stdio pipes unavailable");
    }
    this.process = child;
    const reader = readline.createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      // A failing handler (or a response write after the pipe closed) must never
      // become an unhandled rejection in the Gateway process.
      this.handleLine(line).catch((error: unknown) => {
        logCodexRpcDiagnostic("line.failed", { pid: child.pid, error: errorMessage(error) });
      });
    });
    // EPIPE and similar stdin errors surface as stream 'error' events; without a
    // listener Node would throw them as uncaught exceptions.
    child.stdin.on("error", (error) => {
      logCodexRpcDiagnostic("stdin.error", { pid: child.pid, error: errorMessage(error) });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.on("error", (error) => {
      logCodexRpcDiagnostic("process.error", {
        pid: child.pid,
        error: errorMessage(error),
      });
      // N28: a spawn failure (for example ENOENT) otherwise surfaces only as
      // an opaque "stdio closed" on the first request.
      this.startError = error;
      this.flushPending(new Error(this.describeStartFailure(error)));
    });
    child.once("exit", () => {
      // N27: commands the app server left in its group stop with it. Sent at
      // once: a pid is not reused while a group of that id has members.
      signalProcessGroup(child, "SIGKILL");
    });
    child.on("close", (code, signal) => {
      logCodexRpcDiagnostic("process.close", {
        pid: child.pid,
        code,
        signal,
        pendingRequests: this.pending.size,
        recentStderr: sanitizeTimeoutStderr(this.stderrTail.trim()),
      });
      this.flushPending(new Error(this.startError
        ? this.describeStartFailure(this.startError)
        : this.describeExit(code, signal)));
      this.process = null;
      this.onClose();
    });
  }

  async close(): Promise<void> {
    logCodexRpcDiagnostic("client.close", {
      pid: this.process?.pid,
      pendingRequests: this.pending.size,
    });
    this.flushPending(new Error("codex app server stdio closed"));
    const child = this.process;
    this.process = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        resolve();
      };
      child.once("close", finish);
      const forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          logCodexRpcDiagnostic("process.force_kill", { pid: child.pid });
          signalProcessGroup(child, "SIGKILL");
        }
      }, Math.max(1, this.shutdownGraceMs));
      forceKillTimer.unref?.();
      // The whole group while the app server still runs (its pid, the group
      // id, may be reused once it has exited), so its commands stop too.
      signalProcessGroup(child, "SIGTERM");
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = `rpc-${++this.counter}`;
    // Write before registering the pending entry: a write that throws (for
    // example after the transport closed) must not leave an orphaned pending
    // promise that a later close() rejects with nobody listening. Responses are
    // read asynchronously, so none can arrive before the entry is registered.
    this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return await new Promise<unknown>((resolve, reject) => {
      const effectiveTimeoutMs = Math.max(100, timeoutMs ?? this.requestTimeoutMs);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        logCodexRpcDiagnostic("request.timeout", {
          id,
          method,
          timeoutMs: effectiveTimeoutMs,
          pid: this.process?.pid,
          recentStderr: sanitizeTimeoutStderr(this.stderrTail.trim()),
        });
        reject(new Error(this.buildTimeoutErrorMessage(method, effectiveTimeoutMs)));
      }, effectiveTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
    });
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
    if (this.pending.size > 0) {
      logCodexRpcDiagnostic("pending.flush", {
        pendingRequests: this.pending.size,
        error: error.message,
        pid: this.process?.pid,
      });
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /** Why the app server could not be started, with what to do about it. */
  private describeStartFailure(error: Error): string {
    const code = (error as NodeJS.ErrnoException).code;
    const hint = code === "ENOENT"
      ? ` The \`${this.command}\` command was not found: install the Codex CLI (for example \`npm install -g @openai/codex\`) or set OPENCLAW_CODEX_APP_SERVER_COMMAND to its path.`
      : "";
    return `Could not start the Codex App Server (\`${this.command} app-server\`): ${error.message}.${hint}`;
  }

  /** The app server exited: say how, and include its last stderr lines (redacted). */
  private describeExit(code: number | null, signal: NodeJS.Signals | null): string {
    const how = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    const stderr = sanitizeTimeoutStderr(this.stderrTail.trim());
    return `codex app server exited (${how}) before it answered${stderr ? `; recent stderr: ${stderr}` : ""}`;
  }

  private buildTimeoutErrorMessage(method: string, timeoutMs: number): string {
    const stderr = this.stderrTail.trim();
    const stderrSuffix = stderr
      ? `; recent stderr: ${sanitizeTimeoutStderr(stderr)}`
      : "";
    return `codex app server timeout after ${timeoutMs}ms: ${method}${stderrSuffix}`;
  }
}

/** Signal the app server's process group (POSIX), or the process itself. */
function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is gone (or was never created); fall back to the child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

function sanitizeTimeoutStderr(stderr: string): string {
  return stderr
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1[redacted credential]@")
    .replace(/\b(authorization\s*[:=]\s*)[^\r\n,;}]+/gi, "$1[redacted credential]")
    .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted credential]")
    .replace(/(["'][A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|authorization)[A-Za-z0-9_.-]*["']\s*:\s*["'])[^"']+(["'])/gi, "$1[redacted credential]$2")
    .replace(/\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|authorization)[A-Za-z0-9_.-]*\s*[:=]\s*)[^\s,}]+/gi, "$1[redacted credential]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsru]_[A-Za-z0-9_]{8,}|[A-Za-z0-9_-]{32,})\b/g, "[redacted token]")
    .replace(/(?:\/Users|\/home)\/[^\s]+/g, "[redacted path]")
    .replace(/\s+/g, " ")
    .slice(-1_000);
}
