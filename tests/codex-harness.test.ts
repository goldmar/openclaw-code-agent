import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { getHarness, listHarnesses } from "../src/harness/index";
import { CodexHarness } from "../src/harness/codex";
import type { HarnessMessage } from "../src/harness/types";

type TurnPlan = {
  events?: ThreadEvent[];
  stream?: (signal?: AbortSignal) => AsyncIterable<ThreadEvent>;
  error?: Error;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function* eventsFromArray(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const event of events) {
    yield event;
  }
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
    assert.ok(h.supportedPermissionModes.includes("acceptEdits"));
    assert.ok(h.supportedPermissionModes.includes("bypassPermissions"));
  });

  it("has synthetic tool names", () => {
    assert.ok(h.questionToolNames.includes("codex:waiting-for-user"));
    assert.ok(h.planApprovalToolNames.includes("codex:plan-approval"));
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

    const h = new CodexHarness({ createCodex: () => codex as any });
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

  it("emits synthetic plan approval tool event on successful plan-mode turn", async () => {
    const codex = new MockCodex([
      {
        events: [
          { type: "thread.started", thread_id: "thread-plan" },
          { type: "item.completed", item: { id: "a1", type: "agent_message", text: "Proposed plan." } },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ],
      },
    ]);

    const h = new CodexHarness({ createCodex: () => codex as any });
    const session = h.launch({ prompt: "plan this", cwd: "/tmp", permissionMode: "plan" });
    const msgs = await collectMessages(session);

    const toolUse = msgs.find((m) => m.type === "tool_use") as any;
    assert.ok(toolUse, "expected synthetic tool_use");
    assert.equal(toolUse.name, "codex:plan-approval");
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

    const h = new CodexHarness({ createCodex: () => codex as any });
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

      const h = new CodexHarness({ createCodex: () => codex as any });
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

    const h = new CodexHarness({ createCodex: () => codex as any });
    const session = h.launch({ prompt: "continue", cwd: "/tmp", resumeSessionId: "thread-resume" });
    const msgs = await collectMessages(session);

    assert.equal(codex.resumeCalls.length, 1);
    assert.equal(codex.resumeCalls[0]?.id, "thread-resume");

    const init = msgs.find((m) => m.type === "init") as any;
    assert.ok(init, "expected init event");
    assert.equal(init.session_id, "thread-resume");
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

    const h = new CodexHarness({ createCodex: () => codex as any });
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

  it("interrupt aborts the active turn and emits terminal failure", async () => {
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
    ]);

    const h = new CodexHarness({ createCodex: () => codex as any });
    const session = h.launch({ prompt: "long", cwd: "/tmp" });

    const collected = collectMessages(session, async (msg) => {
      if (msg.type === "init") {
        await session.interrupt?.();
      }
    });

    const msgs = await collected;
    const result = msgs.find((m) => m.type === "result") as any;
    assert.ok(result, "expected result");
    assert.equal(result.data.success, false);
    assert.match(result.data.result, /interrupted/);
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

    const h = new CodexHarness({ createCodex: () => codex as any });
    const msgs = await collectMessages(h.launch({ prompt: "fail", cwd: "/tmp" }));

    const results = msgs.filter((m) => m.type === "result") as any[];
    assert.equal(results.length, 1);
    assert.equal(results[0].data.success, false);
    assert.match(results[0].data.result, /mock turn failure/);
  });

  it("thrown exception path emits exactly one terminal failure result", async () => {
    const codex = new MockCodex([{ error: new Error("mock thrown error") }]);
    const h = new CodexHarness({ createCodex: () => codex as any });

    const msgs = await collectMessages(h.launch({ prompt: "throw", cwd: "/tmp" }));
    const results = msgs.filter((m) => m.type === "result") as any[];

    assert.equal(results.length, 1);
    assert.equal(results[0].data.success, false);
    assert.match(results[0].data.result, /mock thrown error/);
  });

  it("uses permissive sandbox and approval options for all starts/resumes", async () => {
    const codex = new MockCodex([
      { events: [{ type: "thread.started", thread_id: "thread-perm" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
      { events: [{ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
    ]);

    async function* prompts(): AsyncGenerator<string> {
      yield "one";
      yield "two";
    }

    const h = new CodexHarness({ createCodex: () => codex as any });
    const session = h.launch({ prompt: prompts(), cwd: "/tmp", permissionMode: "plan" });
    await session.setPermissionMode?.("acceptEdits");
    await collectMessages(session);

    const all = [
      ...codex.startCalls,
      ...codex.resumeCalls.map((c) => c.options),
    ];

    assert.ok(all.length >= 1);
    for (const opts of all) {
      assert.equal(opts.sandboxMode, "danger-full-access");
      assert.equal(opts.approvalPolicy, "never");
    }
  });

  it("adds filesystem root and env extras to additionalDirectories in bypass mode", async () => {
    const prev = process.env.OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS;
    process.env.OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS = "/mnt/data,/tmp,/mnt/data";

    try {
      const codex = new MockCodex([
        { events: [{ type: "thread.started", thread_id: "thread-bypass" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
      ]);

      const h = new CodexHarness({ createCodex: () => codex as any });
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

    const h = new CodexHarness({ createCodex: () => codex as any });
    await collectMessages(h.launch({ prompt: "go", cwd: "/tmp", permissionMode: "plan" }));

    assert.equal(codex.startCalls[0]?.additionalDirectories, undefined);
  });

  it("passes modelReasoningEffort through to thread options", async () => {
    const codex = new MockCodex([
      { events: [{ type: "thread.started", thread_id: "thread-reasoning" }, { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }] },
    ]);

    const h = new CodexHarness({ createCodex: () => codex as any });
    await collectMessages(h.launch({ prompt: "go", cwd: "/tmp", reasoningEffort: "high" }));

    assert.equal(codex.startCalls[0]?.modelReasoningEffort, "high");
  });
});
