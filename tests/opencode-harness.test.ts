import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
  failQuestionReplies = false;
  private streamController?: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
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

    if (path === "/api/event") {
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
    if (method === "GET" && path === "/api/session/ses_existing/context") return json([]);
    if (method === "GET" && path === "/api/session/ses_test/context") {
      return json([{ type: "assistant", content: [{ type: "text", text: "Final." }] }]);
    }
    if (method === "GET" && path === "/api/session/ses_existing/context") {
      return json([{ type: "assistant", content: [{ type: "text", text: "Resumed." }] }]);
    }
    if (method === "POST" && path.endsWith("/wait")) {
      if (this.waitMode === "defer") {
        return await new Promise<Response>((resolve, reject) => {
          this.deferredWait = { resolve, reject };
          init?.signal?.addEventListener("abort", () => reject(new Error("wait aborted")), { once: true });
        });
      }
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path.endsWith("/prompt")) return json({ type: "assistant", content: [] });
    if (method === "POST" && path.includes("/permission/request/")) return json(true);
    if (method === "POST" && path.includes("/question/request/")) {
      if (this.failQuestionReplies) {
        return new Response(JSON.stringify({ error: "question reply failed" }), { status: 500 });
      }
      return json(true);
    }
    if (method === "PATCH" && path === "/session/ses_test") return json({ id: "ses_test" });
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
  it("creates a session, sends a queued v2 prompt, and emits backend/completion", async () => {
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

    const prompt = mock.requests.find((request) => request.method === "POST" && request.path === "/api/session/ses_test/prompt");
    assert.deepEqual(prompt?.body, {
      prompt: { text: "ship it" },
      delivery: "queue",
    });
    assert.equal(mock.requests.some((request) => request.path === "/api/session/ses_test/wait"), true);

    const ref = messages.find((message) => message.type === "backend_ref") as Extract<HarnessMessage, { type: "backend_ref" }> | undefined;
    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(ref?.ref.kind, "opencode-server");
    assert.equal(ref?.ref.conversationId, "ses_test");
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.result, "Final.");
    assert.equal(mock.closed, true);
  });

  it("streams text deltas and tool calls from v2 events", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/api/event") resolve();
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

  it("maps permission requests to pending input and replies with v2 endpoint", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/api/event") resolve();
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
    const reply = mock.requests.find((request) => request.path === "/api/session/ses_test/permission/request/per_1/reply");
    assert.deepEqual(reply?.body, { response: "once" });
  });

  it("deduplicates permission resolved events when the server echoes the reply", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/api/event") resolve();
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
        if (url.pathname === "/api/event") resolve();
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
        if (url.pathname === "/api/event") resolve();
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
    const reply = mock.requests.find((request) => request.path === "/api/session/ses_test/permission/request/per_auto/reply");
    assert.deepEqual(reply?.body, { response: "once" });
  });

  it("resumes with resume=true on the first prompt", async () => {
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

    const prompt = mock.requests.find((request) => request.method === "POST" && request.path === "/api/session/ses_existing/prompt");
    assert.deepEqual(prompt?.body, {
      prompt: { text: "continue" },
      delivery: "queue",
      resume: true,
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

    const contextRequests = mock.requests.filter((request) => request.method === "GET" && request.path === "/api/session/ses_existing/context");
    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/api/session/ses_existing/prompt");
    assert.equal(contextRequests.length, 3);
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { prompt: { text: "first" }, delivery: "queue", resume: true },
      { prompt: { text: "second" }, delivery: "queue" },
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
    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/api/session/ses_forked/prompt");
    assert.deepEqual(forkRequests.map((request) => request.path), ["/session/ses_existing/fork"]);
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { prompt: { text: "first" }, delivery: "queue" },
      { prompt: { text: "second" }, delivery: "queue" },
    ]);
  });

  it("prepends system prompts because v2 prompt has no system field", async () => {
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

    const prompt = mock.requests.find((request) => request.method === "POST" && request.path === "/api/session/ses_test/prompt");
    assert.deepEqual(prompt?.body, {
      prompt: { text: "Use the project conventions.\n\nimplement" },
      delivery: "queue",
    });
  });

  it("prepends system prompts only to the first multi-turn prompt", async () => {
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

    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/api/session/ses_test/prompt");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { prompt: { text: "Use the project conventions.\n\nfirst" }, delivery: "queue" },
      { prompt: { text: "second" }, delivery: "queue" },
    ]);
  });

  it("emits failed completion from failed session events", async () => {
    const mock = new MockOpenCodeServer();
    const waitForEventStream = new Promise<void>((resolve) => {
      const originalFetch = mock.fetch;
      mock.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname === "/api/event") resolve();
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
        if (url.pathname === "/api/event") resolve();
        return response;
      };
    });
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "fail once", cwd: "/repo" });
    await waitForEventStream;
    await waitForRequest(mock, "/api/session/ses_test/wait");
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
    const originalFetch = mock.fetch;
    mock.fetch = async (input, init) => {
      const responsePromise = originalFetch(input, init);
      const url = new URL(typeof input === "string" ? input : input.url);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api/session/ses_test/context") {
        contextRequested.resolve();
        await releaseContext.promise;
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

  it("does not emit a failed completion after interrupt aborts an active wait", async () => {
    const mock = new MockOpenCodeServer();
    mock.waitMode = "defer";
    const harness = new OpenCodeHarness({
      createServer: async () => mock.handle(),
      fetch: mock.fetch,
    });

    const session = harness.launch({ prompt: "stop", cwd: "/repo" });
    await waitForRequest(mock, "/api/session/ses_test/wait");
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
    await waitForRequest(mock, "/api/session/ses_test/wait");
    await session.interrupt?.();

    const messages = await collectAllMessages(session);
    const completions = messages.filter((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }>[];
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.data.outcome, "interrupted");

    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/api/session/ses_test/prompt");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { prompt: { text: "first" }, delivery: "queue" },
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
    assert.equal(mock.requests.some((request) => request.path === "/session"), false);
    assert.equal(mock.requests.some((request) => request.path === "/api/session/ses_test/prompt"), false);
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

    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/api/session/ses_test/prompt");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { prompt: { text: "first" }, delivery: "queue" },
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
    const promptsSent = mock.requests.filter((request) => request.method === "POST" && request.path === "/api/session/ses_test/prompt");
    assert.deepEqual(promptsSent.map((request) => request.body), [
      { prompt: { text: "first" }, delivery: "queue" },
      { prompt: { text: "second" }, delivery: "queue" },
    ]);
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
});
