import "./test-env";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeCodexLimitReset,
  formatCodexRateLimits,
  getCodexRateLimits,
  mergeCodexRateLimitsUpdate,
  recordCodexRateLimits,
  resetCodexRateLimitsForTests,
} from "../src/harness/codex-rate-limits";
import { formatStats } from "../src/format";
import type { RateLimitSnapshot } from "../src/harness/codex-app-server-protocol/v2/RateLimitSnapshot";

const NOW = 1_800_000_000_000;

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: NOW / 1000 + 3_600 },
    secondary: { usedPercent: 42.4, windowDurationMins: 10_080, resetsAt: NOW / 1000 + 3 * 86_400 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
    ...overrides,
  };
}

describe("Codex rate-limit surfacing (B14)", () => {
  beforeEach(() => resetCodexRateLimitsForTests());

  it("formats nothing until a snapshot is observed", () => {
    assert.deepEqual(formatCodexRateLimits(undefined, NOW), []);
  });

  it("formats primary and secondary windows with reset times", () => {
    recordCodexRateLimits({
      ordinaryUsageAllowed: true,
      rateLimits: snapshot(),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      accountId: null,
      rateLimitUpsell: null,
    }, "fallback-1", NOW - 120_000);
    assert.deepEqual(formatCodexRateLimits(undefined, NOW), [
      "Codex usage limits (pro plan), observed 2m ago:",
      "  Primary (5h): 17% used, resets in 1h 0m",
      "  Secondary (weekly): 42% used, resets in 3d 0h",
    ]);
  });

  it("merges sparse updates without clearing previously observed values", () => {
    const key = recordCodexRateLimits({
      ordinaryUsageAllowed: false,
      rateLimits: snapshot(),
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
      accountId: null,
      rateLimitUpsell: null,
    }, "fallback-2", NOW);
    mergeCodexRateLimitsUpdate(key, snapshot({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: NOW / 1000 + 600 }, secondary: null, planType: null, rateLimitReachedType: "rate_limit_reached" }), NOW);
    const state = getCodexRateLimits(key);
    assert.equal(state?.snapshot.primary?.usedPercent, 100);
    assert.equal(state?.snapshot.secondary?.usedPercent, 42.4);
    assert.equal(state?.snapshot.planType, "pro");
    assert.equal(state?.ordinaryUsageAllowed, false);
    assert.match(formatCodexRateLimits([state!], NOW).join("\n"), /Limit reached: rate limit reached/);
    assert.match(describeCodexLimitReset(key, NOW) ?? "", /^Codex usage limit resets in 10m/);
    assert.equal(describeCodexLimitReset(key, NOW + 3_600_000), undefined, "expired windows are not reported");
    assert.doesNotMatch(formatCodexRateLimits([state!], NOW + 3_600_000).join("\n"), /Primary/);
  });

  it("keeps accounts separate and never renders account ids", () => {
    const base = { ordinaryUsageAllowed: true, rateLimitsByLimitId: null, rateLimitResetCredits: null, rateLimitUpsell: null };
    const a = recordCodexRateLimits({ ...base, rateLimits: snapshot(), accountId: "acct-secret-a" }, "fb-a", NOW);
    const b = recordCodexRateLimits({ ...base, rateLimits: snapshot({ planType: "plus" }), accountId: "acct-secret-b" }, "fb-b", NOW - 1);
    mergeCodexRateLimitsUpdate(b, snapshot({ primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: NOW / 1000 + 60 } }), NOW - 1);
    assert.equal(getCodexRateLimits(a)?.snapshot.primary?.usedPercent, 17);
    assert.equal(getCodexRateLimits(b)?.snapshot.primary?.usedPercent, 99);
    const text = formatCodexRateLimits(undefined, NOW).join("\n");
    assert.match(text, /\[account 1\]/);
    assert.match(text, /\[account 2\]/);
    assert.doesNotMatch(text, /acct-secret/);
  });

  it("appends the snapshot to agent_stats output", () => {
    const metrics = {
      totalLaunched: 1,
      sessionsByStatus: { completed: 1, failed: 0, killed: 0 },
      sessionsWithDuration: 0,
      totalDurationMs: 0,
      totalCostUsd: 0,
    } as unknown as Parameters<typeof formatStats>[0];
    assert.doesNotMatch(formatStats(metrics, 0, []), /Codex usage/);
    const text = formatStats(metrics, 0, ["Codex usage limits (pro plan), observed 0m ago:", "  Primary (5h): 1% used"]);
    assert.match(text, /📈 Codex usage limits \(pro plan\)/);
    assert.match(text, /Primary \(5h\): 1% used/);
  });
});
