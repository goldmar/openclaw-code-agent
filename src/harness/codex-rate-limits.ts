/**
 * Latest Codex account rate-limit snapshot observed by any Codex session.
 *
 * Codex sessions read `account/rateLimits/read` after `initialize` and merge
 * sparse `account/rateLimits/updated` notifications into it. The snapshot is
 * account-wide, so a single process-level value is the right granularity.
 */

import type { GetAccountRateLimitsResponse } from "./codex-app-server-protocol";
import type { RateLimitSnapshot } from "./codex-app-server-protocol/v2/RateLimitSnapshot";
import type { RateLimitWindow } from "./codex-app-server-protocol/v2/RateLimitWindow";

export interface CodexRateLimitState {
  snapshot: RateLimitSnapshot;
  ordinaryUsageAllowed: boolean | null;
  observedAt: number;
}

let latest: CodexRateLimitState | undefined;

export function recordCodexRateLimits(response: GetAccountRateLimitsResponse, now = Date.now()): void {
  latest = {
    snapshot: response.rateLimits,
    ordinaryUsageAllowed: response.ordinaryUsageAllowed,
    observedAt: now,
  };
}

/**
 * Merge a sparse rolling update. Null fields mean "unavailable in this update"
 * and keep the previously observed value, per the protocol contract.
 */
export function mergeCodexRateLimitsUpdate(update: RateLimitSnapshot, now = Date.now()): void {
  const previous = latest?.snapshot;
  const merged = { ...(previous ?? update) } as RateLimitSnapshot;
  for (const [key, value] of Object.entries(update) as Array<[keyof RateLimitSnapshot, unknown]>) {
    if (value !== null && value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  latest = {
    snapshot: merged,
    ordinaryUsageAllowed: latest?.ordinaryUsageAllowed ?? null,
    observedAt: now,
  };
}

export function getCodexRateLimits(): CodexRateLimitState | undefined {
  return latest;
}

export function resetCodexRateLimitsForTests(): void {
  latest = undefined;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatWindowName(window: RateLimitWindow): string {
  const mins = window.windowDurationMins;
  if (!mins) return "window";
  if (mins % (60 * 24) === 0) return mins === 10_080 ? "weekly" : `${mins / (60 * 24)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function formatWindow(label: string, window: RateLimitWindow | null, now: number): string | undefined {
  if (!window) return undefined;
  const reset = window.resetsAt ? `, resets in ${formatDuration(window.resetsAt * 1000 - now)}` : "";
  return `${label} (${formatWindowName(window)}): ${Math.round(window.usedPercent)}% used${reset}`;
}

/** Human-readable lines for `agent_stats`. Empty when nothing was observed yet. */
export function formatCodexRateLimits(state: CodexRateLimitState | undefined = latest, now = Date.now()): string[] {
  if (!state) return [];
  const { snapshot } = state;
  const plan = snapshot.planType && snapshot.planType !== "unknown" ? ` (${snapshot.planType} plan)` : "";
  const lines = [`Codex usage limits${plan}, observed ${formatDuration(now - state.observedAt)} ago:`];
  const primary = formatWindow("  Primary", snapshot.primary, now);
  const secondary = formatWindow("  Secondary", snapshot.secondary, now);
  if (primary) lines.push(primary);
  if (secondary) lines.push(secondary);
  if (snapshot.credits && !snapshot.credits.unlimited && snapshot.credits.hasCredits) {
    lines.push(`  Credits balance: ${snapshot.credits.balance ?? "unknown"}`);
  }
  if (snapshot.rateLimitReachedType) {
    lines.push(`  Limit reached: ${snapshot.rateLimitReachedType.replace(/_/g, " ")}`);
  } else if (state.ordinaryUsageAllowed === false) {
    lines.push("  Ordinary included usage is currently not allowed for this account.");
  }
  return lines.length > 1 ? lines : [];
}

/** Short reset hint appended to usage-limit turn failures. */
export function describeCodexLimitReset(now = Date.now()): string | undefined {
  const snapshot = latest?.snapshot;
  const windows = [snapshot?.primary, snapshot?.secondary]
    .filter((window): window is RateLimitWindow => !!window && window.usedPercent >= 100 && !!window.resetsAt);
  if (windows.length === 0) return undefined;
  const resetsAt = Math.max(...windows.map((window) => window.resetsAt!));
  return `Codex usage limit resets in ${formatDuration(resetsAt * 1000 - now)} (${new Date(resetsAt * 1000).toISOString()}).`;
}
