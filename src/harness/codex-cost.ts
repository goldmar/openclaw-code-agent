import { asRecord } from "../pending-input-normalization";

export type CodexTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type TokenRates = {
  input: number;
  cachedInput: number;
  output: number;
};

// USD per 1M tokens. These are the current standard API rates documented at
// https://developers.openai.com/api/docs/models/compare as of 2026-08-31.
const STANDARD_RATES: Record<string, TokenRates> = {
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
};

const LONG_CONTEXT_INPUT_THRESHOLD = 272_000;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;
const FAST_MODE_MULTIPLIER = 2;
const LONG_CONTEXT_INPUT_MULTIPLIER = 2;
const LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;
const PER_MILLION = 1_000_000;

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function canonicalPricingModel(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "gpt-5.6") return "gpt-5.6-sol";
  for (const pricedModel of Object.keys(STANDARD_RATES)) {
    if (normalized === pricedModel || normalized.startsWith(`${pricedModel}-`)) {
      return pricedModel;
    }
  }
  return undefined;
}

export type CodexAccountType = "apiKey" | "chatgpt" | "amazonBedrock";

export function extractCodexAccountType(value: unknown): CodexAccountType | undefined {
  const response = asRecord(value);
  const account = asRecord(response?.account);
  const type = account?.type;
  return type === "apiKey" || type === "chatgpt" || type === "amazonBedrock"
    ? type
    : undefined;
}

export function extractRawResponseUsage(value: unknown): {
  responseId: string;
  usage: CodexTokenUsage;
} | undefined {
  const response = asRecord(value);
  const usage = asRecord(response?.usage);
  const responseId = typeof response?.responseId === "string"
    ? response.responseId.trim()
    : "";
  if (!responseId || !usage) return undefined;

  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const cachedInputTokens = nonNegativeInteger(usage.cachedInputTokens);
  const cacheWriteInputTokens = nonNegativeInteger(usage.cacheWriteInputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  const reasoningOutputTokens = nonNegativeInteger(usage.reasoningOutputTokens);
  if (
    inputTokens === undefined
    || cachedInputTokens === undefined
    || cacheWriteInputTokens === undefined
    || outputTokens === undefined
    || reasoningOutputTokens === undefined
    || cachedInputTokens + cacheWriteInputTokens > inputTokens
    || reasoningOutputTokens > outputTokens
  ) {
    return undefined;
  }

  return {
    responseId,
    usage: {
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
    },
  };
}

/**
 * Estimate OpenAI API token charges for one upstream Codex response.
 *
 * `outputTokens` already contains reasoning tokens; reasoningOutputTokens is a
 * diagnostic subset and must not be added again. Unknown models and malformed
 * usage remain unpriced rather than producing a misleading estimate.
 */
export function estimateCodexApiCostUsd(params: {
  model?: string;
  fastMode?: boolean;
  usage: CodexTokenUsage;
}): number | undefined {
  const pricingModel = canonicalPricingModel(params.model);
  const baseRates = pricingModel ? STANDARD_RATES[pricingModel] : undefined;
  if (!baseRates) return undefined;

  const {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  } = params.usage;
  if (
    ![inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
    || cachedInputTokens + cacheWriteInputTokens > inputTokens
    || reasoningOutputTokens > outputTokens
  ) {
    return undefined;
  }

  const isLongContext = inputTokens > LONG_CONTEXT_INPUT_THRESHOLD;
  const serviceMultiplier = params.fastMode ? FAST_MODE_MULTIPLIER : 1;
  const inputMultiplier = serviceMultiplier * (isLongContext ? LONG_CONTEXT_INPUT_MULTIPLIER : 1);
  const outputMultiplier = serviceMultiplier * (isLongContext ? LONG_CONTEXT_OUTPUT_MULTIPLIER : 1);
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteInputTokens;

  return (
    uncachedInputTokens * baseRates.input * inputMultiplier
    + cachedInputTokens * baseRates.cachedInput * inputMultiplier
    + cacheWriteInputTokens * baseRates.input * CACHE_WRITE_INPUT_MULTIPLIER * inputMultiplier
    + outputTokens * baseRates.output * outputMultiplier
  ) / PER_MILLION;
}
