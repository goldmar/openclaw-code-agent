import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  codexAccountType,
  estimateCodexApiCostUsd,
  isFastServiceTier,
  tokenUsageFromBreakdown,
} from "../src/harness/codex-cost";

describe("Codex API cost accounting", () => {
  it("prices GPT-6 Astra input, cached input, and output tokens", () => {
    const cost = estimateCodexApiCostUsd({
      model: "gpt-6-astra",
      usage: {
        inputTokens: 100_000,
        cachedInputTokens: 20_000,
        cacheWriteInputTokens: 0,
        outputTokens: 10_000,
        reasoningOutputTokens: 5_000,
      },
    });

    assert.equal(cost, 1.32);
  });

  it("prices GPT-6 Sol and Luna at their standard API rates", () => {
    const usage = {
      inputTokens: 100_000,
      cachedInputTokens: 20_000,
      cacheWriteInputTokens: 0,
      outputTokens: 10_000,
      reasoningOutputTokens: 5_000,
    };

    assert.equal(estimateCodexApiCostUsd({ model: "gpt-6-sol", usage }), 0.264);
    assert.equal(estimateCodexApiCostUsd({ model: "GPT-6-Luna", usage }), 0.0132);
  });

  it("applies cache-write, Fast mode, and long-context rates to GPT-6 models", () => {
    // Matches the published Fast long-context gpt-6-sol rates:
    // $8 input, $0.80 cached input, $10 cache writes, $30 output per 1M.
    assert.equal(estimateCodexApiCostUsd({
      model: "gpt-6-sol",
      serviceTier: "priority",
      usage: {
        inputTokens: 300_000,
        cachedInputTokens: 100_000,
        cacheWriteInputTokens: 50_000,
        outputTokens: 1_000,
        reasoningOutputTokens: 500,
      },
    }), 1.81);
    // Standard short-context gpt-6-luna cache writes are $0.125 per 1M.
    assert.equal(estimateCodexApiCostUsd({
      model: "gpt-6-luna",
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        cacheWriteInputTokens: 200,
        outputTokens: 100,
        reasoningOutputTokens: 90,
      },
    }), 0.000119);
  });

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
      serviceTier: "priority",
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
    assert.equal(estimateCodexApiCostUsd({
      model: "gpt-6-astra-unlisted-snapshot",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
    }), undefined);
    for (const model of ["gpt-6-sol-unlisted-snapshot", "gpt-6-luna-unlisted-snapshot", "gpt-6-terra"]) {
      assert.equal(estimateCodexApiCostUsd({
        model,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
        },
      }), undefined, model);
    }
    assert.equal(tokenUsageFromBreakdown({
      totalTokens: 11,
      inputTokens: 10,
      cachedInputTokens: 11,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    }), undefined);
  });

  it("applies the fast multiplier only for the effective priority tier Codex reports", () => {
    const usage = {
      inputTokens: 100_000,
      cachedInputTokens: 20_000,
      cacheWriteInputTokens: 0,
      outputTokens: 10_000,
      reasoningOutputTokens: 5_000,
    };
    const standard = estimateCodexApiCostUsd({ model: "gpt-6-sol", usage });
    assert.equal(estimateCodexApiCostUsd({ model: "gpt-6-sol", serviceTier: null, usage }), standard);
    assert.equal(estimateCodexApiCostUsd({ model: "gpt-6-sol", serviceTier: "default", usage }), standard);
    assert.equal(estimateCodexApiCostUsd({ model: "gpt-6-sol", serviceTier: "priority", usage }), standard! * 2);
    assert.equal(isFastServiceTier("fast"), true);
    assert.equal(isFastServiceTier("flex"), false);
  });

  it("reads the typed account type and token-usage breakdowns", () => {
    assert.equal(codexAccountType({ account: { type: "apiKey" }, requiresOpenaiAuth: true, workspaceRouting: null }), "apiKey");
    assert.equal(codexAccountType({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }), undefined);
    assert.equal(codexAccountType(undefined), undefined);
    assert.deepEqual(tokenUsageFromBreakdown({
      totalTokens: 13,
      inputTokens: 10,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 2,
    }), {
      inputTokens: 10,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 2,
    });
  });
});
