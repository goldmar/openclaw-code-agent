import type { GetAccountResponse } from "./codex-app-server-protocol";
import type { TokenUsageBreakdown } from "./codex-app-server-protocol/v2/TokenUsageBreakdown";

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

// USD per 1M tokens. These are the current standard API rates documented on
// the official OpenAI model pages as of 2026-09-04.
// GPT-6 Astra: https://developers.openai.com/api/docs/models/gpt-6-astra
// GPT-6 Sol and Luna: https://developers.openai.com/api/docs/pricing (Standard,
// short context, as of 2026-09-23; also announced in
// https://developers.openai.com/api/docs/changelog).
const STANDARD_RATES: Record<string, TokenRates> = {
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
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
  // GPT-6 models are priced by exact id only; unlisted snapshots stay unpriced.
  if (normalized.startsWith("gpt-6-")) {
    return Object.hasOwn(STANDARD_RATES, normalized) ? normalized : undefined;
  }
  for (const pricedModel of Object.keys(STANDARD_RATES)) {
    if (normalized === pricedModel || normalized.startsWith(`${pricedModel}-`)) {
      return pricedModel;
    }
  }
  return undefined;
}

export type CodexAccountType = NonNullable<GetAccountResponse["account"]>["type"];

export function codexAccountType(response: GetAccountResponse | undefined): CodexAccountType | undefined {
  return response?.account?.type;
}

/**
 * Codex reports fast mode as the `priority` service tier (sending `fast` is
 * normalized to `priority`). Only the tier the server actually applied counts.
 */
export function isFastServiceTier(serviceTier: string | null | undefined): boolean {
  const normalized = serviceTier?.trim().toLowerCase();
  return normalized === "priority" || normalized === "fast";
}

/** Convert one `thread/tokenUsage/updated` breakdown into priced token usage. */
export function tokenUsageFromBreakdown(breakdown: TokenUsageBreakdown | undefined): CodexTokenUsage | undefined {
  if (!breakdown) return undefined;
  const usage: CodexTokenUsage = {
    inputTokens: breakdown.inputTokens,
    cachedInputTokens: breakdown.cachedInputTokens,
    cacheWriteInputTokens: breakdown.cacheWriteInputTokens,
    outputTokens: breakdown.outputTokens,
    reasoningOutputTokens: breakdown.reasoningOutputTokens,
  };
  return isValidUsage(usage) ? usage : undefined;
}

function isValidUsage(usage: CodexTokenUsage): boolean {
  const values = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
  ];
  return values.every((value) => nonNegativeInteger(value) !== undefined)
    && usage.cachedInputTokens + usage.cacheWriteInputTokens <= usage.inputTokens
    && usage.reasoningOutputTokens <= usage.outputTokens;
}

/**
 * Estimate OpenAI API token charges for one upstream Codex model response
 * (the `last` breakdown of a `thread/tokenUsage/updated` notification).
 *
 * `outputTokens` already contains reasoning tokens; reasoningOutputTokens is a
 * diagnostic subset and must not be added again. Unknown models and malformed
 * usage remain unpriced rather than producing a misleading estimate.
 */
export function estimateCodexApiCostUsd(params: {
  model?: string;
  /** Effective service tier reported by Codex for the thread. */
  serviceTier?: string | null;
  usage: CodexTokenUsage;
}): number | undefined {
  const pricingModel = canonicalPricingModel(params.model);
  const baseRates = pricingModel ? STANDARD_RATES[pricingModel] : undefined;
  if (!baseRates) return undefined;

  if (!isValidUsage(params.usage)) return undefined;
  const {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
  } = params.usage;

  const isLongContext = inputTokens > LONG_CONTEXT_INPUT_THRESHOLD;
  const serviceMultiplier = isFastServiceTier(params.serviceTier) ? FAST_MODE_MULTIPLIER : 1;
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
