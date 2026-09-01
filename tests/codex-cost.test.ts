import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateCodexApiCostUsd,
  extractCodexAccountType,
  extractRawResponseUsage,
} from "../src/harness/codex-cost";

describe("Codex API cost accounting", () => {
  it("does not double-count reasoning tokens already included in outputTokens", () => {
    const cost = estimateCodexApiCostUsd({
      model: "gpt-5.6-sol",
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        cacheWriteInputTokens: 200,
        outputTokens: 100,
        reasoningOutputTokens: 90,
      },
    });

    assert.equal(cost, 0.00476);
  });

  it("applies Fast mode and long-context multipliers per response", () => {
    const cost = estimateCodexApiCostUsd({
      model: "gpt-5.6-luna",
      fastMode: true,
      usage: {
        inputTokens: 300_000,
        cachedInputTokens: 100_000,
        cacheWriteInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 500,
      },
    });

    assert.equal(cost, 0.1716);
  });

  it("leaves unknown models and inconsistent usage unpriced", () => {
    assert.equal(estimateCodexApiCostUsd({
      model: "future-model",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
    }), undefined);
    assert.equal(extractRawResponseUsage({
      responseId: "resp-1",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 11,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
    }), undefined);
  });

  it("extracts only explicit app-server account and usage fields", () => {
    assert.equal(extractCodexAccountType({ account: { type: "apiKey" } }), "apiKey");
    assert.equal(extractCodexAccountType({ account: null }), undefined);
    assert.equal(extractCodexAccountType({ account: { type: "secret-account-type" } }), undefined);
    assert.deepEqual(extractRawResponseUsage({
      responseId: "resp-1",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 2,
      },
    }), {
      responseId: "resp-1",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 2,
      },
    });
  });
});
