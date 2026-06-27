import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHarness, listHarnesses } from "../src/harness/index";
import { CodexHarness, DEFAULT_APP_SERVER_ARGS, DEFAULT_REQUEST_TIMEOUT_MS, isCodexAppServerSessionId } from "../src/harness/codex";
import { StdioJsonRpcClient } from "../src/harness/codex-rpc";
import type { HarnessMessage } from "../src/harness/types";

type NotificationHandler = (method: string, params: unknown) => Promise<void> | void;
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
type ClientSettings = {
  command: string;
  args: string[];
  requestTimeoutMs: number;
};

const CODEX_TIMEOUT_ENV = "OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS";
const VALID_THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";
const CODEX_ARGS_ENV = "OPENCLAW_CODEX_APP_SERVER_ARGS";

class MockJsonRpcClient {
  requests: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
  pendingInputResponses: unknown[] = [];
  private notificationHandler: NotificationHandler = () => undefined;
  private requestHandler: RequestHandler = async () => ({});

  constructor(
    private readonly options: {
      threadId?: string;
      runId?: string;
      threadCwd?: string;
      assistantText?: string;
      finalPlanMarkdown?: string;
      pendingInput?: {
        method: string;
        params: unknown;
      };
      failTurn?: string;
      turnCompletionMethod?: "turn/completed" | "turn/failed" | "turn/cancelled";
      turnStatus?: "completed" | "failed" | "interrupted" | "cancelled";
    } = {},
  ) {}

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async notify(_method: string, _params?: unknown): Promise<void> {}

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.requests.push({ method, params, timeoutMs });

    if (method === "initialize") return {};
    if (method === "thread/start" || method === "thread/new") {
      return {
        threadId: this.options.threadId ?? "thread-123",
        ...(this.options.threadCwd ? { cwd: this.options.threadCwd } : {}),
      };
    }
    if (method === "thread/resume") {
      return {
        threadId: this.options.threadId ?? "thread-resume",
        ...(this.options.threadCwd ? { cwd: this.options.threadCwd } : {}),
      };
    }
    if (method === "turn/interrupt") {
      return {};
    }
    if (method !== "turn/start") {
      return {};
    }

    const threadId = this.options.threadId ?? "thread-123";
    const runId = this.options.runId ?? "turn-1";

    queueMicrotask(async () => {
      if (this.options.pendingInput) {
        const response = await this.requestHandler(this.options.pendingInput.method, this.options.pendingInput.params);
        this.pendingInputResponses.push(response);
        await this.notificationHandler("serverrequest/resolved", {
          threadId,
          turnId: runId,
          requestId: "req-1",
        });
      }

      if (this.options.assistantText) {
        await this.notificationHandler("item/agentmessage/delta", {
          threadId,
          turnId: runId,
          item: { id: "assistant-1", type: "agentMessage", delta: this.options.assistantText },
        });
      }

      if (this.options.finalPlanMarkdown) {
        await this.notificationHandler("turn/plan/updated", {
          threadId,
          turnId: runId,
          plan: {
            explanation: "Implementation plan",
            steps: [{ step: "Update code", status: "pending" }],
          },
        });
        await this.notificationHandler("item/completed", {
          threadId,
          turnId: runId,
          item: { id: "plan-1", type: "plan", text: this.options.finalPlanMarkdown },
        });
      }

      await this.notificationHandler(
        this.options.turnCompletionMethod ?? (this.options.failTurn ? "turn/failed" : "turn/completed"),
        {
          threadId,
          turnId: runId,
          turn: this.options.failTurn
            ? { id: runId, status: "failed", error: { message: this.options.failTurn } }
            : { id: runId, status: this.options.turnStatus ?? "completed" },
        },
      );
    });

    return { threadId, turnId: runId };
  }
}

async function withCodexTimeoutEnv<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const original = process.env[CODEX_TIMEOUT_ENV];
  if (value === undefined) {
    delete process.env[CODEX_TIMEOUT_ENV];
  } else {
    process.env[CODEX_TIMEOUT_ENV] = value;
  }
  try {
    return await run();
  } finally {
    if (original === undefined) {
      delete process.env[CODEX_TIMEOUT_ENV];
    } else {
      process.env[CODEX_TIMEOUT_ENV] = original;
    }
  }
}

async function withCodexArgsEnv<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const original = process.env[CODEX_ARGS_ENV];
  if (value === undefined) {
    delete process.env[CODEX_ARGS_ENV];
  } else {
    process.env[CODEX_ARGS_ENV] = value;
  }
  try {
    return await run();
  } finally {
    if (original === undefined) {
      delete process.env[CODEX_ARGS_ENV];
    } else {
      process.env[CODEX_ARGS_ENV] = original;
    }
  }
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

describe("CodexHarness static properties", () => {
  const h = new CodexHarness();

  it("has name 'codex'", () => {
    assert.equal(h.name, "codex");
  });

  it("supports all permission modes", () => {
    assert.ok(h.supportedPermissionModes.includes("default"));
    assert.ok(h.supportedPermissionModes.includes("plan"));
    assert.ok(h.supportedPermissionModes.includes("bypassPermissions"));
  });

  it("exposes native pending-input and plan-artifact capabilities", () => {
    assert.equal(h.capabilities.nativePendingInput, true);
    assert.equal(h.capabilities.nativePlanArtifacts, true);
    assert.equal(h.capabilities.worktrees, "native-restore");
  });
});

describe("CodexHarness.buildUserMessage", () => {
  const h = new CodexHarness();

  it("returns expected structure", () => {
    const msg = h.buildUserMessage("hello", "sess-xyz");
    assert.deepEqual(msg, { type: "user", text: "hello", session_id: "sess-xyz" });
  });
});

describe("harness registry — codex registration", () => {
  it("getHarness('codex') returns CodexHarness", () => {
    const h = getHarness("codex");
    assert.equal(h.name, "codex");
    assert.ok(h instanceof CodexHarness);
  });

  it("listHarnesses includes codex", () => {
    assert.ok(listHarnesses().includes("codex"));
  });
});

describe("Codex App Server RPC diagnostics", () => {
  it("redacts raw process command arguments from spawn diagnostics", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const client = new StdioJsonRpcClient("true", ["--token", "secret-token"], 1234);
      await client.connect();
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      await client.close();

      const joined = warnings.join("\n");
      assert.doesNotMatch(joined, /secret-token/);
      assert.doesNotMatch(joined, /--token/);
      assert.doesNotMatch(joined, /"args"/);
      assert.doesNotMatch(joined, /"command"/);

      const spawn = warnings
        .map((warning) => JSON.parse(warning) as Record<string, unknown>)
        .find((entry) => entry.event === "process.spawn");
      assert.equal(spawn?.component, "CodexAppServerRpc");
      assert.equal(spawn?.commandKind, "custom");
      assert.equal(spawn?.appServerSubcommand, true);
      assert.equal(spawn?.configuredArgCount, 2);
      assert.equal(spawn?.requestTimeoutMs, 1234);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("CodexHarness App Server mapping", () => {
  it("passes configured Codex request timeout to createClient, initialize, thread start, and turn start", async () => {
    await withCodexTimeoutEnv("12345", async () => {
      const client = new MockJsonRpcClient({ assistantText: "Done." });
      const createdSettings: ClientSettings[] = [];
      const harness = new CodexHarness({
        createClient: (settings) => {
          createdSettings.push(settings);
          return client as any;
        },
      });

      await collectMessages(harness.launch({ prompt: "ship it", cwd: "/tmp" }));

      assert.equal(createdSettings[0]?.requestTimeoutMs, 12345);
      assert.equal(client.requests.find((request) => request.method === "initialize")?.timeoutMs, 12345);
      assert.equal(
        client.requests.find((request) => request.method === "thread/start" || request.method === "thread/new")?.timeoutMs,
        12345,
      );
      assert.equal(client.requests.find((request) => request.method === "turn/start")?.timeoutMs, 12345);
    });
  });

  it("passes configured Codex request timeout to thread resume requests", async () => {
    await withCodexTimeoutEnv("23456", async () => {
      const client = new MockJsonRpcClient({ threadId: VALID_THREAD_ID, assistantText: "Resumed." });
      const createdSettings: ClientSettings[] = [];
      const harness = new CodexHarness({
        createClient: (settings) => {
          createdSettings.push(settings);
          return client as any;
        },
      });

      await collectMessages(harness.launch({
        prompt: "continue",
        cwd: "/tmp",
        resumeSessionId: VALID_THREAD_ID,
      }));

      assert.equal(createdSettings[0]?.requestTimeoutMs, 23456);
      assert.equal(client.requests.find((request) => request.method === "thread/resume")?.timeoutMs, 23456);
      assert.equal(client.requests.find((request) => request.method === "turn/start")?.timeoutMs, 23456);
    });
  });

  it("passes configured Codex request timeout to turn interrupt requests", async () => {
    await withCodexTimeoutEnv("34567", async () => {
      const client = new MockJsonRpcClient({
        runId: "turn-pending",
        pendingInput: {
          method: "turn/requestUserInput",
          params: {
            threadId: "thread-123",
            turnId: "turn-pending",
            requestId: "req-1",
            questions: [{
              id: "confirm",
              question: "Interrupt?",
              options: ["Yes", "No"],
            }],
          },
        },
      });
      const harness = new CodexHarness({
        createClient: () => client as any,
      });
      const session = harness.launch({ prompt: "pause here", cwd: "/tmp" });
      const iter = session.messages[Symbol.asyncIterator]();

      let sawPendingInput = false;
      for (let i = 0; i < 8; i += 1) {
        const next = await iter.next();
        if (next.done) break;
        if (next.value.type === "pending_input") {
          sawPendingInput = true;
          await session.interrupt?.();
          break;
        }
      }

      assert.equal(sawPendingInput, true);
      assert.equal(client.requests.find((request) => request.method === "turn/interrupt")?.timeoutMs, 34567);

      assert.equal(await session.submitPendingInputOption?.(0), true);
      for (let i = 0; i < 8; i += 1) {
        const next = await iter.next();
        if (next.done || next.value.type === "run_completed") break;
      }
    });
  });

  it("falls back to default Codex request timeout before creating clients for invalid env values", async () => {
    for (const timeoutValue of ["invalid", "0", "-1"]) {
      await withCodexTimeoutEnv(timeoutValue, async () => {
        const client = new MockJsonRpcClient({ assistantText: "Done." });
        const createdSettings: ClientSettings[] = [];
        const harness = new CodexHarness({
          createClient: (settings) => {
            createdSettings.push(settings);
            return client as any;
          },
        });

        await collectMessages(harness.launch({ prompt: "ship it", cwd: "/tmp" }));

        assert.equal(createdSettings[0]?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
        assert.equal(client.requests.find((request) => request.method === "thread/start")?.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
      });
    }
  });

  it("uses stdio listener args by default for Codex app-server clients", async () => {
    for (const value of [undefined, "", "   "]) {
      await withCodexArgsEnv(value, async () => {
        const client = new MockJsonRpcClient({ assistantText: "Done." });
        const createdSettings: ClientSettings[] = [];
        const harness = new CodexHarness({
          createClient: (settings) => {
            createdSettings.push(settings);
            return client as any;
          },
        });

        await collectMessages(harness.launch({ prompt: "ship it", cwd: "/tmp" }));

        assert.deepEqual(createdSettings[0]?.args, DEFAULT_APP_SERVER_ARGS);
      });
    }
  });

  it("lets explicit Codex app-server args override the stdio defaults", async () => {
    await withCodexArgsEnv("--experimental-foo,--bar", async () => {
      const client = new MockJsonRpcClient({ assistantText: "Done." });
      const createdSettings: ClientSettings[] = [];
      const harness = new CodexHarness({
        createClient: (settings) => {
          createdSettings.push(settings);
          return client as any;
        },
      });

      await collectMessages(harness.launch({ prompt: "ship it", cwd: "/tmp" }));

      assert.deepEqual(createdSettings[0]?.args, ["--experimental-foo", "--bar"]);
    });
  });

  it("redacts sensitive stderr details from Codex app-server timeout errors", () => {
    const client = new StdioJsonRpcClient("codex", DEFAULT_APP_SERVER_ARGS, DEFAULT_REQUEST_TIMEOUT_MS) as any;
    client.stderrTail = [
      "api_key=sk-test-secret1234567890",
      "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      "Authorization: Basic dXNlcjpwYXNz",
      "authorization: ApiKey abc123",
      "OPENAI_API_KEY=sk-prefixed-secret1234567890",
      "GITHUB_TOKEN=ghp_prefixedabcdefghijklmnopqrstuvwxyz123456",
      "ANTHROPIC_AUTH_TOKEN: anthropic-prefixed-secret-value",
      '{"password":"hunter2","secret":"quoted-private-value"}',
      '{"service_api_key":"quoted-prefixed-secret-value"}',
      "database postgres://user:secret@db.example.com/openclaw",
      "cache redis://:password@cache.example.com/0",
      "callback https://alice:hunter2@example.com/path",
      "path /home/alice/projects/private-openclaw/session.log",
      "opaque abcdef1234567890abcdef1234567890",
    ].join("\n");

    const message = client.buildTimeoutErrorMessage("initialize", 120000);

    assert.match(message, /recent stderr:/);
    assert.doesNotMatch(message, /sk-test-secret/);
    assert.doesNotMatch(message, /ghp_abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(message, /dXNlcjpwYXNz/);
    assert.doesNotMatch(message, /abc123/);
    assert.doesNotMatch(message, /sk-prefixed-secret/);
    assert.doesNotMatch(message, /ghp_prefixed/);
    assert.doesNotMatch(message, /anthropic-prefixed-secret-value/);
    assert.doesNotMatch(message, /hunter2/);
    assert.doesNotMatch(message, /quoted-private-value/);
    assert.doesNotMatch(message, /quoted-prefixed-secret-value/);
    assert.doesNotMatch(message, /postgres:\/\/user:secret/);
    assert.doesNotMatch(message, /redis:\/\/:password/);
    assert.doesNotMatch(message, /https:\/\/alice:hunter2/);
    assert.doesNotMatch(message, /\/home\/alice/);
    assert.doesNotMatch(message, /abcdef1234567890abcdef1234567890/);
    assert.match(message, /\[redacted credential\]/);
    assert.match(message, /\[redacted path\]/);
    assert.match(message, /\[redacted token\]/);
  });

  it("emits backend ref, assistant output, and a completed run", async () => {
    const client = new MockJsonRpcClient({ assistantText: "Done." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    const messages = await collectMessages(harness.launch({ prompt: "ship it", cwd: "/tmp" }));
    const ref = messages.find((message) => message.type === "backend_ref") as Extract<HarnessMessage, { type: "backend_ref" }> | undefined;
    const text = messages.find((message) => message.type === "text_delta") as Extract<HarnessMessage, { type: "text_delta" }> | undefined;
    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;

    assert.equal(ref?.ref.kind, "codex-app-server");
    assert.equal(ref?.ref.conversationId, "thread-123");
    assert.equal(text?.text, "Done.");
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.outcome, "completed");
    assert.equal(result?.data.session_id, "thread-123");
  });

  it("resumes an existing thread when resumeSessionId is provided", async () => {
    const client = new MockJsonRpcClient({ threadId: VALID_THREAD_ID, assistantText: "Resumed." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "continue",
      cwd: "/tmp",
      resumeSessionId: VALID_THREAD_ID,
    }));

    assert.equal(client.requests.some((request) => request.method === "thread/resume"), true);
    const resumeRequest = client.requests.find((request) => request.method === "thread/resume");
    assert.equal(Object.hasOwn((resumeRequest?.params as Record<string, unknown>) ?? {}, "cwd"), false);
    const ref = messages.find((message) => message.type === "backend_ref") as Extract<HarnessMessage, { type: "backend_ref" }> | undefined;
    assert.equal(ref?.ref.conversationId, VALID_THREAD_ID);
  });

  it("normalizes accepted Codex App Server resume ids before resuming", async () => {
    const client = new MockJsonRpcClient({ threadId: VALID_THREAD_ID, assistantText: "Resumed." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    await collectMessages(harness.launch({
      prompt: "continue",
      cwd: "/tmp",
      resumeSessionId: `  ${VALID_THREAD_ID}\n`,
    }));

    assert.equal(isCodexAppServerSessionId(`  ${VALID_THREAD_ID}\n`), true);
    const resumeRequest = client.requests.find((request) => request.method === "thread/resume");
    assert.equal((resumeRequest?.params as { threadId?: string } | undefined)?.threadId, VALID_THREAD_ID);
  });

  it("starts a fresh thread instead of sending non-UUID resume ids to Codex App Server", async () => {
    const client = new MockJsonRpcClient({ threadId: VALID_THREAD_ID, assistantText: "Fresh." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "continue",
      cwd: "/tmp",
      resumeSessionId: "ses_plugin_owned_thread",
    }));

    assert.equal(isCodexAppServerSessionId("ses_plugin_owned_thread"), false);
    assert.equal(client.requests.some((request) => request.method === "thread/resume"), false);
    assert.equal(client.requests.some((request) => request.method === "thread/start" || request.method === "thread/new"), true);
    const ref = messages.find((message) => message.type === "backend_ref") as Extract<HarnessMessage, { type: "backend_ref" }> | undefined;
    assert.equal(ref?.ref.conversationId, VALID_THREAD_ID);
  });

  it("passes full-permission Codex execution policy on fresh thread start", async () => {
    const client = new MockJsonRpcClient({ assistantText: "Inspecting." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    await collectMessages(harness.launch({
      prompt: "investigate",
      cwd: "/tmp",
      permissionMode: "plan",
      codexApprovalPolicy: "never",
      reasoningEffort: "xhigh",
      fastMode: true,
    }));

    const startRequest = client.requests.find((request) => request.method === "thread/start" || request.method === "thread/new");
    assert.deepEqual(startRequest?.params, {
      cwd: "/tmp",
      reasoningEffort: "xhigh",
      service_tier: "fast",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const turnStartRequest = client.requests.find((request) => request.method === "turn/start");
    assert.deepEqual(turnStartRequest?.params, {
      threadId: "thread-123",
      input: [{ type: "text", text: "investigate" }],
      service_tier: "fast",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      collaborationMode: {
        mode: "plan",
        settings: {
          reasoningEffort: "xhigh",
          developerInstructions: null,
        },
      },
    });
  });

  it("sends bare Codex runtime model ids in App Server launch payloads", async () => {
    const client = new MockJsonRpcClient({ assistantText: "Inspecting." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    await collectMessages(harness.launch({
      prompt: "investigate",
      cwd: "/tmp",
      model: "openai/gpt-5.5",
      permissionMode: "plan",
    }));

    const startRequest = client.requests.find((request) => request.method === "thread/start" || request.method === "thread/new");
    const turnStartRequest = client.requests.find((request) => request.method === "turn/start");
    assert.equal((startRequest?.params as { model?: string } | undefined)?.model, "gpt-5.5");
    assert.equal((turnStartRequest?.params as { model?: string } | undefined)?.model, "gpt-5.5");
    assert.equal((turnStartRequest?.params as any)?.collaborationMode?.settings?.model, "gpt-5.5");
    assert.doesNotMatch(JSON.stringify([startRequest?.params, turnStartRequest?.params]), /openai\/gpt-5\.5/);
  });

  it("rejects unsupported provider-prefixed Codex model ids before App Server launch", () => {
    const client = new MockJsonRpcClient({ assistantText: "Inspecting." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    assert.throws(
      () => harness.launch({
        prompt: "investigate",
        cwd: "/tmp",
        model: "anthropic/gpt-5.5",
      }),
      /Codex model "anthropic\/gpt-5\.5" is not supported/,
    );
    assert.equal(client.requests.length, 0);
  });

  it("defaults fresh Codex sessions to never approval without falling back to on-request prompts", async () => {
    const client = new MockJsonRpcClient({ assistantText: "Inspecting." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    await collectMessages(harness.launch({
      prompt: "investigate",
      cwd: "/tmp",
      permissionMode: "plan",
    }));

    const startRequest = client.requests.find((request) => request.method === "thread/start" || request.method === "thread/new");
    assert.deepEqual(startRequest?.params, {
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("starts fresh Codex threads in the prepared cwd, not the original repo cwd", async () => {
    const client = new MockJsonRpcClient({ assistantText: "Inspecting." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/repo/openclaw/.worktrees/openclaw-worktree-ship-it",
      originalWorkdir: "/repo/openclaw",
      worktreeStrategy: "ask",
    }));

    const startRequest = client.requests.find((request) => request.method === "thread/start" || request.method === "thread/new");
    assert.equal((startRequest?.params as { cwd?: string } | undefined)?.cwd, "/repo/openclaw/.worktrees/openclaw-worktree-ship-it");
  });

  it("captures native Codex worktree refs from thread state", async () => {
    const client = new MockJsonRpcClient({
      threadId: "thread-worktree",
      threadCwd: "/Users/test/.codex/worktrees/abcd/openclaw",
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/repo/openclaw",
      originalWorkdir: "/repo/openclaw",
      worktreeStrategy: "ask",
    }));
    const ref = messages.find((message) => message.type === "backend_ref") as Extract<HarnessMessage, { type: "backend_ref" }> | undefined;

    assert.equal(ref?.ref.worktreePath, "/Users/test/.codex/worktrees/abcd/openclaw");
    assert.equal(ref?.ref.worktreeId, "abcd");
  });

  it("emits an interrupted outcome for cancelled Codex turns", async () => {
    const client = new MockJsonRpcClient({
      threadId: "thread-interrupt",
      runId: "turn-interrupt",
      turnCompletionMethod: "turn/completed",
      turnStatus: "interrupted",
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    const messages = await collectMessages(harness.launch({ prompt: "redirect", cwd: "/tmp" }));
    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;

    assert.equal(result?.data.success, false);
    assert.equal(result?.data.outcome, "interrupted");
    assert.equal(result?.data.result, undefined);
  });

  it("emits nested structured pending input and resolves button selections", async () => {
    const client = new MockJsonRpcClient({
      pendingInput: {
        method: "turn/requestUserInput",
        params: {
          threadId: "thread-123",
          turnId: "turn-1",
          requestId: "req-1",
          questions: [{
            id: "environment",
            question: "Choose an environment",
            options: ["Staging", "Production"],
          }],
        },
      },
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });
    const session = harness.launch({ prompt: "deploy it", cwd: "/tmp" });
    const iter = session.messages[Symbol.asyncIterator]();

    const seen: HarnessMessage[] = [];
    for (let i = 0; i < 8; i += 1) {
      const next = await iter.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.type === "pending_input") {
        const submitted = await session.submitPendingInputOption?.(1);
        assert.equal(submitted, true);
      }
      if (
        next.value.type === "run_completed"
        && seen.some((message) => message.type === "pending_input_resolved")
      ) {
        break;
      }
    }

    const pending = seen.find((message) => message.type === "pending_input") as Extract<HarnessMessage, { type: "pending_input" }> | undefined;
    const resolved = seen.find((message) => message.type === "pending_input_resolved") as Extract<HarnessMessage, { type: "pending_input_resolved" }> | undefined;
    assert.match(pending?.state.promptText ?? "", /^Choose an environment/);
    assert.match(pending?.state.promptText ?? "", /Options:/);
    assert.deepEqual(pending?.state.options, ["Staging", "Production"]);
    assert.equal(pending?.state.questions?.[0]?.id, "environment");
    assert.equal(Boolean(resolved), true);
    assert.deepEqual(client.pendingInputResponses[0], {
      answers: {
        environment: {
          answers: ["Production"],
        },
      },
    });
  });

  it("logs and rejects top-level-only Codex request_user_input payloads without pending input", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const client = new MockJsonRpcClient({
        pendingInput: {
          method: "turn/requestUserInput",
          params: {
            threadId: "thread-123",
            turnId: "turn-1",
            requestId: "req-1",
            question: "Choose an environment",
            options: ["Staging", "Production"],
          },
        },
      });
      const harness = new CodexHarness({
        createClient: () => client as any,
      });

      const messages = await collectMessages(harness.launch({ prompt: "deploy it", cwd: "/tmp" }));

      assert.equal(messages.some((message) => message.type === "pending_input"), false);
      assert.match(warnings.join("\n"), /Malformed Codex request_user_input payload for req-1: expected non-empty questions\[\]/);
      assert.deepEqual(client.pendingInputResponses[0], {
        error: "Malformed Codex request_user_input payload for req-1: expected non-empty questions[]",
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  it("resolves nested Codex question options as request_user_input answers", async () => {
    const client = new MockJsonRpcClient({
      pendingInput: {
        method: "tool/requestUserInput",
        params: {
          threadId: "thread-123",
          turnId: "turn-1",
          requestId: "req-1",
          questions: [{
            id: "confirm_path",
            header: "Confirm",
            question: "Proceed with the plan?",
            options: [{
              label: "Yes (Recommended)",
              value: "yes",
              description: "Continue the current plan.",
            }, {
              label: "No",
              value: "no",
              description: "Stop and revisit the approach.",
            }],
          }],
        },
      },
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });
    const session = harness.launch({ prompt: "confirm", cwd: "/tmp" });
    const iter = session.messages[Symbol.asyncIterator]();

    const seen: HarnessMessage[] = [];
    for (let i = 0; i < 8; i += 1) {
      const next = await iter.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.type === "pending_input") {
        assert.deepEqual(next.value.state.options, ["Yes (Recommended)", "No"]);
        assert.equal(next.value.state.questions?.[0]?.id, "confirm_path");
        const submitted = await session.submitPendingInputOption?.(0);
        assert.equal(submitted, true);
      }
      if (
        next.value.type === "run_completed"
        && seen.some((message) => message.type === "pending_input_resolved")
      ) {
        break;
      }
    }

    assert.deepEqual(client.pendingInputResponses[0], {
      answers: {
        confirm_path: {
          answers: ["yes"],
        },
      },
    });
  });

  it("queues multiple Codex questions and submits combined answers after the final selection", async () => {
    const client = new MockJsonRpcClient({
      pendingInput: {
        method: "tool/requestUserInput",
        params: {
          threadId: "thread-123",
          turnId: "turn-1",
          requestId: "req-1",
          questions: [{
            id: "environment",
            header: "Environment",
            question: "Which environment should I target?",
            options: [
              { label: "Staging", description: "Use staging credentials." },
              { label: "Production", description: "Use production credentials." },
            ],
          }, {
            id: "scope",
            header: "Scope",
            question: "How broad should the rollout be?",
            multiSelect: true,
            options: [
              { label: "Canary", description: "Start with a small cohort." },
              { label: "Everyone", description: "Roll out to all users." },
            ],
          }],
        },
      },
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });
    const session = harness.launch({ prompt: "deploy", cwd: "/tmp" });
    const iter = session.messages[Symbol.asyncIterator]();

    const seen: HarnessMessage[] = [];
    for (let i = 0; i < 10; i += 1) {
      const next = await iter.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.type === "pending_input" && next.value.state.activeQuestionIndex === 0) {
        assert.deepEqual(next.value.state.options, ["Staging", "Production"]);
        assert.equal(await session.submitPendingInputOption?.(1, {
          requestId: "req-1",
          questionId: "environment",
        }), true);
        assert.deepEqual(client.pendingInputResponses, []);
      } else if (next.value.type === "pending_input" && next.value.state.activeQuestionIndex === 1) {
        assert.deepEqual(next.value.state.options, ["Canary", "Everyone"]);
        assert.match(next.value.state.promptText ?? "", /Reply with one or more option labels\./);
        assert.deepEqual(next.value.state.answers, {
          environment: { answers: ["Production"] },
        });
        assert.equal(await session.submitPendingInputOption?.(0, {
          requestId: "req-1",
          questionId: "scope",
        }), true);
      }
      if (
        next.value.type === "run_completed"
        && seen.some((message) => message.type === "pending_input_resolved")
      ) {
        break;
      }
    }

    assert.deepEqual(client.pendingInputResponses, [{
      answers: {
        environment: { answers: ["Production"] },
        scope: { answers: ["Canary"] },
      },
    }]);
  });

  it("accepts free-text overrides during queued Codex questions without losing earlier answers", async () => {
    const client = new MockJsonRpcClient({
      pendingInput: {
        method: "tool/requestUserInput",
        params: {
          threadId: "thread-123",
          turnId: "turn-1",
          requestId: "req-1",
          questions: [{
            id: "environment",
            header: "Environment",
            question: "Which environment should I target?",
            options: [
              { label: "Staging", description: "Use staging credentials." },
              { label: "Production", description: "Use production credentials." },
            ],
          }, {
            id: "scope",
            header: "Scope",
            question: "How broad should the rollout be?",
            options: [
              { label: "Canary", description: "Start with a small cohort." },
              { label: "Everyone", description: "Roll out to all users." },
            ],
          }],
        },
      },
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });
    const session = harness.launch({ prompt: "deploy", cwd: "/tmp" });
    const iter = session.messages[Symbol.asyncIterator]();

    for (let i = 0; i < 10; i += 1) {
      const next = await iter.next();
      if (next.done) break;
      if (next.value.type === "pending_input" && next.value.state.activeQuestionIndex === 0) {
        assert.equal(await session.submitPendingInputOption?.(0, {
          requestId: "req-1",
          questionId: "environment",
        }), true);
      } else if (next.value.type === "pending_input" && next.value.state.activeQuestionIndex === 1) {
        assert.equal(await session.submitPendingInputText?.("Canary first, then expand after metrics look clean"), true);
      }
      if (next.value.type === "run_completed") break;
    }

    assert.deepEqual(client.pendingInputResponses, [{
      answers: {
        environment: { answers: ["Staging"] },
        scope: { answers: ["Canary first, then expand after metrics look clean"] },
      },
    }]);
  });

  it("rejects stale queued Codex question tokens without corrupting collected answers", async () => {
    const client = new MockJsonRpcClient({
      pendingInput: {
        method: "tool/requestUserInput",
        params: {
          threadId: "thread-123",
          turnId: "turn-1",
          requestId: "req-1",
          questions: [{
            id: "environment",
            header: "Environment",
            question: "Which environment should I target?",
            options: [
              { label: "Staging", description: "Use staging credentials." },
              { label: "Production", description: "Use production credentials." },
            ],
          }, {
            id: "scope",
            header: "Scope",
            question: "How broad should the rollout be?",
            options: [
              { label: "Canary", description: "Start with a small cohort." },
              { label: "Everyone", description: "Roll out to all users." },
            ],
          }],
        },
      },
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });
    const session = harness.launch({ prompt: "deploy", cwd: "/tmp" });
    const iter = session.messages[Symbol.asyncIterator]();

    for (let i = 0; i < 10; i += 1) {
      const next = await iter.next();
      if (next.done) break;
      if (next.value.type === "pending_input" && next.value.state.activeQuestionIndex === 0) {
        assert.equal(await session.submitPendingInputOption?.(1, {
          requestId: "req-1",
          questionId: "environment",
        }), true);
      } else if (next.value.type === "pending_input" && next.value.state.activeQuestionIndex === 1) {
        assert.equal(await session.submitPendingInputOption?.(0, {
          requestId: "req-1",
          questionId: "environment",
        }), false);
        assert.deepEqual(client.pendingInputResponses, []);
        assert.equal(await session.submitPendingInputOption?.(1, {
          requestId: "req-1",
          questionId: "scope",
        }), true);
      }
      if (next.value.type === "run_completed") break;
    }

    assert.deepEqual(client.pendingInputResponses, [{
      answers: {
        environment: { answers: ["Production"] },
        scope: { answers: ["Everyone"] },
      },
    }]);
  });

  it("submits free-text answers into a live pending-input request", async () => {
    const client = new MockJsonRpcClient({
      pendingInput: {
        method: "turn/requestUserInput",
        params: {
          threadId: "thread-123",
          turnId: "turn-1",
          requestId: "req-1",
          questions: [{
            id: "rationale",
            question: "Need rationale",
            options: ["Short", "Long"],
          }],
        },
      },
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });
    const session = harness.launch({ prompt: "plan it", cwd: "/tmp" });
    const iter = session.messages[Symbol.asyncIterator]();

    const seen: HarnessMessage[] = [];
    for (let i = 0; i < 8; i += 1) {
      const next = await iter.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.type === "pending_input") {
        const submitted = await session.submitPendingInputText?.("Use explicit names");
        assert.equal(submitted, true);
      }
      if (
        next.value.type === "run_completed"
        && seen.some((message) => message.type === "pending_input_resolved")
      ) {
        break;
      }
    }

    const pending = seen.find((message) => message.type === "pending_input") as Extract<HarnessMessage, { type: "pending_input" }> | undefined;
    assert.match(pending?.state.promptText ?? "", /^Need rationale/);
    assert.deepEqual(client.pendingInputResponses[0], {
      answers: {
        rationale: {
          answers: ["Use explicit names"],
        },
      },
    });
  });

  it("emits finalized plan artifacts from Codex plan notifications", async () => {
    const client = new MockJsonRpcClient({
      finalPlanMarkdown: "1. Update code\n2. Add tests\n\nShould I proceed?",
    });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "plan it",
      cwd: "/tmp",
      permissionMode: "plan",
    }));

    const plan = messages.find((message) => message.type === "plan_artifact") as Extract<HarnessMessage, { type: "plan_artifact" }> | undefined;
    assert.equal(plan?.finalized, true);
    assert.match(plan?.artifact.markdown ?? "", /Should I proceed\?/);
    assert.equal(plan?.artifact.steps[0]?.step, "Update code");
  });
});
