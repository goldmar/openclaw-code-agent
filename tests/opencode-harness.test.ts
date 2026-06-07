import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpenCodeHarness } from "../src/harness/opencode";
import type { HarnessMessage } from "../src/harness/types";

type RequestRecord = {
  method: string;
  path: string;
  body?: unknown;
};

class MockOpenCodeServer {
  requests: RequestRecord[] = [];
  closed = false;
  waitMode: "immediate" | "defer" = "immediate";
  statusMode: "idle" | "busy-then-idle" = "idle";
  busyStatusResponses = 0;
  omitIdleStatus = false;
  assistantAvailableAfterStatusRequests = 0;
  assistantMessageShape: "classic" | "current" = "classic";
  failQuestionReplies = false;
  failSessionPatch = false;
  private streamController?: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private statusRequests = 0;
  private promptAsyncRequests = 0;
  private deferredWait?: {
    resolve: (response: Response) => void;
    reject: (error: unknown) => void;
  };

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path, body });

    if (path === "/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.streamController = controller;
        },
        cancel: () => undefined,
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    if (path === "/api/health") return json({ healthy: true, version: "1.16.2" });
    if (method === "POST" && path === "/session") return json({ id: "ses_test" });
    if (method === "POST" && path === "/session/ses_existing/fork") return json({ id: "ses_forked" });
    if (method === "GET" && path === "/session/status") {
      this.statusRequests += 1;
      const type = (this.busyStatusResponses > 0 && this.statusRequests <= this.busyStatusResponses)
        || (this.statusMode === "busy-then-idle" && this.statusRequests === 1)
        ? "busy"
        : "idle";
      if (this.omitIdleStatus && type === "idle") return json({});
      return json({ ses_test: { type }, ses_existing: { type }, ses_forked: { type } });
    }
    if (method === "GET" && /^\/session\/[^/]+\/message$/.test(path)) {
      if (this.statusRequests < this.assistantAvailableAfterStatusRequests) return json([]);
      return json(Array.from({ length: this.promptAsyncRequests }, () => this.assistantMessageShape === "current"
        ? {
            info: { role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "Final from current shape." }],
          }
        : {
            info: { type: "assistant", content: [{ type: "text", text: "Final." }] },
            parts: [],
          }));
    }
    if (method === "POST" && path.endsWith("/prompt_async")) {
      this.promptAsyncRequests += 1;
      if (this.waitMode === "defer") {
        return await new Promise<Response>((resolve, reject) => {
          this.deferredWait = { resolve, reject };
          init?.signal?.addEventListener("abort", () => reject(new Error("wait aborted")), { once: true });
        });
      }
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path.startsWith("/permission/") && path.endsWith("/reply")) return json(true);
    if (method === "POST" && path.startsWith("/question/") && path.endsWith("/reply")) {
      if (this.failQuestionReplies) {
        return new Response(JSON.stringify({ error: "question reply failed" }), { status: 500 });
      }
      return json(true);
    }
    if (method === "PATCH" && path === "/session/ses_test") {
      if (this.failSessionPatch) {
        return new Response(JSON.stringify({ error: "permission patch failed" }), { status: 500 });
      }
      return json({ id: "ses_test" });
    }
    if (method === "POST" && path === "/session/ses_test/abort") return json(true);
    return new Response(JSON.stringify({ error: `unexpected ${method} ${path}` }), { status: 404 });
  };

  emit(event: unknown): void {
    this.streamController?.enqueue(this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  }

  closeStream(): void {
    this.streamController?.close();
  }

  resolveWait(response = new Response(null, { status: 204 })): void {
    this.deferredWait?.resolve(response);
    this.deferredWait = undefined;
  }

  handle() {
    return {
      baseUrl: "http://opencode.test",
      close: async () => {
        this.closed = true;
        this.closeStream();
      },
    };
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function htmlShell(): Response {
  return new Response("<!doctype html><html><head><title>OpenCode</title></head><body><div id=\"root\"></div></body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function collectMessages(
  session: { messages: AsyncIterable<HarnessMessage> },
  limit = 20,
): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const message of session.messages) {
    out.push(message);
    if (out.length >= limit) break;
    if (message.type === "run_completed") break;
  }
  return out;
}

async function collectAllMessages(
  session: { messages: AsyncIterable<HarnessMessage> },
): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const message of session.messages) {
    out.push(message);
  }
  return out;
}

function installFakeOpenCodeServer(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-opencode-test-"));
  const file = join(dir, "opencode");
  writeFileSync(file, `#!/usr/bin/env node\n${script}`);
  chmodSync(file, 0o755);
  return file;
}

function installFakeOpenCodeServerInDir(dir: string, script: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode");
  writeFileSync(file, `#!/usr/bin/env node\n${script}`);
  chmodSync(file, 0o755);
  return file;
}

function waitForRequest(mock: MockOpenCodeServer, path: string, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (mock.requests.some((request) => request.path === path)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for request ${path}`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function waitForRequestCount(mock: MockOpenCodeServer, path: string, count: number, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (mock.requests.filter((request) => request.path === path).length >= count) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${count} requests to ${path}`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe("OpenCodeHarness static properties", () => {
  const h = new OpenCodeHarness();

  it("exposes the OpenCode backend contract", () => {
    assert.equal(h.name, "opencode");
    assert.equal(h.backendKind, "opencode-server");
    assert.ok(h.supportedPermissionModes.includes("default"));
    assert.ok(h.supportedPermissionModes.includes("plan"));
    assert.ok(h.supportedPermissionModes.includes("bypassPermissions"));
    assert.equal(h.capabilities.nativePendingInput, true);
    assert.equal(h.capabilities.nativePlanArtifacts, false);
    assert.equal(h.capabilities.worktrees, "plugin-managed");
  });

  it("builds user messages", () => {
    assert.deepEqual(h.buildUserMessage("hello", "ses_1"), {
      type: "user",
      text: "hello",
      session_id: "ses_1",
    });
  });
});

describe("OpenCodeHarness HTTP/SSE mapping", () => {
  it("creates a session, sends a classic async prompt, and emits backend/completion", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/repo",
      permissionMode: "plan",
      model: "anthropic/claude-sonnet-4-5",
    }));

    const create = mock.requests.find((request) => request.method === "POST" && request.path === "/session");
    assert.deepEqual(create?.body, {
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      metadata: { client: "openclaw-code-agent" },
      permission: [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "external_directory", pattern: "*", action: "deny" },
      ],
    });

    const prompt = mock.requests.find((request) => request.method === "POST" && request.path === "/session/ses_test/prompt_async");
    assert.deepEqual(prompt?.body, {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      parts: [{ type: "text", text: "ship it" }],
    });
    assert.equal(mock.requests.some((request) => request.method === "GET" && request.path === "/session/status"), true);

    const ref = messages.find((message) => message.type === "backend_ref") as Extract<HarnessMessage, { type: "backend_ref" }> | undefined;
    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(ref?.ref.kind, "opencode-server");
    assert.equal(ref?.ref.conversationId, "ses_test");
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.result, "Final.");
    assert.equal(mock.closed, true);
  });

  it("uses the real OpenCode classic JSON lifecycle endpoints", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/repo",
      permissionMode: "plan",
    }));

    const lifecyclePaths = mock.requests
      .map((request) => request.path)
      .filter((path) => path !== "/event");
    assert.ok(lifecyclePaths.length > 0);
    assert.equal(lifecyclePaths.some((path) => path.startsWith("/api/session")), false);
    assert.deepEqual(new Set(lifecyclePaths), new Set([
      "/session",
      "/session/ses_test/message",
      "/session/ses_test/prompt_async",
      "/session/status",
    ]));
  });

  it("rejects HTML 200 responses instead of accepting the OpenCode app shell as JSON", async () => {
    const mock = new MockOpenCodeServer();
    const originalFetch = mock.fetch;
    mock.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if ((init?.method ?? "GET") === "POST" && url.pathname === "/session") {
        mock.requests.push({ method: "POST", path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        return htmlShell();
      }
      return originalFetch(input, init);
    };
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/repo",
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(result?.data.success, false);
    assert.match(result?.data.result ?? "", /OpenCode POST \/session expected JSON API response/);
    assert.match(result?.data.result ?? "", /content-type text\/html/);
    assert.match(result?.data.result ?? "", /web UI HTML app shell/);
    assert.doesNotMatch(result?.data.result ?? "", /<\/html>.*<\/html>/);
  });

  it("waits for classic status polling before completing", async () => {
    const mock = new MockOpenCodeServer();
    mock.statusMode = "busy-then-idle";
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/repo",
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(mock.requests.some((request) => request.method === "GET" && request.path === "/session/status"), true);
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.result, "Final.");
  });

  it("treats sessions missing from the classic active status map as idle", async () => {
    const mock = new MockOpenCodeServer();
    mock.statusMode = "busy-then-idle";
    mock.omitIdleStatus = true;
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/repo",
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(
      mock.requests.filter((request) => request.method === "GET" && request.path === "/session/status").length,
      2,
    );
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.result, "Final.");
  });

  it("uses classic status polling on later turns", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      yield { type: "user", text: "second" };
    }

    const messages = await collectAllMessages(harness.launch({ prompt: prompts(), cwd: "/repo" }));
    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 2);
    assert.equal(completions.every((completion) => completion.data.success), true);
    assert.equal(mock.requests.filter((request) => request.path === "/session/status").length, 2);
  });

  it("uses classic prompt_async and message routes", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "implement",
      cwd: "/repo",
      model: "anthropic/claude-sonnet-4-5",
      systemPrompt: "Use project conventions.",
    }));

    const classicPrompt = mock.requests.find((request) => request.method === "POST" && request.path === "/session/ses_test/prompt_async");
    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.deepEqual(classicPrompt?.body, {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      system: "Use project conventions.",
      parts: [{ type: "text", text: "implement" }],
    });
    assert.equal(mock.requests.some((request) => request.method === "GET" && request.path === "/session/ses_test/message"), true);
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.result, "Final.");
  });

  it("extracts assistant results from current OpenCode role/parts messages", async () => {
    const mock = new MockOpenCodeServer();
    mock.assistantMessageShape = "current";
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/repo",
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.result, "Final from current shape.");
  });

  it("waits for OpenCode turns beyond the short HTTP request timeout", async () => {
    const mock = new MockOpenCodeServer();
    mock.busyStatusResponses = 2;
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
      requestTimeoutMs: 5,
      turnTimeoutMs: 1_000,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "long enough",
      cwd: "/repo",
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(mock.requests.filter((request) => request.method === "GET" && request.path === "/session/status").length, 3);
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.result, "Final.");
  });

  it("does not complete from idle status before a classic async prompt produces an assistant message", async () => {
    const mock = new MockOpenCodeServer();
    mock.assistantAvailableAfterStatusRequests = 3;
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "avoid stale result",
      cwd: "/repo",
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.result, "Final.");
    assert.equal(mock.requests.filter((request) => request.method === "GET" && request.path === "/session/status").length, 3);
  });

  it("streams text deltas and tool calls from OpenCode events", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "stream", cwd: "/repo" });
    await waitForEventStream;
    mock.emit({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_test", delta: "Hello" },
    });
    mock.emit({
      type: "session.next.tool.called",
      properties: { sessionID: "ses_test", tool: "bash", input: { command: "pwd" } },
    });

    const messages = await collectMessages(session);
    const text = messages.find((message) => message.type === "text_delta") as Extract<HarnessMessage, { type: "text_delta" }> | undefined;
    const tool = messages.find((message) => message.type === "tool_call") as Extract<HarnessMessage, { type: "tool_call" }> | undefined;
    assert.equal(text?.text, "Hello");
    assert.equal(tool?.name, "bash");
    assert.deepEqual(tool?.input, { command: "pwd" });
  });

  it("normalizes numbered sync event names", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "stream", cwd: "/repo" });
    await waitForEventStream;
    mock.emit({
      type: "sync",
      name: "session.next.text.delta.12",
      data: { sessionID: "ses_test", delta: "Hello" },
    });

    const messages = await collectMessages(session);
    const text = messages.find((message) => message.type === "text_delta") as Extract<HarnessMessage, { type: "text_delta" }> | undefined;
    assert.equal(text?.text, "Hello");
  });

  it("ignores events for other OpenCode sessions", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "stream", cwd: "/repo" });
    await waitForEventStream;
    mock.emit({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_other", delta: "wrong" },
    });
    mock.emit({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_test", delta: "right" },
    });

    const messages = await collectMessages(session);
    const text = messages.filter((message) => message.type === "text_delta") as Extract<HarnessMessage, { type: "text_delta" }>[];
    assert.deepEqual(text.map((message) => message.text), ["right"]);
  });

  it("maps permission requests to pending input and replies with classic endpoint", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "needs permission", cwd: "/repo" });
    await waitForEventStream;
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: [],
      },
    });

    const seen: HarnessMessage[] = [];
    for await (const message of session.messages) {
      seen.push(message);
      if (message.type === "pending_input") {
        assert.equal(await session.submitPendingInputOption?.(0), true);
      }
      if (message.type === "pending_input_resolved") break;
    }

    const pending = seen.find((message) => message.type === "pending_input") as Extract<HarnessMessage, { type: "pending_input" }> | undefined;
    assert.equal(pending?.state.kind, "approval");
    assert.equal(pending?.state.requestId, "per_1");
    const reply = mock.requests.find((request) => request.path === "/permission/per_1/reply");
    assert.deepEqual(reply?.body, { reply: "once" });
  });

  it("deduplicates permission resolved events when the server echoes the reply", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "needs permission", cwd: "/repo" });
    await waitForEventStream;
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "per_echo",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["npm test"],
      },
    });

    const seen: HarnessMessage[] = [];
    const iterator = session.messages[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      seen.push(next.value);
      if (next.value.type === "pending_input") {
        assert.equal(await session.submitPendingInputOption?.(0), true);
        mock.emit({
          type: "permission.replied",
          properties: { sessionID: "ses_test", requestID: "per_echo" },
        });
      }
      if (seen.filter((message) => message.type === "pending_input_resolved").length === 1) break;
    }
    mock.resolveWait();
    for await (const message of iterator) {
      seen.push(message);
    }

    const resolved = seen.filter((message) => message.type === "pending_input_resolved") as Extract<HarnessMessage, { type: "pending_input_resolved" }>[];
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.requestId, "per_echo");
  });

  it("deduplicates question resolved events when the server echoes the reply", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "needs answer", cwd: "/repo" });
    await waitForEventStream;
    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_echo",
        sessionID: "ses_test",
        question: "Which branch?",
        options: ["main"],
      },
    });

    const seen: HarnessMessage[] = [];
    const iterator = session.messages[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      seen.push(next.value);
      if (next.value.type === "pending_input") {
        assert.equal(await session.submitPendingInputText?.("main"), true);
        mock.emit({
          type: "question.replied",
          properties: { sessionID: "ses_test", requestID: "q_echo" },
        });
      }
      if (seen.filter((message) => message.type === "pending_input_resolved").length === 1) break;
    }
    mock.resolveWait();
    for await (const message of iterator) {
      seen.push(message);
    }

    const resolved = seen.filter((message) => message.type === "pending_input_resolved") as Extract<HarnessMessage, { type: "pending_input_resolved" }>[];
    const reply = mock.requests.find((request) => request.path === "/question/q_echo/reply");
    assert.deepEqual(reply?.body, { answers: [["main"]] });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.requestId, "q_echo");
  });

  it("emits failed completion when inline question reply fails after a completed turn", async () => {
    const mock = new MockOpenCodeServer();
    mock.failQuestionReplies = true;
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });
    const nextPrompt = Promise.withResolvers<void>();

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      await nextPrompt.promise;
      yield { type: "user", text: "main" };
    }

    const session = harness.launch({ prompt: prompts(), cwd: "/repo" });
    const iterator = session.messages[Symbol.asyncIterator]();
    const seen: HarnessMessage[] = [];
    while (true) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      seen.push(next.value);
      if (next.value.type === "run_completed") break;
    }

    const firstCompletion = seen.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(firstCompletion?.data.success, true);

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_fail",
        sessionID: "ses_test",
        question: "Which branch?",
        options: ["main"],
      },
    });

    while (!seen.some((message) => message.type === "pending_input")) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      seen.push(next.value);
    }

    nextPrompt.resolve();
    for await (const message of iterator) {
      seen.push(message);
    }

    const completions = seen.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 2);
    assert.equal(completions[1]?.data.success, false);
    assert.equal(completions[1]?.data.outcome, "failed");
    assert.match(completions[1]?.data.result ?? "", /question reply failed/);
  });

  it("auto-approves permission requests in bypassPermissions mode", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "go", cwd: "/repo", permissionMode: "bypassPermissions" });
    await waitForEventStream;
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "per_auto",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: [],
      },
    });

    await collectMessages(session);
    const reply = mock.requests.find((request) => request.path === "/permission/per_auto/reply");
    assert.deepEqual(reply?.body, { reply: "once" });
  });

  it("resumes by sending the first prompt on the classic session", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    await collectMessages(harness.launch({
      prompt: "continue",
      cwd: "/repo",
      resumeSessionId: "ses_existing",
    }));

    const prompt = mock.requests.find((request) => request.method === "POST" && request.path === "/session/ses_existing/prompt_async");
    assert.deepEqual(prompt?.body, {
      parts: [{ type: "text", text: "continue" }],
    });
  });

  it("validates resumed sessions only once across multi-turn prompts", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      yield { type: "user", text: "second" };
    }

    await collectAllMessages(harness.launch({
      prompt: prompts(),
      cwd: "/repo",
      resumeSessionId: "ses_existing",
    }));

    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/session/ses_existing/prompt_async");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { parts: [{ type: "text", text: "first" }] },
      { parts: [{ type: "text", text: "second" }] },
    ]);
  });

  it("forks resumed sessions only once across multi-turn prompts", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      yield { type: "user", text: "second" };
    }

    await collectAllMessages(harness.launch({
      prompt: prompts(),
      cwd: "/repo",
      resumeSessionId: "ses_existing",
      forkSession: true,
    }));

    const forkRequests = mock.requests.filter((request) => request.method === "POST" && request.path.endsWith("/fork"));
    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/session/ses_forked/prompt_async");
    assert.deepEqual(forkRequests.map((request) => request.path), ["/session/ses_existing/fork"]);
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { parts: [{ type: "text", text: "first" }] },
      { parts: [{ type: "text", text: "second" }] },
    ]);
  });

  it("sends system prompts on the first classic prompt", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    await collectMessages(harness.launch({
      prompt: "implement",
      cwd: "/repo",
      systemPrompt: "Use the project conventions.",
    }));

    const prompt = mock.requests.find((request) => request.method === "POST" && request.path === "/session/ses_test/prompt_async");
    assert.deepEqual(prompt?.body, {
      system: "Use the project conventions.",
      parts: [{ type: "text", text: "implement" }],
    });
  });

  it("sends system prompts only on the first multi-turn prompt", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      yield { type: "user", text: "second" };
    }

    await collectAllMessages(harness.launch({
      prompt: prompts(),
      cwd: "/repo",
      systemPrompt: "Use the project conventions.",
    }));

    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/session/ses_test/prompt_async");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { system: "Use the project conventions.", parts: [{ type: "text", text: "first" }] },
      { parts: [{ type: "text", text: "second" }] },
    ]);
  });

  it("emits failed completion from failed session events", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "fail", cwd: "/repo" });
    await waitForEventStream;
    mock.emit({
      type: "session.next.step.failed",
      properties: {
        sessionID: "ses_test",
        error: { message: "tool failed" },
      },
    });

    const messages = await collectMessages(session);
    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(result?.data.success, false);
    assert.equal(result?.data.result, "tool failed");
  });

  it("does not emit a second completion when an SSE failure races with wait success", async () => {
    const mock = new MockOpenCodeServer();
    mock.waitMode = "defer";
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "fail once", cwd: "/repo" });
    await waitForEventStream;
    await waitForRequest(mock, "/session/ses_test/prompt_async");
    mock.emit({
      type: "session.next.step.failed",
      properties: {
        sessionID: "ses_test",
        error: { message: "tool failed" },
      },
    });
    mock.resolveWait();

    const messages = await collectAllMessages(session);
    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.data.success, false);
    assert.equal(completions[0]?.data.outcome, "failed");
    assert.equal(completions[0]?.data.result, "tool failed");
  });

  it("keeps wait success when an SSE failure arrives during context fetch", async () => {
    const mock = new MockOpenCodeServer();
    const contextRequested = Promise.withResolvers<void>();
    const releaseContext = Promise.withResolvers<void>();
    let messageFetches = 0;
    const originalFetch = mock.fetch;
    mock.fetch = async (input, init) => {
      const responsePromise = originalFetch(input, init);
      const url = new URL(typeof input === "string" ? input : input.url);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/session/ses_test/message") {
        messageFetches += 1;
        if (messageFetches === 3) {
          contextRequested.resolve();
          await releaseContext.promise;
        }
      }
      return await responsePromise;
    };
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "succeed", cwd: "/repo" });
    await contextRequested.promise;
    mock.emit({
      type: "session.next.step.failed",
      properties: {
        sessionID: "ses_test",
        error: { message: "late tool failed" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseContext.resolve();

    const messages = await collectAllMessages(session);
    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.data.success, true);
    assert.equal(completions[0]?.data.outcome, "completed");
    assert.equal(completions[0]?.data.result, "Final.");
  });

  it("times out an active wait even when an interrupt signal is attached", async () => {
    const mock = new MockOpenCodeServer();
    mock.waitMode = "defer";
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
      requestTimeoutMs: 5,
    });

    const messages = await collectAllMessages(harness.launch({ prompt: "hang", cwd: "/repo" }));

    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.data.success, false);
    assert.equal(completions[0]?.data.outcome, "failed");
    assert.match(completions[0]?.data.result ?? "", /OpenCode POST \/session\/ses_test\/prompt_async timed out after 5ms/);
  });

  it("does not emit a failed completion after interrupt aborts an active wait", async () => {
    const mock = new MockOpenCodeServer();
    mock.waitMode = "defer";
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "stop", cwd: "/repo" });
    await waitForRequest(mock, "/session/ses_test/prompt_async");
    await session.interrupt?.();

    const messages = await collectAllMessages(session);
    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.data.success, false);
    assert.equal(completions[0]?.data.outcome, "interrupted");
    assert.equal(mock.requests.some((request) => request.method === "POST" && request.path === "/session/ses_test/abort"), true);
  });

  it("stops a multi-message prompt stream after interrupting an active turn", async () => {
    const mock = new MockOpenCodeServer();
    mock.waitMode = "defer";
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      yield { type: "user", text: "second" };
    }

    const session = harness.launch({ prompt: prompts(), cwd: "/repo" });
    await waitForRequest(mock, "/session/ses_test/prompt_async");
    await session.interrupt?.();

    const messages = await collectAllMessages(session);
    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.data.outcome, "interrupted");

    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/session/ses_test/prompt_async");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { parts: [{ type: "text", text: "first" }] },
    ]);
  });

  it("emits interrupted completion when interrupted before session creation", async () => {
    const mock = new MockOpenCodeServer();
    let resolveServer!: (handle: ReturnType<MockOpenCodeServer["handle"]>) => void;
    const serverRequested = Promise.withResolvers<void>();
    const serverReady = new Promise<ReturnType<MockOpenCodeServer["handle"]>>((resolve) => {
      resolveServer = resolve;
    });
    const harness = new OpenCodeHarness({
      createServer: async () => {
        serverRequested.resolve();
        return await serverReady;
      },
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "stop during startup", cwd: "/repo" });
    await serverRequested.promise;
    await session.interrupt?.();
    resolveServer(mock.handle());

    const messages = await collectAllMessages(session);
    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.data.success, false);
    assert.equal(completions[0]?.data.outcome, "interrupted");
    assert.equal(mock.closed, true);
    assert.equal(mock.requests.some((request) => request.path === "/session"), false);
    assert.equal(mock.requests.some((request) => request.path === "/session/ses_test/prompt_async"), false);
  });

  it("closes a late OpenCode server handle after startup abort", async () => {
    const mock = new MockOpenCodeServer();
    let capturedSignal: AbortSignal | undefined;
    let resolveServer!: (handle: ReturnType<MockOpenCodeServer["handle"]>) => void;
    const serverRequested = Promise.withResolvers<void>();
    const serverReady = new Promise<ReturnType<MockOpenCodeServer["handle"]>>((resolve) => {
      resolveServer = resolve;
    });
    const abortController = new AbortController();
    const harness = new OpenCodeHarness({
      createServer: async (options) => {
        capturedSignal = options.signal;
        serverRequested.resolve();
        return await serverReady;
      },
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "stop during startup", cwd: "/repo", abortController });
    await serverRequested.promise;
    abortController.abort();
    resolveServer(mock.handle());

    const messages = await collectAllMessages(session);
    const completion = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(capturedSignal?.aborted, true);
    assert.equal(mock.closed, true);
    assert.equal(mock.requests.some((request) => request.path === "/session"), false);
    assert.equal(completion?.data.success, false);
    assert.match(completion?.data.result ?? "", /interrupted before session creation/);
  });

  it("reports the OpenCode route that times out during startup", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      requestTimeoutMs: 5,
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/session") {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
          });
        }
        return await mock.fetch(input, init);
      },
    });

    const messages = await collectAllMessages(harness.launch({ prompt: "start", cwd: "/repo" }));
    const completion = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(completion?.data.success, false);
    assert.match(completion?.data.result ?? "", /OpenCode POST \/session timed out after 5ms/);
    assert.equal(mock.closed, true);
  });

  it("fails startup with a readiness diagnostic when the health fetch hangs", async () => {
    const previousCommand = process.env.OPENCLAW_OPENCODE_COMMAND;
    const fakeOpenCodeCommand = installFakeOpenCodeServer(`
const http = require("node:http");
const portArg = process.argv[process.argv.indexOf("--port") + 1];
const server = http.createServer((_req, _res) => {});
server.listen(Number(portArg), "127.0.0.1");
`);
    process.env.OPENCLAW_OPENCODE_COMMAND = fakeOpenCodeCommand;
    try {
      const harness = new OpenCodeHarness({ requestTimeoutMs: 5, startupTimeoutMs: 25 });

      const messages = await collectAllMessages(harness.launch({ prompt: "start", cwd: process.cwd() }));
      const completion = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
      assert.equal(messages.some((message) => message.type === "backend_ref"), false);
      assert.equal(completion?.data.success, false);
      assert.match(completion?.data.result ?? "", /Timed out waiting for OpenCode server readiness/);
      assert.match(completion?.data.result ?? "", /Command: .*opencode serve --hostname 127\.0\.0\.1 --port \d+ --print-logs/);
      assert.match(completion?.data.result ?? "", /PATH:/);
    } finally {
      if (previousCommand === undefined) {
        delete process.env.OPENCLAW_OPENCODE_COMMAND;
      } else {
        process.env.OPENCLAW_OPENCODE_COMMAND = previousCommand;
      }
      rmSync(dirname(fakeOpenCodeCommand), { recursive: true, force: true });
    }
  });

  it("retries a timed-out OpenCode health fetch during startup", async () => {
    const previousCommand = process.env.OPENCLAW_OPENCODE_COMMAND;
    const fakeOpenCodeCommand = installFakeOpenCodeServer(`
const http = require("node:http");
const portArg = process.argv[process.argv.indexOf("--port") + 1];
let healthRequests = 0;
let prompted = false;
let statusRequests = 0;
const json = (res, value) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/api/health") {
    healthRequests += 1;
    if (healthRequests === 1) return;
    return json(res, { healthy: true });
  }
  if (path === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return;
  }
  if (req.method === "POST" && path === "/session") return json(res, { id: "ses_retry" });
  if (req.method === "POST" && path === "/session/ses_retry/prompt_async") {
    prompted = true;
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && path === "/session/status") {
    statusRequests += 1;
    return json(res, { ses_retry: { type: prompted && statusRequests > 1 ? "idle" : "busy" } });
  }
  if (req.method === "GET" && path === "/session/ses_retry/message") {
    return json(res, prompted && statusRequests > 1
      ? [{ type: "assistant", content: [{ type: "text", text: "READY_AFTER_RETRY" }] }]
      : []);
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
server.listen(Number(portArg), "127.0.0.1");
`);
    process.env.OPENCLAW_OPENCODE_COMMAND = fakeOpenCodeCommand;
    try {
      const harness = new OpenCodeHarness({ requestTimeoutMs: 50, startupTimeoutMs: 500 });

      const messages = await collectAllMessages(harness.launch({ prompt: "start", cwd: process.cwd() }));
      const completion = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
      assert.equal(messages.some((message) => message.type === "backend_ref"), true);
      assert.equal(completion?.data.success, true);
      assert.match(completion?.data.result ?? "", /READY_AFTER_RETRY/);
    } finally {
      if (previousCommand === undefined) {
        delete process.env.OPENCLAW_OPENCODE_COMMAND;
      } else {
        process.env.OPENCLAW_OPENCODE_COMMAND = previousCommand;
      }
      rmSync(dirname(fakeOpenCodeCommand), { recursive: true, force: true });
    }
  });

  it("resolves OpenCode from a Homebrew bin next to a Gateway node opt path", async () => {
    const previousCommand = process.env.OPENCLAW_OPENCODE_COMMAND;
    const previousPath = process.env.PATH;
    const prefix = mkdtempSync(join(tmpdir(), "openclaw-opencode-prefix-"));
    installFakeOpenCodeServerInDir(join(prefix, "bin"), `
const http = require("node:http");
const portArg = process.argv[process.argv.indexOf("--port") + 1];
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ healthy: true }));
});
server.listen(Number(portArg), "127.0.0.1");
`);
    mkdirSync(join(prefix, "opt", "node", "bin"), { recursive: true });
    delete process.env.OPENCLAW_OPENCODE_COMMAND;
    process.env.PATH = join(prefix, "opt", "node", "bin");
    try {
      const harness = new OpenCodeHarness({ requestTimeoutMs: 5, startupTimeoutMs: 25 });

      const messages = await collectAllMessages(harness.launch({ prompt: "start", cwd: process.cwd() }));
      const completion = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
      assert.equal(completion?.data.success, false);
      assert.match(completion?.data.result ?? "", new RegExp(`Command: ${join(prefix, "bin", "opencode").replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} \\(resolved from opencode\\)`));
    } finally {
      if (previousCommand === undefined) {
        delete process.env.OPENCLAW_OPENCODE_COMMAND;
      } else {
        process.env.OPENCLAW_OPENCODE_COMMAND = previousCommand;
      }
      process.env.PATH = previousPath;
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("fails startup when session creation fetch never settles after abort", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      requestTimeoutMs: 5,
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        const method = init?.method ?? "GET";
        if (method === "POST" && url.pathname === "/session") {
          mock.requests.push({ method, path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
          return await new Promise<Response>(() => undefined);
        }
        return await mock.fetch(input, init);
      },
    });

    const messages = await collectAllMessages(harness.launch({ prompt: "start", cwd: "/repo" }));
    const completion = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(messages.some((message) => message.type === "backend_ref"), false);
    assert.equal(completion?.data.success, false);
    assert.match(completion?.data.result ?? "", /OpenCode POST \/session timed out after 5ms/);
    assert.equal(mock.closed, true);
  });

  it("shares startup across concurrent client requests", async () => {
    const mock = new MockOpenCodeServer();
    let createServerCalls = 0;
    let resolveServer!: (handle: ReturnType<MockOpenCodeServer["handle"]>) => void;
    const serverRequested = Promise.withResolvers<void>();
    const serverReady = new Promise<ReturnType<MockOpenCodeServer["handle"]>>((resolve) => {
      resolveServer = resolve;
    });
    const harness = new OpenCodeHarness({
      createServer: async () => {
        createServerCalls += 1;
        serverRequested.resolve();
        return await serverReady;
      },
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "start", cwd: "/repo" });
    await serverRequested.promise;
    const modePromise = session.setPermissionMode?.("plan");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(createServerCalls, 1);
    resolveServer(mock.handle());
    await modePromise;

    const messages = await collectAllMessages(session);
    const completion = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(createServerCalls, 1);
    assert.equal(completion?.data.success, true);
  });

  it("stores permission mode changes before startup without starting OpenCode", async () => {
    const mock = new MockOpenCodeServer();
    let createServerCalls = 0;
    const releasePrompt = Promise.withResolvers<void>();
    const harness = new OpenCodeHarness({
      createServer: async () => {
        createServerCalls += 1;
        return mock.handle();
      },
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      await releasePrompt.promise;
      yield { type: "user", text: "start" };
    }

    const session = harness.launch({ prompt: prompts(), cwd: "/repo" });
    await session.setPermissionMode?.("plan");
    assert.equal(createServerCalls, 0);

    releasePrompt.resolve();
    const messages = await collectAllMessages(session);
    const settings = messages.find((message) => message.type === "settings_changed") as Extract<HarnessMessage, { type: "settings_changed" }> | undefined;
    const create = mock.requests.find((request) => request.method === "POST" && request.path === "/session");
    assert.equal(settings?.permissionMode, "plan");
    assert.deepEqual(create?.body, {
      metadata: { client: "openclaw-code-agent" },
      permission: [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "todowrite", pattern: "*", action: "deny" },
        { permission: "external_directory", pattern: "*", action: "deny" },
      ],
    });
  });

  it("emits interrupted completion when interrupted between stream turns", async () => {
    const mock = new MockOpenCodeServer();
    const nextPrompt = Promise.withResolvers<void>();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      await nextPrompt.promise;
      yield { type: "user", text: "second" };
    }

    const session = harness.launch({ prompt: prompts(), cwd: "/repo" });
    const iterator = session.messages[Symbol.asyncIterator]();
    const seen: HarnessMessage[] = [];
    while (true) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      seen.push(next.value);
      if (next.value.type === "run_completed") break;
    }

    await session.interrupt?.();
    nextPrompt.resolve();
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value);
    }

    const completions = seen.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 2);
    assert.equal(completions[0]?.data.outcome, "completed");
    assert.equal(completions[1]?.data.success, false);
    assert.equal(completions[1]?.data.outcome, "interrupted");

    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/session/ses_test/prompt_async");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { parts: [{ type: "text", text: "first" }] },
    ]);
  });

  it("still emits one completion per prompt in a multi-turn launch stream", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      yield { type: "user", text: "second" };
    }

    const messages = await collectAllMessages(harness.launch({ prompt: prompts(), cwd: "/repo" }));
    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    const backendRefs = messages.filter((message) => message.type === "backend_ref") as Extract<HarnessMessage, { type: "backend_ref" }>[];
    assert.equal(completions.length, 2);
    assert.equal(backendRefs.length, 1);
    assert.equal(backendRefs[0]?.ref.conversationId, "ses_test");
    assert.equal(completions.every((completion) => completion.data.success), true);
    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/session/ses_test/prompt_async");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { parts: [{ type: "text", text: "first" }] },
      { parts: [{ type: "text", text: "second" }] },
    ]);
  });

  it("reopens the event stream after it closes between turns", async () => {
    const mock = new MockOpenCodeServer();
    mock.waitMode = "defer";
    const nextPrompt = Promise.withResolvers<void>();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    async function* prompts(): AsyncGenerator<unknown> {
      yield { type: "user", text: "first" };
      await nextPrompt.promise;
      yield { type: "user", text: "second" };
    }

    const session = harness.launch({ prompt: prompts(), cwd: "/repo" });
    const iterator = session.messages[Symbol.asyncIterator]();
    const seen: HarnessMessage[] = [];
    await waitForRequest(mock, "/session/ses_test/prompt_async");
    mock.resolveWait();
    while (true) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      seen.push(next.value);
      if (next.value.type === "run_completed") break;
    }

    mock.closeStream();
    await new Promise((resolve) => setTimeout(resolve, 0));
    nextPrompt.resolve();
    await waitForRequestCount(mock, "/event", 2);
    await waitForRequestCount(mock, "/session/ses_test/prompt_async", 2);
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "per_second",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: [],
      },
    });

    while (!seen.some((message) => message.type === "pending_input")) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      seen.push(next.value);
    }

    assert.equal(await session.submitPendingInputOption?.(0), true);
    mock.resolveWait();
    for await (const message of iterator) {
      seen.push(message);
    }

    const pending = seen.find((message) => message.type === "pending_input") as Extract<HarnessMessage, { type: "pending_input" }> | undefined;
    const completions = seen.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(pending?.state.requestId, "per_second");
    assert.equal(completions.length, 2);
    assert.equal(mock.requests.filter((request) => request.path === "/event").length, 2);
  });

  it("switches permission mode by patching the classic session endpoint", async () => {
    const mock = new MockOpenCodeServer();
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });
    const session = harness.launch({ prompt: "switch", cwd: "/repo", permissionMode: "plan" });
    await collectMessages(session);

    await session.setPermissionMode?.("bypassPermissions");

    const patch = mock.requests.find((request) => request.method === "PATCH" && request.path === "/session/ses_test");
    assert.deepEqual(patch?.body, {
      permission: [
        { permission: "edit", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "allow" },
        { permission: "external_directory", pattern: "*", action: "allow" },
      ],
    });
  });

  it("does not emit settings changes when active permission patch fails", async () => {
    const mock = new MockOpenCodeServer();
    mock.waitMode = "defer";
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });
    const session = harness.launch({ prompt: "switch", cwd: "/repo", permissionMode: "plan" });
    const iterator = session.messages[Symbol.asyncIterator]();
    const seen: HarnessMessage[] = [];
    await waitForRequest(mock, "/session/ses_test/prompt_async");
    mock.failSessionPatch = true;

    await assert.rejects(
      session.setPermissionMode?.("bypassPermissions"),
      /permission patch failed/,
    );

    const patch = mock.requests.find((request) => request.method === "PATCH" && request.path === "/session/ses_test");
    assert.ok(patch);
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "per_after_failed_patch",
        sessionID: "ses_test",
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: [],
      },
    });

    while (!seen.some((message) => message.type === "pending_input")) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      seen.push(next.value);
    }

    const pending = seen.find((message) => message.type === "pending_input") as Extract<HarnessMessage, { type: "pending_input" }> | undefined;
    assert.equal(pending?.state.requestId, "per_after_failed_patch");
    assert.equal(seen.some((message) => message.type === "settings_changed"), false);
    mock.resolveWait();
    for await (const message of iterator) {
      seen.push(message);
    }
  });
});
