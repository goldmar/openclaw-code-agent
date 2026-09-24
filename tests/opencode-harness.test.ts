import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OpenCodeHarness,
  openCodeAgentForMode,
  parseMultiSelectAnswer,
  permissionRulesForMode,
  startOpenCodeServer,
  type OpenCodeServerHandle,
} from "../src/harness/opencode";
import type { HarnessLaunchOptions, HarnessMessage, HarnessSession } from "../src/harness/types";

type RequestRecord = {
  method: string;
  path: string;
  directory?: string;
  body?: any;
};

type MockSession = {
  id: string;
  directory?: string;
  messages: unknown[];
};

/**
 * In-memory OpenCode server: classic JSON routes with `?directory=`, one
 * `/global/event` SSE stream (events wrapped as `{directory, payload}`).
 */
class MockOpenCodeServer {
  requests: RequestRecord[] = [];
  closed = false;
  createCount = 0;
  sessionCost: number | undefined = 0.25;
  /** Automatically answer each prompt and emit busy → idle events. */
  autoComplete = true;
  replyText = "Final.";
  replyError: unknown;
  statuses: Record<string, { type: string }> = {};
  failQuestionReplies = false;
  failSessionPatch = false;
  failRoute?: (method: string, path: string) => Response | Promise<Response> | undefined;
  readonly sessions = new Map<string, MockSession>();
  private nextSession = 0;
  private streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  private readonly encoder = new TextEncoder();
  private exitListeners: Array<(reason: string) => void> = [];

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const directory = url.searchParams.get("directory") ?? undefined;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path, directory, body });

    const override = await this.failRoute?.(method, path);
    if (override) return override;

    if (path === "/global/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.streams.push(controller);
        },
        cancel: () => undefined,
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "POST" && path === "/session") {
      const id = `ses_${++this.nextSession}`;
      this.sessions.set(id, { id, directory, messages: [] });
      return json({ id, directory });
    }
    const forkMatch = /^\/session\/([^/]+)\/fork$/.exec(path);
    if (method === "POST" && forkMatch) {
      const id = `ses_fork_${++this.nextSession}`;
      this.sessions.set(id, { id, directory, messages: [...(this.session(forkMatch[1]).messages)] });
      return json({ id });
    }
    if (method === "GET" && path === "/session/status") return json(this.statuses);
    const messageMatch = /^\/session\/([^/]+)\/message$/.exec(path);
    if (method === "GET" && messageMatch) return json(this.session(messageMatch[1]).messages);
    const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(path);
    if (method === "POST" && promptMatch) {
      const id = promptMatch[1];
      this.session(id).messages.push({ info: { role: "user", id: `msg_user_${this.requests.length}` }, parts: [] });
      if (this.autoComplete) queueMicrotask(() => this.completeTurn(id));
      return new Response(null, { status: 204 });
    }
    const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(path);
    if (method === "POST" && abortMatch) return json(true);
    const sessionMatch = /^\/session\/([^/]+)$/.exec(path);
    if (method === "GET" && sessionMatch) return json({ id: sessionMatch[1], cost: this.sessionCost });
    if (method === "PATCH" && sessionMatch) {
      if (this.failSessionPatch) return new Response(JSON.stringify({ error: "permission patch failed" }), { status: 500 });
      return json({ id: sessionMatch[1] });
    }
    if (method === "POST" && path.startsWith("/permission/") && path.endsWith("/reply")) return json(true);
    if (method === "POST" && path.startsWith("/question/") && path.endsWith("/reply")) {
      if (this.failQuestionReplies) return new Response(JSON.stringify({ error: "question reply failed" }), { status: 500 });
      return json(true);
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${path}` }), { status: 404 });
  };

  session(id: string): MockSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = { id, messages: [] };
      this.sessions.set(id, session);
    }
    return session;
  }

  /** Append an assistant reply and emit the busy → text → idle event sequence. */
  completeTurn(id: string, text = this.replyText): void {
    const created = 1_000 + this.session(id).messages.length * 1_000;
    this.session(id).messages.push({
      info: {
        role: "assistant",
        id: `msg_asst_${this.session(id).messages.length}`,
        providerID: "openai",
        modelID: "gpt-5.5",
        cost: 0.1,
        tokens: { total: 1_600, input: 1_000, output: 200, reasoning: 50, cache: { read: 400, write: 0 } },
        time: { created, completed: created + 750 },
        ...(this.replyError ? { error: this.replyError } : {}),
      },
      parts: [{ type: "text", text }],
    });
    this.emit({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } });
    this.emit({ type: "message.part.delta", properties: { sessionID: id, field: "text", delta: text } });
    this.emit({ type: "session.status", properties: { sessionID: id, status: { type: "idle" } } });
    this.emit({ type: "session.idle", properties: { sessionID: id } });
  }

  emit(payload: unknown, directory = "/repo"): void {
    const frame = this.encoder.encode(`data: ${JSON.stringify({ directory, payload })}\n\n`);
    for (const stream of this.streams) {
      try {
        stream.enqueue(frame);
      } catch {
        // closed stream
      }
    }
  }

  dropStreams(): void {
    for (const stream of this.streams.splice(0)) {
      try {
        stream.close();
      } catch {
        // already closed
      }
    }
  }

  crash(reason = "OpenCode server exited unexpectedly (SIGKILL)."): void {
    this.dropStreams();
    for (const listener of this.exitListeners) listener(reason);
  }

  handle(): OpenCodeServerHandle {
    this.createCount += 1;
    this.closed = false;
    return {
      baseUrl: "http://opencode.test",
      close: async () => {
        this.closed = true;
        this.dropStreams();
      },
      onExit: (listener) => {
        this.exitListeners.push(listener);
      },
    };
  }

  requestsTo(method: string, pattern: RegExp): RequestRecord[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
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

function harnessFor(mock: MockOpenCodeServer, deps: Record<string, unknown> = {}): OpenCodeHarness {
  return new OpenCodeHarness({
    createServer: async () => mock.handle(),
    fetch: mock.fetch,
    serverIdleShutdownMs: 0,
    fallbackPollIntervalMs: 5,
    streamReconnectDelayMs: 5,
    ...deps,
  });
}

/** Multi-turn prompt source like Session's MessageStream. */
function promptStream() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(text: string) {
      queue.push({ type: "user", text });
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) yield queue.shift();
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

class Collector {
  readonly messages: HarnessMessage[] = [];
  private waiters: Array<{ predicate: (messages: HarnessMessage[]) => boolean; resolve: () => void }> = [];
  readonly done: Promise<void>;

  constructor(readonly session: HarnessSession) {
    this.done = (async () => {
      for await (const message of session.messages) {
        this.messages.push(message);
        this.check();
      }
      this.check();
    })();
  }

  private check(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(this.messages)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  async until(predicate: (messages: HarnessMessage[]) => boolean, label = "condition", timeoutMs = 2_000): Promise<void> {
    if (predicate(this.messages)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}; saw ${this.messages.map((m) => m.type).join(",")}`)), timeoutMs);
      this.waiters.push({ predicate, resolve: () => { clearTimeout(timer); resolve(); } });
    });
  }

  completions() {
    return this.messages.filter((message): message is Extract<HarnessMessage, { type: "run_completed" }> => message.type === "run_completed");
  }

  async untilCompletions(count: number): Promise<void> {
    await this.until((messages) => messages.filter((message) => message.type === "run_completed").length >= count, `${count} completion(s)`);
  }

  pending() {
    return this.messages.filter((message): message is Extract<HarnessMessage, { type: "pending_input" }> => message.type === "pending_input");
  }
}

function launch(harness: OpenCodeHarness, options: Partial<HarnessLaunchOptions> = {}) {
  const stream = promptStream();
  const session = harness.launch({ prompt: stream, cwd: "/repo", ...options });
  return { stream, session, collector: new Collector(session) };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function installFakeOpenCodeServer(script: string, dir = mkdtempSync(join(tmpdir(), "openclaw-opencode-test-"))): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode");
  writeFileSync(file, `#!/usr/bin/env node\n${script}`);
  chmodSync(file, 0o755);
  return file;
}

async function withOpenCodeCommand<T>(command: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_OPENCODE_COMMAND;
  process.env.OPENCLAW_OPENCODE_COMMAND = command;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_OPENCODE_COMMAND;
    else process.env.OPENCLAW_OPENCODE_COMMAND = previous;
  }
}

describe("OpenCodeHarness static properties", () => {
  const h = new OpenCodeHarness();

  it("exposes the OpenCode backend contract", () => {
    assert.equal(h.name, "opencode");
    assert.equal(h.backendKind, "opencode-server");
    assert.deepEqual([...h.supportedPermissionModes], ["default", "plan", "bypassPermissions"]);
    assert.equal(h.capabilities.nativePendingInput, true);
    assert.equal(h.capabilities.nativePlanArtifacts, false);
    assert.equal(h.capabilities.nativePlanDecisions, true);
    assert.equal(h.capabilities.worktrees, "plugin-managed");
  });

  it("builds user messages without a session id", () => {
    assert.deepEqual(h.buildUserMessage("hello", "ses_1"), { type: "user", text: "hello" });
  });

  it("maps permission modes to built-in agents and a minimal permission overlay", () => {
    assert.equal(openCodeAgentForMode("plan"), "plan");
    assert.equal(openCodeAgentForMode("default"), "build");
    assert.equal(openCodeAgentForMode("bypassPermissions"), "build");
    assert.deepEqual(permissionRulesForMode("plan"), [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ]);
    assert.ok(permissionRulesForMode("default").every((rule) => rule.action === "ask"));
    assert.ok(permissionRulesForMode("bypassPermissions").every((rule) => rule.action === "allow"));
    assert.deepEqual(permissionRulesForMode("default").map((rule) => rule.permission), ["edit", "bash", "task", "todowrite", "external_directory"]);
  });

  it("parses multi-select answers from labels or option numbers", () => {
    const question = {
      id: "sizes",
      question: "Sizes?",
      multiSelect: true,
      options: [{ label: "Small", value: "S" }, { label: "Medium" }, { label: "Large", value: "L" }],
    };
    assert.deepEqual(parseMultiSelectAnswer(question, "1, large\nMedium, custom"), ["S", "L", "Medium", "custom"]);
  });
});

describe("OpenCodeHarness turns on the shared server", () => {
  it("creates a directory-scoped session, prompts the build agent, and completes on SSE idle", async () => {
    const mock = new MockOpenCodeServer();
    const { stream, collector } = launch(harnessFor(mock), {
      cwd: "/work/repo",
      model: "openai/gpt-5.5",
      reasoningEffort: "high",
      permissionMode: "default",
    });
    stream.push("Do the task");
    await collector.untilCompletions(1);

    const [create] = mock.requestsTo("POST", /^\/session$/);
    assert.equal(create?.directory, "/work/repo");
    assert.deepEqual(create?.body.model, { id: "gpt-5.5", providerID: "openai" });
    assert.deepEqual(create?.body.permission, permissionRulesForMode("default"));
    const [prompt] = mock.requestsTo("POST", /\/prompt_async$/);
    assert.equal(prompt?.directory, "/work/repo");
    assert.equal(prompt?.body.agent, "build");
    assert.equal(prompt?.body.variant, "high");
    assert.deepEqual(prompt?.body.model, { providerID: "openai", modelID: "gpt-5.5" });
    assert.ok(mock.requests.every((request) => request.path === "/global/event" || request.directory === "/work/repo"));

    const [completion] = collector.completions();
    assert.equal(completion?.data.success, true);
    assert.equal(completion?.data.result, "Final.");
    assert.equal(completion?.data.session_id, "ses_1");
    assert.equal(completion?.data.total_cost_usd, 0.25, "session record cost wins");
    assert.equal(completion?.data.duration_ms, 750, "duration comes from the assistant records");
    assert.deepEqual(completion?.data.usage?.models, [{
      model: "openai/gpt-5.5",
      costUsd: 0.1,
      inputTokens: 1_000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    }]);
    assert.equal(completion?.data.usage?.contextTokens, 1_600);
    assert.ok(collector.messages.some((message) => message.type === "backend_ref" && message.ref.conversationId === "ses_1"));
    assert.ok(collector.messages.some((message) => message.type === "text_delta" && message.text === "Final."));
    assert.equal(mock.requestsTo("GET", /^\/session\/status$/).length, 0, "no status polling while the stream is healthy");
    stream.end();
    await collector.done;
    assert.equal(mock.closed, true);
  });

  it("falls back to summed message costs when the session record has no cost", async () => {
    const mock = new MockOpenCodeServer();
    mock.sessionCost = undefined;
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("go");
    await collector.untilCompletions(1);
    assert.equal(collector.completions()[0]?.data.total_cost_usd, 0.1);
    stream.end();
    await collector.done;
  });

  it("uses the read-only plan agent in plan mode and switches to build after approval", async () => {
    const mock = new MockOpenCodeServer();
    const { stream, session, collector } = launch(harnessFor(mock), { permissionMode: "plan" });
    stream.push("Plan it");
    await collector.untilCompletions(1);
    assert.deepEqual(mock.requestsTo("POST", /^\/session$/)[0]?.body.permission, permissionRulesForMode("plan"));
    assert.equal(mock.requestsTo("POST", /\/prompt_async$/)[0]?.body.agent, "plan");

    await session.setPermissionMode?.("bypassPermissions");
    const [patch] = mock.requestsTo("PATCH", /^\/session\/ses_1$/);
    assert.deepEqual(patch?.body.permission, permissionRulesForMode("bypassPermissions"));
    await collector.until(
      (messages) => messages.some((message) => message.type === "settings_changed" && message.permissionMode === "bypassPermissions"),
      "settings change",
    );

    stream.push("Approved. Go ahead.");
    await collector.untilCompletions(2);
    assert.equal(mock.requestsTo("POST", /\/prompt_async$/)[1]?.body.agent, "build");
    stream.end();
    await collector.done;
  });

  it("does not emit settings changes when the permission patch fails", async () => {
    const mock = new MockOpenCodeServer();
    mock.failSessionPatch = true;
    const { stream, session, collector } = launch(harnessFor(mock), { permissionMode: "plan" });
    stream.push("Plan it");
    await collector.untilCompletions(1);
    await assert.rejects(() => session.setPermissionMode!("bypassPermissions"), /permission patch failed/);
    assert.equal(collector.messages.some((message) => message.type === "settings_changed"), false);
    stream.end();
    await collector.done;
  });

  it("stores permission mode changes before startup without starting OpenCode", async () => {
    const mock = new MockOpenCodeServer();
    const harness = harnessFor(mock);
    const { stream, session, collector } = launch(harness, { permissionMode: "plan" });
    await session.setPermissionMode?.("bypassPermissions");
    assert.equal(mock.createCount, 0);
    stream.push("go");
    await collector.untilCompletions(1);
    assert.deepEqual(mock.requestsTo("POST", /^\/session$/)[0]?.body.permission, permissionRulesForMode("bypassPermissions"));
    assert.equal(mock.requestsTo("POST", /\/prompt_async$/)[0]?.body.agent, "build");
    stream.end();
    await collector.done;
  });

  it("sends the system prompt only on the first prompt", async () => {
    const mock = new MockOpenCodeServer();
    const { stream, collector } = launch(harnessFor(mock), { systemPrompt: "  Stay in the worktree.  " });
    stream.push("one");
    await collector.untilCompletions(1);
    stream.push("two");
    await collector.untilCompletions(2);
    const prompts = mock.requestsTo("POST", /\/prompt_async$/);
    assert.equal(prompts[0]?.body.system, "Stay in the worktree.");
    assert.equal(Object.hasOwn(prompts[1]?.body ?? {}, "system"), false);
    stream.end();
    await collector.done;
  });

  it("confirms an idle event that arrives without turn activity before completing", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    mock.statuses = { ses_1: { type: "busy" } };
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("go");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    // A stale idle with no new assistant message must not complete the turn.
    mock.emit({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await waitFor(() => mock.requestsTo("GET", /^\/session\/status$/).length >= 1, "idle confirmation");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(collector.completions().length, 0);

    mock.statuses = {};
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    assert.equal(collector.completions()[0]?.data.success, true);
    stream.end();
    await collector.done;
  });

  it("fails the turn from session.error events", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("go");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.emit({ type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "Provider rejected the request" } } } });
    await collector.untilCompletions(1);
    const [completion] = collector.completions();
    assert.equal(completion?.data.success, false);
    assert.equal(completion?.data.outcome, "failed");
    assert.equal(completion?.data.result, "Provider rejected the request");
    stream.end();
    await collector.done;
  });

  it("fails a completed turn whose last assistant record carries an error", async () => {
    const mock = new MockOpenCodeServer();
    mock.replyError = { name: "ProviderAuthError", data: { message: "Token refresh failed: 401" } };
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("go");
    await collector.untilCompletions(1);
    assert.equal(collector.completions()[0]?.data.outcome, "failed");
    assert.equal(collector.completions()[0]?.data.result, "Token refresh failed: 401");
    stream.end();
    await collector.done;
  });

  it("streams text deltas and reports each tool call once with its input", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("go");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    const toolPart = (status: string, input: unknown) => ({
      type: "message.part.updated",
      properties: { part: { sessionID: "ses_1", type: "tool", tool: "bash", callID: "call_1", state: { status, input } } },
    });
    mock.emit(toolPart("pending", {}));
    mock.emit(toolPart("running", { command: "ls" }));
    mock.emit(toolPart("completed", { command: "ls" }));
    mock.emit({ type: "message.part.delta", properties: { sessionID: "ses_1", field: "reasoning", delta: "hidden" } });
    mock.emit({ type: "message.part.delta", properties: { sessionID: "ses_1", field: "text", delta: "visible" } });
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    const tools = collector.messages.filter((message) => message.type === "tool_call");
    assert.deepEqual(tools, [{ type: "tool_call", name: "bash", input: { command: "ls" } }]);
    const texts = collector.messages.filter((message) => message.type === "text_delta").map((message) => message.type === "text_delta" ? message.text : "");
    assert.deepEqual(texts, ["visible", "Final."]);
    stream.end();
    await collector.done;
  });

  it("normalizes numbered v2 sync event names", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("go");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.emit({ type: "sync", name: "session.next.text.delta.1", data: { sessionID: "ses_1", delta: "v2 text" } });
    mock.emit({ type: "sync", name: "session.next.tool.called.1", data: { sessionID: "ses_1", tool: "read", input: { path: "a" } } });
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    assert.ok(collector.messages.some((message) => message.type === "text_delta" && message.text === "v2 text"));
    assert.ok(collector.messages.some((message) => message.type === "tool_call" && message.name === "read"));
    stream.end();
    await collector.done;
  });

  it("rejects HTML 200 responses instead of accepting the OpenCode app shell as JSON", async () => {
    const mock = new MockOpenCodeServer();
    mock.failRoute = (method, path) => (method === "POST" && path === "/session" ? htmlShell() : undefined);
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("go");
    await collector.untilCompletions(1);
    assert.equal(collector.completions()[0]?.data.success, false);
    assert.match(collector.completions()[0]?.data.result ?? "", /expected JSON API response but received content-type text\/html.*OpenCode web UI HTML app shell/);
    stream.end();
    await collector.done;
  });

  it("times out a turn that never becomes idle", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, collector } = launch(harnessFor(mock, { turnTimeoutMs: 30 }));
    stream.push("go");
    await collector.untilCompletions(1);
    assert.match(collector.completions()[0]?.data.result ?? "", /Timed out waiting for OpenCode session ses_1 to become idle after 30ms/);
    stream.end();
    await collector.done;
  });
});

describe("OpenCodeHarness shared server lifecycle", () => {
  it("shares one server across concurrent sessions and demultiplexes events by session", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const harness = harnessFor(mock);
    const a = launch(harness, { cwd: "/repo-a" });
    const b = launch(harness, { cwd: "/repo-b" });
    a.stream.push("task a");
    b.stream.push("task b");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 2, "both prompts");
    assert.equal(mock.createCount, 1, "one shared server");
    assert.equal(mock.requestsTo("GET", /^\/global\/event$/).length, 1, "one shared event stream");
    const createDirs = mock.requestsTo("POST", /^\/session$/).map((request) => request.directory).sort();
    assert.deepEqual(createDirs, ["/repo-a", "/repo-b"]);

    const sessionFor = (dir: string) => [...mock.sessions.values()].find((session) => session.directory === dir)!.id;
    mock.completeTurn(sessionFor("/repo-b"), "B done");
    await b.collector.untilCompletions(1);
    assert.equal(a.collector.completions().length, 0, "events for another session are ignored");
    assert.equal(b.collector.completions()[0]?.data.result, "B done");

    b.stream.end();
    await b.collector.done;
    assert.equal(mock.closed, false, "server stays up while a session holds it");
    mock.completeTurn(sessionFor("/repo-a"), "A done");
    await a.collector.untilCompletions(1);
    a.stream.end();
    await a.collector.done;
    assert.equal(mock.closed, true, "last session releases the server");
  });

  it("keeps the shared server warm for the idle-shutdown window", async () => {
    const mock = new MockOpenCodeServer();
    const harness = harnessFor(mock, { serverIdleShutdownMs: 40 });
    const first = launch(harness);
    first.stream.push("one");
    await first.collector.untilCompletions(1);
    first.stream.end();
    await first.collector.done;
    assert.equal(mock.closed, false);

    const second = launch(harness);
    second.stream.push("two");
    await second.collector.untilCompletions(1);
    assert.equal(mock.createCount, 1, "a session within the window reuses the server");
    second.stream.end();
    await second.collector.done;
    await waitFor(() => mock.closed, "idle shutdown");
  });

  it("falls back to status polling while the event stream is disconnected", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    mock.statuses = { ses_1: { type: "busy" } };
    let blockStream = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (blockStream && url.pathname === "/global/event") {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return await mock.fetch(input, init);
    };
    const { stream, collector } = launch(harnessFor(mock, { fetch: fetchImpl }));
    stream.push("go");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    blockStream = true;
    mock.dropStreams();
    await waitFor(() => mock.requestsTo("GET", /^\/session\/status$/).length >= 2, "fallback polling");
    assert.equal(collector.completions().length, 0, "busy status keeps waiting");

    // The turn finishes while no events can be delivered.
    mock.session("ses_1").messages.push({ info: { role: "assistant", id: "late" }, parts: [{ type: "text", text: "Finished offline." }] });
    mock.statuses = {};
    await collector.untilCompletions(1);
    assert.equal(collector.completions()[0]?.data.result, "Finished offline.");
    stream.end();
    await collector.done;
  });

  it("fails in-flight turns when the server dies and restarts it for the next turn", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("first");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.crash("OpenCode server exited unexpectedly (SIGKILL).");
    await collector.untilCompletions(1);
    const [failed] = collector.completions();
    assert.equal(failed?.data.success, false);
    assert.match(failed?.data.result ?? "", /OpenCode server exited unexpectedly \(SIGKILL\)\..*session can continue in a new turn/);

    mock.autoComplete = true;
    stream.push("second");
    await collector.untilCompletions(2);
    assert.equal(mock.createCount, 2, "a fresh server starts for the next turn");
    assert.equal(mock.requestsTo("POST", /^\/session$/).length, 1, "the OpenCode session continues");
    assert.equal(collector.completions()[1]?.data.success, true);
    stream.end();
    await collector.done;
  });

  it("interrupts only the in-flight turn and keeps accepting prompts", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, session, collector } = launch(harnessFor(mock));
    stream.push("long task");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    await session.interrupt?.();
    await collector.untilCompletions(1);
    assert.equal(collector.completions()[0]?.data.outcome, "interrupted");
    assert.equal(mock.requestsTo("POST", /\/abort$/).length, 1);

    mock.autoComplete = true;
    stream.push("redirected task");
    await collector.untilCompletions(2);
    assert.equal(collector.completions()[1]?.data.success, true);
    stream.end();
    await collector.done;
  });

  it("releases the server and stops on close", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, session, collector } = launch(harnessFor(mock));
    stream.push("go");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    await session.close?.();
    assert.equal(mock.closed, true);
    stream.end();
    await collector.done;
    assert.ok(collector.completions().every((completion) => completion.data.success === false));
  });

  it("interrupts startup before session creation when the launch is aborted", async () => {
    const mock = new MockOpenCodeServer();
    const serverRequested = Promise.withResolvers<void>();
    let releaseServer!: () => void;
    const serverGate = new Promise<void>((resolve) => { releaseServer = resolve; });
    const abortController = new AbortController();
    const harness = new OpenCodeHarness({
      createServer: async () => {
        serverRequested.resolve();
        await serverGate;
        return mock.handle();
      },
      fetch: mock.fetch,
      serverIdleShutdownMs: 0,
    });
    const { stream, collector } = launch(harness, { abortController });
    stream.push("go");
    await serverRequested.promise;
    abortController.abort();
    releaseServer();
    stream.end();
    await collector.done;
    assert.equal(mock.requestsTo("POST", /^\/session$/).length, 0);
    const completion = collector.completions()[0];
    if (completion) assert.equal(completion.data.success, false);
  });

  it("shuts down a server whose only waiting launch was cancelled during startup", async () => {
    const mock = new MockOpenCodeServer();
    const serverRequested = Promise.withResolvers<void>();
    let releaseServer!: () => void;
    const serverGate = new Promise<void>((resolve) => { releaseServer = resolve; });
    const abortController = new AbortController();
    const harness = new OpenCodeHarness({
      createServer: async () => {
        serverRequested.resolve();
        await serverGate;
        return mock.handle();
      },
      fetch: mock.fetch,
      serverIdleShutdownMs: 0,
    });
    const { stream, collector } = launch(harness, { abortController });
    stream.push("go");
    await serverRequested.promise;
    abortController.abort();
    stream.end();
    await collector.done;
    releaseServer();
    await waitFor(() => mock.closed, "orphaned server shutdown");
    assert.equal(mock.createCount, 1);
  });

  it("reports the OpenCode route that times out during session creation", async () => {
    const mock = new MockOpenCodeServer();
    mock.failRoute = (method, path) => (method === "POST" && path === "/session"
      ? new Promise<Response>(() => undefined)
      : undefined);
    const { stream, collector } = launch(harnessFor(mock, { requestTimeoutMs: 5 }));
    stream.push("go");
    await collector.untilCompletions(1);
    assert.match(collector.completions()[0]?.data.result ?? "", /OpenCode POST \/session timed out after 5ms/);
    assert.equal(collector.messages.some((message) => message.type === "backend_ref"), false);
    stream.end();
    await collector.done;
  });
});

describe("OpenCodeHarness resume and fork", () => {
  it("validates a resumed session once and reuses it across turns", async () => {
    const mock = new MockOpenCodeServer();
    mock.session("ses_existing").directory = "/repo";
    const { stream, collector } = launch(harnessFor(mock), { resumeSessionId: "ses_existing" });
    stream.push("one");
    await collector.untilCompletions(1);
    stream.push("two");
    await collector.untilCompletions(2);
    assert.equal(mock.requestsTo("POST", /^\/session$/).length, 0);
    assert.equal(mock.requestsTo("POST", /^\/session\/ses_existing\/prompt_async$/).length, 2);
    assert.ok(collector.messages.some((message) => message.type === "backend_ref" && message.ref.conversationId === "ses_existing"));
    stream.end();
    await collector.done;
  });

  it("forks a resumed session once and continues on the fork", async () => {
    const mock = new MockOpenCodeServer();
    const { stream, collector } = launch(harnessFor(mock), { resumeSessionId: "ses_existing", forkSession: true });
    stream.push("one");
    await collector.untilCompletions(1);
    stream.push("two");
    await collector.untilCompletions(2);
    assert.equal(mock.requestsTo("POST", /\/fork$/).length, 1);
    const forkId = collector.completions()[0]?.data.session_id;
    assert.match(forkId ?? "", /^ses_fork_/);
    assert.equal(mock.requestsTo("POST", new RegExp(`^/session/${forkId}/prompt_async$`)).length, 2);
    stream.end();
    await collector.done;
  });
});

describe("OpenCodeHarness pending input", () => {
  it("maps permission requests to pending input and replies on the directory-scoped route", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, session, collector } = launch(harnessFor(mock), { permissionMode: "default" });
    stream.push("go");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.emit({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["rm -rf build"] } });
    await collector.until((messages) => messages.some((message) => message.type === "pending_input"), "permission prompt");
    const [pending] = collector.pending();
    assert.equal(pending?.state.kind, "approval");
    assert.deepEqual(pending?.state.options, ["Allow once", "Always allow", "Reject"]);
    assert.match(pending?.state.promptText ?? "", /bash permission for rm -rf build/);

    assert.equal(await session.submitPendingInputOption?.(1, { requestId: "per_1" }), true);
    const [reply] = mock.requestsTo("POST", /^\/permission\/per_1\/reply$/);
    assert.deepEqual(reply?.body, { reply: "always" });
    assert.equal(reply?.directory, "/repo");
    mock.emit({ type: "permission.replied", properties: { sessionID: "ses_1", requestID: "per_1" } });
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    assert.equal(collector.messages.filter((message) => message.type === "pending_input_resolved").length, 1, "echoed reply is deduplicated");
    stream.end();
    await collector.done;
  });

  it("auto-approves permission requests in bypassPermissions mode", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, collector } = launch(harnessFor(mock), { permissionMode: "bypassPermissions" });
    stream.push("go");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.emit({ type: "permission.asked", properties: { id: "per_2", sessionID: "ses_1", permission: "edit" } });
    await waitFor(() => mock.requestsTo("POST", /^\/permission\/per_2\/reply$/).length === 1, "auto reply");
    assert.deepEqual(mock.requestsTo("POST", /^\/permission\/per_2\/reply$/)[0]?.body, { reply: "once" });
    assert.equal(collector.pending().length, 0);
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    stream.end();
    await collector.done;
  });

  it("answers multi-question requests with one answer array per question", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, session, collector } = launch(harnessFor(mock));
    stream.push("ask me");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.emit({
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID: "ses_1",
        questions: [
          { question: "Pick a color", header: "Color", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
          { question: "Pick sizes", header: "Sizes", options: [{ label: "S" }, { label: "M" }, { label: "L" }], multiple: true },
          { question: "Anything else?", header: "Notes", options: [], custom: true },
        ],
      },
    });
    await collector.until((messages) => messages.some((message) => message.type === "pending_input"), "question");
    const first = collector.pending()[0]!.state;
    assert.equal(first.activeQuestionIndex, 0);
    assert.deepEqual(first.options, ["Red", "Blue"]);
    assert.equal(first.questions?.[1]?.multiSelect, true);
    assert.equal(first.questions?.[1]?.allowsFreeText, true);

    assert.equal(await session.submitPendingInputOption?.(1, { requestId: "que_1" }), true);
    await collector.until(() => collector.pending().length === 2, "second question");
    assert.equal(collector.pending()[1]?.state.activeQuestionIndex, 1);
    assert.equal(mock.requestsTo("POST", /^\/question\//).length, 0, "no reply until every question is answered");

    assert.equal(await session.submitPendingInputText?.("1, L"), true);
    await collector.until(() => collector.pending().length === 3, "third question");
    assert.equal(await session.submitPendingInputText?.("Ship it Friday"), true);

    const [reply] = mock.requestsTo("POST", /^\/question\/que_1\/reply$/);
    assert.deepEqual(reply?.body, { answers: [["Blue"], ["S", "L"], ["Ship it Friday"]] });
    assert.equal(reply?.directory, "/repo");
    mock.emit({ type: "question.replied", properties: { sessionID: "ses_1", requestID: "que_1" } });
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    assert.equal(collector.messages.filter((message) => message.type === "pending_input_resolved").length, 1);
    stream.end();
    await collector.done;
  });

  it("submits structured option values for single questions", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, session, collector } = launch(harnessFor(mock));
    stream.push("ask");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.emit({
      type: "question.asked",
      properties: {
        id: "que_2",
        sessionID: "ses_1",
        questions: [{ question: "Policy source?", options: [{ label: "Plugin store", value: "plugin_store" }, { label: "Local" }] }],
      },
    });
    await collector.until(() => collector.pending().length === 1, "question");
    assert.equal(await session.submitPendingInputOption?.(0), true);
    assert.deepEqual(mock.requestsTo("POST", /^\/question\/que_2\/reply$/)[0]?.body, { answers: [["plugin_store"]] });
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    stream.end();
    await collector.done;
  });

  it("routes a prompt that arrives while a question is pending to the question", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("ask");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.emit({ type: "question.asked", properties: { id: "que_3", sessionID: "ses_1", question: "Which branch?" } });
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    stream.push("main");
    await waitFor(() => mock.requestsTo("POST", /^\/question\/que_3\/reply$/).length === 1, "question reply");
    assert.deepEqual(mock.requestsTo("POST", /^\/question\/que_3\/reply$/)[0]?.body, { answers: [["main"]] });
    assert.equal(mock.requestsTo("POST", /\/prompt_async$/).length, 1, "the answer is not sent as a new prompt");
    stream.end();
    await collector.done;
  });

  it("emits a failed completion when an inline question reply fails", async () => {
    const mock = new MockOpenCodeServer();
    mock.autoComplete = false;
    mock.failQuestionReplies = true;
    const { stream, collector } = launch(harnessFor(mock));
    stream.push("ask");
    await waitFor(() => mock.requestsTo("POST", /\/prompt_async$/).length === 1, "prompt");
    mock.emit({ type: "question.asked", properties: { id: "que_4", sessionID: "ses_1", question: "Which branch?" } });
    mock.completeTurn("ses_1");
    await collector.untilCompletions(1);
    stream.push("main");
    await collector.untilCompletions(2);
    assert.equal(collector.completions()[1]?.data.success, false);
    assert.match(collector.completions()[1]?.data.result ?? "", /question reply failed/);
    await collector.done;
  });
});

describe("startOpenCodeServer", () => {
  it("starts `opencode serve --port 0` and reads the bound URL from stdout", async () => {
    const command = installFakeOpenCodeServer(`
console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.");
console.log("opencode server listening on http://127.0.0.1:43123");
console.error(JSON.stringify(process.argv.slice(2)));
setInterval(() => {}, 1000);
`);
    await withOpenCodeCommand(command, async () => {
      const handle = await startOpenCodeServer({ startupTimeoutMs: 5_000 });
      try {
        assert.equal(handle.baseUrl, "http://127.0.0.1:43123");
      } finally {
        await handle.close();
      }
    });
    rmSync(dirname(command), { recursive: true, force: true });
  });

  it("fails with a readiness diagnostic when the listening line never appears", async () => {
    const command = installFakeOpenCodeServer(`console.log("booting"); setInterval(() => {}, 1000);`);
    await withOpenCodeCommand(command, async () => {
      await assert.rejects(
        () => startOpenCodeServer({ startupTimeoutMs: 1_500 }),
        (error: Error) => {
          assert.match(error.message, /Timed out waiting for OpenCode server readiness after 1500ms/);
          assert.match(error.message, /Command: .*opencode serve --hostname 127\.0\.0\.1 --port 0 --print-logs/);
          assert.match(error.message, /Output:\nbooting/);
          assert.match(error.message, /PATH:/);
          return true;
        },
      );
    });
    rmSync(dirname(command), { recursive: true, force: true });
  });

  it("reports an early exit before readiness", async () => {
    const command = installFakeOpenCodeServer(`console.error("config invalid"); process.exit(3);`);
    await withOpenCodeCommand(command, async () => {
      await assert.rejects(() => startOpenCodeServer({ startupTimeoutMs: 5_000 }), /exited before readiness \(code 3\).*config invalid/s);
    });
    rmSync(dirname(command), { recursive: true, force: true });
  });

  it("notifies exit listeners when the server dies after readiness", async () => {
    const command = installFakeOpenCodeServer(`
console.log("opencode server listening on http://127.0.0.1:43124");
setTimeout(() => process.exit(9), 50);
`);
    await withOpenCodeCommand(command, async () => {
      const handle = await startOpenCodeServer({ startupTimeoutMs: 5_000 });
      const reason = await new Promise<string>((resolve) => handle.onExit?.(resolve));
      assert.match(reason, /OpenCode server exited unexpectedly \(code 9\)/);
    });
    rmSync(dirname(command), { recursive: true, force: true });
  });

  it("resolves OpenCode from a Homebrew bin next to a Gateway node opt path", async () => {
    const previousPath = process.env.PATH;
    const previousCommand = process.env.OPENCLAW_OPENCODE_COMMAND;
    const prefix = mkdtempSync(join(tmpdir(), "openclaw-opencode-prefix-"));
    installFakeOpenCodeServer(`console.log("not ready"); setInterval(() => {}, 1000);`, join(prefix, "bin"));
    mkdirSync(join(prefix, "opt", "node", "bin"), { recursive: true });
    delete process.env.OPENCLAW_OPENCODE_COMMAND;
    process.env.PATH = join(prefix, "opt", "node", "bin");
    try {
      await assert.rejects(
        () => startOpenCodeServer({ startupTimeoutMs: 100 }),
        new RegExp(`Command: ${join(prefix, "bin", "opencode").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(resolved from opencode\\)`),
      );
    } finally {
      process.env.PATH = previousPath;
      if (previousCommand === undefined) delete process.env.OPENCLAW_OPENCODE_COMMAND;
      else process.env.OPENCLAW_OPENCODE_COMMAND = previousCommand;
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it("surfaces startup failures as a failed completion without a backend ref", async () => {
    const command = installFakeOpenCodeServer(`process.exit(1);`);
    await withOpenCodeCommand(command, async () => {
      const harness = new OpenCodeHarness({ startupTimeoutMs: 5_000, serverIdleShutdownMs: 0 });
      const { stream, collector } = launch(harness, { cwd: process.cwd() });
      stream.push("go");
      await collector.untilCompletions(1);
      assert.equal(collector.messages.some((message) => message.type === "backend_ref"), false);
      assert.match(collector.completions()[0]?.data.result ?? "", /exited before readiness/);
      stream.end();
      await collector.done;
    });
    rmSync(dirname(command), { recursive: true, force: true });
  });
});
