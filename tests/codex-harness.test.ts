import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { getHarness, listHarnesses } from "../src/harness/index";
import { CodexHarness } from "../src/harness/codex";
import type { CodexAuthWorkspace } from "../src/harness/codex-auth";
import type { HarnessMessage } from "../src/harness/types";

type TurnPlan = {
  events?: ThreadEvent[];
  stream?: (signal?: AbortSignal) => AsyncIterable<ThreadEvent>;
  error?: Error;
};

type MockAuthWorkspaceState = {
  prepareCalls: number;
  releaseCalls: number;
  cleanupCalls: number;
};

type MockAuthWorkspace = {
  workspace: CodexAuthWorkspace;
  state: MockAuthWorkspaceState;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function* eventsFromArray(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const event of events) {
    yield event;
  }
}

function createMockAuthWorkspace(options: {
  env?: Record<string, string>;
  prepareForTurn?: (state: MockAuthWorkspaceState) => Promise<() => Promise<void>> | (() => Promise<void>);
  cleanup?: (state: MockAuthWorkspaceState) => Promise<void> | void;
} = {}): MockAuthWorkspace {
  const state: MockAuthWorkspaceState = {
    prepareCalls: 0,
    releaseCalls: 0,
    cleanupCalls: 0,
  };

  return {
    state,
    workspace: {
      tempHome: "/tmp/openclaw-codex-auth-test-home",
      tempCodexDir: "/tmp/openclaw-codex-auth-test-home/.codex",
      canonicalHome: "/tmp/openclaw-codex-auth-test-canonical",
      canonicalCodexDir: "/tmp/openclaw-codex-auth-test-canonical/.codex",
      canonicalAuthPath: "/tmp/openclaw-codex-auth-test-canonical/.codex/auth.json",
      canonicalSessionsPath: "/tmp/openclaw-codex-auth-test-canonical/.codex/sessions",
      canonicalConfigPath: "/tmp/openclaw-codex-auth-test-canonical/.codex/config.toml",
      env: options.env ?? {
        HOME: "/tmp/openclaw-codex-auth-test-home",
        PATH: process.env.PATH ?? "",
      },
      async prepareForTurn(): Promise<() => Promise<void>> {
        state.prepareCalls += 1;
        if (options.prepareForTurn) return options.prepareForTurn(state);
        return async () => {
          state.releaseCalls += 1;
        };
      },
      async cleanup(): Promise<void> {
        state.cleanupCalls += 1;
        await options.cleanup?.(state);
      },
    },
  };
}

function createHarness(
  codex: MockCodex,
  options: { auth?: MockAuthWorkspace } = {},
): {
  harness: CodexHarness;
  auth: MockAuthWorkspace;
  createCodexCalls: Array<{ env?: Record<string, string> }>;
} {
  const auth = options.auth ?? createMockAuthWorkspace();
  const createCodexCalls: Array<{ env?: Record<string, string> }> = [];

  return {
    auth,
    createCodexCalls,
    harness: new CodexHarness({
      createCodex: (createOptions) => {
        createCodexCalls.push(createOptions ?? {});
        return codex as any;
      },
      createAuthWorkspace: async () => auth.workspace,
    }),
  };
}

class MockThread {
  constructor(
    public id: string | null,
    private readonly plans: TurnPlan[],
    private readonly inputs: Array<{ threadId: string | null; input: string }>,
  ) {}

  async runStreamed(input: string, turnOptions: { signal?: AbortSignal } = {}): Promise<{ events: AsyncIterable<ThreadEvent> }> {
    this.inputs.push({ threadId: this.id, input });

    const plan = this.plans.shift();
    if (!plan) throw new Error("No turn plan configured");
    if (plan.error) throw plan.error;
    if (plan.stream) return { events: plan.stream(turnOptions.signal) };
    return { events: eventsFromArray(plan.events ?? []) };
  }
}

class MockCodex {
  readonly startCalls: ThreadOptions[] = [];
  readonly resumeCalls: Array<{ id: string; options: ThreadOptions }> = [];
  readonly inputs: Array<{ threadId: string | null; input: string }> = [];

  constructor(
    private readonly plans: TurnPlan[],
    private readonly defaultThreadId: string | null = null,
  ) {}

  startThread(options: ThreadOptions = {}): MockThread {
    this.startCalls.push(options);
    return new MockThread(this.defaultThreadId, this.plans, this.inputs);
  }

  resumeThread(id: string, options: ThreadOptions = {}): MockThread {
    this.resumeCalls.push({ id, options });
    return new MockThread(id, this.plans, this.inputs);
  }
}

async function collectMessages(
  session: { messages: AsyncIterable<HarnessMessage> },
  onMessage?: (message: HarnessMessage) => Promise<void> | void,
): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const message of session.messages) {
    out.push(message);
    if (onMessage) await onMessage(message);
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

  it("has synthetic tool names", () => {
    assert.ok(h.questionToolNames.includes("codex:waiting-for-user"));
    assert.deepEqual(h.planApprovalToolNames, []);
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

describe("CodexHarness SDK mapping", () => {
  it("emits init, assistant text, reasoning text, and success result with cost", async () => {
    const usage = { input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 100_000 };
    const codex = new MockCodex([
      {
        events: [
          { type: "thread.started", thread_id: "thread-abc" },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } },
          { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Done." } },
          { type: "turn.completed", usage },
        ],
      },
    ]);

    const { harness: h } = createHarness(codex);
    const session = h.launch({ prompt: "do work", cwd: "/tmp" });
    const msgs = await collectMessages(session);

    const init = msgs.find((m) => m.type === "init") as any;
    assert.equal(init.session_id, "thread-abc");

    const texts = msgs.filter((m) => m.type === "text").map((m: any) => m.text);
    assert.deepEqual(texts, ["thinking", "Done."]);

    const result = msgs.find((m) => m.type === "result") as any;
    assert.ok(result, "expected result event");
    assert.equal(result.data.success, true);
    assert.equal(result.data.session_id, "thread-abc");

    const expectedCost =
      (800_000 * (1.10 / 1_000_000)) +
      (200_000 * (0.275 / 1_000_000)) +
      (100_000 * (4.40 / 1_000_000));
    assert.ok(Math.abs(result.data.total_cost_usd - expectedCost) < 1e-12);
  });

  it("passes the isolated HOME override to the Codex SDK constructor", async () => {
    const codex = new MockCodex([
      {
        events: [
          { type: "thread.started", thread_id: "thread-env" },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ],
      },
    ]);

    const { harness: h, createCodexCalls } = createHarness(codex, {
      auth: createMockAuthWorkspace({
        env: {
          HOME: "/tmp/isolated-codex-home",
          PATH: process.env.PATH ?? "",
        },
      }),
    });

    await collectMessages(h.launch({ prompt: "go", cwd: "/tmp" }));

    assert.equal(createCodexCalls.length, 1);
    assert.equal(createCodexCalls[0]?.env?.HOME, "/tmp/isolated-codex-home");
  });

  it("releases the auth bootstrap lock on the first streamed event", async () => {
    const codex = new MockCodex([
      {
        stream: async function* (): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: "thread-lock" };
          await sleep(10);
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        },
      },
    ]);

    const auth = createMockAuthWorkspace();
    const { harness: h } = createHarness(codex, { auth });
    const session = h.launch({ prompt: "go", cwd: "/tmp" });

    await collectMessages(session, (message) => {
      if (message.type === "init") {
        assert.equal(auth.state.releaseCalls, 1);
      }
    });

    assert.equal(auth.state.prepareCalls, 1);
    assert.equal(auth.state.releaseCalls, 1);
    assert.equal(auth.state.cleanupCalls, 1);
  });

  it("releases the auth bootstrap lock on startup failure before the first event", async () => {
    const codex = new MockCodex([{ error: new Error("startup failed") }]);
    const auth = createMockAuthWorkspace();
    const { harness: h } = createHarness(codex, { auth });

    const msgs = await collectMessages(h.launch({ prompt: "go", cwd: "/tmp" }));

    const result = msgs.find((message) => message.type === "result") as any;
    assert.equal(result.data.success, false);
    assert.match(result.data.result, /startup failed/);
    assert.equal(auth.state.prepareCalls, 1);
    assert.equal(auth.state.releaseCalls, 1);
    assert.equal(auth.state.cleanupCalls, 1);
  });

  it("uses a soft planning prompt on the first turn when launched in plan mode", async () => {
    const codex = new MockCodex([
      {
        events: [
          { type: "thread.started", thread_id: "thread-plan" },
          { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Proposed plan." } },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ],
      },
    ]);

    const { harness: h } = createHarness(codex);
    const session = h.launch({ prompt: "plan this", cwd: "/tmp", permissionMode: "plan" });
    const msgs = await collectMessages(session);

    assert.match(codex.inputs[0]?.input ?? "", /Do not implement yet/);
    assert.match(codex.inputs[0]?.input ?? "", /implementation plan only/);
    assert.equal(msgs.some((m) => m.type === "tool_use"), false);
  });

  it("emits synthetic waiting-for-user tool event when tail text matches heuristic", async () => {
    const codex = new MockCodex([
      {
        events: [
          { type: "thread.started", thread_id: "thread-wait" },
          { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Should I proceed with implementation?" } },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ],
      },
    ]);

    const { harness: h } = createHarness(codex);
    const session = h.launch({ prompt: "ask", cwd: "/tmp", permissionMode: "default" });
    const msgs = await collectMessages(session);

    const toolUse = msgs.find((m) => m.type === "tool_use") as any;
    assert.ok(toolUse, "expected synthetic tool_use");
    assert.equal(toolUse.name, "codex:waiting-for-user");
  });

  it("emits activity heartbeat while a turn is running", async () => {
    const prev = process.env.OPENCLAW_CODEX_HEARTBEAT_MS;
    process.env.OPENCLAW_CODEX_HEARTBEAT_MS = "20";

    try {
      const codex = new MockCodex([
        {
          stream: async function* (): AsyncGenerator<ThreadEvent> {
            yield { type: "thread.started", thread_id: "thread-heartbeat" };
            await sleep(75);
            yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
          },
        },
      ]);

      const { harness: h } = createHarness(codex);
      const session = h.launch({ prompt: "heartbeat", cwd: "/tmp" });
      const msgs = await collectMessages(session);

      const activityCount = msgs.filter((m) => m.type === "activity").length;
      assert.ok(activityCount >= 1, "expected at least one heartbeat");
      assert.ok(msgs.some((m) => m.type === "result"), "expected terminal result");
    } finally {
      process.env.OPENCLAW_CODEX_HEARTBEAT_MS = prev;
    }
  });

  it("resumeSessionId uses resumeThread on first turn and emits init from thread id", async () => {
    const codex = new MockCodex([
      {
        events: [
          { type: "turn.started" },
          { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Resumed." } },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ],
      },
    ]);

    const { harness: h } = createHarness(codex);
    const session = h.launch({ prompt: "continue", cwd: "/tmp", resumeSessionId: "thread-resume" });
    const msgs = await collectMessages(session);

    assert.equal(codex.resumeCalls.length, 1);
    assert.equal(codex.resumeCalls[0]?.id, "thread-resume");

    const init = msgs.find((m) => m.type === "init") as any;
    assert.ok(init, "expected init event");
    assert.equal(init.session_id, "thread-resume");
  });

  it("does not emit init for a resumed thread before the streamed turn produces a real event", async () => {
    const codex = new MockCodex([{ error: new Error("resume failed before first event") }]);

    const { harness: h } = createHarness(codex);
    const msgs = await collectMessages(h.launch({
      prompt: "continue",
      cwd: "/tmp",
      resumeSessionId: "thread-resume-fail",
    }));

    assert.equal(codex.resumeCalls.length, 1);
    assert.equal(msgs.some((m) => m.type === "init"), false);

    const result = msgs.find((m) => m.type === "result") as any;
    assert.ok(result, "expected terminal result");
    assert.equal(result.data.success, false);
    assert.match(result.data.result, /resume failed before first event/);
  });

  it("setPermissionMode applies on next turn via thread recreation with same id", async () => {
    let releaseSecondTurn: (() => void) | undefined;
    const secondTurnGate = new Promise<void>((resolve) => {
      releaseSecondTurn = resolve;
    });

    async function* promptStream(): AsyncGenerator<string> {
      yield "first";
      await secondTurnGate;
      yield "second";
    }

    const codex = new MockCodex([
      {
        events: [
          { type: "thread.started", thread_id: "thread-recreate" },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ],
      },
      {
        events: [
          { type: "turn.started" },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ],
      },
    ]);

    const { harness: h } = createHarness(codex);
    const session = h.launch({ prompt: promptStream(), cwd: "/tmp", permissionMode: "plan" });

    const collected = collectMessages(session, async (msg) => {
      if (msg.type === "result" && (msg as any).data.num_turns === 1) {
        await session.setPermissionMode?.("bypassPermissions");
        releaseSecondTurn?.();
      }
    });

    const msgs = await collected;
    const results = msgs.filter((m) => m.type === "result") as any[];
    assert.equal(results.length, 2);

    assert.equal(codex.startCalls.length, 1);
    assert.equal(codex.resumeCalls.length, 1);
    assert.equal(codex.resumeCalls[0]?.id, "thread-recreate");
  });

  it("interrupt redirects the active turn without emitting terminal failure", async () => {
    const codex = new MockCodex([
      {
        stream: async function* (signal?: AbortSignal): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: "thread-interrupt" };
          await new Promise<void>((resolve, reject) => {
            if (!signal) return reject(new Error("missing abort signal"));
            const onAbort = (): void => {
              signal.removeEventListener("abort", onAbort);
              reject(new Error("interrupted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
          });
        },
      },
      {
        events: [
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ],
      },
    ]);

    const { harness: h } = createHarness(codex);
    let releaseSecondTurn: (() => void) | undefined;
    const secondTurnGate = new Promise<void>((resolve) => {
      releaseSecondTurn = resolve;
    });
    async function* promptStream(): AsyncGenerator<string> {
      yield "long";
      await secondTurnGate;
      yield "redirected";
    }

    const session = h.launch({ prompt: promptStream(), cwd: "/tmp" });

    const collected = collectMessages(session, async (msg) => {
      if (msg.type === "init") {
        await session.interrupt?.();
        releaseSecondTurn?.();
      }
    });

    const msgs = await collected;
    const results = msgs.filter((m) => m.type === "result") as any[];
    assert.equal(results.length, 1);
    assert.equal(results[0]?.data.success, true);
    assert.deepEqual(codex.inputs.map((entry) => entry.input), ["long", "redirected"]);
    assert.equal(codex.resumeCalls.length, 1);
    assert.equal(codex.resumeCalls[0]?.id, "thread-interrupt");
  });

  it("turn.failed path emits exactly one terminal failure result", async () => {
    const codex = new MockCodex([
      {
        events: [
          { type: "thread.started", thread_id: "thread-failed" },
          { type: "turn.failed", error: { message: "mock turn failure" } },
        ],
      },
    ]);

    const { harness: h } = createHarness(codex);
    const msgs = await collectMessages(h.launch({ prompt: "fail", cwd: "/tmp" }));

    const results = msgs.filter((m) => m.type === "result") as any[];
    assert.equal(results.length, 1);
    assert.equal(results[0].data.success, false);
    assert.match(results[0].data.result, /mock turn failure/);
  });

  it("thrown exception path emits exactly one terminal failure result", async () => {
    const codex = new MockCodex([{ error: new Error("mock thrown error") }]);
    const { harness: h } = createHarness(codex);

    const msgs = await collectMessages(h.launch({ prompt: "throw", cwd: "/tmp" }));
    const results = msgs.filter((m) => m.type === "result") as any[];

    assert.equal(results.length, 1);
    assert.equal(results[0].data.success, false);
    assert.match(results[0].data.result, /mock thrown error/);
  });

  it("uses danger-full-access and preserves the default Codex approval policy across starts/resumes", async () => {
    const codex = new MockCodex([
      { events: [{ type: "thread.started", thread_id: "thread-perm" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
      { events: [{ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
    ]);

    async function* prompts(): AsyncGenerator<string> {
      yield "one";
      yield "two";
    }

    const { harness: h } = createHarness(codex);
    const session = h.launch({ prompt: prompts(), cwd: "/tmp", permissionMode: "plan" });
    await session.setPermissionMode?.("default");
    await collectMessages(session);

    const all = [
      ...codex.startCalls,
      ...codex.resumeCalls.map((c) => c.options),
    ];

    assert.ok(all.length >= 1);
    for (const opts of all) {
      assert.equal(opts.sandboxMode, "danger-full-access");
      assert.equal(opts.approvalPolicy, "on-request");
    }
  });

  it("passes through an explicit never Codex approval policy", async () => {
    const codex = new MockCodex([
      { events: [{ type: "thread.started", thread_id: "thread-approval" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
    ]);

    const { harness: h } = createHarness(codex);
    await collectMessages(h.launch({
      prompt: "go",
      cwd: "/tmp",
      codexApprovalPolicy: "never",
    }));

    assert.equal(codex.startCalls[0]?.sandboxMode, "danger-full-access");
    assert.equal(codex.startCalls[0]?.approvalPolicy, "never");
  });

  it("adds filesystem root and env extras to additionalDirectories in bypass mode", async () => {
    const prev = process.env.OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS;
    process.env.OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS = "/mnt/data,/tmp,/mnt/data";

    try {
      const codex = new MockCodex([
        { events: [{ type: "thread.started", thread_id: "thread-bypass" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
      ]);

      const { harness: h } = createHarness(codex);
      await collectMessages(h.launch({ prompt: "go", cwd: "/home/openclaw/project", permissionMode: "bypassPermissions" }));

      const startOpts = codex.startCalls[0];
      assert.ok(startOpts?.additionalDirectories?.includes("/"), "root directory should be included");
      assert.ok(startOpts?.additionalDirectories?.includes("/mnt/data"));
      assert.ok(startOpts?.additionalDirectories?.includes("/tmp"));
      assert.equal(new Set(startOpts?.additionalDirectories ?? []).size, (startOpts?.additionalDirectories ?? []).length, "additionalDirectories should be deduped");
    } finally {
      process.env.OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS = prev;
    }
  });

  it("does not set additionalDirectories outside bypass mode", async () => {
    const codex = new MockCodex([
      { events: [{ type: "thread.started", thread_id: "thread-default" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
    ]);

    const { harness: h } = createHarness(codex);
    await collectMessages(h.launch({ prompt: "go", cwd: "/tmp", permissionMode: "plan" }));

    assert.equal(codex.startCalls[0]?.additionalDirectories, undefined);
  });

  it("passes modelReasoningEffort through to thread options", async () => {
    const codex = new MockCodex([
      { events: [{ type: "thread.started", thread_id: "thread-reasoning" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
    ]);

    const { harness: h } = createHarness(codex);
    await collectMessages(h.launch({ prompt: "go", cwd: "/tmp", reasoningEffort: "high" }));

    assert.equal(codex.startCalls[0]?.modelReasoningEffort, "high");
  });
});
