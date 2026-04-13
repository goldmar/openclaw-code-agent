import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

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
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type JsonRpcNotificationHandler = (method: string, params: unknown) => Promise<void> | void;
export type JsonRpcRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export type JsonRpcClient = {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  notify: (method: string, params?: unknown) => Promise<void>;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  setNotificationHandler: (handler: JsonRpcNotificationHandler) => void;
  setRequestHandler: (handler: JsonRpcRequestHandler) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseJsonRpc(raw: string): JsonRpcEnvelope | null {
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

export class StdioJsonRpcClient implements JsonRpcClient {
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
    // Codex is a native local backend for this plugin, so the accepted transport
    // surface here is a stdio child process rather than an in-process SDK client.
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
