/**
 * Shared settings for the property and model-based tests (fast-check).
 *
 * CI runs every property with a fixed seed and a small run budget, so a
 * failure reproduces exactly and the suite stays fast. Deep mode raises the
 * budget for nightly or remote runs:
 *
 * - `OCA_PROPERTY_RUNS=<n>` runs every property `n` times (the per-property
 *   CI budgets below are ignored).
 * - `OCA_PROPERTY_SEED=<int>` replays a reported seed; `OCA_PROPERTY_SEED=random`
 *   draws a fresh seed per property (fast-check prints it on failure).
 *
 * On failure fast-check throws an error whose message names the seed, the
 * shrink path and the shrunk counterexample; `node:test` prints it verbatim.
 * Replay one failure with `OCA_PROPERTY_SEED=<seed>` (and the same
 * `OCA_PROPERTY_RUNS`, if any).
 */
import fc from "fast-check";

/** The fixed CI seed. Any 32-bit integer works; changing it reshuffles every property. */
export const DEFAULT_PROPERTY_SEED = 0x0ca5_2026;

function parseRuns(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const runs = Number(raw);
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error(`OCA_PROPERTY_RUNS must be a positive integer, got "${raw}".`);
  }
  return runs;
}

function parseSeed(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return DEFAULT_PROPERTY_SEED;
  if (value === "random") return undefined;
  const seed = Number(value);
  if (!Number.isInteger(seed)) {
    throw new Error(`OCA_PROPERTY_SEED must be an integer or "random", got "${raw}".`);
  }
  return seed;
}

const deepRuns = parseRuns(process.env.OCA_PROPERTY_RUNS);
const seed = parseSeed(process.env.OCA_PROPERTY_SEED);

/** True when `OCA_PROPERTY_RUNS` overrides the CI budgets. */
export const PROPERTY_DEEP_MODE = deepRuns !== undefined;

/**
 * fast-check parameters for one property: the fixed (or requested) seed and
 * `ciRuns` runs, or `OCA_PROPERTY_RUNS` runs in deep mode.
 */
export function propertyParams<T>(ciRuns: number, extra: fc.Parameters<T> = {}): fc.Parameters<T> {
  return {
    ...(seed !== undefined ? { seed } : {}),
    numRuns: deepRuns ?? ciRuns,
    ...extra,
  };
}
