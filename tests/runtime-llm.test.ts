import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

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
