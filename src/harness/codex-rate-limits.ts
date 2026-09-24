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

let unreportedAccountCounter = 0;

/**
 * Key for a connection whose account id is unknown (read failed or the
 * backend omitted it). Unique per connection so unknown accounts never merge.
 */
export function unreportedCodexAccountKey(): string {
  unreportedAccountCounter += 1;
  return `unreported-account-${unreportedAccountCounter}`;
}

/**
 * Snapshots per Codex account. Different sessions can run under different
 * ChatGPT accounts, so updates never merge across accounts. Account ids stay
 * in memory only and are never rendered.
 */
const byAccount = new Map<string, CodexRateLimitState>();

/**
 * Record a full `account/rateLimits/read` response; returns the account key
 * (`fallbackKey` when the backend did not report an account id).
 */
export function recordCodexRateLimits(
  response: GetAccountRateLimitsResponse,
  fallbackKey: string,
  now = Date.now(),
): string {
  const accountKey = response.accountId?.trim() || fallbackKey;
  byAccount.set(accountKey, {
    snapshot: response.rateLimits,
    ordinaryUsageAllowed: response.ordinaryUsageAllowed,
    observedAt: now,
  });
  return accountKey;
}

/**
 * Merge a sparse rolling update for one account. Null fields mean
 * "unavailable in this update" and keep the previously observed value.
 */
export function mergeCodexRateLimitsUpdate(accountKey: string, update: RateLimitSnapshot, now = Date.now()): void {
  const previous = byAccount.get(accountKey);
  const merged = { ...(previous?.snapshot ?? update) } as RateLimitSnapshot;
  for (const [key, value] of Object.entries(update) as Array<[keyof RateLimitSnapshot, unknown]>) {
    if (value !== null && value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  byAccount.set(accountKey, {
    snapshot: merged,
    ordinaryUsageAllowed: previous?.ordinaryUsageAllowed ?? null,
    observedAt: now,
  });
}

export function getCodexRateLimits(accountKey: string): CodexRateLimitState | undefined {
  return byAccount.get(accountKey);
}

export function listCodexRateLimits(): CodexRateLimitState[] {
  return [...byAccount.values()].sort((a, b) => b.observedAt - a.observedAt);
}

export function resetCodexRateLimitsForTests(): void {
  byAccount.clear();
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

function formatAccountLines(state: CodexRateLimitState, now: number, label: string): string[] {
  const { snapshot } = state;
  const plan = snapshot.planType && snapshot.planType !== "unknown" ? ` (${snapshot.planType} plan)` : "";
  const lines = [`Codex usage limits${plan}${label}, observed ${formatDuration(now - state.observedAt)} ago:`];
  const primary = formatWindow("  Primary", activeWindow(snapshot.primary, now), now);
  const secondary = formatWindow("  Secondary", activeWindow(snapshot.secondary, now), now);
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

/** A window whose reset time already passed no longer describes current usage. */
function activeWindow(window: RateLimitWindow | null, now: number): RateLimitWindow | null {
  if (!window) return null;
  return window.resetsAt && window.resetsAt * 1000 <= now ? null : window;
}

/**
 * Human-readable lines for `agent_stats`, one block per observed account.
 * Empty when nothing was observed yet.
 */
export function formatCodexRateLimits(states: CodexRateLimitState[] = listCodexRateLimits(), now = Date.now()): string[] {
  return states.flatMap((state, index) => formatAccountLines(state, now, states.length > 1 ? ` [account ${index + 1}]` : ""));
}

/** Short reset hint appended to usage-limit failures for one account. */
export function describeCodexLimitReset(accountKey: string, now = Date.now()): string | undefined {
  const snapshot = byAccount.get(accountKey)?.snapshot;
  const windows = [snapshot?.primary, snapshot?.secondary]
    .filter((window): window is RateLimitWindow => !!window
      && window.usedPercent >= 100
      && !!window.resetsAt
      && window.resetsAt * 1000 > now);
  if (windows.length === 0) return undefined;
  const resetsAt = Math.max(...windows.map((window) => window.resetsAt!));
  return `Codex usage limit resets in ${formatDuration(resetsAt * 1000 - now)} (${new Date(resetsAt * 1000).toISOString()}).`;
}
