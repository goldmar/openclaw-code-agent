import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createListener, type Server, type Socket } from "node:net";
import { OpenCodeHarness, isConnectionResetError, type OpenCodeServerHandle } from "../src/harness/opencode";
import type { HarnessMessage } from "../src/harness/types";
import { OpenCodeBackend } from "./harness-backends";

/**
 * The fake OpenCode server behind a real loopback HTTP listener, so requests
 * go through Node's fetch and its connection pool. Each `start()` is one
 * `opencode serve` generation on the same port, as `--port 0` usually binds
 * 4096 again. `close()` behaves like a killed server process whose sockets the
 * client has not noticed yet: the next byte sent on one of them is answered
 * with a TCP reset.
 */
class LoopbackOpenCodeServer {
  generation = 0;
  readonly requests: Array<{ generation: number; method: string; path: string; connection: string | undefined }> = [];
  private port = 0;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private exitListener: ((reason: string) => void) | undefined;

  constructor(private readonly handler: typeof fetch) {}

  async start(): Promise<OpenCodeServerHandle> {
    this.generation += 1;
    const generation = this.generation;
    const http = createServer((req, res) => { void this.serve(generation, req, res); });
    // A plain TCP listener hands connections to the HTTP server, so closing the
    // listener frees the port without closing idle keep-alive connections, as
    // with a killed process whose FIN the client has not processed yet.
    const listener = createListener((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      http.emit("connection", socket);
    });
    await new Promise<void>((resolve) => listener.listen(this.port, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("loopback server has no port");
    this.port = address.port;
    this.server = listener;
    return {
      baseUrl: `http://127.0.0.1:${this.port}`,
      close: async () => this.close(),
      onExit: (listener) => { this.exitListener = listener; },
    };
  }

  /** The server process died: OCA hears about the exit, its sockets are stale. */
  crash(): void {
    this.close();
    this.exitListener?.("OpenCode server exited unexpectedly (SIGKILL).");
  }

  close(): void {
    for (const socket of this.sockets) {
      socket.prependListener("data", () => socket.resetAndDestroy());
    }
    this.server?.close();
    this.server = undefined;
  }

  destroyAll(): void {
    this.server?.close();
    for (const socket of this.sockets) socket.destroy();
  }

  private async serve(generation: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    this.requests.push({ generation, method: req.method ?? "GET", path: url.pathname, connection: req.headers.connection });
    const response = await this.handler(url.href, {
      method: req.method,
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    // Send the headers now: an event stream has no body until its first event.
    res.flushHeaders();
    if (response.body) {
      for await (const chunk of response.body) {
        if (res.destroyed) break;
        res.write(chunk);
      }
    }
    res.end();
  }
}

async function runTurn(harness: OpenCodeHarness, backend: OpenCodeBackend, turn: number, text: string): Promise<HarnessMessage[]> {
  const session = harness.launch({ prompt: `turn ${turn}`, cwd: "/tmp" });
  const messages: HarnessMessage[] = [];
  const collected = (async () => {
    for await (const message of session.messages) {
      messages.push(message);
      if (message.type === "run_completed") break;
    }
  })();
  await backend.waitForTurns(turn);
  await backend.endTurn(text);
  await collected;
  return messages;
}

let loopback: LoopbackOpenCodeServer | undefined;

afterEach(() => {
  loopback?.destroyAll();
  loopback = undefined;
});

describe("OpenCode server restarts on the same port", () => {
  it("runs the first turn after a restart without reusing sockets of the previous server", async () => {
    const backend = new OpenCodeBackend();
    loopback = new LoopbackOpenCodeServer(backend.fetch);
    const server = loopback;
    const harness = new OpenCodeHarness({
      createServer: () => server.start(),
      serverIdleShutdownMs: 60_000,
      fallbackPollIntervalMs: 5,
      streamReconnectDelayMs: 5,
    });

    const first = await runTurn(harness, backend, 1, "first done");
    assert.equal(first.find((message) => message.type === "run_completed")?.type, "run_completed");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The shared server dies; the next launch starts generation 2 on the same port.
    server.crash();
    const second = await runTurn(harness, backend, 2, "second done");
    const completed = second.find((message): message is Extract<HarnessMessage, { type: "run_completed" }> => message.type === "run_completed");
    assert.equal(completed?.data.success, true, JSON.stringify(completed?.data));
    assert.equal(server.generation, 2);
    assert.ok(server.requests.some((request) => request.generation === 2 && request.path === "/session"));
    assert.deepEqual(
      server.requests.filter((request) => request.connection !== "close"),
      [],
      "every request opts out of keep-alive",
    );
    assert.deepEqual(backend.protocolViolations, []);
    // Stop generation 2 so its event stream does not keep the test process alive.
    server.crash();
  });
});

describe("isConnectionResetError", () => {
  it("recognizes fetch failures caused by a reset connection", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    assert.equal(isConnectionResetError(new TypeError("fetch failed", { cause: reset })), true);
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    assert.equal(isConnectionResetError(new TypeError("fetch failed", { cause: socket })), true);
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    assert.equal(isConnectionResetError(new TypeError("fetch failed", { cause: refused })), false);
    assert.equal(isConnectionResetError(new Error("OpenCode GET /session/status timed out after 5ms.")), false);
  });
});

describe("OpenCode request retry", () => {
  it("repeats a read once when its connection was reset", async () => {
    const backend = new OpenCodeBackend();
    let resets = 0;
    const flakyFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/message") && resets === 0) {
        resets += 1;
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
      }
      return await backend.fetch(input, init);
    };
    const harness = new OpenCodeHarness({
      createServer: async () => ({ baseUrl: "http://opencode.test", close: async () => undefined }),
      fetch: flakyFetch,
      serverIdleShutdownMs: 0,
      fallbackPollIntervalMs: 5,
      streamReconnectDelayMs: 5,
    });

    const messages = await runTurn(harness, backend, 1, "done after a reset");
    const completed = messages.find((message): message is Extract<HarnessMessage, { type: "run_completed" }> => message.type === "run_completed");
    assert.equal(resets, 1);
    assert.equal(completed?.data.success, true, JSON.stringify(completed?.data));
    assert.ok(messages.some((message) => message.type === "text_delta"));
  });
});
