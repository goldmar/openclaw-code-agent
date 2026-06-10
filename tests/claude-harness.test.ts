import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeHarness } from "../src/harness/claude-code";
import type { HarnessMessage } from "../src/harness/types";

function createQueryHandle(messages: unknown[]) {
  const permissionModes: string[] = [];
  const streamedInputs: SDKUserMessage[][] = [];
  let interrupted = false;

  const handle = {
    async *[Symbol.asyncIterator](): AsyncIterable<unknown> {
      for (const message of messages) {
        yield message;
      }
    },
    async setPermissionMode(mode: string): Promise<void> {
      permissionModes.push(mode);
    },
    async streamInput(input: AsyncIterable<SDKUserMessage>): Promise<void> {
      const batch: SDKUserMessage[] = [];
      for await (const message of input) {
        batch.push(message);
      }
      streamedInputs.push(batch);
    },
    async interrupt(): Promise<void> {
      interrupted = true;
    },
  };

  return {
    handle,
    permissionModes,
    streamedInputs,
    wasInterrupted: () => interrupted,
  };
}

async function collectMessages(
  session: { messages: AsyncIterable<HarnessMessage> },
): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const message of session.messages) {
    out.push(message);
    if (message.type === "run_completed") break;
  }
  return out;
}

describe("ClaudeCodeHarness", () => {
  it("treats Claude AskUserQuestion questions[] as a formal multi-question contract", async () => {
    const startupOptions = Promise.withResolvers<Record<string, unknown>>();
    const { handle } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-questions", duration_ms: 0, total_cost_usd: 0, num_turns: 1, result: "done" },
    ]);
    const harness = new ClaudeCodeHarness({
      startup: async ({ options } = {}) => {
        startupOptions.resolve(options ?? {});
        return { query: () => handle as any };
      },
    });

    const session = harness.launch({
      prompt: "ask",
      cwd: "/tmp/project",
      canUseTool: async () => ({ behavior: "allow" as const, updatedInput: {} }),
    });
    const options = await startupOptions.promise;
    const canUseTool = options.canUseTool as ((toolName: string, input: Record<string, unknown>) => Promise<unknown>);

    await canUseTool("AskUserQuestion", {
      questions: [{
        id: "policy_source",
        header: "Policy",
        question: "Which policy source should I use?",
        options: [
          {
            label: "Plugin store",
            value: "plugin_store",
            description: "Shared policy controlled by plugin config.",
          },
          { label: "Local override", preview: "Only this session." },
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
    });

    const messages = await collectMessages(session);
    const pending = messages.find((message) => message.type === "pending_input") as Extract<HarnessMessage, { type: "pending_input" }> | undefined;

    assert.equal(pending?.state.kind, "question");
    assert.equal(pending?.state.activeQuestionIndex, 0);
    assert.deepEqual(pending?.state.options, ["Plugin store", "Local override"]);
    assert.equal(pending?.state.questions?.length, 2);
    assert.equal(pending?.state.questions?.[0]?.id, "policy_source");
    assert.equal(pending?.state.questions?.[0]?.options[0]?.value, "plugin_store");
    assert.equal(pending?.state.questions?.[0]?.options[0]?.description, "Shared policy controlled by plugin config.");
    assert.equal(pending?.state.questions?.[0]?.options[1]?.description, "Only this session.");
    assert.equal(pending?.state.questions?.[1]?.question, "How broad should the rollout be?");
    assert.equal(pending?.state.questions?.[1]?.multiSelect, true);
    assert.equal(pending?.state.questions?.[1]?.allowsFreeText, true);
    assert.match(pending?.state.promptText ?? "", /Question 1 - Policy/);
    assert.doesNotMatch(pending?.state.promptText ?? "", /Question 2 - Scope/);
  });

  it("pre-warms Claude Code with startup() before the first query", async () => {
    const calls: { startup: number; query: number } = { startup: 0, query: 0 };
    let promptSeen: string | AsyncIterable<SDKUserMessage> | undefined;
    let optionsSeen: Record<string, unknown> | undefined;
    const { handle } = createQueryHandle([
      { type: "system", subtype: "init", session_id: "claude-session-1" },
      { type: "assistant", message: { content: [{ type: "text", text: "Ready" }] } },
      { type: "result", subtype: "success", session_id: "claude-session-1", duration_ms: 12, total_cost_usd: 0.1, num_turns: 1, result: "done" },
    ]);
    const harness = new ClaudeCodeHarness({
      query: () => {
        calls.query += 1;
        return handle as any;
      },
      startup: async ({ options } = {}) => {
        calls.startup += 1;
        optionsSeen = options;
        return {
          query(prompt) {
            promptSeen = prompt;
            return handle as any;
          },
        };
      },
    });

    const messages = await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/tmp/project",
      permissionMode: "plan",
    }));

    assert.equal(calls.startup, 1);
    assert.equal(calls.query, 0);
    assert.equal(promptSeen, "ship it");
    assert.equal(optionsSeen?.cwd, "/tmp/project");
    assert.equal(optionsSeen?.permissionMode, "plan");
    assert.equal(messages.some((message) => message.type === "backend_ref"), true);
    assert.equal(messages.at(-1)?.type, "run_completed");
  });

  it("passes configured reasoning effort to Claude Code without inventing a default", async () => {
    const seenOptions: Record<string, unknown>[] = [];
    const { handle } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-effort", duration_ms: 0, total_cost_usd: 0, num_turns: 1, result: "done" },
    ]);
    const harness = new ClaudeCodeHarness({
      startup: async ({ options } = {}) => {
        seenOptions.push(options ?? {});
        return { query: () => handle as any };
      },
    });

    await collectMessages(harness.launch({
      prompt: "think harder",
      cwd: "/tmp/project",
      reasoningEffort: "xhigh",
    }));

    assert.equal(seenOptions[0]?.effort, "xhigh");

    const { handle: defaultHandle } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-default", duration_ms: 0, total_cost_usd: 0, num_turns: 1, result: "done" },
    ]);
    const defaultHarness = new ClaudeCodeHarness({
      startup: async ({ options } = {}) => {
        seenOptions.push(options ?? {});
        return { query: () => defaultHandle as any };
      },
    });

    await collectMessages(defaultHarness.launch({
      prompt: "use default effort",
      cwd: "/tmp/project",
    }));

    assert.equal(Object.hasOwn(seenOptions[1] ?? {}, "effort"), false);
  });

  it("passes resume options through Claude Code startup and preserves the backend ref", async () => {
    const seenOptions: Record<string, unknown>[] = [];
    const { handle } = createQueryHandle([
      { type: "system", subtype: "init", session_id: "claude-resume-session" },
      { type: "result", subtype: "success", session_id: "claude-resume-session", duration_ms: 0, total_cost_usd: 0, num_turns: 1, result: "resumed" },
    ]);
    const harness = new ClaudeCodeHarness({
      startup: async ({ options } = {}) => {
        seenOptions.push(options ?? {});
        return { query: () => handle as any };
      },
    });

    const messages = await collectMessages(harness.launch({
      prompt: "continue",
      cwd: "/tmp/project",
      resumeSessionId: "claude-resume-session",
    }));

    assert.equal(seenOptions[0]?.resume, "claude-resume-session");
    assert.equal(seenOptions[0]?.forkSession, false);
    const ref = messages.find((message) => message.type === "backend_ref");
    assert.equal(ref?.type, "backend_ref");
    assert.equal(ref?.ref.conversationId, "claude-resume-session");
  });

  it("waits for startup() before forwarding control calls to the query handle", async () => {
    let resolveStartup: ((value: { query: () => AsyncIterable<unknown> }) => void) | undefined;
    const { handle, permissionModes, streamedInputs, wasInterrupted } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-session-2", duration_ms: 0, total_cost_usd: 0, num_turns: 1, result: "done" },
    ]);
    const harness = new ClaudeCodeHarness({
      startup: async () => await new Promise((resolve) => {
        resolveStartup = resolve;
      }),
    });
    const session = harness.launch({
      prompt: "warm start",
      cwd: "/tmp/project",
    });

    const permissionPromise = session.setPermissionMode?.("plan");
    const streamPromise = session.streamInput?.((async function* oneMessage() {
      yield {
        type: "user",
        message: { role: "user", content: "continue" },
        parent_tool_use_id: null,
      } satisfies SDKUserMessage;
    })());
    const interruptPromise = session.interrupt?.();

    resolveStartup?.({
      query: () => handle as any,
    });

    await Promise.all([
      permissionPromise,
      streamPromise,
      interruptPromise,
      collectMessages(session),
    ]);

    assert.deepEqual(permissionModes, ["plan"]);
    assert.equal(streamedInputs.length, 1);
    assert.equal(streamedInputs[0]?.[0]?.type, "user");
    assert.equal(wasInterrupted(), true);
  });

  it("maps Claude error result messages from errors[] when result is absent", async () => {
    const { handle } = createQueryHandle([
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "claude-session-3",
        duration_ms: 9,
        total_cost_usd: 0,
        num_turns: 1,
        errors: ["Tool execution failed", "Bash exited with status 1"],
      },
    ]);
    const harness = new ClaudeCodeHarness({
      startup: async () => ({
        query: () => handle as any,
      }),
    });

    const messages = await collectMessages(harness.launch({
      prompt: "break it",
      cwd: "/tmp/project",
    }));
    const result = messages.find((message) => message.type === "run_completed");

    assert.equal(result?.type, "run_completed");
    assert.equal(result?.data.success, false);
    assert.equal(result?.data.result, "Tool execution failed\nBash exited with status 1");
  });
});
