import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHarness, listHarnesses } from "../src/harness/index";
import { CodexHarness } from "../src/harness/codex";
import type { HarnessMessage } from "../src/harness/types";

type NotificationHandler = (method: string, params: unknown) => Promise<void> | void;
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

class MockJsonRpcClient {
  requests: Array<{ method: string; params: unknown }> = [];
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

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });

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

describe("CodexHarness App Server mapping", () => {
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
    const client = new MockJsonRpcClient({ threadId: "thread-existing", assistantText: "Resumed." });
    const harness = new CodexHarness({
      createClient: () => client as any,
    });

    const messages = await collectMessages(harness.launch({
      prompt: "continue",
      cwd: "/tmp",
      resumeSessionId: "thread-existing",
    }));

    assert.equal(client.requests.some((request) => request.method === "thread/resume"), true);
    const resumeRequest = client.requests.find((request) => request.method === "thread/resume");
    assert.equal(Object.hasOwn((resumeRequest?.params as Record<string, unknown>) ?? {}, "cwd"), false);
    const ref = messages.find((message) => message.type === "backend_ref") as Extract<HarnessMessage, { type: "backend_ref" }> | undefined;
    assert.equal(ref?.ref.conversationId, "thread-existing");
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

  it("emits structured pending input and resolves button selections", async () => {
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
    assert.equal(pending?.state.promptText, "Choose an environment");
    assert.deepEqual(pending?.state.options, ["Staging", "Production"]);
    assert.equal(Boolean(resolved), true);
    assert.deepEqual(client.pendingInputResponses[0], { option: "Production", index: 1 });
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
          question: "Need rationale",
          options: ["Short", "Long"],
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
    assert.equal(pending?.state.promptText, "Need rationale");
    assert.deepEqual(client.pendingInputResponses[0], { text: "Use explicit names" });
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
