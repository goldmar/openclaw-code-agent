import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import { setPluginRuntime } from "../src/runtime-store";
import {
  completeRuntimeLlmText,
  describeRuntimeLlmError,
  getRuntimeLlmComplete,
  stripJsonCodeFence,
} from "../src/runtime-llm";
import {
  buildQuestionContextMicroSummary,
  createRuntimeQuestionContextSummaryProvider,
} from "../src/question-context-summary";

afterEach(() => {
  setPluginRuntime(undefined);
});

describe("runtime.llm completion adapter", () => {
  it("runs the completion outside a closed request work scope inherited from an earlier tool call", async () => {
    // Stand-in for the host's per-request async work scope: session events keep
    // the ALS context of the tool call that started the session, and the host
    // rejects work admitted into a scope that has already closed.
    const workScope = new AsyncLocalStorage<{ closed: boolean }>();
    const complete = async () => {
      if (workScope.getStore()?.closed) throw new Error("Async work scope is closed");
      return { text: "ok" } as never;
    };
    const scope = { closed: false };
    const inherited = await workScope.run(scope, () => new Promise<() => Promise<string>>((resolve) => {
      // A later session event scheduled from inside the tool call.
      setTimeout(() => resolve(() => completeRuntimeLlmText(complete, {
        purpose: "openclaw-code-agent.test",
        systemPrompt: "s",
        prompt: "p",
        maxTokens: 10,
      })), 1);
    }));
    scope.closed = true;
    const text = await workScope.run(scope, () => inherited());
    assert.equal(text, "ok");
  });

  it("sends the host LlmCompleteParams shape and returns LlmCompleteResult.text", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const complete = async (params: Record<string, unknown>) => {
      calls.push(params);
      return { text: "  ```json\n{\"ok\":true}\n```  ", provider: "p", model: "m", agentId: "main", usage: {} };
    };
    const signal = new AbortController().signal;

    const text = await completeRuntimeLlmText(complete as never, {
      purpose: "openclaw-code-agent.test",
      systemPrompt: "Return JSON.",
      prompt: "Evidence",
      maxTokens: 50,
      signal,
    });

    assert.equal(text, "{\"ok\":true}");
    assert.deepEqual(calls, [{
      messages: [{ role: "user", content: "Evidence" }],
      systemPrompt: "Return JSON.",
      purpose: "openclaw-code-agent.test",
      maxTokens: 50,
      reasoning: "low",
      signal,
    }]);
  });

  it("only resolves the public runtime.llm.complete surface", () => {
    setPluginRuntime(undefined);
    assert.equal(getRuntimeLlmComplete(), undefined);

    const complete = async () => ({ text: "x" });
    setPluginRuntime({ llm: { complete }, ai: { complete: async () => ({ text: "ai" }) }, models: { complete: async () => ({ text: "models" }) } });
    assert.equal(getRuntimeLlmComplete(), complete);
  });

  it("keeps the host error code in diagnostics", () => {
    const err = Object.assign(new Error("denied"), { code: "LLM_COMPLETION_NOT_AUTHORIZED" });
    assert.equal(describeRuntimeLlmError(err), "LLM_COMPLETION_NOT_AUTHORIZED: denied");
    assert.equal(describeRuntimeLlmError(new Error("plain")), "plain");
  });

  it("strips Markdown JSON fences", () => {
    assert.equal(stripJsonCodeFence("```\n{\"a\":1}\n```"), "{\"a\":1}");
    assert.equal(stripJsonCodeFence("{\"a\":1}"), "{\"a\":1}");
  });
});

describe("question context summary via runtime.llm", () => {
  it("summarizes through runtime.llm.complete", async () => {
    const purposes: unknown[] = [];
    setPluginRuntime({
      llm: {
        async complete(params: Record<string, unknown>) {
          purposes.push(params.purpose);
          return { text: "{\"summary\":\"The migration needs a target database first.\"}" };
        },
      },
    });
    const provider = createRuntimeQuestionContextSummaryProvider();
    assert.ok(provider);

    const summary = await buildQuestionContextMicroSummary({
      sessionName: "question",
      question: "Which database should I migrate?",
      context: "I found two candidate databases in the config.",
      provider,
    });

    assert.equal(summary, "The migration needs a target database first.");
    assert.deepEqual(purposes, ["openclaw-code-agent.question-context-summary"]);
  });

  it("aborts the host completion when the summary budget expires", async () => {
    let aborted = false;
    setPluginRuntime({
      llm: {
        complete(params: { signal?: AbortSignal }) {
          return new Promise((_resolve, reject) => {
            params.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          });
        },
      },
    });
    const provider = createRuntimeQuestionContextSummaryProvider();
    assert.ok(provider);

    const summary = await buildQuestionContextMicroSummary({
      sessionName: "question",
      question: "Which database should I migrate?",
      context: "I found two candidate databases in the config.",
      provider,
      timeoutMs: 10,
    });

    assert.equal(summary, undefined);
    assert.equal(aborted, true);
  });
});
